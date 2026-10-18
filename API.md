# dsh-pet 对外 HTTP 接口一览

dsh-pet 在本地 `127.0.0.1` 上起了一个 HTTP 服务，把所有能力挂在**一条前缀路由** `/dsh-pet-7340` 下。
桌面窗口、设置页与第三方脚本访问的都是同一份实现。本文只做**功能预览**（接口名 + 一句话），
完整契约——参数、响应体、字段含义、错误码与示例——见根目录的 [`openapi.yaml`](openapi.yaml)。

- **基址**：`http://127.0.0.1:<port>/dsh-pet-7340`，`<port>` 默认 `7340`（被占用会自动顺延，可用 `--port` 指定）
- **只监听 127.0.0.1，且没有鉴权**：任何能访问本机该端口的进程都能调用，请勿转发到公网

---

## 一、读状态

| 接口                            | 功能                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /dsh-pet-7340/state`       | **轮询唯一数据源**：一次拿到说话、工作状态、系统通知、余额四类状态；另带 `configVersion`（配置版本指纹，变了就该重拉 `/config`） |
| `GET /dsh-pet-7340/config`      | 读合并后的成品配置（内置默认 + 用户层，字段已填满）                                                                              |
| `GET /dsh-pet-7340/config/meta` | 配置文件路径、各类数据落盘位置（设置页「存储」区用的就是它）                                                                     |
| `GET /dsh-pet-7340/models`      | 可用服务商与模型清单（来自「本地服务」里配置的端点）                                                                             |
| `GET /dsh-pet-7340/chat?pet=`   | 读某只桌宠最近的对话记忆窗口                                                                                                     |

## 二、让桌宠做事

| 接口                                | 功能                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `POST /dsh-pet-7340/whisper?pet=`   | 让桌宠**生成**一句碎碎念（走当前模型）                                                                          |
| `POST /dsh-pet-7340/broadcast?pet=` | **第三方投喂**：把外部给定的文本直接写进气泡（不生成，只搬运）                                                  |
| `POST /dsh-pet-7340/anim?pet=`      | **点播动画**：让桌宠播一段指定动画，效果与右键「动作」菜单一致                                                  |
| `POST /dsh-pet-7340/work-status`    | **本机任务状态灯**：把桌宠当状态灯（思考 / 干活 / 收尾 / 等你确认 / 成功 / 出错），可带自定义文案与自动熄灭时间 |
| `POST /dsh-pet-7340/chat?pet=`      | 对桌宠说一句话并生成回复，同时写入对话记忆                                                                      |
| `POST /dsh-pet-7340/balance`        | 立即刷新一次余额                                                                                                |
| `POST /dsh-pet-7340/reload`         | 重载桌面端（销毁并按最新配置重建全部宠物窗口；与保存配置同一条路径）                                            |

## 三、改配置

| 接口                             | 功能                                                                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /dsh-pet-7340/config`       | 保存用户层配置（白名单重建，用户手写的精调字段会保留）                                                                                                                                                                                               |
| `POST /dsh-pet-7340/pet-display` | **改单只宠物的显示位置**（`desktop` 显示 / `none` 隐藏；`both` 等价 desktop、`web` 等价 none，只为兼容旧配置）：只传 `{ id, display }`，**不必回传整段 pets**——写哪一层（主配置还是 `pet/<前缀>-config.json`）由宿主按 id 反查。返回改动后的成品聚合 |
| `POST /dsh-pet-7340/config`      | 用内置默认整份覆盖用户配置，即「恢复默认」                                                                                                                                                                                                           |

## 四、素材

| 接口                                      | 功能                                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /dsh-pet-7340/thumb/{素材根}/{file}` | 动画素材（`.webm` / `.mov`）。**素材根** = `pet/<名>-animation/` 的 `<名>`，主配置宠物一律 `main`（不是实例 id：`pig1` 这种写法会静默回落到主素材链） |
| `GET /dsh-pet-7340/font/{file}`           | 字体文件                                                                                                                                              |
| `GET /dsh-pet-7340/pic/{file}`            | 通知图标（`pic/`）与表情包（`pic/memes/{素材根}/`，按宠物归属）                                                                                       |

---

## 三条要记住的约定

1. **数据只有一个出口**：`GET /state`。它返回宿主内存里的已发布状态，每个状态位是
   `{ counter, data }`。
2. **动作端点不返回数据**：`whisper` / `broadcast` / `anim` / `chat` / `balance` / `reload` 只回
   `{ ok: true }`，表示"动作做完了"；结果写进状态，调用方随后拉一拍 `/state` 即可看到
   （立刻补拉就是 0 延迟，不必等下一个轮询周期）。配置写接口（`PUT`/`POST /config`、
   `POST /pet-display`）例外：它们直接返回改动后的成品聚合。
3. **`counter` 变了才渲染**：它是 `Date.now()` 且严格递增，宿主重启也不会倒退。
   状态位的路径（如 `sections.balance`、`pets.<id>.say`）请当作**不透明键**使用——
   宠物 id 允许含点号，**不要按 `.` 切分**。

## 快速试一下

```bash
BASE=http://127.0.0.1:<port>/dsh-pet-7340

# 拉一次状态（只读、零副作用，可以随便轮询）
curl -s $BASE/state

# 让桌宠说一句外部给的话，然后立刻回读状态
curl -s -X POST "$BASE/broadcast?pet=main" \
     -H 'content-type: application/json' \
     -d '{"text":"巡检完毕，一切正常"}'
curl -s $BASE/state   # → pets.main.say.data.text

# 让它播一段动画（名字取自 GET /config 里**该宠物所属条目**的 animations：
#  main 条目的宠物用 main 的池，pet/<名>-config.json 的种类各用自己的池）
curl -s -X POST "$BASE/anim?pet=main" \
     -H 'content-type: application/json' \
     -d '{"name":"东张西望"}'

# 把桌宠当成本机任务状态灯（6 档；text 覆盖气泡文案，ttlSec 到期自动熄灭）
curl -s -X POST "$BASE/work-status" \
     -H 'content-type: application/json' \
     -d '{"state":"working","text":"跑测试","ttlSec":600}'

# 任务结束，熄灭
curl -s -X POST "$BASE/work-status" \
     -H 'content-type: application/json' \
     -d '{"state":null}'
```

`tools/pet-status.mjs` 把上面两条包成了命令行：`node tools/pet-status.mjs working "跑测试"`。

## 服务本身的运维端点

除 `/dsh-pet-7340` 前缀外，本地服务还提供两个运维端点（不在 OpenAPI 契约里）：

| 端点             | 说明                                                     |
| ---------------- | -------------------------------------------------------- |
| `GET /health`    | 服务信息：名称、版本、监听端口、已运行秒数               |
| `POST /shutdown` | 优雅停机：释放定时器与桌面窗口后关闭服务（脚本化停机用） |

设置页与本地服务接口挂在 `/app/*`（`GET /app/api/config`、`POST /app/api/config`、
`POST /app/api/test`、`POST /app/api/open-dir`、`POST /app/api/update-check`），同样不在 OpenAPI 契约里——
它们是这个应用的内部界面，不是给第三方用的稳定接口。

## 相关

- [`openapi.yaml`](openapi.yaml) —— 完整契约（OpenAPI 3.1，可直接导入 Swagger UI / Postman）
- [`tools/api-tester.html`](tools/api-tester.html) —— 桌宠控制台：扮演第三方消费方的示例页面，
  可直观试用上述接口（用 `node tools/api-tester.cjs` 启动，它会带上本地代理解决跨域）
