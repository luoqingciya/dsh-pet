/**
 * 生成侧的「模型回落」测试 —— 钉住 A 方案的实际行为（issue #75）：
 * 条目配置的 whisperModel / chatModel 优先；它调用失败（凭据被删 / 模型下架 / 该服务商没配 key）
 * 时**回落到当前对话的模型重试一次**；仍失败才把**最后一次**（当前对话模型）的失败原因抛出去。
 *
 * 用假 ctx.llm.stream 驱动（不碰真服务商、不联网）：按 provider 决定这次是抛错、返回空流还是正常文本，
 * 并记录每次调用的 provider/model——回落的顺序与次数就是本文件要钉的不变式。
 *
 * 另外钉住调用形状：每次调用都带调用身份 sessionId；「没拿到正文」时报流终止块里的真实原因。
 *
 * 跑法：node --experimental-strip-types --test src/host/model-fallback.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { generateWhisper } from './whisper.ts';
import { generateChat } from './chat.ts';
import { PET_CALL_IDENTITY } from './llm-call.ts';
import type { ModelRef } from './model-selection.ts';

/** 一次调用的行为：ok = 正常出文本；throw = 流里抛错；empty = 空流且无终止块；fail = 流以 error 终止且无正文 */
type Behavior = 'ok' | 'throw' | 'empty' | 'fail';

const CONFIGURED: ModelRef = { provider: 'configured', model: 'cheap-model' };
const CURRENT: ModelRef = { provider: 'current', model: 'main-model' };

/** 造一个假 ctx：currentSelection 返回 current（'throw' = 抛错），llm.stream 按 provider 决定行为 */
function fakeCtx(current: ModelRef | 'throw', behavior: Record<string, Behavior>) {
  const calls: ModelRef[] = [];
  /** 每次调用的完整参数（含 sessionId） */
  const options: Record<string, unknown>[] = [];
  const ctx = {
    agentDefaultModel: {
      currentSelection: (): ModelRef => {
        if (current === 'throw') throw new Error('当前对话未配置模型');
        return current;
      },
    },
    llm: {
      // 声明"无 reasoning 元数据"：supportsReasoningOff 返回 false，不附加 reasoningEffort
      resolveModelInfo: async () => ({}),
      stream: (o: ModelRef) => {
        calls.push({ provider: o.provider, model: o.model });
        options.push(o as unknown as Record<string, unknown>);
        const b = behavior[o.provider] ?? 'throw';
        return (async function* () {
          if (b === 'throw') throw new Error(o.provider + ' 不可用');
          if (b === 'empty') return;
          if (b === 'fail') {
            yield {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: { message: o.provider + ' 400：缺少必需的路由头', code: 'HTTP_400' },
              },
            };
            return;
          }
          yield { type: 'text-delta', index: 0, text: '你好呀' };
        })();
      },
    },
  };
  return { ctx, calls, options };
}

describe('generateWhisper —— 配置模型优先、失败回落当前对话', () => {
  test('配置的模型可用 → 只调它一次，不碰当前对话的模型', async () => {
    const { ctx, calls } = fakeCtx(CURRENT, { configured: 'ok', current: 'ok' });
    const r = await generateWhisper(ctx, '人设', undefined, CONFIGURED);
    assert.deepEqual(r, { ok: true, text: '你好呀' });
    assert.deepEqual(calls, [CONFIGURED], '配置可用时不得再调当前对话的模型');
  });

  test('配置的模型抛错 → 回落到当前对话的模型重试一次', async () => {
    const { ctx, calls } = fakeCtx(CURRENT, { configured: 'throw', current: 'ok' });
    const r = await generateWhisper(ctx, '人设', undefined, CONFIGURED);
    assert.deepEqual(r, { ok: true, text: '你好呀' }, '回落成功应返回正常文本');
    assert.deepEqual(calls, [CONFIGURED, CURRENT], '顺序必须是「配置的 → 当前对话的」');
  });

  test('配置的模型返回空流（模型未返回文本）→ 同样回落', async () => {
    const { ctx, calls } = fakeCtx(CURRENT, { configured: 'empty', current: 'ok' });
    const r = await generateWhisper(ctx, '人设', undefined, CONFIGURED);
    assert.deepEqual(r, { ok: true, text: '你好呀' });
    assert.deepEqual(calls, [CONFIGURED, CURRENT]);
  });

  test('两个都失败 → 返回最后一次（当前对话模型）的失败原因', async () => {
    const { ctx, calls } = fakeCtx(CURRENT, { configured: 'throw', current: 'throw' });
    const r = await generateWhisper(ctx, '人设', undefined, CONFIGURED);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'generate-error');
    assert.equal(r.ok === false && r.message, 'current 不可用', '报错应来自当前对话的模型（用户真正在用的那个）');
    assert.deepEqual(calls, [CONFIGURED, CURRENT]);
  });

  test('没配模型（留空）→ 只调当前对话的模型一次（旧行为逐字不变）', async () => {
    const { ctx, calls } = fakeCtx(CURRENT, { current: 'ok' });
    const r = await generateWhisper(ctx, '人设', undefined, undefined);
    assert.deepEqual(r, { ok: true, text: '你好呀' });
    assert.deepEqual(calls, [CURRENT]);
  });

  test('两边都拿不到模型 → provider-missing，且一次都不调用 LLM', async () => {
    const { ctx, calls } = fakeCtx('throw', {});
    const r = await generateWhisper(ctx, '人设', undefined, undefined);
    assert.deepEqual(r, { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' });
    assert.deepEqual(calls, []);
  });

  test('配置的模型与当前对话相同 → 去重，失败时只试一次', async () => {
    const { ctx, calls } = fakeCtx(CONFIGURED, { configured: 'throw' });
    const r = await generateWhisper(ctx, '人设', undefined, CONFIGURED);
    assert.equal(r.ok, false);
    assert.deepEqual(calls, [CONFIGURED], '同一个模型不得试两遍（白等一个超时）');
  });
});

describe('generateChat —— 同一套回落规则（chatModel）', () => {
  test('配置的模型抛错 → 回落到当前对话的模型', async () => {
    const { ctx, calls } = fakeCtx(CURRENT, { configured: 'throw', current: 'ok' });
    const r = await generateChat(ctx, '人设', [], '在吗', [], CONFIGURED);
    assert.deepEqual(r, { ok: true, text: '你好呀' });
    assert.deepEqual(calls, [CONFIGURED, CURRENT]);
  });

  test('留空 → 只用当前对话的模型（旧行为）', async () => {
    const { ctx, calls } = fakeCtx(CURRENT, { current: 'ok' });
    const r = await generateChat(ctx, '人设', [], '在吗', [], undefined);
    assert.deepEqual(r, { ok: true, text: '你好呀' });
    assert.deepEqual(calls, [CURRENT]);
  });

  test('两边都拿不到模型 → provider-missing，且一次都不调用 LLM', async () => {
    const { ctx, calls } = fakeCtx('throw', {});
    const r = await generateChat(ctx, '人设', [], '在吗', [], undefined);
    assert.deepEqual(r, { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' });
    assert.deepEqual(calls, []);
  });
});

describe('调用形状 —— 调用身份与真实失败原因', () => {
  test('对话调用带调用身份 sessionId', async () => {
    const { ctx, options } = fakeCtx(CURRENT, { current: 'ok' });
    await generateChat(ctx, '人设', [], '在吗', [], undefined);
    assert.equal(options.length, 1);
    assert.equal(options[0].sessionId, PET_CALL_IDENTITY);
  });

  test('碎碎念调用带同一身份，回落两次也不换值', async () => {
    const { ctx, options } = fakeCtx(CURRENT, { configured: 'empty', current: 'ok' });
    await generateWhisper(ctx, '人设', undefined, CONFIGURED);
    assert.deepEqual(
      options.map((o) => o.sessionId),
      [PET_CALL_IDENTITY, PET_CALL_IDENTITY],
      '回落两次也必须用同一个身份',
    );
  });

  test('流以 error 终止且无正文 → 报终止块里的真实原因', async () => {
    const { ctx } = fakeCtx(CURRENT, { current: 'fail' });
    const r = await generateChat(ctx, '人设', [], '在吗', [], undefined);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.message, 'current 400：缺少必需的路由头');
  });

  test('空流且无终止块 → 仍是"模型未返回文本"（旧行为逐字不变）', async () => {
    const { ctx } = fakeCtx(CURRENT, { configured: 'empty', current: 'empty' });
    const r = await generateChat(ctx, '人设', [], '在吗', [], CONFIGURED);
    assert.equal(r.ok === false && r.message, '模型未返回文本');
  });
});

/**
 * 请求形状 —— **时间背景不得进 system**（prompt cache 前缀）。
 *
 * 现场：填好 Key 之后碎碎念几乎拿不到上下文缓存。根因是我们自己：时间背景精确到分钟，
 * 从前拼在 system 末尾，而 prompt cache 靠"前缀逐字相同"命中——每次请求都在同一位置断掉。
 * 碎碎念只能命中第一个 64 token 块；对话更惨，记忆历史排在 system 之后，整段历史都要重算。
 *
 * 修法：system 只留人设（逐字稳定），时间拼到最后一条 user 消息上。这里从**请求参数**这一层
 * 钉住分工，避免以后又有人图省事把时间塞回 system。
 */
describe('请求形状 —— 时间背景只进 user 消息（缓存前缀必须稳定）', () => {
  /** 取出 options 里的 system 与「最后一条 user 消息的正文」 */
  const shapeOf = (o: Record<string, unknown>): { system: string; user: string; all: string[] } => {
    const messages = (o.messages ?? []) as Array<{ content?: Array<{ text?: string }> }>;
    const texts = messages.map((m) => String(m.content?.[0]?.text ?? ''));
    return { system: String(o.system ?? ''), user: texts[texts.length - 1] ?? '', all: texts };
  };

  test('碎碎念：system 原样透传，时间在 user 指令里', async () => {
    const { ctx, options } = fakeCtx(CURRENT, { current: 'ok' });
    const system = '你是一只桌面小女仆。\n你的名字是“小女仆”。';
    await generateWhisper(ctx, system, undefined, undefined, new Date(2026, 9, 18, 14, 31));
    const s = shapeOf(options[0]!);
    assert.equal(s.system, system, 'system 必须逐字原样（它就是缓存前缀）');
    assert.ok(!s.system.includes('【当下】'), 'system 不得含时间行');
    assert.ok(s.user.startsWith('【当下】'), '时间背景必须在 user 消息里（且在指令之前）');
    assert.ok(s.user.includes('随便说一句日常碎碎念'), '原指令不能被时间行顶掉');
  });

  test('对话：历史原样，只有最后一条 user 带时间', async () => {
    const { ctx, options } = fakeCtx(CURRENT, { current: 'ok' });
    const history = [
      { role: 'user' as const, content: '你好', ts: 1 },
      { role: 'assistant' as const, content: '主人好呀', ts: 2 },
    ];
    await generateChat(ctx, '人设', history, '【当下】…\n今天吃什么', [], undefined);
    const s = shapeOf(options[0]!);
    assert.equal(s.system, '人设', 'system 不得被追加任何内容');
    assert.deepEqual(s.all.slice(0, 2), ['你好', '主人好呀'], '历史必须原样（它们是可缓存的前缀）');
    assert.ok(s.user.endsWith('今天吃什么'));
  });
});
