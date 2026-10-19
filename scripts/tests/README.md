# 运行时 UI 回归

在**仓库根目录**运行（包就在根上）：

```sh
npm install
npm run build
npm run ensure:electron      # 没有 Electron 运行时的话（CI / 新机器）
npm run test:ui
```

要指定另一份 Electron，用 `DSH_PET_ELECTRON=<可执行文件>`；不指定就用应用自己的运行时缓存
（`scripts/electron-runtime-dir.mjs` 解析，与应用同口径）。没有可用 Electron 时全部用例跳过。

CI 里由 `build.yml` 的 `ui` job 跑（Windows runner，有桌面会话才能真开窗口），
`release` 依赖它——真机 UI 不绿就不发版。

## 公共底座 `_harness.mjs`

端口**不再是每个文件写死的常量**，而是启动前 `bind(0)` 现取：上一轮跑挂了留下进程时，
应用会把端口顺延到下一个，而用例还在等原来那个端口的 `/health`——表现是整轮挂死
（实测两次，各挂 3 分钟以上）。现在每个用例独立端口，起不来也会在 20 秒内抛错而不是无限等。

`launchApp()` 还负责：独立临时 profile、删掉 `ELECTRON_RUN_AS_NODE`（留着就永远没有窗口）、
等 `/health` 通过、返回 `exited` promise 与 profile 路径。mock 服务用 `listenMock()`（同样现取端口）。

用例串行执行（`--test-concurrency=1`）：多个 Electron 同时启动会互相抢焦点，
而托盘菜单是失焦即收的，并行跑会让它偶发失败。

## 七个用例

| 用例                         | 平台                 | 覆盖                                                                                                                                                                                                                                                                                                |
| ---------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-window.test.mjs`    | 全平台（需显示环境） | 真实拉起应用主进程：宠物窗口出现、渲染端拿到配置、bridge 可用、素材经 scheme 加载且**真的在播**、对话状态/通知、状态灯、对话弹窗显示记忆；另含**拖拽→甩出→落地**全链路（命中层可点、越阈值、弹簧跟手、松手估速、落地收尾）与**位置驱动源唯一性**、窗口跟随（`pet:set-bounds` → `setContentBounds`） |
| `prompt-cache.test.mjs`      | 全平台               | mock 模型端点录下**真实请求体**：system 逐字稳定且不含时间行、时间只在最后一条 user、历史保持原文；顺带验证 `--port` 生效                                                                                                                                                                           |
| `update-and-models.test.mjs` | 全平台               | 版本检查（发现新版写日志、关掉开关后**一个请求都不发**）；设置页「模型」输入框从端点 `/models` 拿到建议（自绘下拉真的展开了）                                                                                                                                                                       |
| `tray-menu.test.mjs`         | 全平台               | 自绘托盘菜单：窗口弹出、5 项齐全、面板绝对定位且在视口内、**真的画出了像素**（不是全透明）、点「退出」真的退出应用                                                                                                                                                                                  |
| `autostart.test.mjs`         | 全平台               | 开机自启：设置页开关能改**系统真实状态**（写读一致）、源码态登录命令带主进程脚本；结束时按初始状态还原，不给机器留自启项                                                                                                                                                                            |
| `shutdown.test.mjs`          | 全平台               | `POST /shutdown` **真的**停掉应用：进程退出、端口不再响应、日志留痕（它会杀掉被测应用，所以单独一个文件）                                                                                                                                                                                           |
| `desktop-macos.test.mjs`     | 仅 macOS             | 原生几何（窗口跟随宠物包围盒）、HiDPI 下的菜单摆位、点击穿透恢复                                                                                                                                                                                                                                    |

> 另有一个**不属于本目录**的运行时检查：`npm run package:smoke`（`scripts/package-smoke.mjs`）
> 真的把**打包产物**拉起来等 `/health`。它补的是"能构建 ≠ 能运行"——1.0.1 的安装版缺
> `src/desktop/` 就是一路绿到用户装上才暴露的，现在 CI 的 `package` job 会跑它。

`desktop-window` 是唯一能抓到「窗口建出来了但页面白屏」的检查——`npm test` 全是纯逻辑与
源码守卫，`npm run app:smoke` 只覆盖 HTTP 侧。

`tray-menu` 与 `update-and-models` 补的是另一类：**窗口在、样式没跟上**。0.8.0 的托盘菜单
「弹出来了但一个像素都没画」、0.9.0 的「下拉字只有 2/3」，都只有这两条能发现——前者靠
`capturePage` 的 alpha 通道，后者靠比字号。

`prompt-cache` 的价值在于**验真实 HTTP 体**：单测只能看到宿主传给 llm 的
`{ system, messages }`，而真正发出去的是 OpenAI 形状（system 折成 `messages[0]`）。
断言读 `body.system` 会永远读到 `undefined`、测试"通过"却什么都没验——写这个用例时踩过一次。

设置页不走 Playwright：它由 `npm run app:smoke` 覆盖（真实应用 + mock 模型端点，
验配置读写、模型清单、碎碎念、对话、通知帧、工作状态），单元测试另跑 `npm test`。
