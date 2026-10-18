# 运行时 UI 回归

在 `dsh-pet/` 包目录运行：

```sh
npm install
npm run build
npx playwright install chromium
DSH_PET_ELECTRON=<一份 electron 可执行文件> npm run test:ui
```

Linux CI 缺少系统库时用 `npx playwright install --with-deps chromium`。

两个用例，都需要 `DSH_PET_ELECTRON` 指向一份 Electron 可执行文件（没有就整体跳过）：

| 用例                      | 平台                 | 覆盖                                                                                            |
| ------------------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| `desktop-window.test.mjs` | 全平台（需显示环境） | 真实拉起应用主进程：宠物窗口出现、渲染端拿到配置、bridge 可用、素材经 scheme 加载且**真的在播** |
| `desktop-macos.test.mjs`  | 仅 macOS             | 原生几何（窗口跟随宠物包围盒）、HiDPI 下的菜单摆位、点击穿透恢复                                |

`desktop-window` 是唯一能抓到「窗口建出来了但页面白屏」的检查——`npm test` 全是纯逻辑与
源码守卫，`npm run app:smoke` 只覆盖 HTTP 侧。

设置页不走 Playwright：它由 `npm run app:smoke` 覆盖（真实应用 + mock 模型端点，
验配置读写、模型清单、碎碎念、对话、通知帧、工作状态），单元测试另跑 `npm test`。
