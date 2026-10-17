# dsh-pet 🐾

一只住在桌面上的透明置顶桌宠。一百余段手绘风透明动画（待机 / 小动作 / 玩耍 / 吃什么 / 时节）、
拖拽甩抛、多开漫游、右键点播，还能查余额、碎碎念、陪你聊天。

**不需要任何 Agent 框架**：装好直接跑，宠物就在桌面上。

完整说明（功能、设置、自定义动画、素材生成链、排障）见仓库首页：
<https://github.com/luoqingciya/dsh-pet#readme>

## 安装与运行

```sh
npm i -g dsh-pet
dsh-pet                 # 首次会下载一份 Electron 到 ~/.dsh/electron
dsh-pet --port 3100     # 指定本地服务端口（默认 3080，被占用会自动顺延）
```

或者不装全局：

```sh
npx dsh-pet
```

## 设置

托盘图标 →「打开设置」，或浏览器打开 <http://127.0.0.1:3080/app/>。

- **桌宠**：多开、大小、位置、显示开关、余额/碎碎念/状态联动、字体、拖拽手感
- **本地服务**：模型服务商（DeepSeek / Ollama / 任意 OpenAI 兼容端点）、API Key、余额服务商、通知开关

API Key 存在本机 `secrets.json`（权限 0600），只写不读、不回显。

## 数据目录

| 平台    | 目录                                     |
| ------- | ---------------------------------------- |
| Windows | `%APPDATA%\dsh-pet\`                     |
| macOS   | `~/Library/Application Support/dsh-pet/` |
| Linux   | `~/.config/dsh-pet/`                     |

## 许可

代码 MIT；素材（动画 / 提示词 / 源视频）允许开源使用、**禁止商用**。
本项目源自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。
