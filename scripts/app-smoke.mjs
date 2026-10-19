#!/usr/bin/env node
/**
 * app-smoke.mjs —— 本地应用的端到端冒烟检查（需要应用已在运行）。
 *
 * 覆盖的是「脱离 DSH 之后最容易断掉的那几条链路」，全部用可计算的断言
 * （HTTP 状态 / JSON 字段 / 状态 counter 变化），不看截图：
 *   1. 本地服务配置的读写与密钥不回显；
 *   2. 模型清单来自端点的 `GET /models`（不靠硬编码）；
 *   3. LLM 流式适配（起一个 mock OpenAI 兼容端点，验证分块拼接）；
 *   4. 碎碎念 → 写入 `/state`；
 *   5. 对话 → 生成成功 → 工作状态切 success → 产生通知帧；
 *   6. 对话记忆落盘。
 *
 * 用法：
 *   终端 A：npm run app
 *   终端 B：npm run app:smoke
 *
 * 注意：它会**改写**本地服务配置（指向临时 mock 端点，并在结束时还原为 DeepSeek 默认）。
 */
import { createServer } from 'node:http';

const APP = process.env.DSH_PET_APP_URL || 'http://127.0.0.1:7340';
const MOCK_PORT = Number(process.env.DSH_PET_SMOKE_MOCK_PORT || 18099);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
}

async function json(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/** mock OpenAI 兼容端点：/v1/models + 流式 /v1/chat/completions */
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-1' }, { id: 'mock-2' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      const parsed = JSON.parse(body || '{}');
      const lastUser = (parsed.messages || []).filter((m) => m.role === 'user').pop();
      const text = '这是 mock 回复：' + String(lastUser?.content ?? '').slice(0, 12);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const part of [text.slice(0, 6), text.slice(6, 12), text.slice(12)]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404).end();
  });
});

await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

const deepseekDefaults = {
  provider: 'deepseek-official',
  model: 'deepseek-chat',
  endpoints: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek 官方',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyRef: 'DEEPSEEK_API_KEY',
      models: ['deepseek-chat', 'deepseek-reasoner'],
    },
  ],
};

try {
  // 1) 配置写入（端点指向 mock）
  const saved = await json(`${APP}/app/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      config: {
        provider: 'custom',
        model: 'mock-1',
        endpoints: [
          {
            id: 'custom',
            name: '自定义（OpenAI 兼容）',
            baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
            apiKeyRef: 'CUSTOM_API_KEY',
            models: [],
          },
        ],
      },
      keys: { CUSTOM_API_KEY: 'sk-mock' },
    }),
  });
  check('保存本地配置', saved.status === 200 && saved.body.ok, saved.body?.config?.provider);
  check('密钥不回显明文', !JSON.stringify(saved.body ?? {}).includes('sk-mock'));

  // 2) 模型清单
  const models = await json(`${APP}/dsh-pet-ng-7340/models`);
  const group = (models.body?.providers ?? []).find((item) => item.id === 'custom');
  check(
    '模型清单来自端点 /models',
    group?.models?.some((item) => item.id === 'mock-1'),
  );

  // 3) 连通性
  const tested = await json(`${APP}/app/api/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'custom', model: 'mock-1' }),
  });
  check('LLM 流式适配（测试连通）', tested.body?.ok === true, tested.body);

  // 4) 碎碎念
  const whisper = await json(`${APP}/dsh-pet-ng-7340/whisper?pet=main`, { method: 'POST' });
  check('碎碎念生成成功', whisper.body?.ok === true, whisper.body);
  const state1 = await json(`${APP}/dsh-pet-ng-7340/state`);
  const say = state1.body?.pets?.main?.say?.data?.text;
  check('碎碎念写入 /state', typeof say === 'string' && say.includes('mock'), say);

  // 5) 对话 → 通知帧 + 工作状态
  const before = state1.body?.sections?.notify?.counter ?? 0;
  const chat = await json(`${APP}/dsh-pet-ng-7340/chat?pet=main`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好呀' }),
  });
  check('对话生成成功', chat.body?.ok === true, chat.body);
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const state2 = await json(`${APP}/dsh-pet-ng-7340/state`);
  check('对话产生通知帧', (state2.body?.sections?.notify?.counter ?? 0) > before);
  check('工作状态切到 success', state2.body?.sections?.workStatus?.data?.state === 'success');

  // 6) 记忆
  const memory = await json(`${APP}/dsh-pet-ng-7340/chat?pet=main`);
  check('对话记忆已记录', Array.isArray(memory.body?.messages) && memory.body.messages.length >= 2);
} finally {
  // 还原配置（不还原密钥：mock 的 CUSTOM_API_KEY 保留在本地也无害，用户可在设置页清除）
  await json(`${APP}/app/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config: deepseekDefaults }),
  }).catch(() => {});
  mock.close();
}

const failed = checks.filter((item) => !item.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
