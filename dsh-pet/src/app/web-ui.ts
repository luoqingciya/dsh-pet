/**
 * 本地应用的 Web 界面层：设置页与「本地服务」接口挂在同一个本地服务上。
 *
 * 为什么走 HTTP 而不是 Electron IPC：页面与宿主同源，`/dsh-pet-7340/*`（宿主半边）
 * 与 `/app/api/*`（本文件）都能直接 fetch，不必为 IPC 再铺一条数据通路；
 * 顺带的好处是排障时可以用普通浏览器打开同一页。
 *
 * 只提供这几个接口（够用即止，不做通用后台）：
 *   GET  /app/api/config     读配置视图（密钥只报「有没有配」）
 *   POST /app/api/config     保存（配置 + 密钥，白名单重建）
 *   POST /app/api/test       用当前设置试生成一句话（验证端点/密钥/模型是否可用）
 *   POST /app/api/open-dir   在系统文件管理器里打开数据目录
 *   GET  /app/api/autostart  读开机自启状态（以系统为准）
 *   POST /app/api/autostart  开关开机自启（立即生效，不跟「保存」走）
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
import type { AutoStartState } from './autostart';
import { checkForUpdate } from './update-check';

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
  /** 退出应用（设置页「退出」按钮：托盘菜单之外的第二条退出路径） */
  quit(): void;
  /** 读开机自启状态（系统为准，见 autostart.ts） */
  autoStart(): AutoStartState;
  /** 开关开机自启（写系统；失败抛错） */
  setAutoStart(enabled: boolean): AutoStartState;
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
  --app-bg:#141417;
  --app-card:#1b1b1f;
  --app-line:#2f2f36;
  --app-line-strong:#3d3d46;
  --app-text:#f2f2f5;
  --app-text-2:#b9b9c2;
  --app-text-3:#8a8a95;
  --app-hover:rgba(255,255,255,.06);
  --app-active:rgba(255,255,255,.1);
  --app-accent:#3b6cf6;
  --app-accent-hover:#4f7cf8;
  --app-ok:#4cc38a;
  --app-err:#f06a6a;
}
@media (prefers-color-scheme: light){
  :root{
    color-scheme: light;
    --app-bg:#f6f6f8;
    --app-card:#ffffff;
    --app-line:#e6e6ea;
    --app-line-strong:#d6d6dc;
    --app-text:#1d1d21;
    --app-text-2:#4a4a52;
    --app-text-3:#6b6b74;
    --app-hover:rgba(0,0,0,.05);
    --app-active:rgba(0,0,0,.09);
    --app-ok:#1f9d63;
    --app-err:#c93c3c;
  }
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{
  background:var(--app-bg);color:var(--app-text);
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
.boot{padding:40px;color:var(--app-text-3)}
.shell{max-width:820px;margin:0 auto;padding:28px 24px 60px}
.top{display:flex;align-items:baseline;gap:12px;margin-bottom:18px}
.top h1{font-size:18px;margin:0;font-weight:600;letter-spacing:.2px}
.top .ver{font-size:12px;color:var(--app-text-3)}
.tabs{display:flex;gap:6px;border-bottom:1px solid var(--app-line);margin-bottom:22px}
.tab{
  appearance:none;background:none;border:none;color:var(--app-text-2);
  padding:10px 14px;font-size:14px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;
}
.tab[aria-selected="true"]{color:var(--app-text);border-bottom-color:var(--app-accent)}
.tab:hover{color:var(--app-text)}
.card{background:var(--app-card);border:1px solid var(--app-line);border-radius:12px;padding:18px;margin-bottom:16px}
.card h2{font-size:14px;margin:0 0 4px;font-weight:600}
.card .hint{color:var(--app-text-3);font-size:12px;margin:0 0 14px;line-height:1.7}
.card .hint code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
details.card>summary{cursor:pointer;font-size:14px;font-weight:600;list-style:none;outline:none}
details.card>summary::-webkit-details-marker{display:none}
details.card>summary::after{content:"▾";float:right;color:var(--app-text-3)}
details.card[open]>summary::after{content:"▴"}
details.card[open]>summary{margin-bottom:14px}
.row{display:grid;grid-template-columns:110px 1fr;gap:10px;align-items:center;margin-bottom:12px}
.row > label{color:var(--app-text-2);font-size:13px}
/* 「模型」输入框的自绘建议列表（替代原生 datalist：原生弹层不跟页面 zoom，150% 屏上只有 2/3 大） */
.suggest{position:relative}
.suggest-list{
  position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:20;margin:0;padding:4px;
  list-style:none;background:var(--app-card);border:1px solid var(--app-line-strong);border-radius:8px;
  box-shadow:0 12px 32px rgba(0,0,0,.4);max-height:240px;overflow-y:auto;
}
.suggest-list li{
  padding:6px 10px;border-radius:6px;font-size:13px;line-height:1.5;color:var(--app-text);
  cursor:default;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.suggest-list li.is-active{background:var(--app-accent);color:#fff}
input[type=text],input[type=password],input[type=number],select{
  width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--app-line-strong);
  background:var(--app-bg);color:var(--app-text);font:inherit;outline:none;
}
input[type=number]{width:110px}
input:focus,select:focus{border-color:var(--app-accent)}
input[type=checkbox]{accent-color:var(--app-accent);width:15px;height:15px;cursor:pointer}
.btn{
  appearance:none;border:1px solid var(--app-line-strong);background:transparent;color:var(--app-text);
  padding:8px 14px;border-radius:8px;font:inherit;cursor:pointer;white-space:nowrap;
}
.btn:hover{background:var(--app-hover)}
.btn.primary{background:var(--app-accent);border-color:transparent;color:#fff}
.btn.primary:hover{background:var(--app-accent-hover)}
.btn:disabled{opacity:.5;cursor:default}
.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:16px}
.status{font-size:12px;color:var(--app-text-3)}
.status.ok{color:var(--app-ok)}
.status.err{color:var(--app-err)}
.kv{display:grid;grid-template-columns:110px 1fr;gap:6px 10px;font-size:13px;margin:0 0 8px}
.kv dt{color:var(--app-text-3)}
.kv dd{margin:0;color:var(--app-text-2);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.chk{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--app-text-2);cursor:pointer}
.switches{display:flex;flex-wrap:wrap;gap:14px}
.inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.unit{font-size:12px;color:var(--app-text-3);white-space:nowrap}
.warn{font-size:12px;color:var(--app-err);margin-top:6px}
.pill{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--app-active);color:var(--app-text-2)}
.pill.ok{background:rgba(76,195,138,.16);color:var(--app-ok)}
.pet-list{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px}
.pet-chip{
  appearance:none;border:1px solid var(--app-line-strong);background:transparent;color:var(--app-text-2);
  padding:7px 12px;border-radius:999px;font:inherit;font-size:13px;cursor:pointer;display:flex;gap:8px;align-items:center;
}
.pet-chip:hover{background:var(--app-hover)}
.pet-chip.is-active{border-color:var(--app-accent);color:var(--app-text);background:var(--app-hover)}
.pet-chip__meta{font-size:11px;color:var(--app-text-3)}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:10}
.modal{background:var(--app-card);border:1px solid var(--app-line);border-radius:12px;padding:20px;max-width:440px;width:calc(100% - 48px)}
.modal h3{margin:0 0 8px;font-size:15px}
.modal p{margin:0;color:var(--app-text-2);font-size:13px;line-height:1.7}
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

    /**
     * 手动检查更新（设置页「更新 → 立即检查」按钮）。
     *
     * 托盘菜单也有「检查更新」，但托盘菜单是原生控件、在 150% 屏上偏小；设置页是正常缩放的
     * 页面，按钮更显眼。两条路走同一份 `checkForUpdate`，口径完全一致。
     */
    if (pathname === '/app/api/update-check' && method === 'POST') {
      try {
        const current = String(deps.runtime().version ?? '');
        const result = await checkForUpdate({ current });
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 200, {
          ok: true,
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }

    /**
     * 开机自启：读 / 写。
     *
     * 独立成两个接口而不是塞进 `/app/api/config`：它不是"配置"，而是**立刻生效的系统状态**
     * （Windows 注册表 / macOS 登录项 / Linux 的 .desktop），也不该跟着「保存/放弃修改」走。
     * 状态以系统为准，所以写入后把重新读出来的结果回给页面，避免"以为开了其实没开"。
     */
    if (pathname === '/app/api/autostart' && method === 'GET') {
      sendJson(res, 200, { ok: true, state: deps.autoStart() });
      return true;
    }

    if (pathname === '/app/api/autostart' && method === 'POST') {
      try {
        const raw: unknown = JSON.parse((await readBody(req)) || '{}');
        const enabled = Boolean((raw as { enabled?: unknown } | null)?.enabled);
        sendJson(res, 200, { ok: true, state: deps.setAutoStart(enabled) });
      } catch (error) {
        sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }

    /**
     * 退出应用。设置页留一个显眼的出口：自绘托盘菜单万一出问题，用户不至于只能去任务管理器。
     * 与 `/shutdown` 一样先回话再退（延迟 100ms 让响应 flush 出去）。
     */
    if (pathname === '/app/api/quit' && method === 'POST') {
      sendJson(res, 200, { ok: true, quitting: true });
      setTimeout(() => deps.quit(), 100);
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
