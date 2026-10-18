/**
 * dsh-pet 应用主进程。
 *
 * 组成：
 *   1. **本地宿主**：`createAppContext` 提供真实的 credentials / llm / 事件总线，
 *      `src/host` 的 `apply()` 在其上跑起来（路由表、配置合并、素材归属、桌面窗口启停都在那一份里）；
 *   2. **本地服务**：`listenAppServer` 监听 127.0.0.1，把宿主路由原样接上，
 *      并额外提供设置页与「本地服务」接口（`web-ui.ts`）；
 *   3. **桌面宠物**：**本进程自己**开透明置顶小窗（`runtime/electron-helper/windows.js`，
 *      经 `desktop.ts` 适配）。渲染端的请求走 `dsh-pet-bridge://` scheme，
 *      `protocol.handle` 直接调宿主路由——同进程内一次函数调用，没有子进程、没有管道；
 *   4. **托盘 + 设置窗口**：应用的壳。关闭设置窗口不退出，退出走托盘菜单。
 *
 * 边界：运行期不 import 任何 `@deepseek-ai/*`（构建期由 alias 换成 `src/app/shims/*` 的替身），
 * 数据目录是应用自己的 `app.getPath('userData')`。
 */
import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, safeStorage, shell } from 'electron';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { apply } from '../host/index';
import { createDesktopService, prepareDesktopRuntime, reportPrimaryScale } from './desktop';
import { listenAppServer } from './server';
import type { RegisteredRoute } from './server';
import { createAppContext } from './context';
import { readAppConfig, readSecrets } from './local-config';
import type { LlmService } from './llm-openai';
import { migrateLegacyData, petDataDir } from './paths';
import { portFromArgv } from './port-arg';
import { encryptionAvailable, setSecretCodec } from './secrets';
import { startNotifyWatcher } from './notifications';
import { createWebUi } from './web-ui';

// ---------- 应用身份与数据目录 ----------
// 必须在任何 getPath('userData') 之前定名：否则 Electron 会把 userData 落到 "Electron" 公共目录，
// 与其它用同一份 electron.exe 跑的脚本互相踩 profile。
app.setName('dsh-pet');

/**
 * 包根目录。
 *
 * 三个来源，按可靠性排序：
 *   1. 启动器显式传入（`npm run app` / `dsh-pet-app`，开发态与 npm 安装都走这条）；
 *   2. **便携包**：`<应用>/resources/app/` 就是包根（`__dirname` = `<…>/lib`，向上一层即包根）；
 *   3. 兜底 cwd（直接 `electron lib/app-main.cjs` 时，至少还能跑起来）。
 */
function resolvePackageRoot(): string {
  if (process.env.DSH_PET_PACKAGE_ROOT) return process.env.DSH_PET_PACKAGE_ROOT;
  const here = typeof __dirname === 'string' ? __dirname : process.cwd();
  const parent = join(here, '..');
  return existsSync(join(parent, 'package.json')) ? parent : process.cwd();
}

/** 包根目录 */
const PACKAGE_ROOT = resolvePackageRoot();

/**
 * 数据根目录。
 *
 * **打包版：数据跟着程序走**（免安装 zip 与安装版都一样）——配置、素材、记忆、日志全部落在
 * `<可执行文件目录>/data`，拷走整个目录即迁移，卸载即删干净，不往 `%APPDATA%` 留东西。
 * 安装版走 per-user 安装（`%LOCALAPPDATA%\Programs\dsh-pet`），该目录对当前用户可写，
 * 所以这条规则成立；万一装到了只读位置（有人手动挪进 Program Files），探测失败就回落到
 * 用户目录，并在日志里说明——绝不因为写不进去就起不来。
 *
 * 开发态（`npm run app`）没有"安装目录"概念，仍用 Electron 的 userData。
 */
function resolveDataRoot(): string {
  if (!app.isPackaged) return app.getPath('userData');
  const beside = join(dirname(process.execPath), 'data');
  try {
    mkdirSync(beside, { recursive: true });
    // 真写一次：目录存在不等于可写（Program Files 下普通用户可创建失败或写入被拒）
    const probe = join(beside, '.write-probe');
    writeFileSync(probe, 'ok', 'utf8');
    rmSync(probe, { force: true });
    return beside;
  } catch {
    return app.getPath('userData');
  }
}

/** 数据根目录（宿主半边眼里就是 DSH_HOME） */
const DATA_ROOT = resolveDataRoot();

// 宿主半边把「用户数据根」统一叫 DSH_HOME（$DSH_HOME/dsh-pet/…）。指向数据根之后，
// 配置、素材、记忆的路径推导一行不用改。
process.env.DSH_HOME = DATA_ROOT;
// Electron 自己的 profile（Chromium 缓存 / GPU 缓存）也收进数据目录，否则便携版会在
// %APPDATA% 留一份同名目录——"拷走即迁移"就不成立了。
if (app.isPackaged) {
  app.setPath('userData', join(DATA_ROOT, 'electron'));
  app.setPath('sessionData', join(DATA_ROOT, 'electron'));
}

/**
 * DPI 探测子进程模式（`dsh-pet.exe <main.cjs> --dpi-probe`）。
 *
 * 为什么要再拉起一个自己：`force-device-scale-factor` 一旦生效，`screen` API 只会报被强制的值，
 * 真实主屏缩放就再也读不到了。所以首次启动先起一个**不带该开关**的短命子进程读一次并落盘。
 *
 * 这个分支必须在**任何**初始化之前判定：不抢单实例锁、不起服务、不建窗口、不读配置。
 */
const IS_DPI_PROBE = process.argv.includes('--dpi-probe');

// 探测进程用独立 profile：它和主实例几乎同时启动，共用同一个 userData 会撞 Chromium 的
// ProcessSingleton 锁（"profile in use"）。它只需要 screen 模块，与 profile 无关。
if (IS_DPI_PROBE) {
  app.setPath('userData', join(app.getPath('temp'), 'dsh-pet-dpi-probe'));
}

/**
 * 命令行端口：`dsh-pet.exe --port 7500` / `--port=7500`（解析见 `./port-arg`）。
 *
 * 为什么应用本体也要认（`src/app/launch.ts` 早就认了）：README / API.md / openapi 都写着
 * 「可用 `--port` 指定」，而打包版**直接跑本文件**、不经过启动器——从前它只读环境变量，
 * 于是 `dsh-pet.exe --port 7500` 静默无效（文档承诺、实际不生效）。免安装版用户恰恰最需要它
 * （同一台机器想开两个实例、或 7340 被别的东西占了）。
 */
function resolvePort(): number {
  const parsed = portFromArgv(process.argv);
  if (parsed.port !== undefined) return parsed.port;
  if (parsed.raw !== undefined) {
    log.warn(`--port 需要 1..65535 的整数，收到 ${JSON.stringify(parsed.raw)}，已忽略并回落默认端口`);
  }
  return Number(process.env.DSH_PET_APP_PORT ?? 7340);
}

/**
 * 桌面窗口层的运行前准备：**必须在 ready 之前**（硬件加速开关与 force-device-scale-factor
 * 都只能那时设）。返回的 uiScale 用于把设置窗按同样的比例补偿回来。
 *
 * 探测子进程也要走这一句：它会**装载**窗口层模块（`protocol.registerSchemesAsPrivileged`
 * 只能在 ready 前调用），只是跳过 DPI 线性化本身（见 probeMode）。
 */
const DPI = prepareDesktopRuntime({
  packageRoot: PACKAGE_ROOT,
  appMainScript: __filename,
  probeMode: IS_DPI_PROBE,
});

/**
 * 落盘日志。
 *
 * 桌面应用的 stdout 在 Windows 上**没有终端可看**（双击启动时根本没有控制台），
 * 一旦主进程在启动阶段抛错，用户只会看到一个系统错误框、没有任何可复制的内容。
 * 因此把关键节点与异常追加到 `<数据目录>/dsh-pet/app.log`（超过 1MB 滚成 app.log.1，
 * 只留一代）：用户遇到问题时把这份文件
 * 发出来即可，不必教他们怎么从命令行启动。
 */
/** 日志文件上限：超过就滚成 app.log.1（只留一代），避免长期运行无限增长 */
const LOG_MAX_BYTES = 1024 * 1024;

function appendLog(line: string): void {
  try {
    const dir = petDataDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'app.log');
    // 超过上限就滚成 app.log.1（只留一代）：长时间运行 + 窗口反复重建时日志会一直长
    try {
      if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
    } catch {
      /* 文件还不存在 / 正被占用：直接追加即可 */
    }
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* 日志写不进去不能反过来影响启动 */
  }
}

/**
 * 应用日志（宿主半边的 `ctx.logger` 也用这一份）。
 *
 * `warn` / `error` **同时落盘**：桌面窗口 是子进程，它的 stderr 由宿主经 `logger.warn`
 * 转发——不落盘的话，"宠物窗口没出现"这类问题在双击启动的场景下完全无从排查
 * （控制台不存在，用户只能看到"只有设置窗"）。
 */
const log = {
  info: (message: string): void => console.log(`[dsh-pet] ${message}`),
  warn: (message: string): void => {
    console.warn(`[dsh-pet] ${message}`);
    appendLog(`[warn] ${message}`);
  },
  error: (message: string): void => {
    console.error(`[dsh-pet] ${message}`);
    appendLog(`[error] ${message}`);
  },
  debug: (message: string): void => {
    if (process.env.DSH_PET_APP_DEBUG === '1') console.log(`[dsh-pet] ${message}`);
  },
};

/** 进程级兜底：未捕获异常先落盘再退出（否则 Electron 只弹一个"Error"框，什么都查不到） */
process.on('uncaughtException', (error: unknown) => {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  appendLog(`[uncaught] ${text}`);
  console.error(`[dsh-pet] 未捕获异常：${text}`);
  app.exit(1);
});
process.on('unhandledRejection', (reason: unknown) => {
  appendLog(`[unhandledRejection] ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

/**
 * 单实例：第二次启动只把设置窗口唤到前台，不重开一套服务与宠物。
 *
 * 注意：拿不到锁时**必须立刻停止启动流程**——只调 `app.quit()` 是不够的，
 * `whenReady` 回调仍会执行，结果是两个实例抢端口、各起一套窗口（实测）。
 */
const GOT_LOCK = IS_DPI_PROBE ? true : app.requestSingleInstanceLock();
if (!GOT_LOCK) {
  appendLog('[single-instance] 已有实例在运行，本进程退出');
}

let settingsWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let server: { port: number; close(): Promise<void> } | undefined;
let context: ReturnType<typeof createAppContext> | undefined;
let stopNotify: (() => void) | undefined;
let quitting = false;
/** 服务实际端口（0 = 还没起来） */
let port = 0;

/** 设置页地址 */
function settingsUrl(): string {
  return `http://127.0.0.1:${port}/app/`;
}

/** 打开（或唤起）设置窗口 */
function openSettings(): void {
  if (port <= 0) return;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    // DPI 线性化把 DIP 变成物理像素：窗口尺寸与页面缩放同时乘 uiScale，
    // 设置页看到的 CSS 尺寸才与不启用线性化时一致（否则 150% 屏上会缩成 2/3）。
    width: Math.round(940 * DPI.uiScale),
    height: Math.round(800 * DPI.uiScale),
    minWidth: Math.round(720 * DPI.uiScale),
    minHeight: Math.round(560 * DPI.uiScale),
    title: 'dsh-pet 设置',
    autoHideMenuBar: true,
    backgroundColor: '#141417',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      zoomFactor: DPI.uiScale,
    },
  });
  settingsWindow.on('closed', () => {
    settingsWindow = undefined;
  });
  // 渲染端报错转发到主进程日志（默认只记 warn/error；DSH_PET_APP_DEBUG=1 时连 log 一起看）
  settingsWindow.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      log.warn(`[设置页] ${event.message}（${event.sourceId}:${event.lineNumber}）`);
    } else {
      log.debug(`[设置页] ${event.message}`);
    }
  });
  // 外部链接走系统浏览器（页面里没有外链，兜底防意外跳转把设置窗变成浏览器）
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  void settingsWindow.loadURL(settingsUrl());
}

/** 通知图标（包内 assets/pic；缺图时传空串让系统用默认图标） */
function notifyIcon(name: string): string {
  const file = join(PACKAGE_ROOT, 'assets', 'pic', `${name}.png`);
  return existsSync(file) ? file : '';
}

/** 弹一条原生通知（应用未就绪 / 系统不支持时静默跳过） */
function showNotification(title: string, body: string, iconName: string): void {
  if (!Notification.isSupported()) return;
  const icon = notifyIcon(iconName);
  const notification = new Notification({ title, body, ...(icon ? { icon } : {}), silent: false });
  notification.on('click', () => openSettings());
  notification.show();
}

/** 托盘：设置 / 重载配置 / 打开数据目录 / 退出 */
function createTray(): void {
  const iconPath = join(PACKAGE_ROOT, 'assets', 'logo.png');
  const image = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  // 托盘图标尺寸同样要补偿 DPI 线性化：DSF=1 时 20px 就是 20 物理像素，
  // 在 150% 屏上会比系统托盘里的其它图标小一圈（它们按 DIP 给 20 → 30 物理像素）。
  const trayPx = Math.round(20 * DPI.uiScale);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: trayPx, height: trayPx }));
  tray.setToolTip('dsh-pet');
  const rebuild = (): void => {
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开设置', click: () => openSettings() },
        {
          label: '重载配置',
          click: () => {
            // 与右键菜单「重载配置」同一条路由：重建桌面窗口，按最新配置重建全部宠物窗口
            void fetch(`http://127.0.0.1:${port}/dsh-pet-7340/reload`, { method: 'POST' }).catch((error: unknown) =>
              log.warn(`重载配置失败：${error instanceof Error ? error.message : String(error)}`),
            );
          },
        },
        { type: 'separator' },
        { label: '打开数据目录', click: () => void shell.openPath(petDataDir()) },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
  };
  rebuild();
  // 左键点托盘 = 打开设置（Windows / Linux 习惯；macOS 走菜单栏点击弹菜单）
  tray.on('click', () => openSettings());
}

/**
 * 首次运行标记文件。
 *
 * 为什么不用"配置文件是否存在"判断：**首次启动并不会写 main-config.jsonc**（只有用户在设置页
 * 点保存才写），于是"配置不存在"永远成立，设置窗每次都会弹——实测第二次启动仍然弹。
 * 改为在第一次启动收尾时落一个标记：它是"这个数据目录已经被初始化过"的直接证据。
 */
function firstRunMarker(): string {
  return join(petDataDir(), '.initialized');
}

/** 是否首次运行（数据目录里还没有初始化标记） */
function isFirstRun(): boolean {
  return !existsSync(firstRunMarker());
}

/** 落首次运行标记（失败不影响启动） */
function markInitialized(): void {
  try {
    writeFileSync(firstRunMarker(), new Date().toISOString() + '\n', 'utf8');
  } catch {
    /* 只影响下次是否弹设置窗，不值得为它中断启动 */
  }
}

/** 起本地宿主（服务 → 上下文 → 插件 apply → 界面） */
async function bootstrap(): Promise<void> {
  appendLog(`[start] root=${PACKAGE_ROOT} data=${app.getPath('userData')} electron=${process.versions.electron}`);
  migrateLegacyData(log.warn);

  const routes: RegisteredRoute[] = [];
  const portRef = { value: 0 };
  // 桌面窗口服务：宿主决定"哪些宠物该显示"，这里负责"怎么开出来"（见 desktop.ts）
  const desktop = createDesktopService({ packageRoot: PACKAGE_ROOT, logger: log });
  context = createAppContext({
    port: () => portRef.value,
    logger: log,
    routes,
    config: () => readAppConfig(),
    secrets: () => readSecrets(),
    petDesktop: desktop,
  });

  const webUi = createWebUi({
    paths: { root: PACKAGE_ROOT },
    runtime: () => ({
      port: portRef.value,
      version: appVersion(),
      dataDir: petDataDir(),
      electron: process.versions.electron ?? '',
    }),
    llm: () => context?.ctx.llm as LlmService,
    openPath: async (dir: string) => {
      await shell.openPath(dir);
    },
    dataDir: () => petDataDir(),
  });

  server = await listenAppServer({
    routes,
    logger: log,
    port: resolvePort(),
    status: () => ({
      name: 'dsh-pet-app',
      version: appVersion(),
      port: portRef.value,
      uptimeSec: Math.round(process.uptime()),
    }),
    extra: webUi,
    /**
     * `POST /shutdown`（API.md 承诺的「优雅停机」）。
     *
     * 从前这里没接：接口照常回 `{ok:true, stopping:true}`，但应用一动不动——脚本以为关掉了，
     * 端口与宠物都还在（接口在、效果没有，与「摆设」同一类问题）。
     * 现在接到与托盘「退出」同一条收尾路径上：`app.quit()` → before-quit 里释放宿主 effect
     * （销毁桌面窗口、清定时器）→ 关服务 → exit。
     *
     * 延迟 100ms 再退：200 响应是刚 `res.end()` 出去的，立刻 exit 会把还没 flush 的连接掐掉，
     * 调用方看到的是「请求失败」，而实际上服务已经停了。
     */
    onShutdown: () => {
      appendLog('[shutdown] 收到 /shutdown，开始优雅停机');
      setTimeout(() => app.quit(), 100);
    },
  });
  portRef.value = server.port;
  port = server.port;
  appendLog(`[server] listening on ${port}`);

  // 插件宿主半边：路由表、配置合并、状态仓、桌面窗口（含守护循环）全在这一句里
  apply(context.ctx);
  appendLog(`[host] apply done, routes=${routes.length}`);

  stopNotify = startNotifyWatcher({
    port: () => port,
    config: () => readAppConfig(),
    show: showNotification,
    log: log.info,
  });

  createTray();
  // 只有首次运行才自动弹设置窗（引导填 API Key）；之后启动就是"点开就有宠物"，
  // 设置窗从托盘或右键菜单进——每次启动都糊一个设置窗在脸上不是桌宠该有的行为。
  if (isFirstRun()) openSettings();
  markInitialized();
  log.info(`本地服务 http://127.0.0.1:${port}/dsh-pet-7340/（设置页 /app/）`);
}

/** 读自身版本（读不到不影响运行） */
function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ---------- 生命周期 ----------

if (IS_DPI_PROBE) {
  // 探测进程：ready 之后读主屏缩放、打到 stdout、退出（父进程按标记抓值）
  app.whenReady().then(() => reportPrimaryScale(PACKAGE_ROOT));
} else if (GOT_LOCK) {
  app.on('second-instance', () => openSettings());

  app.on('window-all-closed', () => {
    // 托盘常驻：关掉设置窗口不等于退出应用（宠物窗口是独立的一批，但都关掉也不退出）
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void (async () => {
      stopNotify?.();
      // 先释放宿主的 effect（销毁桌面窗口、清定时器），再关服务
      await context?.dispose().catch(() => {});
      await server?.close().catch(() => {});
      appendLog('[quit] 已退出');
      app.exit(0);
    })();
  });

  app.whenReady().then(async () => {
    try {
      // 密钥加密：safeStorage 要在 app ready 之后才可靠（Linux 需要密钥环就绪）。
      // 不支持的环境（无密钥环）会退化成明文落盘，日志里说明一次。
      setSecretCodec({
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
        decrypt: (encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64')),
      });
      appendLog(`[secrets] 加密落盘：${encryptionAvailable() ? 'on' : 'off（系统不支持，明文保存）'}`);
      await bootstrap();
    } catch (error) {
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
      appendLog(`[fatal] ${text}`);
      log.error(`启动失败：${text}`);
      app.exit(1);
    }
  });
} else {
  // 交给已有实例处理（它收到 second-instance 会唤出设置窗），本进程不参与任何初始化
  app.whenReady().then(() => app.exit(0));
}
