/**
 * `electron` 的最小类型声明（只覆盖本地应用用到的 API）。
 *
 * 为什么不装 `electron` 这个 devDependency：它的 postinstall 会下载 ~100MB 的运行时，
 * 而本项目**本来就不需要**再下一份（应用自带运行时；开发态由启动器准备一份到
 * `<用户缓存>/dsh-pet-ng/electron`）。为几十行类型引入一次大下载不划算。
 *
 * 代价：这份声明必须与真实 API 保持同步。它被 `src/main/main.ts`、`src/main/desktop.ts`
 * 与 `src/desktop/windows.js`（窗口层，跑在主进程里）共同消费——这三处用到的成员一览即全部，
 * 改主进程时如果这里缺字段，typecheck 会直接报出来（这正是目的）。
 */
declare module 'electron' {
  /** 窗口内容区矩形 */
  interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  /** 一个点（屏幕物理像素） */
  interface Point {
    x: number;
    y: number;
  }

  /**
   * 一块显示器。
   *
   * 注意：`bounds`/`workArea` 的单位取决于是否开了 `force-device-scale-factor`
   * （本应用锁成 1，于是就是物理像素）——见 src/desktop/windows.js 头部那一大段推导。
   */
  interface Display {
    id: number;
    scaleFactor: number;
    bounds: Rectangle;
    workArea: Rectangle;
  }

  /** 渲染端 console 消息事件（Electron 43 的签名：属性在事件对象上） */
  interface ConsoleMessageEvent {
    level: 'info' | 'warning' | 'error' | 'debug';
    message: string;
    lineNumber: number;
    sourceId: string;
  }

  /** 主进程收到的 IPC 事件：`sender` 用来反查是哪个窗口发来的 */
  interface IpcMainEvent {
    sender: WebContents;
  }

  /** 渲染进程发来的请求（custom scheme 的 protocol.handle 里拿到它） */
  interface ProtocolRequest {
    url: string;
    method: string;
    /** POST/PUT 的请求体 */
    text(): Promise<string>;
  }

  interface WebContents {
    id: number;
    send(channel: string, ...args: unknown[]): void;
    /** 页面级缩放（DPI 线性化时用来把宠物/菜单还原到 DIP 观感） */
    setZoomFactor(factor: number): void;
    /** 关掉后台节流：被其它透明窗遮挡时仍持续渲染（否则移开遮挡物会看到"消失"） */
    setBackgroundThrottling(allowed: boolean): void;
    isLoading(): boolean;
    on(event: 'console-message', listener: (event: ConsoleMessageEvent) => void): void;
    on(event: 'context-menu', listener: (event: { preventDefault(): void }) => void): void;
    on(event: 'did-finish-load', listener: () => void): void;
    once(event: 'did-finish-load', listener: () => void): void;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void;
    openDevTools(options?: { mode?: string }): void;
  }

  interface BrowserWindowOptions {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    x?: number;
    y?: number;
    title?: string;
    autoHideMenuBar?: boolean;
    backgroundColor?: string;
    show?: boolean;
    /** 宽高按内容区算（不含边框）；无边框窗两者等价，写上是为了和真实语义对齐 */
    useContentSize?: boolean;
    /** 允许窗口伸出屏幕（macOS 默认会把 y 钳到菜单栏下沿） */
    enableLargerThanScreen?: boolean;
    transparent?: boolean;
    frame?: boolean;
    alwaysOnTop?: boolean;
    skipTaskbar?: boolean;
    resizable?: boolean;
    movable?: boolean;
    minimizable?: boolean;
    maximizable?: boolean;
    fullscreenable?: boolean;
    hasShadow?: boolean;
    /** 可聚焦：对话输入框/菜单要能拿到焦点才打得了字 */
    focusable?: boolean;
    webPreferences?: {
      contextIsolation?: boolean;
      nodeIntegration?: boolean;
      sandbox?: boolean;
      preload?: string;
      /** 页面缩放（DPI 线性化时用来把设置页还原到 DIP 观感） */
      zoomFactor?: number;
      /**
       * 隐藏期不产首帧（省一次合成）。代价：`ready-to-show` **永不触发**，
       * 必须另有兜底显示路径（见 windows.js 的 #55 注释）。
       */
      paintWhenInitiallyHidden?: boolean;
      spellcheck?: boolean;
    };
  }

  export class BrowserWindow {
    constructor(options?: BrowserWindowOptions);
    /** 由 IPC 事件反查是哪个窗口发来的（`BrowserWindow.fromWebContents(event.sender)`） */
    static fromWebContents(webContents: WebContents): BrowserWindow | null;
    readonly id: number;
    readonly webContents: WebContents;
    loadURL(url: string): Promise<void>;
    /** 加载本地文件（托盘菜单页等）；query 用来把配置地址/几何注入渲染端 */
    loadFile(
      filePath: string,
      options?: { query?: Record<string, string>; search?: string; hash?: string },
    ): Promise<void>;
    on(event: 'closed', listener: () => void): void;
    on(event: 'blur', listener: () => void): void;
    once(event: 'ready-to-show', listener: () => void): void;
    isDestroyed(): boolean;
    isMinimized(): boolean;
    isVisible(): boolean;
    isFocused(): boolean;
    restore(): void;
    show(): void;
    /** 显示但不抢焦点（宠物窗绝不打断用户正在做的事） */
    showInactive(): void;
    hide(): void;
    focus(): void;
    destroy(): void;
    getBounds(): Rectangle;
    getContentBounds(): Rectangle;
    setBounds(rect: Rectangle): void;
    setContentBounds(rect: Rectangle, animate?: boolean): void;
    /** 点击穿透翻转；`forward: true` 让穿透期间仍转发 mousemove（命中判定要用） */
    setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
    setAlwaysOnTop(flag: boolean, level?: 'normal' | 'floating' | 'screen-saver'): void;
    setVisibleOnAllWorkspaces(flag: boolean, options?: { visibleOnFullScreen?: boolean }): void;
    setMenuBarVisibility(visible: boolean): void;
  }

  /** 主进程侧的 IPC：渲染端 `ipcRenderer.send` 的对端 */
  export const ipcMain: {
    on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void;
  };

  /** 显示器枚举与热更新（多屏几何的唯一来源） */
  export const screen: {
    getAllDisplays(): Display[];
    getPrimaryDisplay(): Display;
    getDisplayNearestPoint(point: Point): Display;
    getCursorScreenPoint(): Point;
    on(event: 'display-metrics-changed' | 'display-added' | 'display-removed', listener: () => void): void;
  };

  /** 自定义 scheme（渲染端页面是 file:// 源，直连 HTTP 会撞 CORS） */
  export const protocol: {
    /** 必须在 ready **之前**调用；只登记特权，不建 handler */
    registerSchemesAsPrivileged(
      schemes: {
        scheme: string;
        privileges: {
          standard?: boolean;
          secure?: boolean;
          supportFetchAPI?: boolean;
          corsEnabled?: boolean;
          /** 允许该 scheme 返回流式响应（大素材不必整块读进内存） */
          stream?: boolean;
          /** 允许该 scheme 的页面不受 CSP 限制（渲染端页面本身是 file://，无 CSP 头） */
          bypassCSP?: boolean;
        };
      }[],
    ): void;
    /** ready 之后调，每个 scheme 只注册一次 */
    handle(scheme: string, handler: (request: ProtocolRequest) => Response | Promise<Response>): void;
  };

  interface MenuItem {
    label?: string;
    type?: 'separator' | 'normal' | 'checkbox';
    click?: () => void;
  }

  export const Menu: {
    buildFromTemplate(template: MenuItem[]): unknown;
  };

  interface NotificationOptions {
    title?: string;
    body?: string;
    icon?: string;
    silent?: boolean;
  }

  export class Notification {
    constructor(options: NotificationOptions);
    static isSupported(): boolean;
    on(event: 'click', listener: () => void): void;
    show(): void;
  }

  interface NativeImage {
    isEmpty(): boolean;
    resize(options: { width?: number; height?: number }): NativeImage;
  }

  export const nativeImage: {
    createFromPath(path: string): NativeImage;
    createEmpty(): NativeImage;
  };

  export class Tray {
    constructor(image: NativeImage);
    setToolTip(text: string): void;
    setContextMenu(menu: unknown): void;
    /** 'click' = 左键；'right-click' = 右键（Windows/Linux 下没设原生菜单时用来弹自绘菜单） */
    on(event: 'click' | 'right-click', listener: () => void): void;
  }

  /**
   * 系统级加密（Windows DPAPI / macOS Keychain / Linux libsecret）。
   * 用来给落盘的 API Key 加密：密文绑定当前用户，换机器/换账号解不开。
   */
  export const safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(plainText: string): Buffer;
    decryptString(encrypted: Buffer): string;
  };

  export const shell: {
    openPath(path: string): Promise<string>;
    openExternal(url: string): Promise<void>;
  };

  /**
   * 电源与用户活跃度（只声明本项目用到的部分）。
   *
   * 主动陪伴用它判断"人在不在"：`getSystemIdleTime()` 只返回**秒数**，
   * 不涉及任何窗口标题、应用名或输入内容——这是有意守住的隐私边界。
   */
  export const powerMonitor: {
    /** 距最后一次用户输入（键鼠）的秒数 */
    getSystemIdleTime(): number;
  };

  /** `app.setLoginItemSettings` 的入参（只声明本项目用到的字段） */
  interface LoginItemSettings {
    /** 登录时启动 */
    openAtLogin: boolean;
    /** Windows：要注册的可执行文件（默认 `process.execPath`） */
    path?: string;
    /** Windows：跟在可执行文件后的参数（源码态要带主进程脚本） */
    args?: string[];
  }

  interface App {
    /** 是否运行在打包后的应用里（`false` = 开发态 `electron lib/app-main.cjs`） */
    readonly isPackaged: boolean;
    /** 命令行开关（`force-device-scale-factor` / `autoplay-policy` 等只能在 ready 之前追加） */
    readonly commandLine: { appendSwitch(name: string, value?: string): void };
    /** 关掉硬件加速（同样只能在 ready 之前） */
    disableHardwareAcceleration(): void;
    setName(name: string): void;
    getName(): string;
    getPath(name: string): string;
    /** 覆盖 Electron 的路径（必须在 ready 之前调用）：本地应用用它把 profile 收进数据目录 */
    setPath(name: string, path: string): void;
    getVersion(): string;
    /** 开机自启：Windows 写 HKCU 的 Run 项，macOS 写登录项（Linux 是空实现，见 autostart.ts） */
    setLoginItemSettings(settings: LoginItemSettings): void;
    getLoginItemSettings(options?: { path?: string; args?: string[] }): { openAtLogin: boolean };
    requestSingleInstanceLock(): boolean;
    whenReady(): Promise<void>;
    quit(): void;
    exit(code?: number): void;
    on(event: 'second-instance', listener: () => void): void;
    on(event: 'window-all-closed', listener: () => void): void;
    on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): void;
  }

  export const app: App;

  /**
   * 渲染进程 → 主进程的单向消息通道（`src/desktop/preload.js` 只用这两个原语）。
   *
   * `on` 的附加参数是 `unknown[]`：Electron 的真实签名是 `any[]`（它没法为每个 channel
   * 生成类型），这里收紧成 `unknown` 是**故意**的——负载形状必须由订阅方显式收窄，
   * 想直接当具体类型用就得写一次 JSDoc 断言（见 preload.js 的 onDisplays / onTrayMenu）。
   */
  export const ipcRenderer: {
    send(channel: string, ...args: unknown[]): void;
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  };

  /** 把一组函数安全地暴露到渲染端的 window 上（contextIsolation 下唯一通道） */
  export const contextBridge: {
    exposeInMainWorld(apiKey: string, api: unknown): void;
  };
}
