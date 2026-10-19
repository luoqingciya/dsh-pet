/**
 * 开机自启的**纯逻辑**：Linux 的 .desktop 内容与 Exec 转义。
 *
 * 为什么单独测这一块：Windows/macOS 走 `app.setLoginItemSettings`（由 test:ui 真机验证），
 * 而 Linux 分支在开发机上跑不到，它唯一的产物就是一串文本——只能靠单测把格式钉住。
 * 这里最容易错的是**转义**：Windows 路径全是反斜杠，少转义一层就会被 Desktop Entry
 * 当成转义序列吃掉（`C:\Users` → `C:Users`），登录时 exec 找不到文件，而且不会报错。
 *
 * 跑法：node --experimental-strip-types --test src/app/autostart-entry.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildDesktopEntry, linuxAutostartFile, quoteExecArg } from './autostart-entry.ts';

describe('quoteExecArg —— Desktop Entry 的 Exec 参数转义', () => {
  test('普通路径：双引号包住即可', () => {
    assert.equal(quoteExecArg('/opt/dsh-pet-ng/dsh-petNG'), '"/opt/dsh-pet-ng/dsh-petNG"');
  });

  test('反斜杠必须转义（Windows 路径）', () => {
    assert.equal(quoteExecArg('C:\\Users\\me\\electron.exe'), '"C:\\\\Users\\\\me\\\\electron.exe"');
  });

  test('双引号 / 反引号 / 美元符号 / 百分号', () => {
    assert.equal(quoteExecArg('a"b'), '"a\\"b"');
    assert.equal(quoteExecArg('a`b'), '"a\\`b"');
    assert.equal(quoteExecArg('$HOME'), '"\\$HOME"');
    // % 是字段码前缀（%f %u %i …），必须写成 %%
    assert.equal(quoteExecArg('100%'), '"100%%"');
  });

  test('带空格的路径不会被拆成两个参数', () => {
    const entry = buildDesktopEntry({ path: 'C:\\Program Files\\dsh pet\\dsh-petNG.exe', args: [] });
    const exec = entry.split('\n').find((line) => line.startsWith('Exec='));
    assert.equal(exec, 'Exec="C:\\\\Program Files\\\\dsh pet\\\\dsh-petNG.exe"');
  });
});

describe('buildDesktopEntry —— Linux autostart 文件内容', () => {
  test('打包版：只有可执行文件', () => {
    assert.equal(
      buildDesktopEntry({ path: '/opt/dsh-pet-ng/dsh-petNG', args: [] }),
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=dsh-petNG',
        'Comment=桌面宠物（dsh-petNG）',
        'Exec="/opt/dsh-pet-ng/dsh-petNG"',
        'Terminal=false',
        'NoDisplay=true',
        'X-GNOME-Autostart-enabled=true',
        '',
      ].join('\n'),
    );
  });

  test('源码态：主进程脚本作为第二个参数（少了它登录后只会拉起一个空壳）', () => {
    const entry = buildDesktopEntry({ path: '/repo/node_modules/electron/electron', args: ['/repo/lib/app-main.cjs'] });
    assert.match(entry, /^Exec="\/repo\/node_modules\/electron\/electron" "\/repo\/lib\/app-main\.cjs"$/m);
  });

  test('首行必须是 [Desktop Entry]（否则被忽略），且以换行结尾', () => {
    const entry = buildDesktopEntry({ path: '/x', args: [] });
    assert.ok(entry.startsWith('[Desktop Entry]\n'));
    assert.ok(entry.endsWith('\n'));
  });
});

describe('linuxAutostartFile —— 路径口径', () => {
  test('默认 ~/.config/autostart/dsh-petNG.desktop', () => {
    assert.equal(linuxAutostartFile({}, '/home/u'), '/home/u/.config/autostart/dsh-petNG.desktop');
  });

  test('XDG_CONFIG_HOME 优先', () => {
    assert.equal(
      linuxAutostartFile({ XDG_CONFIG_HOME: '/xdg/cfg' }, '/home/u'),
      '/xdg/cfg/autostart/dsh-petNG.desktop',
    );
  });
});
