/**
 * dsh-pet 应用主进程。
 *
 * 组成（每一块都复用已有的宿主半边，不另写业务）：
 *   1. **本地宿主**：`createAppContext` 提供真实的 credentials / llm / 事件总线，
 *      `src/host` 的 `apply()` 在其上跑起来（路由表、配置合并、素材归属、桌面 Helper 守护都在那一份里）；
 *   2. **本地服务**：`listenAppServer` 监听 127.0.0.1，把宿主路由原样接上，
 *      并额外提供设置页与「本地服务」接口（`web-ui.ts`）；
 *   3. **桌面宠物**：由宿主自己拉起 Electron 透明小窗（`runtime/electron-helper`）——
 *      本文件不碰窗口，只保证服务和 Electron 路径可用；
 *   4. **托盘 + 设置窗口**：应用的壳。关闭设置窗口不退出，退出走托盘菜单。
 *
 * 边界：运行期不 import 任何 `@deepseek-ai/*`（构建期由 alias 换成 `src/app/shims/*` 的替身），
 * 数据目录是应用自己的 `app.getPath('userData')`。
 */
import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, shell } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { apply } from '../host/index';
import { listenAppServer } from './server';
import type { RegisteredRoute } from './server';
import { createAppContext } from './context';
import { readAppConfig, readSecrets } from './local-config';
import type { LlmService } from './llm-openai';
import { migrateLegacyData, petDataDir } from './paths';
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
// 桌面 Helper 用同一份 Electron 二进制（打包版即应用自带的那份，开发态即缓存里的那份）
process.env.DSH_PET_ELECTRON_PATH = process.execPath;

/** 应用日志（宿主半边的 ctx.logger 也用这一份） */
const log = {
  info: (message: string): void => console.log(`[dsh-pet] ${message}`),
  warn: (message: string): void => console.warn(`[dsh-pet] ${message}`),
  error: (message: string): void => console.error(`[dsh-pet] ${message}`),
  debug: (message: string): void => {
    if (process.env.DSH_PET_APP_DEBUG === '1') console.log(`[dsh-pet] ${message}`);
  },
};

/**
 * 落盘日志。
 *
 * 桌面应用的 stdout 在 Windows 上**没有终端可看**（双击启动时根本没有控制台），
 * 一旦主进程在启动阶段抛错，用户只会看到一个系统错误框、没有任何可复制的内容。
 * 因此把关键节点与异常追加到 `<数据目录>/dsh-pet/app.log`：用户遇到问题时把这份文件
 * 发出来即可，不必教他们怎么从命令行启动。
 */
function appendLog(line: string): void {
  try {
    const dir = petDataDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'app.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* 日志写不进去不能反过来影响启动 */
  }
}

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
 * `whenReady` 回调仍会执行，结果是两个实例抢端口、各起一套 Helper（实测）。
 */
const GOT_LOCK = app.requestSingleInstanceLock();
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
    width: 940,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    title: 'dsh-pet 设置',
    autoHideMenuBar: true,
    backgroundColor: '#141417',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 20, height: 20 }));
  tray.setToolTip('dsh-pet');
  const rebuild = (): void => {
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开设置', click: () => openSettings() },
        {
          label: '重载配置',
          click: () => {
            // 与右键菜单「重载配置」同一条路由：重启桌面 Helper，按最新配置重建全部宠物窗口
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
 * 把「一次对话生成」合成一对会话事件投给插件。
 *
 * 这是本地模式补齐**工作状态联动**与**系统通知**的关键：插件那两条链路只认
 * `session/event`（turn/start、turn/end），本地没有 DSH 会话，就由应用在真实的
 * 生成前后各投一条——插件的工作状态机与通知帧因此**原样工作**，不需要为本地模式
 * 另写一套状态机，也不会出现"两套语义慢慢漂移"。
 */
function emitTurnStart(): void {
  context?.emit('session/event', { header: { id: 'dsh-pet-local' } }, { type: 'turn/start' });
}

function emitTurnEnd(ok: boolean, message?: string): void {
  context?.emit(
    'session/event',
    { header: { id: 'dsh-pet-local' } },
    {
      type: 'turn/end',
      data: { reason: ok ? { kind: 'completed' } : { kind: 'error', error: { message: message ?? '生成失败' } } },
    },
  );
}

/**
 * 包一层动作路由：生成前投 turn/start，响应写完后按结果投 turn/end。
 *
 * 只包 `/chat`（用户主动发起、值得弹通知）；`/whisper` 是每 5 分钟一次的自动碎碎念，
 * 给它发"对话完成"通知就是刷屏——这也正是 DSH 里碎碎念不产生通知的同一口径。
 */
function wrapChatRoute(): void {
  const route = context?.routes.find((item) => item.path === '/dsh-pet-7340');
  if (!route) return;
  const original = route.handler;
  route.handler = (req, res) => {
    const isChat = (req.method ?? 'GET') === 'POST' && (req.url ?? '').startsWith('/dsh-pet-7340/chat');
    if (!isChat) return original(req, res);
    emitTurnStart();
    let captured = '';
    const originalEnd = res.end.bind(res);
    // 抓响应体：宿主用 res.end(payload) 写 JSON，这里抄一份用于判定 ok（不改变任何写出行为）
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (typeof chunk === 'string') captured = chunk;
      return (originalEnd as (...args: unknown[]) => unknown)(chunk, ...rest);
    }) as typeof res.end;
    return Promise.resolve(original(req, res)).finally(() => {
      let ok = false;
      let message: string | undefined;
      try {
        const body = JSON.parse(captured) as { ok?: boolean; message?: string };
        ok = body.ok === true;
        message = body.message;
      } catch {
        /* 非 JSON（异常分支）：按失败处理 */
      }
      emitTurnEnd(ok, message);
    });
  };
}

/** 起本地宿主（服务 → 上下文 → 插件 apply → 界面） */
async function bootstrap(): Promise<void> {
  appendLog(`[start] root=${PACKAGE_ROOT} data=${app.getPath('userData')} electron=${process.versions.electron}`);
  migrateLegacyData(log.warn);

  const routes: RegisteredRoute[] = [];
  const portRef = { value: 0 };
  context = createAppContext({
    port: () => portRef.value,
    logger: log,
    routes,
    config: () => readAppConfig(),
    secrets: () => readSecrets(),
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
    port: Number(process.env.DSH_PET_APP_PORT ?? 7340),
    status: () => ({
      name: 'dsh-pet-app',
      version: appVersion(),
      port: portRef.value,
      uptimeSec: Math.round(process.uptime()),
    }),
    extra: webUi,
  });
  portRef.value = server.port;
  port = server.port;
  appendLog(`[server] listening on ${port}`);

  // 插件宿主半边：路由表、配置合并、状态仓、桌面 Helper（含守护循环）全在这一句里
  apply(context.ctx);
  wrapChatRoute();
  appendLog(`[host] apply done, routes=${routes.length}`);

  stopNotify = startNotifyWatcher({
    port: () => port,
    config: () => readAppConfig(),
    show: showNotification,
    log: log.info,
  });

  createTray();
  openSettings();
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

if (GOT_LOCK) {
  app.on('second-instance', () => openSettings());

  app.on('window-all-closed', () => {
    // 托盘常驻：关掉设置窗口不等于退出应用（宠物还在桌面上）
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void (async () => {
      stopNotify?.();
      // 先释放插件的 effect（停桌面 Helper、清定时器），再关服务
      await context?.dispose().catch(() => {});
      await server?.close().catch(() => {});
      appendLog('[quit] 已退出');
      app.exit(0);
    })();
  });

  app.whenReady().then(async () => {
    try {
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
