#!/usr/bin/env node
/**
 * package-app.mjs —— 打**免安装版**（解压即用、免 Node）。
 *
 * 产出结构（Electron 约定的「resources/app」布局）：
 *
 *   dist/dsh-pet-app/
 *   ├─ dsh-pet.exe          ← 带图标与版本信息的可执行文件
 *   ├─ *.dll / *.pak / …    ← Electron 运行时
 *   └─ resources/app/       ← 本包（lib / runtime / assets / package.json）
 *
 * Windows 走 electron-builder 的 `--dir`：只有它会把**图标与版本信息写进 exe**
 * （需要 rcedit 那套 Windows 资源编辑）。早期的「拷一份 electron.exe 改名」做法产出的
 * 是 Electron 默认图标，用户看到的是一张没名字的白图标——这个坑踩过一次，别再回去。
 *
 * macOS / Linux 仍是「拷运行时 + 改名」：macOS 的图标在 .app/Contents/Resources 里，
 * 改名 exe 不影响 Dock 图标来源（仍是 Electron.icns），换图标要改 Info.plist，暂不做。
 *
 * 用法：npm run app:package [-- --out dist/my-app]
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLAT = process.platform;

/** 解析 Electron 运行时目录（与桌面 Helper 同一个来源） */
function electronDir() {
  const explicit = process.env.DSH_PET_ELECTRON_DIR;
  if (explicit && existsSync(explicit)) return explicit;
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || homedir(), '.dsh');
  const dir = join(home, 'electron');
  return existsSync(dir) ? dir : undefined;
}

/** 平台对应的 Electron 可执行文件名 */
const EXE_NAME = PLAT === 'win32' ? 'electron.exe' : PLAT === 'darwin' ? 'Electron' : 'electron';
/** 免安装版可执行文件名 */
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

/**
 * 裁掉用不到的语言包。
 *
 * Electron 自带 55 个 `locales/*.pak`（约 47MB），一个中文桌宠只需要 zh-CN 与 en-US。
 * Windows 走 electron-builder 时由 `electronLanguages` 处理；这里对"拷运行时"的路径补一刀，
 * 两条路径都裁到只剩两个（幂等：已经裁过再跑无副作用）。
 */
function pruneLocales(dir) {
  const keep = new Set(['zh-CN.pak', 'en-US.pak']);
  const locales = join(dir, 'locales');
  if (!existsSync(locales)) return;
  let removed = 0;
  for (const file of readdirSync(locales)) {
    if (keep.has(file)) continue;
    try {
      unlinkSync(join(locales, file));
      removed += 1;
    } catch {
      /* 删不掉就留着，不影响运行 */
    }
  }
  if (removed > 0) console.log(`[package-app] 裁掉 ${removed} 个语言包（保留 zh-CN / en-US）`);
}

/** 写使用说明 */
function writeReadme(out) {
  writeFileSync(
    join(out, 'README.txt'),
    [
      'dsh-pet 免安装版',
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
}

/**
 * Windows：用 electron-builder 的 `--dir` 产物（带图标与版本信息）。
 * @returns 是否成功（失败时返回 false，由调用方回落到"拷运行时"的老路径）
 */
function buildWindowsPayload(source) {
  const builder = join(ROOT, 'node_modules', '.bin', 'electron-builder.cmd');
  if (!existsSync(builder)) return undefined;

  console.log('[package-app] Windows：用 electron-builder --dir 生成带图标的可执行文件…');
  const result = spawnSync(
    builder,
    [
      '--win',
      '--dir',
      '--config',
      'electron-builder.yml',
      '--publish',
      'never',
      `-c.electronDist=${source}`,
      `-c.electronVersion=${process.env.DSH_PET_ELECTRON_VERSION || '43.3.0'}`,
    ],
    {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
        ELECTRON_BUILDER_BINARIES_MIRROR:
          process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
      },
    },
  );
  if (result.status !== 0) {
    console.error(`[package-app] electron-builder --dir 失败（exit ${result.status}），回落到拷贝运行时`);
    return undefined;
  }
  const unpacked = join(ROOT, 'dist', 'installer', 'win-unpacked');
  return existsSync(join(unpacked, 'dsh-pet.exe')) ? unpacked : undefined;
}

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

  // 上一次的产物要先清掉；若应用正在运行，exe 被占用会 EPERM——给出能看懂的提示
  try {
    rmSync(out, { recursive: true, force: true });
  } catch (error) {
    console.error(
      `[package-app] 无法清理旧产物 ${out}：${error instanceof Error ? error.message : String(error)}\n` +
        '  如果 dsh-pet 正在运行，请先从托盘退出再打包。',
    );
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });

  // Windows 优先用 electron-builder 的成品（图标 + 版本信息）
  const payload = PLAT === 'win32' ? buildWindowsPayload(source) : undefined;
  if (payload) {
    cpSync(payload, out, { recursive: true });
    pruneLocales(out);
    writeReadme(out);
    console.log('[package-app] 完成（含图标）。启动：' + join(out, APP_EXE));
    return;
  }

  // 其余平台（或 electron-builder 不可用）：拷运行时 + 改名
  cpSync(source, out, { recursive: true });
  if (PLAT === 'darwin') {
    const inner = join(out, 'Electron.app', 'Contents', 'MacOS', 'Electron');
    if (existsSync(inner)) renameSync(inner, join(out, 'Electron.app', 'Contents', 'MacOS', 'dsh-pet'));
  } else {
    const exe = join(out, EXE_NAME);
    if (existsSync(exe)) renameSync(exe, join(out, APP_EXE));
  }

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

  pruneLocales(out);
  writeReadme(out);
  console.log('[package-app] 完成。启动：' + (PLAT === 'win32' ? join(out, APP_EXE) : out));
}

main();
