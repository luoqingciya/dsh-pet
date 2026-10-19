/**
 * 本地应用配置（替代 DSH 的 `agentDefaultModel` + `credentials` + `llm` 三件服务的数据源）。
 *
 * 两份文件，职责分开：
 *   - `app-config.json`：服务商 / 模型 / 端点 / 通知开关 —— 可以随手看、随手改，不含任何秘密；
 *   - `secrets.json`：API Key 表（`DEEPSEEK_API_KEY` 等）—— 单独一份，写入时权限收紧到 0600。
 * 分开的理由：用户要排障时经常把配置贴出来（issue / 聊天），把 key 和配置混在一个文件里，
 * 一次复制就泄露。分开之后「贴配置」是安全的默认动作。
 *
 * 校验口径与插件宿主半边一致：**读进来的值必须可信**，非法值回落默认而不是抛错——
 * 一个手改坏的字段不该让桌宠打不开。写出去的值走白名单重建，不整份透传客户端输入。
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { appConfigFile, secretsFile } from './paths';
import { openSecret, sealSecret } from './secrets';

/** 一个 OpenAI 兼容端点（一个端点 = 一个 provider id） */
export interface AppEndpoint {
  /** provider id（同时用于余额路由匹配，如 `deepseek-official`） */
  id: string;
  /** 设置页展示名 */
  name: string;
  /** OpenAI 兼容根地址（不带 `/chat/completions`） */
  baseUrl: string;
  /** 密钥名（`secrets.json` 的 key）；空串 = 该端点不需要密钥（如本机 Ollama） */
  apiKeyRef: string;
  /** 已知模型清单（空 = 运行时向 `GET {baseUrl}/models` 拉取） */
  models: string[];
  /**
   * 是否在请求体里显式关闭「思考模式」（`{"thinking":{"type":"disabled"}}`）。
   *
   * 只有明确支持的端点才写——未知字段对严格的 OpenAI 兼容实现可能直接 400。
   * DeepSeek V4 默认开启思考（见其 Thinking Mode 文档）：桌宠只要一句碎碎念，
   * 开着思考会白等几秒推理、多花推理 token，所以预设里关掉。
   */
  thinking?: 'off';
}

/** 通知开关（本地应用只保留两类可观测事件，见 notifications.ts） */
export interface AppNotifyConfig {
  /** 对话回复完成 */
  chatReply: boolean;
  /** 余额告急（已用 ≥ 90%） */
  balanceAlert: boolean;
}

/** 本地应用配置 */
export interface AppConfig {
  version: 1;
  /** 主服务商（同时决定碎碎念/对话用哪个端点、余额查哪个服务商） */
  provider: string;
  /** 主模型 */
  model: string;
  /** 余额服务商：空串 = 跟随主服务商 */
  balanceProvider: string;
  endpoints: AppEndpoint[];
  notify: AppNotifyConfig;
  /**
   * 启动后是否检查新版本（只提示 + 打开下载页，**不会**自动替换文件）。
   *
   * 默认 true。关掉它 = 完全不发这次网络请求（给在意出网行为、或网络环境访问不了
   * api.github.com 的人一个干净的开关）。托盘「检查更新」是手动触发，不受这个开关影响。
   */
  updateCheck: boolean;
}

/**
 * 内置端点（`endpoints` 缺失/损坏时的兜底，也是首次启动的初始值）。
 *
 * 维护口径：**地址写死、模型清单尽量留空**。留空时设置页会向端点的 `GET /models` 现拉，
 * 比在代码里硬编码一串会过期的模型名可靠（2026-07 DeepSeek 就把 `deepseek-chat` /
 * `deepseek-reasoner` 换成了 `deepseek-flash` / `deepseek-v4-pro`，硬编码的老名字会让
 * 所有用户在同一天一起 404）。只有「官方明确、且短期不会变」的模型才写进清单。
 */
export const DEFAULT_ENDPOINTS: AppEndpoint[] = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek 官方',
    // 官方 OpenAI 兼容根地址就是 https://api.deepseek.com（加不加 /v1 都通，这里用带版本号的写法）
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyRef: 'DEEPSEEK_API_KEY',
    // 2026-07-24 起 deepseek-chat / deepseek-reasoner 已停用，现行模型是这两个
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    thinking: 'off',
  },
  {
    id: 'ollama',
    name: 'Ollama（本机）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKeyRef: '',
    models: [],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyRef: 'OPENAI_API_KEY',
    models: [],
  },
  {
    id: 'dashscope',
    name: '阿里云百炼（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyRef: 'DASHSCOPE_API_KEY',
    models: ['qwen-plus', 'qwen-max', 'qwen-long'],
  },
  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    baseUrl: '',
    apiKeyRef: 'CUSTOM_API_KEY',
    models: [],
  },
];

/** 默认配置（首次启动即用：DeepSeek 官方 + 现行模型） */
export const DEFAULT_APP_CONFIG: AppConfig = {
  version: 1,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  balanceProvider: '',
  endpoints: DEFAULT_ENDPOINTS,
  notify: { chatReply: true, balanceAlert: true },
  updateCheck: true,
};

/** 已知可查余额的服务商（设置页「余额服务商」下拉框的数据源；与 host/balance 的注册表对齐） */
export const BALANCE_PROVIDERS: Array<{ id: string; name: string; keyRef: string }> = [
  { id: 'deepseek-official', name: 'DeepSeek 官方', keyRef: 'DEEPSEEK_API_KEY' },
  { id: 'opencode-go', name: 'OpenCode Zen Go', keyRef: 'OPENCODE_GO_API_KEY' },
  { id: 'commandcode', name: 'Command Code', keyRef: 'COMMANDCODE_API_KEY' },
];

/** 字符串字段的安全取值 */
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

/** 字符串数组（去空、去重、限长） */
function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= 200) break;
  }
  return out;
}

/** 单个端点：字段缺失回落默认端点；id 非法直接丢弃 */
function normalizeEndpoint(raw: unknown, index: number): AppEndpoint | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const fallback = DEFAULT_ENDPOINTS[index] ?? DEFAULT_ENDPOINTS[DEFAULT_ENDPOINTS.length - 1]!;
  const id = str(obj.id, fallback.id);
  if (!id) return undefined;
  return {
    id,
    name: str(obj.name, fallback.name) || id,
    baseUrl: str(obj.baseUrl, fallback.baseUrl),
    apiKeyRef: typeof obj.apiKeyRef === 'string' ? obj.apiKeyRef.trim() : fallback.apiKeyRef,
    models: strList(obj.models),
    // 只认 'off'：其余值（含手改的错字）一律当"未声明"，绝不把未知字段发给端点
    ...(obj.thinking === 'off' ? { thinking: 'off' as const } : {}),
  };
}

/**
 * 把任意输入规范成一份**可信**配置。
 * @param raw 解析后的 JSON（或 undefined）
 */
export function normalizeAppConfig(raw: unknown): AppConfig {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(obj.endpoints) ? obj.endpoints : [];
  const endpoints: AppEndpoint[] = [];
  for (const [index, item] of list.entries()) {
    const endpoint = normalizeEndpoint(item, index);
    if (!endpoint) continue;
    if (endpoints.some((e) => e.id === endpoint.id)) continue;
    endpoints.push(endpoint);
    if (endpoints.length >= 20) break;
  }
  // 端点表为空（或用户把内置端点删光）时回落内置清单：没有端点就完全没有 AI 能力，
  // 但用户仍应能打开设置页把它改回来——所以这里不是报错，是"保留可用下限"
  const effectiveEndpoints = endpoints.length > 0 ? endpoints : DEFAULT_ENDPOINTS.map((e) => ({ ...e }));
  const provider = str(obj.provider, DEFAULT_APP_CONFIG.provider);
  const knownProvider = effectiveEndpoints.some((e) => e.id === provider);
  const notifyRaw = obj.notify && typeof obj.notify === 'object' ? (obj.notify as Record<string, unknown>) : {};
  return {
    version: 1,
    provider: knownProvider ? provider : effectiveEndpoints[0]!.id,
    // 字段缺失 → 默认模型（首次启动即可用）；显式空串 → 保持空（用户主动清掉，不要偷偷填回去）
    model: typeof obj.model === 'string' ? obj.model.trim() : DEFAULT_APP_CONFIG.model,
    balanceProvider: str(obj.balanceProvider, ''),
    endpoints: effectiveEndpoints,
    notify: {
      chatReply: typeof notifyRaw.chatReply === 'boolean' ? notifyRaw.chatReply : true,
      balanceAlert: typeof notifyRaw.balanceAlert === 'boolean' ? notifyRaw.balanceAlert : true,
    },
    // 缺失 = 默认开（新装用户应当知道有新版本）；显式 false 才关
    updateCheck: typeof obj.updateCheck === 'boolean' ? obj.updateCheck : true,
  };
}

/** 读配置（文件不存在 / 解析失败 / 字段非法 → 回落默认，绝不抛） */
export function readAppConfig(): AppConfig {
  try {
    return normalizeAppConfig(JSON.parse(readFileSync(appConfigFile(), 'utf8')));
  } catch {
    // 首次启动没有配置文件：用**默认配置**（含默认服务商与模型），而不是"字段全空"的规范结果
    return normalizeAppConfig(DEFAULT_APP_CONFIG);
  }
}

/** 原子写（先写临时文件再改名，避免写一半断电留下坏 JSON） */
function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  if (mode !== undefined) {
    try {
      chmodSync(tmp, mode);
    } catch {
      // Windows 上 chmod 只影响只读位；失败不影响可用性
    }
  }
  try {
    renameSync(tmp, file);
  } catch {
    // Windows 上目标已存在时 rename 会失败：退化成「覆盖写 + 删临时文件」
    writeFileSync(file, readFileSync(tmp));
    try {
      unlinkSync(tmp);
    } catch {
      /* 清理失败无影响 */
    }
  }
  if (mode !== undefined) {
    try {
      chmodSync(file, mode);
    } catch {
      /* 同上 */
    }
  }
}

/** 保存配置（白名单重建后落盘；返回落盘后的规范值） */
export function saveAppConfig(patch: unknown): AppConfig {
  const next = normalizeAppConfig(patch);
  writeJsonAtomic(appConfigFile(), next);
  return next;
}

/** 密钥表（名字 → 值） */
export type SecretMap = Record<string, string>;

/** 读密钥表（缺文件 → 空表） */
export function readSecrets(): SecretMap {
  try {
    const raw: unknown = JSON.parse(readFileSync(secretsFile(), 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    const out: SecretMap = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      const name = key.trim();
      // 落盘值可能是密文（enc:v1:…），也可能是升级前的明文；解不开按"未配置"处理
      const text = openSecret(value.trim());
      if (name && text) out[name] = text;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 保存密钥表。
 *
 * 语义：**整表替换**（设置页每次提交完整表）。传 `null` 值表示删除该条。
 * 空值不落盘——空字符串与"没配"是同一件事，留着只会让下面的"是否已配置"判断变复杂。
 */
export function saveSecrets(input: unknown): SecretMap {
  const current = readSecrets();
  const next: SecretMap = { ...current };
  if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const name = key.trim();
      if (!name) continue;
      if (value === null || value === '') {
        delete next[name];
        continue;
      }
      if (typeof value !== 'string') continue;
      const text = value.trim();
      if (text) next[name] = text;
    }
  }
  // 落盘时加密（系统支持的话）；内存里始终是明文，调用方无感
  const sealed: SecretMap = {};
  for (const [name, value] of Object.entries(next)) sealed[name] = sealSecret(value);
  writeJsonAtomic(secretsFile(), sealed, 0o600);
  return next;
}

/** 某个端点当前解析到的密钥（不需要密钥的端点返回空串） */
export function keyOfEndpoint(endpoint: AppEndpoint | undefined, secrets: SecretMap = readSecrets()): string {
  if (!endpoint || !endpoint.apiKeyRef) return '';
  return secrets[endpoint.apiKeyRef] ?? '';
}

/** 按 id 找端点 */
export function endpointOf(config: AppConfig, id: string): AppEndpoint | undefined {
  return config.endpoints.find((e) => e.id === id);
}

/** 设置页可见的配置视图：密钥只报"有没有配"，绝不回传明文 */
export interface AppConfigView {
  provider: string;
  model: string;
  balanceProvider: string;
  endpoints: Array<AppEndpoint & { keyConfigured: boolean; keyRef: string }>;
  notify: AppNotifyConfig;
  /** 启动时检查新版本（设置页「更新」开关） */
  updateCheck: boolean;
  /** 密钥名 → 是否已配置（含余额服务商要求的 key） */
  keys: Record<string, boolean>;
}

/** 生成设置页视图 */
export function configView(config: AppConfig = readAppConfig(), secrets: SecretMap = readSecrets()): AppConfigView {
  const keyNames = new Set<string>();
  for (const endpoint of config.endpoints) if (endpoint.apiKeyRef) keyNames.add(endpoint.apiKeyRef);
  for (const provider of BALANCE_PROVIDERS) keyNames.add(provider.keyRef);
  return {
    provider: config.provider,
    model: config.model,
    balanceProvider: config.balanceProvider,
    endpoints: config.endpoints.map((endpoint) => ({
      ...endpoint,
      keyConfigured: endpoint.apiKeyRef ? Boolean(secrets[endpoint.apiKeyRef]) : true,
      keyRef: endpoint.apiKeyRef,
    })),
    notify: { ...config.notify },
    updateCheck: config.updateCheck,
    keys: Object.fromEntries([...keyNames].map((name) => [name, Boolean(secrets[name])])),
  };
}
