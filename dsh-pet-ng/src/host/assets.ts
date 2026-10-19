/**
 * 素材归属与目录解析 —— 「这个文件该从哪读」的唯一一处。
 *
 * 归属规则（动画与表情包**同一套**语义，只是目录后缀不同）：
 *   - pet pack 宠物（`pet/<素材根>-animation/` 或 `-memes/` 存在）：**只查自己的**，
 *     查不到即 404 / 该条目剔除，绝不回落到主素材链（混用会让"我的猪怎么长着鱼的尾巴"这种
 *     问题无从排查）；
 *   - 其余（主宠物及用户自己加的多只实例，共用全局动画池）：
 *     用户目录优先（`main-animation/webm|mov`、`memes/`），其次包内 `assets/webm|mov`、`assets/memes`。
 *
 * 为什么单独成文件：这套规则被三处消费——`/thumb` 路由、`/pic/memes` 路由、表情包池
 * （`readMemePool`）。**池里能选到的名字，路由必须取得到**，否则气泡配图会图裂；
 * 三处共用同一个函数是这条不变式的唯一保证（以前它埋在 index.ts 的闭包里，只能靠源码守卫）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveAsset } from './http';

export interface AssetPathOptions {
  /** 包根（`assets/` 的上一级） */
  packageRoot: string;
  /** 用户数据根（`$DSH_HOME/dsh-petNG`） */
  userRoot: string;
  /** 文件宠物配置目录（`<userRoot>/pet`），用于判定"是不是 pet pack" */
  petConfigDir: string;
}

export interface AssetPaths {
  /** 用户动画根（`<userRoot>/main-animation`）—— 设置页展示与 `/config/meta` 用 */
  thumbUserRoot: string;
  /** 用户表情包根（`<userRoot>/memes`） */
  memesUserRoot: string;
  /** 扩展名 → 素材子目录名（webm → webm/，mov → mov/） */
  animSubdirFor(ext: string): string;
  /** 包内动画素材根（按扩展名取子目录） */
  assetRootFor(ext: string): string;
  /** 用户动画根（按扩展名取子目录） */
  userRootFor(ext: string): string;
  /**
   * 表情包目录链（按素材根）。
   * pet pack 独占目录存在 → 只返回它；否则用户目录 → 包内目录。
   */
  memeDirsFor(assetRoot: string): string[];
}

/**
 * 建一套素材路径解析器。
 * @param options 包根、用户数据根与文件宠物目录
 */
export function createAssetPaths(options: AssetPathOptions): AssetPaths {
  const packageMemesDir = join(options.packageRoot, 'assets', 'memes');
  const thumbUserRoot = join(options.userRoot, 'main-animation');
  const memesUserRoot = join(options.userRoot, 'memes');

  const animSubdirFor = (ext: string): string => (ext === '.mov' ? 'mov' : 'webm');

  return {
    thumbUserRoot,
    memesUserRoot,
    animSubdirFor,
    assetRootFor: (ext) => join(options.packageRoot, 'assets', animSubdirFor(ext)),
    userRootFor: (ext) => join(thumbUserRoot, animSubdirFor(ext)),
    memeDirsFor: (assetRoot) => {
      // 素材根来自 URL 段：先过 resolveAsset 防穿越（Windows 上 %5C 解出的反斜杠不会被
      // rest.split('/') 切开，直接 join 会让 `..\..\x` 逃出用户根读盘）
      const own = resolveAsset(options.petConfigDir, `${assetRoot}-memes`);
      if (own !== undefined && existsSync(own)) return [own];
      return [memesUserRoot, packageMemesDir];
    },
  };
}
