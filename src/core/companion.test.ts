/**
 * 主动陪伴决策层的测试（core/companion.ts）。
 *
 * 这块代码的失败方式几乎只有一种：**太吵**。而"太吵"没法靠肉眼调，只能靠一张矩阵钉住
 * "什么情况下必须闭嘴"。所以下面按**规则顺序**逐条断言，每条都同时验
 * ① 决策对不对 ② 记忆怎么变（次数有没有被吃、离开状态有没有被消费）。
 *
 * 全部用 Node 内置 test runner，不引入依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_COMPANION_CONFIG,
  emptyCompanionMemory,
  inQuietHours,
  normalizeCompanionConfig,
  step,
} from './companion.ts';
import type { CompanionConfig, CompanionMemory, CompanionSignals } from './companion.ts';

/** 一个"人在场、白天、刚主动过很久"的基准信号 */
const baseSignals: CompanionSignals = {
  now: 1_700_000_000_000,
  hour: 14,
  dayKey: '2026-10-20',
  idleSec: 5,
};

const on: CompanionConfig = { ...DEFAULT_COMPANION_CONFIG, enabled: true };

/** 造记忆：默认"从未主动、人在场" */
const mem = (over: Partial<CompanionMemory> = {}): CompanionMemory => ({
  ...emptyCompanionMemory(),
  dayKey: '2026-10-20',
  ...over,
});

const sig = (over: Partial<CompanionSignals> = {}): CompanionSignals => ({ ...baseSignals, ...over });

describe('inQuietHours —— 免打扰时段', () => {
  test('null = 不限', () => {
    assert.equal(inQuietHours(3, null), false);
  });

  test('普通区间（含头不含尾）', () => {
    assert.equal(inQuietHours(9, { start: 9, end: 18 }), true);
    assert.equal(inQuietHours(8.99, { start: 9, end: 18 }), false);
    assert.equal(inQuietHours(18, { start: 9, end: 18 }), false);
  });

  test('跨零点：23–8 覆盖深夜与清晨', () => {
    const q = { start: 23, end: 8 };
    assert.equal(inQuietHours(23, q), true);
    assert.equal(inQuietHours(0, q), true);
    assert.equal(inQuietHours(7.9, q), true);
    assert.equal(inQuietHours(8, q), false);
    assert.equal(inQuietHours(14, q), false);
  });

  test('起止相同 = 不限（避免写成 0/0 就整天闭嘴）', () => {
    assert.equal(inQuietHours(12, { start: 0, end: 0 }), false);
  });
});

describe('step —— 规则顺序（先判"不许动"）', () => {
  test('1. 关掉 → disabled，记忆原样（不吃次数）', () => {
    const r = step(sig(), mem(), { ...on, enabled: false });
    assert.deepEqual(r.decision, { act: 'none', reason: 'disabled' });
    assert.equal(r.memory.dayCount, 0);
  });

  test('默认配置是**关闭**的（主动行为不该替用户默认打开）', () => {
    assert.equal(DEFAULT_COMPANION_CONFIG.enabled, false);
    assert.deepEqual(step(sig(), mem(), DEFAULT_COMPANION_CONFIG).decision, {
      act: 'none',
      reason: 'disabled',
    });
  });

  test('2. 免打扰时段 → quiet-hours，优先于人不在', () => {
    const r = step(sig({ hour: 2, idleSec: 9999 }), mem(), on);
    assert.deepEqual(r.decision, { act: 'none', reason: 'quiet-hours' });
  });

  test('3. 人不在（空闲 ≥ awayAfterMin）→ away，并记下离开时刻', () => {
    const r = step(sig({ idleSec: 10 * 60 }), mem(), on);
    assert.deepEqual(r.decision, { act: 'none', reason: 'away' });
    assert.equal(r.memory.awaySince, baseSignals.now, '离开起点必须记下（回来判定要用）');
    assert.equal(r.memory.dayCount, 0, '人不在时不该消耗次数');
  });

  test('3b. 一直在离开：awaySince 不刷新（保留第一次离开的时刻）', () => {
    const first = step(sig({ idleSec: 20 * 60 }), mem(), on);
    const later = step(sig({ now: baseSignals.now + 60_000, idleSec: 21 * 60 }), first.memory, on);
    assert.equal(later.memory.awaySince, baseSignals.now);
  });

  test('4. 今日次数用完 → daily-cap（即使间隔已过）', () => {
    const r = step(sig(), mem({ dayCount: 8, lastActAt: 0 }), on);
    assert.deepEqual(r.decision, { act: 'none', reason: 'daily-cap' });
    assert.equal(r.memory.dayCount, 8);
  });

  test('5. 距上次太近 → too-soon', () => {
    const r = step(sig(), mem({ lastActAt: baseSignals.now - 5 * 60_000, dayCount: 1 }), on);
    assert.deepEqual(r.decision, { act: 'none', reason: 'too-soon' });
  });

  test('5b. 间隔刚够 → 放行', () => {
    const r = step(sig(), mem({ lastActAt: baseSignals.now - 20 * 60_000, dayCount: 1 }), on);
    assert.equal(r.decision.act, 'move');
  });
});

describe('step —— 什么时候真的动', () => {
  test('6. 人刚回来（离开状态解除）→ greet，并消费 awaySince', () => {
    const away = step(sig({ idleSec: 30 * 60 }), mem(), on);
    const back = step(sig({ idleSec: 3 }), away.memory, on);
    assert.deepEqual(back.decision, { act: 'move', flavor: 'greet' });
    assert.equal(back.memory.awaySince, 0, 'awaySince 必须被消费，否则每拍都迎接');
    assert.equal(back.memory.dayCount, 1);
    assert.equal(back.memory.lastActAt, baseSignals.now);
  });

  test('6b. 迎接只发生一次：紧接着下一拍变回 stroll', () => {
    const away = step(sig({ idleSec: 30 * 60 }), mem(), on);
    const back = step(sig({ idleSec: 3 }), away.memory, on);
    const next = step(sig({ now: baseSignals.now + 25 * 60_000, idleSec: 2 }), back.memory, on);
    assert.deepEqual(next.decision, { act: 'move', flavor: 'stroll' });
  });

  test('7. 人在场且间隔已过 → stroll', () => {
    const r = step(sig(), mem({ lastActAt: baseSignals.now - 60 * 60_000, dayCount: 2 }), on);
    assert.deepEqual(r.decision, { act: 'move', flavor: 'stroll' });
    assert.equal(r.memory.dayCount, 3);
  });

  test('从未主动过（lastActAt = 0）也允许第一次 stroll', () => {
    const r = step(sig(), mem({ lastActAt: 0 }), on);
    assert.equal(r.decision.act, 'move');
  });
});

describe('step —— 跨天重置', () => {
  test('换了一天：次数归零、离开状态清空', () => {
    const r = step(sig({ dayKey: '2026-10-21' }), mem({ dayKey: '2026-10-20', dayCount: 8, awaySince: 123 }), on);
    assert.equal(r.decision.act, 'move', '昨天用满 8 次不该压今天的额度');
    assert.equal(r.memory.dayCount, 1);
    assert.equal(r.memory.awaySince, 0, '跨天后不该把昨天的"离开"算成刚回来');
  });

  test('首次运行（dayKey 为空）等价于新的一天', () => {
    const r = step(sig(), emptyCompanionMemory(), on);
    assert.equal(r.memory.dayKey, '2026-10-20');
    assert.equal(r.decision.act, 'move');
  });
});

describe('step —— 纯函数性质', () => {
  test('不改传入的对象（记忆是值传递，调用方自己落盘）', () => {
    const memory = mem({ dayCount: 3 });
    const snapshot = JSON.stringify(memory);
    step(sig(), memory, on);
    assert.equal(JSON.stringify(memory), snapshot);
  });

  test('同样的输入永远得到同样的输出', () => {
    const a = step(sig(), mem({ lastActAt: 1, dayCount: 2 }), on);
    const b = step(sig(), mem({ lastActAt: 1, dayCount: 2 }), on);
    assert.deepEqual(a, b);
  });
});

describe('normalizeCompanionConfig —— 配置校验（缺失取默认，写错判非法）', () => {
  test('整段缺失 → 内置默认（老配置没有这一段是正常的）', () => {
    assert.deepEqual(normalizeCompanionConfig(undefined), DEFAULT_COMPANION_CONFIG);
    assert.deepEqual(normalizeCompanionConfig(null), DEFAULT_COMPANION_CONFIG);
  });

  test('不是对象 / 是数组 → null（写错就判红，不静默兜底）', () => {
    assert.equal(normalizeCompanionConfig('on'), null);
    assert.equal(normalizeCompanionConfig([1, 2]), null);
  });

  test('字段缺失取默认，写了就用自己的', () => {
    const c = normalizeCompanionConfig({ enabled: true, dailyCap: 3 });
    assert.ok(c);
    assert.equal(c.enabled, true);
    assert.equal(c.dailyCap, 3);
    assert.equal(c.minIntervalMin, DEFAULT_COMPANION_CONFIG.minIntervalMin);
  });

  test('类型/范围写错 → null', () => {
    assert.equal(normalizeCompanionConfig({ enabled: 'yes' }), null);
    assert.equal(normalizeCompanionConfig({ minIntervalMin: 0 }), null, '间隔必须 ≥1 分钟');
    assert.equal(normalizeCompanionConfig({ minIntervalMin: 'abc' }), null);
    assert.equal(normalizeCompanionConfig({ awayAfterMin: 0 }), null);
    assert.equal(normalizeCompanionConfig({ dailyCap: -1 }), null);
  });

  test('quietHours：null 合法（= 不限），越界小时判非法', () => {
    assert.equal(normalizeCompanionConfig({ quietHours: null })?.quietHours, null);
    assert.equal(normalizeCompanionConfig({ quietHours: { start: 25, end: 8 } }), null);
    assert.deepEqual(normalizeCompanionConfig({ quietHours: { start: 1, end: 6 } })?.quietHours, {
      start: 1,
      end: 6,
    });
  });

  test('dailyCap 取整（写了 8.9 也不该变成 8.9 次额度）', () => {
    assert.equal(normalizeCompanionConfig({ dailyCap: 8.9 })?.dailyCap, 8);
  });
});

describe('step —— 手动静音（安静一小时）', () => {
  test('静音期内 → snoozed，且优先于免打扰/离开等一切规则', () => {
    const m = mem({ snoozeUntil: baseSignals.now + 30 * 60_000 });
    assert.deepEqual(step(sig({ hour: 2, idleSec: 99999 }), m, on).decision, {
      act: 'none',
      reason: 'snoozed',
    });
  });

  test('静音期内不吃次数、不动上次主动时刻', () => {
    const m = mem({ snoozeUntil: baseSignals.now + 60_000, dayCount: 2, lastActAt: 111 });
    const r = step(sig(), m, on);
    assert.equal(r.memory.dayCount, 2);
    assert.equal(r.memory.lastActAt, 111);
    assert.equal(r.memory.snoozeUntil, m.snoozeUntil, '静音期内不该把截止时刻改掉');
  });

  test('静音过期 → 恢复正常判定，并把 snoozeUntil 清零（落盘文件不留在过去的时间戳）', () => {
    const m = mem({ snoozeUntil: baseSignals.now - 1000 });
    const r = step(sig(), m, on);
    assert.equal(r.decision.act, 'move');
    assert.equal(r.memory.snoozeUntil, 0);
  });

  test('静音优先于"关闭"之外的所有规则——包括刚回来的迎接', () => {
    const m = mem({ awaySince: baseSignals.now - 5 * 60_000, snoozeUntil: baseSignals.now + 60_000 });
    assert.equal(step(sig({ idleSec: 1 }), m, on).decision.act, 'none');
  });
});
