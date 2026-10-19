// 位置驱动源的状态机：纯逻辑（无 DOM / 无 rAF / 无 this），两端共用。
//
// 背景：宠物位置有四个可能的来源——
//   - `move`  漫游：按移动动画的播放进度推进（本目录的 planMove 规划好的轨迹）
//   - `drag`  拖拽：过阻尼弹簧跟随指针
//   - `throw` 抛掷：重力 + 边缘反弹 + 落地摩擦
//   - （`none` 静止：位置由 position()/sendBounds 一次性设定，没有循环在跑）
//
// 改造前这几套各有一个独立 rAF 与一个 token，靠**调用点手工**"先 stopXxx 再 startYyy"维持
// "同一时刻只有一个在写坐标"。这类不变量靠人工维护必然漏：漏一处就是两个循环同时写位置，
// 表现是宠物抖成两团，或者落地后还按旧速度继续漂——而且极难复现（取决于动画就绪与用户操作的先后）。
//
// 这里把"能不能切"抽成一张表，让调用方（桌面 sprite.js；浏览器侧 pet.ts 若回归同样适用）
// 的切换只有一个入口，也让这条不变量可以脱离 Electron/浏览器单测。

/** 谁在写宠物的位置（同一时刻**只有一个**） */
export type DriveKind = 'none' | 'move' | 'drag' | 'throw';

/**
 * 每个**目标**驱动源允许从哪些状态切过来；不在这张表里 = 该切换非法。
 *
 * 规则只有两条，但都是有意为之：
 *   - `move` 只能从 `none`（或它自己）起：漫游是"背景行为"，**绝不能抢占**用户正在进行的
 *     抓取/抛掷。允许 `move → move` 只是为了让"同一驱动重启"这条规则在表里一致，
 *     实际不会发生（待兑现的移动是一次性的，见 sprite.js 的 startMoveDrive）。
 *   - `drag` / `throw` 从任何状态都允许：用户的手永远优先，空中也能一把抓住（'throw' → 'drag'）。
 */
const ALLOWED_FROM: Record<DriveKind, readonly DriveKind[]> = {
  none: ['none', 'move', 'drag', 'throw'],
  move: ['none', 'move'],
  drag: ['none', 'move', 'drag', 'throw'],
  throw: ['none', 'move', 'drag', 'throw'],
};

/** 全部驱动源（顺序即声明顺序，测试用它做穷举） */
export const DRIVE_KINDS: readonly DriveKind[] = ['none', 'move', 'drag', 'throw'];

/**
 * 从 `current` 切到 `next` 是否合法。
 *
 * 注意 `current === next` 时一律返回 true：那是"重启同一个驱动"（例如被撞后再抛一次），
 * 调用方据此可以放心地先停后起，不必自己特判。
 */
export function canStartDrive(current: DriveKind, next: DriveKind): boolean {
  const allowed = ALLOWED_FROM[next];
  if (!allowed) return false; // 防御：调用方传了表外的值（不该发生，但别让断言变成崩溃）
  return allowed.includes(current);
}

/**
 * 该驱动源是否"正在写位置"（即不是静止态）。
 *
 * 用来替代散落各处的 `this.throwRef !== null || this.moveRef !== null` 这类判据——
 * 那些判据读的是实现细节，且每加一个驱动源就要改一遍。
 */
export function driveOwnsPosition(kind: DriveKind): boolean {
  return kind !== 'none';
}
