# 本地应用（不装 DSH）

这个仓库原本是 **DeepSeek Harness 插件**。本目录下的 `src/app`、`scripts/package-app.mjs`
与两个启动脚本，把它变成了一只**独立的桌面应用**：不需要 DSH、不需要浏览器、不需要联网登录，
双击就能在桌面上养这只桌宠。

> 插件形态**没有被删除**：`src/host` / `src/client` 仍是插件本体，`dsh plugin add` 照常可用。
> 本地应用只是给同一份源码换了一个宿主。

---

## 1. 三种启动方式

| 方式                         | 命令                                                        | 适合谁              |
| ---------------------------- | ----------------------------------------------------------- | ------------------- |
| **便携版**（推荐给最终用户） | `npm run app:package` → 双击 `dist/dsh-pet-app/dsh-pet.exe` | 不装 Node，解压即用 |
| 仓库内运行                   | `npm run app`                                               | 改代码时            |
| 全局命令                     | `npm i -g .` → `dsh-pet-app`                                | 习惯命令行          |

Windows 上也可以直接双击仓库根目录的 **`dsh-pet.cmd`**（首次会自动装依赖并构建）。

---

## 2. 功能对照：DSH 插件 vs 本地应用

| 能力                          | DSH 插件             | 本地应用           | 说明                                           |
| ----------------------------- | -------------------- | ------------------ | ---------------------------------------------- |
| 动画链 / 随机动作 / 待机      | ✅                   | ✅                 | 同一份 `src/shared` 纯逻辑与素材               |
| 点击 / 拖拽 / 甩抛 / 碰撞     | ✅                   | ✅                 | 同一套物理与 Electron 透明窗                   |
| 右键菜单 / 多开 / 屏幕漫游    | ✅                   | ✅                 | 同上                                           |
| pet pack（新宠物种类）        | ✅                   | ✅                 | 仍扫描 `$DATA/dsh-pet/pet/`                    |
| 设置页（大小/位置/物理/字体） | ✅ DSH 设置页        | ✅ 独立设置窗      | 复用 `src/client/settings.ts`，一行没改        |
| 余额动画 + 气泡               | ✅ 走 DSH 凭据       | ✅ 本地密钥直连    | 支持 DeepSeek / OpenCode Zen Go / Command Code |
| 碎碎念 / 对话                 | ✅ 走 DSH 模型       | ✅ OpenAI 兼容端点 | 默认 DeepSeek，可指 Ollama / 任意兼容服务      |
| 系统通知                      | ✅ DSH 会话事件      | ⚠️ 本地事件        | 见下方「能力边界」                             |
| 工作状态联动                  | ✅ 跟随 DSH 会话     | ⚠️ 跟随本地对话    | 生成中「思考」→ 完成「成功」/ 失败「出错」     |
| 第三方 HTTP 接口              | ✅ `/dsh-pet-7340/*` | ✅ 同一套          | 端口默认 3080，仅本机                          |

### 能力边界（如实说明）

- **工作状态**：DSH 里的六个档位来自 agent 会话（思考 / 工作 / 整理 / 等待 / 成功 / 出错）。
  本地应用没有 agent，只有「宠物自己在生成一句话」这件事，因此只有
  `thinking → success / error` 三档会被真实触发，另外三档保留在配置里但不会被激活。
- **系统通知**：DSH 的通知覆盖「对话完成 / 生成失败 / 输出截断 / 权限申请 / 用户选择」。
  本地应用只剩前两类有对应事件，另外新增一类本地专有提醒（余额已用 ≥ 90%）。
  帧的生成仍然走插件自己的 `notify-events.ts`（由应用合成 `turn/start`、`turn/end` 会话事件驱动），
  文案映射仍来自 `src/shared/notify.ts`——不是另写一套。
- **账号余额**（`deepseek-account`，DSH 平台登录态）本地不可用：它没有 API Key，
  凭证在 DSH 的账号服务里。设置页选它只会得到一句明确说明。

---

## 3. 架构

```
┌──────────────────────────── dsh-pet.exe（Electron 主进程）────────────────────────────┐
│  src/app/main.ts                                                                       │
│   ├─ 本地宿主  src/app/context.ts                                                      │
│   │    ├─ credentials  →  $DATA/dsh-pet/secrets.json（0600）                           │
│   │    ├─ llm          →  src/app/llm-openai.ts（OpenAI 兼容 SSE）                    │
│   │    ├─ agentDefaultModel → $DATA/dsh-pet/app-config.json                            │
│   │    └─ on/emit      →  合成 turn/start、turn/end 会话事件                            │
│   ├─ 插件宿主半边  src/host/index.ts 的 apply()                                        │
│   │    └─ 路由表 / 配置合并 / 素材归属 / HelperProcess 守护（一行没改）                  │
│   ├─ 本地服务  src/standalone/server.ts（127.0.0.1，默认 3080）                          │
│   │    ├─ /dsh-pet-7340/*   ← 插件原生路由（第三方接口照旧可用）                         │
│   │    └─ /app/*            ← 设置页 + 本地服务接口（src/app/web-ui.ts）                │
│   ├─ 设置窗口  BrowserWindow → http://127.0.0.1:<port>/app/                            │
│   ├─ 托盘      打开设置 / 重载配置 / 打开数据目录 / 退出                                  │
│   └─ 通知      src/app/notifications.ts（轮询 /state → 原生 Notification）              │
└────────────────────────────────────────────────────────────────────────────────────────┘
                                   │  spawn（与 DSH 内运行同一条路径）
                                   ▼
                 runtime/electron-helper（每只宠物一个透明置顶小窗）
```

**设计上的一条硬规则**：本地应用**不重写任何宠物业务**。路由、配置合并、动画池、物理、
菜单、气泡全部复用插件那一份源码；`src/app` 只补「DSH 原本提供、脱离后必须自带」的三件事：
**凭证 / 模型 / 通知通道**，外加一个壳（托盘 + 设置窗 + 启动器）。

这样做的好处是：插件以后新增端点或动画，本地应用自动跟着变，不存在两套实现慢慢漂移。

---

## 4. 数据目录

| 平台    | 目录                                     |
| ------- | ---------------------------------------- |
| Windows | `%APPDATA%\dsh-pet\`                     |
| macOS   | `~/Library/Application Support/dsh-pet/` |
| Linux   | `~/.config/dsh-pet/`                     |

```
<数据目录>/
└─ dsh-pet/
   ├─ main-config.jsonc    ← 桌宠配置（与插件同一份格式）
   ├─ app-config.json      ← 本地服务配置（服务商 / 模型 / 端点 / 通知开关）
   ├─ secrets.json         ← API Key（权限 0600，单独一份便于「贴配置不泄露」）
   ├─ memory.json          ← 对话记忆
   ├─ main-animation/      ← 自定义动画（webm）
   └─ pet/                 ← 额外宠物种类（pet pack）
```

**首次启动会自动接管** `~/.dsh/dsh-pet/`（DSH 插件时期的数据）：大小、位置、自定义素材、
pet pack 全部保留，不用重配一遍。只在新目录不存在时做一次，不会覆盖。

---

## 5. 配置本地服务

打开设置窗（托盘 → 打开设置）→「本地服务」页签：

1. **服务商**：DeepSeek 官方 / Ollama（本机）/ 自定义（OpenAI 兼容）
2. **模型**：如 `deepseek-chat`、`qwen2.5:7b`
3. **接口地址**：OpenAI 兼容根地址（不带 `/chat/completions`）
4. **API Key**：写入 `secrets.json`；已配置的不回显，留空表示不修改
5. **余额服务商**：默认跟随模型服务商，也可单独指定（例如对话走 Ollama、余额查 DeepSeek）
6. **系统通知**：对话回复 / 余额告急

点「测试连通」可直接验证端点 + 密钥 + 模型是否可用，失败会把服务端返回的原文带出来。

对应的命令行等价物：

```sh
curl -X POST http://127.0.0.1:3080/app/api/config \
  -H 'content-type: application/json' \
  -d '{"config":{"provider":"deepseek-official","model":"deepseek-chat"},
       "keys":{"DEEPSEEK_API_KEY":"sk-..."}}'
```

---

## 6. 打包便携版

```sh
npm run build          # 构建 lib（含 app-main.cjs / app-settings.js）
npm run app:package    # → dist/dsh-pet-app/
```

打包脚本做的事：把 `$DSH_HOME/electron` 里的 Electron 运行时拷进输出目录 → 改名为
`dsh-pet.exe` → 把 `lib` / `runtime` / `assets` 放进 `resources/app/` → 写一份精简
`package.json`（`main: lib/app-main.cjs`）。全程离线，用的是插件桌面模式已经下好的那份 Electron。

**限制（明确说）**：不做代码签名，也不改 exe 的图标与版本信息（需要 Windows 资源编辑工具）。
便携版的定位是「解压即用」，不是应用商店分发。

---

## 7. 排障

| 现象                                   | 原因与处理                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| 启动后桌面没有宠物                     | 检查 `main-config.jsonc` 里宠物的 `display` 是否为 `desktop` / `both`；托盘「重载配置」 |
| 碎碎念/对话报「缺少 API Key」          | 设置页「本地服务」填写对应密钥，或把服务商切到不需要密钥的本机 Ollama                   |
| 碎碎念/对话报「模型接口返回 HTTP 401」 | 密钥无效或与端点不匹配（DeepSeek 的 key 不能用于自定义端点）                            |
| 余额只弹一句文字说明                   | 该服务商没有余额接口，或所选服务商缺密钥；气泡第二行会给出 provider id 与原因           |
| 端口 3080 被占用                       | 启动器 `--port 3100`，或 `DSH_PET_APP_PORT=3100`                                        |
| 想看详细日志                           | `DSH_PET_APP_DEBUG=1 npm run app`                                                       |

---

## 8. 许可与二创

代码 MIT；素材（动画 / 提示词 / 源视频）允许开源使用、**禁止商用**。
基于本项目的衍生作品，在介绍、展示、分发处须附原作者地址：
<https://github.com/PC2005-cloud/dsh-pet>
