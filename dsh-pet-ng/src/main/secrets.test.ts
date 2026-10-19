/**
 * 密钥加密层的单元测试 —— 钉住三条容易出事的行为：
 *   ① 没有加密能力时**不能**给值加前缀（否则旧版本/无密钥环环境读到 `enc:v1:` 会当密文去解，
 *      解不开就变成"密钥丢了"）；
 *   ② 升级前写下的明文必须照常可读（不强制迁移，避免用户升级后突然要重填）；
 *   ③ 解密失败（换机器 / 换账号 / 密钥环重置）返回空串 = 未配置，**不能抛**——
 *      一个坏文件不该让设置页打不开。
 *
 * 跑法：node --experimental-strip-types --test src/main/secrets.test.ts
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { ENC_PREFIX, encryptionAvailable, openSecret, sealSecret, setSecretCodec } from './secrets.ts';

/** 假加密：base64 反转，足够验证"进出成对"且显然不是明文 */
const fakeCodec = {
  available: () => true,
  encrypt: (plain: string) => Buffer.from(plain, 'utf8').reverse().toString('base64'),
  decrypt: (encoded: string) => Buffer.from(encoded, 'base64').reverse().toString('utf8'),
};

/** 无能力实现（模拟 Linux 无密钥环 / 测试环境） */
const plainCodec = { available: () => false, encrypt: (s: string) => s, decrypt: (s: string) => s };

afterEach(() => {
  setSecretCodec(plainCodec);
});

describe('sealSecret / openSecret', () => {
  test('没有加密能力 → 原样落盘，且不带前缀', () => {
    setSecretCodec(plainCodec);
    assert.equal(sealSecret('sk-abc'), 'sk-abc');
    assert.equal(encryptionAvailable(), false);
  });

  test('有加密能力 → 落盘值带 enc:v1: 前缀，且不含明文', () => {
    setSecretCodec(fakeCodec);
    const sealed = sealSecret('sk-abc');
    assert.ok(sealed.startsWith(ENC_PREFIX));
    assert.ok(!sealed.includes('sk-abc'));
    assert.equal(openSecret(sealed), 'sk-abc');
  });

  test('升级前的明文照常可读', () => {
    setSecretCodec(fakeCodec);
    assert.equal(openSecret('sk-legacy'), 'sk-legacy');
  });

  test('解密失败 → 空串（视为未配置），不抛错', () => {
    setSecretCodec({
      available: () => true,
      encrypt: (s) => s,
      decrypt: () => {
        throw new Error('DPAPI: 换了用户');
      },
    });
    assert.equal(openSecret(ENC_PREFIX + 'whatever'), '');
  });

  test('空值不进加密路径', () => {
    setSecretCodec(fakeCodec);
    assert.equal(sealSecret(''), '');
  });
});
