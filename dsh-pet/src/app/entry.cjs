/**
 * 便携版应用的角色分发入口（打包后作为 `resources/app/package.json` 的 `main`）。
 *
 * 为什么需要它：打包后的 Electron（`dsh-pet.exe`）会**忽略命令行里的脚本路径**，
 * 一律加载 `resources/app`。而桌宠的透明小窗是一个独立的 Electron 进程（`runtime/electron-helper`），
 * 宿主用 `spawn(process.execPath, [helperMain])` 拉起它——在便携版里那条命令会再次加载本入口，
 * 于是"拉起 Helper"变成了"再启动一个完整应用"（实测会连开好几个实例、各占一个端口）。
 *
 * 解法：同一个可执行文件按环境变量分角色。宿主侧 `helperSpawnEnv()` 给 Helper 子进程注入
 * `DSH_PET_ROLE=helper`，本文件据此只加载小窗运行时；其余情况加载应用主进程。
 *
 * 开发态不受影响：`electron.exe lib/app-main.cjs` 是 Electron 的"跑脚本"模式，
 * 命令行路径生效，压根不会走到本文件。
 *
 * 注意：本文件是**纯 CommonJS 源码**（不是构建产物），由 `scripts/package-app.mjs` 原样拷进
 * `resources/app/lib/`。刻意用运行时 `path.join` 而不是静态 require——静态写法会被打包器
 * 当成依赖图的一部分，把两个入口都打进同一份产物里。
 */
'use strict';
/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- 本文件刻意是 CommonJS：
   它由打包后的 Electron 直接执行（不做构建），require/__dirname/process 都是 CJS 全局 */

const path = require('node:path');

if (process.env.DSH_PET_ROLE === 'helper') {
  require(path.join(__dirname, '..', 'runtime', 'electron-helper', 'main.js'));
} else {
  require(path.join(__dirname, 'app-main.cjs'));
}
