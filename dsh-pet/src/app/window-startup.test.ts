/**
 * 启动时的窗口行为守卫 —— 两个都曾经以"静默"的方式坏过，用户只看到"没有宠物"。
 *
 * ① 宠物窗口的页面路径：`loadFile('index.html')` 是相对 **appPath** 解析的。开发态
 *    appPath = 脚本所在目录，恰好能用；打包后 Helper 与主进程共用同一个 exe，appPath
 *    变成 `resources/app`，于是去找 `resources/app/index.html` → ERR_FILE_NOT_FOUND，
 *    窗口创建了但永远是空白（透明窗 → 看起来就是"没出现"）。
 * ② 设置窗的弹出时机：早期用"配置文件是否存在"判断首次运行，但**首次启动并不写
 *    main-config.jsonc**（只有点保存才写），于是每次启动都弹设置窗——用户点开应用
 *    只看到设置页，以为桌宠没启动。
 *
 * 两处都只能读源码断言（需要真实 Electron 才能跑），与仓库既有的守卫测试同一套路。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const helperMain = readSource('../../runtime/electron-helper/main.js');
const appMain = readSource('./main.ts');

describe('宠物窗口的页面路径', () => {
  test('必须用 __dirname 拼绝对路径（相对路径在打包后会指向 resources/app）', () => {
    assert.ok(
      /\.loadFile\(path\.join\(__dirname, 'index\.html'\)/.test(helperMain),
      "loadFile 必须写成 path.join(__dirname, 'index.html')：相对路径按 appPath 解析，打包后必然 404",
    );
    assert.ok(
      !/\.loadFile\('index\.html'/.test(helperMain),
      "不得回退到 loadFile('index.html')——开发态能跑、打包后静默失败",
    );
  });
});

describe('设置窗的弹出时机', () => {
  test('用初始化标记判断首次运行，而不是"配置文件是否存在"', () => {
    assert.ok(
      /function isFirstRun\(\): boolean \{\s*return !existsSync\(firstRunMarker\(\)\);/.test(appMain),
      '首次运行必须看标记文件',
    );
    assert.ok(/function markInitialized\(\)/.test(appMain), '必须有落标记的函数');
    assert.ok(
      /if \(isFirstRun\(\)\) openSettings\(\);\s*\n\s*markInitialized\(\);/.test(appMain),
      '启动流程必须是「首次运行才弹设置窗 → 落标记」',
    );
  });

  test('标记落在数据目录里（随程序迁移，不写 APPDATA）', () => {
    assert.ok(/join\(petDataDir\(\), '\.initialized'\)/.test(appMain), '标记文件必须在 petDataDir() 下');
  });
});
