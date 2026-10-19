/**
 * 本地服务的安全边界：跨站请求必须被拒。
 *
 * 背景（0.9.1 修的真实漏洞）：服务原先对所有响应发 `access-control-allow-origin: *` 并放行
 * OPTIONS 预检，于是**任意网页**都能跨域 `POST /app/api/config` 改写 `endpoints[].baseUrl`，
 * 再触发一次生成——用户的 API Key 会随 `Authorization: Bearer` 发到攻击者地址。
 *
 * 这里钉住四件事：不再发 CORS 头、跨站 Origin 403、非回环 Host 403（DNS rebinding）、
 * 无 Origin 的本机脚本照常放行。
 *
 * 跑法：node --experimental-strip-types --test src/main/server.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createRequestListener, crossSiteReason } from './server.ts';

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** 假请求（只带监听器会用到的字段） */
function fakeReq(options: { method?: string; url?: string; headers?: Record<string, string> }): IncomingMessage {
  return {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: options.headers ?? {},
  } as unknown as IncomingMessage;
}

/** 假响应：记录状态、头与 body */
function fakeRes(): { res: ServerResponse; state: { status: number; headers: Record<string, string>; body: string } } {
  const state = { status: 0, headers: {} as Record<string, string>, body: '' };
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status;
      if (headers) Object.assign(state.headers, headers);
      res.headersSent = true;
      return res;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) state.body += String(chunk);
    },
    destroy() {},
  };
  return { res: res as unknown as ServerResponse, state };
}

/** 走一遍监听器（不起 socket）；extra 是异步的，等一拍再看结果 */
async function dispatch(
  req: IncomingMessage,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const { res, state } = fakeRes();
  const listener = createRequestListener({
    routes: [],
    logger: quietLogger,
    status: () => ({ name: 'dsh-petNG' }),
    extra: async () => false,
  });
  listener(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  return state;
}

describe('crossSiteReason —— 放行与拒绝的边界', () => {
  test('没有 Origin：本机脚本照常放行', () => {
    assert.equal(crossSiteReason({ method: 'POST', headers: { host: '127.0.0.1:7340' } }), undefined);
  });

  test('同源（Origin 与 Host 一致）：放行', () => {
    assert.equal(
      crossSiteReason({
        method: 'POST',
        headers: { host: '127.0.0.1:7340', origin: 'http://127.0.0.1:7340' },
      }),
      undefined,
    );
    // 端口顺延后仍然成立（两边都取自同一个请求）
    assert.equal(
      crossSiteReason({ method: 'POST', headers: { host: '127.0.0.1:7341', origin: 'http://127.0.0.1:7341' } }),
      undefined,
    );
    assert.equal(
      crossSiteReason({ method: 'POST', headers: { host: 'localhost:7340', origin: 'http://localhost:7340' } }),
      undefined,
    );
  });

  test('跨站 Origin：拒绝（写操作尤其）', () => {
    const reason = crossSiteReason({
      method: 'POST',
      headers: { host: '127.0.0.1:7340', origin: 'https://evil.example' },
    });
    assert.match(String(reason), /跨站/);
    // 另一个本机端口的页面也算跨站
    assert.match(
      String(crossSiteReason({ method: 'POST', headers: { host: '127.0.0.1:7340', origin: 'http://127.0.0.1:3000' } })),
      /跨站/,
    );
  });

  test('Origin: null（file:// 页面）只放行只读方法', () => {
    assert.equal(crossSiteReason({ method: 'GET', headers: { host: '127.0.0.1:7340', origin: 'null' } }), undefined);
    assert.match(
      String(crossSiteReason({ method: 'POST', headers: { host: '127.0.0.1:7340', origin: 'null' } })),
      /跨站/,
    );
  });

  test('非回环 Host：拒绝（DNS rebinding）', () => {
    assert.match(String(crossSiteReason({ method: 'GET', headers: { host: 'evil.example:7340' } })), /只接受本机访问/);
    assert.match(String(crossSiteReason({ method: 'GET', headers: {} })), /Host/);
  });
});

describe('监听器 —— 真实响应上的表现', () => {
  test('OPTIONS 预检不再回 CORS 头（跨域请求因此发不出去）', async () => {
    const out = await dispatch(
      fakeReq({ method: 'OPTIONS', url: '/app/api/config', headers: { host: '127.0.0.1:7340' } }),
    );
    assert.equal(out.status, 204);
    assert.equal(out.headers['access-control-allow-origin'], undefined, '不得再发 ACAO');
  });

  test('跨站 POST 直接 403，且不回 CORS 头', async () => {
    const out = await dispatch(
      fakeReq({
        method: 'POST',
        url: '/app/api/config',
        headers: { host: '127.0.0.1:7340', origin: 'https://evil.example', 'content-type': 'application/json' },
      }),
    );
    assert.equal(out.status, 403);
    assert.match(out.body, /跨站/);
    assert.equal(out.headers['access-control-allow-origin'], undefined);
  });

  test('同源 / 无 Origin 的正常请求不受影响', async () => {
    assert.equal((await dispatch(fakeReq({ url: '/health', headers: { host: '127.0.0.1:7340' } }))).status, 200);
    assert.equal(
      (
        await dispatch(
          fakeReq({ url: '/health', headers: { host: '127.0.0.1:7340', origin: 'http://127.0.0.1:7340' } }),
        )
      ).status,
      200,
    );
  });
});
