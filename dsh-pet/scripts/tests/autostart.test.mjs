// 运行时回归：**开机自启**开关。
//
// 要钉三件事：
//   ① 设置页真的有这个开关，且初始状态跟系统一致（不是写死的 false）；
//   ② 勾上之后系统里真的会开机自启（读回来是 true，不是"以为开了"）；
//   ③ 取消勾选能还原——测试结束必须把机器恢复原状，不能给开发机留一条自启项。
//
// 真机副作用：Windows 会在 HKCU\…\Run 下写一条 `dsh-pet`（结束时按初始状态还原）；
// Linux 会临时写 `~/.config/autostart/dsh-pet.desktop`；macOS 动登录项。
//
// 运行前：npm run build
//   DSH_PET_ELECTRON=<一份 electron 可执行文件> npm run test:ui
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { electronExe, launchApp, waitFor } from './_harness.mjs';

const executablePath = electronExe();

/** 读/写自启状态（走设置页用的同一套接口） */
async function autoStart(base, enabled) {
  if (enabled === undefined) {
    const res = await fetch(`${base}/app/api/autostart`);
    return (await res.json()).state;
  }
  const res = await fetch(`${base}/app/api/autostart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  return (await res.json()).state;
}

test('开机自启：设置页开关能真的改系统状态', { skip: !executablePath, timeout: 90000 }, async () => {
  const { app, base } = await launchApp({ tag: 'autostart', env: { DSH_PET_UPDATE_DELAY_MS: '600000' } });

  let initial;
  try {
    initial = await autoStart(base);
    assert.equal(initial.supported, true, `本平台应支持开机自启（实际：${JSON.stringify(initial)}）`);
    assert.ok(initial.target, '必须能说清写到哪儿（设置页要展示）');
    // 源码态的登录命令必须带主进程脚本：只注册 electron.exe 的话，登录后是个没有任何窗口的空壳。
    // 这条不是理论风险——Chromium 的 --inspect 开关会插在 argv[1]，早先的实现就注册成了裸 exe。
    if (initial.dev) {
      assert.match(initial.command, /app-main\.cjs/, `源码态登录命令必须带主进程脚本（实际：${initial.command}）`);
    }

    // 设置窗首次运行会自动弹出
    let settings;
    const found = await waitFor(async () => {
      for (const page of app.windows()) {
        const title = await page.title().catch(() => '');
        if (title.includes('设置')) {
          settings = page;
          return true;
        }
      }
      return false;
    });
    assert.ok(found, '设置窗必须出现（首次运行自动弹出）');
    await settings.waitForLoadState('domcontentloaded').catch(() => {});

    // ① 卡片与开关存在，且勾选状态 == 系统状态
    const box = settings.getByRole('checkbox', { name: /开机自启/ });
    const shown = await waitFor(() => box.count().then((n) => n === 1), 15000);
    assert.ok(shown, '设置页必须有「开机自启」开关');
    assert.equal(await box.isChecked(), initial.enabled, '开关初始状态必须与系统一致');

    // ② 勾上 → 系统里真的是 true
    await box.click();
    const turnedOn = await waitFor(async () => (await autoStart(base)).enabled === true, 15000);
    assert.ok(turnedOn, '勾上之后 /app/api/autostart 必须回报 enabled=true');
    const fromMain = await app.evaluate(
      ({ app: electronApp }) => electronApp.getLoginItemSettings({ path: process.execPath, args: [] }).openAtLogin,
    );
    // 源码态注册的是 electron + 主进程脚本，args 不为空；这里用接口结果为准，主进程这条只做旁证
    assert.equal(typeof fromMain, 'boolean', '主进程应能读到登录项状态');
    assert.ok(await box.isChecked(), '开关必须停在勾选态（不能被重渲染拨回去）');

    // ③ 还原：回到测试开始前的状态
    await box.click();
    const restored = await waitFor(async () => (await autoStart(base)).enabled === initial.enabled, 15000);
    assert.ok(restored, '取消勾选后必须回到测试前的状态');
  } finally {
    // 万一上面中途断言失败，这里兜底恢复，别给开发机留下一条自启项
    if (initial) {
      await autoStart(base, initial.enabled).catch(() => {});
    }
    await app.close().catch(() => {});
  }
});
