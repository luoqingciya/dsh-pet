/**
 * 提示词拼装的**缓存前缀**约束。
 *
 * 背景（用户实测）：填好 API Key 之后，碎碎念几乎拿不到上下文缓存。根因不在服务商，而在我们
 * 自己——时间背景（精确到**分钟**）曾经拼在 system 末尾：
 *
 *   system = 人设 + 名字声明 + `【当下】现在是…14:31…`
 *
 * prompt cache 命中靠**前缀逐字相同**。时间行一变，缓存就从那一行开始失效：
 *   - 碎碎念：system 只有一百来个 token，断点落在第一个 64 token 块之后 → 最多命中一块；
 *   - 对话：记忆历史排在 system **后面** → 前缀一断，整段历史全部按新输入计费。
 * 所以「缓存支持了、实际几乎用不上」。
 *
 * 本文件钉住修好后的分工：
 *   ① `petSystemPrompt` 逐字稳定（跨分钟、跨请求都一样）且**不含**任何时间内容；
 *   ② 时间背景只出现在最后一条 user 消息里（`withTimeContext`），且原文一个字符都不少。
 *
 * 跑法：node --experimental-strip-types --test src/core/prompt.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { petSystemPrompt, withTimeContext } from './prompt.ts';

/** 最小可用的成品聚合：一个 main 条目 + 一个文件宠物条目 */
const cfg = (): Record<string, Record<string, unknown>> => ({
  main: {
    whisperPrompt: '你是一只桌面小女仆。',
    pets: [{ id: 'main', name: '小女仆' }],
  },
  pig: {
    whisperPrompt: '你是一只桌面小猪。',
    pets: [{ id: 'pig1', name: '小猪' }],
  },
});

describe('petSystemPrompt —— 必须是稳定的缓存前缀', () => {
  test('人设 + 名字声明，逐字稳定', () => {
    assert.equal(petSystemPrompt('main', cfg()), '你是一只桌面小女仆。\n你的名字是“小女仆”。');
  });

  test('时间不进 system：任何时刻、任何一天都逐字相同', () => {
    const a = petSystemPrompt('main', cfg());
    const b = petSystemPrompt('main', cfg());
    assert.equal(a, b, '同一份配置必须得到同一个字符串');
    assert.ok(!a.includes('【当下】'), 'system 不得含时间行（那是每请求都变的内容）');
    assert.ok(!/\d{1,2}:\d{2}/.test(a), 'system 不得含时分（精确到分钟的内容会打断缓存前缀）');
    assert.ok(!/星期[一二三四五六日]/.test(a), 'system 不得含星期');
  });

  test('文件宠物取自己的条目；未知名回落 main 的人设、名字按传入 id', () => {
    assert.equal(petSystemPrompt('pig1', cfg()), '你是一只桌面小猪。\n你的名字是“小猪”。');
    assert.equal(
      petSystemPrompt('不存在的id', cfg()),
      '你是一只桌面小女仆。\n你的名字是“不存在的id”。',
      '找不到实例时用 main 的人设，但名字仍按调用方给的 id 声明（不冒用别人的名字）',
    );
  });

  test('名字缺失按 id；没有 whisperPrompt 时只剩名字声明', () => {
    const bare: Record<string, Record<string, unknown>> = { main: { pets: [{ id: 'main' }] } };
    assert.equal(petSystemPrompt('main', bare), '你的名字是“main”。');
  });
});

describe('withTimeContext —— 时间只拼在 user 消息上', () => {
  test('时间行在前、原文在后，原文一个字符都不少', () => {
    const text = '随便说一句日常碎碎念。';
    const out = withTimeContext(text, new Date(2026, 9, 18, 14, 31));
    assert.ok(out.startsWith('【当下】现在是2026年10月18日星期日 14:31'), out.slice(0, 40));
    assert.ok(out.endsWith(text), '用户/指令文本必须留在末尾（模型对末尾指令更敏感）');
    assert.ok(out.includes('下午'), '时段文案要跟着时间走');
  });

  test('同一分钟内两次调用结果相同（缓存只被"跨分钟"打断）', () => {
    const t = '在吗';
    assert.equal(
      withTimeContext(t, new Date(2026, 9, 18, 14, 31, 5)),
      withTimeContext(t, new Date(2026, 9, 18, 14, 31, 58)),
    );
  });

  test('非法 Date → 原样返回（绝不把 NaN 年/月塞进提示词，也不留空行）', () => {
    assert.equal(withTimeContext('在吗', new Date('nope')), '在吗');
  });
});
