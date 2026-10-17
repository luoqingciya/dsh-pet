/**
 * 本地应用配置的单元测试 —— 钉住三件容易悄悄坏掉的事：
 *   1. **非法输入不抛**：配置是用户能手改的文件，改坏了必须回落默认，而不是让应用打不开；
 *   2. **端点表不能空**：端点被删光时回落内置清单（否则用户连设置页都救不回来）；
 *   3. **密钥只报"有没有配"**：`configView` 一旦回传明文，就是一次静默泄露。
 *
 * 用临时目录隔离真实数据目录（`paths.ts` 的目录全部由 `DSH_HOME` 推导）。
 * 跑法：node --experimental-strip-types --test src/app/local-config.test.ts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  BALANCE_PROVIDERS,
  configView,
  DEFAULT_APP_CONFIG,
  endpointOf,
  keyOfEndpoint,
  normalizeAppConfig,
  readAppConfig,
  readSecrets,
  saveAppConfig,
  saveSecrets,
} from './local-config.ts';

const ORIGINAL_HOME = process.env.DSH_HOME;
let home = '';

before(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-pet-app-cfg-'));
  process.env.DSH_HOME = home;
});

after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = ORIGINAL_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('normalizeAppConfig', () => {
  test('空输入 → 默认服务商与默认模型', () => {
    const config = normalizeAppConfig(undefined);
    assert.equal(config.provider, DEFAULT_APP_CONFIG.provider);
    assert.equal(config.model, DEFAULT_APP_CONFIG.model);
    assert.equal(config.endpoints.length, DEFAULT_APP_CONFIG.endpoints.length);
  });

  test('provider 不在端点表里 → 回落到第一个端点（不留一个指向空气的服务商）', () => {
    const config = normalizeAppConfig({
      provider: 'not-exist',
      endpoints: [{ id: 'only', name: 'Only', baseUrl: 'http://x/v1', apiKeyRef: '', models: [] }],
    });
    assert.equal(config.provider, 'only');
  });

  test('端点被删光 → 回落内置清单（保留可用下限）', () => {
    const config = normalizeAppConfig({ endpoints: [] });
    assert.deepEqual(
      config.endpoints.map((e) => e.id),
      DEFAULT_APP_CONFIG.endpoints.map((e) => e.id),
    );
  });

  test('重复 id 只留第一个；非法项直接丢弃', () => {
    const config = normalizeAppConfig({
      endpoints: [
        { id: 'a', name: 'A', baseUrl: 'http://a/v1', apiKeyRef: '', models: ['m1', 'm1', '  ', 'm2'] },
        { id: 'a', name: '重复', baseUrl: 'http://b/v1', apiKeyRef: '', models: [] },
        null,
        'nope',
      ],
    });
    assert.equal(config.endpoints.length, 1);
    assert.deepEqual(config.endpoints[0]!.models, ['m1', 'm2']);
  });

  test('notify 非布尔值回落默认（true）', () => {
    const config = normalizeAppConfig({ notify: { chatReply: 'yes', balanceAlert: 0 } });
    assert.equal(config.notify.chatReply, true);
    assert.equal(config.notify.balanceAlert, true);
  });
});

describe('配置文件读写', () => {
  test('没有文件时读到默认配置（含默认模型）', () => {
    const config = readAppConfig();
    assert.equal(config.provider, 'deepseek-official');
    assert.equal(config.model, 'deepseek-chat');
  });

  test('保存后能原样读回，且白名单外的字段不落盘', () => {
    saveAppConfig({
      provider: 'deepseek-official',
      model: 'deepseek-reasoner',
      balanceProvider: 'commandcode',
      evil: 'should-not-persist',
    });
    const config = readAppConfig();
    assert.equal(config.model, 'deepseek-reasoner');
    assert.equal(config.balanceProvider, 'commandcode');
    assert.equal('evil' in config, false);
  });
});

describe('密钥', () => {
  test('保存 / 读取 / 删除（null 表示删）', () => {
    saveSecrets({ DEEPSEEK_API_KEY: 'sk-a', CUSTOM_API_KEY: 'sk-b' });
    assert.equal(readSecrets().DEEPSEEK_API_KEY, 'sk-a');
    saveSecrets({ DEEPSEEK_API_KEY: null });
    assert.equal(readSecrets().DEEPSEEK_API_KEY, undefined);
    assert.equal(readSecrets().CUSTOM_API_KEY, 'sk-b');
  });

  test('空字符串不落盘（空 = 没配）', () => {
    saveSecrets({ OPENCODE_GO_API_KEY: '' });
    assert.equal(readSecrets().OPENCODE_GO_API_KEY, undefined);
  });

  test('configView 只报是否已配置，绝不回传明文', () => {
    saveSecrets({ DEEPSEEK_API_KEY: 'sk-secret-value' });
    const view = configView();
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes('sk-secret-value'), false);
    assert.equal(view.keys.DEEPSEEK_API_KEY, true);
    // 余额服务商要求的 key 也要出现在视图里（设置页据此渲染输入框）
    for (const provider of BALANCE_PROVIDERS) assert.equal(typeof view.keys[provider.keyRef], 'boolean');
  });

  test('keyOfEndpoint：不需要密钥的端点返回空串', () => {
    const config = normalizeAppConfig({ endpoints: [{ id: 'ollama', baseUrl: 'http://x/v1', apiKeyRef: '' }] });
    assert.equal(keyOfEndpoint(endpointOf(config, 'ollama')), '');
  });
});
