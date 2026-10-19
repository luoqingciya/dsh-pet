/**
 * 版本检查（自动更新的 A 方案：提示 + 打开下载页，不自动替换文件）。
 *
 * 这里只测纯逻辑：版本比较、响应解析、失败口径。真实网络请求由注入的 fetch 顶掉，
 * 因此不需要联网、也不会碰 api.github.com。
 *
 * 跑法：node --experimental-strip-types --test src/main/update-check.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkForUpdate, compareVersions, parseLatestRelease, versionCore } from './update-check.ts';

describe('compareVersions —— 版本比较', () => {
  test('数字段逐段比较（0.10 > 0.9，不是字符串比较）', () => {
    assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
    assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
    assert.equal(compareVersions('0.6.2', '0.6.2'), 0);
    assert.ok(compareVersions('0.6.1', '0.6.2') < 0);
  });

  test('容忍 v 前缀与预发布后缀（预发布视为更旧）', () => {
    assert.equal(compareVersions('v0.6.2', '0.6.2'), 0);
    assert.ok(compareVersions('0.7.0-beta.1', '0.6.9') > 0);
    assert.ok(compareVersions('0.7.0-beta.1', '0.7.0') < 0, '同数字段的预发布比正式版旧');
  });

  test('解析不了的一方按最旧处理（宁可不提示，也不误报）', () => {
    assert.equal(versionCore('latest'), undefined);
    assert.ok(compareVersions('0.6.2', 'latest') > 0);
    assert.ok(compareVersions('latest', '0.6.2') < 0);
    assert.equal(compareVersions('latest', 'nightly'), 0);
  });
});

describe('parseLatestRelease —— 两种响应形状', () => {
  test('GitHub 形状', () => {
    assert.deepEqual(
      parseLatestRelease({
        tag_name: 'v0.7.0',
        html_url: 'https://github.com/luoqingciya/dsh-pet-ng/releases/tag/v0.7.0',
      }),
      { version: '0.7.0', url: 'https://github.com/luoqingciya/dsh-pet-ng/releases/tag/v0.7.0' },
    );
  });

  test('简化形状（自建镜像放一个静态 JSON 即可）', () => {
    assert.deepEqual(parseLatestRelease({ version: '0.7.0', url: 'https://example.com/dl' }), {
      version: '0.7.0',
      url: 'https://example.com/dl',
    });
  });

  test('draft / prerelease / 缺版本号 / 非对象 → undefined', () => {
    assert.equal(parseLatestRelease({ tag_name: 'v0.7.0', draft: true }), undefined);
    assert.equal(parseLatestRelease({ tag_name: 'v0.7.0', prerelease: true }), undefined);
    assert.equal(parseLatestRelease({ tag_name: 'latest' }), undefined);
    assert.equal(parseLatestRelease(null), undefined);
    assert.equal(parseLatestRelease('nope'), undefined);
  });

  test('url 不是 http(s) 时回落到 Release 页（绝不把任意字符串交给 openExternal）', () => {
    const parsed = parseLatestRelease({ tag_name: 'v0.7.0', html_url: 'javascript:alert(1)' });
    assert.ok(parsed?.url.startsWith('https://github.com/'));
  });
});

describe('checkForUpdate —— 结果三态', () => {
  /** 造一个假的 fetch：返回给定 JSON / 状态码 / 抛错 */
  const fakeFetch = (impl: () => Promise<Response>) => (() => impl()) as unknown as typeof fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  test('远端更新 → newer（带下载地址）', async () => {
    const r = await checkForUpdate({
      current: '0.6.2',
      url: 'https://example.com/latest',
      fetchImpl: fakeFetch(async () => json({ tag_name: 'v0.7.0', html_url: 'https://example.com/dl' })),
    });
    assert.deepEqual(r, { kind: 'newer', version: '0.7.0', url: 'https://example.com/dl' });
  });

  test('远端相同或更旧 → latest（不打扰用户）', async () => {
    for (const tag of ['v0.6.2', 'v0.6.1']) {
      const r = await checkForUpdate({
        current: '0.6.2',
        url: 'https://example.com/latest',
        fetchImpl: fakeFetch(async () => json({ tag_name: tag })),
      });
      assert.equal(r.kind, 'latest');
    }
  });

  test('HTTP 错误 / 响应格式不对 / 抛错 → error（自动检查时由调用方静默）', async () => {
    const bad = await checkForUpdate({
      current: '0.6.2',
      url: 'https://example.com/latest',
      fetchImpl: fakeFetch(async () => json({ message: 'rate limited' }, 403)),
    });
    assert.equal(bad.kind, 'error');
    assert.ok(bad.kind === 'error' && bad.message.includes('403'));

    const malformed = await checkForUpdate({
      current: '0.6.2',
      url: 'https://example.com/latest',
      fetchImpl: fakeFetch(async () => json({ hello: 'world' })),
    });
    assert.equal(malformed.kind, 'error');

    const thrown = await checkForUpdate({
      current: '0.6.2',
      url: 'https://example.com/latest',
      fetchImpl: fakeFetch(async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com');
      }),
    });
    assert.equal(thrown.kind, 'error');
    assert.ok(thrown.kind === 'error' && thrown.message.includes('ENOTFOUND'));
  });

  test('请求头带 UA 与 accept（GitHub API 不带 UA 会 403）', async () => {
    let seen: Record<string, string> = {};
    await checkForUpdate({
      current: '0.6.2',
      url: 'https://example.com/latest',
      fetchImpl: ((_url: string, init: RequestInit) => {
        seen = init.headers as Record<string, string>;
        return Promise.resolve(json({ tag_name: 'v0.6.2' }));
      }) as unknown as typeof fetch,
    });
    assert.ok(seen['user-agent']?.includes('dsh-pet-ng'));
    assert.ok(seen.accept?.includes('github'));
  });
});
