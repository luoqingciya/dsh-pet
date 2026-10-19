/**
 * 打包脚本用的「Electron 运行时目录」解析。
 *
 * **必须与 `src/main/electron-runtime.ts` 的 `electronLandingDir()` 同口径**——那边是应用
 * 运行期的唯一定义（开发态下载/定位走它）。打包脚本是纯 `.mjs`（`node scripts/package-app.mjs`
 * 直接跑），不能 import TS，所以这里镜像一份；`src/main/electron-runtime.test.ts` 会把两边的
 * 结果对一遍，防止再次漂移（0.9.0 就因为只改了应用侧、打包脚本还认旧路径，三平台 CI 全挂）。
 *
 * 顺序（与运行时一致）：
 *   1. `DSH_PET_ELECTRON_DIR`（显式指定，CI / 自定义安装位置）
 *   2. 本应用自己的缓存目录：win `%LOCALAPPDATA%\dsh-petNG\electron`、
 *      mac `~/Library/Caches/dsh-pet-ng/electron`、linux `$XDG_CACHE_HOME|~/.cache/dsh-pet-ng/electron`
 *   3. 旧版位置 `$DSH_HOME/electron`（默认 `~/.dsh/electron`）——只读兼容，已下过的不必重下
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 本应用自己的缓存根（与 `appCacheDir()` 同口径）。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @param {string} [home]
 */
export function appCacheDir(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'dsh-pet-ng');
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'dsh-pet-ng');
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'dsh-pet-ng');
}

/**
 * 找一个可用的 Electron 运行时目录（找不到返回 undefined，由调用方给出提示）。
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string }} [options]
 * @returns {string | undefined}
 */
export function resolveElectronRuntimeDir(options = {}) {
  const { env = process.env, platform = process.platform, home = homedir() } = options;

  const explicit = env.DSH_PET_ELECTRON_DIR;
  if (explicit && existsSync(explicit)) return explicit;

  const current = join(appCacheDir(env, platform, home), 'electron');
  if (existsSync(current)) return current;

  const legacy = join(env.DSH_HOME || join(home, '.dsh'), 'electron');
  return existsSync(legacy) ? legacy : undefined;
}
