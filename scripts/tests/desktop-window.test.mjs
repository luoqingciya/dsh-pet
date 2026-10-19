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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { electronExe, launchApp, waitFor } from './_harness.mjs';

const executablePath = electronExe();

/** 读渲染端的驱动状态：drive + 还活着的循环（物理证据）+ 调试镜像 */
const readDriveOf = (page) =>
  page.evaluate(() => {
    const s = sprites[0];
    return {
      drive: s.drive,
      live: [
        ['move', s.moveLoop],
        ['drag', s.dragLoop],
        ['throw', s.throwLoop],
      ]
        .filter(([, v]) => v !== null)
        .map(([k]) => k),
      debug: window.__dshPetDebug.drive,
      hasCustomPos: s.customPos !== null,
    };
  });

test('desktop window: 渲染端拿到配置、画出宠物、视频真的在播', { skip: !executablePath, timeout: 90000 }, async (t) => {
  // 独立 profile + 独立端口：不碰用户真实配置，也不会撞单实例锁
  const { app, profile } = await launchApp({ tag: 'ui' });

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

    await t.test('素材经 dsh-pet-ng-bridge:// 加载并真的在播', () => {
      const loaded = info.video.filter((v) => v.w > 0);
      assert.ok(loaded.length >= 1, '至少有一个视频解出了尺寸');
      assert.ok(
        loaded.every((v) => v.src.startsWith('dsh-pet-ng-bridge://')),
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
      const readState = async () => (await fetch(origin + '/dsh-pet-ng-7340/state')).json();
      const before = await readState();
      const notifyBefore = before?.sections?.notify?.counter ?? 0;

      // 走渲染端同一条通道（bridge scheme）。临时 profile 里没有 API Key → 必然失败，
      // 但 turn/start、turn/end 与成败无关：状态必须切到 error，通知帧必须产生。
      const status = await petPage.evaluate(() =>
        fetch('dsh-pet-ng-bridge://dsh-pet-ng/dsh-pet-ng-7340/chat?pet=main', {
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
        fetch(origin + '/dsh-pet-ng-7340/work-status', {
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
      const meta = await (await fetch(origin + '/dsh-pet-ng-7340/config/meta')).json();
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
        () =>
          petPage.evaluate(
            () => document.querySelectorAll('.dsh-pet-ng-chat-history .dsh-pet-ng-chat-row').length === 2,
          ),
        10000,
      );
      const info = await petPage.evaluate(() => {
        const box = document.querySelector('.dsh-pet-ng-chat')?.getBoundingClientRect();
        return {
          rows: Array.from(document.querySelectorAll('.dsh-pet-ng-chat-history .dsh-pet-ng-chat-row')).map(
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

    // 真机全链路：pointerdown → 越过阈值 → 弹簧跟手 → 松手甩出 → 落地收尾。
    //
    // 这条链路此前**没有任何覆盖**：drive-loops 的单测只到纯逻辑，状态机用例是分段驱动
    // （直接调 startThrow）。中间那层"DOM 指针事件 → dragState → 弹簧跟随 → 松手估速"从没跑过，
    // 而它恰恰最容易回归：阈值、屏幕坐标增量、pointer capture、估速窗口，任一处改错都表现为
    // "宠物拖不动"或"松手不飞"，且只有真人操作才会发现。
    //
    // 两段式：**按下**用真实 CDP 指针（证明命中层可点、OS 穿透下事件仍能到达），
    // **位移**用屏幕坐标的合成事件（CDP 的视口坐标会与"窗口跟随宠物"形成正反馈，见下方注释）。
    await t.test('拖拽→甩出→落地 走完整链路（真机指针事件）', async () => {
      const readDrive = () => readDriveOf(petPage);
      const start = await petPage.evaluate(() => {
        const r = document.querySelector('.pet-hit').getBoundingClientRect();
        return {
          cx: r.left + r.width / 2,
          cy: r.top + r.height / 2,
          pos: { x: sprites[0].pos.x, y: sprites[0].pos.y },
        };
      });

      // ⓪ 先证明"位置上报 → 主进程真的移动窗口"这条链没断（紧接着要把它桩掉，否则拖拽测不了）。
      // 这一段走的是**真实** sendBounds：渲染端 → pet:set-bounds → setContentBounds。
      const winBoundsOf = () =>
        app.evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows().find((x) => String(x.getTitle()).includes('桌宠'));
          return w ? w.getBounds() : null;
        });
      const beforeWin = await winBoundsOf();
      assert.ok(beforeWin, '必须能拿到宠物窗口的 bounds（主进程侧）');
      await petPage.evaluate(() => {
        const s = sprites[0];
        s.sendBounds(s.pos.x + 40, s.pos.y + 20); // 真实路径：上报 → IPC → 主进程移动窗口
      });
      const winMoved = await waitFor(async () => {
        const b = await winBoundsOf();
        return !!b && b.x >= beforeWin.x + 30 && b.y >= beforeWin.y + 15;
      }, 5000);
      const afterWin = await winBoundsOf();
      assert.ok(
        winMoved,
        `主进程必须真的把窗口移过去（x ${beforeWin.x} → ${afterWin?.x}，y ${beforeWin.y} → ${afterWin?.y}）`,
      );

      // 窗口移动的桩：把 sendBounds 换成"只更新 pos、不发 IPC"。
      //
      // 为什么必须桩掉：真机上窗口会跟着宠物走，而 CDP 的虚拟光标不会跟着窗口走。
      // 窗口一移，Chromium 就判定指针已经离开窗口并**释放指针捕获**（lostpointercapture），
      // 于是 dragState 被兜底复位、拖拽在第二帧就断了。真实鼠标不存在这个问题——物理光标
      // 由用户按着，窗口朝它移动，指针始终在窗内。
      // 桩掉之后：拖拽/弹簧/估速/抛掷的逻辑照常全跑，只是不再真的移动窗口——那条链
      // （上报 → IPC → setContentBounds）由上面的 ⓪ 单独断言，不在这里重复。
      await petPage.evaluate(() => {
        const s = sprites[0];
        s.__realSendBounds = s.sendBounds;
        s.sendBounds = function (x, y) {
          this.pos = { x: Math.round(x), y: Math.round(y) };
        };
      });

      try {
        // ① 真实指针按下：证明 .pet-hit 在 OS 点击穿透（setIgnoreMouseEvents）下仍能接到事件
        await petPage.mouse.move(start.cx, start.cy);
        await petPage.mouse.down();
        const pressed = await petPage.evaluate(() => ({
          active: sprites[0].dragState.active,
          dragging: sprites[0].dragState.dragging,
        }));
        assert.equal(pressed.active, true, 'pointerdown 必须被 .pet-hit 接住');
        assert.equal(pressed.dragging, false, '还没越过阈值时不该算拖拽（否则点击会被误判成拖拽）');
        // 立刻收掉这个真实指针：它没有对应的**物理**光标，窗口一移 Chromium 就可能判定
        // "指针已离开"并释放捕获 → lostpointercapture → 松手兜底 → 拖拽被掐断。
        // 本地偶发、CI 上稳定复现（1.0.1 首轮 tag 就是这么挂的）。拖拽过程改由合成事件驱动。
        await petPage.mouse.up();
        await new Promise((r) => setTimeout(r, 50)); // 让真实指针可能触发的 lostpointercapture 先排空

        // ② 合成 pointerdown + 两次位移：完整走一遍 dragState → 阈值 → 弹簧跟随
        const mid = await petPage.evaluate(async () => {
          const s = sprites[0];
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const before = { x: s.pos.x, y: s.pos.y };
          const pid = 7; // 自用 pointerId，避开真实指针
          /** 按**屏幕坐标**发指针事件（dx/dy 是相对按下点的屏幕增量，CSS px）——与真实鼠标同构 */
          const fire = (type, dx, dy, buttons) =>
            s.hit.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                pointerId: pid,
                button: 0,
                buttons,
                screenX: toScreen(s.dragState.sx + dx),
                screenY: toScreen(s.dragState.sy + dy),
              }),
            );
          // 基准沿用上一次真实按下记下的屏幕坐标（sx/sy），合成按下只是把它再设一遍
          fire('pointerdown', 0, 0, 1);
          const afterDown = { active: s.dragState.active, dragging: s.dragState.dragging };
          fire('pointermove', 40, -20, 1); // 越过阈值（5px）
          await sleep(30); // 轨迹要两个相隔 ≥20ms 的样本（估速要求）
          fire('pointermove', 120, -60, 1);
          await sleep(60); // 弹簧跟随跑几帧，位置真的动起来
          return {
            afterDown,
            dragging: s.dragState.dragging,
            drive: s.drive,
            live: [s.moveLoop, s.dragLoop, s.throwLoop].filter(Boolean).length,
            stage: s.stage.style.transform,
            before,
            pos: { x: s.pos.x, y: s.pos.y },
          };
        });
        assert.equal(
          mid.afterDown.active,
          true,
          `合成 pointerdown 也必须被接住（实际 ${JSON.stringify(mid.afterDown)}）`,
        );
        assert.equal(mid.afterDown.dragging, false, '按下瞬间不该算拖拽');
        assert.equal(
          mid.dragging,
          true,
          `超过阈值（5px）后必须进入拖拽态（drive=${mid.drive}，live=${mid.live}，按下时 ${JSON.stringify(mid.afterDown)}）`,
        );
        assert.equal(mid.drive, 'drag', '拖拽期间驱动源必须是 drag');
        assert.equal(mid.live, 1, '拖拽期间只能有一个循环在写位置');
        assert.equal(mid.stage, 'none', '拖拽时舞台要拍平（人物随光标拿起）');
        const moved = Math.hypot(mid.pos.x - mid.before.x, mid.pos.y - mid.before.y);
        assert.ok(moved > 10, `宠物必须真的跟着指针走（实际位移 ${moved.toFixed(1)}px）`);

        // ③ 再甩一下立刻松手：轨迹够新够快 → 估出初速 → 抛掷
        const released = await petPage.evaluate(() => {
          const s = sprites[0];
          const init = {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            button: 0,
            buttons: 0,
            screenX: toScreen(s.dragState.sx + 150),
            screenY: toScreen(s.dragState.sy - 20),
          };
          s.hit.dispatchEvent(new PointerEvent('pointermove', { ...init, buttons: 1 }));
          window.dispatchEvent(new PointerEvent('pointerup', init));
          return {
            drive: s.drive,
            live: [s.moveLoop, s.dragLoop, s.throwLoop].filter(Boolean).length,
            dragging: s.dragState.dragging,
          };
        });
        assert.equal(released.dragging, false, '松手后拖拽态必须复位');
        assert.equal(released.drive, 'throw', '快速甩出后松手必须进入抛掷（否则松手只会原地放下）');
        assert.equal(released.live, 1, '抛掷期间只能有一个循环在写位置');

        // ④ 落地收尾：落点写进 customPos、留痕，驱动源收回 none
        const settled = await waitFor(async () => (await readDrive()).drive === 'none', 25000);
        const after = await readDrive();
        assert.ok(settled, `抛掷必须自然收尾（当前 ${after.drive}）`);
        assert.deepEqual(after.live, [], '收尾后不该残留循环');
        assert.equal(after.hasCustomPos, true, '落点要写进 customPos（下次启动的位置）');
        const release = await petPage.evaluate(() => window.__dshPetDebug.lastDragRelease ?? null);
        assert.ok(release && Number.isFinite(release.x), '落定要留痕（排障与冒烟断言都读它）');

        const errors = await petPage.evaluate(() => (window.__dshPetDebug.errors ?? []).slice(0, 3));
        assert.deepEqual(errors, [], '整条链路不得产生渲染端错误');
      } finally {
        // 还原 sendBounds：后面的用例不该被这个桩影响
        await petPage
          .evaluate(() => {
            const s = sprites[0];
            if (s.__realSendBounds) {
              s.sendBounds = s.__realSendBounds;
              delete s.__realSendBounds;
            }
          })
          .catch(() => {});
      }
    });

    // 回归：位置驱动源（漫游/拖拽/抛掷）同一时刻**只能有一个**在写 this.pos。
    //
    // 从前是四套 rAF 各带 token，靠调用点手工"先 stopXxx 再 startYyy"维持这条不变量。
    // 漏一处就是两个循环同时写坐标——宠物抖成两团、落地后还按旧速度漂，真机上极难复现
    // （取决于动画就绪与用户操作的先后）。C 阶段把它做成显式状态机（shared/drive.ts），
    // 这条用例钉住真机上的行为：状态合法、抢占被拒、自然收尾。
    // 放在最后：抛掷会真的移动窗口，前面的几何断言（弹窗必须落在窗口内）不能被它影响。
    await t.test('位置驱动源同一时刻只有一个，且能正常收尾', async () => {
      // 直接看三个循环：这是"谁在写位置"的物理证据，比状态字段更难撒谎
      const readDrive = () => readDriveOf(petPage);

      // ① 启动即合法：允许静止或正在漫游，但不许"两个驱动源同时在跑"
      const boot = await readDrive();
      assert.ok(['none', 'move', 'drag', 'throw'].includes(boot.drive), `drive 非法：${boot.drive}`);
      assert.equal(boot.debug, boot.drive, '调试钩子必须与真实状态一致（排障全靠它）');
      assert.ok(boot.live.length <= 1, `启动后不该有多个驱动源在跑：${boot.live.join(',')}`);

      // ② 抛掷接管位置，且**漫游抢不走**（用户的手优先；背景行为不许插队）
      const thrown = await petPage.evaluate(() => {
        const s = sprites[0];
        s.startThrow(s.pos.x, s.pos.y, 600, -900);
        return { drive: s.drive, live: [s.moveLoop, s.dragLoop, s.throwLoop].filter((v) => v !== null).length };
      });
      assert.equal(thrown.drive, 'throw', 'startThrow 必须接管位置');
      assert.equal(thrown.live, 1, '抛掷期间只能有一个 rAF 在写位置');

      const noPreempt = await petPage.evaluate(() => {
        const s = sprites[0];
        // 伪造一次"移动动画就绪"：这正是从前会同时开出第二个循环的路径
        s.pendingMove = {
          startRatio: 0.1,
          startYRatio: 0.1,
          targetRatio: 0.9,
          dir: 1,
          totalRatio: 0.8,
          leadSec: 0,
          tailSec: 0,
        };
        s.startMoveDrive(document.createElement('video'));
        return {
          drive: s.drive,
          pending: s.pendingMove,
          live: [s.moveLoop, s.dragLoop, s.throwLoop].filter((v) => v !== null).length,
        };
      });
      assert.equal(noPreempt.drive, 'throw', '漫游绝不能抢占飞行中的宠物');
      assert.equal(noPreempt.live, 1, '被拒的移动不许留下第二个循环');
      assert.equal(noPreempt.pending, null, '被拒的移动必须作废（否则 tryMove 会永久以为「已有移动在进行」）');

      // ③ 自然落地 → 收回 'none'。卡在 'throw' 上会导致以后再也起不了漫游（位置永远被"占用"）
      const settled = await waitFor(async () => (await readDrive()).drive === 'none', 25000);
      const after = await readDrive();
      assert.ok(settled, `抛掷必须自然收尾（当前 ${after.drive}，活动 ${after.live.join(',')}）`);
      assert.deepEqual(after.live, [], '收尾后不该残留 rAF');
      assert.equal(after.hasCustomPos, true, '落定位置要写进 customPos（下次启动的落点）');

      // ④ 抓取随时可抢（含空中抓取），松手立刻让位
      const grabbed = await petPage.evaluate(() => {
        const s = sprites[0];
        s.startThrow(s.pos.x, s.pos.y, 0, -600); // 先飞起来
        const flying = s.drive;
        s.dragTarget = { x: s.pos.x + 40, y: s.pos.y };
        s.startDragFollow(); // 空中一把抓住
        const during = s.drive;
        const live = [s.moveLoop, s.dragLoop, s.throwLoop].filter((v) => v !== null).length;
        s.stopDragFollow();
        return { flying, during, live, after: s.drive };
      });
      assert.equal(grabbed.flying, 'throw', '抛掷应已开始');
      assert.equal(grabbed.during, 'drag', '空中抓取必须能抢过抛掷（用户的手优先）');
      assert.equal(grabbed.live, 1, '抓取接管的瞬间也必须只有一个循环在跑');
      assert.equal(grabbed.after, 'none', '松手后驱动源必须收回 none');

      const errors = await petPage.evaluate(() => (window.__dshPetDebug.errors ?? []).slice(0, 3));
      assert.deepEqual(errors, [], '整个拖拽/抛掷过程中渲染端不得报错');
    });
  } finally {
    await app.close().catch(() => {});
  }
});
