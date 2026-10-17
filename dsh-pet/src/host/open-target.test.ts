/**
 * 右键菜单「打开设置」的接线守卫。
 *
 * 链路（改一侧就会断，所以按本仓库既有做法读源码断言）：
 *   宿主 index.ts 把站点地址（`DSH_PET_SITE_URL` = 本地服务 origin）注入 Helper
 *   → helper main.js 的 `pet:open-site` 用系统默认浏览器打开它
 *   → 渲染端菜单首项是「打开设置」，action 固定为 `open-site`。
 *
 * 应用形态只有一种（本地桌面应用），因此不再有「按宿主形态分派」这层间接：
 * 菜单不写死地址，地址由宿主注入——换端口（`--port`）时菜单自动跟着走。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const host = readSource('./index.ts');
const main = readSource('../../runtime/electron-helper/main.js');
const preload = readSource('../../runtime/electron-helper/preload.js');
const sprite = readSource('../../runtime/electron-helper/sprite.js');

describe('右键「打开设置」', () => {
  test('宿主：注入站点地址，且不再有宿主形态分派', () => {
    assert.ok(/DSH_PET_SITE_URL: siteUrl/.test(host), 'launchHelper 必须把站点地址注入 Helper（否则菜单项没有目标）');
    assert.ok(
      /const siteUrl = ctx\.connection\.authenticatedUrl\(origin\)/.test(host),
      '站点地址要经 connection.authenticatedUrl 取（本地实现恒等返回 origin）',
    );
    assert.ok(
      !/DSH_PET_OPEN_TARGET/.test(host),
      '应用形态只有一种，不得再注入 DSH_PET_OPEN_TARGET（否则会误导后来的人以为还有第二种宿主）',
    );
  });

  test('helper 主进程：pet:open-site 用默认浏览器打开，且没有 dsh:// 分支', () => {
    assert.ok(
      /ipcMain\.on\('pet:open-site',[\s\S]*?openSite\(url\)/.test(main),
      'main.js 必须把 open-site 交给 openSite(url)',
    );
    assert.ok(!/dsh:\/\/open/.test(main), '不得残留 dsh://open（那是 DSH 桌面端的协议）');
    assert.ok(!/OPEN_TARGET/.test(main), '不得残留 OPEN_TARGET（形态分派已删除）');
  });

  test('preload 暴露窗口控制原语', () => {
    assert.ok(/openDshSite\(url\)/.test(preload), 'preload 必须暴露 openDshSite(url)');
  });

  test('渲染端：菜单首项是「打开设置」，action 仍是 open-site', () => {
    assert.ok(
      /label: '打开设置', action: 'open-site'/.test(sprite),
      '菜单首项必须是「打开设置」+ open-site（文案与动作名都只在这一处）',
    );
    assert.ok(!/OPEN_TARGET/.test(sprite), '渲染端不得残留 OPEN_TARGET');
  });
});
