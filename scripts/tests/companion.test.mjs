// 主动陪伴 P0 的真机回归：**一拍真的会动、静音真的立刻闭嘴**。
//
// 为什么需要这一层：`core/companion` 的矩阵单测只证明"决策对不对"，证明不了
// 「配置读到了 → 定时拍在跑 → 决策落到 S → 渲染端收到 anim」这条链是通的。
// 而这条链断掉的方式很隐蔽：配置段名写错、effect 没注册、拍间隔被写死、写错叶子名……
// 全都表现为"功能像没打开"，靠看代码很难发现。
//
// 两个让用例可行的口子（都在生产代码里，不是测试专用分支）：
//   · `DSH_PET_COMPANION_TICK_MS`：把 30s 的拍压到 1s（只改节奏，不改语义）；
//   · harness 的 `prepare(profile)`：在启动前把一份 `companion.enabled=true` 的用户配置
//     塞进临时 profile（`--user-data-dir` 会让它成为数据根，不碰真实用户数据）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { electronExe, launchApp, waitFor } from './_harness.mjs';

const executablePath = electronExe();
const ROUTE = '/dsh-pet-ng-7340';

test('主动陪伴：一拍就动，静音后立刻闭嘴', { skip: !executablePath, timeout: 120000 }, async () => {
  const { app, base, profile } = await launchApp({
    tag: 'companion',
    env: { DSH_PET_COMPANION_TICK_MS: '1000' },
    prepare: (dir) => {
      mkdirSync(join(dir, 'dsh-pet-ng'), { recursive: true });
      writeFileSync(
        join(dir, 'dsh-pet-ng', 'main-config.jsonc'),
        JSON.stringify({
          // 间隔/上限都放宽，保证"该动的时候一定会动"；awayAfterMin 调到很大，
          // 免得 CI 机器上"空闲 10 分钟"把动作按掉（runner 本来就没有输入）
          companion: {
            enabled: true,
            quietHours: null,
            minIntervalMin: 1,
            dailyCap: 20,
            awayAfterMin: 999,
          },
        }),
        'utf8',
      );
    },
  });

  const animCounter = async () => {
    const s = await (await fetch(`${base}${ROUTE}/state`)).json();
    return Number(s?.pets?.main?.anim?.counter ?? 0);
  };

  try {
    // ① 一拍之内（1s 拍 + 余量）必须写出 anim：这是"配置 → 调度 → 决策 → S"整条链的证明
    const moved = await waitFor(async () => (await animCounter()) > 0, 20000);
    assert.ok(moved, '20 秒内没有任何 anim 指令——主动陪伴没跑起来（看 reason 是 disabled 还是配置没读到）');

    // ② 静音：接口返回未来的截止时刻，并落盘
    const res = await fetch(`${base}${ROUTE}/companion/snooze?minutes=60`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.until > Date.now(), '静音截止时刻必须在未来');

    const mem = JSON.parse(readFileSync(join(profile, 'dsh-pet-ng', 'companion.json'), 'utf8'));
    assert.equal(mem.snoozeUntil, body.until, '静音必须落盘（重启不该解除）');

    // ③ 静音期内不许再动：等 6 拍，counter 不能变
    const before = await animCounter();
    await new Promise((r) => setTimeout(r, 6000));
    const after = await animCounter();
    assert.equal(after, before, '静音期间仍在写 anim —— 决策器没把 snoozeUntil 算进去');
  } finally {
    await app.close().catch(() => {});
  }
});
