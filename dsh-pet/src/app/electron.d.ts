/**
 * `electron` 的最小类型声明（只覆盖本地应用用到的 API）。
 *
 * 为什么不装 `electron` 这个 devDependency：它的 postinstall 会下载 ~100MB 的运行时，
 * 而本项目**本来就不需要**再下一份（应用自带运行时；开发态由启动器准备一份到
 * `$DSH_HOME/electron`）。为几十行类型引入一次大下载不划算。
 *
 * 代价：这份声明必须与真实 API 保持同步。它只被 `src/app/main.ts` 与
 * `runtime/electron-helper/windows.js` 的调用方（src/app/desktop.ts）间接消费，
 * 用到的成员一览即全部——改主进程时如果这里缺字段，typecheck 会直接报出来（这正是目的）。
 */
declare module 'electron' {
  /** 窗口内容区矩形 */
  interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  /** 渲染端 console 消息事件（Electron 43 的签名：属性在事件对象上） */
  interface ConsoleMessageEvent {
    level: 'info' | 'warning' | 'error' | 'debug';
    message: string;
    lineNumber: number;
    sourceId: string;
  }

  interface WebContents {
    on(event: 'console-message', listener: (event: ConsoleMessageEvent) => void): void;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void;
    openDevTools(options?: { mode?: string }): void;
  }

  interface BrowserWindowOptions {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    title?: string;
    autoHideMenuBar?: boolean;
    backgroundColor?: string;
    show?: boolean;
    webPreferences?: {
      contextIsolation?: boolean;
      nodeIntegration?: boolean;
      sandbox?: boolean;
      preload?: string;
      /** 页面缩放（DPI 线性化时用来把设置页还原到 DIP 观感） */
      zoomFactor?: number;
    };
  }

  export class BrowserWindow {
    constructor(options?: BrowserWindowOptions);
    readonly webContents: WebContents;
    loadURL(url: string): Promise<void>;
    on(event: 'closed', listener: () => void): void;
    isDestroyed(): boolean;
    isMinimized(): boolean;
    restore(): void;
    show(): void;
    focus(): void;
  }

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

  interface App {
    /** 是否运行在打包后的应用里（`false` = 开发态 `electron lib/app-main.cjs`） */
    readonly isPackaged: boolean;
    setName(name: string): void;
    getName(): string;
    getPath(name: string): string;
    /** 覆盖 Electron 的路径（必须在 ready 之前调用）：本地应用用它把 profile 收进数据目录 */
    setPath(name: string, path: string): void;
    getVersion(): string;
    requestSingleInstanceLock(): boolean;
    whenReady(): Promise<void>;
    quit(): void;
    exit(code?: number): void;
    on(event: 'second-instance', listener: () => void): void;
    on(event: 'window-all-closed', listener: () => void): void;
    on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): void;
  }

  export const app: App;
}
