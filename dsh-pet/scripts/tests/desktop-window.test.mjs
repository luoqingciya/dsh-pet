// 宠物窗口的运行时回归：用真实 Electron 拉起应用主进程，检查渲染端是否真的把宠物画出来。
//
// 为什么需要它：`npm test` 全是纯逻辑与源码守卫，`npm run app:smoke` 只覆盖 HTTP 侧——
// 「窗口建出来了但页面白屏」这类问题两者都抓不到（历史故障：loadFile 相对路径 → 打包后 404，
// 用户只看到"没有宠物"）。本用例是唯一一条真正打开窗口、读 DOM、看视频有没有解出首帧的检查。
//
// 运行前：
//   npm run build
//   DSH_PET_ELECTRON=<一份 electron 可执行文件> npm run test:ui
// 无显示环境（纯 CLI 的 Linux）会被跳过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const executablePath = process.env.DSH_PET_ELECTRON;

/** 等一个条件成立（最多 timeoutMs），返回是否成立 */
async function waitFor(check, timeoutMs = 15000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

test('desktop window: 渲染端拿到配置、画出宠物、视频真的在播', { skip: !executablePath, timeout: 90000 }, async (t) => {
  // 独立 profile：不碰用户真实配置，也不会撞单实例锁
  const profile = mkdtempSync(join(tmpdir(), 'dsh-pet-ui-'));
  const env = { ...process.env, DSH_PET_APP_PORT: '7411' };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await _electron.launch({
    executablePath,
    args: [join(root, 'lib', 'app-main.cjs'), `--user-data-dir=${profile}`],
    env,
  });

  try {
    // 首次启动会同时开设置窗与宠物窗，按标题挑出宠物窗
    let petPage;
    const found = await waitFor(async () => {
      for (const page of app.windows()) {
        const title = await page.title().catch(() => '');
        if (title.includes('桌宠')) {
          petPage = page;
          return true;
        }
      }
      return false;
    });
    assert.ok(found, '必须出现宠物窗口（标题含「桌宠」）');

    // 视频要先解出元数据：readyState 0 = 素材根本没加载（bridge / 路径 / 素材缺失）
    const playing = await waitFor(
      () =>
        petPage.evaluate(() =>
          Array.from(document.querySelectorAll('.pet-sprite video')).some((v) => v.readyState >= 1),
        ),
      20000,
    );
    assert.ok(playing, '宠物视频必须加载出元数据（readyState >= 1）');

    const info = await petPage.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('.pet-sprite video'));
      return {
        configOk: Boolean(window.__dshPetDebug?.configOk),
        hasBridge: typeof window.petBridge !== 'undefined',
        hasSetBounds: typeof window.petBridge?.setBounds === 'function',
        spriteCount: document.querySelectorAll('.pet-sprite').length,
        errors: (window.__dshPetDebug?.errors ?? []).slice(0, 3),
        errorVisible: document.getElementById('pet-error')?.classList.contains('visible') ?? null,
        video: videos.map((v) => ({ src: v.currentSrc, w: v.videoWidth, h: v.videoHeight, paused: v.paused })),
      };
    });

    await t.test('渲染端启动完成且无报错', () => {
      assert.equal(info.configOk, true, '渲染端必须成功拉到配置（configOk）');
      assert.equal(info.errorVisible, false, '错误提示层不得显示');
      assert.deepEqual(info.errors, [], '渲染端不得记录运行错误');
      assert.ok(info.spriteCount >= 1, '至少要画出一只宠物');
    });

    await t.test('bridge 可用（preload 暴露了窗口控制原语）', () => {
      assert.equal(info.hasBridge, true);
      assert.equal(info.hasSetBounds, true, 'setBounds 缺失 → 窗口不会跟随宠物移动');
    });

    await t.test('素材经 dsh-pet-bridge:// 加载并真的在播', () => {
      const loaded = info.video.filter((v) => v.w > 0);
      assert.ok(loaded.length >= 1, '至少有一个视频解出了尺寸');
      assert.ok(
        loaded.every((v) => v.src.startsWith('dsh-pet-bridge://')),
        '素材必须走 bridge scheme（file:// 页面直连 HTTP 会被 CORS 拦）',
      );
      assert.ok(
        loaded.some((v) => v.paused === false),
        '宠物动画必须在播放（不是暂停态）',
      );
    });
    // 回归：对话状态联动 / 通知必须对**桌面宠物自己发起的对话**生效。
    // 从前 turn 事件包在 HTTP 路由外面，bridge 这条路上什么都不发生（用户点宠物聊天时
    // 设置里的「对话状态联动」看起来还在、实际永远不切动画）。
    await t.test('桌面宠物自己发起对话也会产生状态与通知', async () => {
      const origin = await petPage.evaluate(() => new URL(CONFIG.configUrl).origin);
      const readState = async () => (await fetch(origin + '/dsh-pet-7340/state')).json();
      const before = await readState();
      const notifyBefore = before?.sections?.notify?.counter ?? 0;

      // 走渲染端同一条通道（bridge scheme）。临时 profile 里没有 API Key → 必然失败，
      // 但 turn/start、turn/end 与成败无关：状态必须切到 error，通知帧必须产生。
      const status = await petPage.evaluate(() =>
        fetch('dsh-pet-bridge://dsh-pet/dsh-pet-7340/chat?pet=main', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: '你好' }),
        }).then((r) => r.status),
      );
      assert.equal(status, 200, '对话请求应被受理（成败由响应体的 ok 表达）');

      const changed = await waitFor(async () => {
        const now = await readState();
        return Boolean(now?.sections?.workStatus?.data?.state) && (now?.sections?.notify?.counter ?? 0) > notifyBefore;
      }, 15000);
      const after = await readState();
      assert.ok(changed, '桌面宠物聊天必须触发对话状态联动与通知帧');
      assert.equal(after.sections.workStatus.data.state, 'error', '没有 API Key → 状态应为 error');
    });
  } finally {
    await app.close().catch(() => {});
  }
});
