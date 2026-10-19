/**
 * 桌面窗口层的应用侧适配器。
 *
 * 真正的窗口逻辑在 `src/desktop/windows.js`（约 900 行手写 JS：透明置顶窗、
 * 点击穿透兜底、跨窗碰撞 broker、置顶看门狗、多显示器几何、DPI 线性化）。**刻意没有搬进 TS**：
 *
 *   - 它和同目录的 `sprite.js` / `events.js` / `preload.js` 是一套东西（渲染端脚本经 index.html
 *     顺序加载），搬走一个反而让"这个目录是一个完整运行时"这件事变模糊；
 *   - 那些注释里的实测数据（DWM 缺陷矩阵、DPI 探针的 DELTA、命中区判定）与代码行号一一对应，
 *     搬进 TS 打包后 `__dirname` 也会从 `src/desktop` 变成 `lib`，路径推导要重写一遍。
 *
 * 本文件只做三件薄事：
 *   1. **ready 之前**把「硬件加速 / force-device-scale-factor」这两件只能那时做的事做掉
 *      （`prepareDesktopRuntime`）；
 *   2. 把宿主注入的请求处理函数接给窗口层（渲染端 scheme → 同进程直调）；
 *   3. 实现 `PetDesktop`（start / stop），供宿主半边调用。
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

import type { DesktopResponse, DesktopStartOptions, PetDesktop } from '../core/desktop-api';

/** 窗口层暴露的最小接口（JS 文件没有类型，这里只声明用到的部分） */
interface WindowLayer {
  prepareRuntime(options?: { probe?: { command: string; args: string[] }; skipDpi?: boolean }): {
    forcedScale: number;
    primaryScale: number;
    uiScale: number;
  };
  /** 探测子进程：把主屏缩放打到 stdout 并退出（ready 之后调） */
  reportPrimaryScale(): void;
  createDesktop(options: {
    request?: (method: string, url: string, body?: string) => Promise<DesktopResponse>;
    configUrl?: string;
  }): {
    start(pets: Array<{ id: string; size: number }>): number;
    stop(): void;
    reload(pets: Array<{ id: string; size: number }>): number;
    dpi: { forcedScale: number; primaryScale: number; uiScale: number };
  };
  /** 托盘菜单（自绘窗口，见 windows.js 的说明）：原生菜单不跟随 DPI 补偿，150% 屏上偏小 */
  createTrayMenu(options: { onAction?: (action: string) => void }): {
    show(items: Array<{ label: string; action?: string }>): void;
    hide(): void;
    destroy(): void;
  };
}

/** DPI 线性化的结果（设置窗要用 uiScale 补偿尺寸，否则 150% 屏上会缩成 2/3） */
export interface DpiInfo {
  /** 实际强制的 device scale factor（0 = 未启用线性化） */
  forcedScale: number;
  /** 探测到的真实主屏缩放 */
  primaryScale: number;
  /** 非宠物 UI（设置窗）的补偿倍数 */
  uiScale: number;
}

let layer: WindowLayer | undefined;

/** 取窗口层（首次调用时加载；路径由包根拼出来，不依赖 cwd） */
function windowLayer(packageRoot: string): WindowLayer {
  if (layer) return layer;
  // 用 createRequire 而不是静态 import：这是一个**运行时路径**下的 CommonJS 文件，
  // 静态 import 会让打包器试图把它拉进产物（它自己又 require('electron')，会重复打一份）。
  const nodeRequire = createRequire(__filename);
  layer = nodeRequire(join(packageRoot, 'src', 'desktop', 'windows.js')) as WindowLayer;
  return layer;
}

/**
 * 必须在 `app.whenReady()` **之前**调用：硬件加速开关与 `force-device-scale-factor`
 * 都只能在 ready 前设置，ready 之后再设无效。
 *
 * @param options.packageRoot 包根（找 src/desktop/windows.js）
 * @param options.appMainScript 应用主进程脚本（DPI 探测子进程要再跑一遍它，见下）
 *
 * 为什么探测要再拉起一个自己：加了 `force-device-scale-factor` 之后 `screen` API 只会报被强制的值，
 * 真实主屏缩放就再也读不到了。所以首次启动先起一个**不带该开关**的短命子进程读一次并落盘，
 * 之后每次启动直接读缓存。子进程走 `--dpi-probe` 分支：不抢单实例锁、不起服务、不建窗口。
 */
export function prepareDesktopRuntime(options: {
  packageRoot: string;
  appMainScript: string;
  /** 本进程就是探测子进程：只装载模块，不做 DPI 线性化（见 windows.js 的 prepareRuntime） */
  probeMode?: boolean;
}): DpiInfo {
  return windowLayer(options.packageRoot).prepareRuntime({
    probe: { command: process.execPath, args: [options.appMainScript, '--dpi-probe'] },
    skipDpi: options.probeMode === true,
  });
}

/**
 * DPI 探测子进程的收尾：打印主屏缩放后退出。
 *
 * 单独成函数是为了让应用主进程和探测子进程共用同一份读取逻辑——探测进程走的也是
 * 本应用的 main 脚本，只是带了 `--dpi-probe` 参数（见 main.ts 的分支）。
 */
export function reportPrimaryScale(packageRoot: string): void {
  windowLayer(packageRoot).reportPrimaryScale();
}

/**
 * 建桌面窗口服务（ready 之后用）。
 *
 * @param options.packageRoot 包根
 * @param options.logger 日志（窗口层自己的输出走 console，这里只记关键节点）
 */
export function createDesktopService(options: {
  packageRoot: string;
  logger: { info(message: string): void };
}): PetDesktop {
  const { packageRoot, logger } = options;
  let desktop: ReturnType<WindowLayer['createDesktop']> | undefined;

  return {
    start(startOptions: DesktopStartOptions): number {
      const layerImpl = windowLayer(packageRoot);
      desktop ??= layerImpl.createDesktop({
        configUrl: startOptions.configUrl,
        // 渲染端的每条请求（配置/余额/碎碎念/素材）都直接落到宿主路由上
        request: (method, url, body) => startOptions.request({ method, url, body }),
      });
      const count = desktop.start(startOptions.pets);
      logger.info(`桌面窗口：${count} 个（${startOptions.pets.map((p) => p.id).join(', ') || '无'}）`);
      return count;
    },
    stop(): void {
      desktop?.stop();
    },
  };
}

/**
 * 建一个**自绘**托盘菜单（Windows/Linux 在 DPI 线性化下原生菜单偏小，见 windows.js）。
 *
 * @param options.packageRoot 包根（找 src/desktop/windows.js）
 * @param options.onAction 菜单项被点击：action 由调用方解释（打开设置 / 重载 / 检查更新 / …）
 */
export function createTrayMenuService(options: { packageRoot: string; onAction: (action: string) => void }): {
  show(items: Array<{ label: string; action?: string }>): void;
  hide(): void;
  destroy(): void;
} {
  return windowLayer(options.packageRoot).createTrayMenu({ onAction: options.onAction });
}
