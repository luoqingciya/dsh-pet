// 运行时回归：版本检查（A 方案）与设置页的模型下拉建议。
//
// 两件事都属于「有实现、没消费方」的历史问题：
//   ① 版本检查此前**完全不存在**——免安装版没有任何"有新版本"的提示；
//   ② `GET /models` 此前在应用里**一个调用方都没有**（设置页只调 /config），模型只能盲填。
//      现在它给「模型」输入框提供下拉建议（自绘，不用原生 datalist），这个用例从真实窗口的 DOM 里验证。
//
// 运行前：npm run build
//   DSH_PET_ELECTRON=<一份 electron 可执行文件> npm run test:ui
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const executablePath = process.env.DSH_PET_ELECTRON;
const PORT = 7417;
const MOCK_PORT = 18095; // 与 prompt-cache(18098) / app-smoke(18099) 错开，避免并行跑时抢端口

/** 等条件成立（最多 timeoutMs） */
async function waitFor(check, timeoutMs = 15000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

test('版本检查提示 + 设置页模型建议', { skip: !executablePath, timeout: 120000 }, async (t) => {
  // mock：版本接口（返回一个远高于当前的版本）+ 模型清单接口
  const mock = createServer((req, res) => {
    if (req.url === '/latest') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://example.com/download' }));
      return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-a' }, { id: 'mock-b' }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((done) => mock.listen(MOCK_PORT, '127.0.0.1', done));

  const profile = mkdtempSync(join(tmpdir(), 'dsh-pet-update-'));
  const env = {
    ...process.env,
    // 版本检查指向本地 mock（默认是 api.github.com，测试不能依赖外网）
    DSH_PET_UPDATE_API: `http://127.0.0.1:${MOCK_PORT}/latest`,
    // 首次检查的延迟从 15s 压到 0.4s，否则这个用例要干等
    DSH_PET_UPDATE_DELAY_MS: '400',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DSH_PET_APP_PORT;

  const app = await _electron.launch({
    executablePath,
    args: [join(root, 'lib', 'app-main.cjs'), `--user-data-dir=${profile}`, '--port', String(PORT)],
    env,
  });

  try {
    const logFile = join(profile, 'dsh-pet', 'app.log');

    await t.test('自动检查：发现新版本会写日志（通知点击打开下载页）', async () => {
      const ok = await waitFor(
        () => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('[update] 发现新版本 99.0.0'),
        20000,
      );
      assert.ok(
        ok,
        `app.log 必须记录发现的新版本（实际：${existsSync(logFile) ? readFileSync(logFile, 'utf8').slice(-200) : '无日志'}）`,
      );
    });

    await t.test('设置页「模型」输入框拿到端点 /models 的建议', async () => {
      // 先把端点指向 mock（这样 host 的 /models 才拉得到清单）
      await fetch(`http://127.0.0.1:${PORT}/app/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          config: {
            provider: 'custom',
            model: 'mock-a',
            balanceProvider: '',
            endpoints: [
              {
                id: 'custom',
                name: 'mock',
                baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
                apiKeyRef: '',
                models: [],
              },
            ],
            notify: { chatReply: true, balanceAlert: true },
            updateCheck: true,
          },
        }),
      });

      // 首次运行会自动弹设置窗；找不到就等一会
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

      // 设置页默认在「桌宠」页签，LocalPanel 要点了才挂载（挂载时才去拉 /models）
      await settings.getByRole('tab', { name: '本地服务' }).click();
      // /models 是异步的：先等提示里的条数出现，再展开下拉——否则聚焦时清单还是空的，列表不会开
      const loaded = await waitFor(() => settings.evaluate(() => document.body.innerText.includes('共 2 个')), 20000);
      assert.ok(loaded, '/models 返回后，提示里应出现建议条数');
      // 「模型」建议是**自绘**下拉（原生 datalist 的弹层不跟页面 zoom，150% 屏上只有 2/3 大），
      // 数据不在 DOM 里，要聚焦输入框才展开
      await settings.locator('.suggest input').click();
      const ready = await waitFor(
        () => settings.evaluate(() => document.querySelectorAll('.suggest-list li').length === 2),
        5000,
      );
      const info = await settings.evaluate(() => ({
        options: Array.from(document.querySelectorAll('.suggest-list li')).map((el) => el.textContent?.trim() ?? ''),
        hasUpdateToggle: Boolean(
          Array.from(document.querySelectorAll('label')).find((el) => el.textContent?.includes('自动检查')),
        ),
        text: document.body.innerText,
      }));
      assert.ok(ready, `模型下拉必须有 2 个建议（实际：${JSON.stringify(info.options)}）`);
      assert.deepEqual(info.options.sort(), ['mock-a', 'mock-b']);
      assert.ok(info.hasUpdateToggle, '设置页必须有「自动检查」开关');
      assert.ok(info.text.includes('更新'), '设置页应有「更新」卡片');

      // 「立即检查」按钮：点一下必须真的去查（mock 返回 v99.0.0），并给出可点的下载页链接
      await settings.getByRole('button', { name: '立即检查' }).click();
      const checked = await waitFor(
        () => settings.evaluate(() => document.body.innerText.includes('有新版本 v99.0.0')),
        15000,
      );
      const after = await settings.evaluate(() => ({
        text: document.body.innerText,
        link: document.querySelector('a[href="https://example.com/download"]') !== null,
      }));
      assert.ok(checked, `点「立即检查」应显示发现的新版本（实际：${after.text.slice(-120)}）`);
      assert.ok(after.link, '有新版本时必须给出「打开下载页」链接');
    });
  } finally {
    await app.close().catch(() => {});
    mock.close();
  }
});

test('设置里关掉自动检查 → 完全不发那次请求', { skip: !executablePath, timeout: 60000 }, async () => {
  let hits = 0;
  const mock = createServer((req, res) => {
    if (req.url === '/latest') {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://example.com/download' }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((done) => mock.listen(MOCK_PORT + 1, '127.0.0.1', done));

  const profile = mkdtempSync(join(tmpdir(), 'dsh-pet-noupdate-'));
  // 预写配置：自动检查关闭（首次启动没有配置文件时读的是默认值 true）
  const dir = join(profile, 'dsh-pet');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'app-config.json'),
    JSON.stringify({
      version: 1,
      provider: 'custom',
      model: 'mock-a',
      balanceProvider: '',
      endpoints: [{ id: 'custom', name: 'mock', baseUrl: 'http://127.0.0.1:9/v1', apiKeyRef: '', models: ['mock-a'] }],
      notify: { chatReply: true, balanceAlert: true },
      updateCheck: false,
    }),
    'utf8',
  );

  const env = {
    ...process.env,
    DSH_PET_UPDATE_API: `http://127.0.0.1:${MOCK_PORT + 1}/latest`,
    DSH_PET_UPDATE_DELAY_MS: '300',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DSH_PET_APP_PORT;

  const app = await _electron.launch({
    executablePath,
    args: [join(root, 'lib', 'app-main.cjs'), `--user-data-dir=${profile}`, '--port', String(PORT + 1)],
    env,
  });

  try {
    // 等到服务就绪 + 首检延迟过去，再确认一次请求都没发
    const up = await waitFor(
      () =>
        fetch(`http://127.0.0.1:${PORT + 1}/health`)
          .then((r) => r.ok)
          .catch(() => false),
      20000,
    );
    assert.ok(up, '应用应当正常启动');
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(hits, 0, '关掉自动检查后不得向版本接口发任何请求');

    const logFile = join(dir, 'app.log');
    if (existsSync(logFile)) {
      assert.ok(!readFileSync(logFile, 'utf8').includes('[update]'), '日志里不该出现更新检查的记录');
    }
  } finally {
    await app.close().catch(() => {});
    mock.close();
  }
});
