/**
 * 对话弹窗的**历史窗口**纯逻辑测试（`historyRows`）。
 *
 * 背景：`GET /chat` 一直是"最近记忆窗口"，但桌面端从来没人调用它——对话弹窗只有一个输入框，
 * 于是「记忆轮数」这个设置在界面上没有任何可见出口（用户看不到它记住了什么）。
 * 修法是弹窗打开时把这段窗口拉回来显示，本文件钉住"记忆 → 行"的口径：
 *   ① 只认 user/assistant 且正文非空的条目（手改坏的旧格式不猜、不伪造）；
 *   ② 取**尾部** limit 条（历史窗口 = 刚才聊了什么，不是从头看一遍）；
 *   ③ 超长按**码点**截断（不把 emoji 截成半个）。
 *
 * 跑法：node --experimental-strip-types --test src/shared/chat.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { historyRows } from './chat.ts';

describe('historyRows —— 记忆窗口 → 弹窗历史行', () => {
  test('只保留 user / assistant，且按原顺序（正序）', () => {
    const rows = historyRows([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '主人好呀' },
      { role: 'system', content: '不该出现' },
      { role: 'tool', content: '也不该出现' },
    ]);
    assert.deepEqual(rows, [
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '主人好呀' },
    ]);
  });

  test('取尾部 limit 条（最近的对话优先）', () => {
    const messages = [
      { role: 'user', content: '1' },
      { role: 'assistant', content: '2' },
      { role: 'user', content: '3' },
      { role: 'assistant', content: '4' },
    ];
    assert.deepEqual(
      historyRows(messages, 2).map((r) => r.text),
      ['3', '4'],
    );
  });

  test('脏数据一律丢弃，不猜、不伪造', () => {
    const rows = historyRows([
      null,
      'not-an-object',
      { role: 'user' },
      { role: 'user', content: '   ' },
      { role: 'assistant', content: 42 },
      { content: '没有 role' },
      { role: 'user', content: '  保留我  ' },
    ]);
    assert.deepEqual(rows, [{ role: 'user', text: '保留我' }]);
  });

  test('非数组 / limit<=0 → 空（读不到就不显示历史）', () => {
    assert.deepEqual(historyRows(undefined), []);
    assert.deepEqual(historyRows(null), []);
    assert.deepEqual(historyRows({ messages: [] }), []);
    assert.deepEqual(historyRows([{ role: 'user', content: 'x' }], 0), []);
  });

  test('超长按码点截断（emoji 不会被截成半个）', () => {
    const long = '🐳'.repeat(60);
    const [row] = historyRows([{ role: 'user', content: long }], 1);
    assert.ok(row !== undefined);
    assert.ok(row.text.endsWith('…'));
    // 40 个码点 + 省略号：代理对被整对保留
    assert.equal(Array.from(row.text).length, 41);
    assert.ok(!/[\uD800-\uDBFF]$/.test(row.text.slice(0, -1)), '不得以孤立的代理项结尾');
  });
});

/**
 * 接线守卫：`GET /chat` 必须**有人调**。
 *
 * 它一直是"最近记忆窗口"，但桌面端从来没有任何地方调用它——接口通、文档写着"弹窗打开时
 * 展示"，实际弹窗只有一个输入框。这与第十一轮那个「设置项是摆设」同源：**有实现、没有
 * 消费方**。本守卫钉住"弹窗打开时会去拉历史"，避免下次重构又把唯一消费方摘掉。
 */
describe('GET /chat —— 记忆窗口必须有消费方（弹窗打开时拉一次）', () => {
  const source = readFileSync(fileURLToPath(new URL('./chat.ts', import.meta.url)), 'utf8');

  test('mountChatDialog 调 fetchChatHistory，且历史区插在输入框之前', () => {
    // 签名是多行的（opts 是内联对象类型），所以从函数名切到文件末尾，不按 `\n}` 截断
    const at = source.indexOf('export function mountChatDialog');
    assert.ok(at >= 0, '必须能定位到 mountChatDialog（守卫失效即无意义）');
    const block = source.slice(at);
    assert.ok(/fetchChatHistory\(withPet\)/.test(block), '弹窗必须用同一个 pet 拉历史');
    assert.ok(
      block.indexOf('root.appendChild(history)') < block.indexOf('root.appendChild(input)'),
      '历史区必须在输入框上方（先看到聊过什么，再决定说什么）',
    );
  });

  test('历史是可选装饰：读不到不得抛错挡住输入', () => {
    const block = /export async function fetchChatHistory[\s\S]*?\n\}/.exec(source)?.[0] ?? '';
    assert.ok(block.length > 0, '必须能定位到 fetchChatHistory');
    assert.ok(/catch\s*\{[\s\S]*?return \[\]/.test(block), '读失败一律回空数组，不抛');
  });
});
