/**
 * 本地应用的数据目录与迁移。
 *
 * 目录口径：`$DSH_HOME` —— 由 Electron 主进程在启动最早期设为**数据根**
 * （打包版 `<安装目录>/data`，开发态 `app.getPath('userData')`）。
 * 桌宠自己的数据在 `$DSH_HOME/dsh-pet-ng/`：配置、素材、记忆、密钥都在里面。
 *
 * **改名遗留（dsh-pet → dsh-petNG）**：换名字等于换了数据目录，老用户不会自动看到自己的
 * 配置。所以首次启动做一次「接管」——按候选顺序找第一个存在的旧目录，整目录**复制**过来
 * （不移动：旧数据原样留着，不满意可以直接退回旧版）。
 *
 * 候选由主进程给（它才知道安装目录在哪），见 `main.ts` 的 `legacyDataDirs()`。
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { resolveDshHome } from '../core/standalone/home-paths';

/** 应用数据根目录（= 宿主半边眼里的 DSH_HOME） */
export function appHomeDir(): string {
  // 口径的唯一实现在 host/standalone/home-paths.ts（宿主半边也用它），这里只转调
  return resolveDshHome();
}

/**
 * 桌宠数据目录（配置 / 素材 / 记忆 / 密钥）。
 *
 * 名字用 `dsh-pet-ng`（小写 kebab）而不是品牌写法 `dsh-petNG`：这是**目录名**，
 * 跟 npm 包名、脚本名保持一致；品牌写法只出现在界面与文档里。
 */
export function petDataDir(): string {
  return join(appHomeDir(), 'dsh-pet-ng');
}

/** 本地应用配置（服务商 / 模型 / 通知开关；**不含密钥**） */
export function appConfigFile(): string {
  return join(petDataDir(), 'app-config.json');
}

/** 本地密钥（provider key 名 → 值；单独一份、权限收紧） */
export function secretsFile(): string {
  return join(petDataDir(), 'secrets.json');
}

/**
 * 目录里有没有「用户数据」。
 *
 * 判「是否已经接管过」**不能用 existsSync，也不能数所有文件**：主进程在写日志时就会
 * `mkdirSync(petDataDir())` 并落一个 `app.log`，首次运行还会写 `.initialized` 标记。
 * 这两个都不算用户数据 —— 否则「装好先启动看了一眼、才发现要迁移」就永远迁不过来了。
 */
const NON_DATA_FILES = new Set(['app.log', 'app.log.1', '.initialized']);

function hasEntries(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => !NON_DATA_FILES.has(name));
  } catch {
    return false;
  }
}

/**
 * 首次启动时接管旧版本的数据。
 *
 * 只在「新目录还没有内容 + 某个旧目录存在」时动作一次；复制失败只告警不阻断启动——
 * 最坏情况是用户重新配一遍，而不是应用打不开。
 *
 * @param log 告警输出（主进程传 console.warn）
 * @param legacyDirs 旧目录候选，按优先级排列（第一个存在的胜出）
 * @returns 是否真的复制了
 */
export function migrateLegacyData(log: (message: string) => void, legacyDirs: string[]): boolean {
  const target = petDataDir();
  if (hasEntries(target)) return false;
  const legacy = legacyDirs.find((dir) => dir && existsSync(dir));
  if (!legacy) return false;
  try {
    mkdirSync(target, { recursive: true });
    cpSync(legacy, target, { recursive: true });
    log(`已接管旧版本的数据：${legacy} → ${target}`);
    return true;
  } catch (error) {
    log(`旧数据接管失败（不影响启动，可在设置页重新配置）：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
