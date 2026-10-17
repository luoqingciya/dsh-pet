#!/usr/bin/env node
/**
 * prepare.js —— 构建 + 收敛发布清单（npm run build）
 *
 * 做什么：
 *   1. tsdown 构建三个入口：app-main.cjs（Electron 主进程）/ app-launch.js（启动器）/ app-settings.js（设置页）
 *   2. 构建桌面共享核心（src/shared → runtime/electron-helper/shared-core.js，window.PetShared）
 *   3. 改写 package.json 的 files 为发布清单（幂等：跑一次即定格，再跑结果不变）
 *
 * 为什么不在这里打便携版：便携版要拷贝整份 Electron 运行时（约 400MB），属于**分发**动作，
 * 由 `npm run app:package` 或 CI 显式触发，不该挂在每次构建上。
 *
 * 用法：node scripts/prepare.js（npm run build；prepack 也会自动跑）
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PKG = join(ROOT, 'package.json');

/** 跑一条 npm script（Windows 下 npm 是 .cmd，必须经 shell） */
function run(script) {
  console.log(`[prepare] ${script} ...`);
  const command = process.platform === 'win32' ? `cmd /c npm run ${script}` : `npm run ${script}`;
  const result = spawnSync(command, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`[prepare] ${script} 失败 (exit ${result.status})`);
    process.exit(1);
  }
}

// 1. 三个入口 + 桌面共享核心
//    先清掉上一版遗留的产物：入口改名后（client.js / index.js / standalone.js 属于插件时代）
//    旧文件会一直躺在 lib 里，被打进发布包，也干扰 prepack-check 的裸依赖扫描。
rmSync(join(ROOT, 'lib'), { recursive: true, force: true });
run('bundle');
run('build:desktop-core');

// 1.5 角色分发入口：便携版与安装版共用同一个 exe 跑「应用主进程」和「桌面 Helper」，
//     靠 `lib/app-entry.cjs` 按 DSH_PET_ROLE 分发（见该文件头）。它是纯 CJS 源码，
//     不经过打包器（静态 require 会被打进同一份产物），这里原样拷进 lib。
copyFileSync(join(ROOT, 'src', 'app', 'entry.cjs'), join(ROOT, 'lib', 'app-entry.cjs'));
console.log('[prepare] ✓ lib/app-entry.cjs（角色分发入口）');

// 2. files 收敛（幂等，无备份）
const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
const keep = [
  // 构建产物：app-main.cjs / app-launch.js / app-settings.js
  'lib',
  // 源码（便于排障与二次开发；体积可忽略）
  'src',
  // 播放素材（VP9-alpha webm）：桌面渲染端只从这里取
  'assets/webm',
  // 桌面透明窗运行时（主进程 / 渲染端 / 共享核心）
  'runtime/electron-helper',
  'assets/fonts',
  'assets/pic',
  // 表情包：host 只从**包内** assets/memes 读图，漏掉即配图功能整体失效
  'assets/memes',
  'assets/config.jsonc',
  'assets/logo.png',
  // 打包脚本（app:package 要用）；Electron 下载工具在 lib/ensure-electron.js，随 lib 发布
  'scripts/package-app.mjs',
  // 双击启动脚本
  'dsh-pet.cmd',
  'dsh-pet.sh',
];
writeFileSync(PKG, JSON.stringify({ ...pkg, files: keep }, null, 2) + '\n', 'utf8');
console.log(`[prepare] ✓ package.json files=[${keep.join(', ')}]`);
console.log('[prepare] 构建完成：npm run app 启动，npm run app:package 打便携版');
