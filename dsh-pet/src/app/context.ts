/**
 * 本地应用的宿主上下文：把宿主半边（`src/host/index.ts` 的 `apply`）跑在**真实服务**上。
 *
 * `apply` 只要求一个 Cordis 风格的 `ctx`，它自己负责路由表、配置合并、素材归属、
 * 桌面窗口的启停。本文件提供的就是那几项服务：
 *
 *   - `credentials.resolve`  → 本地 `secrets.json`（设置页填写，权限 0600）
 *   - `agentDefaultModel`    → 本地 `app-config.json` 的服务商 + 模型
 *   - `llm`                  → OpenAI 兼容端点（`llm-openai.ts`）
 *   - `on(...)`              → 真实的事件总线：应用把「一次对话生成」合成
 *                              `turn/start` / `turn/end` 会话事件投进来，于是宿主的
 *                              **工作状态联动**与**系统通知帧**两条链路照常工作，
 *                              不需要为本地模式另写一套状态机。
 *   - `petDesktop`           → 桌面窗口服务（`desktop.ts`）：宿主决定"哪些宠物该显示在桌面"，
 *                              应用决定"怎么把窗口开出来"。纯 Node 环境不传 = 没有桌面宠物。
 *
 * 本文件一行业务逻辑都没有：加一个宠物端点、改一处配置合并，仍然只改 `src/host`。
 */

import type { AppConfig } from './local-config';
import { readSecrets, type SecretMap } from './local-config';
import { createLlmService, type LlmService } from './llm-openai';
import type { PetDesktop } from '../host/desktop-api';
import type { AppLogger, RegisteredRoute } from './server';

/** 路由与日志类型由 `./server` 定义，这里原样转出，调用方只 import 一处 */
export type { AppLogger, RegisteredRoute };

/** 事件处理器（插件只用到 (session, event) 与 (payload) 两种形状） */
type EventHandler = (...args: unknown[]) => unknown;

export interface AppContextOptions {
  /** 本地服务端口（函数形式：先监听、端口确定后才 `apply`） */
  port: number | (() => number);
  logger: AppLogger;
  /** 路由收集数组（与服务共用同一个） */
  routes?: RegisteredRoute[];
  /** 现读配置（设置页保存后立即生效） */
  config: () => AppConfig;
  /** 现读密钥（同上） */
  secrets?: () => SecretMap;
  /** 桌面窗口服务（Electron 环境才有；不传 = 没有桌面宠物，其余端点照常） */
  petDesktop?: PetDesktop;
}

export interface AppContext {
  /** 交给 `apply()` 的 ctx */
  ctx: Record<string, unknown>;
  routes: RegisteredRoute[];
  /** 初始化期间失败的 effect（每项已打日志） */
  failures: string[];
  /** 向插件投递一个宿主事件（本地合成：turn/start、turn/end…） */
  emit(name: string, ...args: unknown[]): void;
  /** 释放全部 effect（停桌面窗口、清定时器）与事件监听 */
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

  /** 把事件投给所有监听器（ctx.emit 与返回的 emit 共用这一份，宿主可以自己投回总线） */
  const emit = (name: string, ...args: unknown[]): void => {
    const set = listeners.get(name);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(...args);
      } catch (error) {
        logger.warn(`事件处理失败（${name}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
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
    /**
     * 事件总线出口：宿主把**自己合成的**会话事件投回来（例如一次对话的 turn/start、turn/end）。
     * 应用里没有真实会话，工作状态联动与通知帧都靠这些事件驱动；宿主是唯一的产生者，
     * 因为只有它知道生成什么时候开始、结果是什么。
     */
    emit,

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

    // 桌面窗口：只在有 Electron 的环境注入（见 desktop.ts）
    ...(options.petDesktop ? { petDesktop: options.petDesktop } : {}),
  };

  return {
    ctx: context,
    routes,
    failures,
    emit,
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
