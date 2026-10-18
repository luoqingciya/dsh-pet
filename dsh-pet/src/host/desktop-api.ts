/**
 * 「桌面窗口」能力的契约 —— 宿主半边（`src/host`）与桌面实现（`src/app/desktop.ts`）之间唯一的接口。
 *
 * 为什么要有这层接口：宿主负责**哪些宠物该显示在桌面上**（配置合并、display 过滤），
 * 应用负责**怎么把窗口开出来**（Electron 透明窗）。宿主不该 import Electron（它要能在纯 Node
 * 下跑单测），应用也不该知道配置怎么合并。两边只在这里握手。
 *
 * 合并进程前，这条边界是「宿主 spawn 一个 Electron 子进程 + 管道协议」；现在是一次函数调用，
 * 契约不变（同样是 start/stop + 一次请求处理），所以宿主侧的改动只是把 spawn 换成调用。
 */

/** 渲染端的一次请求（URL 已去掉 scheme，形如 `/dsh-pet-7340/state?x=1`） */
export interface DesktopRequest {
  method: string;
  url: string;
  body?: string;
}

/** 宿主对一次请求的应答：json/text 走 body；素材走 file（绝对路径，窗口层自行读盘） */
export interface DesktopResponse {
  status: number;
  contentType?: string;
  body?: string;
  /** 素材文件的绝对路径（webm / 字体 / 图片）：二进制不过 JSON，窗口层直接读盘 */
  file?: string;
}

export interface DesktopStartOptions {
  /** 桌面可见的宠物（每只一个窗口） */
  pets: Array<{ id: string; size: number }>;
  /** 渲染端拉配置的地址（写进窗口 URL 的 query） */
  configUrl: string;
  /** 渲染端请求处理函数（宿主注入，内部就是 handlePetRoute） */
  request: (req: DesktopRequest) => Promise<DesktopResponse>;
}

export interface PetDesktop {
  /** 建（或重建）全部宠物窗口。返回实际创建的窗口数 */
  start(options: DesktopStartOptions): number;
  /** 销毁全部宠物窗口 */
  stop(): void;
}
