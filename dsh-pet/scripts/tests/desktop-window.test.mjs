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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
    // 外部状态灯（POST /work-status）：任何脚本都能点亮桌宠，文案要落到气泡上
    await t.test('外部状态灯能点亮桌宠并显示自定义文案', async () => {
      const origin = await petPage.evaluate(() => new URL(CONFIG.configUrl).origin);
      const post = (body) =>
        fetch(origin + '/dsh-pet-7340/work-status', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      const res = await post({ state: 'working', text: '跑测试', ttlSec: 60 });
      assert.equal(res.status, 200, '状态灯写入应被受理');

      const shown = await waitFor(
        () =>
          petPage.evaluate(() => (document.querySelector('.pet-bubble.is-on')?.textContent || '').includes('跑测试')),
        10000,
      );
      assert.ok(shown, '气泡必须显示外部传入的文案（text 覆盖档位文案）');

      const cleared = await post({ state: null });
      assert.equal(cleared.status, 200, '清空应被受理');
      const gone = await waitFor(
        () =>
          petPage.evaluate(() => !(document.querySelector('.pet-bubble.is-on')?.textContent || '').includes('跑测试')),
        10000,
      );
      assert.ok(gone, '清空后气泡文案必须消失');
    });
    // 回归：对话弹窗必须显示最近记忆（`GET /chat` 的唯一消费方）。
    // 从前这个接口一个调用方都没有——注释写着"弹窗打开时展示"，实际弹窗只有一个输入框，
    // 「记忆轮数」这个设置在界面上没有任何可见出口。
    await t.test('右键「对话」打开的弹窗顶部显示最近记忆', async () => {
      const origin = await petPage.evaluate(() => new URL(CONFIG.configUrl).origin);
      // host 读的是 /config/meta 里那个 user 文件所在目录下的 memory.json；
      // 临时 profile 里没配 API Key（发不出真对话），直接写两条记忆模拟"聊过"。
      const meta = await (await fetch(origin + '/dsh-pet-7340/config/meta')).json();
      const dataRoot = dirname(String(meta.user));
      mkdirSync(dataRoot, { recursive: true });
      writeFileSync(
        join(dataRoot, 'memory.json'),
        JSON.stringify({
          main: {
            main: {
              messages: [
                { role: 'user', content: '在吗', ts: 1 },
                { role: 'assistant', content: '在的在的', ts: 2 },
              ],
            },
          },
        }),
        'utf8',
      );

      // 走用户真实路径（右键「对话」→ showChatFromMenu），不是直接 mount 组件：
      // 它带 clamp 可视矩形与宠物自己的素材根，与手写调用不是同一条代码路径。
      const opened = await petPage.evaluate(() => {
        const sprite = sprites[0];
        if (!sprite) return 'no-sprite';
        sprite.showChatFromMenu();
        return window.__dshPetDebug.chatOpen === true ? 'open' : 'not-open';
      });
      assert.equal(opened, 'open', '右键「对话」应打开弹窗');

      const shown = await waitFor(
        () => petPage.evaluate(() => document.querySelectorAll('.dsh-pet-chat-history .dsh-pet-chat-row').length === 2),
        10000,
      );
      const info = await petPage.evaluate(() => {
        const box = document.querySelector('.dsh-pet-chat')?.getBoundingClientRect();
        return {
          rows: Array.from(document.querySelectorAll('.dsh-pet-chat-history .dsh-pet-chat-row')).map(
            (el) => el.textContent,
          ),
          inView: box
            ? box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight
            : false,
          errors: (window.__dshPetDebug.errors ?? []).slice(0, 3),
        };
      });
      assert.ok(shown, `历史必须显示在弹窗顶部（实际：${JSON.stringify(info.rows)}）`);
      assert.deepEqual(info.rows, ['你：在吗', 'TA：在的在的'], '历史内容与顺序必须与 memory.json 一致');
      assert.equal(info.inView, true, '弹窗（含历史）必须落在窗口内：历史是异步到达的，高度变了要重新夹回');
      assert.deepEqual(info.errors, [], '渲染端不得记录错误');

      // 再点一次关掉，避免影响后续用例
      await petPage.evaluate(() => sprites[0].showChatFromMenu());
      const closed = await waitFor(() => petPage.evaluate(() => window.__dshPetDebug.chatOpen === false), 5000);
      assert.ok(closed, '再点「对话」应关掉弹窗');
    });
  } finally {
    await app.close().catch(() => {});
  }
});
