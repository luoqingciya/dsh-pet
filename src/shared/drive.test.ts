/**
 * 位置驱动源状态机的测试（shared/drive.ts + 桌面精灵的接入点）。
 *
 * 钉住三件事：
 *   ① 转移表本身：漫游只能在"没人驱动位置"时启动；抓取/抛掷随时可以抢占（用户的手优先）。
 *   ② `current === next` 合法（"重启同一驱动"，被撞后再抛一次靠它）。
 *   ③ **源码守卫**：sprite.js 里除了 setDrive/releaseDrive/构造初始化，不许有第四处写 this.drive。
 *      这条是重点——状态机唯一入口的价值全靠"没人绕过去"；绕过去就又回到手工维护不变量，
 *      而这个 bug 的表现（两个 rAF 同时写坐标）在真机上极难复现，只能靠源码断言拦。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DRIVE_KINDS, canStartDrive, driveOwnsPosition } from './drive.ts';
import type { DriveKind } from './drive.ts';

const spriteSrc = readFileSync(fileURLToPath(new URL('../desktop/sprite.js', import.meta.url)), 'utf8');

/** 从源码里数某个子串出现次数（源码守卫用） */
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('canStartDrive —— 位置驱动源的转移表', () => {
  test('漫游绝不能抢占用户操作：拖拽/抛掷期间不许开始漫游', () => {
    assert.equal(canStartDrive('none', 'move'), true);
    for (const busy of ['drag', 'throw'] as DriveKind[]) {
      assert.equal(canStartDrive(busy, 'move'), false, `不应允许 ${busy} → move`);
    }
  });

  test('抓取/抛掷从任何状态都允许：用户的手永远优先（含空中抓取）', () => {
    for (const from of DRIVE_KINDS) {
      assert.equal(canStartDrive(from, 'drag'), true, `应允许 ${from} → drag`);
      assert.equal(canStartDrive(from, 'throw'), true, `应允许 ${from} → throw`);
    }
  });

  test('收回静止从任何状态都允许（每个驱动源都能正常收尾）', () => {
    for (const from of DRIVE_KINDS) {
      assert.equal(canStartDrive(from, 'none'), true, `应允许 ${from} → none`);
    }
  });

  test('current === next 一律合法：语义是「重启同一驱动」', () => {
    for (const kind of DRIVE_KINDS) {
      assert.equal(canStartDrive(kind, kind), true, `应允许 ${kind} → ${kind}`);
    }
  });

  test('表外的值不会被误判为合法（防御性，不让断言变成崩溃）', () => {
    assert.equal(canStartDrive('none', 'fly' as unknown as DriveKind), false);
  });

  test('DRIVE_KINDS 与转移表的键一一对应（新增驱动源时忘改表会被这里抓到）', () => {
    assert.deepEqual([...DRIVE_KINDS].sort(), ['drag', 'move', 'none', 'throw']);
  });
});

describe('driveOwnsPosition —— 「是否正在写位置」', () => {
  test('只有静止态不算占用位置', () => {
    assert.equal(driveOwnsPosition('none'), false);
    for (const kind of ['move', 'drag', 'throw'] as DriveKind[]) {
      assert.equal(driveOwnsPosition(kind), true, `${kind} 应算占用位置`);
    }
  });
});

describe('源码守卫 —— sprite.js 必须走唯一入口', () => {
  test('this.drive 只在三处被写：构造初始化、setDrive、releaseDrive', () => {
    // 构造里 `this.drive = 'none';`
    assert.equal(count(spriteSrc, "this.drive = 'none';"), 2, "写 'none' 的地方应只有构造与 releaseDrive");
    // setDrive 里 `this.drive = next;`
    assert.equal(count(spriteSrc, 'this.drive = next;'), 1, 'setDrive 应是唯一登记新状态的地方');
    // 合计：任何别处新增的 `this.drive = ...` 都会让下面这条失败
    const assignments = spriteSrc.match(/this\.drive\s*=/g) ?? [];
    assert.equal(assignments.length, 3, `this.drive 赋值应只有 3 处，实际 ${assignments.length} 处`);
  });

  test('三个驱动源的启动函数都经 setDrive 拿所有权', () => {
    // 带 ` {` 是为了命中**定义**而不是调用点（调用点以 `;` 结尾，且可能出现在定义之前）
    for (const fn of ['startMoveDrive(el) {', 'startDragFollow() {', 'startThrow(px, py, vx, vy) {']) {
      const at = spriteSrc.indexOf(fn);
      assert.notEqual(at, -1, `sprite.js 里找不到 ${fn}（改名了？守卫需要同步）`);
      // 函数体开头 400 字符内必须出现 setDrive——先拿所有权再起 rAF，顺序不能反
      const head = spriteSrc.slice(at, at + 400);
      assert.match(head, /this\.setDrive\(/, `${fn} 没有先调 setDrive 就直接起循环了`);
    }
  });

  test('位置判据不再直接读 rAF handle（改读 drive）', () => {
    // 允许出现的地方只有各驱动源内部的 "是否已在跑" 自检与 cancel 分支
    assert.equal(count(spriteSrc, 'S.driveOwnsPosition(this.drive)'), 2, 'relayout 与 tryMove 都应改读 drive 状态');
  });

  test('调试钩子暴露当前驱动源（冒烟/排障要能看到）', () => {
    assert.match(spriteSrc, /__dshPetDebug\.drive = next;/);
    assert.match(spriteSrc, /__dshPetDebug\.drive = 'none';/);
  });

  test('三个驱动循环都由 shared 的工厂起，类里不再手写 step', () => {
    for (const call of ['S.startMoveLoop(', 'S.startDragLoop(', 'S.startThrowLoop(']) {
      assert.equal(count(spriteSrc, call), 1, `${call} 应恰好被调用一次（驱动循环在 shared/drive-loops）`);
    }
  });

  test('位置驱动不再自己排帧：sprite.js 里只剩 Q 弹挤压那一段 rAF', () => {
    // 漫游/拖拽/抛掷的帧调度已收口到 createLoop（含"cancel 后已排队的帧也不执行"）。
    // 残留的 rAF 只该属于视觉挤压（纯表现，不写位置），共 2 处 request + 2 处 cancel。
    assert.equal(count(spriteSrc, 'requestAnimationFrame'), 2, 'rAF 只该剩 Q 弹挤压那两处');
    assert.equal(count(spriteSrc, 'cancelAnimationFrame'), 2, 'cancel 同理');
    // 反过来说：一旦有人在这里又手写一个位置循环，上面两条会立刻挂
    assert.equal(count(spriteSrc, 'moveToken'), 0, 'token 式取消应已被 Loop 取代');
    assert.equal(count(spriteSrc, 'throwToken'), 0);
    assert.equal(count(spriteSrc, 'dragFollowToken'), 0);
  });
});
