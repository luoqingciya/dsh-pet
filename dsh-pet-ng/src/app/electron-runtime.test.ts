/**
 * Electron 运行时落地目录的口径守卫。
 *
 * 背景（0.9.0 的真实事故）：把开发态 Electron 从 `~/.dsh/electron` 迁到应用自己的缓存目录时，
 * 只改了运行时（`electron-runtime.ts`），打包脚本 `package-app.mjs` / `package-installer.mjs`
 * 还认旧路径——本地因为旧目录里还有一份，没暴露；CI 上三平台全部「找不到 Electron 运行时」。
 *
 * 所以这里把「应用侧」与「打包脚本侧」两份实现**对着测**：任何一边改了路径规则，这个用例就红。
 *
 * 跑法：node --experimental-strip-types --test src/app/electron-runtime.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appCacheDir, electronLandingDir } from './electron-runtime.ts';
import { appCacheDir as scriptAppCacheDir, resolveElectronRuntimeDir } from '../../scripts/electron-runtime-dir.mjs';

describe('缓存根：应用与打包脚本同口径', () => {
  test('默认环境下一模一样', () => {
    assert.equal(appCacheDir(), scriptAppCacheDir());
  });

  test('环境变量改了也一起跟着变', () => {
    const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
    process.env.LOCALAPPDATA = join(tmpdir(), 'dsh-fake-local');
    process.env.XDG_CACHE_HOME = join(tmpdir(), 'dsh-fake-xdg');
    try {
      assert.equal(appCacheDir(), scriptAppCacheDir());
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('Electron 落地目录 = 缓存根/electron', () => {
    const saved = process.env.DSH_PET_ELECTRON_DIR;
    delete process.env.DSH_PET_ELECTRON_DIR;
    try {
      assert.equal(electronLandingDir(), join(scriptAppCacheDir(), 'electron'));
    } finally {
      if (saved !== undefined) process.env.DSH_PET_ELECTRON_DIR = saved;
    }
  });
});

describe('打包脚本：新缓存优先、旧位置只读兜底', () => {
  test('两者都有 → 用新的；只有旧的 → 用旧的；都没有 → undefined', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-electron-dir-'));
    const home = join(root, 'dsh-home');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: home,
      LOCALAPPDATA: join(root, 'local'),
    };
    delete env.DSH_PET_ELECTRON_DIR;
    const current = join(scriptAppCacheDir(env), 'electron');
    const legacy = join(home, 'electron');
    try {
      assert.equal(resolveElectronRuntimeDir({ env }), undefined, '两个都没有时应返回 undefined');

      mkdirSync(legacy, { recursive: true });
      assert.equal(resolveElectronRuntimeDir({ env }), legacy, '只有旧位置时走只读兜底');

      mkdirSync(current, { recursive: true });
      assert.equal(resolveElectronRuntimeDir({ env }), current, '新位置存在时优先用它');

      // 显式指定优先级最高
      assert.equal(resolveElectronRuntimeDir({ env: { ...env, DSH_PET_ELECTRON_DIR: legacy } }), legacy);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
