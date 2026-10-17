/**
 * 本地应用的系统通知：轮询 `/state`，把宿主写进 `sections.notify` 的通知帧翻成
 * **系统级原生通知**（Electron `Notification`）。
 *
 * 为什么不复用 `src/client/notify.ts`：那是浏览器侧实现（Web Notification API + 页面聚焦判定），
 * 而本地应用没有浏览器页面——宠物是独立透明窗口，用户此时很可能正在别的应用里，
 * 「窗口失焦才弹」这条规则在这里恰好**永远成立**，所以直接弹原生通知就是正确行为。
 * 帧 → 文案的映射仍然复用 `shared/notify.ts` 的 `frameToToast`（单一来源，不另写一套文案）。
 *
 * 事件来源：本地没有 DSH 会话，通知帧由 `main.ts` 把「一次对话生成」合成
 * `turn/start` / `turn/end` 会话事件投给插件（见 `context.ts` 的 `emit`），
 * 插件自己的 `notify-events.ts` 据此生成帧——因此这里的帧语义与 DSH 内**完全一致**。
 *
 * 另加一类本地专有提醒：余额/额度已用 ≥ 90%（DSH 里余额只播动画，不弹通知）。
 */
import { readBalance } from '../shared/state';
import { balancePercent, type BalanceView } from '../shared/balance';
import { frameToToast, type NotifyFrame } from '../shared/notify';
import type { AppConfig } from './local-config';

/** 轮询间隔（与浏览器容器一致：1s） */
const POLL_MS = 1000;
/** 余额告急阈值（已用百分比） */
const BALANCE_ALERT_PERCENT = 90;

export interface NotifyWatcherDeps {
  /** 本地服务端口（现读） */
  port: () => number;
  /** 现读配置（通知开关） */
  config: () => AppConfig;
  /** 弹一条系统通知 */
  show(title: string, body: string, iconName: string): void;
  /** 日志 */
  log(message: string): void;
}

/** 状态叶子的通用形状 */
interface Leaf {
  counter?: number;
  data?: unknown;
}

/** 读一个分区的叶子 */
function sectionOf(state: unknown, name: string): Leaf | undefined {
  const sections = (state as { sections?: Record<string, unknown> } | null)?.sections;
  const leaf = sections?.[name];
  return leaf && typeof leaf === 'object' ? (leaf as Leaf) : undefined;
}

/**
 * 起通知轮询。
 * @returns 停止函数
 */
export function startNotifyWatcher(deps: NotifyWatcherDeps): () => void {
  let stopped = false;
  let inFlight = false;
  /** 上一次看到的 notify 计数（首拉只记基线，不补弹历史帧——与浏览器容器同语义） */
  let notifyCounter: number | undefined;
  /** 上一次看到的余额计数 */
  let balanceCounter: number | undefined;
  /** 本轮是否已经就余额告急提醒过（回落到阈值以下时复位） */
  let balanceAlerted = false;

  const handleNotify = (leaf: Leaf): void => {
    if (notifyCounter === undefined) {
      notifyCounter = leaf.counter ?? 0;
      return;
    }
    if ((leaf.counter ?? 0) === notifyCounter) return;
    notifyCounter = leaf.counter ?? 0;
    const toast = frameToToast((leaf.data ?? {}) as NotifyFrame);
    if (!toast) return;
    // 开关只关「对话完成」一类（本地唯一会产生的是它）；其余类型保持放行
    const config = deps.config();
    if (toast.title === '对话完成' && !config.notify.chatReply) return;
    deps.show(toast.title, toast.body, toast.icon);
  };

  const handleBalance = (leaf: Leaf): void => {
    if (balanceCounter === undefined) {
      balanceCounter = leaf.counter ?? 0;
      return;
    }
    if ((leaf.counter ?? 0) === balanceCounter) return;
    balanceCounter = leaf.counter ?? 0;
    const read = readBalance(leaf as Parameters<typeof readBalance>[0]);
    if (!read || !read.state.ok) return;
    const percent = balancePercent(read.state as BalanceView);
    if (percent === undefined) return;
    if (percent < BALANCE_ALERT_PERCENT) {
      balanceAlerted = false;
      return;
    }
    if (balanceAlerted) return;
    balanceAlerted = true;
    if (!deps.config().notify.balanceAlert) return;
    const name = (read.state as { provider?: string }).provider ?? '';
    deps.show('余额/额度告急', `已用 ${Math.round(percent)}%（${name}）`, 'notify-truncated');
  };

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const res = await fetch(`http://127.0.0.1:${deps.port()}/dsh-pet-7340/state`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return;
      const state: unknown = await res.json();
      const notify = sectionOf(state, 'notify');
      if (notify) handleNotify(notify);
      const balance = sectionOf(state, 'balance');
      if (balance) handleBalance(balance);
    } catch (error) {
      // 服务还没起来 / 正在重启：下一拍再试，不刷日志
      if (!stopped && process.env.DSH_PET_APP_DEBUG === '1') {
        deps.log(`通知轮询失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), POLL_MS);
  // 立即跑一拍，把基线记下来（否则启动后第一条真实通知会被当成基线吞掉）
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
