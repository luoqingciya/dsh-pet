/**
 * 安装包「升级不丢配置」的接线守卫。
 *
 * 背景（用户报障）：每次装新版本，配置 / 密钥 / 记忆全没了。根因不在应用，在 NSIS ——
 * electron-builder 升级时会把**整个 $INSTDIR** 挪进 $PLUGINSDIR 再随卸载器删掉，
 * 而用户数据按设计就在 `<安装目录>\data`。修复见 `build/installer.nsh`：
 * 安装器 `.onInit`（早于旧版卸载器）先把 data 挪到安装目录同级，装完再挪回来。
 *
 * 这段 NSIS 没法在 node:test 里跑（要么编译安装包、要么真装一次），所以这里只钉**接线**：
 * 配置里真的挂了脚本、脚本里真的定义了那两个宏、且确实动的是 `data`。
 * 行为验证做过一次 A/B：带脚本 → 配置存活；把 include 换成空文件 → 配置消失。
 *
 * 跑法：node --experimental-strip-types --test src/app/installer-upgrade.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const builderConfig = read('../../electron-builder.yml');
const installerNsh = read('../../build/installer.nsh');
/** 去掉注释行后的脚本正文（注释里会举例提到默认流程的 RMDir /r $INSTDIR，别误判） */
const installerCode = installerNsh
  .split('\n')
  .filter((line) => !line.trim().startsWith(';'))
  .join('\n');

describe('安装包升级：用户数据必须留在原地', () => {
  test('electron-builder 配置挂上了自定义脚本', () => {
    assert.ok(
      /^\s*include:\s*build\/installer\.nsh\s*$/m.test(builderConfig),
      'nsis.include 必须指向 build/installer.nsh：不挂脚本就退回"升级删整个安装目录"',
    );
  });

  test('脚本在安装前（customInit）把 data 挪走、装完（customInstall）挪回', () => {
    assert.ok(/!macro\s+customInit/.test(installerNsh), '必须有 customInit（.onInit 里、早于旧卸载器）');
    assert.ok(/!macro\s+customInstall/.test(installerNsh), '必须有 customInstall（文件装完后恢复）');
    assert.ok(
      /\$INSTDIR\\data/.test(installerNsh),
      '两个宏都必须针对 $INSTDIR\\data —— 那是用户配置 / 密钥 / 记忆 / 自定义动画的位置',
    );
  });

  test('没有动 $INSTDIR 之外的任何东西（不碰 %APPDATA%、不自己删整个安装目录）', () => {
    assert.ok(!/\$APPDATA/.test(installerCode), '本脚本只负责安装目录里的 data，不要越界');
    assert.ok(!/RMDir\s+\/r\s+"?\$INSTDIR"?\s*$/m.test(installerCode), '不要自己删整个安装目录（默认流程负责）');
  });
});
