/**
 * 本地应用的 HTTP 服务：桌宠的全部能力都挂在 `127.0.0.1` 的这一个端口上。
 *
 * 职责边界很清楚——**这里没有业务**：
 *   1. 绑定 127.0.0.1（端口被占用则顺延）；
 *   2. 把落在 `/dsh-pet-ng-7340` 前缀上的请求原样交给宿主半边注册的 handler
 *      （它自己写响应头与 body，路由表只有那一份）；
 *   3. 把其余请求交给 `extra`（设置页静态资源 + 本地服务接口，见 `web-ui.ts`）；
 *   4. 提供 `/health`（运维/探活）与 `/shutdown`（脚本化停机）；
 *   5. 兜住 handler 的异常，回 500 JSON。
 *
 * **安全边界（0.9.1）**：这个端口上没有鉴权，所以必须挡住"别人网页里的 JS"。
 * 从前对所有响应发 `access-control-allow-origin: *` 并放行 OPTIONS 预检，于是任意网站都能
 * 跨域 `POST /app/api/config` 把 `endpoints[].baseUrl` 改成自己的地址，再触发一次生成，
 * 用户的 API Key 就随 `Authorization: Bearer` 发出去了。现在：
 *   - 不再发任何 CORS 头（设置页同源，不需要；跨域读直接失败）；
 *   - `Host` 必须是回环名（防 DNS rebinding：evil.com 解析到 127.0.0.1 时 Host 仍是 evil.com）；
 *   - 带 `Origin` 的请求必须与 `Host` 同源；`Origin: null`（file:// 页面）只放行只读方法。
 * 不带 `Origin` 的客户端（curl / IDE 插件 / CI / Node 脚本）照旧放行——它们本来就有本机权限。
 *
 * 为什么服务要存在（而不是让主进程直接和渲染端 IPC）：桌面透明窗渲染端与第三方脚本
 * 都用同一套 HTTP 契约（`/dsh-pet-ng-7340/*`，见仓库根 `API.md`）；把它做成真实 HTTP，
 * 桌宠就同时是一个可被脚本驱动的实体，而不只是应用里的一个窗口。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';

/** 宿主半边注册到 `ctx.webServer` 的一条路由（`kind` 只有 prefix / exact 两种） */
export interface RegisteredRoute {
  kind: string;
  /** 路由路径，例如 `/dsh-pet-ng-7340` */
  path: string;
  /** 真实 Node HTTP handler：自己写响应头与 body */
  handler: (req: IncomingMessage, res: ServerResponse) => unknown;
}

/** 应用日志接口（宿主半边的 `ctx.logger` 与主进程共用这一份形状） */
export interface AppLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/** 默认端口（与桌面窗口 的内置默认一致） */
export const DEFAULT_PORT = 7340;
/** 端口被占用时向后顺延的个数上限 */
export const PORT_SCAN_LIMIT = 25;

export interface AppServerOptions {
  /** 宿主半边注册的路由（与 `createAppContext` 共用同一个数组） */
  routes: RegisteredRoute[];
  logger: AppLogger;
  /** 首选端口，默认 {@link DEFAULT_PORT} */
  port?: number;
  /** `/health` 的运维信息提供者 */
  status?: () => unknown;
  /** `/shutdown` 被请求时通知调用方收尾 */
  onShutdown?: () => void;
  /**
   * 额外路由（设置页与本地服务接口）。在宿主路由表**之前**尝试，
   * 返回 true 表示已处理（此时不要再写响应）。
   */
  extra?: (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean | Promise<boolean>;
}

export interface AppServer {
  /** 实际监听的端口（首选端口被占用时会大于请求值） */
  port: number;
  close(): Promise<void>;
}

/**
 * 回环主机名判定（`Host` 头去掉端口后比较）。
 * 只认 127.0.0.1 / localhost / [::1]：DNS rebinding 攻击里，页面域名解析到 127.0.0.1，
 * 但浏览器发出的 `Host` 仍是攻击者域名，这一条就能拦住。
 */
function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase().replace(/:\d+$/, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/**
 * 跨站请求判定：返回拒绝原因，`undefined` 表示放行。
 *
 * 规则（见文件头的安全边界）：
 *   1. `Host` 必须是回环名；
 *   2. 没有 `Origin` → 放行（curl / IDE 插件 / CI / Node 脚本，本来就具备本机权限）；
 *   3. 有 `Origin` → 必须与 `Host` 同源（端口顺延后依然成立，因为两边都取自同一个请求）；
 *   4. 例外：`Origin: null` 且是只读方法（独立开发模式下渲染端是 `file://` 页面）。
 *
 * 导出以便单测直接喂假请求，不必起 socket。
 */
export function crossSiteReason(req: { method?: string; headers: Record<string, unknown> }): string | undefined {
  const host = String(req.headers.host ?? '');
  if (!host) return '缺少 Host 头';
  if (!isLoopbackHost(host)) return `只接受本机访问（Host: ${host}）`;

  const rawOrigin = req.headers.origin;
  if (rawOrigin === undefined) return undefined;
  const origin = String(rawOrigin);

  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'http:' && parsed.host.toLowerCase() === host.toLowerCase()) return undefined;
  } catch {
    /* Origin 不是合法 URL（典型是字符串 "null"）：落到下面按跨站处理 */
  }

  const method = (req.method ?? 'GET').toUpperCase();
  if (origin === 'null' && (method === 'GET' || method === 'HEAD')) return undefined;

  return `跨站请求被拒绝（Origin: ${origin}）`;
}

/** 只取 pathname（不解码，避免 %2F 一类输入在校验之前被改写）；非法 URL 落回 '/' */
function pathnameOf(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

function matches(route: RegisteredRoute, pathname: string): boolean {
  if (route.kind === 'exact') return pathname === route.path;
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** handler 抛错时的收口：头已发出就断连，否则 500 JSON */
function fail(res: ServerResponse, error: unknown, logger: AppLogger): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`路由处理异常：${message}`);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, 500, { error: message });
}

/** 建一个请求监听器（导出以便单测直接驱动，不必真的起 socket） */
export function createRequestListener(options: AppServerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const { routes, logger, status, onShutdown, extra } = options;
  return (req, res) => {
    const method = req.method ?? 'GET';
    const pathname = pathnameOf(req.url);
    logger.debug(`${method} ${pathname}`);

    // 预检：**不再回 CORS 头**——跨域预检因此失败，真正的请求根本发不出去
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 跨站请求一律 403（见 crossSiteReason 的规则）
    const crossSite = crossSiteReason(req);
    if (crossSite) {
      logger.warn(`${method} ${pathname} 被拒：${crossSite}`);
      sendJson(res, 403, { error: crossSite });
      return;
    }

    /** 额外路由没接：走宿主路由表与内置运维端点 */
    const fallThrough = (): void => {
      if (pathname === '/health') {
        sendJson(res, 200, status?.() ?? { name: 'dsh-petNG' });
        return;
      }
      if (pathname === '/shutdown') {
        // 先回话再收尾：调用方要能拿到 200，而不是被自己的停机动作打断
        sendJson(res, 200, { ok: true, stopping: true });
        queueMicrotask(() => onShutdown?.());
        return;
      }
      const route = routes.find((candidate) => matches(candidate, pathname));
      if (route === undefined) {
        sendText(
          res,
          404,
          `dsh-petNG: 没有匹配的路由（已注册：${routes.map((item) => item.path).join(', ') || '无'}）`,
        );
        return;
      }
      try {
        void Promise.resolve(route.handler(req, res)).catch((error: unknown) => fail(res, error, logger));
      } catch (error) {
        fail(res, error, logger);
      }
    };

    // 额外路由优先（设置页 / 本地服务接口）；抛错同样收口成 500，不静默
    if (extra) {
      try {
        void Promise.resolve(extra(req, res, pathname))
          .then((handled) => {
            if (!handled) fallThrough();
          })
          .catch((error: unknown) => fail(res, error, logger));
      } catch (error) {
        fail(res, error, logger);
      }
      return;
    }
    fallThrough();
  };
}

/** 从 preferred 起找一个能绑上的 127.0.0.1 端口；`preferred = 0` 表示交给系统分配 */
async function bindFirstFree(server: HttpServer, preferred: number, logger: AppLogger): Promise<number> {
  for (let port = preferred; port < preferred + PORT_SCAN_LIMIT; port += 1) {
    try {
      await new Promise<void>((accept, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          accept();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      // 真实端口必须回读 address()：传 0 时监听端口由系统分配，不等于请求值
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      if (preferred > 0 && bound !== preferred) logger.warn(`端口 ${preferred} 被占用，改用 ${bound}`);
      return bound;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`从 ${preferred} 起连续 ${PORT_SCAN_LIMIT} 个端口都被占用`);
}

/**
 * 起本地服务。
 * @param options 路由、日志器、首选端口与运维回调
 * @returns 实际端口与关闭函数
 */
export async function listenAppServer(options: AppServerOptions): Promise<AppServer> {
  const server = createServer(createRequestListener(options));
  // 客户端半截请求（扫描器、被中断的连接）不该变成未捕获异常刷屏
  server.on('clientError', (_error, socket) => socket.destroy());
  const port = await bindFirstFree(server, options.port ?? DEFAULT_PORT, options.logger);
  options.logger.info(`本地服务已监听 http://127.0.0.1:${port}/`);
  return {
    port,
    async close(): Promise<void> {
      // keep-alive 连接会让 close() 一直等：先断开全部连接再关（脚本化停机不能挂住）
      server.closeAllConnections();
      await new Promise<void>((accept) => server.close(() => accept()));
    },
  };
}
