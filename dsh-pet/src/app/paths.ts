/**
 * 本地应用的数据目录与迁移（不依赖 DSH）。
 *
 * 目录口径：`$DSH_HOME` —— 由 Electron 主进程在启动最早期设为 `app.getPath('userData')`
 * （Windows 为 `%APPDATA%\dsh-pet`，macOS 为 `~/Library/Application Support/dsh-pet`）。
 * 这样插件宿主半边原有的全部路径推导（`$DSH_HOME/dsh-pet/main-config.jsonc`、
 * `main-animation/`、`pet/`、`memory.json`）**一行不改**就落到应用自己的数据目录里，
 * 也就不会和用户机器上真实的 DSH 安装互相踩。
 *
 * 首次启动做一次「老配置接管」：若 `<用户目录>/.dsh/dsh-pet` 存在而应用目录里还没有
 * `dsh-pet/`，整目录复制过来——用户从 DSH 插件迁移过来时，大小/位置/自定义素材/pet pack
 * 全部保留，不需要重新配一遍。
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveDshHome } from '../host/standalone/home-paths';

/** 应用数据根目录（= 宿主半边眼里的 DSH_HOME） */
export function appHomeDir(): string {
  // 口径的唯一实现在 host/standalone/home-paths.ts（宿主半边也用它），这里只转调
  return resolveDshHome();
}

/** 桌宠数据目录（配置 / 素材 / 记忆） */
export function petDataDir(): string {
  return join(appHomeDir(), 'dsh-pet');
}

/** 本地应用配置（服务商 / 模型 / 通知开关；**不含密钥**） */
export function appConfigFile(): string {
  return join(petDataDir(), 'app-config.json');
}

/** 本地密钥（provider key 名 → 值；单独一份、权限收紧） */
export function secretsFile(): string {
  return join(petDataDir(), 'secrets.json');
}

/** 旧版（DSH 插件时期）数据目录 */
function legacyPetDataDir(): string {
  return join(homedir(), '.dsh', 'dsh-pet');
}

/**
 * 首次启动时接管旧配置。
 *
 * 只在「新目录不存在 + 旧目录存在」时动作一次；复制失败只告警不阻断启动——
 * 最坏情况是用户重新配一遍，而不是应用打不开。
 *
 * @param log 告警输出（主进程传 console.warn）
 * @returns 是否真的复制了
 */
export function migrateLegacyData(log: (message: string) => void): boolean {
  const target = petDataDir();
  const legacy = legacyPetDataDir();
  if (existsSync(target) || !existsSync(legacy)) return false;
  try {
    mkdirSync(target, { recursive: true });
    cpSync(legacy, target, { recursive: true });
    log(`已接管 DSH 插件时期的配置与素材：${legacy} → ${target}`);
    return true;
  } catch (error) {
    log(`旧配置接管失败（不影响启动，可在设置页重新配置）：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
