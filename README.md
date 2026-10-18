# dsh-pet 🐾

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

到 [Releases](https://github.com/luoqingciya/dsh-pet/releases) 下载 `dsh-pet-<版本>-win-x64-setup.exe`，
双击安装。装到当前用户目录（`%LOCALAPPDATA%\Programs\dsh-pet`），不需要管理员权限，
开始菜单与桌面都有快捷方式。

**数据就在安装目录下的 `data/`**：卸载时随程序一起删除，不往系统盘其它地方留东西。

### 方式二：免安装版（全平台）

下载对应平台的压缩包（`dsh-pet-<版本>-<平台>-<架构>.zip`），解压到任意**可写**目录
（包里是一个 `dsh-pet/` 文件夹，整个放过去即可）后：

- Windows：双击 `dsh-pet.exe`
- macOS：双击压缩包里的 `Electron.app`（包内可执行文件已改名为 `dsh-pet`；想让它显示成
  `dsh-pet.app` 可以自己重命名整个 bundle）
- Linux：运行 `./dsh-pet`

**数据就在解压目录下的 `data/`**：整个目录拷走即迁移，删掉即卸载干净。

宠物出现在屏幕右上角，托盘图标里可以打开设置、重载配置、退出。

> **首次启动**会额外打开一次设置窗，引导你填模型与 API Key；之后启动就只出宠物
> （设置窗随时可以从托盘或右键菜单打开）。

### 方式三：从源码运行

```sh
git clone git@github.com:luoqingciya/dsh-pet.git
cd dsh-pet/dsh-pet
npm install
npm run app
```

首次启动会自动下载一份 Electron 到 `~/.dsh/electron`（约 350MB，只下一次；打包版已自带，不需要下载）。
`npm run app` 会先构建再启动，改完代码重跑即可。源码态的数据放在 Electron 的用户目录
（`%APPDATA%\dsh-pet`），与打包版互不干扰。

### 方式四：双击启动脚本

Windows 直接双击仓库里的 `dsh-pet.cmd`；macOS / Linux 运行 `./dsh-pet.sh`。
首次会自动装依赖并构建。

> **端口**：本地服务默认监听 `127.0.0.1:7340`（与 DeepSeek Harness 的 3080 错开）。
> 被占用会自动顺延；要固定别的端口用 `dsh-pet --port <端口>` 或环境变量 `DSH_PET_APP_PORT`。

---

## 功能

- **动画链**：每个动画（含待机）播完按权重选下一个，首尾相接；权重在 `config.jsonc` 里可调
- **事件动画**：余额 / 碎碎念 / 对话状态按档位触发专属动画，档内可配候选数组（随机抽 + 循环轮换）
- **多开**：同时养多只，各自独立大小与位置
- **屏幕漫游**：朝朝向方向行走，先探测空间、不走出屏幕（多屏按各屏边界判定）
- **点击 / 拖拽 / 甩抛**：点击有回应动画并 Q 弹挤压；拖拽弹簧跟手，甩出即抛物线飞行、屏幕边缘反弹、
  落地摩擦停稳；多只宠物之间还能互相撞开
- **右键菜单**：动作 → 分类 → 具体动画任意点播；工具项：打开设置 / 查看余额 / 碎碎念 / 对话 / 回到初始位置 / 重载配置
- **余额展示**：按已用百分比分档播动画 + 头顶气泡（DeepSeek 余额 / OpenCode Zen Go 与 Command Code 的额度窗口）
- **碎碎念与对话**：按周期自动生成一句；右键随时开口；对话有记忆（落盘、重启不丢），
  弹窗打开时顶部会显示最近几条——记住的和看到的永远是同一份
- **状态灯**：回话时切「思考 → 成功 / 出错」；也能由任何脚本点亮——本机任务跑到哪一步，桌宠就演哪一档
- **系统通知**：回话完成 / 生成失败、余额告急时弹原生通知
- **自定义**：往数据目录丢 VP9-alpha `.webm` 就是新动画；`pet/` 下建配置就能加**全新宠物种类**
- **无障碍**：支持 `prefers-reduced-motion`（减少动效时跳过 Q 弹与淡入）

---

## 设置

托盘图标 →「打开设置」，或浏览器打开 <http://127.0.0.1:7340/app/>。

### 桌宠

每只宠物独立配置：名字、大小、**是否显示在桌面**、贴哪个角与偏移、四个功能开关
（余额动画 / 碎碎念 / 对话状态联动 / 待在原地）。
全局配置：配图开关、抛掷锁定屏幕、字体与字号、对话记忆轮数、拖拽手感（重力 / 弹性 / 摩擦 / 力度 / 互撞）。

### 本地服务

模型与密钥都在这里，**改完立即生效**：

| 项         | 说明                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| 服务商     | DeepSeek 官方 / Ollama（本机）/ OpenAI / 阿里云百炼（通义千问）/ 自定义（OpenAI 兼容）                          |
| 模型       | 如 `deepseek-flash`、`deepseek-v4-pro`、`qwen-plus`、`qwen2.5:7b`；留空则从端点的 `/models` 自动拉取            |
| 接口地址   | OpenAI 兼容根地址（不带 `/chat/completions`）                                                                   |
| API Key    | 存在本机 `secrets.json`，**用系统密钥加密**（Windows DPAPI / macOS 钥匙串 / Linux libsecret）；只写不读、不回显 |
| 余额服务商 | 默认跟随模型服务商，也可单独指定（对话走 Ollama、余额查 DeepSeek）                                              |
| 通知       | 对话结果（完成或失败）/ 余额告急                                                                                |

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
  <img src="dsh-pet/assets/preview/daiji-huxi-xiuxian.gif" width="150" alt="待机呼吸">
  <img src="dsh-pet/assets/preview/dongzhangxiwang.gif" width="150" alt="东张西望">
  <img src="dsh-pet/assets/preview/pangxie-zoulu.gif" width="150" alt="螃蟹走路">
</p>

**小动作 / 玩耍**

<p>
  <img src="dsh-pet/assets/preview/chaoda-shenlanyao.gif" width="150" alt="超大伸懒腰">
  <img src="dsh-pet/assets/preview/xie-daima.gif" width="150" alt="写代码">
  <img src="dsh-pet/assets/preview/yuandi-zhuanxin-wan-mofang.gif" width="150" alt="玩魔方">
  <img src="dsh-pet/assets/preview/lu-mao.gif" width="150" alt="撸猫">
</p>

**吃什么 / 时节**

<p>
  <img src="dsh-pet/assets/preview/shuan-huoguo.gif" width="150" alt="涮火锅">
  <img src="dsh-pet/assets/preview/chi-token.gif" width="150" alt="吃 Token">
  <img src="dsh-pet/assets/preview/duixueren.gif" width="150" alt="堆雪人">
  <img src="dsh-pet/assets/preview/fang-yanhua.gif" width="150" alt="放烟花">
</p>

**交互与状态**

<p>
  <img src="dsh-pet/assets/preview/dianji-huiying-kaixin-yuedong.gif" width="150" alt="点击回应">
  <img src="dsh-pet/assets/preview/beishubiao-tuozhuai-xuankong-fankui.gif" width="150" alt="拖拽悬空">
  <img src="dsh-pet/assets/preview/qian-dai-man-yi.gif" width="150" alt="余额-钱袋满溢">
  <img src="dsh-pet/assets/preview/suisuinian-fadai-suisuinian.gif" width="150" alt="碎碎念">
  <img src="dsh-pet/assets/preview/gongzuozhuangtai-sikao-maopao.gif" width="150" alt="工作状态-思考">
</p>

全部 106 段动画见 `dsh-pet/assets/preview/`（GIF 仅作展示；实际播放用同名的透明 webm）。

---

## 自定义

### 加动作

把 VP9-alpha 编码的透明 `.webm` 放进数据目录的 `main-animation/webm/`，右键「重载配置」后即可点播；
想让它在随机链里出现，在 `config.jsonc` 的 `animations` 里加个名字。

### 加宠物种类（pet pack）

```
<数据目录>/dsh-pet/pet/
├─ pig-config.json      ← 与主配置同构（pets / animations / animationWeights 必须写全）
└─ pig-animation/       ← 这个种类自己的素材，平铺放 .webm
```

扫描 `pet/` 自动发现，桌面同时生效；一个种类文件可放任意多只实例，共享同一套素材。
设置页只列出主宠物；文件宠物改完右键「重载配置」即生效。

---

## 对外 HTTP 接口

桌宠不只是个摆设：它把全部能力挂在 `http://127.0.0.1:7340/dsh-pet-7340`（只监听本机、无鉴权），
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
curl -s -X POST http://127.0.0.1:7340/dsh-pet-7340/work-status \
     -H 'content-type: application/json' \
     -d '{"state":"waiting","text":"等你确认一下"}'
```

`ttlSec`（默认 900 秒）到期自动熄灭——脚本崩了也不会让宠物永远卡在「干活」里。
状态是全局的，只有开了设置里「状态灯」开关的宠物会演。

---

## 架构

```
dsh-pet.exe（单个 Electron 进程）
 ├─ 本地服务 127.0.0.1:7340
 │   ├─ /dsh-pet-7340/*   宿主半边：配置合并 / 状态仓 / 素材 / 余额 / 对话（src/host）
 │   └─ /app/*            设置页与本地服务接口（src/app/web-ui.ts）
 ├─ 宿主上下文（src/app/context.ts）
 │   ├─ credentials → secrets.json     ├─ llm → OpenAI 兼容端点
 │   └─ 事件总线（合成 turn/start、turn/end 驱动工作状态与通知）
 ├─ 托盘 / 设置窗口 / 原生通知
 └─ 桌面窗口层（src/app/desktop.ts + runtime/electron-helper/windows.js）
     └─ 每只宠物一个透明置顶小窗；渲染端请求经 dsh-pet-bridge:// 直接调宿主路由
```

设计上有一条硬规则：**只有一份宠物业务**。路由、配置合并、动画池、物理、菜单、气泡全部在
`src/host` + `src/shared`；`src/app` 只补「宿主该提供的东西」（凭证 / 模型 / 通知）和一个壳。
加一个端点或改一处动画逻辑，桌面窗口、设置页、HTTP 接口同时生效。

桌宠窗口与宿主在**同一个进程**里：渲染端的每个请求走 `dsh-pet-bridge://` scheme，
`protocol.handle` 直接调宿主路由（同进程函数调用，不经网络、不经管道）。早先的版本把窗口层
放在一个独立的 Electron 子进程里、用 stdout 管道通信——那套间接层已整体移除，
省掉一整套常驻的 Electron 基础进程（实测 7 进程 / 575MB → 4 进程 / 约 350MB）。

---

## 数据目录

**打包版：数据跟着程序走。**

| 形态              | 数据目录                                                              |
| ----------------- | --------------------------------------------------------------------- |
| 安装版（Windows） | `<安装目录>\data\`（默认 `%LOCALAPPDATA%\Programs\dsh-pet\data\`）    |
| 免安装版          | `<解压目录>\data\`                                                    |
| 源码运行          | `%APPDATA%\dsh-pet\`（macOS `~/Library/Application Support/dsh-pet`） |

```
<数据目录>/
├─ electron/           Electron 自己的缓存（Chromium profile，可随时删）
└─ dsh-pet/
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

首次启动会自动接管 `~/.dsh/dsh-pet/`（旧版本的数据），只在新目录不存在时做一次。

---

## 排障

| 现象                                  | 处理                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 桌面没有宠物                          | 设置页「显示在桌面」是否勾上；托盘「重载配置」；看 `app.log`                                                |
| 碎碎念/对话报「缺少 API Key」         | 「本地服务」填对应密钥，或把服务商切到不需要密钥的本机 Ollama                                               |
| 报「模型接口返回 HTTP 401」           | 密钥与端点不匹配（DeepSeek 的 key 不能用于自定义端点）                                                      |
| 余额只弹一句文字说明                  | 该服务商没有余额接口或缺密钥；气泡第二行会给出 provider id 与原因                                           |
| 端口 7340 被占用                      | 会自动顺延；要固定用 `dsh-pet --port 7500`（或 `npm run app -- --port 7500`），或设 `DSH_PET_APP_PORT=7500` |
| 装到 Program Files 后数据不在安装目录 | 那里对普通用户不可写，应用自动回落到用户目录；改用默认的 per-user 安装位置即可                              |
| 想看详细日志                          | `DSH_PET_APP_DEBUG=1 npm run app`，或直接看 `app.log`                                                       |

---

## 从零生成自己的宠物

这个仓库同时保留了**素材生成链**——换角色、换动作、换风格，全流程可复现：

```
① 提示词（prompts/） → ② 源视频（video/） → ③ 透明动画（scripts/） → ④ 放进应用
```

1. 按 `prompts/桌面宠物 10 秒动作提示词.md` 的配方，用任意视频模型生成 10 秒绿幕视频（16:9，纯绿幕）
2. `scripts/` 里的 Python 管线：水印遮罩 → 绿幕抠像（或 PR 手工抠像）→ 归一化 → 转码 640×360 VP9-alpha
3. 产物放进 `dsh-pet/assets/webm/`，再在 `config.jsonc` 的 `animations` 里登记名字

源视频体积大，不随仓库发布（本仓库的 Release 只提供程序包，不含源视频）——自己生成即可，生成链脚本与提示词都在仓库里。

---

## 构建与发布

```sh
npm run build           # 构建 lib（主进程 / 启动器 / 设置页 + 桌面共享核心）
npm run app             # 构建并启动
npm run app:package     # 免安装 zip 的内容目录：dist/dsh-pet-app/
npm run app:installer   # Windows 安装包（NSIS）：dist/installer/dsh-pet-<版本>-win-x64-setup.exe
npm run app:smoke       # 端到端冒烟（需要应用已在运行）
npm test                # 单元测试
```

CI（`.github/workflows/build.yml`）在 Windows / macOS / Linux 上构建免安装版并上传；
Windows 额外产出安装包。推 `v*` 标签时自动创建 Release，附上三平台 zip 与 Windows 安装包。

---

## 许可

- 代码：MIT
- 素材（动画 / 提示词 / 源视频）：允许开源使用，**禁止商用**
- 本项目源自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（原作者）。
  按其约定：基于本项目的衍生 / 改版 / 换皮作品，在**任何介绍、展示、分发该作品的地方**，
  须附上原作者 GitHub 地址。
