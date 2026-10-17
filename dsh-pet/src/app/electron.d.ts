/**
 * `electron` 的最小类型声明（只覆盖本地应用用到的 API）。
 *
 * 为什么不装 `electron` 这个 devDependency：它的 postinstall 会下载 ~100MB 的运行时，
 * 而本项目**本来就不需要**再下一份（桌面 Helper 用的是 `$DSH_HOME/electron` 里那份，
 * 本地应用用启动器解析出的同一份）。为几十行类型引入一次大下载不划算。
 *
 * 代价：这份声明必须与真实 API 保持同步。它只被 `src/app/main.ts` 消费，
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
    on(event: 'click', listener: () => void): void;
  }

  export const shell: {
    openPath(path: string): Promise<string>;
    openExternal(url: string): Promise<void>;
  };

  interface App {
    setName(name: string): void;
    getName(): string;
    getPath(name: string): string;
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
