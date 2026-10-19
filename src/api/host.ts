/**
 * dsh-petNG 宿主半边 —— 应用的全部业务能力（HTTP 路由的唯一实现）。
 *
 * 职责：提供 `/dsh-pet-ng-7340/` 前缀下的所有端点（`handlePetRoute`）。
 * 全部配置（内置默认 + 用户主配置 + 文件宠物）由 `./config` 的 `readAllConfig` 统一读取合并，
 * 本文件只消费它的返回值（绝对正确、零校验），不直接解析任何配置文件。
 *
 * 谁在用这份实现：
 *   - 本地 HTTP 服务（`src/main/server.ts` 把请求转进来）—— 设置页、桌面窗口、第三方脚本都走它；
 *   - 桌面窗口的 bridge（`src/main/desktop.ts` 注入的 request）—— 窗口内渲染端取配置/状态/素材。
 * 两条路共用同一个函数，所以「桌面看到的」与「接口返回的」永远一致。
 *
 * 路由：
 *   /dsh-pet-ng-7340/config             → 合并后的**成品配置**（{ main:{...}, test1:{...}, ... }，
 *                                每条目字段已填满；设置页与桌面窗口的唯一配置入口）
 *                                GET 读取成品；PUT 保存用户层（白名单重建 main-config.jsonc）、
 *                                POST 同步用户层（把内置默认 config.jsonc **原文**整份写入，
 *                                含注释与全部高级字段）—— 两个写接口的**响应体都是保存后的成品聚合**
 *   /dsh-pet-ng-7340/reload              → 「重载配置」（POST）：重建桌面窗口，全部宠物窗口按最新配置重建；
 *                                与保存走**同一条**重启路径（syncDesktop），数量/display/size 变化同样生效
 *   /dsh-pet-ng-7340/config/meta         → 配置文件与素材目录路径（设置页「存储」区）
 *   /dsh-pet-ng-7340/models              → 可选「服务商 + 模型」清单（设置页「本地服务」下拉框数据源）
 *   /dsh-pet-ng-7340/thumb/<素材根>/<动画名>.webm|.mov  → 素材按宠物归属：
 *       文件宠物 = /dsh-pet-ng/pet/<素材根>-animation/（只查自己的，绝不回落）；
 *       主宠物   = /dsh-pet-ng/main-animation/<webm|mov>（用户目录，优先）→ 包内 assets/<webm|mov>
 *       <素材根> 是**标识符**（pet/ 下文件名前缀），含分隔符/保留字符即 400（见 ID_FORBIDDEN）
 *   /dsh-pet-ng-7340/state               → **轮询统一状态 S**（GET，前端 1s 轮询的唯一数据源）：
 *                                       { sections: { balance, workStatus, notify }, pets: { <id>: { say } } }，
 *                                       每个叶子 = { counter, data }；counter 变了前端才渲染。
 *                                       只读、纯内存、零副作用（绝不在这里触发外部调用/模型生成）。
 *   /dsh-pet-ng-7340/balance              → 余额刷新（POST 动作端点，写 S；数据从 /state 读）
 *   /dsh-pet-ng-7340/whisper              → 让某只宠物立即说一句（POST 动作端点，写 S 的 pets.<id>.say）
 *   /dsh-pet-ng-7340/broadcast            → 第三方投喂：把外部给定的文本写进气泡（不生成、只搬运）
 *   /dsh-pet-ng-7340/anim                 → 点播动画（效果与右键「动作」菜单一致）
 *   /dsh-pet-ng-7340/chat                 → 对话与记忆（GET 最近窗口 / POST 对话并写 memory.json）
 *   /dsh-pet-ng-7340/font|pic             → 字体 / 通知图标 / 表情包素材
 *
 * 系统通知：应用把「一次对话生成」合成 turn/start、turn/end 会话事件投进来（见 src/main/main.ts），
 * 这里据此生成通知帧写进 S 的 sections.notify，应用主进程轮询到变化后弹原生通知
 * （帧契约与 shared/notify.ts 一致；单槽，见下方 pushNotifyFrame）。
 *
 * 安全性：resolveAsset 做「防穿越」校验，保证路径仍在对应根目录内；
 *         PUT 保存经 saveUserConfig 白名单重建，id 过滤文件名非法字符。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from '../core/standalone/home-paths';
import { credentialRef } from '../core/standalone/credentials';
import { queryBalance } from '../core/balance/index';
import { generateWhisper } from '../core/whisper';
import { generateChat } from '../core/chat';
import { configuredModel } from '../core/model-selection';
import { limitPool, pickMeme, readMemePool } from '../core/memes';
import {
  findPetInstance,
  flattenPetList,
  migrateUserConfig,
  readAllConfig,
  sliceMemoryRounds,
  type ConfigPaths,
} from '../core/config';
import { currentTaskFromTodo, reduceWorkStatus } from '../core/work-status';
import {
  agentErrorFrame,
  isCompletionTurnEnd,
  reduceNotifyFrame,
  sessionIdOf,
  shouldNotifySession,
} from '../core/notify-events';
import { createAssetPaths } from '../core/assets';
import { createMemoryStore } from '../core/memory-store';
import { createWorkStatusPublisher } from '../core/work-status-publisher';
import { createNotifyPipeline, type Waterfall } from '../core/notify-pipeline';
import { PollStateStore } from '../core/state';
import { readBody, sendFile, sendJson, sendText } from '../core/http';
import { petSystemPrompt, withTimeContext } from '../core/prompt';
import type { DesktopRequest, DesktopResponse, PetDesktop } from '../core/desktop-api';
import { createPetRouter } from './router';

/** 插件行 id（与 cordis.patch.yml 一致） */
export const name = 'pet';
/**
 * 宿主半边对 ctx 的要求（应用在 `src/main/context.ts` 里一次性给齐）：
 * webServer（路由）+ agentDefaultModel（服务商/模型）+ credentials（凭证）+ llm（生成）。
 * 这里刻意**不声明** Cordis 的 `inject`：应用直接调 `apply(ctx)`，那份清单只对插件加载器有意义。
 */

/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const ROUTE_PREFIX = '/dsh-pet-ng-7340';

// 配置的读取/校验/合并/保存全部收敛在 ./config（readAllConfig / saveUserConfig，host 自包含实现，
// 不 import src/shared —— 宿主跑在 Node、渲染端跑在浏览器上下文，避免把 DOM 代码拖进来）。本文件不再保留任何配置逻辑，只消费成品返回值。

/** 该宠物是否参与桌面模式（Electron 透明窗） */
const isDesktopVisible = (display: unknown): boolean => display === 'desktop' || display === 'both';

// ---------------------------------------------------------------------------
// 额外宠物（pet pack）说明：校验/扫描已收敛到 ./config（readAllConfig 内部逐字段合并），
// 这里不再有 host 侧拷贝——文件宠物与主宠物一样，统一从 readAllConfig 的成品读取。
// ---------------------------------------------------------------------------

/** 宿主主体：注册 `/dsh-pet-ng-7340` 前缀路由（全部业务端点的唯一实现）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 应用注入的 ctx（webServer 等能力无静态类型）
export function apply(ctx: any): void {
  // 用户数据根：配置与用户素材统一收敛于此（扩展包按 <插件id> 各自建目录）
  const dshHome = resolveDshHome();
  const userRoot = join(dshHome, 'dsh-pet-ng');
  // 用户主配置（可编辑层）与文件宠物目录；配置读取/合并统一走 readAllConfig（./config）。
  // 主配置是 **JSONC**（main-config.jsonc）——与包内默认 config.jsonc 同名同格式：
  // 「同步」写进去的就是带注释的原文，扩展名如实反映内容（旧版 main-config.json 只读回落 + 启动迁移）
  const userConfigPath = join(userRoot, 'main-config.jsonc');
  const legacyUserConfigPath = join(userRoot, 'main-config.json');
  const petConfigDir = join(userRoot, 'pet');
  // 配置路径集（readAllConfig 的唯一输入：内置默认 + 用户主配置 + 文件宠物目录）
  const configPaths: ConfigPaths = {
    defaultFile: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
    userFile: userConfigPath,
    legacyUserFile: legacyUserConfigPath,
    petDir: petConfigDir,
  };
  // 老用户一次性迁移：main-config.json → main-config.jsonc（重命名，内容一字不动；
  // 新文件已存在则不动旧文件）。失败不影响运行——读取侧对旧路径有回落。
  migrateUserConfig(configPaths, (msg) => console.log('[dsh-petNG] ' + msg));
  // 用户动画目录（thumb 播放时优先于包内素材；webm 放 main-animation/webm/，mov（macOS 定制）放 main-animation/mov/）
  // 轮询统一状态（S）：前端 1s 轮询的**唯一**数据源（余额 / 工作状态 / 通知 / 宠物说话）。
  // 所有写入走 state.writeSection / writePet（由它统一更新 counter），见 ./state 的说明。
  // 素材归属与目录解析（/thumb、/pic/memes、表情包池三处共用，见 ./assets）
  const assetPaths = createAssetPaths({ packageRoot: PACKAGE_ROOT, userRoot, petConfigDir });
  const { thumbUserRoot, memesUserRoot, memeDirsFor, assetRootFor, userRootFor } = assetPaths;

  const state = new PollStateStore();
  // 工作状态联动快照（/state 里的 sections.workStatus，桌面窗口 1s 轮询）：state=当前活动状态（null=空闲）、
  // task=当前任务详情、ts=最近变化时间（轮询侧检测变化用）。气泡文案不在此：渲染端读配置
  // events.workStatusTexts（host 不内置文案）。
  // 聚合与展示选择都在 WorkStatusStore（host/work-status.ts，纯逻辑可单测）：**state 与 task 都按
  // 会话存**——task 曾是全局单值，写过一次就跟着此后所有会话活动一直显示（issue #59）。
  // 进程内内存态：重启回空闲；每次会话事件有实际状态变化才更新（签名比对防刷屏）。
  // 工作状态：快照发布 + 外部状态灯，实现在 core/work-status-publisher
  const workStatusPublisher = createWorkStatusPublisher({
    writeSection: (data) => state.writeSection('workStatus', data),
  });
  const workStatus = workStatusPublisher.store;
  const publishWorkStatus = workStatusPublisher.publish;
  const applyExternalStatus = workStatusPublisher.applyExternal;

  // 系统通知帧：宿主监听应用投进来的会话事件（turn/end、agent/error）生成通知帧
  // （帧契约与 shared/notify.ts 一致），写进 S 的 sections.notify；应用主进程轮询到变化后
  // 弹原生通知（见 src/main/notifications.ts）。
  // **单槽**（后到覆盖先到）：同一秒来多条只弹最后一条。这是有意的取舍——1 秒内连弹多个系统通知
  // 本身没有意义（反而更烦），所以不再带 seq / 增量帧队列（改造前的 frames 数组机制已删）。
  // 通知帧管道（单槽推帧 / 终态清理 / 活动门）收在 core/notify-pipeline
  const notify = createNotifyPipeline({
    writeFrame: (frame) => state.writeSection('notify', frame),
    workStatus,
    publishWorkStatus,
    waterfall: (ctx as { waterfall?: Waterfall }).waterfall,
  });
  // 碎碎念周期调度的「上次生成时刻」（按宠物）：调度拍据此判断到没到点。
  // 改造前这份节流靠 whisperCache（缓存 + ts 比较），现在"该不该生成"由调度侧决定、
  // "生成结果"直接写 S——多端共享同一句由 S 天然保证，不再需要第二份缓存。
  const lastWhisperAt = new Map<string, number>();

  // 对话记忆：读写 / 串行锁 / 轮数全部收在 core/memory-store（唯一读写方是本进程）
  const memory = createMemoryStore({ rootDir: userRoot });

  /** 生成/返回某宠物的一句碎碎念（周期 GET 与菜单手动触发共用的同一逻辑）：
   *  每只宠物独立生成（所属条目的人设）。生成成功就写进 S 的 pets.<id>.say——
   *  碎碎念 / 命令气泡 / 对话回复在前端本来就是**同一条展示链路**（同一个 triggerWhisper、
   *  同一个气泡槽、同一批 events.whisper 动画），所以合并成同一个叶子；"周期内不重复"由
   *  调度侧的 lastWhisperAt 保证，不再需要一份 whisperCache（多端共享也由 S 天然保证）。
   *  配图（whisperImageEnabled 开启时）：从表情包池**随机抽 1 张**，把描述注入指令并随文本一起写。 */
  const publishWhisper = async (petId: string): Promise<boolean> => {
    const cfg = readAllConfig(configPaths);
    const found = findPetInstance(cfg, petId);
    const conf = found ? found.conf : (cfg.main ?? {});
    const entry = found ? found.entry : 'main';
    const system = petSystemPrompt(petId, cfg);
    // 配图：全局开关关闭 / 池为空 / 池内图片全缺失 → 纯文本（不报错，退化为原行为）
    const meme = conf.whisperImageEnabled === true ? pickMeme(readMemePool(conf.memes, memeDirsFor(entry))) : undefined;
    // 模型：条目配置的 whisperModel 优先（留空 = 不指定）；生成侧失败会回落到本地服务配置的模型重试一次
    // now：时间背景由 whisper 侧拼到最后一条 user 消息（不进 system——那是缓存前缀，见 ./prompt）
    const result = await generateWhisper(ctx, system, meme, configuredModel(conf, 'whisperModel'), new Date());
    if (!result.ok) {
      // 失败**不写 S**（与改造前一致：静默跳过 + console.warn，不伪造文案、不弹错误气泡）
      console.warn(
        '[dsh-petNG] 碎碎念生成失败 pet=' +
          petId +
          ' reason=' +
          result.reason +
          (result.message ? ' ' + result.message : ''),
      );
      return false;
    }
    state.writePet(petId, 'say', result.image ? { text: result.text, image: result.image } : { text: result.text });
    return true;
  };

  /** 与某只宠物对话：截取最近记忆 → 生成回复 → 写入记忆 → 把回复写进 S 的 pets.<id>.say。
   *  供 POST /chat（动作端点）与 /chat 命令共用同一条路径（锁内读写，防并发交错写盘）。
   *  配图（chatImageEnabled 开启时）：把表情包清单交给模型按语境选一张，命中池内才随回复写回。 */
  const chatWithPet = async (
    petId: string,
    text: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'provider-missing' | 'generate-error'; message?: string }> =>
    memory.withLock(async () => {
      const cfg = readAllConfig(configPaths);
      const rounds = memory.roundsFor(petId, cfg);
      const found = findPetInstance(cfg, petId);
      const conf = (found ?? { conf: cfg.main ?? {} }).conf;
      // 人设：所属条目的 whisperPrompt（合并器已填默认）+ 名字声明（与碎碎念同一拼装）
      const system = petSystemPrompt(petId, cfg);
      // 配图：开关关闭 → 空池（指令与解析都不介入，与旧行为逐字一致）；目录链按所属条目取。
      // 张数上限（chatImageLimit，0 = 不限制）：整张清单每条消息都要附，截断后费用上限可控。
      const pool =
        conf.chatImageEnabled === true
          ? limitPool(readMemePool(conf.memes, memeDirsFor(found?.entry ?? 'main')), Number(conf.chatImageLimit))
          : [];
      const mem = await memory.read();
      const bucketKey = found?.entry ?? petId;
      const bucket = (mem[bucketKey] ??= {});
      const entry = (bucket[petId] ??= { messages: [] });
      // rounds = 0（用户关掉历史）→ 空历史；否则截尾部 rounds 轮（1 轮 = 1 问 1 答）。
      // 不能写 slice(-rounds * 2)：-0 在 JS 里 === 0，slice(-0) 返回整个数组而不是空。
      const list = sliceMemoryRounds(entry.messages, rounds);
      // 模型：条目配置的 chatModel 优先（留空 = 不指定）；生成侧失败会回落到本地服务配置的模型重试一次
      // 时间背景只进**这一次请求**的 user 消息（不进 system、也不写进记忆）：system + 历史构成
      // 的前缀因此逐字稳定，整段记忆都能命中 prompt cache——见 ./prompt 的头注释。
      const generated = await generateChat(
        ctx,
        system,
        list,
        withTimeContext(text, new Date()),
        pool,
        configuredModel(conf, 'chatModel'),
      );
      if (!generated.ok) return generated;
      const now = Date.now();
      entry.messages.push({ role: 'user', content: text, ts: now });
      // 记忆只存正文（配图属展示层，不进上下文——否则下次请求会把标记当历史读回去）
      entry.messages.push({ role: 'assistant', content: generated.text, ts: now });
      await memory.write(mem);
      // 回复写进 S（与碎碎念同一个叶子：前端本来就是同一条展示链路）。
      // `reply: true` 是给展示层的信号：这是**用户刚问的那句话的回答**，优先级高于
      // 「终态任务」气泡（否则对话一结束，turn/end 的「这一轮搞定啦」会把回答整段盖掉，
      // 用户只看到"任务结束"、看不到回答——只能再点一次对话翻历史）。
      state.writePet(
        petId,
        'say',
        generated.image
          ? { text: generated.text, image: generated.image, reply: true }
          : { text: generated.text, reply: true },
      );
      return { ok: true as const };
    });

  /**
   * 当前生效宠物列表 = readAllConfig 成品拍平（main + 文件宠物全部条目；合并器已保证 id 唯一、
   * 字段填满），命令与桌面模式都从这里取。
   */
  const effectivePetList = (): Record<string, unknown>[] => flattenPetList(readAllConfig(configPaths));

  /** 余额刷新周期（秒）：成品 main 条目的 eventsRefreshSec.balance（合并器已填默认；非法兜底 1800） */
  const balancePeriodSec = (cfg: Record<string, Record<string, unknown>>): number => {
    const ers = cfg.main?.eventsRefreshSec as Record<string, unknown> | undefined;
    const n = Number(ers?.balance);
    return Number.isFinite(n) && n > 0 ? n : 1800;
  };

  /** 碎碎念周期（秒）：该宠物**所属条目**的 eventsRefreshSec.whisper（合并器已填默认；非法兜底 300） */
  const whisperPeriodSec = (cfg: Record<string, Record<string, unknown>>, petId: string): number => {
    const conf = (findPetInstance(cfg, petId) ?? { conf: cfg.main ?? {} }).conf;
    const ers = conf.eventsRefreshSec as Record<string, unknown> | undefined;
    const n = Number(ers?.whisper);
    return Number.isFinite(n) && n > 0 ? n : 300;
  };

  /**
   * 刷新余额并写入 S —— host 侧**唯一**的余额查询点。
   *
   * 改造前是每个客户端各自按自己的定时器去查（每个窗口一个）：同一份外部 API
   * 被重复请求、不同窗口还可能看到新旧不一致的数据。现在只有这里查，所有窗口都从 /state 读同一份结果。
   *
   * 失败也写进 S（reason 区分 unsupported / credential-missing / fetch-error）——余额不可用要弹
   * 文字说明气泡，不能静默；意外异常同样落成 fetch-error，不吞。
   *
   * @param manual 这次刷新是不是"用户要的"（/balance 命令、桌面「查看余额」菜单）。
   *   标记随数据一起写进叶子：只有 host 知道是谁要的，前端据此决定余额不可用时要不要**必弹**
   *   文字说明（decideBalanceNotice 的 explicit；周期刷新则只在原因变化时弹一次，免得反复刷屏）。
   */
  const refreshBalance = async (manual = false): Promise<void> => {
    const mark = <T>(v: T): T | (T & { manual: true }) => (manual ? { ...v, manual: true } : v);
    try {
      const sel = ctx.agentDefaultModel.currentSelection();
      // 余额服务商：默认跟随当前对话的模型（DSH 内行为不变）。本地应用（无 DSH）允许
      // 「对话用 A、余额查 B」——宿主若提供 petBalanceProvider 能力就优先用它，空串回落 sel.provider。
      const petBalanceProvider = (ctx as { petBalanceProvider?: () => unknown }).petBalanceProvider;
      const balanceProviderId =
        typeof petBalanceProvider === 'function' ? String(petBalanceProvider() || sel.provider) : sel.provider;
      const result = await queryBalance(balanceProviderId, async (ref) => {
        const rc = await ctx.credentials.resolve(credentialRef(ref));
        return rc?.value;
      });
      state.writeSection('balance', mark(result));
    } catch (e) {
      state.writeSection(
        'balance',
        mark({
          ok: false,
          provider: 'unknown',
          reason: 'fetch-error',
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  /**
   * 「默认宠物」= 有效宠物列表的第一只。
   *
   * 从前这里还有"用户在 /pet 里选过哪只"的进程内状态；斜杠命令删掉后没有"当前桌宠"这个概念了，
   * 动作端点一律用查询参数 `pet=<id>` 指定目标，缺省就落到第一只。
   */
  const resolveActivePetId = (): string => {
    try {
      const eff = effectivePetList();
      return eff.length === 0 ? '' : String(eff[0].id);
    } catch {
      return '';
    }
  };

  let hasDesktopPet = false;
  const refreshDesktop = (): void => {
    hasDesktopPet = false;
    try {
      hasDesktopPet = effectivePetList().some((p) => isDesktopVisible(p.display));
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-petNG] 宠物配置非法，桌面模式已跳过：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  refreshDesktop();

  /** 桌面可见宠物列表（[{id,size}]）：应用据此决定开几个局部窗口（每宠物一个）。 */
  const desktopPetList = (): Array<{ id: string; size: number }> => {
    try {
      return effectivePetList()
        .filter((p) => isDesktopVisible(p.display))
        .map((p) => ({ id: String(p.id), size: Number(p.size) }));
    } catch {
      return [];
    }
  };

  /**
   * 桌面窗口能力：由应用注入（`src/main/desktop.ts`）。
   *
   * 纯 Node 环境（单测、脚本）没有它 → 桌面宠物不可用，其余端点照常——这也是为什么它是
   * **可选**能力而不是硬依赖：宿主的业务逻辑不该因为"没图形环境"而跑不起来。
   */
  const desktop = ctx.petDesktop as PetDesktop | undefined;

  let disposed = false;
  let desktopRunning = false;
  let startRetryTimer: NodeJS.Timeout | undefined;

  /**
   * 渲染端的一次请求 → 宿主路由结果。
   *
   * 与 HTTP 路由**同一个** handlePetRoute：桌面窗口看到的配置/状态/素材与第三方脚本拉到的
   * 完全一致，不存在"两套语义慢慢漂移"。素材走文件绝对路径，二进制不过 JSON。
   */
  const desktopRequest = async (req: DesktopRequest): Promise<DesktopResponse> => {
    const result = await handlePetRouteWithTurn(req.url, req.method, req.body);
    if (result.kind === 'file') {
      // file 分支恒 200（404/400 已由 text 分支表达）
      return { status: 200, contentType: result.contentType, file: result.file };
    }
    if (result.kind === 'text') {
      return { status: result.status, contentType: 'text/plain; charset=utf-8', body: result.body };
    }
    return {
      status: result.status,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(result.obj),
    };
  };

  /** 按当前配置把桌面窗口开出来（没有桌面能力 / 无可见宠物时什么都不做） */
  const startDesktop = (): void => {
    if (disposed || !desktop || desktopRunning) return;
    if (!hasDesktopPet) return; // 没有任何宠物 display 含 desktop/both：不开窗口
    const port = typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : 0;
    if (!port || port <= 0) {
      // 服务可能尚未完成监听（OS 分配端口时 port 短暂为 0）：延迟重试。
      if (!startRetryTimer) {
        startRetryTimer = setTimeout(() => {
          startRetryTimer = undefined;
          startDesktop();
        }, 500);
        startRetryTimer.unref?.();
      }
      return;
    }
    const configUrl = `http://127.0.0.1:${port}${ROUTE_PREFIX}/config`;
    try {
      const count = desktop.start({ pets: desktopPetList(), configUrl, request: desktopRequest });
      desktopRunning = count > 0;
      ctx.logger?.info?.(`dsh-petNG 桌面窗口已就绪：${count} 个`);
    } catch (e) {
      desktopRunning = false;
      ctx.logger?.warn?.(`dsh-petNG 桌面窗口创建失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** 销毁全部桌面窗口（保留配置，可再次拉起） */
  const stopDesktop = (reason = 'settings-change'): void => {
    if (startRetryTimer) {
      clearTimeout(startRetryTimer);
      startRetryTimer = undefined;
    }
    if (!desktopRunning) return;
    desktopRunning = false;
    ctx.logger?.debug?.(`dsh-petNG 桌面窗口关闭（${reason}）`);
    desktop?.stop();
  };

  /**
   * 宠物配置（display / size 等）变更后：重解析桌面宠物并**重建全部窗口**。
   *
   * 合并进程前这里要「等旧 helper 真正退出再 spawn 新的」（issue #64：旧窗口还没消失、新窗口
   * 已经画出来，用户看到两只宠物）。现在销毁是同步的，`stop()` 返回时窗口已经没了，不需要等待，
   * 也就没有重叠的可能。
   *
   * 队列保留：连续保存会触发多次重建，串行化让"最后一次配置"一定最后生效，
   * 也避免中间态被并发打乱。队列自身绝不留下 rejected 状态，否则后续保存再也不会重建。
   */
  let desktopSyncQueue: Promise<void> = Promise.resolve();
  const syncDesktop = (): Promise<void> => {
    desktopSyncQueue = desktopSyncQueue
      .then(async () => {
        refreshDesktop();
        stopDesktop('desktop-config-change');
        startDesktop();
      })
      .catch((e: unknown) => {
        ctx.logger?.warn?.(`[dsh-petNG] 重建桌面窗口失败：${e instanceof Error ? e.message : String(e)}`);
      });
    return desktopSyncQueue;
  };

  /** 单次业务路由（HTTP 请求与桌面窗口的 scheme 请求共用同一份实现）：
   *  输入只需 rawUrl(/dsh-pet-ng-7340/... + 查询) + method + body 文本；返回 RouteResult(JSON/文本/文件)，
   *  消费方各自落盘——业务逻辑只有一份，设置页 / 桌面窗口 / 第三方脚本看到的完全一致。 */
  // 全部端点实现在 api/router.ts：这里只负责把装配好的服务与状态递进去
  const handlePetRouteWithTurn = createPetRouter({
    routePrefix: ROUTE_PREFIX,
    packageRoot: PACKAGE_ROOT,
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
    llm: ctx.llm,
    readMemory: () => memory.read(),
    memoryRounds: (petId, cfg) => memory.roundsFor(petId, cfg),
    publishWhisper,
    chatWithPet,
    refreshBalance,
    resolveActivePetId,
    syncDesktop,
    applyExternalStatus,
    emit: (name, ...args) => ctx.emit?.(name, ...args),
    logger: ctx.logger,
  });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            const body = req.method === 'PUT' || req.method === 'POST' ? await readBody(req) : undefined;
            const result = await handlePetRouteWithTurn(req.url ?? '/', req.method ?? 'GET', body);
            if (result.kind === 'json') sendJson(res, result.status, result.obj, result.headers);
            else if (result.kind === 'text') sendText(res, result.status, result.body);
            else sendFile(res, result.file, result.contentType); // 非 async：流在 open 后自己 pipe，错误内部收口
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
        },
      }),
    'dsh-petNG: /dsh-pet-ng-7340 asset route',
  );

  // 工作状态联动：监听 DSH 会话事件 → 聚合"当前活动状态"（WorkStatusStore → 展示快照）。
  // 消费的事件：turn/start、user/message（goal 续跑轮判定）、tool/call（update_goal 收尾判定）、
  // tool/result、approval/asked、turn/end、todo/write（只更新任务详情文案，不切档位）。
  // 纯监听不调用模型；有宠物启用 workStatusEnabled 时才被浏览器侧消费（host 侧恒轻量监听）。
  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session: unknown, event: unknown) => {
      const type = (event as { type?: string } | null)?.type;
      if (!type) return;
      const sessionId = String(
        (session as { id?: unknown; header?: { id?: unknown } } | null)?.header?.id ??
          (session as { id?: unknown } | null)?.id ??
          'unknown',
      );
      if (type === 'todo/write') {
        // 任务详情文案：只写**该会话**的条目（state/task 同源，不再有全局字段，也就不可能串会话）。
        // 会话没有活动条目（已空闲/已清理）→ 不动：它不会被展示，写进去只会成为一条"幽灵文案"。
        // 清单里再无 in_progress/pending 时 currentTaskFromTodo 返回 null，等于把旧文案清掉、
        // 气泡回落到档位文案（issue #59 缺陷 3：档位文案不该被一条历史记录永久屏蔽）。
        if (workStatus.has(sessionId)) {
          workStatus.setTask(
            sessionId,
            currentTaskFromTodo(event as { data?: { todos?: Array<{ status?: string; content?: string }> } }),
          );
          publishWorkStatus(); // 任务文案变化也要写 S（气泡内容靠它更新）
        }
        return;
      }
      if (type === 'turn/start') {
        // 新一轮也开始新的任务上下文：清掉上一轮留下的任务详情文案（issue #59），否则它会一直挂着。
        // 代价：goal 续跑这类多轮任务，每轮开头会回落一瞬档位文案，直到本轮（通常在开头几步内）
        // 再写一次 todo 清单。
        workStatus.setTask(sessionId, null);
        publishWorkStatus(); // 清掉上一轮任务文案也要写 S
      }
      const next = reduceWorkStatus(
        event as { type?: string; data?: Record<string, unknown> & { reason?: { kind?: string } } },
      );
      if (!next) {
        // turn/end 的 null（aborted / 未知 kind）＝该会话回合已结束：清掉会话状态，让展示回到空闲或
        // 落到其他活跃会话，防止回合被打断后永久卡在上一档；其他事件的 null 是"不关心"，忽略。
        if (type === 'turn/end') {
          notify.cancelTerminal(sessionId); // 条目都要清了，别留一个到点后无事可做的定时器
          workStatus.clear(sessionId); // 条目连同任务详情文案一起消失（clear 内部会重算展示）
          publishWorkStatus(); // 回合被打断 → 回到空闲：前端据此收起常驻气泡
        }
        return;
      }
      const seq = Number((event as { seq?: unknown }).seq ?? 0);
      // 同会话同状态不重复更新（防刷屏）；不同状态才改写并重算展示。
      // 终态走 setTerminal（终态排他：先扫掉别处遗留的成功/出错，否则外部状态灯那条用
      // Date.now() 当 seq 的陈旧文案会抢走真实对话结果的展示，见 work-status.ts）。
      const changed =
        next === 'success' || next === 'error'
          ? workStatus.setTerminal(sessionId, next, seq)
          : workStatus.setState(sessionId, next, seq);
      if (!changed) return;
      publishWorkStatus(); // 档位变了 → 写 S（前端据此切动画 + 气泡）
      // 终态只展示短暂窗口后自动清理：陈旧完成态不再浮上来（Bug 3 的一环，顺带缓解 Bug 2 残留）。
      // 回到非终态则取消那次待执行的清理——否则它到点时会话已非终态，既不清也不重排，
      // 条目（连同旧任务文案）就永久留下了。
      notify.onTerminalState(sessionId, next);
    });
    return () => {
      dispose();
      notify.dispose();
    };
  }, 'dsh-petNG: work-status session events');

  // 系统通知：监听 DSH 宿主事件 → 生成通知帧入队（浏览器轮询 /state 读到后弹 toast）。
  // 与 work-status 同一 session/event 源，但职责各自独立（通知帧 = 事件 → toast 的一对一映射，
  // 不做状态聚合）。帧契约与 shared/notify.ts 完全一致，浏览器侧映射零改动。
  //   事件源：turn/end（完成/失败/截断）、approval/asked（权限申请）、
  //          tool/call（ask_user_question：用户选择）、agent/error（无回合位置失败，0.1.5 新增）。
  //   两道门：会话门 #82（shouldNotifySession：子代理/委派不发）+ 活动门 #114（只拦「对话完成」，
  //          延迟确认这条会话确实没活了再弹，见上方 scheduleCompletionNotify）。
  // 纯监听不调用模型；通知是浏览器网页端能力，桌面模式不消费本队列（不影响任何宠物行为）。
  ctx.effect(() => {
    const sessionDispose = ctx.on(
      'session/event',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (session: any, event: any) => {
        // 会话门（issue #82）：子代理 / 委派会话不发通知——你等的是父对话，不是某一路子代理跑完。
        // 判据用 header.origin（不是 parentSession，那会把普通 fork 的主对话一起静音），
        // 判据不可用时放行，绝不把通知整体打哑。详见 notify-events.ts 的 shouldNotifySession。
        if (!shouldNotifySession(session)) return;
        // 活动门（issue #114）：「对话完成」延迟确认这条会话确实没活了再弹——团队会话里 Lead 的
        // 这一轮结束 ≠ 团队收工，成员还在跑时弹「对话完成」是误报。生成失败/输出截断、权限申请、
        // 用户选择不过这道门，直接放行（理由见 notify-events.ts 的 isCompletionTurnEnd）。
        if (isCompletionTurnEnd(event)) {
          notify.scheduleCompletion(sessionIdOf(session), event);
          return;
        }
        const frame = reduceNotifyFrame(event as Parameters<typeof reduceNotifyFrame>[0]);
        if (frame) notify.pushFrame(frame);
      },
    );
    // agent/error（agent-loop dispatch.emit）：无回合位置的生成失败；0.1.5 新增，
    // 旧版无此事件 = 少一条通知（turn/end error 分支已覆盖大部分失败场景），不报错。
    // **两道门都管不到它**：载荷只有 { turn, step, error }，不带会话标识，无从判定来源。
    const errorDispose = ctx.on(
      'agent/error',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (payload: any) => {
        notify.pushFrame(agentErrorFrame(payload?.error));
      },
    );
    return () => {
      // 卸载时清掉待查的定时器：否则插件已卸载，到点还去写一次 S
      notify.dispose();
      sessionDispose();
      errorDispose();
    };
  }, 'dsh-petNG: notify frames');

  // 余额周期刷新：host 侧唯一定时器（前端不再有任何余额定时器）。
  // 周期**每次重新读配置** eventsRefreshSec.balance → 改了配置下一拍自然跟上。
  // 没有任何启用余额的宠物时跳过查询：尊重配置，不白花外部 API 调用。
  ctx.effect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function arm(sec: number): void {
      if (disposed) return;
      timer = setTimeout(() => void tick(), Math.max(1000, sec * 1000));
    }
    async function tick(): Promise<void> {
      let sec: number;
      try {
        const cfg = readAllConfig(configPaths);
        sec = balancePeriodSec(cfg);
        // 没有任何启用余额的宠物 → 不查（省外部调用）；配置改了下一拍自然跟上
        if (flattenPetList(cfg).some((p) => p.balanceEnabled === true)) await refreshBalance();
      } catch {
        // 读配置抛错 = 安装损坏（readAllConfig 只在**内置默认**缺失/损坏时抛，用户层写坏只会告警回退）：
        // 不再重排——每 30 分钟重试一次没有意义，而且会白占一个常驻定时器。修好安装后重启 DSH 即可。
        return;
      }
      arm(sec);
    }
    void tick(); // 启动即拉一次（与改造前客户端"先拉一次再定时"一致）
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, 'dsh-petNG: balance poll');

  // 碎碎念周期：host 侧调度（前端不再有任何碎碎念定时器）。
  // 一拍 = 读一次配置 + 给"到点"的宠物各生成一句；下一拍按**最短周期**排（多数部署只有一个
  // 周期值，那它就是那个值）。用"读一次配置 + 逐宠物比对 lastWhisperAt"而不是每宠一个定时器：
  // 宠物随配置增删、周期随条目改，固定拍天然跟上，不用维护一堆定时器的生命周期。
  ctx.effect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function arm(sec: number): void {
      if (disposed) return;
      timer = setTimeout(() => void tick(), Math.max(1000, sec * 1000));
    }
    function tick(): void {
      let next = 300;
      try {
        const cfg = readAllConfig(configPaths);
        const now = Date.now();
        let min = Infinity;
        for (const pet of flattenPetList(cfg)) {
          const petId = String(pet.id ?? '');
          if (!petId || pet.whisperEnabled !== true) continue;
          const sec = whisperPeriodSec(cfg, petId);
          min = Math.min(min, sec);
          if (now - (lastWhisperAt.get(petId) ?? 0) < sec * 1000) continue;
          lastWhisperAt.set(petId, now);
          // 不 await：生成要几秒，别把调度拍拖住（每只宠物独立生成，互不阻塞）
          void publishWhisper(petId).catch(() => {});
        }
        if (Number.isFinite(min)) next = min;
      } catch {
        // 读配置抛错 = 安装损坏（同余额定时器）：不再重排，别白占常驻句柄
        return;
      }
      arm(next);
    }
    void tick(); // 启动即生成一次（与改造前客户端首拉就生成一致）
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, 'dsh-petNG: whisper poll');

  // 系统通知的宿主监听已在上方注册（notify frames effect）：host 监听 session/event +
  // agent/error 生成通知帧入队，浏览器轮询 /notify 拉取弹 toast（DSH 0.1.5 删除了浏览器侧
  // api.events.mux/host 事件流，通知与宠物一样改走 host 通道，两端行为一致）。

  // 随宿主生命周期清理：销毁全部桌面窗口
  ctx.effect(() => () => {
    disposed = true;
    workStatusPublisher.dispose();
    stopDesktop('host-dispose');
  });

  // 路由就绪后把桌面窗口开出来（无桌面能力 / 无可见宠物时静默跳过）
  startDesktop();
}
