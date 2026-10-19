/**
 * 本地 LLM 服务：把「OpenAI 兼容的 chat/completions 流」适配成插件宿主半边期望的
 * `ctx.llm` 契约（`stream()` 返回 `AsyncIterable<chunk>`，chunk 为 `{ type:'text', text }`）。
 *
 * 为什么是「适配」而不是重写生成逻辑：`host/whisper.ts` 与 `host/chat.ts` 已经写好了
 * 候选链、超时、人设、配图、失败文案等全部业务，它们只依赖 `ctx.llm.stream()` 这一个入口。
 * 因此这里只做协议翻译——**一份业务逻辑，两种宿主**（DSH 里用 DSH 的 llm，本地应用用本文件）。
 *
 * 契约细节（照 DSH 的真实形状，不是"能跑就行"）：
 *   - `stream(options)` 必须**同步返回 AsyncIterable**：调用方一律 `for await (...)`，
 *     返回 Promise 会立刻 TypeError，且那个 rejected promise 无人接管会终止进程；
 *   - `resolveModelInfo` 是**异步**的；本实现恒报「不支持 reasoning effort」，
 *     于是 `supportsReasoningOff()` 为 false，调用方不传 `reasoningEffort`——
 *     这对 OpenAI 兼容端点正是正确行为（多数端点不认这个字段）；
 *   - 错误在首次 `next()` 时抛出，落在调用方已有的 try/catch 里，转成结构化失败。
 */
import type { AppConfig } from './local-config';
import { endpointOf, readSecrets, type SecretMap } from './local-config';

/** 宿主半边传进来的消息（只用到 role 与文本内容） */
interface LlmMessage {
  role?: string;
  content?: unknown;
}

/** `stream()` 的入参（只声明本实现真正读的字段） */
interface LlmStreamOptions {
  provider?: string;
  model?: string;
  system?: string;
  messages?: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** 对外暴露的 llm 服务形状（与 DSH 的 ctx.llm 使用面一致） */
export interface LlmService {
  listProviders(): Array<{ id: string; name: string }>;
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>;
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ reasoning: { efforts: never[] } }>;
  stream(options: LlmStreamOptions): AsyncIterable<{ type: 'text'; text: string }>;
}

/** 把宿主半边的消息内容（`[{type:'text',text}]` 或字符串）拍成纯文本 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const block = part as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

/** 拼成 OpenAI 的 messages 数组（system 单列一条，与 DSH 的 `system` 字段同义） */
function toOpenAiMessages(options: LlmStreamOptions): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  const system = typeof options.system === 'string' ? options.system.trim() : '';
  if (system) out.push({ role: 'system', content: system });
  for (const message of options.messages ?? []) {
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user';
    const text = contentText(message.content);
    if (!text) continue;
    out.push({ role, content: text });
  }
  return out;
}

/** 端点根地址归一（去掉末尾斜杠；空 → 报错文案用） */
function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** 模型清单缓存（端点 + key 变了要失效，用 baseUrl 做键足够） */
const modelCache = new Map<string, { at: number; models: Array<{ id: string; name: string }> }>();
/** 清单缓存有效期（ms） */
const MODEL_CACHE_MS = 60_000;

/**
 * 建一个本地 llm 服务。
 * @param deps `config()` 每次现读（设置页保存后立即生效，不需要重启应用）；
 *             `secrets()` 同理
 */
export function createLlmService(deps: { config: () => AppConfig; secrets?: () => SecretMap }): LlmService {
  const secretsOf = (): SecretMap => (deps.secrets ? deps.secrets() : readSecrets());

  /** 解析出本次调用要用的端点与密钥 */
  const resolveEndpoint = (provider: string): { baseUrl: string; key: string; name: string; thinking?: 'off' } => {
    const config = deps.config();
    const endpoint = endpointOf(config, provider);
    if (!endpoint) {
      throw new Error(`未配置服务商「${provider}」，请在设置页「本地服务」里选择或新增端点`);
    }
    if (!endpoint.baseUrl) {
      throw new Error(`服务商「${endpoint.name}」还没有填写接口地址（设置页「本地服务」）`);
    }
    const key = endpoint.apiKeyRef ? (secretsOf()[endpoint.apiKeyRef] ?? '') : '';
    if (endpoint.apiKeyRef && !key) {
      throw new Error(`缺少 API Key：${endpoint.apiKeyRef}（设置页「本地服务」里填写）`);
    }
    return { baseUrl: trimBase(endpoint.baseUrl), key, name: endpoint.name, thinking: endpoint.thinking };
  };

  return {
    listProviders() {
      return deps.config().endpoints.map((endpoint) => ({ id: endpoint.id, name: endpoint.name }));
    },

    async listModels(provider) {
      const config = deps.config();
      const endpoint = endpointOf(config, provider);
      if (!endpoint) return [];
      // 显式配了清单就以配置为准（自定义端点往往没有 /models）
      if (endpoint.models.length > 0) return endpoint.models.map((id) => ({ id, name: id }));
      if (!endpoint.baseUrl) return [];
      const cacheKey = endpoint.baseUrl + '|' + (endpoint.apiKeyRef ? 'key' : 'nokey');
      const cached = modelCache.get(cacheKey);
      if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.models;
      try {
        const key = endpoint.apiKeyRef ? (secretsOf()[endpoint.apiKeyRef] ?? '') : '';
        const res = await fetch(trimBase(endpoint.baseUrl) + '/models', {
          headers: key ? { authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const body: unknown = await res.json();
        const data = (body as { data?: unknown })?.data;
        const models = (Array.isArray(data) ? data : [])
          .map((item) => {
            const id = String((item as { id?: unknown })?.id ?? '');
            return { id, name: id };
          })
          .filter((item) => item.id)
          .slice(0, 500);
        modelCache.set(cacheKey, { at: Date.now(), models });
        return models;
      } catch {
        // 拉不到清单不是错误：设置页允许手填模型名
        return [];
      }
    },

    async resolveModelInfo() {
      // 恒报「无 reasoning effort」→ 调用方不传 reasoningEffort（OpenAI 兼容端点的正确行为）
      return { reasoning: { efforts: [] as never[] } };
    },

    stream(options) {
      const provider = String(options.provider ?? '');
      const model = String(options.model ?? '');
      const messages = toOpenAiMessages(options);
      const temperature = typeof options.temperature === 'number' ? options.temperature : undefined;
      const maxTokens = typeof options.maxTokens === 'number' ? options.maxTokens : undefined;
      const signal = options.signal;

      return {
        [Symbol.asyncIterator](): AsyncIterator<{ type: 'text'; text: string }> {
          let started = false;
          /** 已解析但还没吐出的文本块 */
          const queue: string[] = [];
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          let buffer = '';
          let finished = false;
          let failure: unknown;

          /** 发起请求（首次 next() 时才做，符合"错误在 next 时抛出"的契约） */
          const start = async (): Promise<void> => {
            const { baseUrl, key, thinking } = resolveEndpoint(provider);
            if (!model) throw new Error('未选择模型（设置页「本地服务」）');
            const res = await fetch(baseUrl + '/chat/completions', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(key ? { authorization: `Bearer ${key}` } : {}),
              },
              body: JSON.stringify({
                model,
                messages,
                stream: true,
                // 端点声明了「关思考」才带这个字段（DeepSeek V4 默认开思考，桌宠只要一句话，
                // 开着会白等几秒推理、多花推理 token）。未声明的端点一律不发，避免严格实现 400。
                ...(thinking === 'off' ? { thinking: { type: 'disabled' } } : {}),
                ...(temperature === undefined ? {} : { temperature }),
                ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
              }),
              signal,
            });
            if (!res.ok) {
              // 把服务端的错误正文带出来——否则用户只看到 "HTTP 401"，不知道是 key 错了还是模型不存在
              let detail = '';
              try {
                detail = (await res.text()).slice(0, 400);
              } catch {
                /* 读不到正文就只报状态码 */
              }
              throw new Error(`模型接口返回 HTTP ${res.status}${detail ? '：' + detail : ''}`);
            }
            if (!res.body) throw new Error('模型接口没有返回流式响应体');
            reader = res.body.getReader();
          };

          /** 读一块并解析 SSE，把文本推进队列 */
          const pump = async (): Promise<void> => {
            if (!reader) return;
            const { done, value } = await reader.read();
            if (done) {
              finished = true;
              return;
            }
            buffer += new TextDecoder().decode(value, { stream: true });
            let index = buffer.indexOf('\n');
            while (index >= 0) {
              const line = buffer.slice(0, index).replace(/\r$/, '');
              buffer = buffer.slice(index + 1);
              index = buffer.indexOf('\n');
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') {
                if (payload === '[DONE]') finished = true;
                continue;
              }
              try {
                const chunk = JSON.parse(payload) as {
                  choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>;
                  error?: { message?: unknown };
                };
                if (chunk.error) throw new Error(String(chunk.error.message ?? '模型接口返回错误'));
                const text = chunk.choices?.[0]?.delta?.content;
                if (typeof text === 'string' && text) queue.push(text);
              } catch (error) {
                if (error instanceof SyntaxError) continue; // 非 JSON 的心跳行忽略
                throw error;
              }
            }
          };

          return {
            async next(): Promise<IteratorResult<{ type: 'text'; text: string }>> {
              if (failure) throw failure;
              try {
                if (!started) {
                  started = true;
                  await start();
                }
                // 队列有货先吐；否则继续读流，直到有文本或流结束
                for (;;) {
                  const text = queue.shift();
                  if (text !== undefined) return { done: false, value: { type: 'text', text } };
                  if (finished) return { done: true, value: undefined };
                  await pump();
                }
              } catch (error) {
                failure = error;
                throw error;
              }
            },
            async return(): Promise<IteratorResult<{ type: 'text'; text: string }>> {
              finished = true;
              try {
                await reader?.cancel();
              } catch {
                /* 取消失败无影响 */
              }
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  };
}
