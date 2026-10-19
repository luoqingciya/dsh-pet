/**
 * 位置驱动循环的测试（shared/drive-loops.ts）。
 *
 * 为什么要单独测这些循环：它们是宠物行为里最容易出 bug 的地方，而从前只能"真的开一个
 * Electron 窗口、拖它一下"来验证（慢、不稳、还测不到边界）。抽出循环时把**帧调度与时钟**
 * 做成了可注入的，于是这里用一台假时钟把整条轨迹跑完：
 *   - 弹簧会不会过冲 / 收敛到指针；
 *   - 漫游的位置是否严格跟着**动画进度**（而不是按时间线性插值）；
 *   - 抛掷多久落地、落地 Q 弹只触发一次、飞行上报有没有被节流；
 *   - `cancel()` 之后是不是真的不再动（这是状态机"同一时刻只有一个驱动源"的底座）。
 *
 * 全部用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createLoop, extendHost, startDragLoop, startMoveLoop, startThrowLoop } from './drive-loops.ts';
import type { DragHost, DriveHost, Loop, MoveHost, Scheduler, ThrowHost } from './drive-loops.ts';
import { DEFAULT_PHYSICS, throwSpace } from './physics.ts';
import type { ThrowState } from './physics.ts';
import type { PhysicsParams } from './types.ts';

/**
 * 假调度器：手动时钟 + 可取消的任务表。
 *
 * `tick(ms)` 只跑**本次之前**已排队的帧（新排的留到下一拍），与真实 rAF 的语义一致。
 */
function fakeScheduler() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map<number, () => void>();
  const sched: Scheduler = {
    raf: (cb) => {
      const id = nextId++;
      tasks.set(id, cb);
      return id;
    },
    cancelRaf: (id) => {
      tasks.delete(id);
    },
    now: () => now,
  };
  return {
    sched,
    /** 推进 ms 并跑一帧 */
    tick(ms = 16) {
      now += ms;
      const batch = [...tasks.values()];
      tasks.clear();
      for (const cb of batch) cb();
    },
    /** 连跑 n 帧 */
    run(n: number, ms = 16) {
      for (let i = 0; i < n; i++) this.tick(ms);
    },
    /** 还排着多少帧（0 = 循环已停） */
    pending: () => tasks.size,
    now: () => now,
  };
}

/** 测试用宿主：位置可写、尺寸/物理给定（显式类型，否则取值器自引用会变成隐式 any） */
interface TestHost extends DriveHost {
  x: number;
  y: number;
  /** moveTo 被调用的次数（断言"真的在逐帧驱动"用） */
  moves: number;
}

function makeHost(over: Partial<DriveHost> = {}): TestHost {
  const host: TestHost = {
    x: 0,
    y: 0,
    moves: 0,
    posX: () => host.x,
    posY: () => host.y,
    moveTo(nx: number, ny: number): void {
      host.x = nx;
      host.y = ny;
      host.moves++;
    },
    halfW: 0,
    halfH: 0,
    size: 100,
    bottomPad: 0,
    physics: DEFAULT_PHYSICS as PhysicsParams,
    ...over,
  };
  return host;
}

describe('createLoop —— 自取消的 rAF 循环', () => {
  test('每帧回调，cancel 之后立刻停（已排队的那帧也不执行）', () => {
    const clock = fakeScheduler();
    let frames = 0;
    const loop = createLoop(() => {
      frames++;
      return true;
    }, clock.sched);

    clock.run(3);
    assert.equal(frames, 3);
    assert.equal(loop.running, true);

    loop.cancel();
    assert.equal(loop.running, false);
    clock.run(5);
    assert.equal(frames, 3, 'cancel 之后不该再有任何帧');
    assert.equal(clock.pending(), 0, '取消要真的把排队的帧摘掉');
  });

  test('帧回调返回 false 即收工（不必外部 cancel）', () => {
    const clock = fakeScheduler();
    let frames = 0;
    const loop = createLoop(() => {
      frames++;
      return frames < 2;
    }, clock.sched);
    clock.run(10);
    assert.equal(frames, 2);
    assert.equal(loop.running, false);
    assert.equal(clock.pending(), 0);
  });

  test('cancel 幂等（重复调用不抛、不再排帧）', () => {
    const clock = fakeScheduler();
    const loop: Loop = createLoop(() => true, clock.sched);
    loop.cancel();
    loop.cancel();
    assert.equal(loop.running, false);
    assert.equal(clock.pending(), 0);
  });
});

describe('extendHost —— 派生宿主必须保住取值器', () => {
  test('位置取值器走原型链，仍能读到最新值', () => {
    const base = makeHost();
    const child = extendHost<DragHost>(base, {
      target: () => null,
      velocity: () => ({ vx: 0, vy: 0 }),
      onDone: () => {},
    });
    base.x = 42;
    assert.equal(child.posX(), 42, '派生宿主读到的必须是**实时**位置（不是派生那一刻的快照）');
  });
});

describe('startDragLoop —— 弹簧跟随', () => {
  test('朝指针收敛且不过冲', () => {
    const clock = fakeScheduler();
    const host = makeHost();
    const target = { x: 100, y: 100 };
    const vel = { vx: 0, vy: 0 };
    let done = 0;
    startDragLoop(
      extendHost<DragHost>(host, { target: () => target, velocity: () => vel, onDone: () => done++ }),
      clock.sched,
    );

    clock.tick(); // 第一帧：动了，但绝不该一步到位
    assert.ok(host.x > 0 && host.x < 100, `第一帧应只走一部分（实际 ${host.x}）`);
    assert.ok(host.y > 0 && host.y < 100);

    clock.run(120); // ≈2s
    assert.ok(Math.abs(host.x - target.x) < 1, `应收敛到指针（实际 ${host.x}）`);
    assert.ok(Math.abs(host.y - target.y) < 1);
    assert.ok(host.x <= target.x + 0.5, '过阻尼弹簧不该过冲');
    assert.equal(done, 0, '目标一直在，不该收尾');
  });

  test('目标消失（松手/被抢）→ onDone 一次并自行收工', () => {
    const clock = fakeScheduler();
    const host = makeHost();
    let target: { x: number; y: number } | null = { x: 50, y: 50 };
    let done = 0;
    const loop = startDragLoop(
      extendHost<DragHost>(host, { target: () => target, velocity: () => ({ vx: 0, vy: 0 }), onDone: () => done++ }),
      clock.sched,
    );
    clock.tick();
    target = null;
    clock.run(5);
    assert.equal(done, 1);
    assert.equal(loop.running, false);
    assert.equal(clock.pending(), 0);
  });

  test('dt 被夹到 1/30 秒：卡顿后不会一步炸开', () => {
    const clock = fakeScheduler();
    const host = makeHost();
    const target = { x: 100, y: 0 };
    startDragLoop(
      extendHost<DragHost>(host, {
        target: () => target,
        velocity: () => ({ vx: 0, vy: 0 }),
        onDone: () => {},
      }),
      clock.sched,
    );
    // 三帧各 1 秒（模拟系统卡顿/标签页挂起）：若不夹取，弹簧会按 1s 积分直接飞出目标之外
    clock.run(3, 1000);
    assert.ok(host.x <= target.x + 0.5, `卡顿后不得过冲（实际 ${host.x}）`);
  });
});

describe('startMoveLoop —— 位置跟着动画进度走', () => {
  /** 10 秒动画、首尾各 1 秒原地不动、从 0 走到视口 50%（1000px 宽的视口 → 500px） */
  function moveFixture() {
    const clock = fakeScheduler();
    const host = makeHost();
    let animTime = 0;
    const settled: Array<[number, number]> = [];
    const moveHost = extendHost<MoveHost>(host, {
      animTime: () => animTime,
      animDuration: () => 10,
      viewW: () => 1000,
      viewH: () => 500,
      onSettled: (rx, ry) => settled.push([rx, ry]),
    });
    const plan = {
      startRatio: 0,
      startYRatio: 0.2,
      targetRatio: 0.5,
      dir: 1,
      totalRatio: 0.5,
      leadSec: 1,
      tailSec: 1,
    };
    const loop = startMoveLoop(moveHost, plan, clock.sched);
    return {
      clock,
      host,
      loop,
      settled,
      setAnimTime: (t: number) => {
        animTime = t;
      },
    };
  }

  test('起步段原地不动，中段线性推进，收尾段停在终点', () => {
    const f = moveFixture();
    f.setAnimTime(0.5); // ≤ leadSec
    f.clock.tick();
    assert.equal(f.host.x, 0, '起步段（leadSec 内）应原地不动');
    assert.equal(f.host.y, 0.2 * 500, '纵向由 startYRatio 决定，整段不变');

    f.setAnimTime(5); // 中段中点：0 + 0.5 * (5-1)/(10-1-1) = 0.25
    f.clock.tick();
    assert.equal(f.host.x, 250, '中段按动画进度线性推进');

    f.setAnimTime(9.5); // ≥ duration - tailSec
    f.clock.tick();
    assert.equal(f.host.x, 500, '收尾段应停在目标比例上');
  });

  test('播完即收工，落点比例交给宿主（下次启动的落点）', () => {
    const f = moveFixture();
    f.setAnimTime(10);
    f.clock.run(3);
    assert.deepEqual(f.settled, [[0.5, 0.2]]);
    assert.equal(f.loop.running, false);
    assert.equal(f.clock.pending(), 0);
  });

  test('动画时长未就绪（NaN）时按 10.09 秒兜底，不会除零/瞬移', () => {
    const clock = fakeScheduler();
    const host = makeHost();
    let animTime = 0;
    let settled = 0;
    startMoveLoop(
      extendHost<MoveHost>(host, {
        animTime: () => animTime,
        animDuration: () => Number.NaN,
        viewW: () => 1000,
        viewH: () => 500,
        onSettled: () => settled++,
      }),
      { startRatio: 0, startYRatio: 0, targetRatio: 1, dir: 1, totalRatio: 1, leadSec: 0, tailSec: 0 },
      clock.sched,
    );
    animTime = 0;
    clock.tick();
    assert.equal(host.x, 0, 't=0 时还在起点');
    animTime = 5.045; // 兜底时长的一半
    clock.tick();
    assert.ok(host.x > 400 && host.x < 600, `中点应走到约一半（实际 ${host.x}）`);
    animTime = 11; // 超过兜底时长
    clock.run(2);
    assert.equal(settled, 1);
  });
});

describe('startThrowLoop —— 抛掷物理', () => {
  /** 800×600 的屏，宠物 100 宽（身体高 100*9/16 = 56.25） */
  function throwFixture(start: ThrowState, over: Partial<ThrowHost> = {}) {
    const clock = fakeScheduler();
    const host = makeHost();
    const space = throwSpace({ areas: [{ x: 0, y: 0, width: 800, height: 600 }], size: 100, sideAllow: 0 });
    const calls = {
      frames: 0,
      reports: 0,
      collides: 0,
      /** 每次落地 Q 弹：发生在第几帧 + 下压幅度 */
      lands: [] as Array<{ frame: number; depth: number }>,
      rests: 0,
    };
    const throwHost = extendHost<ThrowHost>(host, {
      confineToScreen: false,
      space: () => space,
      others: () => ({}),
      onFrameState: () => {
        calls.frames++;
      },
      reportFlight: () => {
        calls.reports++;
      },
      reportCollide: () => {
        calls.collides++;
      },
      onLand: (depth) => {
        calls.lands.push({ frame: calls.frames, depth });
      },
      onRest: () => {
        calls.rests++;
      },
      ...over,
    });
    const loop = startThrowLoop(throwHost, start, clock.sched);
    return { clock, host, loop, calls, space };
  }

  test('从空中落到底边并停下（atRest 只收尾一次）', () => {
    const f = throwFixture({ x: 100, y: 0, vx: 0, vy: 0 });
    f.clock.run(600); // 最多 10 秒
    assert.equal(f.loop.running, false, '必须落地收工，不能永远飞');
    assert.equal(f.calls.rests, 1, 'onRest 只该触发一次');
    // 地面 = maxY = 600 - 56.25
    assert.ok(Math.abs(f.host.y - (600 - 56.25)) < 1, `应停在地面（实际 y=${f.host.y}）`);
  });

  test('落地 Q 弹只在空中→地面那一帧触发（绝不连帧重复弹）', () => {
    const f = throwFixture({ x: 100, y: 0, vx: 0, vy: 0 });
    f.clock.run(600);
    assert.ok(f.calls.lands.length >= 1, '落地应触发 Q 弹');

    // 真正要守的不变量：**相邻两次落地必须隔开若干帧**。
    // 去掉 prevGrounded 守卫后，宠物贴地那几帧会每帧都满足 bounced && grounded → 连帧触发，
    // 看起来像抽搐。这里用帧号直接钉住它，而不是猜"应该弹几次"（弹跳次数取决于恢复系数）。
    for (let i = 1; i < f.calls.lands.length; i++) {
      const gap = f.calls.lands[i].frame - f.calls.lands[i - 1].frame;
      assert.ok(gap > 1, `第 ${i} 次落地距上一次只隔 ${gap} 帧：贴地期间重复触发了 Q 弹`);
    }
    for (const { depth } of f.calls.lands) {
      assert.ok(depth > 0.5 && depth <= 0.85, `下压幅度应在合理区间（实际 ${depth}）`);
    }
  });

  test('飞行状态上报被节流（远少于帧数）', () => {
    const f = throwFixture({ x: 100, y: 0, vx: 0, vy: 0 });
    f.clock.run(600);
    assert.ok(f.calls.reports > 0, '飞行期间必须上报（跨窗碰撞检测靠它）');
    assert.ok(
      f.calls.reports < f.calls.frames / 1.5,
      `上报应节流到约 30ms 一次（帧 ${f.calls.frames} / 上报 ${f.calls.reports}）`,
    );
  });

  test('横向撞墙反弹（不会飞出屏幕）', () => {
    const f = throwFixture({ x: 100, y: 0, vx: 3000, vy: 0 });
    f.clock.run(600);
    assert.ok(f.host.x >= -1 && f.host.x <= 800 - 100 + 1, `不得飞出工作区（实际 x=${f.host.x}）`);
  });

  test('撞到别的宠物 → 把动量转发给目标窗（一帧只处理一次）', () => {
    const collided: string[] = [];
    const f = throwFixture(
      { x: 100, y: 0, vx: 400, vy: 0 },
      {
        others: () => ({ buddy: { x: 160, y: 0, vx: 0, vy: 0, size: 100, bottomPad: 0 } }),
        reportCollide: (pid: string) => {
          collided.push(pid);
        },
        physics: { ...DEFAULT_PHYSICS, petCollision: true } as PhysicsParams,
      },
    );
    f.clock.run(60);
    assert.ok(collided.length >= 1, '应检测到碰撞并转发给被撞方');
    assert.ok(
      collided.every((p) => p === 'buddy'),
      '转发目标必须是撞到的那只',
    );
  });

  test('cancel() 之后立刻定格（空中被抓走）', () => {
    const f = throwFixture({ x: 100, y: 0, vx: 500, vy: -800 });
    f.clock.run(3);
    const frozen = { x: f.host.x, y: f.host.y };
    f.loop.cancel();
    f.clock.run(20);
    assert.deepEqual({ x: f.host.x, y: f.host.y }, frozen, 'cancel 后位置不得再变');
    assert.equal(f.calls.rests, 0, '被取消的抛掷不该走 onRest');
  });
});
