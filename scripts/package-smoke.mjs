#!/usr/bin/env node
/**
 * package-smoke.mjs —— 打包产物的**启动**冒烟：真的把装出来的应用跑起来，看它能不能活。
 *
 * 为什么需要：CI 只**构建**安装包，从不**运行**它；`test:ui` 跑的是源码态（`npm run app`）。
 * 于是"包里缺文件"这类问题一路绿到用户装上才暴露 —— 1.0.1 就是这么发出去的：
 * `electron-builder.yml` 的 files 列表还停在 B2 重构前（有 runtime/、没有 src/desktop/），
 * 安装版启动即崩 `Cannot find module <安装目录>/resources/app/src/desktop/windows.js`，
 * 而免安装 zip（走 package-app.mjs 的 APP_DIRS）完全正常。
 *
 * 做法：起 `<unpacked>/dsh-petNG.exe --port <端口>`，轮询 `GET /health`，拿到 200 +
 * `name=dsh-petNG` 就算过；进程提前退出或超时就红，并把 data/app.log 的尾巴打出来。
 * 数据落在产物自己的 `data/` 下（应用强制 userData = <安装目录>/data/electron），不碰真实用户数据。
 *
 * 用法：
 *   node scripts/package-smoke.mjs                      # 自动找 dist/installer/win-unpacked
 *   node scripts/package-smoke.mjs --dir <unpacked 目录> --port 7399
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WIN = process.platform === 'win32';

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') out.dir = resolve(argv[i + 1] ?? '');
    else if (a.startsWith('--dir=')) out.dir = resolve(a.slice('--dir='.length));
    else if (a === '--port') out.port = Number(argv[i + 1]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice('--port='.length));
  }
  return out;
}

const args = parseArgv(process.argv.slice(2));
const dir = args.dir ?? join(ROOT, 'dist', 'installer', 'win-unpacked');
const exe = join(dir, WIN ? 'dsh-petNG.exe' : 'dsh-petNG');
const port = args.port ?? 7399;
const TIMEOUT_MS = 60000;

if (!existsSync(exe)) {
  console.error(`[package-smoke] FAIL: 找不到可执行文件 ${exe}（先跑 npm run app:installer）`);
  process.exit(1);
}

/** 产物自带的数据目录（应用强制 userData = <安装目录>/data/electron，日志在 data/app.log） */
const logFile = join(dir, 'data', 'app.log');

function tailLog(n = 25) {
  try {
    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    return lines.slice(-n).join('\n');
  } catch {
    return '(没有日志文件)';
  }
}

/**
 * 子进程环境：**必须清掉 `ELECTRON_RUN_AS_NODE`**。
 *
 * 在 Electron 系的工具里（VS Code 终端、WorkBuddy 等）跑本脚本时，这个变量是继承来的，
 * 会让 `dsh-petNG.exe` 以 **Node 模式**启动：`--version` 打印 v24.x、`--port` 直接报
 * "bad option: --port" 然后退出（实测踩过）。CI 上没有这个变量，所以只在本地复现——
 * 但正因为"只在本地复现"，它会浪费掉排查时间，写在这里。
 */
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.DSH_PET_SKIP_MIGRATION = '1'; // 别去接管旧版本数据

const child = spawn(exe, [`--port=${port}`], {
  cwd: dir,
  stdio: 'ignore',
  env,
});

let exited = null;
child.on('exit', (code, signal) => {
  exited = { code, signal };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询 /health，直到 200 或超时 */
async function waitHealthy() {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) return { ok: false, reason: `进程提前退出（code=${exited.code} signal=${exited.signal}）` };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        return { ok: true, body };
      }
    } catch {
      /* 还没起来：继续等 */
    }
    await sleep(300);
  }
  return { ok: false, reason: `${TIMEOUT_MS / 1000}s 内 /health 没有响应` };
}

function kill() {
  if (!child.pid || exited) return;
  try {
    // 用 spawnSync：异步 taskkill 会随脚本退出而丢掉，留下卡在崩溃对话框里的孤儿进程
    if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch {
    /* 已经没了 */
  }
}

const result = await waitHealthy();
kill();

if (!result.ok) {
  console.error(`[package-smoke] FAIL: ${result.reason}`);
  console.error(`[package-smoke] 应用日志（${logFile}）尾巴：\n${tailLog()}`);
  process.exit(1);
}

const name = result.body?.name ?? '(未知)';
const version = result.body?.version ?? '(未知)';
if (!String(name).includes('dsh-petNG')) {
  console.error(`[package-smoke] FAIL: /health 返回的 name 不对：${JSON.stringify(result.body)}`);
  process.exit(1);
}
console.log(`[package-smoke] ok: 打包产物能启动（${name} ${version}，端口 ${port}）`);
