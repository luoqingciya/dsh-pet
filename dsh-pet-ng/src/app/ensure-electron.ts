#!/usr/bin/env node
/**
 * 下载 Electron 运行时到 `electronLandingDir()`（本应用缓存目录下的 `electron/`，
 * 按平台为 `%LOCALAPPDATA%\dsh-petNG\electron` / `~/Library/Caches/dsh-pet-ng/electron` /
 * `~/.cache/dsh-pet-ng/electron`；可用 `DSH_PET_ELECTRON_DIR` 覆盖）。
 *
 * 为什么是这么薄的一层：真正的下载/校验/解压逻辑在 `src/app/electron-runtime.ts` 的
 * `ensureElectronDownload()` 里——应用首次启动自动下载走的也是它。以前这里有一份**重复实现**
 * （自己 import @electron/get + extract-zip），两边的镜像、版本、解压方式各写一遍，
 * 改了一处忘另一处就会出现"CI 下好了、用户跑起来又下一遍"这类问题。
 *
 * 现在只有一份实现，这里只负责调用它并把结果打印出来。
 *
 * 用法：npm run ensure:electron
 * 环境变量：DSH_PET_ELECTRON_DIR / DSH_PET_ELECTRON_VERSION / DSH_PET_ELECTRON_MIRROR
 */
import { ensureElectronDownload, resolveElectronPath } from './electron-runtime';

async function main() {
  // 先用解析器走一遍：显式路径 / npm 包 / 缓存目录 / 旧版 ~/.dsh 位置都算"已有"，
  // 避免旧用户因为换了落地目录又白下 350MB
  const existing = resolveElectronPath();
  if (existing) {
    console.log(existing);
    return 0;
  }
  const path = await ensureElectronDownload();
  if (!path) {
    console.error('[ensure-electron] 下载失败：检查网络或设置 DSH_PET_ELECTRON_MIRROR');
    return 1;
  }
  console.log(path);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[ensure-electron] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
