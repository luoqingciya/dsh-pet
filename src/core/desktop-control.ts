/**
 * 桌面窗口的生命周期。
 *
 * 「哪些宠物该显示在桌面」由配置决定，「怎么把窗口开出来」由应用注入的 `PetDesktop` 决定
 * （`src/main/desktop.ts`）。这一层只做两者之间的调度：
 *
 *   - **refresh**：重读配置，判断还有没有桌面可见的宠物（没有就别开窗）；
 *   - **start / stop**：按需拉起 / 销毁全部窗口；
 *   - **sync**：配置变更后重建——串行队列保证"最后一次配置"一定最后生效。
 *
 * 为什么 sync 要排队：连续保存会触发多次重建，不串行的话中间态会互相打乱。
 * 合并进程前这里还要「等旧 helper 真正退出再 spawn 新的」（issue #64：旧窗口没消失、新窗口
 * 已经画出来，用户看到两只宠物）；现在销毁是同步的，`stop()` 返回时窗口已经没了，不需要等。
 * 队列自身绝不留下 rejected 状态，否则后续保存再也不会重建。
 *
 * **与路由层的循环依赖**：桌面窗口的请求要落回同一份路由实现（`handleRequest`），而路由层
 * 重建窗口又要调 `sync()`。两个方向都用**延迟回调**解开——创建时只传函数引用，真正调用发生在
 * 启动之后，不会形成模块级循环 import。
 */
import type { DesktopRequest, DesktopResponse, PetDesktop } from './desktop-api';

/** 该宠物是否参与桌面模式（Electron 透明窗） */
export function isDesktopVisible(display: unknown): boolean {
  return display === 'desktop' || display === 'both';
}

export interface DesktopControlOptions {
  /** 应用注入的桌面窗口能力；纯 Node 环境（单测 / 脚本）为 undefined */
  desktop: PetDesktop | undefined;
  /** 当前监听端口（0 = 服务还没起来，会延迟重试） */
  resolvePort: () => number;
  /** 路由前缀，用于拼渲染端要拉的配置地址 */
  routePrefix: string;
  /** 渲染端请求 → 路由结果（由 api 层注入） */
  handleRequest: (req: DesktopRequest) => Promise<DesktopResponse>;
  /** 配置里的成品宠物列表（`flattenPetList(readAllConfig(...))`） */
  listPets: () => Record<string, unknown>[];
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; debug?: (m: string) => void };
}

export interface DesktopControl {
  /** 重读配置，刷新"有没有桌面可见宠物"的判断 */
  refresh(): void;
  /** 桌面可见宠物列表（`[{id,size}]`）：应用据此决定开几个局部窗口 */
  pets(): Array<{ id: string; size: number }>;
  /** 按当前配置把窗口开出来（无桌面能力 / 无可见宠物时什么都不做） */
  start(): void;
  /** 销毁全部窗口（保留配置，可再次拉起） */
  stop(reason?: string): void;
  /** 配置变更后重建（串行） */
  sync(): Promise<void>;
  /** 退出：停窗口 + 清重试定时器 */
  dispose(): void;
}

export function createDesktopControl(options: DesktopControlOptions): DesktopControl {
  const { desktop, resolvePort, routePrefix, handleRequest, listPets, logger } = options;

  let hasDesktopPet = false;
  let disposed = false;
  let running = false;
  let startRetryTimer: NodeJS.Timeout | undefined;
  let syncQueue: Promise<void> = Promise.resolve();

  const refresh = (): void => {
    hasDesktopPet = false;
    try {
      hasDesktopPet = listPets().some((p) => isDesktopVisible(p.display));
    } catch (e) {
      logger?.warn?.(`[dsh-petNG] 宠物配置非法，桌面模式已跳过：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  refresh();

  const pets = (): Array<{ id: string; size: number }> => {
    try {
      return listPets()
        .filter((p) => isDesktopVisible(p.display))
        .map((p) => ({ id: String(p.id), size: Number(p.size) }));
    } catch {
      return [];
    }
  };

  const start = (): void => {
    if (disposed || !desktop || running) return;
    if (!hasDesktopPet) return; // 没有任何宠物 display 含 desktop/both：不开窗口
    const port = resolvePort();
    if (!port || port <= 0) {
      // 服务可能尚未完成监听（OS 分配端口时 port 短暂为 0）：延迟重试。
      if (!startRetryTimer) {
        startRetryTimer = setTimeout(() => {
          startRetryTimer = undefined;
          start();
        }, 500);
        startRetryTimer.unref?.();
      }
      return;
    }
    const configUrl = `http://127.0.0.1:${port}${routePrefix}/config`;
    try {
      const count = desktop.start({ pets: pets(), configUrl, request: handleRequest });
      running = count > 0;
      logger?.info?.(`dsh-petNG 桌面窗口已就绪：${count} 个`);
    } catch (e) {
      running = false;
      logger?.warn?.(`dsh-petNG 桌面窗口创建失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const stop = (reason = 'settings-change'): void => {
    if (startRetryTimer) {
      clearTimeout(startRetryTimer);
      startRetryTimer = undefined;
    }
    if (!running) return;
    running = false;
    logger?.debug?.(`dsh-petNG 桌面窗口关闭（${reason}）`);
    desktop?.stop();
  };

  return {
    refresh,
    pets,
    start,
    stop,
    sync(): Promise<void> {
      syncQueue = syncQueue
        .then(async () => {
          refresh();
          stop('desktop-config-change');
          start();
        })
        .catch((e: unknown) => {
          logger?.warn?.(`[dsh-petNG] 重建桌面窗口失败：${e instanceof Error ? e.message : String(e)}`);
        });
      return syncQueue;
    },
    dispose(): void {
      disposed = true;
      stop('host-dispose');
    },
  };
}
