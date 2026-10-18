// POST /shutdown 真的停掉应用（接口在、效果没有 = 失败）。
//
// 运行前：npm run build
//   npm run test:ui                       # 用应用自己的 Electron 缓存
//   DSH_PET_ELECTRON=<electron 可执行文件> npm run test:ui   # 或显式指定
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { electronExe, launchApp } from './_harness.mjs';

const executablePath = electronExe();

test('POST /shutdown 真的停掉应用', { skip: !executablePath, timeout: 90000 }, async () => {
  const { app, base, profile, exited } = await launchApp({ tag: 'shutdown' });

  try {
    const res = await fetch(`${base}/shutdown`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.stopping, true, '响应体要如实说明"正在停"');

    const exit = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 20000))]);
    assert.notEqual(exit, 'timeout', '20 秒内进程必须退出（不退出就是"接口在、效果没有"）');

    // 端口必须一起关掉：只杀进程不退服务的话，下次启动会顺延端口
    const alive = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })
      .then(() => true)
      .catch(() => false);
    assert.equal(alive, false, '退出后端口不得继续响应');

    // 日志里要留下收尾痕迹（双击场景下这是唯一可查的证据）
    const logFile = join(profile, 'dsh-pet', 'app.log');
    if (existsSync(logFile)) {
      const text = readFileSync(logFile, 'utf8');
      assert.ok(text.includes('[shutdown]'), 'app.log 应记录收到 /shutdown');
      assert.ok(text.includes('[quit] 已退出'), 'app.log 应记录走完了收尾');
    }
  } finally {
    await app.close().catch(() => {});
  }
});
