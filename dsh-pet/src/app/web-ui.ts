/**
 * 本地应用的 Web 界面层：把设置页与「本地服务」接口挂在同一个本地服务上。
 *
 * 为什么走 HTTP 而不是 Electron IPC：设置页里的「桌宠配置」组件（`src/client/settings.ts`）
 * 是**按 DSH 插件环境写的**——它自己 `fetch('/dsh-pet-7340/config')`、自己读
 * `--dsw-alias-*` 主题变量。把它原样复用、由同一个 origin 提供页面，比为了 IPC 改一整套
 * 数据通路要稳得多，也让页面在普通浏览器里打开同样能用（排障时很方便）。
 *
 * 只提供 4 个接口（够用即止，不做通用后台）：
 *   GET  /app/api/config     读配置视图（密钥只报「有没有配」）
 *   POST /app/api/config     保存（配置 + 密钥，白名单重建）
 *   POST /app/api/test       用当前设置试生成一句话（验证端点/密钥/模型是否可用）
 *   POST /app/api/open-dir   在系统文件管理器里打开数据目录
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

import {
  BALANCE_PROVIDERS,
  configView,
  readAppConfig,
  readSecrets,
  saveAppConfig,
  saveSecrets,
  type AppConfig,
} from './local-config';
import type { LlmService } from './llm-openai';

/** 设置页资源在包内的位置（构建产物：lib/app-settings.js 与 lib/app-settings.css） */
export interface WebUiPaths {
  /** 包根目录 */
  root: string;
}

/** 注入给界面层的能力（Electron 相关动作由主进程提供，本模块不 import electron） */
export interface WebUiDeps {
  paths: WebUiPaths;
  /** 运行时信息（端口、版本、数据目录） */
  runtime(): Record<string, unknown>;
  /** 当前 llm 服务（测试用） */
  llm(): LlmService;
  /** 在系统文件管理器里打开目录 */
  openPath(dir: string): Promise<void>;
  /** 数据目录 */
  dataDir(): string;
}

/** 读请求体（限 1MiB，避免被本地脚本灌爆内存） */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((accept, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大（上限 1MiB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => accept(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** 设置页 HTML（内联样式；页面只有一张，没必要再拆 css 文件） */
function pageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<!-- 设置页只加载同源资源：CSP 收紧到 'self'（样式允许内联——设置页组件用 <style> 注入样式表）。
     没有这条策略时 Electron 会持续报 "Insecure Content-Security-Policy" 警告。 -->
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:" />
<title>dsh-pet 设置</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div id="root"><div class="boot">正在加载设置…</div></div>
<script src="/app/settings.js"></script>
</body>
</html>`;
}

/** 页面主题与骨架样式（把 DSH 的 --dsw-alias-* 语义变量映射到本地配色） */
const PAGE_CSS = `
:root{
  color-scheme: dark;
  --dsw-alias-bg-layer-1:#1b1b1f;
  --dsw-alias-border-l1:#2f2f36;
  --dsw-alias-border-l2:#3d3d46;
  --dsw-alias-label-primary:#f2f2f5;
  --dsw-alias-label-secondary:#b9b9c2;
  --dsw-alias-label-tertiary:#8a8a95;
  --dsw-alias-label-dimmed:#6f6f79;
  --dsw-alias-label-caption:#9a9aa4;
  --dsw-alias-interactive-bg-hover:rgba(255,255,255,.06);
  --dsw-alias-interactive-bg-active:rgba(255,255,255,.1);
  --dsw-alias-button-info-fill:#3b6cf6;
  --dsw-alias-button-info-hover:#4f7cf8;
  --dsw-alias-state-business-primary:#6ea8fe;
  --dsw-alias-state-error-primary:#f06a6a;
  --dsw-alias-state-error-secondary:rgba(240,106,106,.16);
  --dsw-alias-state-success-primary:#4cc38a;
  --dsw-alias-tooltip-bg:#2a2a31;
  --app-bg:#141417;
  --app-card:#1b1b1f;
  --app-line:#2f2f36;
}
@media (prefers-color-scheme: light){
  :root{
    color-scheme: light;
    --dsw-alias-bg-layer-1:#ffffff;
    --dsw-alias-border-l1:#e6e6ea;
    --dsw-alias-border-l2:#d6d6dc;
    --dsw-alias-label-primary:#1d1d21;
    --dsw-alias-label-secondary:#4a4a52;
    --dsw-alias-label-tertiary:#6b6b74;
    --dsw-alias-label-dimmed:#8a8a92;
    --dsw-alias-label-caption:#5c5c64;
    --dsw-alias-interactive-bg-hover:rgba(0,0,0,.05);
    --dsw-alias-interactive-bg-active:rgba(0,0,0,.09);
    --dsw-alias-tooltip-bg:#2a2a31;
    --app-bg:#f6f6f8;
    --app-card:#ffffff;
    --app-line:#e6e6ea;
  }
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{
  background:var(--app-bg);color:var(--dsw-alias-label-primary);
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
.boot{padding:40px;color:var(--dsw-alias-label-tertiary)}
.shell{max-width:820px;margin:0 auto;padding:28px 24px 60px}
.top{display:flex;align-items:center;gap:12px;margin-bottom:18px}
.top h1{font-size:18px;margin:0;font-weight:600;letter-spacing:.2px}
.top .ver{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.tabs{display:flex;gap:6px;border-bottom:1px solid var(--app-line);margin-bottom:22px}
.tab{
  appearance:none;background:none;border:none;color:var(--dsw-alias-label-secondary);
  padding:10px 14px;font-size:14px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;
}
.tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-button-info-fill)}
.tab:hover{color:var(--dsw-alias-label-primary)}
.card{background:var(--app-card);border:1px solid var(--app-line);border-radius:12px;padding:18px;margin-bottom:16px}
.card h2{font-size:14px;margin:0 0 4px;font-weight:600}
.card .hint{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0 0 14px}
.row{display:grid;grid-template-columns:150px 1fr;gap:10px;align-items:center;margin-bottom:12px}
.row > label{color:var(--dsw-alias-label-secondary);font-size:13px}
input[type=text],input[type=password],select{
  width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--app-bg);color:var(--dsw-alias-label-primary);font:inherit;outline:none;
}
input:focus,select:focus{border-color:var(--dsw-alias-button-info-fill)}
.btn{
  appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);
  padding:8px 14px;border-radius:8px;font:inherit;cursor:pointer;
}
.btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.btn.primary{background:var(--dsw-alias-button-info-fill);border-color:transparent;color:#fff}
.btn.primary:hover{background:var(--dsw-alias-button-info-hover)}
.btn:disabled{opacity:.5;cursor:default}
.actions{display:flex;gap:10px;align-items:center;margin-top:16px}
.status{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.status.ok{color:var(--dsw-alias-state-success-primary)}
.status.err{color:var(--dsw-alias-state-error-primary)}
.kv{display:grid;grid-template-columns:150px 1fr;gap:6px 10px;font-size:13px}
.kv dt{color:var(--dsw-alias-label-tertiary)}
.kv dd{margin:0;color:var(--dsw-alias-label-secondary);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.chk{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.warn{font-size:12px;color:var(--dsw-alias-state-error-primary);margin-top:6px}
.pill{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-secondary)}
.pill.ok{background:rgba(76,195,138,.16);color:var(--dsw-alias-state-success-primary)}
`;

/** 静态资源响应（设置页 bundle） */
function sendFile(res: ServerResponse, file: string, type: string): void {
  try {
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh-pet: 设置页资源缺失（请先 npm run build）');
  }
}

/** 测试生成：用当前设置让模型说一句「在」，把失败原因原样带回去 */
async function testGeneration(llm: LlmService, provider: string, model: string): Promise<unknown> {
  const startedAt = Date.now();
  try {
    let text = '';
    for await (const chunk of llm.stream({
      provider,
      model,
      system: '你是桌宠。只回复两个字：在的',
      messages: [{ role: 'user', content: [{ type: 'text', text: '在吗' }] }],
      signal: AbortSignal.timeout(30_000),
    })) {
      text += chunk.text;
      if (text.length > 200) break;
    }
    return { ok: true, text: text.trim().slice(0, 200), ms: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), ms: Date.now() - startedAt };
  }
}

/**
 * 建「额外路由」处理函数（交给 `listenStandaloneServer` 的 `extra`）。
 * @param deps 运行时能力
 * @returns `(req, res, pathname) => 是否已处理`
 */
export function createWebUi(deps: WebUiDeps) {
  const settingsJs = join(deps.paths.root, 'lib', 'app-settings.js');
  return async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
    const method = req.method ?? 'GET';

    if (pathname === '/') {
      res.writeHead(302, { location: '/app/' });
      res.end();
      return true;
    }
    if (pathname === '/app' || pathname === '/app/' || pathname === '/app/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(pageHtml());
      return true;
    }
    if (pathname === '/app/settings.js') {
      sendFile(res, settingsJs, 'text/javascript; charset=utf-8');
      return true;
    }

    if (pathname === '/app/api/config' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        config: configView(),
        runtime: deps.runtime(),
        balanceProviders: BALANCE_PROVIDERS,
      });
      return true;
    }

    if (pathname === '/app/api/config' && method === 'POST') {
      try {
        const raw: unknown = JSON.parse(await readBody(req));
        const body = (raw ?? {}) as { config?: unknown; keys?: unknown };
        // 只改配置里出现的字段：整份提交时等价于覆盖，局部提交时保留其余字段
        const current: AppConfig = readAppConfig();
        const patch = { ...current, ...((body.config as Record<string, unknown>) ?? {}) };
        saveAppConfig(patch);
        if (body.keys !== undefined) saveSecrets(body.keys);
        sendJson(res, 200, { ok: true, config: configView(readAppConfig(), readSecrets()) });
      } catch (error) {
        sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }

    if (pathname === '/app/api/test' && method === 'POST') {
      try {
        const raw: unknown = JSON.parse((await readBody(req)) || '{}');
        const body = (raw ?? {}) as { provider?: unknown; model?: unknown };
        const config = readAppConfig();
        const provider = String(body.provider ?? config.provider);
        const model = String(body.model ?? config.model);
        sendJson(res, 200, await testGeneration(deps.llm(), provider, model));
      } catch (error) {
        sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }

    if (pathname === '/app/api/open-dir' && method === 'POST') {
      await deps.openPath(deps.dataDir());
      sendJson(res, 200, { ok: true, dir: deps.dataDir() });
      return true;
    }

    return false;
  };
}
