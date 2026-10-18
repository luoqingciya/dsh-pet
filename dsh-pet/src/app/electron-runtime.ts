/**
 * Electron 运行时：定位 / 下载 / 解压。
 *
 * 谁在用：
 *   - **开发态启动器**（`lib/app-launch.js`）：`npm run app` 时找一份 Electron 来跑主进程；
 *   - `npm run ensure:electron`（CI 与手动修复）；
 *   - `/config/meta` 的「存储」区展示 Electron 落地目录。
 *
 * 合并进程后，**运行期不再需要它**：应用自己就是 Electron，桌宠窗口跑在同一个进程里，
 * 没有"再拉一个 Electron"这回事。因此这里只剩下"给开发态准备一份运行时"这一件事，
 * 原先的 `HelperProcess`（spawn/守护/重启退避/熔断/管道协议）整块删除。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { downloadArtifact } from '@electron/get';

const require = createRequire(import.meta.url);

/** $DSH_HOME（默认 ~/.dsh）：开发态 Electron 的落地根 */
export function dshHomeDir(): string {
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  return process.env.DSH_HOME || join(userProfile, '.dsh');
}

// ---------- 平台适配（win32 / darwin / linux）----------
// Electron 官方发布包按平台/架构不同：win32 解压出 electron.exe + 散文件；
// darwin 解压出 Electron.app（可执行文件在 Contents/MacOS/Electron）；linux 是 electron 单文件。

/** 当前平台标识（win32 / darwin / linux） */
const PLAT = process.platform;

/** $DSH_HOME/electron 落地目录下，可执行文件的相对路径（按平台） */
const ELECTRON_REL =
  PLAT === 'win32'
    ? 'electron.exe'
    : PLAT === 'darwin'
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron';

/**
 * Electron 运行时落地目录（$DSH_HOME/electron）—— 下载解压的目标，
 * 也是设置页「存储」里让用户清理的那个目录。
 *
 * 唯一定义处：解析（resolveElectronPath / defaultElectronExe）与下载
 * （ensureElectronDownload）全部走这里，避免同一个目录字面量在多个模块各写一遍。
 */
export function electronLandingDir(): string {
  return join(dshHomeDir(), 'electron');
}

/** Electron 落地路径：$DSH_HOME/electron/<按平台的可执行文件>。 */
export function defaultElectronExe(): string {
  return join(electronLandingDir(), ELECTRON_REL);
}

/**
 * 解析 Electron 可执行文件。优先级：
 *   1. 显式候选（用户配置）/ DSH_PET_ELECTRON_PATH 环境变量
 *   2. 本机已安装的 electron npm 包（require('electron') 返回二进制路径）
 *   3. $DSH_HOME/electron（默认 ~/.dsh/electron）—— ensureElectronDownload 的落地路径
 *
 * 只认这三处，不去 npm 全局目录 / Program Files / /usr/bin 探测别人装的 Electron
 * （版本不可控，且会把"找不到"变成"用了一个奇怪的版本"）。
 */
export function resolveElectronPath(candidates: Array<string | undefined> = []): string | undefined {
  const seen = new Set<string>();
  const list: string[] = [];
  const push = (value: string | undefined | null): void => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    list.push(value);
  };
  for (const value of candidates) push(value);
  if (process.env.DSH_PET_ELECTRON_PATH) push(process.env.DSH_PET_ELECTRON_PATH);
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string' && resolved) push(resolved);
  } catch {
    /* electron 未安装时跳过 */
  }
  push(defaultElectronExe());
  return list.find((value) => existsSync(value));
}

export interface EnsureElectronOptions {
  /** Electron 版本号（默认 43.3.0，可被 DSH_PET_ELECTRON_VERSION 覆盖）。 */
  version?: string;
  /** 下载镜像（默认 npmmirror，可被 DSH_PET_ELECTRON_MIRROR 覆盖）。 */
  mirror?: string;
  /** 单次下载超时（默认 10 分钟）。 */
  timeoutMs?: number;
}

/**
 * 进程内下载并解压 Electron 到 $DSH_HOME/electron。
 * 不 spawn 子进程（`process.execPath` 在 Electron 里指向宿主 exe，调脚本会再拉起一个自己）。
 * 已存在则原样返回；失败返回 undefined。
 */
export async function ensureElectronDownload(options: EnsureElectronOptions = {}): Promise<string | undefined> {
  const version = options.version || process.env.DSH_PET_ELECTRON_VERSION || '43.3.0';
  const mirror = options.mirror || process.env.DSH_PET_ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const targetDir = electronLandingDir();
  const exe = defaultElectronExe();
  if (existsSync(exe)) return exe;

  // 下载日志用 console 直出（这条路径只在开发态/CI 走，没有应用日志可用）
  const log = (message: string): void => console.log(`[dsh-pet] ${message}`);
  const warn = (message: string): void => console.warn(`[dsh-pet] ${message}`);
  const startedAt = Date.now();

  log(`Electron not found, downloading v${version} (${PLAT}-${process.arch}) ...`);

  try {
    mkdirSync(targetDir, { recursive: true });
    // 官方 @electron/get 下载：负责 URL 拼装、镜像、SHA256 校验（sumchecker）、下载缓存
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Electron download timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    let nextLogAt = Date.now() + 3000;
    try {
      const zipPath = await downloadArtifact({
        version: `v${version}`,
        artifactName: 'electron',
        // platform/arch 不传：@electron/get 用宿主平台与架构自动推断
        mirrorOptions: { mirror: mirror.replace(/\/$/, '') + '/' },
        downloadOptions: {
          signal: controller.signal,
          quiet: true,
          getProgressCallback: async (progress: { transferred: number; total: number | null }) => {
            const now = Date.now();
            if (!progress.total || now < nextLogAt) return;
            nextLogAt = now + 3000;
            log(
              `downloading ${(progress.transferred / 1024 / 1024).toFixed(1)}MB / ${(progress.total / 1024 / 1024).toFixed(1)}MB`,
            );
          },
        },
      });
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`download complete (${seconds}s), extracting to ${targetDir} ...`);
      // 官方 @electron-internal/extract-zip 解压：纯 Node + native binding，跨平台一致，
      // 正确处理 symlink 与文件权限。
      //
      // 为什么用**动态 import**而不是顶层静态 import：该包是 N-API 原生模块，预编译产物只覆盖
      // 官方列出的 target。静态 import 会在模块求值期就执行 binding.js 顶层的
      // `if (!nativeBinding) throw`，于是**只想用应用模式**的用户也会因为"入口加载失败"而
      // 整个起不来。改成按需加载后，这条路径只在真要解压时才走。
      const { default: extract } = await import('@electron-internal/extract-zip');
      await extract(zipPath, { dir: targetDir });
      if (!existsSync(exe)) {
        throw new Error(`Electron zip extracted, but ${ELECTRON_REL} not found`);
      }
      const readySeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`ready in ${readySeconds}s: ${exe}`);
      return exe;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    warn(`ensure failed: ${error instanceof Error ? error.message : String(error)}`);
    warn('Set DSH_PET_ELECTRON_PATH to an existing Electron, or retry later.');
    return undefined;
  }
}
