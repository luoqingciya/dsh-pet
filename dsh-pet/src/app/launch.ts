#!/usr/bin/env node
/**
 * dsh-pet 本地应用启动器（Node 运行，不依赖 DSH）。
 *
 * 它只做三件事：
 *   1. 找 Electron（优先 `DSH_PET_ELECTRON_PATH`，其次本机缓存 `$DSH_HOME/electron`，
 *      都没有就下载一次——与插件桌面模式同一套解析与下载实现，不另写一份）；
 *   2. 用这份 Electron 拉起 `lib/app-main.cjs`（主进程），把包根经环境变量传下去
 *      （主进程据此找 assets / lib / runtime，不依赖 cwd）；
 *   3. 透传退出码与信号。
 *
 * 为什么主进程走 CJS：Electron 43 的 ESM 主进程里 `import 'electron'` 会被 Node 的
 * 解析器判给 `node_modules/electron`（那个包导出的是一串路径字符串），拿不到 `app`；
 * CJS 的 `require('electron')` 才是运行时模块。产物因此命名为 `.cjs`。
 *
 * 用法：
 *   npm run app                 # 仓库内（先构建）
 *   npx dsh-pet-app             # 装成全局/本地包之后
 *   node lib/app-launch.js --port 3100
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureElectronDownload, resolveElectronPath } from '../host/helper-process';

/** 包根（本文件在 lib/ 下） */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 解析命令行：只支持 `--port`（其余原样报错，避免"静默忽略"） */
function parsePort(argv: string[]): { port?: number; error?: string } {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--port' || arg.startsWith('--port=')) {
      const raw = arg === '--port' ? String(argv[index + 1] ?? '') : arg.slice('--port='.length);
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        return { error: `--port 需要 1..65535 的整数，收到 ${JSON.stringify(raw)}` };
      }
      return { port: value };
    }
    if (arg === '-h' || arg === '--help') {
      console.log('用法：dsh-pet-app [--port <端口>]');
      process.exit(0);
    }
    return { error: `未知参数：${arg}` };
  }
  return {};
}

async function main(): Promise<number> {
  const parsed = parsePort(process.argv.slice(2));
  if (parsed.error) {
    console.error(`dsh-pet-app: ${parsed.error}`);
    return 2;
  }

  const mainScript = join(ROOT, 'lib', 'app-main.cjs');
  if (!existsSync(mainScript)) {
    console.error(`dsh-pet-app: 缺少构建产物 ${mainScript}，请先运行 npm run build`);
    return 1;
  }

  let electron = resolveElectronPath([process.env.DSH_PET_ELECTRON_PATH]);
  if (!electron) {
    console.log('[dsh-pet] 未找到 Electron，正在下载（首次启动一次，之后走缓存）…');
    electron = await ensureElectronDownload();
  }
  if (!electron) {
    console.error(
      '[dsh-pet] Electron 不可用：请设置 DSH_PET_ELECTRON_PATH 指向 electron 可执行文件，或检查网络后重试。',
    );
    return 1;
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_PET_PACKAGE_ROOT: ROOT,
    DSH_PET_ELECTRON_PATH: electron,
  };
  // 该变量存在时 Electron 会以纯 Node 模式启动（拿不到 app / BrowserWindow），必须删掉而不是置空
  delete env.ELECTRON_RUN_AS_NODE;
  if (parsed.port !== undefined) env.DSH_PET_APP_PORT = String(parsed.port);

  const child = spawn(electron, [mainScript], { stdio: 'inherit', env });
  // Ctrl+C 交给子进程处理（它会走自己的收尾流程），父进程等它退出
  const forward = (signal: NodeJS.Signals): void => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  return await new Promise<number>((accept) => {
    child.on('exit', (code, signal) => {
      if (signal) {
        console.log(`[dsh-pet] 已退出（${signal}）`);
        accept(0);
        return;
      }
      accept(code ?? 0);
    });
    child.on('error', (error) => {
      console.error(`[dsh-pet] 启动失败：${error.message}`);
      accept(1);
    });
  });
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(`dsh-pet-app: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  });
