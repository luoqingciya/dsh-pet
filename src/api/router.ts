/**
 * 宠物业务的 HTTP 契约层：/dsh-pet-ng-7340/ 前缀下的全部端点。
 *
 * 这一层只做「协议 ↔ 业务」的翻译：解析路径与查询、校验入参、把业务结果包成 RouteResult。
 * 真正的业务在 src/core/（配置合并 / 状态仓 / 素材归属 / 余额 / 对话 / 通知帧）。
 *
 * 谁在用：
 *   - 本地 HTTP 服务（src/main/server.ts 把请求转进来）；
 *   - 桌面窗口的 bridge（src/main/desktop.ts 注入的 request）。
 * 两条路共用同一个函数，所以「桌面看到的」与「接口返回的」永远一致。
 *
 * 依赖从 createPetRouter(deps) 传入：deps 是宿主在 apply() 里装配好的服务与状态，
 * 本层不自己 new 任何东西，也不 import electron。
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AssetPaths } from '../core/assets';
import { decideAnim } from '../core/anim';
import { decideBroadcast, normalizeBroadcastText } from '../core/broadcast';
import type { ChatMemoryMessage } from '../core/chat';
import {
  configVersion,
  findPetInstance,
  ID_FORBIDDEN,
  PET_DISPLAY_SET,
  readAllConfig,
  readPetConfigEntry,
  readUserConfig,
  saveUserConfig,
  sliceMemoryRounds,
  syncUserConfigFromDefault,
  userConfigUnparsable,
  type ConfigPaths,
} from '../core/config';
import { mimeOf, resolveAsset, resolveExisting, type RouteResult } from '../core/http';
import type { PollStateStore } from '../core/state';
import { parseExternalWorkStatus, type ExternalWorkStatusInput, type WorkStatusStore } from '../core/work-status';

/** 对话记忆的形状（与 core/chat 的落盘结构一致） */
type MemoryBook = Record<string, Record<string, { messages: ChatMemoryMessage[] }>>;

/** 宿主 llm 服务里路由层用到的那几个方法（/models 端点） */
export interface RouterLlm {
  listProviders?: () => Array<{ id?: unknown; name?: unknown }>;
  listConfigurableProviders?: () => Array<{ provider?: unknown; displayName?: unknown }>;
  listModels?: (provider: string) => Promise<Array<{ id?: unknown; name?: unknown }>>;
}

/**
 * 路由层需要宿主提供的一切 —— 全部由 apply() 装配后传入。
 *
 * 刻意**不传整个 ctx**：那样路由层就又能随手拿到 logger/emit 之外的东西，
 * 依赖会重新变成隐式的。要什么列什么，加依赖必须改这个接口。
 */
export interface PetRouterDeps {
  routePrefix: string;
  packageRoot: string;
  configPaths: ConfigPaths;
  userRoot: string;
  userConfigPath: string;
  petConfigDir: string;
  thumbUserRoot: string;
  memesUserRoot: string;
  memeDirsFor: AssetPaths['memeDirsFor'];
  assetRootFor: AssetPaths['assetRootFor'];
  userRootFor: AssetPaths['userRootFor'];
  state: PollStateStore;
  workStatus: WorkStatusStore;
  llm: RouterLlm | undefined;
  readMemory: () => Promise<MemoryBook>;
  memoryRounds: (petId: string, cfg: Record<string, Record<string, unknown>>) => number;
  publishWhisper: (petId: string) => Promise<boolean>;
  chatWithPet: (
    petId: string,
    text: string,
  ) => Promise<{ ok: true } | { ok: false; reason: 'provider-missing' | 'generate-error'; message?: string }>;
  refreshBalance: (manual?: boolean) => Promise<void>;
  resolveActivePetId: () => string;
  syncDesktop: () => Promise<void>;
  applyExternalStatus: (input: ExternalWorkStatusInput) => void;
  emit: (name: string, ...args: unknown[]) => void;
  logger?: { warn?: (message: string) => void };
}

export function createPetRouter(deps: PetRouterDeps) {
  const {
    routePrefix,
    packageRoot,
    configPaths,
    userRoot,
    userConfigPath,
    petConfigDir,
    thumbUserRoot,
    memesUserRoot,
    memeDirsFor,
    assetRootFor,
    userRootFor,
    state,
    workStatus,
    llm: llmService,
    readMemory,
    memoryRounds,
    publishWhisper,
    chatWithPet,
    refreshBalance,
    resolveActivePetId,
    syncDesktop,
    applyExternalStatus,
    emit,
    logger,
  } = deps;
  const handlePetRoute = async (rawUrl: string, method: string, body?: string): Promise<RouteResult> => {
    const url = new URL(rawUrl, 'http://localhost');
    const rest = decodeURIComponent(url.pathname.slice(routePrefix.length + 1));

    // 成品配置：/dsh-pet-ng-7340/config（GET 读取合并成品 / PUT 保存用户层 / POST 同步内置默认）
    if (rest === 'config') {
      if (method === 'GET') {
        // 唯一配置入口：readAllConfig 返回绝对正确的完成品聚合（{ main:{...}, test1:{...} }），
        // 桌面窗口与设置页直接消费，无需任何校验/兜底
        try {
          // 动态配置必须杀缓存（与 /state 同口径）：消费端会「发现配置版本变化 → 重拉 /config」，
          // 这一次 GET 若命中缓存就会拿回旧配置，那套机制直接失效。
          return {
            kind: 'json',
            status: 200,
            obj: readAllConfig(configPaths),
            headers: { 'cache-control': 'no-cache, no-store' },
          };
        } catch (e) {
          return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
        }
      }
      if (method === 'PUT') {
        try {
          const parsed = JSON.parse(body ?? '');
          // 透传保留：读当前磁盘上的用户文件原对象，把非白名单顶层字段（physics/whisperPrompt/
          // chatMemoryRounds/...）带回给 saveUserConfig——设置页保存不再抹掉用户手改的精调配置。
          // **必须走 JSONC 容忍解析器**（readUserConfig）：用户层可能是「同步」写入的带 // 注释
          // 的 config.jsonc 原文，用严格 JSON.parse 会在这里抛错并被吞掉 → existing 变 undefined
          // → 白名单重建 → 用户的高级字段全丢（老 bug 的复发路径，已由守卫测试钉住）。
          const existing = readUserConfig(configPaths);
          const clean = saveUserConfig(parsed, existing);
          if (!clean) {
            return {
              kind: 'json',
              status: 400,
              obj: {
                error:
                  'invalid pet config: expected { pets:[{name?,id,size,balanceEnabled,display,position:{corner,marginX,marginY}}] }（display 为 web/desktop/both/none 之一；可选顶层 whisperImageEnabled / chatImageEnabled 布尔；可选宠物布尔 whisperEnabled / workStatusEnabled / fixedEnabled）',
              },
            };
          }
          // 损坏预检：用户层存在但连 JSONC 都解析不了（真损坏）→ **先不写盘**。
          // 保存是白名单重建，existing 读不出来就等于把文件里剩下的内容整份丢掉，而且静默——
          // 所以回 409 让设置页弹窗（取消 = 不动文件；确认 = 带 ?force=1 强行重建）。
          if (url.searchParams.get('force') !== '1' && userConfigUnparsable(configPaths)) {
            return {
              kind: 'json',
              status: 409,
              obj: { error: 'user config is unparsable', needConfirm: true, userFile: userConfigPath },
            };
          }
          await mkdir(userRoot, { recursive: true });
          await writeFile(userConfigPath, JSON.stringify(clean, null, 2), 'utf8');
          void syncDesktop(); // display/size 等可能变化：重解析桌面宠物并重建窗口（异步，不阻塞保存响应）
          // 响应体 = 保存后的**成品聚合**（与 GET /config 同一份，字段已填满）：
          // 设置页把它直接交给容器的 flattenConfigPets 拍平渲染——客户端的条目级字段
          // （动画池/权重/物理参数/工作状态文案）只有这一处填充，不再有第二份补吹实现。
          return { kind: 'json', status: 200, obj: readAllConfig(configPaths) };
        } catch {
          return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
        }
      }
      if (method === 'POST') {
        // 同步：把内置默认配置（assets/config.jsonc 原文，含注释）整份写入用户配置——
        // 既是「恢复默认」（合并结果 = 内置默认），又给用户留下一份可直接编辑的完整配置，
        // 不必再自己从包内复制一份（见 config.ts 的 syncUserConfigFromDefault）。
        try {
          syncUserConfigFromDefault(configPaths);
        } catch (e) {
          // 默认文件缺失 / 用户目录不可写：显式 500，绝不静默留下半个配置文件
          return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
        }
        void syncDesktop(); // 配置变了：重解析桌面宠物并重建窗口（异步，不阻塞响应）
        return { kind: 'json', status: 200, obj: readAllConfig(configPaths) };
      }
      return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
    }

    // 单只宠物的显示位置（桌面端右键「关闭桌面显示」→ POST /pet-display）。
    // 高频操作，故只收 id + display 两个参数，不要求调用方回传整段 pets（那是 PUT /config 的形态：
    // 客户端做读-改-写既容易误伤同层其它宠物，也拿不准该写哪一层）。
    // 层归属由服务端反查：id 在合并后被 mergePet 保证**全局唯一**（重复实例会被跳过、不进聚合），
    // 所以 findPetInstance 的结果没有歧义；反过来让客户端传 entry 只会多出"参数与真实归属不符"的
    // 新失败面（还平白把 entry 暴露成拼文件路径的输入）。
    // 写入语义与 PUT /config 完全一致：saveUserConfig 白名单重建 + existing 透传——用户手改的
    // whisperPrompt / memes 等非白名单字段不许被抹掉（见 ./config 里那段老 bug 的注释）。
    if (rest === 'pet-display') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let payload: { id?: unknown; display?: unknown };
      try {
        payload = JSON.parse(body ?? '') as { id?: unknown; display?: unknown };
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const petId = typeof payload.id === 'string' ? payload.id.trim() : '';
      const nextDisplay = String(payload.display ?? '');
      if (!petId) return { kind: 'json', status: 400, obj: { error: 'missing pet id' } };
      if (!PET_DISPLAY_SET.has(nextDisplay)) {
        return { kind: 'json', status: 400, obj: { error: `invalid display: ${nextDisplay}` } };
      }
      let merged: Record<string, Record<string, unknown>>;
      try {
        merged = readAllConfig(configPaths);
      } catch (e) {
        return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
      }
      // 命中不到有两种可能：id 根本不存在，或该实例在合并时**因 id 与其它条目重复被跳过**（于是不在
      // 聚合里）。两种都只能回 404——绝不能凭 id 去猜它"应该"属于哪个文件。
      const hit = findPetInstance(merged, petId);
      if (!hit) return { kind: 'json', status: 404, obj: { error: `pet not found: ${petId}` } };
      // 目标层：main → 用户主配置；其余 → 文件宠物自己的配置（.json 或 .jsonc，定位统一走 ./config）
      let layerPath: string;
      let layerDir: string;
      let existing: Record<string, unknown> | undefined;
      if (hit.entry === 'main') {
        layerPath = userConfigPath;
        layerDir = userRoot;
        existing = readUserConfig(configPaths);
      } else {
        const file = readPetConfigEntry(configPaths, hit.entry);
        if (!file) {
          return { kind: 'json', status: 404, obj: { error: `pet config file not found: ${hit.entry}` } };
        }
        layerPath = file.path;
        layerDir = petConfigDir;
        existing = file.raw;
      }
      // 整段替换语义：saveUserConfig 重建的是整个 pets 数组，必须带上**该层全部**宠物，只把目标
      // 那只的 display 换掉（漏掉别的 = 把它们从配置里删掉）。
      const layerPets = Array.isArray(hit.conf.pets) ? (hit.conf.pets as Record<string, unknown>[]) : [];
      const pets = layerPets.map((p) => (String(p.id) === petId ? { ...p, display: nextDisplay } : p));
      const clean = saveUserConfig({ pets }, existing);
      if (!clean) return { kind: 'json', status: 400, obj: { error: 'invalid pet config' } };
      try {
        await mkdir(layerDir, { recursive: true });
        await writeFile(layerPath, JSON.stringify(clean, null, 2), 'utf8');
      } catch (e) {
        return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
      }
      // 不 await：发起者很可能就是**即将被这次重载换掉的**桌面窗口（与 /reload 同一处境）。
      // 写盘已经落定，重启结果不需要回给调用方。
      void syncDesktop();
      // 响应体 = 改动后的**成品聚合**（与 PUT / POST /config 同形）：调用方（浏览器端右键菜单）
      // 直接把它交给 petBridge.reload，不必再发一次 GET /config —— 与设置页保存走的是同一条路，
      // 也就不会拿到可能陈旧的配置（现场表现：不返回聚合时浏览器端要刷新才生效）。
      return { kind: 'json', status: 200, obj: readAllConfig(configPaths) };
    }

    // 桌面端「重载配置」（右键菜单 → POST /reload）：重建桌面窗口，全部桌面宠物窗口按最新配置重建。
    // 与保存走**同一条**重启路径（syncDesktop：串行队列 + 等旧进程真正退出再起新的），
    // 所以宠物数量 / display / size 的变化同样生效——渲染端就地重拉配置做不到这几项
    // （每只宠物一个窗口，是宿主启动时按 DSH_PET_PETS 建的）。
    // 注意：发起者就是**即将被重启的那个 helper**，本响应不保证送达，因此不 await 重启、立刻回 200。
    if (rest === 'reload') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      void syncDesktop();
      return { kind: 'json', status: 200, obj: { reloading: true } };
    }

    // 配置文件与素材目录路径（设置页「存储」区展示用）。
    // 从前这里还返回 storage（全部落盘位置）与 profile（拼 DSH 插件卸载命令用）：
    // 前者没有任何消费方、后者随脱离 DSH 一起作废，一并删除。
    if (rest === 'config/meta') {
      return {
        kind: 'json',
        status: 200,
        obj: {
          user: userConfigPath,
          default: join(packageRoot, 'assets', 'config.jsonc'),
          animations: thumbUserRoot,
          memes: memesUserRoot,
        },
      };
    }

    // 可选模型清单（设置页「AI 模型」两个下拉框的数据源）：与 DSH 自己的模型选择器**同源**——
    // 都来自宿主 llm 服务：listProviders = 已注册的实时服务商路由，listModels(provider) = 该路由下的模型。
    // 只读、无副作用；某个服务商列模型失败（适配器不支持 / 网络）只让它空着，不拖垮整张清单。
    // 服务商路由一个都没注册时回落到 listConfigurableProviders（适配器声明可配置的路由），
    // 免得下拉框空着——那种路由调用失败会由生成侧的回落兜住。
    if (rest === 'models') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        const llm = llmService as
          | {
              listProviders?: () => Array<{ id?: unknown; name?: unknown }>;
              listConfigurableProviders?: () => Array<{ provider?: unknown; displayName?: unknown }>;
              listModels?: (provider: string) => Promise<Array<{ id?: unknown; name?: unknown }>>;
            }
          | undefined;
        const named = (id: unknown, name: unknown): { id: string; name: string } => {
          const pid = String(id ?? '');
          return { id: pid, name: String(name ?? '') || pid };
        };
        let providers = (typeof llm?.listProviders === 'function' ? llm.listProviders() : []).map((p) =>
          named(p?.id, p?.name),
        );
        if (providers.length === 0 && typeof llm?.listConfigurableProviders === 'function') {
          providers = llm.listConfigurableProviders().map((p) => named(p?.provider, p?.displayName));
        }
        providers = providers.filter((p) => p.id);
        const catalog = await Promise.all(
          providers.map(async (p) => {
            let models: Array<{ id: string; name: string }> = [];
            try {
              const list = await llm?.listModels?.(p.id);
              models = (Array.isArray(list) ? list : []).map((m) => named(m?.id, m?.name)).filter((m) => m.id);
            } catch {
              /* 单个服务商列不出模型：留空即可（下拉框里该服务商只有「跟随当前对话」可选） */
            }
            return { ...p, models };
          }),
        );
        return { kind: 'json', status: 200, obj: { providers: catalog } };
      } catch (e) {
        return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
      }
    }

    // 轮询统一状态（S）：/dsh-pet-ng-7340/state（GET，no-cache）——前端 1s 轮询的**唯一**数据源
    // （余额 / 工作状态 / 通知 / 宠物说话，形状见 ./state）。
    // 只读、纯内存、**零副作用**：绝不在这里触发外部调用或模型生成——那会把所有人的 1s 轮询拖死。
    if (rest === 'state') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      return {
        kind: 'json',
        status: 200,
        // 顺带下发配置版本：浏览器端靠它发现「配置被别处改过」（桌面端右键改 display / 另一个标签页
        // 保存 / 用户手改配置文件）后重拉 /config。没有它，桌面端的改动要刷新页面才可见。
        obj: { ...state.read(), configVersion: configVersion(configPaths) },
        headers: { 'cache-control': 'no-cache, no-store' },
      };
    }

    // 余额：/dsh-pet-ng-7340/balance（POST = 立即刷新一次并写入 S，返回 {ok}）
    // 动作端点，**不返回余额数据**——数据只有一个出口（/state），这里只负责"让它刷新"。
    // 改造前这里是 GET（直接查余额）+ /balance/trigger（1s 计数轮询）两个端点，都已删除：
    // 前端不再各自定时查余额（host 定时器统一查，两端共享一份），也不再需要计数轮询中转。
    if (rest === 'balance') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      await refreshBalance(true); // manual：用户主动要的，余额不可用时前端必弹文字说明
      // ok 只表示"这次刷新动作完成了"；余额本身是否可用在 S 的 data 里（ok:false 会弹文字说明气泡）
      return { kind: 'json', status: 200, obj: { ok: true } };
    }

    // 本机任务状态灯：/dsh-pet-ng-7340/work-status（POST）
    // 任何脚本 / IDE 插件 / CI / agent 都能把桌宠当状态灯用：
    //   {"state":"working","text":"跑测试","ttlSec":600}   → 切「干活」并显示自定义文案
    //   {"state":null}                                    → 清空，回到空闲
    // state 的 6 个档位与 animations.events.workStatus 索引一致；text 覆盖档位气泡文案；
    // ttlSec 缺省 900 秒（脚本崩了也不会让宠物永远卡在「干活」），0 = 不自动清。
    // 落到同一个 WorkStatusStore（会话 id = dsh-pet-ng-external），动画与气泡零新增代码。
    if (rest === 'work-status') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { ok: false, error: 'invalid JSON body' } };
      }
      const parsedStatus = parseExternalWorkStatus(parsed);
      if (!parsedStatus.ok) return { kind: 'json', status: 400, obj: { ok: false, error: parsedStatus.message } };
      applyExternalStatus(parsedStatus.value);
      return { kind: 'json', status: 200, obj: { ok: true, state: workStatus.snapshot().state } };
    }

    // 碎碎念：/dsh-pet-ng-7340/whisper?pet=<id>（POST = 立即让桌宠新说一句，返回 {ok}）
    // 动作端点，**不返回文本**——文本走 S 的 pets.<id>.say（碎碎念/命令气泡/对话回复同一个叶子）。
    // 手动语义不受 whisperEnabled 门控：那个字段只关自动周期（与改造前一致）。
    if (rest === 'whisper') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const petId = String(url.searchParams.get('pet') ?? '');
      try {
        const ok = await publishWhisper(petId);
        return { kind: 'json', status: 200, obj: ok ? { ok: true } : { ok: false, reason: 'generate-error' } };
      } catch (e) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 第三方投喂：/dsh-pet-ng-7340/broadcast?pet=<id>（POST = 把一段**外部给定的**文本写进桌宠气泡）
    // 与 /whisper 的区别：这个**不生成**，调用方自己给文本——宿主侧其他插件（女仆巡检等）
    // 想说自己的话时用它，桌宠就成了那套人格的"实体"（见 issue #76）。
    // 写入 S 的 pets.<id>.say —— 与碎碎念/对话回复**同一个叶子**，两端 1s 内自动显示，前端零改动。
    // 动作端点，只回 {ok}；文本本身从 /state 读。
    // 校验（不通过一律 HTTP 200 + ok:false，与 /chat 的失败口径一致）：
    //   text 必填、trim 后非空（**不设长度限制，也不限频**：内容与频率由调用方自己负责）；
    //   pet 缺省 = 当前桌宠（resolveActivePetId），须真实存在；
    //   image 只认**包内表情包名**（池内命中即用其规范名），杜绝第三方注入外部地址。
    if (rest === 'broadcast') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      // 空文本不需要读配置就能判定：先短路，别为一个必然失败的请求去碰磁盘
      if (!normalizeBroadcastText(o.text)) {
        return { kind: 'json', status: 200, obj: { ok: false, reason: 'bad-request', message: 'text 为空' } };
      }
      try {
        const cfg = readAllConfig(configPaths);
        const d = decideBroadcast({
          cfg,
          requested: String(url.searchParams.get('pet') ?? ''),
          active: resolveActivePetId(),
          text: o.text,
          image: o.image,
          memeDirs: memeDirsFor,
        });
        if (!d.ok) return { kind: 'json', status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
        state.writePet(d.petId, 'say', d.image ? { text: d.text, image: d.image } : { text: d.text });
        return { kind: 'json', status: 200, obj: { ok: true } };
      } catch (e) {
        // 配置读取失败等（安装损坏）→ 显式失败，不静默
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 点播动画：/dsh-pet-ng-7340/anim?pet=<id>（POST = 让桌宠播一段指定动画）
    // 效果与右键菜单点「动作」树**完全一致**——两端都复用同一个菜单动作处理函数
    // （浏览器 handleMenuAction / 桌面 sprite.onMenuAction），宿主只负责把名字送到。
    // 写入 S 的 pets.<id>.anim —— 前端 1s 内发现 counter 变化后换源播放（**名字即文件名**）。
    // 动作端点，只回 {ok}。
    // 校验（不通过一律 HTTP 200 + ok:false，与其他动作端点口径一致）：
    //   name 必填、trim 后非空，且必须在该宠物 animations 配置能点到的集合内
    //   （播放端对不存在的动画没有兜底：名字即文件名 → 404 → 加载失败 → 表现为"点了没反应"，
    //    所以必须在这里拦住，而不是写进 S 让前端白跑一趟）；
    //   pet 缺省 = 当前桌宠（resolveActivePetId），须真实存在。
    if (rest === 'anim') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      try {
        const cfg = readAllConfig(configPaths);
        const d = decideAnim({
          cfg,
          requested: String(url.searchParams.get('pet') ?? ''),
          active: resolveActivePetId(),
          name: o.name,
        });
        if (!d.ok) return { kind: 'json', status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
        state.writePet(d.petId, 'anim', { name: d.name });
        return { kind: 'json', status: 200, obj: { ok: true } };
      } catch (e) {
        // 配置读取失败等（安装损坏）→ 显式失败，不静默
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 对话：/dsh-pet-ng-7340/chat?pet=<id>
    //   GET  —— 最近记忆窗口（截尾 chatMemoryRounds 轮），弹窗打开时展示（一次性读，不是轮询）
    //   POST —— 携带历史生成回复并写入记忆；**只回 {ok}**，回复走 S 的 pets.<id>.say
    // 记忆唯一读写方 = host（memory.json；桌面窗口与设置页都只是客户端）→
    // 同一实例的浏览器与桌面天然共享同一份记忆；文件全存不删，
    // 请求只截尾部 chatMemoryRounds 轮（1 轮 = 1 问 1 答；合并器已按条目填默认）。
    if (rest === 'chat') {
      const petId = String(url.searchParams.get('pet') ?? '');
      try {
        if (method === 'GET') {
          const cfg = readAllConfig(configPaths);
          const mem = await readMemory();
          const bucket = mem[findPetInstance(cfg, petId)?.entry ?? petId] ?? {};
          const list = (bucket[petId]?.messages ?? []).slice();
          const rounds = memoryRounds(petId, cfg);
          // 与 chatWithPet 同一语义：rounds = 0 → 空历史（slice(-0) 会返回整个数组，见上）
          const messages = sliceMemoryRounds(list, rounds);
          return { kind: 'json', status: 200, obj: { ok: true, messages, rounds } };
        }
        if (method === 'POST') {
          const parsed = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
          const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
          if (!text) {
            return { kind: 'json', status: 200, obj: { ok: false, reason: 'bad-request', message: '消息为空' } };
          }
          if (text.length > 2000) {
            return {
              kind: 'json',
              status: 200,
              obj: { ok: false, reason: 'bad-request', message: '消息过长（限 2000 字）' },
            };
          }
          const result = await chatWithPet(petId, text);
          return { kind: 'json', status: 200, obj: result };
        }
        return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      } catch (e) {
        // 配置已由 readAllConfig 保证正确（不再有 config-error 分支）；其余（IO/LLM）→ generate-error
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 动画文件：/dsh-pet-ng-7340/thumb/<素材根>/<file>，扩展名 webm（默认）/ mov（macOS 定制）。
    // 素材归属按「是否存在该宠物的独立素材目录 `pet/<petId>-animation/`」判定：
    //   - 存在（pet pack 宠物）：只查自己的目录，查不到即 404 显式报错——绝不混用
    //   - 不存在（**所有主配置宠物**，main 与用户添加的任意多只）：主素材链
    //     main-animation/<webm|mov> 优先 → 包内 assets/<webm|mov>（与宠物数量无关，多只共用）
    // mov（HEVC-with-Alpha）为 macOS Safari/WKWebView 定制格式：默认不随包发布，
    // 用户从 GitHub Release（assets-mov）下载后放 main-animation/mov/，并把客户端播放
    // 扩展名常量（src/shared/constants.ts 的 ANIMATION_EXT / 产物 lib/client.js）改为 .mov。
    // 注意：font / pic 是扁平的 /<scope>/<file>，只有 thumb 是 /<scope>/<petId>/<file>——
    // 这里先拆 scope，再按 scope 各自拆剩余段，避免 font/pic 被误当作 petId 吞掉文件段。
    const [scope, ...restParts] = rest.split('/');
    if (scope === 'font') {
      const fontRoot = join(packageRoot, 'assets', 'fonts');
      const fontFile = resolveExisting(fontRoot, restParts.join('/'));
      if (fontFile === undefined) return { kind: 'text', status: 404, body: 'dsh-petNG: font not found' };
      return { kind: 'file', file: fontFile, contentType: mimeOf(fontFile) };
    }

    // 通知图标：/dsh-pet-ng-7340/pic/<file> → 包内 assets/pic（方形 png，系统通知 icon 用）
    // 表情包：/dsh-pet-ng-7340/pic/memes/<素材根>/<名称>.png → 按素材根走 memeDirsFor 的目录链
    // （种类独占目录 → 用户目录 → 包内），与 /thumb 同一套素材归属语义；名称含中文，URL 段已在上方解码。
    // 旧的两段形式 /pic/memes/<名称>.png 保留：等价于素材根 main 的目录链（未升级的客户端照常取到包内图）。
    if (scope === 'pic') {
      if (restParts[0] === 'memes') {
        const segs = restParts.slice(1);
        // 段数 ≥ 2 = <素材根>/<名称…>；恰好 1 段 = 旧扁平形式。表情包名称即文件名（不含子目录），
        // 所以两种形式不歧义；素材根与 /thumb 的 petId 同规矩：含分隔符 / 保留字符即显式 400。
        const scoped = segs.length >= 2;
        const assetRoot = scoped ? segs[0] : 'main';
        if (scoped && (assetRoot.length > 64 || ID_FORBIDDEN.test(assetRoot))) {
          return { kind: 'text', status: 400, body: 'dsh-petNG: invalid asset root' };
        }
        const rel = (scoped ? segs.slice(1) : segs).join('/');
        let picFile: string | undefined;
        for (const dir of memeDirsFor(assetRoot)) {
          picFile = resolveExisting(dir, rel);
          if (picFile !== undefined) break;
        }
        if (picFile === undefined) return { kind: 'text', status: 404, body: 'dsh-petNG: pic not found' };
        return { kind: 'file', file: picFile, contentType: mimeOf(picFile) };
      }
      const picRoot = join(packageRoot, 'assets', 'pic');
      const picFile = resolveExisting(picRoot, restParts.join('/'));
      if (picFile === undefined) return { kind: 'text', status: 404, body: 'dsh-petNG: pic not found' };
      return { kind: 'file', file: picFile, contentType: mimeOf(picFile) };
    }

    if (scope !== 'thumb') {
      return { kind: 'text', status: 400, body: 'dsh-petNG: expected /dsh-pet-ng-7340/thumb/<petId>/<file>' };
    }
    // thumb 是三段式：/<scope>/<petId>/<file>——从这里再拆宠物 id 与文件名
    const [petId, ...nameParts] = restParts;
    if (!petId || nameParts.length === 0) {
      return { kind: 'text', status: 400, body: 'dsh-petNG: expected /dsh-pet-ng-7340/thumb/<petId>/<file>' };
    }
    // petId 是**标识符**（= pet/<名>-animation/ 的 <名>，来源是 pet/ 下的文件名前缀），不是路径片段：
    // 含分隔符/保留字符即显式 400，早于任何路径拼接判定。合法名（含中文）照常——
    // 用非法字符类而不是 ASCII 白名单。非法输入不再静默回落到主素材池（攻击尝试与"没有独立素材"可区分），
    // 也给下面的 resolveAsset 之外再留一道结构性防线。
    if (ID_FORBIDDEN.test(petId)) {
      return { kind: 'text', status: 400, body: 'dsh-petNG: invalid pet id' };
    }
    const fileName = nameParts.join('/');
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    if (ext !== '.webm' && ext !== '.mov') {
      return { kind: 'text', status: 400, body: 'dsh-petNG: unsupported animation format (expected .webm or .mov)' };
    }
    // 素材归属（按是否存在该宠物的独立素材目录判定，绝不静默混用）：
    //   - 存在 `pet/<petId>-animation/`（pet pack 宠物，URL 段 = 素材根 assetRoot）：
    //     只查自己的目录，查不到即 404 显式报错——绝不回落别的素材
    //   - 不存在（**所有主配置宠物**：main 及用户添加的任意多只，共用全局动画池）：
    //     主素材链——用户 main-animation/<ext 子目录> 优先，其次包内 assets/<ext 子目录>
    // extraAnimDir 必须先过 resolveAsset：petId 是解码后的 URL 段，Windows 上 %5C 解出的
    // 反斜杠不会被 rest.split('/') 切开，直接 join 会让 `..\..\x` 逃出用户根读盘。
    const extraAnimDir = resolveAsset(petConfigDir, petId + '-animation');
    const file =
      extraAnimDir !== undefined && existsSync(extraAnimDir)
        ? resolveExisting(extraAnimDir, fileName)
        : (resolveExisting(userRootFor(ext), fileName) ?? resolveExisting(assetRootFor(ext), fileName));
    if (file === undefined) return { kind: 'text', status: 404, body: 'dsh-petNG: asset not found' };
    return { kind: 'file', file, contentType: mimeOf(file) };
  };

  /**
   * 本地对话的「会话」标识：应用里没有真实会话，合成的 turn 事件统一挂在这个 id 下
   * （工作状态按会话聚合；与 `src/main/context.ts` 的 LOCAL_SESSION_ID 一致，改一处要改两处）。
   */
  const CHAT_SESSION = { header: { id: 'dsh-pet-ng-local' } };

  /** 把一条合成的会话事件投回总线（宿主同时是生产者与消费者：事件经 ctx.emit 回到上面的监听器） */
  const emitTurn = (type: 'turn/start' | 'turn/end', ok = false, message?: string): void => {
    try {
      emit(
        'session/event',
        CHAT_SESSION,
        type === 'turn/start'
          ? { type: 'turn/start' }
          : {
              type: 'turn/end',
              data: {
                reason: ok ? { kind: 'completed' } : { kind: 'error', error: { message: message ?? '生成失败' } },
              },
            },
      );
    } catch (e) {
      logger?.warn?.(`[dsh-petNG] 投递 ${type} 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * `handlePetRoute` + 一次对话的 turn/start → turn/end。
   *
   * **为什么必须收口在这里**：`/chat` 有两条入口——HTTP（设置页 / 脚本）与桌面窗口的
   * `dsh-pet-ng-bridge://` scheme。从前这一步包在 HTTP 路由**外面**，于是桌面宠物自己发起的对话
   * （也就是用户点宠物聊天的那条路）完全不产生 turn 事件：对话状态联动不切动画、
   * 也不弹「对话完成」通知。两条路都落到 handlePetRoute，包在它外面才覆盖全部入口。
   */
  const handlePetRouteWithTurn = async (rawUrl: string, method: string, body?: string): Promise<RouteResult> => {
    if (method !== 'POST' || !rawUrl.startsWith(`${routePrefix}/chat`)) {
      return handlePetRoute(rawUrl, method, body);
    }
    emitTurn('turn/start');
    try {
      const result = await handlePetRoute(rawUrl, method, body);
      const obj = result.kind === 'json' ? (result.obj as { ok?: boolean; message?: string }) : undefined;
      emitTurn('turn/end', obj?.ok === true, obj?.message);
      return result;
    } catch (e) {
      emitTurn('turn/end', false, e instanceof Error ? e.message : String(e));
      throw e;
    }
  };

  return handlePetRouteWithTurn;
}
