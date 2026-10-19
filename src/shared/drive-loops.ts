// 位置驱动的三个 rAF 循环（漫游 / 弹簧跟随 / 抛掷）：**不碰 DOM、不碰 IPC**。
//
// 为什么要抽出来：这三段循环是宠物行为里最容易出 bug 的地方——它们各自逐帧写位置，
// 又互相抢占（抓取打断漫游、松手甩出去、落地前被抓走）。从前它们内联在 sprite.js 里，
// 每帧直接读 `this.pos`、写 `this.customPos`、调 `window.petBridge`，于是：
//   - 只能靠"真的开一个 Electron 窗口、拖它一下"来验证（UI 用例又慢又不稳）；
//   - 想单独测"抛掷多久落地""弹簧会不会过冲"根本没门。
// 现在循环只经 `host` 读写宿主状态，帧调度与时钟也可注入——`src/shared/drive-loops.test.ts`
// 用假时钟把整条轨迹跑完，不需要窗口。
//
// 谁在用：桌面渲染端（`sprite.js`）。浏览器侧 pet.ts 是同构的另一份（已移出本仓库），后续若回归可迁过来；
// 这也是把它放在 shared 而不是 desktop 的原因（与 physics.ts 同一层：纯运行时，无 UI）。

import {
  bodyPixelBox,
  collidePet,
  landingSquash,
  rectsOverlap,
  screenOfBox,
  springStep,
  throwStepRegion,
} from './physics';
import type { PetCollider, ThrowSpace, ThrowState } from './physics';
import type { PhysicsParams } from './types';

/** 排一帧（默认 `requestAnimationFrame`；测试注入手动时钟） */
export type Raf = (cb: () => void) => number;
/** 取消一帧 */
export type CancelRaf = (id: number) => void;
/** 当前时刻（毫秒；默认 `performance.now`） */
export type Now = () => number;

/** 帧调度与时钟的可注入外壳 */
export interface Scheduler {
  raf: Raf;
  cancelRaf: CancelRaf;
  now: Now;
}

const defaultScheduler: Scheduler = {
  raf: (cb) => requestAnimationFrame(cb),
  cancelRaf: (id) => cancelAnimationFrame(id),
  now: () => performance.now(),
};

/**
 * 一个**自取消**的 rAF 循环。
 *
 * 这就是从前 `moveRef + moveToken` / `dragFollow + dragFollowToken` / `throwRef + throwToken`
 * 那六件套的替代：`cancel()` 之后，即使某一帧已经排在队列里，它的回调也不会再执行
 * （从前靠"token 对不上就 return"手工实现，三处各写一遍，还得记得每次 cancel 都 ++token）。
 */
export interface Loop {
  /** 取消（幂等）。已排队的帧不会再跑 */
  cancel(): void;
  /** 是否还在跑（自然跑完或被 cancel 后为 false） */
  readonly running: boolean;
}

/**
 * 起一个循环：`frame` 返回 `false` 表示这一帧结束后收工。
 * @param frame 每帧回调（返回 false 结束）
 * @param sched 调度外壳
 */
export function createLoop(frame: () => boolean, sched: Scheduler = defaultScheduler): Loop {
  let alive = true;
  let id = 0;
  const tick = () => {
    if (!alive) return;
    id = 0;
    if (frame() === false) {
      alive = false;
      return;
    }
    if (alive) id = sched.raf(tick);
  };
  id = sched.raf(tick);
  return {
    cancel() {
      alive = false;
      if (id) {
        sched.cancelRaf(id);
        id = 0;
      }
    },
    get running() {
      return alive;
    },
  };
}

/**
 * 在共用宿主之上派生一个更具体的宿主（补上某个循环额外需要的能力）。
 *
 * 用 `Object.create` 而不是 `{ ...base }`：展开运算符会把 base 上的**取值器求值一次**
 * 变成快照。现在 DriveHost 上已经没有取值器了（位置改成方法，正是为了避开这个坑），
 * 但派生宿主这件事迟早会再遇到，留原型链是更稳的写法——`Object.assign` 只写 extra
 * 那几个键（方法/常量），不会碰到原型。
 */
export function extendHost<T extends DriveHost>(base: DriveHost, extra: Omit<T, keyof DriveHost>): T {
  return Object.assign(Object.create(base) as T, extra);
}

/**
 * 三个驱动循环共用的宿主：位置读写 + 尺寸 + 物理参数。
 *
 * 位置用**属性**而不是 `pos()` 方法：这是 60fps 的热路径，每帧返回新对象纯属浪费。
 */
export interface DriveHost {
  /** 当前包围盒左上角 X（工作区 CSS px）。
   *  用方法而不是属性：宿主是对象字面量，取值器里的 this 指向字面量本身，
   *  想在取值器里读外面的 this 就得先 `const self = this`（而 eslint 的 no-this-alias 不允许）。 */
  posX(): number;
  /** 当前包围盒左上角 Y */
  posY(): number;
  /** 把宠物移到该位置（宿主内部负责取整与上报窗口） */
  moveTo(x: number, y: number): void;
  /** 包围盒宽的一半 */
  halfW: number;
  /** 包围盒高的一半 */
  halfH: number;
  /** 包围盒宽（CSS px） */
  size: number;
  /** 舞台脚底垫高（碰撞几何要用） */
  bottomPad: number;
  physics: PhysicsParams;
}

// ---------- 漫游 ----------

/** 一次移动的规划（来自 shared/motion 的 planMove，外加动画首尾的静止段） */
export interface MovePlanInput {
  startRatio: number;
  startYRatio: number;
  targetRatio: number;
  /** 水平方向：+1 向右，-1 向左 */
  dir: number;
  /** 需要走过的比例距离（正数） */
  totalRatio: number;
  /** 动画开头原地不动的秒数 */
  leadSec: number;
  /** 动画结尾原地不动的秒数 */
  tailSec: number;
}

export interface MoveHost extends DriveHost {
  /** 移动动画当前播放时刻（秒） */
  animTime(): number;
  /** 移动动画总时长（秒）；未就绪时为 NaN，循环内部按 10.09 兜底 */
  animDuration(): number;
  /** 视口宽（CSS px）——移动按比例规划，这里换算成像素。
   *  用方法而不是属性：显示器变化会改它，快照一份就会用旧尺寸算落点 */
  viewW(): number;
  /** 视口高 */
  viewH(): number;
  /** 跑完：把落点比例记下来（下次启动的落点） */
  onSettled(targetRatio: number, yRatio: number): void;
}

/**
 * 漫游驱动：**位置由动画播放进度决定**（不是按时间线性插值）——
 * 这样"走路"动画的脚步与位移天然同步，动画被暂停/跳帧也不会走位错乱。
 *
 * 动画首尾各留 leadSec / tailSec 原地不动（起步与收步），中间线性走完 totalRatio。
 */
export function startMoveLoop(host: MoveHost, plan: MovePlanInput, sched?: Scheduler): Loop {
  const { startRatio, startYRatio, targetRatio, dir, totalRatio, leadSec, tailSec } = plan;
  const raw = host.animDuration();
  const duration = Number.isFinite(raw) && raw > 0 ? raw : 10.09;
  const travelWindow = Math.max(0.1, duration - leadSec - tailSec);
  return createLoop(() => {
    const t = host.animTime();
    let ratioX: number;
    if (t <= leadSec) ratioX = startRatio;
    else if (t >= duration - tailSec) ratioX = targetRatio;
    else ratioX = startRatio + dir * totalRatio * ((t - leadSec) / travelWindow);
    // 移动的是窗口（宠物包围盒跟随），sprite 在本窗口内不动
    host.moveTo(ratioX * host.viewW() - host.halfW, startYRatio * host.viewH() - host.halfH);
    if (t < duration - tailSec) return true;
    host.onSettled(targetRatio, startYRatio);
    return false;
  }, sched);
}

// ---------- 拖拽 ----------

export interface DragHost extends DriveHost {
  /** 指针目标（工作区 px）；null = 松手/被抢，循环自行收尾 */
  target(): { x: number; y: number } | null;
  /** 弹簧速度状态（由宿主持有，跨帧累积；循环不自己存） */
  velocity(): { vx: number; vy: number };
  /** 目标没了（循环自然结束） */
  onDone(): void;
}

/**
 * 拖拽驱动：**过阻尼弹簧**朝指针追赶，而不是硬贴。
 *
 * 为什么要弹簧：指针事件是高频且抖的（尤其高刷新率鼠标/触控板），硬贴会把抖动原样传给窗口，
 * 窗口位移看起来像"抽搐"。弹簧是一阶低通，抹平高频、保留方向感。
 * `dt` 上限 1/30 秒：标签页/系统卡顿后第一帧的 dt 会很大，不夹取会让弹簧一步过冲。
 */
export function startDragLoop(host: DragHost, sched?: Scheduler): Loop {
  const s = sched ?? defaultScheduler;
  let last = s.now();
  return createLoop(() => {
    const target = host.target();
    if (!target) {
      host.onDone();
      return false;
    }
    const now = s.now();
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    const vel = host.velocity();
    let x = host.posX();
    let y = host.posY();
    vel.vx = springStep(vel.vx, x, target.x, dt, host.physics.throwPower);
    vel.vy = springStep(vel.vy, y, target.y, dt, host.physics.throwPower);
    x += vel.vx * dt;
    y += vel.vy * dt;
    host.moveTo(x, y); // 移动的是窗口（宿主 posX/posY 实时更新）；sprite 在本窗口内不动
    return true;
  }, s);
}

// ---------- 抛掷 ----------

/** 碰撞站场里"另一只宠物"的状态（CSS px，已 ÷scale） */
export interface OtherPet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  bottomPad: number;
}

export interface ThrowHost extends DriveHost {
  /** 抛掷锁定在当前屏（屏缝当墙） */
  confineToScreen: boolean;
  /** 抛掷空间（逐屏 AABB）。**每次调用都要取最新**——relayout() 会让宿主的缓存失效 */
  space(): ThrowSpace;
  /** 碰撞站场里其它宠物（CSS px）；关掉 petCollision 时不会被调用 */
  others(): Record<string, OtherPet>;
  /** 每帧的实时飞行状态（宿主用来回答"我现在在飞吗"、算点击积分） */
  onFrameState(state: ThrowState): void;
  /** 上报飞行状态给主进程 broker（节流已在循环内做，宿主只管发） */
  reportFlight(state: ThrowState): void;
  /** 撞到别人：请主进程把动量转发给目标窗口 */
  reportCollide(targetId: string, vx: number, vy: number): void;
  /** 落地那一帧（空中→地面）：播 Q 弹，depth 已按冲击速度算好 */
  onLand(depth: number): void;
  /** 落定：把位置记下来（customPos），清飞行状态 */
  onRest(): void;
}

/** 飞行状态上报节流（毫秒）：主进程 broker 汇聚后广播，其它窗口拿它做跨窗碰撞检测 */
const FLIGHT_REPORT_MS = 30;

/**
 * 抛掷驱动：重力 + 逐屏边缘反弹 + 落地摩擦，落定后把位置交给宿主。
 *
 * 三个容易踩的点，都在这里收口：
 *   1. **边界是"工作区并集"而不是外接矩形**：显示器摆放不规则时外接矩形里有大片空洞，
 *      以它为边界会把宠物放进看不见的地方（见 physics.ts 的 throwStepRegion）。
 *   2. **锁屏**（confineToScreen）：松手那一刻定下所在屏，飞行途中不重取——否则宠物会在
 *      屏缝上反复改主意。屏数变了（拔显示器）由 throwStepRegion 自动退回不锁定。
 *   3. **落地 Q 弹只在"空中→地面"那一帧触发一次**：每帧都判 `y >= maxY` 会在贴地滚动时
 *      连续触发，看起来像抽搐。
 */
export function startThrowLoop(host: ThrowHost, start: ThrowState, sched?: Scheduler): Loop {
  const s = sched ?? defaultScheduler;
  const lockScreen = host.confineToScreen ? screenOfBox(host.space(), start.x, start.y) : -1;
  let state: ThrowState = { x: start.x, y: start.y, vx: start.vx, vy: start.vy };
  let last = s.now();
  let prevGrounded = false;
  let lastReport = 0;

  return createLoop(() => {
    const now = s.now();
    const dt = (now - last) / 1000;
    last = now;
    const fallingVy = state.vy; // 本帧积分前的竖直速度（正=下落）：即落地冲击速度
    // 每帧重取：显示器变化时 relayout() 会让宿主缓存失效，res.screen 必须与这一份对应
    const sp = host.space();
    const res = throwStepRegion(state, dt, sp, host.physics, lockScreen);
    state = { x: res.x, y: res.y, vx: res.vx, vy: res.vy };
    host.onFrameState(state);

    // 上报飞行状态（节流）：broker 汇聚后广播，其它窗口用它做跨窗碰撞检测
    if (now - lastReport > FLIGHT_REPORT_MS) {
      host.reportFlight(state);
      lastReport = now;
    }

    // 宠物间碰撞（仅 petCollision 开启）：飞行中的自己撞到其它宠物 → 动量弹开
    if (host.physics.petCollision) {
      const myBody = bodyPixelBox({ x: state.x, y: state.y, size: host.size, bottomPad: host.bottomPad });
      const others = host.others();
      for (const pid of Object.keys(others)) {
        const o = others[pid];
        if (!o || !o.size) continue;
        const otherBody = bodyPixelBox({ x: o.x, y: o.y, size: o.size, bottomPad: o.bottomPad });
        if (!rectsOverlap(myBody, otherBody)) continue;
        const fly: PetCollider = { x: state.x, y: state.y, vx: state.vx, vy: state.vy, size: host.size };
        const hitPet: PetCollider = { x: o.x, y: o.y, vx: o.vx, vy: o.vy, size: o.size };
        const hit = collidePet(fly, hitPet);
        if (hit) {
          // 飞行方：按动量结果继续弹开；被撞方：主进程转发给目标窗口 → 目标窗 startThrow
          state = { x: state.x, y: state.y, vx: hit.fvx, vy: hit.fvy };
          host.onFrameState(state);
          host.reportCollide(pid, hit.hvx, hit.hvy);
          break; // 一帧只处理一次碰撞（避免连锁触发抖动）
        }
      }
    }

    host.moveTo(res.x, res.y);

    // 落地 Q 弹：只在空中→地面转换帧触发一次，力度随冲击速度（轻落 0.8 ~ 重砸 0.55）。
    // 「地面」是**当前所在屏**的底边——多屏各有各的地面高度
    const curBounds = sp.bounds[res.screen] || sp.bounds[0];
    const grounded = curBounds ? res.y >= curBounds.maxY - 1 : false;
    if (res.bounced && grounded && !prevGrounded) host.onLand(landingSquash(fallingVy));
    prevGrounded = grounded;

    if (res.atRest) {
      host.onRest();
      return false;
    }
    return true;
  }, s);
}
