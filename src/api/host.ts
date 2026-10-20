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
import { generateWhisper } from '../core/whisper';
import { generateChat } from '../core/chat';
import {
  balancePeriodSec,
  findPetInstance,
  flattenPetList,
  migrateUserConfig,
  readAllConfig,
  whisperPeriodSec,
  type ConfigPaths,
} from '../core/config';
import { pick } from '../shared/pickers';
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
import { createDesktopControl } from '../core/desktop-control';
import { createPetServices } from '../core/pet-services';
import { createBalanceService } from '../core/balance-service';
import { createNotifyPipeline, type Waterfall } from '../core/notify-pipeline';
import { PollStateStore } from '../core/state';
import { readBody, sendFile, sendJson, sendText } from '../core/http';
import type { DesktopRequest, DesktopResponse, PetDesktop } from '../core/desktop-api';
import { createPetRouter } from './router';
import { DEFAULT_COMPANION_CONFIG, normalizeCompanionConfig, step } from '../core/companion';
import { readCompanionMemory, writeCompanionMemory } from '../core/companion-memory';

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

  // 碎碎念与对话：前处理（人设/配图/模型）与落点（S 的 pets.<id>.say）完全一致，
  // 收在 core/pet-services；生成能力在这里绑定 ctx 后注入，core 不认识 ctx。
  const petServices = createPetServices({
    configPaths,
    state,
    memory,
    memeDirsFor,
    whisper: (system, meme, model, now) => generateWhisper(ctx, system, meme, model, now),
    chat: (system, list, text, pool, model) => generateChat(ctx, system, list, text, pool, model),
  });
  const publishWhisper = petServices.publishWhisper;
  const chatWithPet = petServices.chatWithPet;

  const effectivePetList = (): Record<string, unknown>[] => flattenPetList(readAllConfig(configPaths));

  /** 余额刷新周期（秒）：成品 main 条目的 eventsRefreshSec.balance（合并器已填默认；非法兜底 1800） */
  // 余额：宿主侧唯一的查询点，实现在 core/balance-service（服务商与凭证由这里绑定 ctx 后注入）
  const balance = createBalanceService({
    state,
    currentProvider: () => ctx.agentDefaultModel.currentSelection().provider,
    balanceProvider: (ctx as { petBalanceProvider?: () => string }).petBalanceProvider,
    resolveCredential: async (ref) => (await ctx.credentials.resolve(ref))?.value,
  });
  const refreshBalance = balance.refresh;

  const resolveActivePetId = (): string => {
    try {
      const eff = effectivePetList();
      return eff.length === 0 ? '' : String(eff[0].id);
    } catch {
      return '';
    }
  };

  // 桌面窗口生命周期（refresh / start / stop / sync）收在 core/desktop-control。
  // 与路由层是双向依赖：这里传 handleRequest 进去，路由那边把 sync 传回来——两边都用延迟回调解开。
  /** 渲染端请求 → 路由结果：与 HTTP 路由同一份实现，只是把 RouteResult 翻成 DesktopResponse */
  const desktopRequest = async (req: DesktopRequest): Promise<DesktopResponse> => {
    const result = await handlePetRouteWithTurn(req.url, req.method, req.body);
    if (result.kind === 'file') {
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

  const desktopControl = createDesktopControl({
    desktop: ctx.petDesktop as PetDesktop | undefined,
    resolvePort: () => (typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : 0),
    routePrefix: ROUTE_PREFIX,
    handleRequest: desktopRequest,
    listPets: effectivePetList,
    logger: ctx.logger,
  });
  const startDesktop = desktopControl.start;
  const syncDesktop = desktopControl.sync;

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

  // 主动陪伴（P0：**只做动作，不说话**）：每 30s 问一次决策器"现在该不该动"。
  //
  // 分工：`core/companion` 是纯决策（什么情况必须闭嘴，有矩阵单测）；这里只做三件事——
  // 采集信号、执行（写 S 的 pets.<id>.anim）、把计数落盘。
  // 动作用的通道与右键菜单点播动画**完全同一条**：渲染端收到 anim 叶子后，
  // 若是 moves 池的动画就走 `tryMove()`（真实位移，边界/朝向/首尾静止段全复用），
  // 所以这里不需要碰驱动状态机，也不会和漫游/拖拽抢位置（drive 被占时 tryMove 会自己让位）。
  //
  // 信号里唯一来自平台的是"系统空闲秒数"（powerMonitor，见 main/index.ts 注入）。
  ctx.effect(() => {
    const memFile = join(userRoot, 'companion.json');
    let memory = readCompanionMemory(memFile);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const TICK_MS = 30_000;

    /** 系统空闲秒数；宿主没注入（非 Electron 环境）= 0，即"视为一直在用" */
    const idleSec = (): number => {
      const fn = (ctx as { systemIdleSec?: () => number }).systemIdleSec;
      if (typeof fn !== 'function') return 0;
      const n = Number(fn());
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };

    /** 给某只宠物播一段"走动"：优先 moves 池（真的会走），没有就退回 idle 池（原地动作） */
    const playMove = (petId: string): void => {
      const cfg = readAllConfig(configPaths);
      const found = findPetInstance(cfg, petId);
      const anims = (found?.conf?.animations ?? {}) as {
        moves?: { actions?: Array<{ name?: unknown }> };
        idle?: unknown;
      };
      const walk = (anims.moves?.actions ?? []).map((a) => String(a?.name ?? '')).filter(Boolean);
      const idlePool = Array.isArray(anims.idle) ? anims.idle.map((n) => String(n)) : [];
      const pool = walk.length ? walk : idlePool;
      if (!pool.length) return; // 配置残缺（没有可播动作）：这一拍什么都不做
      state.writePet(petId, 'anim', { name: pick(pool) });
    };

    const tick = (): void => {
      if (disposed) return;
      try {
        const cfg = readAllConfig(configPaths);
        const conf = normalizeCompanionConfig(cfg.main?.companion) ?? DEFAULT_COMPANION_CONFIG;
        if (conf.enabled) {
          const now = Date.now();
          const d = new Date(now);
          const dayKey =
            d.getFullYear() +
            '-' +
            String(d.getMonth() + 1).padStart(2, '0') +
            '-' +
            String(d.getDate()).padStart(2, '0');
          const { decision, memory: next } = step(
            { now, hour: d.getHours() + d.getMinutes() / 60, dayKey, idleSec: idleSec() },
            memory,
            conf,
          );
          // 只在真的变了才落盘（"人不在"那几拍会反复返回同一份状态）
          const changed =
            next.lastActAt !== memory.lastActAt ||
            next.dayKey !== memory.dayKey ||
            next.dayCount !== memory.dayCount ||
            next.awaySince !== memory.awaySince;
          if (changed) {
            memory = next;
            writeCompanionMemory(memFile, memory);
          }
          if (decision.act === 'move') {
            const pet = effectivePetList().find((p) => p.display !== 'none');
            const petId = String(pet?.id ?? '');
            if (petId) playMove(petId);
          }
        }
      } catch {
        // 读配置失败等：跳过这一拍，别让定时器链断掉（下一拍再试）
      }
      timer = setTimeout(tick, TICK_MS);
    };
    timer = setTimeout(tick, TICK_MS);
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, 'dsh-petNG: companion poll');

  // 系统通知的宿主监听已在上方注册（notify frames effect）：host 监听 session/event +
  // agent/error 生成通知帧入队，浏览器轮询 /notify 拉取弹 toast（DSH 0.1.5 删除了浏览器侧
  // api.events.mux/host 事件流，通知与宠物一样改走 host 通道，两端行为一致）。

  // 随宿主生命周期清理：销毁全部桌面窗口
  ctx.effect(() => () => {
    workStatusPublisher.dispose();
    desktopControl.dispose();
  });

  // 路由就绪后把桌面窗口开出来（无桌面能力 / 无可见宠物时静默跳过）
  startDesktop();
}
