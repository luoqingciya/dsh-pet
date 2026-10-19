/**
 * 本地宿主上下文的单元测试 —— 钉住「把 DSH 的三个服务换成什么」这件事本身：
 *   - `credentials.resolve` 读本地密钥表，缺 key 必须返回 undefined（而不是空串——
 *     余额路由靠 `!key` 判定 credential-missing，空串会被当成"配了一个空 key"继续发请求）；
 *   - `agentDefaultModel.currentSelection` 随配置现读（设置页保存后立即生效，不需要重启）；
 *   - `on/emit` 是**真事件总线**：插件的 turn/start、turn/end 靠它驱动工作状态与通知帧，
 *     监听器抛错不能把其它监听器带崩。
 *
 * 跑法：node --experimental-strip-types --test src/main/context.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createAppContext, LOCAL_SESSION_ID, localSession } from './context.ts';
import { normalizeAppConfig } from './local-config.ts';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** 一份最小可用的配置 */
function config() {
  return normalizeAppConfig({
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    balanceProvider: 'commandcode',
    endpoints: [
      {
        id: 'deepseek-official',
        name: 'DeepSeek',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKeyRef: 'DEEPSEEK_API_KEY',
        models: ['deepseek-chat'],
      },
    ],
  });
}

describe('createAppContext', () => {
  test('credentials.resolve：有 key 返回值，没 key 返回 undefined', async () => {
    const app = createAppContext({ port: 0, logger, config, secrets: () => ({ DEEPSEEK_API_KEY: 'sk-1' }) });
    const credentials = app.ctx.credentials as { resolve(ref: unknown): Promise<{ value: string } | undefined> };
    assert.deepEqual(await credentials.resolve('DEEPSEEK_API_KEY'), { value: 'sk-1' });
    assert.equal(await credentials.resolve('OPENCODE_GO_API_KEY'), undefined);
    assert.equal(await credentials.resolve(''), undefined);
  });

  test('agentDefaultModel 现读配置（保存即生效）', () => {
    let provider = 'deepseek-official';
    const app = createAppContext({
      port: 0,
      logger,
      config: () => ({ ...config(), provider }),
      secrets: () => ({}),
    });
    const model = app.ctx.agentDefaultModel as { currentSelection(): { provider: string; model: string } };
    assert.equal(model.currentSelection().provider, 'deepseek-official');
    provider = 'ollama';
    assert.equal(model.currentSelection().provider, 'ollama');
  });

  test('petBalanceProvider 透出余额服务商（与对话服务商解耦）', () => {
    const app = createAppContext({ port: 0, logger, config, secrets: () => ({}) });
    const read = app.ctx.petBalanceProvider as () => string;
    assert.equal(read(), 'commandcode');
  });

  test('emit 投递会话事件；单个监听器抛错不影响其它监听器', () => {
    const app = createAppContext({ port: 0, logger, config, secrets: () => ({}) });
    const received: string[] = [];
    (app.ctx.on as (name: string, fn: (...args: unknown[]) => void) => () => void)('session/event', () => {
      throw new Error('boom');
    });
    (app.ctx.on as (name: string, fn: (...args: unknown[]) => void) => () => void)('session/event', (...args) => {
      const event = args[1] as { type: string };
      received.push(event.type);
    });
    app.emit('session/event', localSession(), { type: 'turn/start' });
    app.emit('session/event', localSession(), { type: 'turn/end' });
    assert.deepEqual(received, ['turn/start', 'turn/end']);
  });

  test('注销后不再收到事件', () => {
    const app = createAppContext({ port: 0, logger, config, secrets: () => ({}) });
    let count = 0;
    const off = (app.ctx.on as (name: string, fn: () => void) => () => void)('x', () => {
      count += 1;
    });
    app.emit('x');
    off();
    app.emit('x');
    assert.equal(count, 1);
  });

  test('effect 抛错被隔离：记录到 failures，不让初始化整体失败', () => {
    const app = createAppContext({ port: 0, logger, config, secrets: () => ({}) });
    const effect = app.ctx.effect as (fn: () => unknown) => unknown;
    effect(() => {
      throw new Error('bad effect');
    });
    assert.equal(app.failures.length, 1);
    assert.match(app.failures[0]!, /bad effect/);
  });

  test('dispose 逆序释放全部 effect', async () => {
    const app = createAppContext({ port: 0, logger, config, secrets: () => ({}) });
    const order: string[] = [];
    const effect = app.ctx.effect as (fn: () => unknown) => unknown;
    effect(() => () => order.push('first'));
    effect(() => () => order.push('second'));
    await app.dispose();
    assert.deepEqual(order, ['second', 'first']);
  });

  test('会话 id 固定（工作状态/通知按会话聚合）', () => {
    assert.equal(localSession().header.id, LOCAL_SESSION_ID);
  });
});
