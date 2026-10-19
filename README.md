# dsh-petNG 🐾

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-8A2BE2">
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Electron%2043-47848F">
  <img alt="assets" src="https://img.shields.io/badge/animations-106%20%E6%AE%B5-ff69b4">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-orange"></a>
</p>

一只住在桌面上的**透明置顶桌宠**：待机呼吸、随机小动作（打瞌睡、玩魔方、涮火锅……）、
左右转向、屏幕漫游、点击 Q 弹、拖拽甩抛反弹、右键点播——一百余段手绘风透明动画随时无缝衔接。
它还能查余额、按心情碎碎念、陪你聊两句，回话完成或余额告急时弹系统通知。

**不依赖任何 Agent 框架**：不需要 DeepSeek Harness、不需要登录，装好就能跑；
设置页是应用内的独立窗口，也允许用浏览器打开（排障时方便）。

---

## 快速开始

### 方式一：安装版（Windows）

到 [Releases](https://github.com/luoqingciya/dsh-pet-ng/releases) 下载 `dsh-pet-ng-<版本>-win-x64-setup.exe`，
双击安装。装到当前用户目录（`%LOCALAPPDATA%\Programs\dsh-petNG`），不需要管理员权限，
开始菜单与桌面都有快捷方式。

**数据就在安装目录下的 `data/`**：卸载时随程序一起删除，不往系统盘其它地方留东西。

> **升级不会丢配置**：安装包在升级前会先把 `data/` 挪到安装目录同级，装完再挪回来
> （electron-builder 的 NSIS 默认会整个删掉安装目录，这正是从前"更新一次配置全没"的原因）。
> 免安装版没有这个问题——解压覆盖同一个文件夹即可，数据就在里面。

### 方式二：免安装版（全平台）

下载对应平台的压缩包（`dsh-pet-ng-<版本>-<平台>-<架构>.zip`），解压到任意**可写**目录
（包里是一个 `dsh-pet-ng/` 文件夹，整个放过去即可）后：

- Windows：双击 `dsh-petNG.exe`
- macOS：双击压缩包里的 `Electron.app`（包内可执行文件已改名为 `dsh-petNG`；想让它显示成
  `dsh-petNG.app` 可以自己重命名整个 bundle）
- Linux：运行 `./dsh-petNG`

**数据就在解压目录下的 `data/`**：整个目录拷走即迁移，删掉即卸载干净。

宠物出现在屏幕右上角，托盘图标里可以打开设置、重载配置、检查更新、打开数据目录、退出
（右键托盘图标弹出菜单；菜单与宠物右键菜单是同一套样式，字号跟随系统缩放）。

> **首次启动**会额外打开一次设置窗，引导你填模型与 API Key；之后启动就只出宠物
> （设置窗随时可以从托盘或右键菜单打开）。

### 方式三：从源码运行

```sh
git clone git@github.com:luoqingciya/dsh-pet-ng.git
cd dsh-pet-ng
npm install
npm run app
```

首次启动会自动下载一份 Electron 运行时（约 350MB，只下一次；打包版已自带，不需要下载），
落在**本应用自己的缓存目录**：Windows `%LOCALAPPDATA%\dsh-petNG\electron`、
macOS `~/Library/Caches/dsh-pet-ng/electron`、Linux `~/.cache/dsh-pet-ng/electron`
（不再写进 `~/.dsh`——那是 DeepSeek Harness 的目录，本项目已经脱离它）。
要换位置用 `DSH_PET_ELECTRON_DIR`，要复用已有的 Electron 用 `DSH_PET_ELECTRON_PATH`。
`npm run app` 会先构建再启动，改完代码重跑即可。源码态的数据放在 Electron 的用户目录
（`%APPDATA%\dsh-petNG`），与打包版互不干扰。

### 方式四：双击启动脚本

Windows 直接双击仓库里的 `dsh-pet-ng.cmd`；macOS / Linux 运行 `./dsh-pet-ng.sh`。
首次会自动装依赖并构建。

> **端口**：本地服务默认监听 `127.0.0.1:7340`（与 DeepSeek Harness 的 3080 错开）。
> 被占用会自动顺延；要固定别的端口用 `dsh-petNG --port <端口>` 或环境变量 `DSH_PET_APP_PORT`。

---

## 功能

- **动画链**：每个动画（含待机）播完按权重选下一个，首尾相接；权重在 `config.jsonc` 里可调
- **事件动画**：余额 / 碎碎念 / 对话状态按档位触发专属动画，档内可配候选数组（随机抽 + 循环轮换）
- **多开**：同时养多只，各自独立大小与位置
- **屏幕漫游**：朝朝向方向行走，先探测空间、不走出屏幕（多屏按各屏边界判定）
- **点击 / 拖拽 / 甩抛**：点击有回应动画并 Q 弹挤压；拖拽弹簧跟手，甩出即抛物线飞行、屏幕边缘反弹、
  落地摩擦停稳；多只宠物之间还能互相撞开
- **右键菜单**：动作 → 分类 → 具体动画任意点播；工具项：打开设置 / 查看余额 / 碎碎念 / 对话 / 回到初始位置 / 重载配置
- **托盘菜单**：打开设置 / 重载配置 / 检查更新 / 打开数据目录 / 退出——**自绘**的，字号跟随系统缩放
  （原生托盘菜单在高分屏上不跟 DPI 补偿，会明显偏小）
- **余额展示**：按已用百分比分档播动画 + 头顶气泡（DeepSeek 余额 / OpenCode Zen Go 与 Command Code 的额度窗口）
- **碎碎念与对话**：按周期自动生成一句；右键随时开口；对话有记忆（落盘、重启不丢），
  弹窗打开时顶部会显示最近几条——记住的和看到的永远是同一份
- **状态灯**：回话时切「思考 → 成功 / 出错」；也能由任何脚本点亮——本机任务跑到哪一步，桌宠就演哪一档
- **系统通知**：回话完成 / 生成失败、余额告急时弹原生通知
- **开机自启**：设置页「启动」一勾即可（Windows 写 `HKCU\…\CurrentVersion\Run`、
  macOS 走登录项、Linux 按 XDG 规范写 `~/.config/autostart/dsh-petNG.desktop`）；
  状态以系统为准——在「任务管理器 → 启动」里禁掉后，设置页会如实显示为关
- **更新提示**：启动后查一次新版本，有新版弹通知、点一下打开下载页（**只提示，不自动替换文件**）；
  托盘「检查更新」可随时手动查
- **自定义**：往数据目录丢 VP9-alpha `.webm` 就是新动画；`pet/` 下建配置就能加**全新宠物种类**
- **无障碍**：支持 `prefers-reduced-motion`（减少动效时跳过 Q 弹与淡入）

---

## 设置

托盘图标 →「打开设置」，或浏览器打开 <http://127.0.0.1:7340/app/>。

### 桌宠

每只宠物独立配置：名字、大小、**是否显示在桌面**、贴哪个角与偏移、四个功能开关
（余额动画 / 碎碎念 / 状态灯 / 待在原地）。
全局配置：配图开关、抛掷锁定屏幕、字体与字号、对话记忆轮数、拖拽手感（重力 / 弹性 / 摩擦 / 力度 / 互撞）。
底部的「启动」一栏是**开机自启**：立刻生效，不跟「保存」走（见上面的功能说明）。

### 本地服务

模型与密钥都在这里，**改完立即生效**：

| 项         | 说明                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 服务商     | DeepSeek 官方 / Ollama（本机）/ OpenAI / 阿里云百炼（通义千问）/ 自定义（OpenAI 兼容）                                                           |
| 模型       | 如 `deepseek-flash`、`deepseek-v4-pro`、`qwen-plus`、`qwen2.5:7b`；**必填**（预设里已填好）。输入框会从端点 `/models` 拉下拉建议，也可以直接手填 |
| 接口地址   | OpenAI 兼容根地址（不带 `/chat/completions`）                                                                                                    |
| API Key    | 存在本机 `secrets.json`，**用系统密钥加密**（Windows DPAPI / macOS 钥匙串 / Linux libsecret）；只写不读、不回显                                  |
| 余额服务商 | 默认跟随模型服务商，也可单独指定（对话走 Ollama、余额查 DeepSeek）                                                                               |
| 通知       | 对话结果（完成或失败）/ 余额告急                                                                                                                 |
| 更新       | 启动时检查新版本（可关）+ **「立即检查」按钮**（结果就地显示，有新版本给下载页链接）。只提示 + 打开下载页，不会自动下载或覆盖文件                |
| 退出       | 设置页底部也有「退出 dsh-petNG」（托盘菜单之外的第二条退出路径）                                                                                 |

点「测试连通」可直接验证端点 + 密钥 + 模型是否可用，失败会把服务端返回的原文带出来。

> **关于模型名**：2026-07-24 起 DeepSeek 停用了 `deepseek-chat` / `deepseek-reasoner`，
> 现行模型是 `deepseek-flash` 与 `deepseek-v4-pro`，预设已经跟上。其余服务商的模型清单
> 默认留空、由端点的 `/models` 现拉——比在代码里硬编码一串会过期的名字可靠。
> DeepSeek 预设会显式关闭「思考模式」（V4 默认开启）：桌宠只要一句话，开着会白等几秒推理。

> 人设（碎碎念与对话共用的 system 提示词）在配置文件的 `whisperPrompt` 字段里，默认已经写好；
> 想换语气直接改那一行。

---

## 效果预览

**待机 / 移动**

<p>
  <img src="dsh-pet-ng/assets/preview/daiji-huxi-xiuxian.gif" width="150" alt="待机呼吸">
  <img src="dsh-pet-ng/assets/preview/dongzhangxiwang.gif" width="150" alt="东张西望">
  <img src="dsh-pet-ng/assets/preview/pangxie-zoulu.gif" width="150" alt="螃蟹走路">
</p>

**小动作 / 玩耍**

<p>
  <img src="dsh-pet-ng/assets/preview/chaoda-shenlanyao.gif" width="150" alt="超大伸懒腰">
  <img src="dsh-pet-ng/assets/preview/xie-daima.gif" width="150" alt="写代码">
  <img src="dsh-pet-ng/assets/preview/yuandi-zhuanxin-wan-mofang.gif" width="150" alt="玩魔方">
  <img src="dsh-pet-ng/assets/preview/lu-mao.gif" width="150" alt="撸猫">
</p>

**吃什么 / 时节**

<p>
  <img src="dsh-pet-ng/assets/preview/shuan-huoguo.gif" width="150" alt="涮火锅">
  <img src="dsh-pet-ng/assets/preview/chi-token.gif" width="150" alt="吃 Token">
  <img src="dsh-pet-ng/assets/preview/duixueren.gif" width="150" alt="堆雪人">
  <img src="dsh-pet-ng/assets/preview/fang-yanhua.gif" width="150" alt="放烟花">
</p>

**交互与状态**

<p>
  <img src="dsh-pet-ng/assets/preview/dianji-huiying-kaixin-yuedong.gif" width="150" alt="点击回应">
  <img src="dsh-pet-ng/assets/preview/beishubiao-tuozhuai-xuankong-fankui.gif" width="150" alt="拖拽悬空">
  <img src="dsh-pet-ng/assets/preview/qian-dai-man-yi.gif" width="150" alt="余额-钱袋满溢">
  <img src="dsh-pet-ng/assets/preview/suisuinian-fadai-suisuinian.gif" width="150" alt="碎碎念">
  <img src="dsh-pet-ng/assets/preview/gongzuozhuangtai-sikao-maopao.gif" width="150" alt="工作状态-思考">
</p>

全部 106 段动画见 `dsh-pet-ng/assets/preview/`（GIF 仅作展示；实际播放用同名的透明 webm）。

---

## 自定义

### 加动作

把 VP9-alpha 编码的透明 `.webm` 放进数据目录的 `main-animation/webm/`，右键「重载配置」后即可点播；
想让它在随机链里出现，在 `config.jsonc` 的 `animations` 里加个名字。

### 加宠物种类（pet pack）

```
<数据目录>/dsh-pet-ng/pet/
├─ pig-config.json      ← 与主配置同构；**只写要覆盖的顶层字段**，没写的取内置默认
└─ pig-animation/       ← 这个种类自己的素材，平铺放 .webm
```

扫描 `pet/` 自动发现，桌面同时生效；一个种类文件可放任意多只实例，共享同一套素材。
设置页只列出主宠物；文件宠物改完右键「重载配置」即生效。

> 顶层字段是**整段替换**：写了 `animations` 就整段用自己的（缺的子键不会从内置默认补回来）。
> 所以新种类通常要自己写一份 `animations` / `animationWeights`，否则会沿用主宠物的动画池。

---

## 对外 HTTP 接口

桌宠不只是个摆设：它把全部能力挂在 `http://127.0.0.1:7340/dsh-pet-ng-7340`（只监听本机、无鉴权），
别的脚本可以让它说话、点播动画、读它的状态。

- 一览：[`API.md`](API.md)
- 完整契约（OpenAPI 3.1，可导入 Swagger UI / Postman）：[`openapi.yaml`](openapi.yaml)
- 控制台：`node tools/api-tester.cjs`

### 把它当状态灯用

6 个档位（思考 / 干活 / 收尾 / 等你确认 / 成功 / 出错）原本是给 agent 会话用的。
现在没有 agent 了，于是把入口开放出来：任何脚本、IDE 插件、CI 都能点亮它。

```sh
node tools/pet-status.mjs working "跑测试"     # 切「干活」，气泡显示「跑测试」
node tools/pet-status.mjs success              # 切「成功」
node tools/pet-status.mjs clear                # 熄灭，回到空闲

# 或者直接用接口（不依赖仓库里的脚本）
curl -s -X POST http://127.0.0.1:7340/dsh-pet-ng-7340/work-status \
     -H 'content-type: application/json' \
     -d '{"state":"waiting","text":"等你确认一下"}'
```

`ttlSec`（默认 900 秒）到期自动熄灭——脚本崩了也不会让宠物永远卡在「干活」里。
状态是全局的，只有开了设置里「状态灯」开关的宠物会演。

---

## 架构

```
dsh-petNG.exe（单个 Electron 进程）
 ├─ 本地服务 127.0.0.1:7340
 │   ├─ /dsh-pet-ng-7340/*   宿主半边：配置合并 / 状态仓 / 素材 / 余额 / 对话（src/host）
 │   └─ /app/*            设置页与本地服务接口（src/main/web-ui.ts）
 ├─ 宿主上下文（src/main/context.ts）
 │   ├─ credentials → secrets.json     ├─ llm → OpenAI 兼容端点
 │   └─ 事件总线（合成 turn/start、turn/end 驱动工作状态与通知）
 ├─ 托盘 / 设置窗口 / 原生通知
 └─ 桌面窗口层（src/main/desktop.ts + src/desktop/windows.js）
     └─ 每只宠物一个透明置顶小窗；渲染端请求经 dsh-pet-ng-bridge:// 直接调宿主路由
```

设计上有两条硬规则：**只有一份宠物业务**，以及**分层只允许单向依赖**。

| 层             | 可以依赖                      | 职责                                            |
| -------------- | ----------------------------- | ----------------------------------------------- |
| `src/main`     | api · desktop · core · shared | Electron 壳：进程、窗口、托盘、协议、自动更新   |
| `src/api`      | core · shared                 | HTTP 契约：路由与请求/响应形状                  |
| `src/desktop`  | shared                        | 桌面窗口层（渲染端，经典 script）               |
| `src/ui`       | shared                        | 设置页（浏览器代码，**不许 import `node:*`**）  |
| `src/core`     | shared · platform             | 纯业务：配置 / 状态 / 素材 / 余额 / 对话        |
| `src/shared`   | —                             | 纯逻辑（菜单、气泡、物理、文案）；见下方注      |
| `src/platform` | —                             | electron 的薄封装，让 core 能脱离 electron 单测 |

> 「两端共用」里的另一端是浏览器 overlay（DSH 插件侧），**已随项目剥离移出本仓库**。
> `src/shared` 仍按「两端同构」维护：改动时以这里的实现为准，代码注释里提到的
> `src/client/pet.ts` / `notify.ts` 都是那份已移出的实现（用于解释"为什么要拆成这样"）。

`npm run check:layers` 把这条规则当门禁跑（CI 的 verify 里）：反向边、循环依赖、
以及 `ui` / `desktop` 里误引 `node:*` 都会直接判红。测试文件整份豁免——它们要跨层做集成验证。

路由、配置合并、动画池、物理、菜单、气泡全部在 `src/core` + `src/shared`；`src/main` 只补
「宿主该提供的东西」（凭证 / 模型 / 通知）和一个壳。
加一个端点或改一处动画逻辑，桌面窗口、设置页、HTTP 接口同时生效。

宿主半边需要的三样「框架级」原语——LLM 消息构造、凭证引用、用户数据根——在
`src/core/standalone/` 有一份本地实现。项目**不依赖任何 Agent 框架**，源码里也不出现
DSH 的包名（`npm run prepack` 会扫描产物，混进 `@deepseek-ai/*` 直接判失败）。

桌宠窗口与宿主在**同一个进程**里：渲染端的每个请求走 `dsh-pet-ng-bridge://` scheme，
`protocol.handle` 直接调宿主路由（同进程函数调用，不经网络、不经管道）。早先的版本把窗口层
放在一个独立的 Electron 子进程里、用 stdout 管道通信——那套间接层已整体移除，
省掉一整套常驻的 Electron 基础进程（实测 7 进程 / 575MB → 4 进程 / 约 350MB）。

---

## 数据目录

**打包版：数据跟着程序走。**

| 形态              | 数据目录                                                                  |
| ----------------- | ------------------------------------------------------------------------- |
| 安装版（Windows） | `<安装目录>\data\`（默认 `%LOCALAPPDATA%\Programs\dsh-petNG\data\`）      |
| 免安装版          | `<解压目录>\data\`                                                        |
| 源码运行          | `%APPDATA%\dsh-petNG\`（macOS `~/Library/Application Support/dsh-petNG`） |

```
<数据目录>/
├─ electron/           Electron 自己的缓存（Chromium profile，可随时删）
└─ dsh-pet-ng/
   ├─ main-config.jsonc   桌宠配置（大小 / 位置 / 动画池 / 权重 / 物理 / 字体 / 人设）
   ├─ app-config.json     本地服务配置（服务商 / 模型 / 端点 / 通知开关）
   ├─ secrets.json        API Key（系统密钥加密）
   ├─ memory.json         对话记忆
   ├─ app.log             运行日志（排障时先看它）
   ├─ .initialized        首次运行标记（删掉它，下次启动会重新弹设置窗）
   ├─ main-animation/webm/  自定义动画（VP9-alpha .webm）
   └─ pet/                额外宠物种类
```

免安装版请解压到**可写**目录（用户目录、D 盘任意文件夹都行）。若放在只读位置（如
`Program Files`），应用会自动回落到用户目录启动，并在日志里说明。

**改名说明（`dsh-pet` → `dsh-petNG`）**：产品改名后数据目录也跟着换了，首次启动会自动接管旧数据，
按顺序取第一个存在的目录：

1. 旧安装目录旁的 `data\dsh-pet\`（安装版从 0.9.x 升级）
2. `%APPDATA%\dsh-pet\dsh-pet\`（0.9.x 源码运行）
3. `~/.dsh/dsh-pet/`（更早的 DSH 插件时期）

第 1 条要求**新旧两版装在同一个父目录下**（安装向导里改过安装位置的尤其注意）。装在别处也没关系：
把旧目录里的 `data\dsh-pet\` 整个复制到新目录的 `data\dsh-pet-ng\` 即可，效果一样。

是**复制**不是移动：旧目录原样保留，不满意可以直接退回旧版。只在「新目录里还没有用户数据」时做一次。

---

## 排障

| 现象                                  | 处理                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面没有宠物                          | 设置页「显示在桌面」是否勾上；托盘「重载配置」；看 `app.log`                                                                                                  |
| 碎碎念/对话报「缺少 API Key」         | 「本地服务」填对应密钥，或把服务商切到不需要密钥的本机 Ollama                                                                                                 |
| 报「模型接口返回 HTTP 401」           | 密钥与端点不匹配（DeepSeek 的 key 不能用于自定义端点）                                                                                                        |
| 余额只弹一句文字说明                  | 该服务商没有余额接口或缺密钥；气泡第二行会给出 provider id 与原因                                                                                             |
| 端口 7340 被占用                      | 会自动顺延；要固定用 `dsh-petNG --port 7500`（或 `npm run app -- --port 7500`），或设 `DSH_PET_APP_PORT=7500`                                                 |
| 装到 Program Files 后数据不在安装目录 | 那里对普通用户不可写，应用自动回落到用户目录；改用默认的 per-user 安装位置即可                                                                                |
| 想看详细日志                          | `DSH_PET_APP_DEBUG=1 npm run app`，或直接看 `app.log`                                                                                                         |
| 开机后没有自动启动                    | 先看「任务管理器 → 启动」里 dsh-petNG 是否被禁用（Windows 会尊重那里的开关，设置页也会跟着显示为关）；源码态挪过仓库目录的话，回设置页重新勾一次              |
| 从不提示新版本                        | 国内访问 `api.github.com` 常不通（失败静默）；托盘「检查更新」会明确报错。可用 `DSH_PET_UPDATE_API` 指向镜像或自建 JSON（`{version,url}` 或 GitHub 形状都认） |

---

## 从零生成自己的宠物

这个仓库同时保留了**素材生成链**——换角色、换动作、换风格，全流程可复现：

```
① 提示词（prompts/） → ② 源视频（video/） → ③ 透明动画（scripts/） → ④ 放进应用
```

1. 按 `prompts/桌面宠物 10 秒动作提示词.md` 的配方，用任意视频模型生成 10 秒绿幕视频（16:9，纯绿幕）
2. `scripts/` 里的 Python 管线：水印遮罩 → 绿幕抠像（或 PR 手工抠像）→ 归一化 → 转码 640×360 VP9-alpha
3. 产物放进 `dsh-pet-ng/assets/webm/`，再在 `config.jsonc` 的 `animations` 里登记名字

源视频体积大，不随仓库发布（本仓库的 Release 只提供程序包，不含源视频）——自己生成即可，生成链脚本与提示词都在仓库里。

---

## 构建与发布

```sh
npm run build           # 构建 lib（主进程 / 启动器 / 设置页 + 桌面共享核心）
npm run app             # 构建并启动
npm run app:package     # 免安装 zip 的内容目录：dist/dsh-pet-ng-app/
npm run app:installer   # Windows 安装包（NSIS）：dist/installer/dsh-pet-ng-<版本>-win-x64-setup.exe
npm run app:smoke       # 端到端冒烟（需要应用已在运行）
npm test                # 单元测试（纯逻辑 + 源码守卫）
npm run test:ui         # 真机 UI 回归（需 DSH_PET_ELECTRON 指向一份 Electron）
```

CI（`.github/workflows/build.yml`）在 Windows / macOS / Linux 上构建免安装版并上传；
Windows 额外产出安装包。推 `v*` 标签时自动创建 Release，附上三平台 zip 与 Windows 安装包。

### 发版步骤

`dev` 是开发分支，`main` 是发布分支——**`main` 只在发版时快进到 `dev`**，所以发版前它通常是旧的。

```sh
# 1. 升版本（package.json 与 package-lock 必须同步，prepack-check 会查）
npm version 1.0.1 --no-git-tag-version
git commit -am "chore(release): 1.0.1"

# 2. 跑一遍完整门禁（与 CI 的 verify 等价）
npm run prepack

# 3. dev → main 快进合并，两边都推
git push origin dev
git checkout main && git merge --ff-only dev && git push origin main

# 4. 打标签并推送——release job 只认 tag，`ui` 与 `package` 全绿才发
git tag -a v1.0.1 -m "1.0.1 —— 一句话说明"
git push origin v1.0.1
git checkout dev   # 回开发分支
```

三个容易踩的点：

- **发布说明要手写**。CI 用的是 `generate_release_notes`，而本仓库没有 PR（直接提交），它只会
  生成一行 "Full Changelog" 链接。发完补一份：
  `gh release edit v1.0.1 --notes-file notes.md`（写清修了什么、下载表、以及跨大版本的升级顺序）。
- **`ui` job 必须绿**。真机用例（托盘菜单、桌面窗口、拖拽全链路）只在 Windows runner 上跑，
  它挂了 `release` 会被跳过——tag 已经推上去了，但 Release 不存在。
- **tag 打错了可以重打**：`git tag -d v1.0.1 && git push origin :refs/tags/v1.0.1`，
  改完代码重新 `tag -a` + push 即可（Release 还没生成时没有副作用）。

写注入真实输入的 UI 用例时，优先用**合成事件 + 屏幕坐标**而不是 `page.mouse`：
后者的指针没有物理光标，窗口一移动 Chromium 就会判定指针离开并释放捕获，本地偶发通过、
CI 稳定失败（1.0.1 首轮 tag 就栽在这里，见 `7f6a81b`）。

---

## 许可

- 代码：MIT
- 素材（动画 / 提示词 / 源视频）：允许开源使用，**禁止商用**
- 本项目源自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（原作者）。
  按其约定：基于本项目的衍生 / 改版 / 换皮作品，在**任何介绍、展示、分发该作品的地方**，
  须附上原作者 GitHub 地址。
