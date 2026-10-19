/**
 * 本地 LLM 适配层的单元测试 —— 钉住「协议翻译」这一层最容易出的三类错：
 *   1. **流式拼接**：SSE 分块可能把一个 JSON 行劈成两半，必须按行缓冲而不是按块解析；
 *   2. **失败可诊断**：缺 key / 缺端点 / 上游 4xx 都要抛出人能看懂的原因（而不是空文本）；
 *   3. **形状契约**：`stream()` 必须**同步**返回 AsyncIterable（返回 Promise 会让
 *      `for await` 立刻 TypeError，并留下一个无人接管的 rejection 直接杀进程）。
 *
 * 用一个真实的本机 HTTP 服务充当 OpenAI 兼容端点（不 mock fetch：要验的正是 HTTP 细节）。
 * 跑法：node --experimental-strip-types --test src/app/llm-openai.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createLlmService } from './llm-openai.ts';
import { normalizeAppConfig, type AppConfig } from './local-config.ts';

let server: Server;
let baseUrl = '';

/** 上游行为开关：每个用例自己摆 */
const mode: { kind: 'ok' | 'error' | 'split' } = { kind: 'ok' };
/** 最近一次 /chat/completions 的请求体（断言「关思考」字段是否发出） */
let lastRequestBody: Record<string, unknown> = {};

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-a' }, { id: 'mock-b' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      // 先把请求体收完再回（断言要看请求体，且不能让连接提前断）
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        try {
          lastRequestBody = JSON.parse(raw || '{}') as Record<string, unknown>;
        } catch {
          lastRequestBody = {};
        }
        if (mode.kind === 'error') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunks = [{ choices: [{ delta: { content: '你好' } }] }, { choices: [{ delta: { content: '，世界' } }] }];
        const payload = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
        if (mode.kind === 'split') {
          // 故意在一个 JSON 行中间切开：按块解析会炸，按行缓冲才对
          res.write(payload.slice(0, 20));
          setTimeout(() => {
            res.write(payload.slice(20));
            res.end();
          }, 20);
          return;
        }
        res.end(payload);
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

after(async () => {
  await new Promise<void>((accept) => server.close(() => accept()));
});

/** 造一份指向本机 mock 的配置 */
function configWith(options: { apiKeyRef?: string; models?: string[]; thinking?: 'off' } = {}): AppConfig {
  return normalizeAppConfig({
    provider: 'mock',
    model: 'mock-a',
    endpoints: [
      {
        id: 'mock',
        name: 'Mock',
        baseUrl,
        apiKeyRef: options.apiKeyRef ?? 'MOCK_KEY',
        models: options.models ?? [],
        ...(options.thinking ? { thinking: options.thinking } : {}),
      },
    ],
  });
}

/** 收完一条流 */
async function collect(iterable: AsyncIterable<{ type: 'text'; text: string }>): Promise<string> {
  let text = '';
  for await (const chunk of iterable) text += chunk.text;
  return text;
}

describe('llm.stream', () => {
  test('把 SSE 文本块拼成完整回复', async () => {
    mode.kind = 'ok';
    const llm = createLlmService({ config: () => configWith(), secrets: () => ({ MOCK_KEY: 'k' }) });
    const text = await collect(
      llm.stream({
        provider: 'mock',
        model: 'mock-a',
        system: '你是桌宠',
        messages: [{ role: 'user', content: [{ type: 'text', text: '在吗' }] }],
      }),
    );
    assert.equal(text, '你好，世界');
  });

  test('JSON 行被网络切成两半也能正确解析（按行缓冲）', async () => {
    mode.kind = 'split';
    const llm = createLlmService({ config: () => configWith(), secrets: () => ({ MOCK_KEY: 'k' }) });
    const text = await collect(llm.stream({ provider: 'mock', model: 'mock-a', messages: [] }));
    assert.equal(text, '你好，世界');
    mode.kind = 'ok';
  });

  test('stream() 同步返回 AsyncIterable（不是 Promise）', () => {
    const llm = createLlmService({ config: () => configWith(), secrets: () => ({ MOCK_KEY: 'k' }) });
    const result = llm.stream({ provider: 'mock', model: 'mock-a' });
    assert.equal(typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator], 'function');
  });

  test('缺 API Key → 首次 next() 抛出可操作的原因', async () => {
    const llm = createLlmService({ config: () => configWith(), secrets: () => ({}) });
    await assert.rejects(collect(llm.stream({ provider: 'mock', model: 'mock-a' })), /缺少 API Key：MOCK_KEY/);
  });

  test('未配置的服务商 → 明确报出 id', async () => {
    const llm = createLlmService({ config: () => configWith(), secrets: () => ({ MOCK_KEY: 'k' }) });
    await assert.rejects(collect(llm.stream({ provider: 'ghost', model: 'x' })), /未配置服务商「ghost」/);
  });

  test('上游 4xx → 带上服务端正文，而不是只有状态码', async () => {
    mode.kind = 'error';
    const llm = createLlmService({ config: () => configWith(), secrets: () => ({ MOCK_KEY: 'k' }) });
    await assert.rejects(collect(llm.stream({ provider: 'mock', model: 'mock-a' })), /HTTP 401.*invalid api key/s);
    mode.kind = 'ok';
  });
});

describe('思考模式开关', () => {
  test('端点声明 thinking=off → 请求体带 {thinking:{type:"disabled"}}', async () => {
    mode.kind = 'ok';
    const llm = createLlmService({
      config: () => configWith({ thinking: 'off' }),
      secrets: () => ({ MOCK_KEY: 'k' }),
    });
    await collect(llm.stream({ provider: 'mock', model: 'mock-a', messages: [] }));
    assert.deepEqual(lastRequestBody.thinking, { type: 'disabled' });
  });

  test('未声明的端点不带这个字段（严格实现可能因未知字段 400）', async () => {
    mode.kind = 'ok';
    const llm = createLlmService({ config: () => configWith(), secrets: () => ({ MOCK_KEY: 'k' }) });
    await collect(llm.stream({ provider: 'mock', model: 'mock-a', messages: [] }));
    assert.equal('thinking' in lastRequestBody, false);
  });
});

describe('llm 目录能力', () => {
  test('listProviders 来自配置', () => {
    const llm = createLlmService({ config: () => configWith(), secrets: () => ({ MOCK_KEY: 'k' }) });
    assert.deepEqual(llm.listProviders(), [{ id: 'mock', name: 'Mock' }]);
  });

  test('未配模型清单时向端点 /models 拉取', async () => {
    const llm = createLlmService({ config: () => configWith(), secrets: () => ({ MOCK_KEY: 'k' }) });
    assert.deepEqual(
      (await llm.listModels('mock')).map((m) => m.id),
      ['mock-a', 'mock-b'],
    );
  });

  test('显式配了清单就以配置为准（不访问网络）', async () => {
    const llm = createLlmService({
      config: () => configWith({ models: ['only-one'] }),
      secrets: () => ({ MOCK_KEY: 'k' }),
    });
    assert.deepEqual(
      (await llm.listModels('mock')).map((m) => m.id),
      ['only-one'],
    );
  });

  test('resolveModelInfo 恒报不支持 reasoning effort（于是调用方不传该字段）', async () => {
    const llm = createLlmService({ config: () => configWith(), secrets: () => ({ MOCK_KEY: 'k' }) });
    const info = await llm.resolveModelInfo('mock', 'mock-a');
    assert.deepEqual(info.reasoning.efforts, []);
  });
});
