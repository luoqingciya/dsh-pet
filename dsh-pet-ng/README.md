# dsh-petNG 🐾

一只住在桌面上的透明置顶桌宠。一百余段手绘风透明动画（待机 / 小动作 / 玩耍 / 吃什么 / 时节）、
拖拽甩抛、多开漫游、右键点播，还能查余额、碎碎念、陪你聊天。

**不需要任何 Agent 框架**：装好直接跑，宠物就在桌面上。

完整说明（功能、设置、自定义动画、素材生成链、排障）见仓库首页：
<https://github.com/luoqingciya/dsh-pet#readme>

## 安装与运行

**从 Releases 下载**（推荐）：

- Windows：`dsh-pet-ng-<版本>-win-x64-setup.exe`（安装版）或 `dsh-pet-ng-<版本>-win-x64.zip`（免安装）
- macOS：`dsh-pet-ng-<版本>-mac-arm64.zip`
- Linux：`dsh-pet-ng-<版本>-linux-x64.zip`

**从源码运行**：

```sh
npm install
npm run app                  # 首次会下载一份 Electron 到用户缓存目录（约 350MB，只下一次）
npm run app -- --port 7500   # 换端口（默认 7340；被占用会自动顺延，一般不用指定）
```

> 本仓库尚未发布到 npm；npm 上的 `dsh-petNG` 是上游的旧版插件，不要用它代替这里的程序。

## 设置

托盘图标 →「打开设置」，或浏览器打开 <http://127.0.0.1:7340/app/>。

- **桌宠**：多开、大小、位置、显示开关、余额/碎碎念/状态联动、字体、拖拽手感、**开机自启**
- **本地服务**：模型服务商（DeepSeek 官方 / Ollama / OpenAI / 阿里云百炼 / 任意 OpenAI 兼容端点）、
  API Key、余额服务商、通知开关

API Key 存在本机 `secrets.json`，用系统密钥加密（Windows DPAPI / macOS 钥匙串 / Linux libsecret）；只写不读、不回显。

## 数据目录

通过 `npm run app` 从源码运行时，数据放在 Electron 的用户目录（Windows `%APPDATA%\dsh-petNG`，
macOS `~/Library/Application Support/dsh-petNG`，Linux `~/.config/dsh-petNG`）。

**安装包与免安装 zip 的数据在程序自己的目录下**（`<安装目录>/data`），整个目录拷走即迁移。
下载地址见仓库 Releases。

## 许可

代码 MIT；素材（动画 / 提示词 / 源视频）允许开源使用、**禁止商用**。
本项目源自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。
