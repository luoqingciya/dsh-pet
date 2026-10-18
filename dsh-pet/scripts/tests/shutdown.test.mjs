// `POST /shutdown` 的运行时回归：接口必须真的把应用停掉。
//
// 为什么单独一个文件：这个用例**会把被测应用杀掉**，塞进 desktop-window.test.mjs 会让
// 后续用例全部落空。所以它自己拉起一个实例、自己验证退出。
//
// 历史故障：`server.ts` 早就实现了 `/shutdown → onShutdown?.()`，但主进程从来没把
// onShutdown 传进 `listenAppServer`——接口照常回 `{ok:true, stopping:true}`，应用一动不动：
// 端口还在、宠物还在、`/health` 还能通。脚本以为关掉了，其实什么都没发生。
// 源码层接线由 `src/app/shutdown.test.ts` 守着；这里验的是**真的会退**。
//
// 运行前：npm run build
//   DSH_PET_ELECTRON=<一份 electron 可执行文件> npm run test:ui
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const executablePath = process.env.DSH_PET_ELECTRON;

test('POST /shutdown 真的停掉应用', { skip: !executablePath, timeout: 90000 }, async () => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-pet-shutdown-'));
  // 与 desktop-window.test.mjs 错开端口：两个文件并行跑时不能抢同一个
  const env = { ...process.env, DSH_PET_APP_PORT: '7412' };
  // 本机/CI 有时会设 ELECTRON_RUN_AS_NODE（把 Electron 当纯 Node 跑），留着就永远没有窗口
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await _electron.launch({
    executablePath,
    args: [join(root, 'lib', 'app-main.cjs'), `--user-data-dir=${profile}`],
    env,
  });
  const proc = app.process();
  const exited = new Promise((done) => proc.once('exit', (code, signal) => done({ code, signal })));

  try {
    // 等本地服务起来（/health 是运维端点，不依赖宠物窗口）
    const origin = `http://127.0.0.1:7412`;
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      ready = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })
        .then((r) => r.ok)
        .catch(() => false);
      if (!ready) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(ready, '本地服务必须先起来（否则 /shutdown 无从谈起）');

    const res = await fetch(`${origin}/shutdown`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.stopping, true, '响应体要如实说明"正在停"');

    const exit = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 20000))]);
    assert.notEqual(exit, 'timeout', '20 秒内进程必须退出（不退出就是"接口在、效果没有"）');

    // 端口必须一起关掉：只杀进程不退服务的话，下次启动会顺延端口
    const alive = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1500) })
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
