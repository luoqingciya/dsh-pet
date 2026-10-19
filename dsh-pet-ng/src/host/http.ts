/**
 * 宿主半边的 HTTP 基础设施：响应写出、请求体读取、素材路径的防穿越校验。
 *
 * 从 `index.ts` 里拆出来的理由很直接：这些函数与「宠物业务」无关，纯粹是
 * "怎么把一个文件/一段 JSON 安全地写给客户端"。它们不依赖任何闭包状态，
 * 单独放一处既能被路由复用，也能被单元测试直接覆盖（以前埋在 1400 行的文件里只能靠源码守卫）。
 */
import { createReadStream, existsSync, fstatSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, normalize, sep } from 'node:path';

/** 不同扩展名对应的 Content-Type 映射 */
export const MIME: Record<string, string> = {
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** 按扩展名取 Content-Type（未知类型回落 octet-stream） */
export function mimeOf(file: string): string {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

/**
 * 规范化并校验请求路径，确保它在 root 目录内（防路径穿越）。
 * @returns 规范化后的绝对文件路径；非法（穿越）时返回 undefined
 */
export function resolveAsset(root: string, rel: string): string | undefined {
  if (rel.length === 0) return undefined;
  const candidate = normalize(join(root, rel));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return undefined;
  return candidate;
}

/** 在 root 下解析并确认实体存在；非法（穿越）或不存在时返回 undefined */
export function resolveExisting(root: string, rel: string): string | undefined {
  const candidate = resolveAsset(root, rel);
  return candidate && existsSync(candidate) ? candidate : undefined;
}

/**
 * 流式返回一个文件（带 Content-Type / 长度 / 缓存头）。
 *
 * Content-Length 必须取自**正在读的那个 fd**（open 事件里 fstat），不能先 stat 再另开流：用户往
 * `main-animation/webm/` 复制或同名覆盖素材时，stat 与真正开始读之间文件会被截断/改写，
 * 一旦实际字节数少于声明的长度，这个响应就**永远不结束、也不报错**（浏览器表现为 stalled、
 * 视频 loadeddata 永不触发且无 error）——issue #62「数据断供」的成因之一。
 * 同一个 fd 的 fstat 拿到的大小与随后读出的字节天然一致。
 */
export function sendFile(res: ServerResponse, file: string, contentType: string): void {
  const stream = createReadStream(file);
  stream.once('open', (fd) => {
    if (res.destroyed || res.writableEnded) {
      stream.destroy(); // 客户端在开流前就放弃了
      return;
    }
    try {
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': fstatSync(fd).size,
        'cache-control': 'public, max-age=3600',
      });
    } catch {
      // 极端情况下 fstat 拿不到：不发长度头，交给 Node 用 chunked 收尾（长度天然一致，只是没声明）
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'public, max-age=3600' });
    }
    stream.pipe(res);
  });
  // 读失败（文件被删/权限/被占用）：直接断连，让客户端立刻看到失败，而不是无限等待
  stream.on('error', () => res.destroy());
  // 客户端提前断开（快速切动画时高频发生）→ 停读，别把整个文件读完
  res.on('close', () => stream.destroy());
}

/** 发送 JSON 响应（headers 可选：如 no-cache） */
export function sendJson(
  res: ServerResponse,
  status: number,
  obj: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/** 发送纯文本响应（素材 404/400 等显式错误文案） */
export function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/** 单次业务路由的应答（HTTP 路由与桌面管道共用同一契约；消费方各自落盘） */
export type RouteResult =
  | { kind: 'json'; status: number; obj: unknown; headers?: Record<string, string> }
  | { kind: 'text'; status: number; body: string }
  | { kind: 'file'; file: string; contentType: string };

/** 收集请求体（文本） */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((accept, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => accept(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
