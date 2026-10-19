/**
 * 命令行端口解析（应用本体）。
 *
 * 背景：README / API.md / openapi 都写着「可用 `--port` 指定」，但打包版直接跑 `app-main.cjs`、
 * 不经过启动器，从前只读 `DSH_PET_APP_PORT` —— 于是 `dsh-petNG.exe --port 7500` 静默无效。
 * 免安装版用户恰恰最需要它（同机多实例、或 7340 被占）。
 *
 * 跑法：node --experimental-strip-types --test src/app/port-arg.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { portFromArgv } from './port-arg.ts';

describe('portFromArgv —— 从 Electron 的 argv 里挑端口', () => {
  test('两种写法都认', () => {
    assert.deepEqual(portFromArgv(['dsh-petNG.exe', '--port', '7500']), { port: 7500 });
    assert.deepEqual(portFromArgv(['dsh-petNG.exe', '--port=7500']), { port: 7500 });
  });

  test('没传 → 空结果（调用方回落到环境变量/默认值）', () => {
    assert.deepEqual(portFromArgv(['dsh-petNG.exe', 'lib/app-main.cjs']), {});
    assert.deepEqual(portFromArgv([]), {});
  });

  test('宽松：Electron 自己的开关与 app 路径一律忽略（这是与启动器 CLI 的关键差别）', () => {
    const argv = [
      'dsh-petNG.exe',
      '--user-data-dir=C:/tmp/x',
      '--allow-file-access-from-files',
      'D:/app/lib/app-main.cjs',
      '--port',
      '7500',
    ];
    assert.deepEqual(portFromArgv(argv), { port: 7500 });
  });

  test('非法值不抛错，回原文供调用方告警', () => {
    assert.deepEqual(portFromArgv(['--port', 'abc']), { raw: 'abc' });
    assert.deepEqual(portFromArgv(['--port']), { raw: '' }, '--port 后面没有值');
    assert.deepEqual(portFromArgv(['--port=0']), { raw: '0' }, '端口 0 = 交给系统分配，这里不接受');
    assert.deepEqual(portFromArgv(['--port=70000']), { raw: '70000' });
    assert.deepEqual(portFromArgv(['--port=7500.5']), { raw: '7500.5' }, '必须是整数');
  });

  test('边界值可用', () => {
    assert.deepEqual(portFromArgv(['--port=1']), { port: 1 });
    assert.deepEqual(portFromArgv(['--port=65535']), { port: 65535 });
  });
});
