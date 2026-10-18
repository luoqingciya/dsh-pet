// 运行时回归：**自绘托盘菜单**。
//
// 背景：Windows 上 `Tray.setContextMenu` 是原生控件，字号由系统/进程 DPI 决定；应用为了让宠物
// 像素级对齐强制了 `force-device-scale-factor=1` —— 原生菜单不跟这套补偿，150% 屏上只有 2/3 大，
// 而 MenuItem 没有字号可调。改成自绘窗口后：菜单用与宠物右键菜单**同一个** DOM 组件渲染，
// 窗口尺寸与 zoomFactor 按 uiScale 补偿。
//
// 这个用例要钉三件事：
//   ① 菜单窗口真的弹出来、渲染出全部菜单项（不是空白窗）；
//   ② 尺寸按 uiScale 放大（150% 屏上不再偏小），且落在屏幕工作区内；
//   ③ 点「退出」真的会退出应用（托盘菜单是主要退出入口，不能只是画得像）。
//
// 运行前：npm run build
//   DSH_PET_ELECTRON=<一份 electron 可执行文件> npm run test:ui
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const executablePath = process.env.DSH_PET_ELECTRON;
const PORT = 7422;

async function waitFor(check, timeoutMs = 15000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

test('自绘托盘菜单：弹出、尺寸、点「退出」', { skip: !executablePath, timeout: 90000 }, async () => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-pet-tray-'));
  const env = { ...process.env, DSH_PET_APP_PORT: String(PORT), DSH_PET_UPDATE_DELAY_MS: '600000' };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await _electron.launch({
    executablePath,
    args: [join(root, 'lib', 'app-main.cjs'), `--user-data-dir=${profile}`, '--port', String(PORT)],
    env,
  });
  const proc = app.process();
  const exited = new Promise((done) => proc.once('exit', (code) => done(code)));

  try {
    const up = await waitFor(() =>
      fetch(`http://127.0.0.1:${PORT}/health`)
        .then((r) => r.ok)
        .catch(() => false),
    );
    assert.ok(up, '本地服务应当起来');

    // 托盘图标没法用代码点，走主进程的排障钩子直接弹菜单（与右键托盘同一个函数）
    const hasHook = await app.evaluate(() => Boolean(globalThis.__dshTray));
    assert.ok(hasHook, '主进程必须暴露 __dshTray 钩子（排障/测试用）');
    await app.evaluate(() => globalThis.__dshTray.show());

    let menuPage;
    const shown = await waitFor(async () => {
      for (const page of app.windows()) {
        const title = await page.title().catch(() => '');
        if (title.includes('托盘菜单')) {
          menuPage = page;
          return true;
        }
      }
      return false;
    });
    assert.ok(shown, '托盘菜单窗口必须弹出来');

    // 菜单项真的渲染出来了（不是空白窗）
    const rendered = await waitFor(
      () => menuPage.evaluate(() => document.querySelectorAll('.dsh-pet-menu-item').length >= 5),
      8000,
    );
    const info = await menuPage.evaluate(() => ({
      items: Array.from(document.querySelectorAll('.dsh-pet-menu-item')).map((el) => el.textContent?.trim() || ''),
      panel: (() => {
        const el = document.querySelector('.dsh-pet-menu-column');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          width: Math.round(r.width),
          height: Math.round(r.height),
          x: Math.round(r.x),
          y: Math.round(r.y),
          right: Math.round(r.right),
          bottom: Math.round(r.bottom),
          position: getComputedStyle(el).position,
        };
      })(),
      styleSheets: document.styleSheets.length,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
    }));
    assert.ok(rendered, `菜单项必须渲染出来（实际：${JSON.stringify(info.items)}）`);
    assert.deepEqual(
      info.items,
      ['打开设置', '重载配置', '检查更新', '打开数据目录', '退出'],
      '菜单项与顺序必须与 TRAY_ITEMS 一致',
    );
    assert.ok(info.panel && info.panel.width > 100 && info.panel.height > 100, '菜单面板必须有实际尺寸');

    // 回归（0.8.0 实机 bug：右键托盘"没反应"）：托盘菜单是**独立页面**，宠物窗那套
    // MENU_CSS 注入（renderer.js）管不到它。少了这份样式，`.dsh-pet-menu-column` 退回
    // 正常文档流（position:static），被 `#root{height:100%}` 顶到视口下方——窗口
    // isVisible() 是 true、DOM 里也数得出 5 项，屏幕上却一个像素都没有。
    // 所以只数 DOM 拦不住，必须断言「样式真的进来了」「面板落在视口内」「窗口真的画出了像素」。
    assert.ok(info.styleSheets >= 2, `菜单样式必须注入（样式表数 ${info.styleSheets}）`);
    assert.equal(info.panel?.position, 'absolute', '菜单面板必须是绝对定位（否则会掉出视口）');
    assert.ok(
      info.panel &&
        info.panel.x >= 0 &&
        info.panel.y >= 0 &&
        info.panel.right <= info.innerWidth + 1 &&
        info.panel.bottom <= info.innerHeight + 1,
      `菜单面板必须整个落在窗口视口内（面板 ${JSON.stringify(info.panel)} / 视口 ${info.innerWidth}×${info.innerHeight}）`,
    );

    const painted = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('托盘菜单'));
      if (!win) return { opaque: 0, total: 1 };
      const bmp = (await win.webContents.capturePage()).toBitmap();
      let opaque = 0;
      for (let i = 3; i < bmp.length; i += 4) if (bmp[i] > 0) opaque++;
      return { opaque, total: bmp.length / 4 };
    });
    assert.ok(
      painted.opaque > painted.total * 0.2,
      `菜单窗口必须真的画出内容（不透明像素 ${painted.opaque}/${painted.total}；全透明＝屏幕上什么都没有）`,
    );

    // 窗口尺寸 = 菜单尺寸 × uiScale（150% 屏上要放大，否则又回到"太小"）
    const bounds = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('托盘菜单'));
      return win ? { ...win.getBounds(), scale: win.webContents.getZoomFactor() } : null;
    });
    assert.ok(bounds, '主进程里应能找到菜单窗口');
    assert.ok(bounds.scale >= 1, `zoomFactor 不应小于 1（实际 ${bounds.scale}）`);
    assert.ok(
      bounds.width >= Math.round(info.panel.width * bounds.scale) - 2,
      `窗口宽度要覆盖菜单（窗口 ${bounds.width} / 菜单 ${info.panel.width} × ${bounds.scale}）`,
    );

    // 点「退出」→ 应用必须真的退出
    await menuPage.evaluate(() => {
      const item = Array.from(document.querySelectorAll('.dsh-pet-menu-item')).find((el) =>
        (el.textContent || '').includes('退出'),
      );
      item?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const exit = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
    assert.notEqual(exit, 'timeout', '点「退出」后应用必须在 15 秒内退出');
  } finally {
    await app.close().catch(() => {});
  }
});
