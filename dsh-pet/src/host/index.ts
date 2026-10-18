/**
 * dsh-pet 宿主半边 —— 应用的全部业务能力（HTTP 路由的唯一实现）。
 *
 * 职责：提供 `/dsh-pet-7340/` 前缀下的所有端点（`handlePetRoute`）。
 * 全部配置（内置默认 + 用户主配置 + 文件宠物）由 `./config` 的 `readAllConfig` 统一读取合并，
 * 本文件只消费它的返回值（绝对正确、零校验），不直接解析任何配置文件。
 *
 * 谁在用这份实现：
 *   - 本地 HTTP 服务（`src/app/server.ts` 把请求转进来）—— 设置页、桌面窗口、第三方脚本都走它；
 *   - 桌面窗口的 bridge（`src/app/desktop.ts` 注入的 request）—— 窗口内渲染端取配置/状态/素材。
 * 两条路共用同一个函数，所以「桌面看到的」与「接口返回的」永远一致。
 *
 * 路由：
 *   /dsh-pet-7340/config             → 合并后的**成品配置**（{ main:{...}, test1:{...}, ... }，
 *                                每条目字段已填满；设置页与桌面窗口的唯一配置入口）
 *                                GET 读取成品；PUT 保存用户层（白名单重建 main-config.jsonc）、
 *                                POST 同步用户层（把内置默认 config.jsonc **原文**整份写入，
 *                                含注释与全部高级字段）—— 两个写接口的**响应体都是保存后的成品聚合**
 *   /dsh-pet-7340/reload              → 「重载配置」（POST）：重建桌面窗口，全部宠物窗口按最新配置重建；
 *                                与保存走**同一条**重启路径（syncDesktop），数量/display/size 变化同样生效
 *   /dsh-pet-7340/config/meta         → 配置文件与素材目录路径 + 全部存储位置清单（设置页「存储」区）
 *   /dsh-pet-7340/models              → 可选「服务商 + 模型」清单（设置页「本地服务」下拉框数据源）
 *   /dsh-pet-7340/thumb/<素材根>/<动画名>.webm|.mov  → 素材按宠物归属：
 *       文件宠物 = /dsh-pet/pet/<素材根>-animation/（只查自己的，绝不回落）；
 *       主宠物   = /dsh-pet/main-animation/<webm|mov>（用户目录，优先）→ 包内 assets/<webm|mov>
 *       <素材根> 是**标识符**（pet/ 下文件名前缀），含分隔符/保留字符即 400（见 ID_FORBIDDEN）
 *   /dsh-pet-7340/state               → **轮询统一状态 S**（GET，前端 1s 轮询的唯一数据源）：
 *                                       { sections: { balance, workStatus, notify }, pets: { <id>: { say } } }，
 *                                       每个叶子 = { counter, data }；counter 变了前端才渲染。
 *                                       只读、纯内存、零副作用（绝不在这里触发外部调用/模型生成）。
 *   /dsh-pet-7340/balance              → 余额刷新（POST 动作端点，写 S；数据从 /state 读）
 *   /dsh-pet-7340/whisper              → 让某只宠物立即说一句（POST 动作端点，写 S 的 pets.<id>.say）
 *   /dsh-pet-7340/broadcast            → 第三方投喂：把外部给定的文本写进气泡（不生成、只搬运）
 *   /dsh-pet-7340/anim                 → 点播动画（效果与右键「动作」菜单一致）
 *   /dsh-pet-7340/chat                 → 对话与记忆（GET 最近窗口 / POST 对话并写 memory.json）
 *   /dsh-pet-7340/font|pic             → 字体 / 通知图标 / 表情包素材
 *
 * 系统通知：应用把「一次对话生成」合成 turn/start、turn/end 会话事件投进来（见 src/app/main.ts），
 * 这里据此生成通知帧写进 S 的 sections.notify，应用主进程轮询到变化后弹原生通知
 * （帧契约与 shared/notify.ts 一致；单槽，见下方 pushNotifyFrame）。
 *
 * 安全性：resolveAsset 做「防穿越」校验，保证路径仍在对应根目录内；
 *         PUT 保存经 saveUserConfig 白名单重建，id 过滤文件名非法字符。
 */
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { queryBalance } from './balance/index';
import { generateWhisper } from './whisper';
import { generateChat, type ChatMemoryMessage } from './chat';
import { configuredModel } from './model-selection';
import { limitPool, pickMeme, readMemePool } from './memes';
import { decideBroadcast, normalizeBroadcastText } from './broadcast';
import { decideAnim } from './anim';
import {
  configVersion,
  findPetInstance,
  flattenPetList,
  ID_FORBIDDEN,
  migrateUserConfig,
  PET_DISPLAY_SET,
  readAllConfig,
  readPetConfigEntry,
  readUserConfig,
  saveUserConfig,
  sliceMemoryRounds,
  syncUserConfigFromDefault,
  userConfigUnparsable,
  type ConfigPaths,
} from './config';
import {
  EXTERNAL_STATUS_SESSION,
  WorkStatusStore,
  currentTaskFromTodo,
  parseExternalWorkStatus,
  reduceWorkStatus,
  type ExternalWorkStatusInput,
} from './work-status';
import {
  agentErrorFrame,
  hasBlockingActivity,
  isCompletionTurnEnd,
  reduceNotifyFrame,
  sessionIdOf,
  shouldNotifySession,
  type HostNotifyFrame,
} from './notify-events';
import { profileNameFrom, storageEntries } from './storage-paths';
import { createAssetPaths } from './assets';
import { PollStateStore } from './state';
import {
  mimeOf,
  readBody,
  resolveAsset,
  resolveExisting,
  sendFile,
  sendJson,
  sendText,
  type RouteResult,
} from './http';
import { timeContextOf } from './time-context';
import type { DesktopRequest, DesktopResponse, PetDesktop } from './desktop-api';
import { electronLandingDir } from '../app/electron-runtime';

/** 插件行 id（与 cordis.patch.yml 一致） */
export const name = 'pet';
/**
 * 宿主半边对 ctx 的要求（应用在 `src/app/context.ts` 里一次性给齐）：
 * webServer（路由）+ agentDefaultModel（服务商/模型）+ credentials（凭证）+ llm（生成）。
 * 这里刻意**不声明** Cordis 的 `inject`：应用直接调 `apply(ctx)`，那份清单只对插件加载器有意义。
 */

/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const ROUTE_PREFIX = '/dsh-pet-7340';

// 配置的读取/校验/合并/保存全部收敛在 ./config（readAllConfig / saveUserConfig，host 自包含实现，
// 不 import src/shared —— 宿主跑在 Node、渲染端跑在浏览器上下文，避免把 DOM 代码拖进来）。本文件不再保留任何配置逻辑，只消费成品返回值。

/** 该宠物是否参与桌面模式（Electron 透明窗） */
const isDesktopVisible = (display: unknown): boolean => display === 'desktop' || display === 'both';

// ---------------------------------------------------------------------------
// 额外宠物（pet pack）说明：校验/扫描已收敛到 ./config（readAllConfig 内部逐字段合并），
// 这里不再有 host 侧拷贝——文件宠物与主宠物一样，统一从 readAllConfig 的成品读取。
// ---------------------------------------------------------------------------

/** 宿主主体：注册 `/dsh-pet-7340` 前缀路由（全部业务端点的唯一实现）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 应用注入的 ctx（webServer 等能力无静态类型）
export function apply(ctx: any): void {
  // 用户数据根：配置与用户素材统一收敛于此（扩展包按 <插件id> 各自建目录）
  const dshHome = resolveDshHome();
  const userRoot = join(dshHome, 'dsh-pet');
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
  migrateUserConfig(configPaths, (msg) => console.log('[dsh-pet] ' + msg));
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
  const workStatus = new WorkStatusStore();
  // 工作状态快照 → 写进 S（前端 1s 轮询 /state 后按 counter 变化渲染）。
  // **只在内容真的变了时才写**：每次写都会推进 counter，前端据此重播档位动画——
  // 会话事件很密（每个 tool/call 都来），无条件写会把动画刷成幻灯片。
  // 判据用**内容**（state + task）而不是 store 的 ts：ts 是 Date.now()（毫秒分辨率），
  // 同一毫秒内连改两次会被误判成"没变化"而漏写（测试里连发事件就会踩到）。
  // data 里不再带 ts：「变了没有」已由叶子 counter 承担，少一个会漂移的第二信号。
  let publishedWork = '\u0000';
  const publishWorkStatus = (): void => {
    const snap = workStatus.snapshot();
    const key = String(snap.state) + '\u0000' + String(snap.task);
    if (key === publishedWork) return;
    publishedWork = key;
    state.writeSection('workStatus', { state: snap.state, task: snap.task });
  };
  /**
   * 外部状态灯（`POST /work-status`）：脚本 / IDE 插件 / CI / agent 把桌宠当一盏状态灯用。
   *
   * 为什么需要它：离开 DSH 之后，6 个档位里只有「思考 / 成功 / 出错」还能被真实事件触发，
   * 另外三个（working / result / waiting）描述的是「agent 在调工具、在等你确认」——本地没有 agent。
   * 与其让它们变成死档位，不如把入口开放出去：任何本机任务都能点亮这盏灯。
   *
   * 落地方式是**复用同一条链路**：写进同一个 WorkStatusStore（独立会话 id），
   * 动画、气泡文案、优先级聚合、终态清理全部沿用，渲染端零改动。
   */
  let externalClearTimer: ReturnType<typeof setTimeout> | undefined;
  const applyExternalStatus = (input: ExternalWorkStatusInput): void => {
    // 每次写入都重排 TTL：后一次写入代表"任务还在继续"，不该被上一条的定时器提前清掉
    if (externalClearTimer) {
      clearTimeout(externalClearTimer);
      externalClearTimer = undefined;
    }
    if (input.state === null) {
      if (workStatus.clear(EXTERNAL_STATUS_SESSION)) publishWorkStatus();
      return;
    }
    // 先扫掉别处遗留的终态（对话刚结束的成功/出错会挂 60s）：它们的优先级高于 working，
    // 不扫就会出现"灯点亮了，宠物还在演上一轮结果"。
    workStatus.clearTerminal(EXTERNAL_STATUS_SESSION);
    workStatus.setState(EXTERNAL_STATUS_SESSION, input.state, Date.now());
    workStatus.setTask(EXTERNAL_STATUS_SESSION, input.text);
    publishWorkStatus();
    if (input.ttlSec > 0) {
      externalClearTimer = setTimeout(() => {
        externalClearTimer = undefined;
        if (workStatus.clear(EXTERNAL_STATUS_SESSION)) publishWorkStatus();
      }, input.ttlSec * 1000);
      externalClearTimer.unref?.();
    }
  };

  // 系统通知帧：宿主监听应用投进来的会话事件（turn/end、agent/error）生成通知帧
  // （帧契约与 shared/notify.ts 一致），写进 S 的 sections.notify；应用主进程轮询到变化后
  // 弹原生通知（见 src/app/notifications.ts）。
  // **单槽**（后到覆盖先到）：同一秒来多条只弹最后一条。这是有意的取舍——1 秒内连弹多个系统通知
  // 本身没有意义（反而更烦），所以不再带 seq / 增量帧队列（改造前的 frames 数组机制已删）。
  const pushNotifyFrame = (frame: HostNotifyFrame): void => {
    state.writeSection('notify', frame);
  }; /** 每会话 turn 级标志（goal 续跑轮判定；不参与展示，仅修正 turn/end 终局语义） */
  /** 终态（success/error）展示窗口定时器：约 60s 后清掉该会话条目，陈旧完成态不再浮上来（Bug 2/3） */
  const terminalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const TERMINAL_KEEP_MS = 60 * 1000;
  /** 取消某会话待执行的终态清理：会话已回到非终态，那次清理到点后既不清理也不重排，留着只会误导 */
  const cancelTerminalCleanup = (sessionId: string): void => {
    const t = terminalTimers.get(sessionId);
    if (t === undefined) return;
    clearTimeout(t);
    terminalTimers.delete(sessionId);
  };
  /** 排一个终态清理定时器（每会话一个，已排则跳过） */
  const scheduleTerminalCleanup = (sessionId: string): void => {
    if (terminalTimers.has(sessionId)) return;
    const t = setTimeout(() => {
      terminalTimers.delete(sessionId);
      const sessionState = workStatus.stateOf(sessionId);
      if (sessionState === 'success' || sessionState === 'error') {
        workStatus.clear(sessionId); // 条目连同它的任务详情文案一起消失，不残留到后续活动
        publishWorkStatus(); // 清完要写 S：否则前端一直挂着那条陈旧完成态
      }
    }, TERMINAL_KEEP_MS);
    terminalTimers.set(sessionId, t);
  };
  // 通知活动门（issue #114）：「对话完成」不立刻弹，先挂起，到点确认这条会话确实没活了再弹
  // （在跑的下属子代理 / 团队成员、后台任务、活跃提醒任一非空 → 丢弃这一帧）。
  //
  // 为什么必须延迟而不是同步查：`workspace/session-activity` 的 turn 族读的是**活 Agent 的
  // status**，而 turn/end 是在回合体的 finally 里追加的——同步那一刻它自己还是 running，判据必然
  // 非空，照「任一非空就不弹」写会把每一条通知都吞掉（详见 notify-events.ts 的 hasBlockingActivity）。
  // 延迟同时让「成员刚变 idle、Lead 下一秒 send_message 又把它唤醒」的窗口过去（队友邮箱是入队后
  // 立刻投递、空闲目标会起一轮）。
  //
  // 判据不可用（宿主没组合 workspace、standalone 伪 ctx 没有 waterfall、调用抛错、返回值形状不对）
  // → 一律放行：宁可多弹一条，也不能让通知被一次宿主变更整体打哑。
  const NOTIFY_ACTIVITY_DELAY_MS = 1500;
  /** 每会话一个待查定时器（同会话连续收尾只保留最后一次：后到覆盖先到，与单槽帧同语义） */
  const notifyActivityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** waterfall 只用到签名本身：DSH 未导出该事件的请求/响应类型，这里宽松声明（与 ctx 同为 any 的现状一致） */
  type Waterfall = (name: string, request: unknown, next: () => Promise<unknown[]>) => Promise<unknown>;
  /** 这条会话是否还有在跑的活；判据不可用一律 false＝放行 */
  const sessionHasRunningWork = async (sessionId: string): Promise<boolean> => {
    const waterfall = (ctx as { waterfall?: Waterfall }).waterfall;
    if (typeof waterfall !== 'function') return false;
    try {
      const activity = await waterfall.call(ctx, 'workspace/session-activity', { sessionId }, () =>
        Promise.resolve([]),
      );
      return hasBlockingActivity(activity);
    } catch {
      return false; // 查询失败不阻塞通知（与「判据不可用时放行」同一策略）
    }
  };
  /** 排一个活动门定时器：到点确认空闲才推这一帧 */
  const scheduleCompletionNotify = (sessionId: string, event: unknown): void => {
    const prev = notifyActivityTimers.get(sessionId);
    if (prev !== undefined) clearTimeout(prev);
    notifyActivityTimers.set(
      sessionId,
      setTimeout(() => {
        notifyActivityTimers.delete(sessionId);
        void (async () => {
          if (await sessionHasRunningWork(sessionId)) return; // 还有活：等真正的收尾轮再弹
          const frame = reduceNotifyFrame(event as Parameters<typeof reduceNotifyFrame>[0]);
          if (frame) pushNotifyFrame(frame);
        })();
      }, NOTIFY_ACTIVITY_DELAY_MS),
    );
  };
  // 碎碎念周期调度的「上次生成时刻」（按宠物）：调度拍据此判断到没到点。
  // 改造前这份节流靠 whisperCache（缓存 + ts 比较），现在"该不该生成"由调度侧决定、
  // "生成结果"直接写 S——多端共享同一句由 S 天然保证，不再需要第二份缓存。
  const lastWhisperAt = new Map<string, number>();

  // 对话记忆文件（唯一读写方 = 本进程；桌面窗口与设置页都只是客户端 → 同一实例天然共享同一份记忆）。
  // 结构双层：{ <种类桶 assetRoot ?? petId>: { <实例 id>: { messages: ChatMemoryMessage[] } } }
  const memoryPath = join(userRoot, 'memory.json');
  // 对话写操作串行队列：read-modify-write 排队执行，防并发对话时交错写盘
  let chatQueue: Promise<void> = Promise.resolve();

  /** 读记忆文件：不存在 → 空；损坏 → 显式报错 + 备份原始文件（绝不静默丢数据）+ 重建空记忆 */
  const readMemory = async (): Promise<Record<string, Record<string, { messages: ChatMemoryMessage[] }>>> => {
    let raw: string;
    try {
      raw = await readFile(memoryPath, 'utf8');
    } catch {
      return {}; // 文件不存在 = 尚无记忆
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      return parsed as Record<string, Record<string, { messages: ChatMemoryMessage[] }>>;
    } catch (e) {
      console.error(
        `dsh-pet: 记忆文件损坏已备份（对话将从头开始）：${memoryPath}（${e instanceof Error ? e.message : String(e)}）`,
      );
      try {
        await mkdir(userRoot, { recursive: true });
        await writeFile(`${memoryPath}.bak-${Date.now()}`, raw, 'utf8');
      } catch {
        /* 备份失败仅告警，不阻断 */
      }
      return {};
    }
  };

  const writeMemory = async (mem: Record<string, Record<string, { messages: ChatMemoryMessage[] }>>): Promise<void> => {
    await mkdir(userRoot, { recursive: true });
    await writeFile(memoryPath, JSON.stringify(mem, null, 2), 'utf8');
  };

  /** 把一次读写封进串行队列（同进程内防交错），返回 fn 的结果 */
  const withMemoryLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chatQueue.then(fn, fn);
    chatQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // ---- 配置消费：唯一入口 readAllConfig（./config）——返回值绝对正确，这里只读字段，零校验 ----

  /** 某宠物的最终人设 system：所属条目（非文件宠物 → main 条目）的 whisperPrompt（合并器已填默认）
   *  + 无条件追加一句名字声明（name，缺失已按 id）——碎碎念与对话共用同一拼装。
   *  + 末尾追加一行**时间背景**（time-context.ts：日期/星期/时刻/时段/工作日或周末）：
   *    碎碎念与对话各自每次生成都会重新走这里，所以拿到的永远是**当前**时刻，不需要额外的刷新机制；
   *    非法 Date 时它为空串，此时整行不加（宁可没有时间信息，也不把 NaN 拼进提示词）。 */
  const petSystemPrompt = (petId: string, cfg: Record<string, Record<string, unknown>>): string => {
    const found = findPetInstance(cfg, petId);
    const conf = found ? found.conf : (cfg.main ?? {});
    const prompt = typeof conf.whisperPrompt === 'string' ? conf.whisperPrompt : '';
    const name = found ? String(found.pet.name || found.pet.id || petId) : petId;
    const nameLine = '你的名字是“' + name + '”。';
    const base = prompt ? prompt + '\n' + nameLine : nameLine;
    const time = timeContextOf(new Date());
    return time ? base + '\n' + time : base;
  };

  /** 对话记忆轮数（1 轮 = 1 问 1 答）：所属条目/主条目的 chatMemoryRounds（合并器已填默认非负数字） */
  const memoryRounds = (petId: string, cfg: Record<string, Record<string, unknown>>): number => {
    const found = findPetInstance(cfg, petId);
    const v = Number(found?.conf.chatMemoryRounds ?? cfg.main?.chatMemoryRounds);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
  };

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
    // 模型：条目配置的 whisperModel 优先（留空 = 不指定）；生成侧失败会回落到当前对话的模型重试一次
    const result = await generateWhisper(ctx, system, meme, configuredModel(conf, 'whisperModel'));
    if (!result.ok) {
      // 失败**不写 S**（与改造前一致：静默跳过 + console.warn，不伪造文案、不弹错误气泡）
      console.warn(
        '[dsh-pet] 碎碎念生成失败 pet=' +
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
    withMemoryLock(async () => {
      const cfg = readAllConfig(configPaths);
      const rounds = memoryRounds(petId, cfg);
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
      const mem = await readMemory();
      const bucketKey = found?.entry ?? petId;
      const bucket = (mem[bucketKey] ??= {});
      const entry = (bucket[petId] ??= { messages: [] });
      // rounds = 0（用户关掉历史）→ 空历史；否则截尾部 rounds 轮（1 轮 = 1 问 1 答）。
      // 不能写 slice(-rounds * 2)：-0 在 JS 里 === 0，slice(-0) 返回整个数组而不是空。
      const list = sliceMemoryRounds(entry.messages, rounds);
      // 模型：条目配置的 chatModel 优先（留空 = 不指定）；生成侧失败会回落到当前对话的模型重试一次
      const generated = await generateChat(ctx, system, list, text, pool, configuredModel(conf, 'chatModel'));
      if (!generated.ok) return generated;
      const now = Date.now();
      entry.messages.push({ role: 'user', content: text, ts: now });
      // 记忆只存正文（配图属展示层，不进上下文——否则下次请求会把标记当历史读回去）
      entry.messages.push({ role: 'assistant', content: generated.text, ts: now });
      await writeMemory(mem);
      // 回复写进 S（与碎碎念同一个叶子：前端本来就是同一条展示链路）
      state.writePet(
        petId,
        'say',
        generated.image ? { text: generated.text, image: generated.image } : { text: generated.text },
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
      ctx.logger?.warn?.(`[dsh-pet] 宠物配置非法，桌面模式已跳过：${e instanceof Error ? e.message : String(e)}`);
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
   * 桌面窗口能力：由应用注入（`src/app/desktop.ts`）。
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
      ctx.logger?.info?.(`dsh-pet 桌面窗口已就绪：${count} 个`);
    } catch (e) {
      desktopRunning = false;
      ctx.logger?.warn?.(`dsh-pet 桌面窗口创建失败：${e instanceof Error ? e.message : String(e)}`);
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
    ctx.logger?.debug?.(`dsh-pet 桌面窗口关闭（${reason}）`);
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
        ctx.logger?.warn?.(`[dsh-pet] 重建桌面窗口失败：${e instanceof Error ? e.message : String(e)}`);
      });
    return desktopSyncQueue;
  };

  /** 单次业务路由（HTTP 请求与桌面窗口的 scheme 请求共用同一份实现）：
   *  输入只需 rawUrl(/dsh-pet-7340/... + 查询) + method + body 文本；返回 RouteResult(JSON/文本/文件)，
   *  消费方各自落盘——业务逻辑只有一份，设置页 / 桌面窗口 / 第三方脚本看到的完全一致。 */
  const handlePetRoute = async (rawUrl: string, method: string, body?: string): Promise<RouteResult> => {
    const url = new URL(rawUrl, 'http://localhost');
    const rest = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));

    // 成品配置：/dsh-pet-7340/config（GET 读取合并成品 / PUT 保存用户层 / POST 同步内置默认）
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

    // 配置文件路径 + 存储位置清单（设置页「高级配置」与「卸载与存储」展示用）
    if (rest === 'config/meta') {
      return {
        kind: 'json',
        status: 200,
        obj: {
          user: userConfigPath,
          default: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
          animations: thumbUserRoot,
          memes: memesUserRoot,
          // 全部落盘位置（本包用户数据 / Electron 运行时 / 桌面端缓存 / 下载缓存 / 插件本体）：
          // 前两条直接传真实写入方的路径，不在这里重拼目录名
          storage: storageEntries({
            userDataRoot: userRoot,
            electronDir: electronLandingDir(),
            home: homedir(),
            packageRoot: PACKAGE_ROOT,
          }),
          // profile 名（拼卸载命令 dsh plugin --profile <名> remove dsh-pet；反推不出时为空串）
          profile: profileNameFrom(PACKAGE_ROOT) ?? '',
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
        const llm = ctx.llm as
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

    // 轮询统一状态（S）：/dsh-pet-7340/state（GET，no-cache）——前端 1s 轮询的**唯一**数据源
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

    // 余额：/dsh-pet-7340/balance（POST = 立即刷新一次并写入 S，返回 {ok}）
    // 动作端点，**不返回余额数据**——数据只有一个出口（/state），这里只负责"让它刷新"。
    // 改造前这里是 GET（直接查余额）+ /balance/trigger（1s 计数轮询）两个端点，都已删除：
    // 前端不再各自定时查余额（host 定时器统一查，两端共享一份），也不再需要计数轮询中转。
    if (rest === 'balance') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      await refreshBalance(true); // manual：用户主动要的，余额不可用时前端必弹文字说明
      // ok 只表示"这次刷新动作完成了"；余额本身是否可用在 S 的 data 里（ok:false 会弹文字说明气泡）
      return { kind: 'json', status: 200, obj: { ok: true } };
    }

    // 本机任务状态灯：/dsh-pet-7340/work-status（POST）
    // 任何脚本 / IDE 插件 / CI / agent 都能把桌宠当状态灯用：
    //   {"state":"working","text":"跑测试","ttlSec":600}   → 切「干活」并显示自定义文案
    //   {"state":null}                                    → 清空，回到空闲
    // state 的 6 个档位与 animations.events.workStatus 索引一致；text 覆盖档位气泡文案；
    // ttlSec 缺省 900 秒（脚本崩了也不会让宠物永远卡在「干活」），0 = 不自动清。
    // 落到同一个 WorkStatusStore（会话 id = dsh-pet-external），动画与气泡零新增代码。
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

    // 碎碎念：/dsh-pet-7340/whisper?pet=<id>（POST = 立即让桌宠新说一句，返回 {ok}）
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

    // 第三方投喂：/dsh-pet-7340/broadcast?pet=<id>（POST = 把一段**外部给定的**文本写进桌宠气泡）
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

    // 点播动画：/dsh-pet-7340/anim?pet=<id>（POST = 让桌宠播一段指定动画）
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

    // 对话：/dsh-pet-7340/chat?pet=<id>
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

    // 动画文件：/dsh-pet-7340/thumb/<素材根>/<file>，扩展名 webm（默认）/ mov（macOS 定制）。
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
      const fontRoot = join(PACKAGE_ROOT, 'assets', 'fonts');
      const fontFile = resolveExisting(fontRoot, restParts.join('/'));
      if (fontFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: font not found' };
      return { kind: 'file', file: fontFile, contentType: mimeOf(fontFile) };
    }

    // 通知图标：/dsh-pet-7340/pic/<file> → 包内 assets/pic（方形 png，系统通知 icon 用）
    // 表情包：/dsh-pet-7340/pic/memes/<素材根>/<名称>.png → 按素材根走 memeDirsFor 的目录链
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
          return { kind: 'text', status: 400, body: 'dsh-pet: invalid asset root' };
        }
        const rel = (scoped ? segs.slice(1) : segs).join('/');
        let picFile: string | undefined;
        for (const dir of memeDirsFor(assetRoot)) {
          picFile = resolveExisting(dir, rel);
          if (picFile !== undefined) break;
        }
        if (picFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: pic not found' };
        return { kind: 'file', file: picFile, contentType: mimeOf(picFile) };
      }
      const picRoot = join(PACKAGE_ROOT, 'assets', 'pic');
      const picFile = resolveExisting(picRoot, restParts.join('/'));
      if (picFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: pic not found' };
      return { kind: 'file', file: picFile, contentType: mimeOf(picFile) };
    }

    if (scope !== 'thumb') {
      return { kind: 'text', status: 400, body: 'dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>' };
    }
    // thumb 是三段式：/<scope>/<petId>/<file>——从这里再拆宠物 id 与文件名
    const [petId, ...nameParts] = restParts;
    if (!petId || nameParts.length === 0) {
      return { kind: 'text', status: 400, body: 'dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>' };
    }
    // petId 是**标识符**（= pet/<名>-animation/ 的 <名>，来源是 pet/ 下的文件名前缀），不是路径片段：
    // 含分隔符/保留字符即显式 400，早于任何路径拼接判定。合法名（含中文）照常——
    // 用非法字符类而不是 ASCII 白名单。非法输入不再静默回落到主素材池（攻击尝试与"没有独立素材"可区分），
    // 也给下面的 resolveAsset 之外再留一道结构性防线。
    if (ID_FORBIDDEN.test(petId)) {
      return { kind: 'text', status: 400, body: 'dsh-pet: invalid pet id' };
    }
    const fileName = nameParts.join('/');
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    if (ext !== '.webm' && ext !== '.mov') {
      return { kind: 'text', status: 400, body: 'dsh-pet: unsupported animation format (expected .webm or .mov)' };
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
    if (file === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: asset not found' };
    return { kind: 'file', file, contentType: mimeOf(file) };
  };

  /**
   * 本地对话的「会话」标识：应用里没有真实会话，合成的 turn 事件统一挂在这个 id 下
   * （工作状态按会话聚合；与 `src/app/context.ts` 的 LOCAL_SESSION_ID 一致，改一处要改两处）。
   */
  const CHAT_SESSION = { header: { id: 'dsh-pet-local' } };

  /** 把一条合成的会话事件投回总线（宿主同时是生产者与消费者：事件经 ctx.emit 回到上面的监听器） */
  const emitTurn = (type: 'turn/start' | 'turn/end', ok = false, message?: string): void => {
    try {
      ctx.emit?.(
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
      ctx.logger?.warn?.(`[dsh-pet] 投递 ${type} 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * `handlePetRoute` + 一次对话的 turn/start → turn/end。
   *
   * **为什么必须收口在这里**：`/chat` 有两条入口——HTTP（设置页 / 脚本）与桌面窗口的
   * `dsh-pet-bridge://` scheme。从前这一步包在 HTTP 路由**外面**，于是桌面宠物自己发起的对话
   * （也就是用户点宠物聊天的那条路）完全不产生 turn 事件：对话状态联动不切动画、
   * 也不弹「对话完成」通知。两条路都落到 handlePetRoute，包在它外面才覆盖全部入口。
   */
  const handlePetRouteWithTurn = async (rawUrl: string, method: string, body?: string): Promise<RouteResult> => {
    if (method !== 'POST' || !rawUrl.startsWith(`${ROUTE_PREFIX}/chat`)) {
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
    'dsh-pet: /dsh-pet-7340 asset route',
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
          cancelTerminalCleanup(sessionId); // 条目都要清了，别留一个到点后无事可做的定时器
          workStatus.clear(sessionId); // 条目连同任务详情文案一起消失（clear 内部会重算展示）
          publishWorkStatus(); // 回合被打断 → 回到空闲：前端据此收起常驻气泡
        }
        return;
      }
      const seq = Number((event as { seq?: unknown }).seq ?? 0);
      // 同会话同状态不重复更新（防刷屏）；不同状态才改写并重算展示
      if (!workStatus.setState(sessionId, next, seq)) return;
      publishWorkStatus(); // 档位变了 → 写 S（前端据此切动画 + 气泡）
      // 终态只展示短暂窗口后自动清理：陈旧完成态不再浮上来（Bug 3 的一环，顺带缓解 Bug 2 残留）。
      // 回到非终态则取消那次待执行的清理——否则它到点时会话已非终态，既不清也不重排，
      // 条目（连同旧任务文案）就永久留下了。
      if (next === 'success' || next === 'error') scheduleTerminalCleanup(sessionId);
      else cancelTerminalCleanup(sessionId);
    });
    return () => {
      dispose();
      for (const t of terminalTimers.values()) clearTimeout(t);
      terminalTimers.clear();
    };
  }, 'dsh-pet: work-status session events');

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
          scheduleCompletionNotify(sessionIdOf(session), event);
          return;
        }
        const frame = reduceNotifyFrame(event as Parameters<typeof reduceNotifyFrame>[0]);
        if (frame) pushNotifyFrame(frame);
      },
    );
    // agent/error（agent-loop dispatch.emit）：无回合位置的生成失败；0.1.5 新增，
    // 旧版无此事件 = 少一条通知（turn/end error 分支已覆盖大部分失败场景），不报错。
    // **两道门都管不到它**：载荷只有 { turn, step, error }，不带会话标识，无从判定来源。
    const errorDispose = ctx.on(
      'agent/error',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (payload: any) => {
        pushNotifyFrame(agentErrorFrame(payload?.error));
      },
    );
    return () => {
      // 卸载时清掉待查的定时器：否则插件已卸载，到点还去写一次 S
      for (const t of notifyActivityTimers.values()) clearTimeout(t);
      notifyActivityTimers.clear();
      sessionDispose();
      errorDispose();
    };
  }, 'dsh-pet: notify frames');

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
  }, 'dsh-pet: balance poll');

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
  }, 'dsh-pet: whisper poll');

  // 系统通知的宿主监听已在上方注册（notify frames effect）：host 监听 session/event +
  // agent/error 生成通知帧入队，浏览器轮询 /notify 拉取弹 toast（DSH 0.1.5 删除了浏览器侧
  // api.events.mux/host 事件流，通知与宠物一样改走 host 通道，两端行为一致）。

  // 随宿主生命周期清理：销毁全部桌面窗口
  ctx.effect(() => () => {
    disposed = true;
    if (externalClearTimer) {
      clearTimeout(externalClearTimer);
      externalClearTimer = undefined;
    }
    stopDesktop('host-dispose');
  });

  // 路由就绪后把桌面窗口开出来（无桌面能力 / 无可见宠物时静默跳过）
  startDesktop();
}
