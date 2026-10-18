# 运行时 UI 回归

在 `dsh-pet/` 包目录运行：

```sh
npm install
npm run build
npx playwright install chromium
DSH_PET_ELECTRON=<一份 electron 可执行文件> npm run test:ui
```

Linux CI 缺少系统库时用 `npx playwright install --with-deps chromium`。

六个用例，都需要 `DSH_PET_ELECTRON` 指向一份 Electron 可执行文件（没有就整体跳过）：

| 用例                         | 平台                 | 覆盖                                                                                                                                     |
| ---------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-window.test.mjs`    | 全平台（需显示环境） | 真实拉起应用主进程：宠物窗口出现、渲染端拿到配置、bridge 可用、素材经 scheme 加载且**真的在播**、对话状态/通知、状态灯、对话弹窗显示记忆 |
| `prompt-cache.test.mjs`      | 全平台               | mock 模型端点录下**真实请求体**：system 逐字稳定且不含时间行、时间只在最后一条 user、历史保持原文；顺带验证 `--port` 生效                |
| `update-and-models.test.mjs` | 全平台               | 版本检查（发现新版写日志、关掉开关后**一个请求都不发**）；设置页「模型」输入框从端点 `/models` 拿到建议（自绘下拉真的展开了）            |
| `tray-menu.test.mjs`         | 全平台               | 自绘托盘菜单：窗口弹出并渲染出全部菜单项、尺寸按 uiScale 放大、点「退出」真的退出应用                                                    |
| `shutdown.test.mjs`          | 全平台               | `POST /shutdown` **真的**停掉应用：进程退出、端口不再响应、日志留痕（它会杀掉被测应用，所以单独一个文件）                                |
| `desktop-macos.test.mjs`     | 仅 macOS             | 原生几何（窗口跟随宠物包围盒）、HiDPI 下的菜单摆位、点击穿透恢复                                                                         |

`desktop-window` 是唯一能抓到「窗口建出来了但页面白屏」的检查——`npm test` 全是纯逻辑与
源码守卫，`npm run app:smoke` 只覆盖 HTTP 侧。

`prompt-cache` 的价值在于**验真实 HTTP 体**：单测只能看到宿主传给 llm 的
`{ system, messages }`，而真正发出去的是 OpenAI 形状（system 折成 `messages[0]`）。
断言读 `body.system` 会永远读到 `undefined`、测试"通过"却什么都没验——写这个用例时踩过一次。

设置页不走 Playwright：它由 `npm run app:smoke` 覆盖（真实应用 + mock 模型端点，
验配置读写、模型清单、碎碎念、对话、通知帧、工作状态），单元测试另跑 `npm test`。
