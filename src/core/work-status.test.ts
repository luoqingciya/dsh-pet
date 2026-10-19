/**
 * host 工作状态纯逻辑单元测试 —— 钉住两件事：
 *   ① 事件 → 档位的压缩（turn/start、turn/end 的 completed/error/max-tokens/blocked/aborted）；
 *   ② 任务详情文案与按会话聚合（issue #59）：多个 in_progress 取**最后**一个、清单全完成 → null、
 *      超长按码点截断；WorkStatusStore 的 task 挂在会话条目上，展示时与 state 同源同会话，
 *      条目一清文案就消失（"任务结束后永久残留"的根治点）。
 *
 * 跑法：node --experimental-strip-types --test src/core/work-status.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  currentTaskFromTodo,
  parseExternalWorkStatus,
  reduceWorkStatus,
  EXTERNAL_STATUS_DEFAULT_TTL_SEC,
  EXTERNAL_STATUS_MAX_TTL_SEC,
  TASK_TEXT_MAX,
  WorkStatusStore,
  type HostWorkStatusState,
} from './work-status.ts';

describe('reduceWorkStatus —— 事件 → 档位', () => {
  const end = (kind: string) => ({ type: 'turn/end', data: { reason: { kind } } });

  test('turn/start → thinking', () => {
    assert.equal(reduceWorkStatus({ type: 'turn/start', data: {} }), 'thinking');
  });

  test('turn/end：completed → success、错误系 → error、blocked → waiting', () => {
    assert.equal(reduceWorkStatus(end('completed')), 'success');
    assert.equal(reduceWorkStatus(end('error')), 'error');
    assert.equal(reduceWorkStatus(end('max-tokens')), 'error');
    assert.equal(reduceWorkStatus(end('timeout')), 'error');
    assert.equal(reduceWorkStatus(end('blocked')), 'waiting');
  });

  test('aborted / 未知 reason → null（调用方据此把会话清回空闲）', () => {
    assert.equal(reduceWorkStatus(end('aborted')), null);
    assert.equal(reduceWorkStatus({ type: 'turn/end', data: {} }), null);
  });

  test('工具与审批类事件', () => {
    assert.equal(reduceWorkStatus({ type: 'tool/call', data: { name: 'read' } }), 'working');
    assert.equal(reduceWorkStatus({ type: 'tool/call', data: { name: 'ask_user_question' } }), 'waiting');
    assert.equal(reduceWorkStatus({ type: 'tool/result', data: {} }), 'result');
    assert.equal(reduceWorkStatus({ type: 'approval/asked', data: {} }), 'waiting');
  });

  test('不认识的事件 → null（不切动画）', () => {
    assert.equal(reduceWorkStatus({ type: 'todo/write', data: {} }), null);
  });
});

describe('currentTaskFromTodo —— 任务详情文案（issue #59）', () => {
  const todo = (...items: Array<[string, string]>) => ({
    data: { todos: items.map(([status, content]) => ({ status, content })) },
  });

  test('单个 in_progress → 它的文案', () => {
    assert.equal(
      currentTaskFromTodo(todo(['completed', '第一步'], ['in_progress', '正在执行 phase1'])),
      '正在执行 phase1',
    );
  });

  test('多个 in_progress → 取**最后一个**（最近开始的那步）', () => {
    // 成因：agent 把新步骤标 in_progress 却忘了收上一步；取第一个就会永远停在最早那步
    const event = todo(['in_progress', '正在执行 phase1'], ['in_progress', '正在执行 phase2']);
    assert.equal(currentTaskFromTodo(event), '正在执行 phase2');
  });

  test('无 in_progress → 回落到第一个 pending；都没有 → null', () => {
    assert.equal(currentTaskFromTodo(todo(['completed', 'a'], ['pending', 'b'], ['pending', 'c'])), 'b');
    assert.equal(currentTaskFromTodo(todo(['completed', 'a'], ['completed', 'b'])), null);
    assert.equal(currentTaskFromTodo(todo()), null);
  });

  test('空清单 / 缺字段 / 非数组 / 空白内容 → null（绝不产出空串气泡）', () => {
    assert.equal(currentTaskFromTodo({}), null);
    assert.equal(currentTaskFromTodo({ data: {} }), null);
    assert.equal(currentTaskFromTodo({ data: { todos: 'x' as unknown as [] } }), null);
    assert.equal(currentTaskFromTodo(todo(['in_progress', '   '])), null);
    assert.equal(currentTaskFromTodo(todo(['in_progress', ''])), null);
  });

  test('超长文案按码点截断加省略号，恰好到上限不截断', () => {
    const long = '甲'.repeat(TASK_TEXT_MAX + 1);
    const cut = currentTaskFromTodo(todo(['in_progress', long]));
    assert.equal(cut, `${'甲'.repeat(TASK_TEXT_MAX)}…`);
    assert.equal(Array.from(cut ?? '').length, TASK_TEXT_MAX + 1); // 40 字 + 省略号
    assert.equal(currentTaskFromTodo(todo(['in_progress', '乙'.repeat(TASK_TEXT_MAX)])), '乙'.repeat(TASK_TEXT_MAX));
  });

  test('截断不劈开代理对（emoji 不会被截成半个字符）', () => {
    const text = '🐟'.repeat(TASK_TEXT_MAX + 5);
    const cut = currentTaskFromTodo(todo(['in_progress', text])) ?? '';
    assert.equal(Array.from(cut).length, TASK_TEXT_MAX + 1); // 40 个 emoji + 省略号
    assert.equal(cut.includes('\uFFFD'), false);
    assert.equal(/[\uD800-\uDBFF]$/.test(cut), false, '不得以孤立高位代理结尾');
  });
});

describe('WorkStatusStore —— 按会话聚合与展示（issue #59）', () => {
  test('state 变化才更新 ts；同状态同 seq 不重复更新（防刷屏）', () => {
    const s = new WorkStatusStore();
    assert.equal(s.setState('a', 'thinking', 1), true);
    const ts1 = s.snapshot().ts;
    assert.equal(s.setState('a', 'thinking', 1), false, '同状态同 seq → 无变化');
    assert.equal(s.snapshot().ts, ts1);
    assert.equal(s.setState('a', 'working', 2), true);
    assert.equal(s.snapshot().state, 'working');
  });

  test('task 随会话条目存取，且与 state 同源取同一个会话', () => {
    const s = new WorkStatusStore();
    s.setState('a', 'working', 1);
    assert.equal(s.has('a'), true);
    assert.equal(s.setTask('a', '正在执行 phase1'), true);
    assert.deepEqual(
      { state: s.snapshot().state, task: s.snapshot().task },
      { state: 'working', task: '正在执行 phase1' },
    );
  });

  test('无活动条目的会话写 task 不生效（不会制造幽灵文案）', () => {
    const s = new WorkStatusStore();
    assert.equal(s.has('ghost'), false);
    assert.equal(s.setTask('ghost', '不该出现'), false);
    assert.equal(s.snapshot().task, null);
  });

  test('多会话：展示取优先级最高者，task 跟着它走（不串会话）', () => {
    const s = new WorkStatusStore();
    s.setState('a', 'thinking', 1);
    s.setTask('a', 'A 的任务');
    s.setState('b', 'working', 2); // working(40) > thinking(30) → 展示 b
    assert.equal(s.snapshot().state, 'working');
    assert.equal(s.snapshot().task, null, 'b 没有任务详情 → 不显示 a 的文案');
    s.setTask('b', 'B 的任务');
    assert.equal(s.snapshot().task, 'B 的任务');
    // a 仍在活动：b 掉出去后展示回 a 的 state 与 a 的文案
    s.clear('b');
    assert.equal(s.snapshot().state, 'thinking');
    assert.equal(s.snapshot().task, 'A 的任务');
  });

  test('同档位取 seq 更大者（最近事件优先）', () => {
    const s = new WorkStatusStore();
    s.setState('a', 'working', 1);
    s.setTask('a', 'A');
    s.setState('b', 'working', 2);
    s.setTask('b', 'B');
    assert.equal(s.snapshot().task, 'B');
  });

  test('条目被清 → 文案一并消失（这是"任务结束后永久残留"的根治点）', () => {
    const s = new WorkStatusStore();
    s.setState('a', 'success', 1);
    s.setTask('a', '已经做完的旧任务');
    assert.equal(s.clear('a'), true);
    assert.equal(s.snapshot().state, null);
    assert.equal(s.snapshot().task, null, '旧文案不得残留到后续活动');
    assert.equal(s.has('a'), false);
  });

  test('setTask(null) 清空文案：回落档位文案的那条路（清单已无 in_progress/pending）', () => {
    const s = new WorkStatusStore();
    s.setState('a', 'working', 1);
    s.setTask('a', 'phase1');
    s.setTask('a', null);
    assert.equal(s.snapshot().task, null);
  });

  test('展示优先级表：waiting > error > working > thinking > result > success', () => {
    const order: HostWorkStatusState[] = ['waiting', 'error', 'working', 'thinking', 'result', 'success'];
    for (let i = 0; i < order.length - 1; i += 1) {
      const s = new WorkStatusStore();
      s.setState('low', order[i + 1], 10); // 序号更大：只有优先级能决定胜负
      s.setState('high', order[i], 1);
      assert.equal(s.snapshot().state, order[i], `${order[i]} 应压过 ${order[i + 1]}`);
    }
  });
});

describe('外部状态灯 —— 请求体校验（POST /work-status）', () => {
  test('六个档位与 null 都接受', () => {
    for (const state of ['thinking', 'working', 'result', 'waiting', 'success', 'error', null]) {
      const r = parseExternalWorkStatus({ state });
      assert.equal(r.ok, true, `${state} 应被接受`);
      if (r.ok) assert.equal(r.value.state, state);
    }
  });

  test('缺 state / 未知 state / 非对象 → 失败且带可读消息', () => {
    for (const body of [{}, { state: 'busy' }, null, [], 'working']) {
      const r = parseExternalWorkStatus(body);
      assert.equal(r.ok, false, `${JSON.stringify(body)} 应被拒绝`);
      if (!r.ok) assert.ok(r.message.length > 0, '必须给出原因（不吞错）');
    }
  });

  test('text：trim 后为空 → null；超长按码点截断（不劈开 emoji）', () => {
    const empty = parseExternalWorkStatus({ state: 'working', text: '   ' });
    assert.ok(empty.ok && empty.value.text === null);

    const long = '跑'.repeat(TASK_TEXT_MAX + 10);
    const r = parseExternalWorkStatus({ state: 'working', text: long });
    assert.ok(r.ok);
    assert.equal(Array.from(r.value.text ?? '').length, TASK_TEXT_MAX + 1, '截断后应含省略号');

    const emoji = parseExternalWorkStatus({ state: 'working', text: '🚀'.repeat(3) });
    assert.ok(emoji.ok && emoji.value.text === '🚀🚀🚀', '代理对不得被劈成半个字符');

    const bad = parseExternalWorkStatus({ state: 'working', text: 123 });
    assert.equal(bad.ok, false);
  });

  test('ttlSec：缺省 900、0 表示不自动清、上限一天、负数与非数字拒绝', () => {
    const def = parseExternalWorkStatus({ state: 'working' });
    assert.ok(def.ok && def.value.ttlSec === EXTERNAL_STATUS_DEFAULT_TTL_SEC);

    const never = parseExternalWorkStatus({ state: 'working', ttlSec: 0 });
    assert.ok(never.ok && never.value.ttlSec === 0);

    const tooLong = parseExternalWorkStatus({ state: 'working', ttlSec: EXTERNAL_STATUS_MAX_TTL_SEC + 1 });
    assert.equal(tooLong.ok, false);

    for (const ttl of [-1, 'abc']) {
      assert.equal(parseExternalWorkStatus({ state: 'working', ttlSec: ttl }).ok, false);
    }
  });
});

describe('WorkStatusStore.clearTerminal —— 点灯前扫掉遗留终态', () => {
  test('清掉 success/error，保留进行中档位，可排除指定会话', () => {
    const s = new WorkStatusStore();
    s.setState('chat', 'error', 1);
    s.setState('other', 'success', 2);
    s.setState('busy', 'working', 3);
    s.setState('ext', 'success', 4);

    assert.equal(s.clearTerminal('ext'), true, '应清掉 chat 与 other');
    assert.equal(s.stateOf('chat'), undefined);
    assert.equal(s.stateOf('other'), undefined);
    assert.equal(s.stateOf('busy'), 'working', '进行中的档位不得被清');
    assert.equal(s.stateOf('ext'), 'success', '被排除的会话保留');
    assert.equal(s.clearTerminal('ext'), false, '没有可清的 → 返回 false（调用方据此不 publish）');
  });
});

/**
 * 终态排他（第十一轮状态灯留下的缺陷）。
 *
 * 现场：脚本 `POST /work-status {"state":"success","text":"跑测试完成"}` 点亮过灯之后，
 * 用户再跟宠物聊一句——对话确实完成了（状态 = success，动画对），但气泡里显示的是
 * **"跑测试完成"** 这条脚本文案：外部条目用 `Date.now()` 当 seq，比会话事件的 seq
 * （0/1/2…）大几个数量级，同档位按 seq 取最近 → 外部那条永远赢。
 *
 * 判据：终态的语义是"刚刚结束了什么"，同一时刻只应有一个——谁最后结束，谁就是展示源。
 */
describe('WorkStatusStore.setTerminal —— 终态排他（不让陈旧终态抢走展示）', () => {
  test('真实对话的终态必须压过外部状态灯留下的陈旧终态', () => {
    const s = new WorkStatusStore();
    // 脚本点亮：seq = Date.now()（远大于会话事件 seq）
    s.setTerminal('dsh-pet-ng-external', 'success', Date.now());
    s.setTask('dsh-pet-ng-external', '跑测试完成');
    assert.equal(s.snapshot().state, 'success');
    assert.equal(s.snapshot().task, '跑测试完成');

    // 对话开始（thinking 优先级更高，先压住它）
    s.setState('dsh-pet-ng-local', 'thinking', 0);
    assert.equal(s.snapshot().state, 'thinking', '进行中的对话应当盖过陈旧的完成态');

    // 对话完成：终态排他 → 外部那条被扫掉，展示的是对话自己的结果
    s.setTerminal('dsh-pet-ng-local', 'success', 0);
    assert.equal(s.stateOf('dsh-pet-ng-external'), undefined, '别处的陈旧终态必须被扫掉');
    assert.equal(s.snapshot().state, 'success');
    assert.equal(s.snapshot().task, null, '展示的必须是这次对话（它没有任务详情），不是脚本文案');
  });

  test('反过来也一样：外部点灯（进行中档位）先扫掉刚结束的对话终态', () => {
    const s = new WorkStatusStore();
    s.setTerminal('dsh-pet-ng-local', 'error', 0);
    assert.equal(s.snapshot().state, 'error');

    // 与 applyExternalStatus 的非终态分支完全一致：先 clearTerminal，再 setState
    assert.equal(s.clearTerminal('dsh-pet-ng-external'), true);
    s.setState('dsh-pet-ng-external', 'working', Date.now());
    assert.equal(s.stateOf('dsh-pet-ng-local'), undefined, '灯亮了：上一轮的出错态不该继续挂着');
    assert.equal(s.snapshot().state, 'working');
  });

  test('清掉别处终态也算变化（否则前端拿不到这一拍）', () => {
    const s = new WorkStatusStore();
    s.setTerminal('other', 'success', 9);
    // 本会话已经是同样的终态：setState 会判"无变化"，但清掉 other 改变了展示
    s.setTerminal('me', 'success', 1);
    assert.equal(s.stateOf('other'), undefined);
    assert.equal(s.setTerminal('me', 'success', 1), false, '什么都没变时返回 false');
  });
});
