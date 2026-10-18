/**
 * UI 用例的公共底座：找 Electron、拿空闲端口、等条件成立、起 mock 服务。
 *
 * 为什么端口要现取（而不是每个文件写死 7411/7412/7416/7417/7422/7426）：
 * 上一轮跑挂了留下进程时，应用的 `listenAppServer` 会**顺延**到下一个端口，而用例还在等
 * 原来那个端口的 `/health` —— 表现是整轮挂死（实测两次，各挂 3 分钟以上），而不是一条失败。
 * 现在每个用例启动前 `bind(0)` 现拿一个，撞端口的可能性降到可忽略；真起不来也会在
 * `launchApp` 里快速抛错，不会无限等。
 *
 * 文件名以 `_` 开头：`npm run test:ui` 的 glob 是 `scripts/tests/*.test.mjs`，不会把它当用例。
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron } from 'playwright';

import { resolveElectronRuntimeDir } from '../electron-runtime-dir.mjs';

/** 包根目录 */
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 要拉起的那份 Electron。
 *
 * 优先 `DSH_PET_ELECTRON`；没设就用应用自己的运行时缓存（`npm run ensure:electron` 下的那份），
 * 于是本地和 CI 都只需要 `npm run test:ui`，不必再手工指路径。
 */
export function electronExe() {
  if (process.env.DSH_PET_ELECTRON) return process.env.DSH_PET_ELECTRON;
  const dir = resolveElectronRuntimeDir();
  if (!dir) return undefined;
  const rel =
    process.platform === 'win32'
      ? 'electron.exe'
      : process.platform === 'darwin'
        ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
        : 'electron';
  return join(dir, rel);
}

/** 现取一个空闲端口（bind 0 → 读回端口 → 关掉） */
export function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/** 等一个条件成立（最多 timeoutMs），返回是否成立 */
export async function waitFor(check, timeoutMs = 15000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

/**
 * 起一个本地 mock 服务（占一个空闲端口）。
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler
 * @returns {Promise<{ server: import('node:http').Server, port: number, base: string, close(): void }>}
 */
export async function listenMock(handler) {
  const server = createHttpServer(handler);
  const port = await new Promise((resolvePort) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolvePort(typeof address === 'object' && address ? address.port : 0);
    });
  });
  return {
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  };
}

/**
 * 起一个应用实例（独立 profile + 独立端口），等 `/health` 通过。
 *
 * @param {object} [options]
 * @param {string} [options.tag]        profile 目录前缀，方便排障时认出是哪个用例
 * @param {NodeJS.ProcessEnv} [options.env] 额外环境变量
 * @param {string[]} [options.args]     追加到主进程脚本之后的参数
 * @param {boolean} [options.passPortArg] 是否用 `--port` 传端口（默认 true；有用例专门验证命令行开关）
 * @param {boolean} [options.waitHealth]  是否等 `/health`（默认 true）
 * @param {number} [options.healthTimeout] 等健康检查的上限（默认 20s）
 * @param {(profile: string) => void} [options.prepare] 启动前预置 profile（写配置等）
 * @returns {Promise<{ app: any, port: number, base: string, profile: string, exited: Promise<any> }>}
 */
export async function launchApp(options = {}) {
  const executablePath = options.executablePath ?? electronExe();
  if (!executablePath) {
    throw new Error('找不到 Electron：设置 DSH_PET_ELECTRON，或先跑一次 npm run ensure:electron');
  }
  const port = options.port ?? (await freePort());
  const profile = mkdtempSync(join(tmpdir(), `dsh-pet-${options.tag ?? 'ui'}-`));
  options.prepare?.(profile);
  const env = { ...process.env, ...options.env };
  // 有用例专门验证「端口只从 --port 来」，那就不能塞环境变量
  if (options.portEnv !== false) env.DSH_PET_APP_PORT = String(port);
  else delete env.DSH_PET_APP_PORT;
  delete env.ELECTRON_RUN_AS_NODE;

  const args = [join(root, 'lib', 'app-main.cjs'), `--user-data-dir=${profile}`];
  if (options.passPortArg !== false) args.push('--port', String(port));
  args.push(...(options.args ?? []));

  const app = await _electron.launch({ executablePath, args, env });
  const proc = app.process();
  const exited = new Promise((done) => proc.once('exit', (code, signal) => done({ code, signal })));
  const base = `http://127.0.0.1:${port}`;

  if (options.waitHealth !== false) {
    const up = await waitFor(
      () =>
        fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
          .then((r) => r.ok)
          .catch(() => false),
      options.healthTimeout ?? 20000,
    );
    if (!up) {
      await app.close().catch(() => {});
      throw new Error(`本地服务没在 ${options.healthTimeout ?? 20000}ms 内起来（端口 ${port}）`);
    }
  }

  return { app, port, base, profile, exited };
}
