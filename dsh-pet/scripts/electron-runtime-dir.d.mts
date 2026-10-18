/**
 * `electron-runtime-dir.mjs` 的类型声明（该文件是纯 JS，供打包脚本直接跑）。
 * 只给单元测试用（`src/app/electron-runtime.test.ts` 拿它和应用侧的口径对比）。
 */

/** 本应用自己的缓存根（与 `src/app/electron-runtime.ts` 的 `appCacheDir()` 同口径） */
export function appCacheDir(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): string;

/** 找一个可用的 Electron 运行时目录（找不到返回 undefined） */
export function resolveElectronRuntimeDir(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}): string | undefined;
