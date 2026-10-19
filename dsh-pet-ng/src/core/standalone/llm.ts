/**
 * 宿主半边用到的 **LLM 消息原语**（本包自己的实现，不依赖任何外部框架）。
 *
 * 这套原语原先来自 DSH 的 `@deepseek-ai/dsh-llm`（宿主半边是从插件时代沿用下来的）。
 * 项目脱离 DSH 之后，源码不再 import 那个包，改为这里的一份最小实现——只有
 * `whisper.ts` / `chat.ts` 真正用到的四个名字：两个消息工厂、文本块拼装器、reasoning 标识。
 *
 * **形状必须与真实契约一致**，不是"反正不会走到"就可以随便写：用户在设置页显式选过
 * `whisperModel` / `chatModel` 时，候选链非空，生成侧会真的走到这里的消息构造与
 * `ctx.llm.stream`。0.3.4 的崩溃正是因为把 `stream` 当成"永远不走的那条路"实现成返回 Promise，
 * 而契约要求 AsyncIterable（细节见 `src/main/context.ts` 里 stream / resolveModelInfo 的注释）。
 */

/** 消息的最小形状（只有角色、内容与来源标记；适配器回放不在独立模式范围内） */
export interface StandaloneLlmMessage {
  role: 'user' | 'assistant';
  content: unknown;
  source: unknown;
}

/** 用户消息（`whisper.ts` / `chat.ts` 的入参形状） */
export function createUserMessage(input: { content: unknown; source: unknown }): StandaloneLlmMessage {
  return { role: 'user', content: input.content, source: input.source };
}

/** 助手消息（`chat.ts` 回放历史用） */
export function createAssistantMessage(input: { content: unknown; source: unknown }): StandaloneLlmMessage {
  return { role: 'assistant', content: input.content, source: input.source };
}

/** 文本块（`BlockAssembler.blocks()` 的元素形状） */
export interface StandaloneTextBlock {
  type: 'text';
  text: string;
}

/**
 * 流式文本拼装：收集文本块，并记录终止块给出的失败原因。
 *
 * 输入块兼容两种文本形状——`{type:'text-delta', text}`（增量块）与
 * `{type:'text', text}`（本应用的 `llm-openai` 直接吐完整块）；`{type:'finish', reason}`
 * 是终止块：适配器抛错会被**折进终止块**（流里不抛），调用方读 `finish` 生成失败文案。
 */
export class BlockAssembler {
  private readonly chunks: string[] = [];

  /** 终止原因（来自 `{type:'finish'}` 块；没有终止块时为 undefined） */
  finish?: { kind?: string; failure?: { message?: string; code?: string } };

  /** 收集一个块；工具调用等非文本块在本地实现里被忽略 */
  push(chunk: unknown): void {
    if (chunk === null || typeof chunk !== 'object') return;
    const block = chunk as { type?: unknown; text?: unknown; reason?: unknown };
    if ((block.type === 'text' || block.type === 'text-delta') && typeof block.text === 'string') {
      this.chunks.push(block.text);
      return;
    }
    if (block.type === 'finish') {
      this.finish = block.reason as BlockAssembler['finish'];
    }
  }

  /** 当前已拼装的块列表 */
  blocks(): StandaloneTextBlock[] {
    const text = this.chunks.join('');
    return text === '' ? [] : [{ type: 'text', text }];
  }
}

/** reasoning effort 标识工厂（真实契约里是枚举工厂，这里保持"传什么就是什么"） */
export function ReasoningEffortId(id: string): string {
  return id;
}
