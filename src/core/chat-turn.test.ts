/**
 * 「对话状态联动」的接线守卫。
 *
 * 背景（0.5.0 的回归）：`/chat` 有**两条**入口——HTTP 与桌面窗口的 `dsh-pet-ng-bridge://` scheme。
 * turn/start、turn/end 曾经由应用包在 HTTP 路由外面，于是桌面宠物自己发起的对话
 * （用户点宠物聊天的那条路）完全不产生 turn 事件：设置里的「对话状态联动」看起来还在，
 * 实际永远不切动画，也永远不弹「对话完成」通知。
 *
 * 修法是把这一步收口到 `handlePetRoute` 外面（两条入口共用），因此本文件钉住：
 *   ① 两条入口都必须走 `handlePetRouteWithTurn`（少一条就退化回"只有脚本聊天才有反应"）；
 *   ② 只有 `POST /chat` 产生 turn 事件（碎碎念/余额/配置写入不该触发状态动画）；
 *   ③ 宿主声明的会话 id 与应用侧 `LOCAL_SESSION_ID` 一致（不一致 → 工作状态按两个会话聚合）。
 *
 * 端到端行为由 `scripts/tests/desktop-window.test.mjs` 覆盖（真实窗口里发一次对话，读 /state）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 包内文件源码（守卫用；相对 src/core/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const host = readSource('./index.ts');
const appMain = readSource('../main/index.ts');
const context = readSource('../main/context.ts');

describe('对话状态联动 —— turn 事件必须覆盖两条入口', () => {
  test('桌面窗口（bridge）路径用 handlePetRouteWithTurn', () => {
    assert.ok(
      /const result = await handlePetRouteWithTurn\(req\.url, req\.method, req\.body\)/.test(host),
      'desktopRequest 必须走带 turn 的版本：否则用户点宠物聊天时状态联动与通知全静默',
    );
  });

  test('HTTP 路径同样用 handlePetRouteWithTurn', () => {
    assert.ok(
      /const result = await handlePetRouteWithTurn\(req\.url \?\? '\/', req\.method \?\? 'GET', body\)/.test(host),
      'HTTP 路由必须走同一份实现（两条入口不能各写一套）',
    );
  });

  test('只有 POST /chat 触发 turn 事件', () => {
    const block = /const handlePetRouteWithTurn = async[\s\S]*?\n {2}\};/.exec(host)?.[0] ?? '';
    assert.ok(block.length > 0, '必须能定位到 handlePetRouteWithTurn（守卫失效即无意义）');
    assert.ok(/method !== 'POST'/.test(block), '非 POST 不发 turn（GET /chat 是读历史）');
    assert.ok(/\$\{ROUTE_PREFIX\}\/chat/.test(block), '只认 /chat 前缀');
    assert.ok(/emitTurn\('turn\/start'\)/.test(block) && /emitTurn\('turn\/end'/.test(block), '起止都要发');
  });

  test('应用侧不再自己包路由（否则 HTTP 路径会发两遍）', () => {
    assert.ok(!/wrapChatRoute/.test(appMain), 'main.ts 不得再有 wrapChatRoute（已收口到宿主）');
    assert.ok(!/emitTurnStart|emitTurnEnd/.test(appMain), 'main.ts 不得再合成 turn 事件');
  });
});

describe('会话 id 单一来源', () => {
  test('宿主的 CHAT_SESSION 与应用侧 LOCAL_SESSION_ID 一致', () => {
    const appId = /export const LOCAL_SESSION_ID = '([^']+)'/.exec(context)?.[1];
    const hostId = /const CHAT_SESSION = \{ header: \{ id: '([^']+)' \} \}/.exec(host)?.[1];
    assert.ok(appId, 'context.ts 里必须能读到 LOCAL_SESSION_ID');
    assert.ok(hostId, 'host 里必须能读到 CHAT_SESSION');
    assert.equal(hostId, appId, '两处 id 不一致 → 工作状态会按两个会话各记一份，展示错乱');
  });

  test('宿主通过 ctx.emit 把事件投回总线（应用侧必须提供 emit）', () => {
    assert.ok(/ctx\.emit\?\.\(/.test(host), '宿主必须用 ctx.emit 投递合成事件');
    assert.ok(/^ {4}emit,$/m.test(context), 'context 的 ctx 对象必须暴露 emit');
  });
});
