#!/usr/bin/env node
/**
 * prepack-check.js —— 产物健康检查（prepack 自动跑，任何一项失败都阻止发布）
 *
 * 检查的都是「坏了但跑得起来」的那类问题——它们不会在开发机上暴露，只会在用户那里翻车：
 *   1. 三个入口产物与运行时要件是否齐全；
 *   2. `lib/app-main.cjs` 必须是 **CJS** 且没有残留裸 require（便携包里没有 node_modules）；
 *   3. 设置页 bundle 不得留下裸 react import（应用里没有模块加载器）；
 *   4. 素材：待机动画池非空、表情包与配置对齐；
 *   5. 包体积上限（防误把母版/源视频塞进来）；
 *   6. 插件时代的字段必须已经清干净（dsh / peerDependencies / icon），否则会误导安装方式。
 *
 * 用法：node scripts/prepack-check.js
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fail = (msg) => {
  console.error(`[prepack-check] FAIL: ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`[prepack-check] ok: ${msg}`);

/** JSONC → JSON：字符串感知地剥离行注释与块注释（config.jsonc 里有行尾注释） */
function stripJsonc(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 递归求和目录体积 */
function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

// ---- 1. 必需产物 ----
const REQUIRED = [
  'lib/app-main.cjs',
  'lib/app-launch.js',
  'lib/app-settings.js',
  // 桌面 Helper 运行时的全部模块：任何一个缺失，main.js 一 require 就崩（且窗口不出现、没有提示）
  'runtime/electron-helper/main.js',
  'runtime/electron-helper/preload.js',
  'runtime/electron-helper/index.html',
  'runtime/electron-helper/shared-core.js',
  'runtime/electron-helper/constants.js',
  'runtime/electron-helper/sprite.js',
  'runtime/electron-helper/events.js',
  'runtime/electron-helper/renderer.js',
  'runtime/electron-helper/host-liveness.js',
  'runtime/electron-helper/pointer-target.js',
  'runtime/electron-helper/topmost-watchdog.js',
  'runtime/electron-helper/dpi-linearization.js',
  'runtime/electron-helper/desktop-geometry.js',
  'assets/config.jsonc',
  'assets/logo.png',
  'src/app/entry.cjs',
];
const missing = REQUIRED.filter((rel) => !existsSync(join(ROOT, rel)));
if (missing.length === 0) ok(`产物齐全（${REQUIRED.length} 项）`);
else fail(`缺少产物：${missing.join(', ')}（先运行 npm run build）`);

// ---- 2. 主进程必须是 CJS，且无裸 require ----
if (existsSync(join(ROOT, 'lib/app-main.cjs'))) {
  const main = readFileSync(join(ROOT, 'lib/app-main.cjs'), 'utf8');
  if (main.includes('import.meta')) fail('app-main.cjs 里出现了 import.meta：CJS 产物会直接语法错误');
  else ok('app-main.cjs 是纯 CJS');

  const requires = [...main.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  const bare = requires.filter((id) => !id.startsWith('node:') && id !== 'electron' && id !== 'url');
  if (bare.length > 0) {
    fail(`app-main.cjs 残留裸 require：${[...new Set(bare)].join(', ')}（便携包里没有 node_modules）`);
  } else {
    ok('app-main.cjs 无裸 require（只依赖 node: 与 electron）');
  }
}

// ---- 3. 设置页不得留裸 react ----
if (existsSync(join(ROOT, 'lib/app-settings.js'))) {
  const settings = readFileSync(join(ROOT, 'lib/app-settings.js'), 'utf8');
  const bareImport = /(?:^|[;\s])(?:import|require)\s*\(?\s*["']react/.test(settings);
  if (bareImport) fail('app-settings.js 残留裸 react 引用（应用里没有模块加载器，会白屏）');
  else ok('设置页 bundle 自带 react');
}

// ---- 4. 素材 ----
try {
  const config = JSON.parse(stripJsonc(readFileSync(join(ROOT, 'assets/config.jsonc'), 'utf8')));
  const idle = config?.animations?.idle;
  if (!Array.isArray(idle) || idle.length === 0) fail('config.jsonc 的 animations.idle 为空');
  else ok(`待机动画池 ${idle.length} 段`);

  const webm = readdirSync(join(ROOT, 'assets/webm')).filter((file) => file.endsWith('.webm'));
  if (webm.length === 0) fail('assets/webm 里没有 webm 素材');
  else ok(`播放素材 ${webm.length} 段`);

  // 表情包：配置里登记的每个名字都要有图（配图只从包内读，缺图即该条失效）
  const memes = config?.memes;
  if (memes && typeof memes === 'object') {
    const names = Object.keys(memes);
    const dir = join(ROOT, 'assets/memes');
    const files = existsSync(dir) ? readdirSync(dir) : [];
    const lost = names.filter((name) => !files.includes(`${name}.png`));
    if (lost.length > 0) fail(`表情包缺图：${lost.slice(0, 5).join(', ')}${lost.length > 5 ? ' …' : ''}`);
    else ok(`表情包 ${names.length} 张与配置对齐`);
  }

  for (const rel of ['assets/fonts', 'assets/pic']) {
    if (!existsSync(join(ROOT, rel)) || readdirSync(join(ROOT, rel)).length === 0) fail(`${rel} 为空`);
  }
} catch (error) {
  fail(`素材检查失败：${error instanceof Error ? error.message : String(error)}`);
}

// ---- 5. 体积 ----
try {
  // 只统计「会被发布的东西」：node_modules 与便携版输出目录（dist/，几百 MB）都不算包体
  const SKIP = new Set(['node_modules', 'dist', '.git']);
  const total = readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => !SKIP.has(entry.name))
    .reduce(
      (sum, entry) =>
        sum + (entry.isDirectory() ? dirSize(join(ROOT, entry.name)) : statSync(join(ROOT, entry.name)).size),
      0,
    );
  const mb = total / 1024 / 1024;
  if (mb > 220) fail(`包体积 ${mb.toFixed(0)}MB 超过 220MB（误塞了母版/源视频？）`);
  else ok(`包体积 ${mb.toFixed(0)}MB`);
} catch {
  /* 体积只是软检查，统计失败不阻断 */
}

// ---- 6. 插件时代的字段必须清干净 ----
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const leftovers = [
  pkg.dsh ? 'dsh' : '',
  pkg.peerDependencies && Object.keys(pkg.peerDependencies).some((key) => key.startsWith('@deepseek-ai/'))
    ? 'peerDependencies(@deepseek-ai/*)'
    : '',
  pkg.icon ? 'icon' : '',
].filter(Boolean);
if (leftovers.length > 0) fail(`package.json 仍残留插件字段：${leftovers.join(', ')}`);
else ok('package.json 无插件残留字段');

console.log(process.exitCode ? '[prepack-check] 未通过' : '[prepack-check] 全部通过');
