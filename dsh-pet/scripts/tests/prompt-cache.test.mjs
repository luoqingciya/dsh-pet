// 运行时回归：**prompt cache 的前缀必须稳定**，以及 `--port` 在打包版代码路径上真的生效。
//
// 为什么要在真机上验：单测只能验到宿主传给 llm 的 options（`{ system, messages }`），
// 而真正发出去的 HTTP 体是 OpenAI 形状——system 被折成 `messages[0]`（role=system）。
// 写这个用例时就踩到过一次：断言读 `body.system` 永远读到 undefined，测试"通过"但什么都没验。
//
// 背景（用户实测）：填好 Key 后碎碎念几乎拿不到上下文缓存。根因是我们自己——时间背景精确到
// 分钟却拼在 system 末尾，前缀每次都在同一位置断掉：碎碎念最多命中第一个 64 token 块，
// 对话则连整段记忆历史都要重算（历史排在 system 之后）。修法是把时间行挪到最后一条 user
// 消息，system 只留人设。
//
// 运行前：npm run build
//   DSH_PET_ELECTRON=<一份 electron 可执行文件> npm run test:ui
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const executablePath = process.env.DSH_PET_ELECTRON;
/** 等条件成立（最多 timeoutMs） */
async function waitFor(check, timeoutMs = 15000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

const PORT = 7416;
const MOCK_PORT = 18098;

test('prompt cache 前缀稳定 + --port 生效', { skip: !executablePath, timeout: 90000 }, async () => {
  /** 录下来的请求体（每次 /v1/chat/completions 一条） */
  const bodies = [];
  const mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(raw || '{}');
      bodies.push(parsed);
      const lastUser = (parsed.messages || []).filter((m) => m.role === 'user').pop();
      const text = '好呀，' + String(lastUser?.content ?? '').slice(-6);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const part of [text.slice(0, 4), text.slice(4)]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((done) => mock.listen(MOCK_PORT, '127.0.0.1', done));

  const profile = mkdtempSync(join(tmpdir(), 'dsh-pet-cache-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // 端口只用 --port 传（不设环境变量）：顺带验证打包版也认这个命令行开关
  delete env.DSH_PET_APP_PORT;

  const app = await _electron.launch({
    executablePath,
    args: [join(root, 'lib', 'app-main.cjs'), `--user-data-dir=${profile}`, '--port', String(PORT)],
    env,
  });

  try {
    let health;
    for (let i = 0; i < 60 && !health; i += 1) {
      health = await fetch(`http://127.0.0.1:${PORT}/health`)
        .then((r) => r.json())
        .catch(() => null);
      if (!health) await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(health?.port, PORT, '--port 必须生效（环境变量没设，端口只能来自 argv）');

    // 把模型端点指向 mock（临时 profile，不影响任何真实配置）
    await fetch(`http://127.0.0.1:${PORT}/app/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          provider: 'custom',
          model: 'mock-1',
          balanceProvider: '',
          endpoints: [
            {
              id: 'custom',
              name: 'mock',
              baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
              apiKeyRef: '',
              models: ['mock-1'],
            },
          ],
          notify: { chatReply: true, balanceAlert: true },
        },
      }),
    });

    await fetch(`http://127.0.0.1:${PORT}/dsh-pet-7340/whisper?pet=main`, { method: 'POST' });
    for (const text of ['第一句话', '第二句话']) {
      await fetch(`http://127.0.0.1:${PORT}/dsh-pet-7340/chat?pet=main`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    }

    const [whisper, chat1, chat2] = bodies;
    assert.ok(whisper && chat1 && chat2, '三次生成都必须真的打到 mock 端点');

    /** system 在真实请求体里是 messages[0]（role=system），不是顶层 system 字段 */
    const sysOf = (body) => String((body.messages || []).find((m) => m.role === 'system')?.content ?? '');
    const lastUserOf = (body) => String((body.messages || []).filter((m) => m.role === 'user').pop()?.content ?? '');

    assert.ok(!sysOf(whisper).includes('【当下】'), 'system 不得含时间行（它会打断缓存前缀）');
    assert.ok(lastUserOf(whisper).startsWith('【当下】'), '时间行必须在 user 消息里');
    assert.equal(sysOf(whisper), sysOf(chat1), '碎碎念与对话共用同一个人设（同一只宠物）');
    assert.equal(sysOf(chat1), sysOf(chat2), 'system 必须逐字相同——它就是缓存前缀');
    assert.equal(
      chat2.messages[1]?.content,
      '第一句话',
      '历史里的 user 消息必须是原文（带时间行就等于每轮都把前缀打断）',
    );
    assert.ok(lastUserOf(chat2).includes('第二句话'), '本轮用户消息不能被时间行顶掉');

    // 回归：回复必须**显示在气泡上**，不能被 turn/end 的「这一轮搞定啦」盖掉。
    // 现场故障：问完话只看到"任务结束"，回复其实已写进 S，得再点一次「对话」翻历史才看到。
    let petPage;
    for (const page of app.windows()) {
      const title = await page.title().catch(() => '');
      if (title.includes('桌宠')) petPage = page;
    }
    assert.ok(petPage, '宠物窗口必须在');
    const bubbleShown = await waitFor(
      () => petPage.evaluate(() => (document.querySelector('.pet-bubble.is-on')?.textContent || '').includes('好呀')),
      10000,
    );
    const bubbleText = await petPage.evaluate(() => document.querySelector('.pet-bubble.is-on')?.textContent || '');
    assert.ok(bubbleShown, `对话回复必须显示在气泡里（实际气泡：${JSON.stringify(bubbleText)}）`);
  } finally {
    await app.close().catch(() => {});
    mock.close();
  }
});
