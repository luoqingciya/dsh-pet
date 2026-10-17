// tsdown 配置：src → lib（三个入口，全部服务于同一个 Electron 应用）
//
//   1) 应用主进程（app-main → lib/app-main.cjs）—— Electron main。**必须是 CJS**：
//      Electron 43 的 ESM 主进程里 `import 'electron'` 会被 Node 解析器判给 node_modules/electron
//      （那个包导出的是一串路径字符串），拿不到 app/BrowserWindow；`require('electron')` 才是运行时模块。
//      它同时打包了宿主半边（src/host）与共享纯逻辑（src/shared），运行时不依赖 node_modules。
//   2) 启动器（app-launch → lib/app-launch.js）—— Node 跑：找 Electron（缓存/下载）再拉起主进程。
//   3) 设置页（app-settings → lib/app-settings.js）—— 浏览器 IIFE，react 打进产物（应用里没有
//      模块加载器，留下裸 import 就是白屏）。
//
// 关于 alias：宿主半边静态 import 了三个只在 DSH 里存在的包（dsh-home-paths / dsh-credentials /
// dsh-llm），应用里没有它们，因此换成 `src/app/shims/*`——替身只做「转调本包自己的同口径实现」，
// 没有任何生成/网络逻辑。其余 @deepseek-ai/* 按外部处理（负向断言），避免哪天误把 DSH 代码打进产物。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

import { loadShims } from './scripts/shims.mjs';

/** 本配置文件所在目录（= 包根） */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)));

/**
 * `@deepseek-ai/*` 的替身映射：唯一来源是 tsconfig.json 的 paths（见 scripts/shims.mjs）。
 * tsdown 的 alias 收绝对路径最稳，这里把相对 paths 解析成绝对路径。
 */
const SHIMS = loadShims();

/** 主进程与启动器共用的编译口径 */
const shared = {
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  dts: false,
  outDir: 'lib',
  clean: false,
};

export default defineConfig([
  {
    ...shared,
    format: ['cjs'],
    entry: { 'app-main': 'src/app/main.ts' },
    // `@electron/get` **不能外部化**：便携包里没有 node_modules，裸 require 会在启动瞬间
    // ERR_MODULE_NOT_FOUND（表现为一个什么都看不到的 "Error" 弹框）。它由下面的 alias 换成替身。
    noExternal: [/^@deepseek-ai\/(?:dsh-home-paths|dsh-credentials|dsh-llm)$/, '@electron/get'],
    external: [
      /^electron$/,
      /^@electron\/(?!get$)/,
      /^node:/,
      /^@deepseek-ai\/(?!dsh-home-paths$|dsh-credentials$|dsh-llm$)/,
    ],
    alias: {
      ...SHIMS,
      // @electron/get 不在 tsconfig paths 里（它在 node_modules 里，类型正常），
      // 但便携包不能带 node_modules，所以构建期换成替身
      '@electron/get': join(packageRoot, 'src', 'app', 'shims', 'electron-get.ts'),
    },
    outputOptions: { entryFileNames: '[name].cjs' },
  },
  {
    ...shared,
    entry: { 'app-launch': 'src/app/launch.ts' },
    // 启动器跑在普通 Node 里（node_modules 在），@electron/get 保持外部引用即可
    external: [/^@electron\//, /^node:/, /^@deepseek-ai\//],
  },
  {
    // 命令行工具：把 Electron 下到 $DSH_HOME/electron（CI 与用户手动修复都用它）。
    // 只是 helper-process.ts 里 ensureElectronDownload 的薄包装，不再有第二份下载实现。
    ...shared,
    entry: { 'ensure-electron': 'src/app/ensure-electron.ts' },
    external: [/^@electron\//, /^node:/, /^@deepseek-ai\//],
  },
  {
    entry: { 'app-settings': 'src/app/page/entry.tsx' },
    format: ['iife'],
    platform: 'browser',
    target: 'es2020',
    dts: false,
    outDir: 'lib',
    clean: false,
    noExternal: [/^react/, /^scheduler/],
    // react 打生产包：dev 版会把 React 18.3 的迁移告警刷满日志，且体积大一半
    define: { 'process.env.NODE_ENV': '"production"' },
    outputOptions: { entryFileNames: '[name].js' },
  },
]);
