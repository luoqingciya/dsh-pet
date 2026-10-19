/**
 * dsh-petNG 应用主进程。
 *
 * 组成：
 *   1. **本地宿主**：`createAppContext` 提供真实的 credentials / llm / 事件总线，
 *      `src/host` 的 `apply()` 在其上跑起来（路由表、配置合并、素材归属、桌面窗口启停都在那一份里）；
 *   2. **本地服务**：`listenAppServer` 监听 127.0.0.1，把宿主路由原样接上，
 *      并额外提供设置页与「本地服务」接口（`web-ui.ts`）；
 *   3. **桌面宠物**：**本进程自己**开透明置顶小窗（`runtime/electron-helper/windows.js`，
 *      经 `desktop.ts` 适配）。渲染端的请求走 `dsh-pet-ng-bridge://` scheme，
 *      `protocol.handle` 直接调宿主路由——同进程内一次函数调用，没有子进程、没有管道；
 *   4. **托盘 + 设置窗口**：应用的壳。关闭设置窗口不退出，退出走托盘菜单。
 *
 * 边界：源码里不出现任何 DSH 包名——宿主半边需要的 LLM 原语 / 凭证引用 / 数据根解析
 * 都在 `src/core/standalone/*` 有一份本地实现；数据目录是应用自己的 `app.getPath('userData')`。
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
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { apply } from '../core/index';
import { createDesktopService, createTrayMenuService, prepareDesktopRuntime, reportPrimaryScale } from './desktop';
import { listenAppServer } from './server';
import type { RegisteredRoute } from './server';
import { createAppContext } from './context';
import { readAppConfig, readSecrets } from './local-config';
import type { LlmService } from './llm-openai';
import { migrateLegacyData, petDataDir } from './paths';
import { portFromArgv } from './port-arg';
import { encryptionAvailable, setSecretCodec } from './secrets';
import { startNotifyWatcher } from './notifications';
import { checkForUpdate, RELEASES_PAGE } from './update-check';
import { readAutoStart, writeAutoStart } from './autostart';
import { createWebUi } from './web-ui';

// ---------- 应用身份与数据目录 ----------
// 必须在任何 getPath('userData') 之前定名：否则 Electron 会把 userData 落到 "Electron" 公共目录，
// 与其它用同一份 electron.exe 跑的脚本互相踩 profile。
app.setName('dsh-petNG');

/**
 * 包根目录。
 *
 * 三个来源，按可靠性排序：
 *   1. 启动器显式传入（`npm run app` / `dsh-pet-ng-app`，开发态与 npm 安装都走这条）；
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
 * 安装版走 per-user 安装（`%LOCALAPPDATA%\Programs\dsh-petNG`），该目录对当前用户可写，
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

// 宿主半边把「用户数据根」统一叫 DSH_HOME（$DSH_HOME/dsh-pet-ng/…）。指向数据根之后，
// 配置、素材、记忆的路径推导一行不用改。
process.env.DSH_HOME = DATA_ROOT;
// Electron 自己的 profile（Chromium 缓存 / GPU 缓存）也收进数据目录，否则便携版会在
// %APPDATA% 留一份同名目录——"拷走即迁移"就不成立了。
if (app.isPackaged) {
  app.setPath('userData', join(DATA_ROOT, 'electron'));
  app.setPath('sessionData', join(DATA_ROOT, 'electron'));
}

/**
 * DPI 探测子进程模式（`dsh-petNG.exe <main.cjs> --dpi-probe`）。
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
  app.setPath('userData', join(app.getPath('temp'), 'dsh-pet-ng-dpi-probe'));
}

/**
 * 命令行端口：`dsh-petNG.exe --port 7500` / `--port=7500`（解析见 `./port-arg`）。
 *
 * 为什么应用本体也要认（`src/main/launch.ts` 早就认了）：README / API.md / openapi 都写着
 * 「可用 `--port` 指定」，而打包版**直接跑本文件**、不经过启动器——从前它只读环境变量，
 * 于是 `dsh-petNG.exe --port 7500` 静默无效（文档承诺、实际不生效）。免安装版用户恰恰最需要它
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
 * 因此把关键节点与异常追加到 `<数据目录>/dsh-pet-ng/app.log`（超过 1MB 滚成 app.log.1，
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
  info: (message: string): void => console.log(`[dsh-petNG] ${message}`),
  warn: (message: string): void => {
    console.warn(`[dsh-petNG] ${message}`);
    appendLog(`[warn] ${message}`);
  },
  error: (message: string): void => {
    console.error(`[dsh-petNG] ${message}`);
    appendLog(`[error] ${message}`);
  },
  debug: (message: string): void => {
    if (process.env.DSH_PET_APP_DEBUG === '1') console.log(`[dsh-petNG] ${message}`);
  },
};

/** 进程级兜底：未捕获异常先落盘再退出（否则 Electron 只弹一个"Error"框，什么都查不到） */
process.on('uncaughtException', (error: unknown) => {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  appendLog(`[uncaught] ${text}`);
  console.error(`[dsh-petNG] 未捕获异常：${text}`);
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
/** 自绘托盘菜单（线性化生效时才有；见 createTray） */
let trayMenu: ReturnType<typeof createTrayMenuService> | undefined;
let server: { port: number; close(): Promise<void> } | undefined;
let context: ReturnType<typeof createAppContext> | undefined;
let stopNotify: (() => void) | undefined;
let stopUpdateCheck: (() => void) | undefined;
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
    title: 'dsh-petNG 设置',
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

/**
 * 版本检查（「A 方案」：只提示 + 打开下载页，**不自动替换文件**）。
 *
 * 为什么不自动装：免安装版没有安装器（electron-builder 的 portable 目标官方不支持自动更新），
 * Windows 又替换不了运行中的 exe——真要"一键升级"就得自己重写一个安装器，失败态（断电 /
 * 杀软 / 权限）会留下"打不开的应用"，比手动解压糟得多。所以这里只做提示。
 *
 * 口径：
 *   - 启动后延迟 {@link UPDATE_FIRST_DELAY_MS} 再查（别和启动抢带宽），之后每 12 小时一次；
 *   - 自动检查**失败一律静默**（api.github.com 在国内经常不通，每次启动弹一句"检查失败"是纯打扰）；
 *   - 托盘「检查更新」是手动触发：最新 / 有新版 / 失败都明确告知，失败时给下载页兜底；
 *   - 设置里可以关掉自动检查（`updateCheck`），关掉就完全不发这个请求。
 */
const UPDATE_FIRST_DELAY_MS = 15_000;
const UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** 首次检查的延迟（`DSH_PET_UPDATE_DELAY_MS` 可覆盖：排障与运行时测试用，正常别动） */
function updateFirstDelay(): number {
  const raw = Number(process.env.DSH_PET_UPDATE_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : UPDATE_FIRST_DELAY_MS;
}

/** 手动触发入口（托盘菜单用；startUpdateCheck 未跑时为空） */
let checkUpdateNow: ((manual: boolean) => void) | undefined;

function startUpdateCheck(): () => void {
  let stopped = false;
  let busy = false;

  const notify = (title: string, body: string, url?: string): void => {
    if (!Notification.isSupported()) return;
    const icon = notifyIcon('notify-done');
    const notification = new Notification({ title, body, ...(icon ? { icon } : {}), silent: true });
    if (url) {
      notification.on('click', () => {
        void shell.openExternal(url);
      });
    }
    notification.show();
  };

  const run = async (manual: boolean): Promise<void> => {
    if (stopped || busy) return;
    // 自动检查受设置开关约束；手动点托盘永远执行（用户明确要了结果）
    if (!manual && readAppConfig().updateCheck === false) return;
    busy = true;
    try {
      const current = appVersion();
      const result = await checkForUpdate({ current });
      if (stopped) return;
      if (result.kind === 'newer') {
        appendLog(`[update] 发现新版本 ${result.version}（当前 ${current}）`);
        notify('dsh-petNG 有新版本', `v${result.version} 可以下载了（当前 v${current}），点此打开下载页`, result.url);
        return;
      }
      if (result.kind === 'latest') {
        appendLog(`[update] 已是最新（${result.version}）`);
        if (manual) notify('dsh-petNG 已是最新版本', `当前 v${current}`);
        return;
      }
      appendLog(`[update] 检查失败：${result.message}`);
      // 自动检查失败不打扰；手动检查失败要说清楚，并给一个能自己去看的落脚点
      if (manual) notify('检查更新失败', `${result.message}。点此打开下载页手动看看`, RELEASES_PAGE);
    } finally {
      busy = false;
    }
  };

  checkUpdateNow = (manual) => void run(manual);
  const first = setTimeout(() => void run(false), updateFirstDelay());
  const timer = setInterval(() => void run(false), UPDATE_INTERVAL_MS);
  // 定时器不该拖住进程退出（应用退出时靠 dispose 收尾，不靠这里）
  first.unref?.();
  timer.unref?.();
  return () => {
    stopped = true;
    checkUpdateNow = undefined;
    clearTimeout(first);
    clearInterval(timer);
  };
}

/** 托盘菜单的动作（自绘菜单与原生菜单共用同一份实现） */
function trayAction(action: string): void {
  switch (action) {
    case 'settings':
      openSettings();
      return;
    case 'reload':
      // 与右键菜单「重载配置」同一条路由：重建桌面窗口，按最新配置重建全部宠物窗口
      void fetch(`http://127.0.0.1:${port}/dsh-pet-ng-7340/reload`, { method: 'POST' }).catch((error: unknown) =>
        log.warn(`重载配置失败：${error instanceof Error ? error.message : String(error)}`),
      );
      return;
    case 'check-update':
      // 手动触发：不走 15 秒延迟，也不受设置里的自动检查开关约束
      if (checkUpdateNow) checkUpdateNow(true);
      else log.info('更新检查尚未就绪（应用还在启动），稍后再试');
      return;
    case 'open-data':
      void shell.openPath(petDataDir());
      return;
    case 'quit':
      quitting = true;
      app.quit();
      return;
    default:
      log.warn(`未知的托盘动作：${action}`);
  }
}

/** 托盘菜单项（自绘与原生两条路共用；顺序即显示顺序） */
const TRAY_ITEMS: Array<{ label: string; action: string }> = [
  { label: '打开设置', action: 'settings' },
  { label: '重载配置', action: 'reload' },
  { label: '检查更新', action: 'check-update' },
  { label: '打开数据目录', action: 'open-data' },
  { label: '退出', action: 'quit' },
];

/** 托盘：设置 / 重载配置 / 检查更新 / 打开数据目录 / 退出 */
function createTray(): void {
  const iconPath = join(PACKAGE_ROOT, 'assets', 'logo.png');
  const image = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  // 托盘图标尺寸同样要补偿 DPI 线性化：DSF=1 时 20px 就是 20 物理像素，
  // 在 150% 屏上会比系统托盘里的其它图标小一圈（它们按 DIP 给 20 → 30 物理像素）。
  const trayPx = Math.round(20 * DPI.uiScale);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: trayPx, height: trayPx }));
  tray.setToolTip('dsh-petNG');

  /**
   * 菜单走**自绘**还是原生？
   *
   * DPI 线性化生效时（Windows/Linux，forcedScale > 0）用自绘窗口：原生托盘菜单是系统控件，
   * 字号不跟应用的缩放补偿走，150% 屏上只有 2/3 大且无法调（实测 primaryScale=1.5）。
   * macOS 不启用线性化（DIP 就是「点」），原生菜单大小本来就对，继续用原生——菜单栏点击弹
   * 原生菜单才是那个平台的习惯。
   */
  if (DPI.forcedScale > 0) {
    trayMenu = createTrayMenuService({ packageRoot: PACKAGE_ROOT, onAction: trayAction });
    tray.on('right-click', () => trayMenu?.show(TRAY_ITEMS));
  } else {
    const rebuild = (): void => {
      tray?.setContextMenu(
        Menu.buildFromTemplate(TRAY_ITEMS.map((item) => ({ label: item.label, click: () => trayAction(item.action) }))),
      );
    };
    rebuild();
  }

  // 左键点托盘 = 打开设置（Windows / Linux 习惯；macOS 走菜单栏点击弹菜单）
  tray.on('click', () => openSettings());

  // 排障 / 运行时测试钩子：没有可点击的托盘图标时（playwright / 无头验证）也能弹一次菜单。
  // 只在主进程里可见，渲染端碰不到。
  (globalThis as Record<string, unknown>).__dshTray = {
    show: () => {
      if (trayMenu) trayMenu.show(TRAY_ITEMS);
      else log.warn('当前是原生托盘菜单，没有自绘菜单可弹');
    },
    items: TRAY_ITEMS,
  };
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

/**
 * 旧版本（还叫 `dsh-pet` 的时候）可能的数据目录，按优先级排列。
 *
 * 改名换了数据目录，老用户不会自动看到自己的配置，所以首启按这张表找一次：
 *   1. **打包版**：旧安装目录旁的 `data/dsh-pet`（per-user 安装的默认位置，
 *      新安装目录叫 dsh-petNG，两者是兄弟目录）；
 *   2. **开发态 / 旧 userData**：`%APPDATA%\dsh-pet\dsh-pet`（userData 与子目录同名，套了两层）；
 *   3. **插件时期**：`~/.dsh/dsh-pet`。
 *
 * 便携版如果被放在自定义目录，这里猜不到——文档里给了手动搬迁的说明。
 */
function legacyDataDirs(): string[] {
  const dirs: string[] = [];
  if (app.isPackaged) {
    // <新安装目录>/../dsh-pet/data/dsh-pet
    dirs.push(join(dirname(process.execPath), '..', 'dsh-pet', 'data', 'dsh-pet'));
  }
  dirs.push(join(app.getPath('appData'), 'dsh-pet', 'dsh-pet'));
  dirs.push(join(homedir(), '.dsh', 'dsh-pet'));
  return dirs;
}

/** 起本地宿主（服务 → 上下文 → 插件 apply → 界面） */
async function bootstrap(): Promise<void> {
  // 迁移放在写日志之前：appendLog 会在数据目录里落 app.log（判「空目录」时会踩到）
  // 测试与临时 profile 不该把用户真实数据搬进来：UI 用例统一带 DSH_PET_SKIP_MIGRATION=1
  const migrated = process.env.DSH_PET_SKIP_MIGRATION !== '1' && migrateLegacyData(log.warn, legacyDataDirs());
  appendLog(`[start] root=${PACKAGE_ROOT} data=${app.getPath('userData')} electron=${process.versions.electron}`);
  if (migrated) appendLog('[migrate] 已接管旧版本的数据（旧目录原样保留）');

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
    // 开机自启：状态以系统为准（Windows 注册表 / macOS 登录项 / Linux .desktop），见 autostart.ts
    autoStart: () => readAutoStart(),
    setAutoStart: (enabled: boolean) => writeAutoStart(enabled),
    // 设置页「退出」：走 before-quit 的收尾（释放宿主 effect → 关服务 → exit）
    quit: () => app.quit(),
  });

  server = await listenAppServer({
    routes,
    logger: log,
    port: resolvePort(),
    status: () => ({
      name: 'dsh-petNG',
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
  // 版本检查：延迟 15 秒查一次，之后每 12 小时一次（失败静默；设置里可关）
  stopUpdateCheck = startUpdateCheck();
  // 只有首次运行才自动弹设置窗（引导填 API Key）；之后启动就是"点开就有宠物"，
  // 设置窗从托盘或右键菜单进——每次启动都糊一个设置窗在脸上不是桌宠该有的行为。
  if (isFirstRun()) openSettings();
  markInitialized();
  log.info(`本地服务 http://127.0.0.1:${port}/dsh-pet-ng-7340/（设置页 /app/）`);
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
      stopUpdateCheck?.();
      trayMenu?.destroy();
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
