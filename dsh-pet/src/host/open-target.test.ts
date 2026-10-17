/**
 * 右键菜单「打开设置」的接线守卫。
 *
 * 链路（改一侧就会断，所以按本仓库既有做法读源码断言）：
 *   宿主 index.ts 注入 `DSH_PET_CONFIG_URL`（本地服务 origin + 路由前缀）
 *   → helper 主进程把它沿 query 交给渲染端（`ORIGIN` = 本地服务 origin，端口变了自动跟随）
 *   → 渲染端菜单首项「打开设置」action=open-site → 主进程 shell.openExternal(ORIGIN)。
 *
 * 应用形态只有一种（本地桌面应用），所以既没有"按宿主形态分派"，也没有 DSH 的启动令牌。
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
  test('宿主：只注入配置地址，不再有宿主形态 / 令牌相关变量', () => {
    assert.ok(
      /DSH_PET_CONFIG_URL: configUrl/.test(host),
      'launchHelper 必须把配置地址注入 Helper（渲染端的 ORIGIN 由它推导）',
    );
    for (const name of ['DSH_PET_OPEN_TARGET', 'DSH_PET_SITE_URL']) {
      assert.ok(!host.includes(name), `不得再注入 ${name}（那是 DSH 宿主时代的间接层）`);
    }
  });

  test('helper 主进程：open-site 直接交给系统浏览器，没有 dsh:// 分支', () => {
    assert.ok(
      /ipcMain\.on\('pet:open-site',[\s\S]*?openSite\(url\)/.test(main),
      'main.js 必须把 open-site 交给 openSite(url)',
    );
    assert.ok(
      /const openSite = \(url\) => \{\s*shell\.openExternal\(url\)/.test(main),
      'openSite 必须就是 shell.openExternal(url)（不再有令牌 / 回落分支）',
    );
    assert.ok(!/dsh:\/\/open/.test(main), '不得残留 dsh://open');
  });

  test('preload 暴露窗口控制原语', () => {
    assert.ok(/openDshSite\(url\)/.test(preload), 'preload 必须暴露 openDshSite(url)');
  });

  test('渲染端：菜单首项是「打开设置」，点击打开的是 ORIGIN', () => {
    assert.ok(
      /label: '打开设置', action: 'open-site'/.test(sprite),
      '菜单首项必须是「打开设置」+ open-site（文案与动作名都只在这一处）',
    );
    assert.ok(/petBridge\.openDshSite\(ORIGIN\)/.test(sprite), '点击后必须打开本地服务的 origin');
  });
});
