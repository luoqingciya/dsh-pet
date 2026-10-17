# 运行时 UI 回归

在 `dsh-pet/` 包目录运行：

```sh
npm install
npm run build
npx playwright install chromium
npm run test:ui
```

Linux CI 缺少系统库时用 `npx playwright install --with-deps chromium`。

当前只有一个用例：`desktop-macos.test.mjs` —— 在 macOS 上用真实 Electron 拉起桌面窗口，
验证原生几何（窗口跟随宠物包围盒）、HiDPI 下的菜单摆位与点击穿透恢复。
其余平台会自动跳过（`skip: process.platform !== 'darwin'`），需要设置 `DSH_PET_ELECTRON`
指向一份 Electron 可执行文件。

设置页不走 Playwright：它由 `npm run app:smoke` 覆盖（真实应用 + mock 模型端点，
验配置读写、模型清单、碎碎念、对话、通知帧、工作状态），单元测试另跑 `npm test`。
