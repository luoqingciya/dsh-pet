/**
 * 本地应用的宿主上下文：把插件宿主半边（`src/host/index.ts` 的 `apply`）跑在**真实服务**上。
 *
 * 与 `src/standalone/context.ts` 的区别只有一处，但很关键：那一份把 DSH 服务全部换成
 * 「明确降级」的替身（没有凭证、没有模型 → 余额/碎碎念/对话一律不可用）；本文件把同样几个
 * 服务换成**本地实现**：
 *
 *   - `credentials.resolve`  → 本地 `secrets.json`（设置页填写，权限 0600）
 *   - `agentDefaultModel`    → 本地 `app-config.json` 的服务商 + 模型
 *   - `llm`                  → OpenAI 兼容端点（`llm-openai.ts`）
 *   - `on(...)`              → 真实的事件总线：本地应用把「一次对话生成」合成
 *                              `turn/start` / `turn/end` 会话事件投进来，于是插件的
 *                              **工作状态联动**与**系统通知帧**两条链路照常工作，
 *                              不需要为本地模式另写一套状态机。
 *   - `get(name)`            → 恒 undefined（账号余额服务 `deepseekAccount` 在本地不存在）
 *
 * 路由表、配置合并、素材归属、桌面 Helper 的拉起与重启仍然全部由插件那一份 `apply` 负责，
 * 本文件一行业务逻辑都没有。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AppConfig } from './local-config';
import { readSecrets, type SecretMap } from './local-config';
import { createLlmService, type LlmService } from './llm-openai';
import type { RegisteredRoute, StandaloneLogger } from '../standalone/context';

/** 插件注册到 `ctx.webServer` 的一条路由（与独立模式同一形状） */
export type { RegisteredRoute, StandaloneLogger };

/** 事件处理器（插件只用到 (session, event) 与 (payload) 两种形状） */
type EventHandler = (...args: unknown[]) => unknown;

export interface AppContextOptions {
  /** 本地服务端口（函数形式：先监听、端口确定后才 `apply`） */
  port: number | (() => number);
  logger: StandaloneLogger;
  /** 路由收集数组（与服务共用同一个） */
  routes?: RegisteredRoute[];
  /** 现读配置（设置页保存后立即生效） */
  config: () => AppConfig;
  /** 现读密钥（同上） */
  secrets?: () => SecretMap;
}

export interface AppContext {
  /** 交给 `apply()` 的 ctx */
  ctx: Record<string, unknown>;
  routes: RegisteredRoute[];
  /** 初始化期间失败的 effect（每项已打日志） */
  failures: string[];
  /** 向插件投递一个宿主事件（本地合成：turn/start、turn/end…） */
  emit(name: string, ...args: unknown[]): void;
  /** 释放全部 effect（停桌面 Helper、清定时器）与事件监听 */
  dispose(): Promise<void>;
}

/** 本地应用的伪会话 id（工作状态/通知按会话聚合，固定一个即可） */
export const LOCAL_SESSION_ID = 'dsh-pet-local';

/** 合成一条会话事件要用的最小 session 形状（`header.id` 是插件取会话 id 的位置） */
export function localSession(): { header: { id: string } } {
  return { header: { id: LOCAL_SESSION_ID } };
}

/**
 * 建本地应用的宿主上下文。
 * @param options 端口、日志、路由数组、配置与密钥的读取函数
 */
export function createAppContext(options: AppContextOptions): AppContext {
  const { logger } = options;
  const routes = options.routes ?? [];
  const failures: string[] = [];
  const disposers: Array<() => unknown> = [];
  const listeners = new Map<string, Set<EventHandler>>();
  let disposed = false;

  const portOf = (): number => (typeof options.port === 'function' ? options.port() : options.port);

  const secretsOf = (): SecretMap => (options.secrets ? options.secrets() : readSecrets());
  const configOf = (): AppConfig => options.config();

  const llm: LlmService = createLlmService({ config: configOf, secrets: secretsOf });

  const webServer = {
    get port(): number {
      return portOf();
    },
    register(spec: RegisteredRoute): () => void {
      routes.push({ kind: spec.kind, path: spec.path, handler: spec.handler });
      return () => {
        const index = routes.findIndex((route) => route.handler === spec.handler);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };

  const context: Record<string, unknown> = {
    effect(fn: () => unknown): unknown {
      try {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose as () => unknown);
        return dispose;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(message);
        logger.error(`初始化某项失败（已跳过）：${message}`);
        return undefined;
      }
    },

    /** 真实事件总线：插件注册的监听器收进表里，由 `emit()` 投递 */
    on(name: string, handler: EventHandler): () => void {
      let set = listeners.get(name);
      if (!set) {
        set = new Set();
        listeners.set(name, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },

    logger,
    webServer,
    /** 本地没有 DSH 的浏览器访问闸门，URL 原样返回 */
    connection: { authenticatedUrl: (baseUrl: string): string => baseUrl },
    commands: { register: (): (() => void) => () => {} },
    /** 本地不装账号服务：账号余额路由会走 credential-missing 的显式失败分支 */
    get: (): undefined => undefined,

    agentDefaultModel: {
      currentSelection: (): { provider: string; model: string } => {
        const config = configOf();
        return { provider: config.provider, model: config.model };
      },
    },

    credentials: {
      /** 余额路由经 `credentialRef(name)` 传入密钥名；本地直接查 secrets.json */
      resolve: async (ref: unknown): Promise<{ value: string } | undefined> => {
        const name = typeof ref === 'string' ? ref : String((ref as { name?: unknown })?.name ?? '');
        if (!name) return undefined;
        const value = secretsOf()[name];
        return value ? { value } : undefined;
      },
    },

    llm,

    /**
     * 余额服务商可与对话服务商不同（例如对话走本机 Ollama、余额仍查 DeepSeek）。
     * 空串 = 跟随主服务商。宿主半边会优先读这个能力（DSH 内不提供，行为不变）。
     */
    petBalanceProvider: (): string => configOf().balanceProvider,
  };

  return {
    ctx: context,
    routes,
    failures,
    emit(name: string, ...args: unknown[]): void {
      const set = listeners.get(name);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          handler(...args);
        } catch (error) {
          logger.warn(`事件处理失败（${name}）：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          await dispose();
        } catch (error) {
          logger.warn(`释放某项失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  };
}

/** 供 server 层复用的请求/响应类型别名（避免各文件重复 import node:http 类型） */
export type { IncomingMessage, ServerResponse };
