/**
 * 系统通知的帧管道。
 *
 * 应用把「一次对话生成」合成 turn/start、turn/end 会话事件投进来，这里据此生成通知帧写进
 * 状态仓的 `sections.notify`，主进程轮询到变化后弹原生通知（见 src/main/notifications.ts）。
 *
 * 三件事：
 *   1. **单槽推帧**：同一秒来多条只留最后一条——1 秒内连弹多个系统通知本身没有意义；
 *   2. **终态清理**：success/error 展示约 60s 后清掉该会话条目，陈旧完成态不再浮上来；
 *   3. **活动门**：「对话完成」不立刻弹，先挂起 1.5s 再确认这条会话确实没活了才弹
 *      （在跑的子代理 / 后台任务 / 活跃提醒任一非空 → 丢弃这一帧）。
 *
 * 为什么活动门必须延迟而不是同步查：`workspace/session-activity` 的 turn 族读的是**活 Agent 的
 * status**，而 turn/end 是在回合体的 finally 里追加的——同步那一刻它自己还是 running，判据必然
 * 非空，照「任一非空就不弹」写会把每一条通知都吞掉（详见 notify-events.ts 的 hasBlockingActivity）。
 * 延迟同时让「成员刚变 idle、Lead 下一秒又把它唤醒」的窗口过去。
 *
 * 判据不可用（宿主没组合 workspace、standalone 伪 ctx 没有 waterfall、调用抛错、返回值形状不对）
 * → 一律放行：宁可多弹一条，也不能让通知被一次宿主变更整体打哑。
 */
import { hasBlockingActivity, reduceNotifyFrame, type HostNotifyFrame } from './notify-events';
import type { WorkStatusStore } from './work-status';

/** waterfall 只用到签名本身：未导出该事件的请求/响应类型，这里宽松声明 */
export type Waterfall = (name: string, request: unknown, next: () => Promise<unknown[]>) => Promise<unknown>;

export interface NotifyPipelineOptions {
  /** 写一帧到状态仓（`state.writeSection('notify', frame)`） */
  writeFrame: (frame: HostNotifyFrame) => void;
  workStatus: WorkStatusStore;
  /** 终态清理后要把变化写回状态仓 */
  publishWorkStatus: () => void;
  /** 宿主的活动查询能力（缺省 = 判据不可用 → 放行） */
  waterfall?: Waterfall;
}

export interface NotifyPipeline {
  /** 直接推一帧（单槽，后到覆盖先到） */
  pushFrame(frame: HostNotifyFrame): void;
  /** 排一个活动门定时器：到点确认空闲才推这一帧 */
  scheduleCompletion(sessionId: string, event: unknown): void;
  /** 工作状态变化时同步终态清理定时器（success/error 排，其余取消） */
  onTerminalState(sessionId: string, next: string): void;
  /** 取消某会话待执行的终态清理 */
  cancelTerminal(sessionId: string): void;
  /** 释放全部定时器（退出时调用） */
  dispose(): void;
}

/** 终态（success/error）展示窗口：约 60s 后清掉该会话条目 */
const TERMINAL_KEEP_MS = 60 * 1000;
/** 活动门延迟 */
const NOTIFY_ACTIVITY_DELAY_MS = 1500;

export function createNotifyPipeline(options: NotifyPipelineOptions): NotifyPipeline {
  const { writeFrame, workStatus, publishWorkStatus, waterfall } = options;

  /** 单槽推帧 */
  const pushFrame = (frame: HostNotifyFrame): void => {
    writeFrame(frame);
  };

  /** 每会话一个终态清理定时器 */
  const terminalTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const cancelTerminal = (sessionId: string): void => {
    const t = terminalTimers.get(sessionId);
    if (t === undefined) return;
    clearTimeout(t);
    terminalTimers.delete(sessionId);
  };

  const scheduleTerminalCleanup = (sessionId: string): void => {
    if (terminalTimers.has(sessionId)) return;
    const t = setTimeout(() => {
      terminalTimers.delete(sessionId);
      const sessionState = workStatus.stateOf(sessionId);
      if (sessionState === 'success' || sessionState === 'error') {
        workStatus.clear(sessionId); // 条目连同任务详情文案一起消失，不残留到后续活动
        publishWorkStatus(); // 清完要写 S：否则前端一直挂着那条陈旧完成态
      }
    }, TERMINAL_KEEP_MS);
    terminalTimers.set(sessionId, t);
  };

  /** 每会话一个待查定时器（同会话连续收尾只保留最后一次，与单槽帧同语义） */
  const activityTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** 这条会话是否还有在跑的活；判据不可用一律 false＝放行 */
  const sessionHasRunningWork = async (sessionId: string): Promise<boolean> => {
    if (typeof waterfall !== 'function') return false;
    try {
      const activity = await waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
      return hasBlockingActivity(activity);
    } catch {
      return false; // 查询失败不阻塞通知（与「判据不可用时放行」同一策略）
    }
  };

  const scheduleCompletion = (sessionId: string, event: unknown): void => {
    const prev = activityTimers.get(sessionId);
    if (prev !== undefined) clearTimeout(prev);
    activityTimers.set(
      sessionId,
      setTimeout(() => {
        activityTimers.delete(sessionId);
        void (async () => {
          if (await sessionHasRunningWork(sessionId)) return; // 还有活：等真正的收尾轮再弹
          const frame = reduceNotifyFrame(event as Parameters<typeof reduceNotifyFrame>[0]);
          if (frame) pushFrame(frame);
        })();
      }, NOTIFY_ACTIVITY_DELAY_MS),
    );
  };

  return {
    pushFrame,
    scheduleCompletion,
    onTerminalState(sessionId: string, next: string): void {
      if (next === 'success' || next === 'error') scheduleTerminalCleanup(sessionId);
      else cancelTerminal(sessionId);
    },
    cancelTerminal,
    dispose(): void {
      for (const t of terminalTimers.values()) clearTimeout(t);
      terminalTimers.clear();
      for (const t of activityTimers.values()) clearTimeout(t);
      activityTimers.clear();
    },
  };
}
