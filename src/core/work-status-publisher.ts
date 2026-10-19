/**
 * 工作状态的发布与「外部状态灯」。
 *
 * 两件事：
 *   1. **快照发布**：把 WorkStatusStore 的聚合结果写进状态仓的 `workStatus` 区。
 *      只在内容真的变了时才写——每次写都会推进 counter，前端据此重播档位动画；会话事件很密
 *      （每个 tool/call 都来），无条件写会把动画刷成幻灯片。判据用**内容**（state + task）
 *      而不是 store 的 ts：ts 是 Date.now()（毫秒分辨率），同一毫秒内连改两次会被误判成
 *      "没变化"而漏写（测试里连发事件就会踩到）。
 *   2. **外部状态灯**（`POST /work-status`）：脚本 / IDE 插件 / CI 把桌宠当一盏灯用。
 *      离开 DSH 之后，6 个档位里只有「思考 / 成功 / 出错」还能被真实事件触发，另外三个
 *      （working / result / waiting）描述的是「agent 在调工具、在等你确认」——本地没有 agent。
 *      与其让它们变成死档位，不如把入口开放出去。
 *
 * 外部灯**复用同一条链路**：写进同一个 WorkStatusStore（独立会话 id），动画、气泡文案、
 * 优先级聚合、终态清理全部沿用，渲染端零改动。
 */
import { EXTERNAL_STATUS_SESSION, WorkStatusStore, type ExternalWorkStatusInput } from './work-status';

export interface WorkStatusPublisherOptions {
  /** 把快照写进状态仓（`state.writeSection('workStatus', data)`） */
  writeSection: (data: { state: string | null; task: string | null }) => void;
}

export interface WorkStatusPublisher {
  /** 底层的聚合仓（会话事件、通知管道都要用） */
  store: WorkStatusStore;
  /** 把当前快照写进状态仓（内容没变则跳过） */
  publish(): void;
  /** 外部状态灯：写入 / 清除 */
  applyExternal(input: ExternalWorkStatusInput): void;
  /** 清掉 TTL 定时器（退出时调用） */
  dispose(): void;
}

export function createWorkStatusPublisher(options: WorkStatusPublisherOptions): WorkStatusPublisher {
  const { writeSection } = options;
  const store = new WorkStatusStore();

  let publishedWork = '\u0000';
  const publish = (): void => {
    const snap = store.snapshot();
    const key = String(snap.state) + '\u0000' + String(snap.task);
    if (key === publishedWork) return;
    publishedWork = key;
    writeSection({ state: snap.state, task: snap.task });
  };

  let externalClearTimer: ReturnType<typeof setTimeout> | undefined;

  const applyExternal = (input: ExternalWorkStatusInput): void => {
    // 每次写入都重排 TTL：后一次写入代表"任务还在继续"，不该被上一条的定时器提前清掉
    if (externalClearTimer) {
      clearTimeout(externalClearTimer);
      externalClearTimer = undefined;
    }
    if (input.state === null) {
      if (store.clear(EXTERNAL_STATUS_SESSION)) publish();
      return;
    }
    // 终态排他：先扫掉别处遗留的终态（对话刚结束的成功/出错会挂 60s），否则它们按优先级/seq
    // 抢走展示——「灯点亮了，宠物还在演上一轮结果」，或者反过来灯的成功文案压住真实对话结果
    // （外部 seq = Date.now()，永远比会话事件新）。进行中的档位不动：那是真的在干活。
    if (input.state === 'success' || input.state === 'error') {
      store.setTerminal(EXTERNAL_STATUS_SESSION, input.state, Date.now());
    } else {
      store.clearTerminal(EXTERNAL_STATUS_SESSION);
      store.setState(EXTERNAL_STATUS_SESSION, input.state, Date.now());
    }
    store.setTask(EXTERNAL_STATUS_SESSION, input.text);
    publish();
    if (input.ttlSec > 0) {
      externalClearTimer = setTimeout(() => {
        externalClearTimer = undefined;
        if (store.clear(EXTERNAL_STATUS_SESSION)) publish();
      }, input.ttlSec * 1000);
      externalClearTimer.unref?.();
    }
  };

  return {
    store,
    publish,
    applyExternal,
    dispose(): void {
      if (externalClearTimer) {
        clearTimeout(externalClearTimer);
        externalClearTimer = undefined;
      }
    },
  };
}
