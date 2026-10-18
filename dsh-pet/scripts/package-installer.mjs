#!/usr/bin/env node
/**
 * package-installer.mjs —— 产出 Windows 安装版（NSIS）。
 *
 * 与 `package-app.mjs`（免安装 zip）分工明确：
 *   - zip：拷一份 Electron 运行时 + resources/app，解压即用（全平台）；
 *   - 安装版：electron-builder 打 NSIS 向导（仅 Windows），装到 `%LOCALAPPDATA%\Programs\dsh-pet`，
 *     带开始菜单/桌面快捷方式与卸载项。
 *
 * 两者**数据位置一致**：都在 `<安装目录>/data`（见 src/app/main.ts 的 resolveDataRoot）。
 *
 * 用法：
 *   npm run app:installer
 *   DSH_PET_ELECTRON_DIR=/path/to/electron/dist npm run app:installer
 *
 * 前置：`npm run build` 已跑过（需要 lib/app-main.cjs 与其余产物）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 解析 Electron 运行时目录（与 package-app.mjs 同一套来源） */
function electronDir() {
  const explicit = process.env.DSH_PET_ELECTRON_DIR;
  if (explicit && existsSync(explicit)) return explicit;
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || homedir(), '.dsh');
  const dir = join(home, 'electron');
  return existsSync(dir) ? dir : undefined;
}

function fail(message) {
  console.error(`[package-installer] ${message}`);
  process.exit(1);
}

if (process.platform !== 'win32') {
  // 明确拒绝而不是静默产出半个包：macOS/Linux 的"安装版"形态（dmg / AppImage）还没做，
  // 现在只用免安装 zip 分发，README 里写清楚了。
  fail('安装版目前只做 Windows（NSIS）。其他平台请用 npm run app:package 产出免安装 zip。');
}

const entry = join(ROOT, 'lib', 'app-main.cjs');
if (!existsSync(entry)) fail('缺少 lib/app-main.cjs，请先运行 npm run build');

const electron = electronDir();
if (!electron) {
  fail('找不到 Electron 运行时。先运行一次应用（会下载到 $DSH_HOME/electron），或用 DSH_PET_ELECTRON_DIR 指定目录。');
}

const builder = join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
);
if (!existsSync(builder)) fail('缺少 electron-builder，请先 npm install');

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
console.log(`[package-installer] dsh-pet ${version}`);
console.log(`[package-installer] Electron: ${electron}`);

// 固定 electronDist，避免 electron-builder 再下一次同版本运行时
const args = [
  '--win',
  'nsis',
  '--config',
  'electron-builder.yml',
  // 只构建、不发布：CI 里 electron-builder 检测到 CI 环境会**自动尝试上传 Release**，
  // 没有 GH_TOKEN 就整个任务失败（本地不会触发，很难提前发现）。发布由工作流自己的
  // release job 负责（把产物挂到 tag 的 Release）。
  '--publish',
  'never',
  `-c.electronDist=${electron}`,
  `-c.electronVersion=${process.env.DSH_PET_ELECTRON_VERSION || '43.3.0'}`,
];

const result = spawnSync(builder, args, {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    // 没有代码签名证书：显式关掉自动探测，否则 electron-builder 会警告"找不到签名身份"
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    // NSIS / 7zip 工具包默认从 GitHub Releases 下——国内网络常连不上（实测 ETIMEDOUT）。
    // 默认走 npmmirror 镜像；CI 或海外环境可用 ELECTRON_BUILDER_BINARIES_MIRROR 覆盖成 GitHub 源。
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  },
});

if (result.status !== 0) fail(`electron-builder 失败（exit ${result.status}）`);
console.log(`[package-installer] 完成：${join(ROOT, 'dist', 'installer')}`);
