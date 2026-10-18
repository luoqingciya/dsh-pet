/**
 * 用户数据根（`$DSH_HOME`）的解析 —— **本包唯一一份实现**。
 *
 * 口径：`process.env.DSH_HOME` 优先，缺省 `<用户主目录>/.dsh`。
 *
 * 为什么要保留 `~/.dsh` 这个默认值：应用形态下 `src/app/main.ts` 在启动最早期就把
 * `DSH_HOME` 指到自己的数据目录（`%APPDATA%\dsh-pet` 或 `<安装目录>/data`），
 * 所以默认值只在"没有应用外壳"时才会用到——那是从 DSH 插件时期沿用下来的兼容口径
 * （老用户的数据就在 `~/.dsh/dsh-pet`，`src/app/paths.ts` 的首启迁移还认它）。
 *
 * 历史上这个函数分散在两处（应用侧 `dshHomeDir()` 与 DSH 提供的 `resolveDshHome()`），
 * 脱离 DSH 后合并到这里：宿主半边与 Electron 落地目录都从这里取，避免口径漂移。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 用户数据根：`$DSH_HOME`，缺省 `~/.dsh` */
export function resolveDshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}
