/**
 * `/shutdown` 的接线守卫。
 *
 * 背景：`API.md` 把它写成「优雅停机：释放定时器与桌面窗口后关闭服务（脚本化停机用）」，
 * `server.ts` 也确实实现了 `/shutdown` → `onShutdown?.()`。但应用主进程**从来没把
 * onShutdown 传进去**——于是这个接口照常回 `{ok:true, stopping:true}`，应用一动不动：
 * 端口还在、宠物还在、`/health` 还能通。脚本以为关掉了，其实是空转。
 *
 * 这与第十一轮那个「设置项是摆设」是同一类问题：**有实现、有文档、有返回码，就是没有效果**。
 * 本文件只钉接线（真实停机要拉起 Electron，属于 `npm run test:ui` 的范畴）。
 *
 * 跑法：node --experimental-strip-types --test src/app/shutdown.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const appMain = readSource('./main.ts');
const server = readSource('./server.ts');

describe('/shutdown —— 文档承诺的「优雅停机」必须真的停', () => {
  test('服务端把 /shutdown 收口到 onShutdown 回调', () => {
    assert.ok(/pathname === '\/shutdown'/.test(server), 'server.ts 必须实现 /shutdown');
    assert.ok(/onShutdown\?\.\(\)/.test(server), '/shutdown 必须调用 onShutdown（否则只是个 200）');
  });

  test('主进程必须把 onShutdown 接上（不接 = 空转）', () => {
    assert.ok(
      /onShutdown:\s*\(\)\s*=>\s*\{/.test(appMain),
      'main.ts 必须给 listenAppServer 传 onShutdown：不传时 /shutdown 回 200 但应用不停',
    );
    assert.ok(/app\.quit\(\)/.test(appMain), 'onShutdown 必须真的触发退出');
  });

  test('退出走 before-quit 的收尾路径（释放宿主 effect + 关服务）', () => {
    assert.ok(/before-quit/.test(appMain), 'before-quit 里的 dispose/close 是优雅停机的实现');
    assert.ok(/context\?\.dispose\(\)/.test(appMain), '退出前必须释放宿主 effect（销毁桌面窗口、清定时器）');
    assert.ok(/server\?\.close\(\)/.test(appMain), '退出前必须关掉本地服务');
  });

  test('不得把 quitting 提前置位（那会跳过上面那条收尾路径）', () => {
    const block = /onShutdown:\s*\(\)\s*=>\s*\{[\s\S]*?\n {4}\}/.exec(appMain)?.[0] ?? '';
    assert.ok(block.length > 0, '必须能定位到 onShutdown 回调（守卫失效即无意义）');
    assert.ok(!/quitting\s*=/.test(block), 'onShutdown 里不得设 quitting：before-quit 见到它就 return，收尾被跳过');
  });
});
