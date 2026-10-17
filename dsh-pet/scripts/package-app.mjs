#!/usr/bin/env node
/**
 * package-app.mjs —— 打一个**便携版**（免安装、免 Node）的本地应用目录。
 *
 * 产出结构（Electron 官方约定的「resources/app」布局，不依赖 electron-builder）：
 *
 *   dist/dsh-pet-app/
 *   ├─ dsh-pet.exe          ← 由 electron.exe 改名（Windows；macOS/Linux 对应改名）
 *   ├─ *.dll / *.pak / …    ← Electron 运行时原样拷贝
 *   └─ resources/app/       ← 本包（lib / runtime / assets / package.json）
 *
 * 为什么不用 electron-builder：它要再下一次同版本 Electron（几百 MB）并依赖一整套
 * 打包链路；而本项目**本来就已经**把 Electron 下到 `$DSH_HOME/electron` 了
 * （插件桌面模式用的就是它）。这里只做「拷贝 + 改名 + 收拢文件」，全程离线、可重复。
 *
 * 代价（如实说明）：不做代码签名、不改 exe 图标与版本信息（那需要 rcedit 之类的
 * Windows 资源编辑工具）。便携版定位是「解压即用」，不是商店分发。
 *
 * 用法：npm run app:package [-- --out dist/my-app]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLAT = process.platform;

/** 解析 Electron 运行时目录（与插件桌面模式同一个来源） */
function electronDir() {
  const explicit = process.env.DSH_PET_ELECTRON_DIR;
  if (explicit && existsSync(explicit)) return explicit;
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || homedir(), '.dsh');
  const dir = join(home, 'electron');
  return existsSync(dir) ? dir : undefined;
}

/** 平台对应的 Electron 可执行文件名 */
const EXE_NAME = PLAT === 'win32' ? 'electron.exe' : PLAT === 'darwin' ? 'Electron' : 'electron';
/** 便携版可执行文件名 */
const APP_EXE = PLAT === 'win32' ? 'dsh-pet.exe' : 'dsh-pet';

/** 解析 `--out` */
function parseOut(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') return resolve(argv[i + 1] ?? '');
    if (argv[i].startsWith('--out=')) return resolve(argv[i].slice('--out='.length));
  }
  return join(ROOT, 'dist', 'dsh-pet-app');
}

/** 只拷应用真正需要的目录（不拷 preview / 源码 / 开发脚本，包体最小） */
const APP_DIRS = [
  'lib',
  'runtime',
  join('assets', 'webm'),
  join('assets', 'fonts'),
  join('assets', 'pic'),
  join('assets', 'memes'),
];
/** 单文件资源 */
const APP_FILES = [join('assets', 'config.jsonc'), join('assets', 'logo.png')];

function main() {
  const out = parseOut(process.argv.slice(2));
  const source = electronDir();
  if (!source) {
    console.error(
      '[package-app] 找不到 Electron 运行时。\n' +
        '  先运行一次桌面模式（会下载到 $DSH_HOME/electron），或用 DSH_PET_ELECTRON_DIR 指定目录。',
    );
    process.exit(1);
  }
  if (!existsSync(join(ROOT, 'lib', 'app-main.cjs'))) {
    console.error('[package-app] 缺少构建产物 lib/app-main.cjs，请先运行 npm run build');
    process.exit(1);
  }

  console.log(`[package-app] Electron: ${source}`);
  console.log(`[package-app] 输出:      ${out}`);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // 1) Electron 运行时
  cpSync(source, out, { recursive: true });

  // 2) 改名（macOS 的可执行文件在 .app 包里）
  if (PLAT === 'darwin') {
    const inner = join(out, 'Electron.app', 'Contents', 'MacOS', 'Electron');
    if (existsSync(inner)) renameSync(inner, join(out, 'Electron.app', 'Contents', 'MacOS', 'dsh-pet'));
  } else {
    const exe = join(out, EXE_NAME);
    if (existsSync(exe)) renameSync(exe, join(out, APP_EXE));
  }

  // 3) resources/app = 本包
  const appDir = join(out, 'resources', 'app');
  mkdirSync(appDir, { recursive: true });
  for (const rel of APP_DIRS) {
    const from = join(ROOT, rel);
    if (!existsSync(from)) continue;
    cpSync(from, join(appDir, rel), { recursive: true });
  }
  for (const rel of APP_FILES) {
    const from = join(ROOT, rel);
    if (existsSync(from)) cpSync(from, join(appDir, rel));
  }

  // 4) 精简 package.json：只留 Electron 启动所需字段（main 指向 CJS 主进程）
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-pet',
        productName: 'dsh-pet',
        version: pkg.version,
        description: pkg.description,
        // 分发入口：Helper 子进程与应用主进程共用同一个 exe（见 src/app/entry.cjs）
        main: 'lib/app-entry.cjs',
        type: 'commonjs',
        license: pkg.license,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  // 5) 使用说明
  writeFileSync(
    join(out, 'README.txt'),
    [
      'dsh-pet 便携版',
      '',
      PLAT === 'win32'
        ? '双击 dsh-pet.exe 启动（宠物出现在桌面，托盘图标可打开设置）。'
        : PLAT === 'darwin'
          ? '双击 Electron.app（可自行改名为 dsh-pet.app）启动。'
          : '运行 ./dsh-pet 启动。',
      '',
      '数据目录（就在本目录下，拷走即迁移）：',
      '  data/',
      '',
      '本目录需要对当前用户可写。若放在只读位置（如 Program Files），',
      '应用会自动回落到用户目录启动，并在日志里说明。',
      '',
      '设置页也可在浏览器打开：http://127.0.0.1:7340/app/',
      '',
    ].join('\n'),
    'utf8',
  );

  console.log('[package-app] 完成。启动：' + (PLAT === 'win32' ? join(out, APP_EXE) : out));
}

main();
