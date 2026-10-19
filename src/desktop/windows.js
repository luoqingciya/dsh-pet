/**
 * dsh-petNG 桌面窗口层 —— 透明置顶小窗的创建与维护（**跑在应用主进程里**，不是独立进程）。
 *
 * 历史：这原本是 `src/desktop/main.js`，一个由宿主 spawn 的独立 Electron 进程，
 * 渲染端经 stdout JSON 行协议 + 本地 HTTP 回调把请求转给宿主（bridge）。合并成一个进程后：
 *   - 请求不再过管道：`dsh-pet-ng-bridge://` 的 protocol.handle **直接调宿主注入的处理函数**
 *     （宿主侧就是 handlePetRoute，与 HTTP 路由同一份实现，语义零变化）；
 *   - 「宿主存活探测 / 管道 EPIPE 守卫」整节删除——没有子进程，就没有"宿主没了"这回事；
 *   - 进程级生命周期（单实例、托盘、退出）归 app-main.cjs，本模块只负责**窗口**。
 *
 * 职责：为**每只桌面宠物**开一个独立的局部小窗口（透明、置顶、不可激活），
 * 窗口 = 宠物包围盒 + 四周外扩余量（renderer 的 WINDOW_MARGIN_RATIO，为气泡/弹窗预留空间），
 * 宠物移动时 renderer 逐帧上报 bounds，本模块 setContentBounds 让窗口跟随宠物。
 *
 * 为什么是「局部小窗口」而不是「全屏透明画布」：全屏透明置顶窗会触发 Windows DWM 视频合成黑屏
 * （播放中的视频画面变黑、声音继续）。触发与窗口**绝对尺寸无关**，需四项齐备：透明置顶 + 非点击穿透
 * + 可聚焦且已聚焦 + **完整盖住视频窗**（98% 覆盖即安全；一个仅占屏幕 26% 的小窗同样能触发，issue #60
 * 的单变量实测矩阵）。本模块恰好会凑齐前三项——悬停宠物即整窗翻成可交互、show() 出去的窗口本就是
 * 聚焦的——而全屏画布又把第四项白送（必然完整遮挡非全屏播放的视频），故"不做全屏画布"的结论不变，
 * 只是理由换成这套条件；现有形态靠**默认整窗穿透 + 小窗几乎不可能完整遮挡视频窗**规避。
 *
 * 输入：窗口默认**整窗点击穿透**（setIgnoreMouseEvents(true,{forward:true})），渲染端在光标
 * 进/出宠物身体命中区时经 pet:set-interactive 翻转可交互——透明像素不挡下层应用。
 *
 * 用法（宿主侧见 src/main/desktop.ts）：
 *   prepareRuntime()   —— 必须在 app ready **之前**调用（HW 加速与 force-device-scale-factor 只能那时设）
 *   createDesktop(...) —— ready 之后调用，返回 { start, stop, reload }
 *   require.main === module —— 开发/测试用：不经应用壳，直接起一套窗口（scripts/tests/desktop-macos.test.mjs 用它）
 */
'use strict';

const { app, BrowserWindow, ipcMain, screen, shell, protocol } = require('electron');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const fsPromises = require('node:fs/promises');
// 点击穿透兜底通道的纯判定（不依赖 Electron 的 forward 鼠标钩子；见文件头注释）
const { decideWindowIgnore, pointerZone } = require('./pointer-target.js');
// 置顶看门狗：WS_EX_TOPMOST 只是样式位，不等于窗口真的在置顶带（见 topmost-watchdog.js 头部）
const { TOPMOST_WATCHDOG_TICK_MS, shouldReassertTopmost } = require('./topmost-watchdog.js');
// 全局 DPI 线性化的纯判定与换算（含平台例外：macOS 的 DIP 已是「点」，无需补偿；见该文件头）
const { shouldLinearize, resolveForcedScale, resolvePetScale, resolveUiScale } = require('./dpi-linearization.js');
const { buildDeskGeometry } = require('./desktop-geometry.js');

// 允许无用户手势直接播放（余额动画等）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/** 探测进程的输出标记（父进程按它抓值） */
const DPI_MARK = 'dsh-pet-ng-primary-scale:';

// ---------- 运行前准备（必须在 app ready 之前调用） ----------

/**
 * Windows 透明分层窗口（WS_EX_LAYERED）在 DWM 硬件加速合成下存在多处缺陷：
 *   - 拖拽移动时窗口四周出现黑色边框（#37）
 *   - 大透明窗移动覆盖小透明窗时，被覆盖窗口内容丢失（显示"消失"）
 * 宠物窗口只渲染轻量动画（640×360），改走软件合成以规避上述缺陷。
 *
 * 合并进程后的代价：这个开关是**进程级**的，设置页也会一起失去硬件加速（表单滚动略钝）。
 * 这是合并的既定取舍——宠物窗口的正确性优先，且设置页只在用户打开时存在。
 */
function disableHardwareAccelerationOnWindows() {
  if (process.platform === 'win32') app.disableHardwareAcceleration();
}

/**
 * 全局 DPI 线性化 + 硬件加速：两件事都只能在 app ready 之前做，因此收在一个入口。
 *
 * @param {{probe?: {command: string, args: string[], env?: Record<string,string>}, skipDpi?: boolean}} [options]
 *   probe：探测真实主屏缩放的子进程命令。缺省是「再跑一遍本文件」（独立开发模式）；
 *   合并进应用主进程后由调用方传入 `[<app-main.cjs>, '--dpi-probe']`。
 *   skipDpi：本进程就是探测子进程 —— 只装载模块（scheme 注册等仍要在 ready 前完成），不做线性化。
 * @returns {{forcedScale: number, primaryScale: number, uiScale: number}}
 *   uiScale = 非宠物 UI（设置窗）的补偿倍数：线性化把 DIP 变成物理像素，不补偿的话
 *   940×800 的设置窗在 150% 屏上会缩成 2/3 大小。
 */
function prepareRuntime(options) {
  const opts = options || {};
  if (opts.probe) probeCommand = opts.probe;
  disableHardwareAccelerationOnWindows();
  // 探测子进程：不加 force-device-scale-factor（否则读到的就是被强制的值），也不再 spawn 一个自己
  if (!opts.skipDpi) applyDpiLinearization();
  return {
    forcedScale: FORCED_SCALE,
    primaryScale: PRIMARY_SCALE,
    uiScale: resolveUiScale({ primaryScale: PRIMARY_SCALE, forcedScale: FORCED_SCALE }),
  };
}

// ---------- 全局 DPI 线性化（多显示器异构缩放的根因修复） ----------
//
// Windows 上 Chromium 的 DIP↔物理 换算是**逐显示器**的仿射变换，而且
// ScreenWin::DIPToScreenRect(hwnd, rect) 用的是「hwnd 当前归属屏」的那一组参数：
//   physical = (dip − D.dipOrigin) × D.scale + D.pixelOrigin
// 归属由 MonitorFromWindow(MONITOR_DEFAULTTONEAREST) 按面积占比决定，窗口骑缝时会反复翻转。
// 两屏缩放不同时，同一个 DIP 值在翻转前后落到不同物理位置、算出不同物理尺寸
// （实测 1.5/1.75 双屏：位置差 110px、924 DIP 宽的窗口尺寸差 231px），
// 于是 setContentBounds 每帧的落点在两套坐标系之间横跳 —— 这就是拖过屏缝时的「分身闪烁」，
// 也是两屏缩放一致时同样骑缝却毫无问题的原因。
//
// --force-device-scale-factor 让 Chromium 的 GetMonitorScaleFactors() 对所有显示器
// 直接返回同一个值，全部屏塌缩成**同一个**仿射变换 ⇒ DIPToScreenRect 的结果与窗口归属无关。
//
// 取值必须是 **1**，不能取主屏的 scaleFactor。实测（tools/probe-dpi.cjs，1.5 + 1.75 双屏）：
//   forced=1.5 → display.bounds 被二次缩放（主屏物理 3840 宽报成 1706 = 3840/1.5/1.5，
//                而同一块屏的 workArea 报 2560 = 3840/1.5，两者自相矛盾）。
//                DIPToScreenPoint 用 bounds.origin() 当 dipOrigin，于是
//                pixelOrigin(3840) ≠ dipOrigin(1706)×1.5，副屏多出 1281px 的**恒定**偏移——
//                比不加 switch 时的 75px 还糟。
//   forced=1   → bounds 与 workArea 一致，每块屏都满足 pixelOrigin == dipOrigin×scale，
//                DIP 与物理像素成为恒等映射，探针的 DELTA 全 0（尺寸差 231×151 也一并归零）。
// 所以这里锁死 1：坐标系 = Windows 物理像素，跨屏几何再无换算与舍入。
//
// 代价：宠物尺寸的单位从 DIP 变成物理像素，不补偿的话在 150% 的屏上会小 1/1.5。
// 用探测到的**真实主屏 scaleFactor** 乘进渲染端的 CONFIG.scale 抵掉（见 petScale()）——
// 主屏上的观感与修复前逐像素相同；其余屏改按主屏缩放渲染宠物（同尺寸同分辨率的两块屏上
// 物理大小反而一致了）。探测失败就整个不启用，退回修复前行为，不做没有补偿的缩放。
//
// 环境变量 DSH_PET_FORCE_DSF：'0' = 关闭本机制；其它正数 = 强制该值（排障用，会踩上面的 bug）。
//
// 「要不要启用 / 强制成几 / 渲染端乘几」三条规则已抽到 dpi-linearization.js（纯函数、带单测）——
// 其中包含一个平台例外：上面这套补偿的前提是「force-device-scale-factor 会把 DIP 换算成物理像素」，
// 那是 Windows 的行为，macOS 上不成立。原因与实测数据见该文件头，本文件不再复述。
//
// 取值时机是个麻烦：switch 必须在 app ready 之前设，而那时 screen 模块还不可用。
// 所以首次启动 spawn 一个自己的探测子进程（DSH_PET_DPI_PROBE=1，只打印 scaleFactor 就退出，
// ~0.5s）并把结果落盘；之后每次启动直接读缓存，零开销。

/** 主屏缩放缓存文件（userData 在 ready 前即可用） */
function dpiCacheFile() {
  return path.join(app.getPath('userData'), 'primary-scale.json');
}

function readCachedPrimaryScale() {
  try {
    const v = Number(JSON.parse(readFileSync(dpiCacheFile(), 'utf8')).scaleFactor);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0; // 首次启动/文件损坏：当作无缓存，重新探测
  }
}

function writeCachedPrimaryScale(value) {
  try {
    writeFileSync(dpiCacheFile(), JSON.stringify({ scaleFactor: value }), 'utf8');
  } catch (e) {
    console.error('[dsh-pet-ng-desktop-helper] write dpi cache failed:', String(e && e.message ? e.message : e));
  }
}

/** 从探测子进程的输出里抓 scaleFactor（0 = 没抓到） */
function parseProbeOutput(text) {
  const m = new RegExp(DPI_MARK + '([0-9.]+)').exec(String(text || ''));
  const v = m ? Number(m[1]) : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 探测命令（由 prepareRuntime 注入）。缺省 = 「再跑一遍本文件」，只用于独立开发模式 */
let probeCommand = null;

/** 拉起探测子进程读主屏 scaleFactor（此时本进程还没加 force-device-scale-factor，读到的是真实值） */
function probePrimaryScale() {
  const cmd = probeCommand || { command: process.execPath, args: [__filename] };
  const opts = {
    env: { ...process.env, DSH_PET_DPI_PROBE: '1', ...(cmd.env || {}) },
    timeout: 20000,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  let out;
  try {
    out = execFileSync(cmd.command, cmd.args, opts);
  } catch (e) {
    // 只认 stdout，不认退出码：一个不开窗口的 Electron 进程调 app.exit() 在 Windows 上
    // 偶发 0xC0000005（退出期访问违例），但那时值早就写出来了，丢掉它纯属浪费一次冷启动。
    out = e && e.stdout ? String(e.stdout) : '';
    if (!parseProbeOutput(out)) {
      const detail = [
        e && e.status !== undefined ? 'status=' + e.status : '',
        e && e.stderr ? 'stderr=' + String(e.stderr).trim().slice(0, 300) : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.error(
        '[dsh-pet-ng-desktop-helper] dpi probe failed:',
        String(e && e.message ? e.message : e).split('\n')[0],
        detail,
      );
      return 0; // 探测失败：不加 switch，退回修复前行为（多屏异构 DPI 会闪，但不影响可用性）
    }
  }
  const v = parseProbeOutput(out);
  if (v > 0) writeCachedPrimaryScale(v);
  return v;
}

/** 真实主屏 scaleFactor（探测所得；0 = 未知）。开启线性化后 screen API 只会报 1，只能靠它。 */
let PRIMARY_SCALE = 0;
/** 实际生效的强制缩放（0 = 未启用，坐标系维持修复前的逐屏 DIP） */
let FORCED_SCALE = 0;

/**
 * 决定是否强制 device scale factor。**只能调一次，且必须在 ready 之前**
 * （`app.commandLine.appendSwitch` 在 ready 之后再调无效）。
 */
function applyDpiLinearization() {
  const forceDsf = process.env.DSH_PET_FORCE_DSF;
  if (!shouldLinearize({ platform: process.platform, forceDsf })) return;
  PRIMARY_SCALE = readCachedPrimaryScale() || probePrimaryScale();
  const forced = resolveForcedScale({ forceDsf, primaryScale: PRIMARY_SCALE });
  if (forced > 0) {
    app.commandLine.appendSwitch('force-device-scale-factor', String(forced));
    FORCED_SCALE = forced;
  }
}

/**
 * 渲染端的 CONFIG.scale：宿主给的基准 × 物理像素补偿。
 * 线性化开启后 1 逻辑像素 = 1 物理像素，宠物按主屏缩放放大回原来的观感。
 */
function petScale() {
  return resolvePetScale({
    baseScale: process.env.DSH_PET_SCALE,
    primaryScale: PRIMARY_SCALE,
    forcedScale: FORCED_SCALE,
  });
}

/**
 * 自定义 scheme：standard（可解析 URL）+ secure（按 https 对待）+ supportFetchAPI（fetch 可用）
 * + stream（视频流）+ corsEnabled（让 CORS 规则生效，配合响应里的 ACAO 头放行 file:// 源页面）。
 *
 * 注册**必须**在 ready 之前，且与"这次到底用不用"无关（注册本身不建 scheme，protocol.handle 才建）。
 * 合并进程后请求不再过管道，但保留这个 scheme 有实打实的好处：渲染端页面是 `file://` 源，
 * 直连 HTTP 会撞 CORS 与私有网络访问限制，而走 scheme 是同进程内的一次函数调用。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'dsh-pet-ng-bridge',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
]);

/** 窗口表：petId -> BrowserWindow */
const windows = new Map();

/** win.id -> 上一次**请求**的内容区矩形（"x,y,w,h"）：pet:set-bounds 的去重基准，见那里的注释 */
const lastRequestedBounds = new Map();

/**
 * win.id -> 渲染端上报的窗口余量 `{ l, t }`（DIP）。
 * 上边距按气泡最大高度加高后**余量不再四边相等**，命中区不能再按「窗口宽/4」反推——
 * 这里存下来交给 pointer-target 的 spriteHitRect（见那里的注释）。
 */
const winMargins = new Map();

/**
 * 宠物间碰撞 broker 状态：petId -> { x, y, vx, vy, size, bottomPad }。
 * 来源：pet:set-bounds（位置+尺寸+速度，随漫游/拖拽/静止保真上报，每帧一次）+
 *       pet:report-flight（飞行中每 ~30ms 高频补充速度）。
 * 任何更新都广播全量给所有窗口——每窗飞行方用它做跨窗碰撞检测（滞后 ≤ 1 帧，可接受）。
 */
const petStates = new Map();

/** 把当前全量宠物状态广播给所有窗口（碰撞检测的共享站场） */
function broadcastPetStates() {
  const states = {};
  for (const [pid, s] of petStates) {
    states[pid] = { x: s.x, y: s.y, vx: s.vx, vy: s.vy, size: s.size, bottomPad: s.bottomPad };
  }
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send('pet:flight-states', states);
  }
}

/** 记录/更新一只宠物的状态并广播 */
function updatePetState(petId, partial) {
  const prev = petStates.get(petId) || { x: 0, y: 0, vx: 0, vy: 0, size: 0, bottomPad: 0 };
  petStates.set(petId, Object.assign({}, prev, partial));
  broadcastPetStates();
}

/**
 * 每窗口当前穿透状态（true = 整窗点击穿透）。所有 setIgnoreMouseEvents 只经本文件
 * （创建时初始化 + pet:set-interactive 翻转 + 光标兜底轮询），这里镜像真实状态，供冒烟断言/排查使用
 * （Electron 无 isIgnoringMouseEvents 取值 API）。
 */
const windowIgnore = new Map();

/** 翻转整窗穿透的**唯一出口**：状态与 windowIgnore 镜像永远一起更新（穿透期间保留 forward） */
function setWindowIgnore(win, ignore) {
  win.setIgnoreMouseEvents(ignore, { forward: true });
  windowIgnore.set(win.id, ignore);
}

/** 兜底通道的光标轮询间隔（ms，与 issue #55 报告者实测值一致） */
const POINTER_POLL_MS = 60;
/** 冒烟期间暂停兜底轮询：它按**真实光标**翻转 windowIgnore，会干扰冒烟对渲染端通道的断言 */
let pointerFallbackPaused = false;

/**
 * 每窗口「渲染端正拿着鼠标输入」标记（win.id → true/false），由渲染端经 `pet:input-busy` 上报。
 *
 * 为什么必须由渲染端说了算：兜底通道判定的是"光标与**窗口矩形**"的关系，而窗口矩形比宠物身体大
 * 一圈（四周各半只宠物的余量）。拖拽时宠物由 rAF 弹簧追赶光标、**滞后**于光标；甩得快时滞后量
 * 超过那一圈余量，光标就落在矩形外 → 判成"窗外" → 翻回穿透 → 渲染端正在拖拽的 window 级
 * pointermove/pointerup 全断（鼠标还按着，宠物却按旧速度"飞"出去，连松手都没人报）。
 *
 * 主进程**无法自行判断**这件事（光看光标位置和窗口位移分不清"拖拽跟手"与"漫游/抛掷"），
 * 而渲染端知道（拖拽中 / 菜单开着 / 对话弹窗开着）。所以只由它上报，busy 期间本进程绝不翻回穿透。
 */
const inputBusy = new Map();
/** 新渲染端把菜单/聊天框局部矩形单独上报，避免忙碌态下整窗透明余量吞点击。 */
const inputRegions = new Map();

/** 每窗口「光标停在余量区且非 busy」的连续时长（ms）：到点由兜底通道强制恢复穿透 */
const offBodyMs = new Map();

/**
 * 桌面宠物列表（[{id,size}]）：宿主经 DSH_PET_PETS 透传（每只宠物一个窗口）。
 * 解析失败/未透传（手动 start-desktop）时回落到单个默认宠物窗口；renderer 首帧发来的
 * set-bounds 会按真实配置自校正尺寸与位置。
 */
function petsFromEnv() {
  try {
    const raw = process.env.DSH_PET_PETS || '';
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0) {
      return arr.map((p, i) => ({
        id: String(p?.id ?? `pet-${i}`),
        size: Number(p?.size) > 0 ? Number(p.size) : 462,
        index: i,
      }));
    }
  } catch {
    /* fallthrough */
  }
  return [{ id: 'main', size: 462, index: 0 }];
}

/** 窗口初始尺寸 = 宠物包围盒 + 四周外扩余量（4×0.5×size，与 renderer 的 WINDOW_MARGIN_RATIO 一致；
 *  renderer 首帧 set-bounds 会按真实配置精确覆盖，这里只是避免启动瞬间的尺寸跳变）。 */
function petWindowSize(size) {
  const height = (size * 9) / 16;
  const bottomPad = (size * (9 / 16) * (360 - 330)) / 360;
  const m = Math.round(size * 0.5);
  return { width: Math.round(size) + m * 2, height: Math.round(height + bottomPad) + m * 2 };
}

/**
 * 桌面几何：**逐显示器的工作区列表** + 它们的外接矩形 + 主屏下标。
 *
 * 外接矩形（hull）仍然是渲染端视口 VIEW 的来源——它只用作坐标系原点与比例换算基准。
 * 但所有边界判定（漫游落点 / 抛掷反弹 / 角落定位 / 菜单夹取）必须走 areas 的**并集**：
 * 显示器摆放不规则时 hull 里会有大片不属于任何屏的空洞，以 hull 为边界会把宠物放进去
 * （实测右倒 T 型双屏：hull 的 23.7% 是空洞，宠物飞进去就彻底看不见了）。
 */
function deskGeometry() {
  return buildDeskGeometry(screen.getAllDisplays(), screen.getPrimaryDisplay().id, process.platform);
}

/** 按给定宠物列表与桌面几何建窗（调用方已算好，避免一次 reload 里重复探测显示器） */
function createPetWindows(pets, geo) {
  const area = geo.hull;
  const configUrl = currentConfigUrl;
  const scale = petScale();
  for (const pet of pets) {
    // 初始窗口尺寸也要吃缩放补偿，否则启动瞬间会有一次可见的尺寸跳变
    const { width, height } = petWindowSize(pet.size * scale);
    const win = new BrowserWindow({
      width,
      height,
      x: area.x, // 初始左上角；renderer 首帧按配置角落/位置校正
      y: area.y,
      show: false,
      useContentSize: true,
      // macOS 默认会把已显示窗口的 y 钳到菜单栏下沿；局部画布的透明余量必须允许伸出屏幕。
      enableLargerThanScreen: true,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      // 可聚焦：对话输入框/菜单需要窗口焦点才能打字（focusable:false 会让输入框永远无法聚焦）。
      // 显示时使用 showInactive()，不打断其它应用；用户主动点对话输入框时仍然允许获得焦点。
      focusable: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        paintWhenInitiallyHidden: false,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 窗口被其他窗口（另一只宠物）完全遮挡时，Chromium 默认会暂停本窗口渲染，
    // 导致大宠物移动盖过小宠物时小宠物显示为"消失"。关闭后台节流，让被遮挡
    // 窗口持续渲染，移开遮挡后立刻恢复显示。
    win.webContents.setBackgroundThrottling(false);
    // 屏蔽 Electron 默认右键菜单：右键菜单由渲染端统一自绘组件弹出（两端一致），绝无双菜单
    win.webContents.on('context-menu', (event) => event.preventDefault());
    // 页面级缩放 = petScale()（渲染端 CONFIG.scale 的同一来源）：整窗内容统一放大，渲染端坐标系
    // 回到 CSS 像素——右键菜单/积分弹窗/聊天框等固定 px UI 随之恢复 DIP 观感，不再逐处补偿
    // （见 DESIGN.md §3.5；跨进程交换仍走物理像素，由渲染端 toScreen/toLocal 收口）。
    // webPreferences.zoomFactor 对 show:false 的窗口不生效（实测），须在加载完成后设置。
    win.webContents.on('did-finish-load', () => {
      win.webContents.setZoomFactor(scale);
    });
    // 默认整窗点击穿透（renderer 在光标进/出身体命中区时经 IPC 翻转可交互）；
    // forward:true 保证穿透期间 mousemove 仍转发进渲染端做命中判定。
    setWindowIgnore(win, true);
    win.once('ready-to-show', () => win.showInactive());
    // [#55 兜底显示] paintWhenInitiallyHidden:false 时渲染器可能不产出首帧，ready-to-show 便永不触发
    // （Electron 文档原文：ready-to-show "will never fire if you use paintWhenInitiallyHidden: false"），
    // 而 show() 只挂在它上面 → 窗口永远隐藏（进程活着、宠物逻辑照跑，桌面上什么都没有）。
    // 页面加载完成后强制兜底一次；zoomFactor 的设置在更早注册的 did-finish-load 里，顺序不受影响。
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (!win.isDestroyed() && !win.isVisible()) win.showInactive();
      }, 400);
    });
    // [#55 兜底交互] 上面的翻转链路只有「Electron forward 鼠标钩子 → 渲染端命中判定」一个入口，
    // 该钩子在 Windows 上可能静默失效（回调超时被系统摘掉 / 被别的软件钩子干扰）→ 光标悬浮无反应、
    // 拖不动、点击与右键全废。这里由主进程按**真实光标位置**独立判定，不依赖那条转发链路：
    // 与 renderer 那条通道并存且判定区域一致（状态未变不翻转），转发正常的环境行为完全不变。
    //
    // 唯一不可自行决定的事：**渲染端正拿着鼠标输入时不得翻回穿透**（见 inputBusy）。
    // 本进程无从判断这件事——光看光标位置与窗口位移分不清"拖拽跟手"和"漫游/抛掷"，所以由渲染端上报。
    const pointerTimer = setInterval(() => {
      if (pointerFallbackPaused || win.isDestroyed()) return;
      const b = win.getBounds();
      if (b.width < 8 || b.height < 8) return; // 尺寸还没落定（renderer 首帧上报前）
      const ignoring = windowIgnore.get(win.id) !== false;
      const busy = inputBusy.get(win.id) === true;
      const point = screen.getCursorScreenPoint();
      // 余量区停留计时：只在"非 busy 且在余量区"时累加，离开余量区即清零；busy 期间不累加。
      const mg = winMargins.get(win.id);
      const zone = pointerZone(b, point, mg);
      const nextMs = !busy && zone === 'margin' ? (offBodyMs.get(win.id) ?? 0) + POINTER_POLL_MS : 0;
      offBodyMs.set(win.id, nextMs);
      const next = decideWindowIgnore(b, point, ignoring, busy, nextMs, inputRegions.get(win.id), mg);
      if (next !== ignoring) setWindowIgnore(win, next);
    }, POINTER_POLL_MS);
    // [置顶看门狗] 建窗时那次 setAlwaysOnTop 之后再没人复查过：外部任何一次 z 序扰动都能让桌宠
    // 沉到普通窗下面——而 `WS_EX_TOPMOST` 位还在（点击穿透的读-改-写会把它写回来），于是
    // "是不是置顶"永远查得出 true、宠物却再也看不见，用户侧只能重启 helper 才回来。
    // 这里低频重钉一次：落地就是 SetWindowPos(HWND_TOPMOST, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)，
    // 不移动、不重绘、不抢焦点（判定的纯逻辑与全部依据见 topmost-watchdog.js）。
    let lastTopmostAssertMs = Date.now();
    const topmostTimer = setInterval(() => {
      const nowMs = Date.now();
      const due = shouldReassertTopmost({
        nowMs,
        lastAssertMs: lastTopmostAssertMs,
        destroyed: win.isDestroyed(),
        visible: win.isVisible(),
        paused: pointerFallbackPaused,
      });
      if (!due) return;
      lastTopmostAssertMs = nowMs;
      win.setAlwaysOnTop(true, 'screen-saver');
    }, TOPMOST_WATCHDOG_TICK_MS);
    win.on('closed', () => {
      clearInterval(pointerTimer);
      clearInterval(topmostTimer);
      windows.delete(pet.id);
      lastRequestedBounds.delete(win.id);
      winMargins.delete(win.id);
      windowIgnore.delete(win.id);
      inputBusy.delete(win.id);
      inputRegions.delete(win.id);
      offBodyMs.delete(win.id);
    });
    win
      // **必须用绝对路径**：`loadFile('index.html')` 是相对 **appPath** 解析的。
      // 开发态 appPath = 本脚本所在目录（src/desktop），相对路径恰好能用；
      // 但打包后 Helper 与主进程共用同一个 exe，appPath 变成 `resources/app`，
      // 相对路径就去找 `resources/app/index.html`（不存在）→ ERR_FILE_NOT_FOUND，
      // 窗口创建了却永远不显示（表现为"只有设置页，没有宠物"）。
      .loadFile(path.join(__dirname, 'index.html'), {
        query: {
          configUrl,
          // 有宿主处理函数 = 走 scheme（同进程直调）；独立开发模式没有 → 渲染端直连 HTTP
          bridge: routeRequest ? '1' : '0',
          // 工具项「打开网站」的文案按宿主形态自动变（见 sprite.js）：desktop=唤起桌面应用 / site=打开站点
          scale: String(scale),
          petIndex: String(pet.index),
          workAreaW: String(area.width),
          workAreaH: String(area.height),
          workAreaX: String(area.x),
          workAreaY: String(area.y),
          // 逐屏工作区（屏幕坐标）+ 主屏下标：渲染端所有边界判定走它们的并集，不走外接矩形。
          // 首帧就要用（position() 定角落），所以走 query；运行期变化再经 pet:displays 推送。
          areas: JSON.stringify(geo.areas),
          workAreas: JSON.stringify(geo.workAreas),
          topInsetRatio: String(geo.topInsetRatio),
          // 逐屏完整面板（含任务栏区）：抛掷越界侧探测用（任务栏条带不当墙，见 shared/physics.ts）
          panels: JSON.stringify(geo.panels),
          primaryIndex: String(geo.primaryIndex),
        },
      })
      .catch((error) => {
        console.error(`[dsh-pet-ng-desktop-helper] page load failed (${pet.id}):`, error);
        win.destroy();
      });
    windows.set(pet.id, win);
  }
}

// ---------- bridge（渲染端 custom scheme → 同进程内直接调宿主处理函数） ----------
// 渲染端页面是 `file://` 源，直连 http://127.0.0.1 会撞 CORS 与私有网络访问限制；走自定义 scheme
// 则是同进程内的一次函数调用，零网络、零序列化往返。
//
// 合并进程前这条链是「stdout JSON 行 → 宿主 → 本地 HTTP 回调」，四段跳转全是为了跨进程；
// 现在宿主处理函数就在同一个进程里，`routeRequest` 直接调它，语义完全不变
// （宿主侧注入的就是 handlePetRoute，与 HTTP 路由同一份实现）。
// 素材仍走「宿主回文件绝对路径 → 这里读盘」，二进制不经过 JSON。

/** 宿主注入的请求处理函数（不注入 = 独立开发模式，渲染端直连 HTTP） */
let routeRequest = null;

/** 处理一个渲染端请求：调宿主处理函数 → 组装 Response（素材读盘） */
async function handleBridgeRequest(request) {
  const url = new URL(request.url); // dsh-pet-ng-bridge://dsh-pet-ng/dsh-pet-ng-7340/...
  const method = request.method || 'GET';
  let body;
  if (method === 'POST' || method === 'PUT') {
    body = await request.text();
  }
  const resp = await routeRequest(method, url.pathname + url.search, body);
  const headers = { 'access-control-allow-origin': '*' }; // 渲染端页面是 file:// 源，scheme 跨源需 CORS
  if (resp.contentType) headers['content-type'] = resp.contentType;
  if (resp.file) {
    // 素材：直接读盘返回（宿主已解析好绝对路径）
    try {
      const data = await fsPromises.readFile(resp.file);
      return new Response(new Uint8Array(data), { status: resp.status || 200, headers });
    } catch (e) {
      console.error('[dsh-pet-ng-desktop-helper] bridge file read failed:', resp.file, e);
      return new Response('dsh-petNG: asset read failed', { status: 500, headers });
    }
  }
  return new Response(resp.body ?? '', { status: resp.status || 200, headers });
}

/** 注册 scheme 处理器（只能在 ready 之后调，且每个进程只能注册一次） */
let protocolReady = false;
function ensureProtocol() {
  if (protocolReady || !routeRequest) return;
  protocolReady = true;
  protocol.handle('dsh-pet-ng-bridge', (request) =>
    handleBridgeRequest(request).catch((e) => {
      console.error('[dsh-pet-ng-desktop-helper] bridge handler error:', String(e && e.message ? e.message : e));
      return new Response('dsh-petNG: bridge error', {
        status: 502,
        headers: { 'access-control-allow-origin': '*' },
      });
    }),
  );
}

// ---------- 窗口管理 ----------

/** 当前这批窗口的配置地址（建窗时写进渲染端 query） */
let currentConfigUrl = '';

/** IPC 只在进程内注册一次（多次 reload 不能重复注册，否则一次上报会被处理多遍） */
let ipcInstalled = false;

/** 显示器热更新监听：只装一次，窗口表为空时自然无副作用 */
let displaysInstalled = false;

/** 销毁全部宠物窗口并清空所有 per-window 状态 */
function destroyWindows() {
  for (const win of [...windows.values()]) {
    if (!win.isDestroyed()) win.destroy();
  }
  windows.clear();
  lastRequestedBounds.clear();
  winMargins.clear();
  windowIgnore.clear();
  inputBusy.clear();
  inputRegions.clear();
  offBodyMs.clear();
  petStates.clear();
}

/**
 * 归一化宿主给的宠物列表：补上窗口序号（渲染端用它区分多只宠物的 query 与缓存键）
 * 并把非法尺寸挡在窗口尺寸计算之前。
 */
function normalizePets(pets) {
  if (!Array.isArray(pets)) return [];
  return pets
    .filter((p) => p && p.id !== undefined && p.id !== null && String(p.id) !== '')
    .map((p, i) => ({
      id: String(p.id),
      size: Number(p.size) > 0 ? Number(p.size) : 462,
      index: Number.isInteger(p.index) ? p.index : i,
    }));
}

/** 按最新配置重建全部窗口（配置变更 / 显示器变化 / 重载） */
function rebuildWindows(input) {
  destroyWindows();
  const pets = normalizePets(input);
  if (pets.length === 0) return 0;
  const geo = deskGeometry();
  console.error(
    '[dsh-pet-ng-desktop-helper] displays: ' +
      JSON.stringify(geo) +
      ' forcedScaleFactor=' +
      (FORCED_SCALE || 'off') +
      ' primaryScale=' +
      (PRIMARY_SCALE || 'unknown') +
      ' petScale=' +
      petScale(),
  );
  createPetWindows(pets, geo);
  return windows.size;
}

/**
 * 建桌面窗口层。
 *
 * @param {{request?: (method: string, url: string, body?: string) => Promise<{status:number, contentType?:string, body?:string, file?:string}>,
 *          configUrl?: string}} [options]
 * @returns {{start: (pets: Array<{id:string,size:number}>|undefined) => number,
 *            stop: () => void,
 *            reload: (pets: Array<{id:string,size:number}>) => number,
 *            windows: Map<string, import('electron').BrowserWindow>,
 *            dpi: {forcedScale: number, primaryScale: number, uiScale: number}}}
 */
function createDesktop(options) {
  const opts = options || {};
  if (opts.request) routeRequest = opts.request;
  if (opts.configUrl) currentConfigUrl = opts.configUrl;
  if (!currentConfigUrl) {
    currentConfigUrl = process.env.DSH_PET_CONFIG_URL || 'http://127.0.0.1:7340/dsh-pet-ng-7340/config';
  }
  installIpc();
  installDisplayWatcher();
  return {
    start(pets) {
      ensureProtocol();
      return rebuildWindows(pets);
    },
    stop() {
      destroyWindows();
    },
    reload(pets) {
      return rebuildWindows(pets);
    },
    windows,
    dpi: {
      forcedScale: FORCED_SCALE,
      primaryScale: PRIMARY_SCALE,
      uiScale: resolveUiScale({ primaryScale: PRIMARY_SCALE, forcedScale: FORCED_SCALE }),
    },
  };
}

/** 装全部渲染端 IPC（幂等） */
function installIpc() {
  if (ipcInstalled) return;
  ipcInstalled = true;

  // 宠物窗口跟随：renderer 逐帧上报窗口内容区位置/尺寸
  ipcMain.on('pet:set-bounds', (event, bounds) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const x = Number(bounds?.x);
    const y = Number(bounds?.y);
    const width = Number(bounds?.width);
    const height = Number(bounds?.height);
    if (![x, y, width, height].every(Number.isFinite)) return;
    // 去重必须比较**我们上一次请求的值**，绝不能拿 win.getContentBounds() 回读值来比：
    // 跨缩放屏的 DIP↔物理 往返有 ScaleToEnclosingRect（向外取整）与 origin 舍入，
    // 读回值与设定值永远不相等，去重永远不生效，反而变成每帧强制重设窗口位置。
    const rect = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    const key = rect.x + ',' + rect.y + ',' + rect.width + ',' + rect.height;
    if (lastRequestedBounds.get(win.id) !== key) {
      lastRequestedBounds.set(win.id, key);
      win.setContentBounds(rect, false);
    }
    // 窗口余量（左右/上）：命中区判定的依据，余量四边不再相等（上边距按气泡最大高度加高）
    const ml = Number(bounds?.marginL);
    const mt = Number(bounds?.marginT);
    if (Number.isFinite(ml) && Number.isFinite(mt)) winMargins.set(win.id, { l: ml, t: mt });
    // 碰撞站场：位置必须用**包围盒左上角**（renderer 显式上报 boxX/boxY）——
    // 窗口坐标 = 包围盒 − margin（半只宠物宽），直接拿窗口坐标会让跨窗检测整体错位
    const petId = [...windows.keys()].find((id) => windows.get(id) === win);
    if (petId) {
      const bx = Number(bounds?.boxX);
      const by = Number(bounds?.boxY);
      const size = Number(bounds?.size);
      const bottomPad = Number(bounds?.bottomPad);
      const vx = Number(bounds?.vx);
      const vy = Number(bounds?.vy);
      // 位置 + 尺寸 + 速度一并登记：set-bounds 是每次位置变化都会触发的全量上报
      // （此前只更新 x/y，静止宠物 size 永远为 0，跨窗碰撞检测 `!o.size` 直接跳过它）；
      // 速度取渲染端上报值（飞行中实时、静止/拖拽 = 0），落地后不再残留旧飞行速度。
      updatePetState(petId, {
        x: Number.isFinite(bx) ? bx : x,
        y: Number.isFinite(by) ? by : y,
        size: Number.isFinite(size) && size > 0 ? size : petStates.get(petId)?.size || 0,
        bottomPad: Number.isFinite(bottomPad) && bottomPad > 0 ? bottomPad : petStates.get(petId)?.bottomPad || 0,
        vx: Number.isFinite(vx) ? vx : 0,
        vy: Number.isFinite(vy) ? vy : 0,
      });
    }
  });

  // 飞行状态上报（碰撞站场）：renderer 飞行中每 ~30ms 上报一次自己的位置/速度/尺寸
  ipcMain.on('pet:report-flight', (event, state) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const petId = [...windows.keys()].find((id) => windows.get(id) === win);
    if (!petId) return;
    const s = state || {};
    const x = Number(s.x);
    const y = Number(s.y);
    const vx = Number(s.vx);
    const vy = Number(s.vy);
    const size = Number(s.size);
    const bottomPad = Number(s.bottomPad);
    if (![x, y, vx, vy, size, bottomPad].every(Number.isFinite)) return;
    updatePetState(petId, { x, y, vx, vy, size, bottomPad });
  });

  // 碰撞结果转发：飞行方窗口检测到撞到 targetId → 把动量结果（目标新初速）转发给目标窗口
  ipcMain.on('pet:collide-result', (event, payload) => {
    const targetId = payload && typeof payload === 'object' ? String(payload.targetId || '') : '';
    const vx = Number(payload?.vx);
    const vy = Number(payload?.vy);
    if (!targetId || !Number.isFinite(vx) || !Number.isFinite(vy)) return;
    const targetWin = windows.get(targetId);
    if (targetWin && !targetWin.isDestroyed()) {
      targetWin.webContents.send('pet:hit', { vx, vy });
    }
  });

  // 点击穿透翻转：renderer 在光标进/出身体命中区时上报；穿透期间仍保留 forward（mousemove 继续转发）。
  // 兜底轮询（见 createPetWindows）也走同一个出口 setWindowIgnore，两条通道共享同一份镜像状态。
  ipcMain.on('pet:set-interactive', (event, interactive) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const input = inputRegions.get(win.id);
    // 渲染端的旧 menuOpen/chatOpen 守卫会请求整窗可交互；这里按真实光标和控件矩形裁定。
    const ignoring =
      interactive && input && inputBusy.get(win.id)
        ? decideWindowIgnore(
            win.getContentBounds(),
            screen.getCursorScreenPoint(),
            false,
            true,
            0,
            input,
            winMargins.get(win.id),
          )
        : !interactive;
    setWindowIgnore(win, ignoring);
  });

  // 拖拽持有完整输入租约；菜单/对话则由 inputRegions 把交互限制在实际控件矩形内。
  // 只存标记、不直接翻转窗口——**唯一出口**仍是 setWindowIgnore（在兜底轮询里按完整规则判定），
  // 否则会出现"两条通道抢着翻同一个窗口"的竞态。
  ipcMain.on('pet:input-busy', (event, busy) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    inputBusy.set(win.id, !!busy);
  });

  ipcMain.on('pet:input-regions', (event, input) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || !input || !Array.isArray(input.rects)) return;
    const rects = input.rects.filter(
      (r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0,
    );
    inputRegions.set(win.id, { dragging: input.dragging === true, rects });
  });

  // 右键菜单「打开网站」：交给**系统默认浏览器**打开（等效于网页里 Ctrl+点击链接新标签页），
  // 不建专属窗口——宠物窗口机制是透明小窗，不该承载常规网页浏览。URL 由渲染端从
  // 打开设置页：地址由宿主经 query 注入（ORIGIN = 本地服务 origin，端口变了自动跟随），
  // 这里只负责交给系统默认浏览器。
  const openSite = (url) => {
    shell.openExternal(url).catch((error) => {
      console.error('[dsh-pet-ng-desktop-helper] openExternal failed:', error);
    });
  };

  // 右键「打开设置」：系统默认浏览器打开本地服务的设置页（同源，直接可用）。
  ipcMain.on('pet:open-site', (event, payload) => {
    const url = payload && typeof payload === 'object' ? String(payload.url || '') : '';
    if (!/^https?:[/][/]/.test(url)) return;
    openSite(url);
  });
}

/**
 * 显示器热更新：分辨率/缩放变化、插拔屏、旋转都会让桌面几何失效。几何在建窗时经 URL query 注入，
 * 渲染端 VIEW 是模块顶层常量，运行期永不更新——表现为「改了分辨率后可移动范围还是旧的」。
 * 这里重算并推给所有窗口，渲染端就地重挂。
 */
function installDisplayWatcher() {
  if (displaysInstalled) return;
  displaysInstalled = true;

  let displaysTimer = null;
  const pushDisplays = () => {
    const geo = deskGeometry();
    lastRequestedBounds.clear(); // 坐标系变了，去重缓存作废，下一帧必须真的重设一次
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send('pet:displays', geo);
    }
    console.error('[dsh-pet-ng-desktop-helper] displays changed: ' + JSON.stringify(geo));
    // 主屏缩放可能一起变了（它决定宠物的尺寸补偿）。线性化生效期间 screen API 只报被强制的值，
    // 真实值只能靠探测子进程拿；不一致就刷新缓存，下次启动自动用上。
    if (FORCED_SCALE > 0) {
      setTimeout(() => {
        const real = probePrimaryScale();
        if (real > 0 && Math.abs(real - PRIMARY_SCALE) > 1e-6) {
          console.error(
            '[dsh-pet-ng-desktop-helper] primary scaleFactor changed ' +
              PRIMARY_SCALE +
              ' -> ' +
              real +
              '; restart the desktop pet to resize',
          );
        }
      }, 1000).unref?.();
    }
  };
  /** 显示器事件会连发（一次改动能来好几条），去抖后只重算一次 */
  const scheduleDisplays = () => {
    if (displaysTimer) clearTimeout(displaysTimer);
    displaysTimer = setTimeout(() => {
      displaysTimer = null;
      pushDisplays();
    }, 300);
  };
  screen.on('display-metrics-changed', scheduleDisplays);
  screen.on('display-added', scheduleDisplays);
  screen.on('display-removed', scheduleDisplays);
}

/**
 * 探测子进程的收尾：把主屏 scaleFactor 打到 stdout 就退出（ready 之后调）。
 * 退出推迟一拍——在 ready 回调里直接 app.exit() 会赶在 stdout 落盘前拆掉进程。
 */
function reportPrimaryScale() {
  process.stdout.write(DPI_MARK + screen.getPrimaryDisplay().scaleFactor + '\n');
  setTimeout(() => app.exit(0), 0);
}

// ---------- 独立开发/测试入口（不经应用壳，直接起一套窗口） ----------

/**
 * 只在 `node src/desktop/windows.js`（由 Electron 执行）时走这里：
 * 从环境变量读宠物列表与配置地址，不注册 bridge（渲染端直连 HTTP）。
 * 用途：对着 mock 服务的 macOS 桌面几何测试（scripts/tests/desktop-macos.test.mjs）、
 * 以及开发时单独调窗口层。
 */
function runStandalone() {
  // 显式定名：被 `electron.exe <本文件>` 直接拉起时，Electron 取不到 app 名会回落成 "Electron"，
  // userData 便落到 %APPDATA%\Electron —— 那是所有这么跑的 Electron 脚本的公共目录。
  // 必须赶在任何 getPath('userData') 之前设。
  app.setName('dsh-pet-ng-electron-helper');

  // 探测子进程：不建窗口，只把主屏 scaleFactor 打到 stdout 就退出。
  // 退出推迟一拍——在 ready 回调里直接 app.exit() 会赶在 stdout 落盘前拆掉进程。
  if (process.env.DSH_PET_DPI_PROBE === '1') {
    app.whenReady().then(() => {
      process.stdout.write(DPI_MARK + screen.getPrimaryDisplay().scaleFactor + '\n');
      setTimeout(() => app.exit(0), 0);
    });
    return;
  }

  prepareRuntime();
  const desktop = createDesktop();
  app.whenReady().then(() => {
    desktop.start(petsFromEnv());
    // 独立模式没有应用壳兜底：窗口全关就退出，不留一个空转进程
    app.on('window-all-closed', () => app.quit());
  });
}

/**
 * 托盘菜单（自绘窗口）。
 *
 * 为什么不用 `Tray.setContextMenu`：Windows 上那是**原生控件**，字号由系统/进程 DPI 决定；
 * 而本应用为了让宠物像素级对齐强制了 `force-device-scale-factor=1` —— 原生菜单不跟这套补偿，
 * 150% 屏上只有 2/3 大，而且 `MenuItem` 没有任何字号/内边距可调（实测主屏 scaleFactor=1.5）。
 *
 * 所以改成"无边框透明小窗 + 同一套 DOM 菜单"：菜单渲染复用 `S.mountContextMenu`（与宠物右键
 * 菜单完全同一个组件、同一套样式），窗口尺寸与 zoomFactor 按 `uiScale` 补偿 —— 与设置窗同一套
 * 做法。窗口只在弹出时存在（第一次右键才建），失焦即隐藏。
 *
 * @param {{onAction?: (action: string) => void}} [options] 菜单项被点击时的回调（action 由调用方解释）
 * @returns {{show: (items: Array<object>) => void, hide: () => void, destroy: () => void}}
 */
/** 托盘菜单的 IPC 只能注册一次（模块级，跨 createTrayMenu 调用共享） */
let trayMenuIpcInstalled = false;

function createTrayMenu(options = {}) {
  const onAction = typeof options.onAction === 'function' ? options.onAction : () => {};
  const scaleOf = () => resolveUiScale({ primaryScale: PRIMARY_SCALE, forcedScale: FORCED_SCALE }) || 1;

  let win = null;
  /** 弹出时的光标位置：收到真实尺寸后按它重新摆（估算尺寸先占位） */
  let anchor = null;
  /** 上一次的菜单尺寸（CSS 像素）；下次弹出先用它，避免闪一下再收缩 */
  let size = { width: 220, height: 240 };
  /** 本次弹出的时刻：用来区分"刚弹出的激活抖动"和"用户真的点了别处" */
  let shownAt = 0;
  /** 弹出后这段时间内的 blur 一律忽略（实测抖动在 10ms 内，给 400ms 足够宽松） */
  const BLUR_GRACE_MS = 400;

  const toPhysical = (v) => Math.round(v * scaleOf());

  /** 按锚点摆窗口：菜单左下角贴光标（托盘在屏幕底部），越界夹回当前屏工作区 */
  function place() {
    if (!win || win.isDestroyed() || !anchor) return;
    const width = toPhysical(size.width);
    const height = toPhysical(size.height);
    const area = screen.getDisplayNearestPoint(anchor).workArea;
    const x = Math.min(Math.max(anchor.x - width + toPhysical(12), area.x), area.x + area.width - width);
    const y = Math.min(Math.max(anchor.y - height, area.y), area.y + area.height - height);
    win.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: toPhysical(size.width),
      height: toPhysical(size.height),
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // 与设置窗同样的补偿：窗口尺寸与页面缩放同时乘 uiScale，菜单在 150% 屏上才是正常大小
        zoomFactor: scaleOf(),
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'tray-menu.html'));
    /**
     * 失焦 = 用户点了别处：与原生菜单一致，直接收起。
     *
     * 但**刚弹出的那一下不算**：右键点在托盘图标上，输入事件属于任务栏/通知区域，
     * 我们这边 show + focus 之后，shell 往往紧接着把激活状态收回去 —— 实测 show→focus→
     * **9ms 后 blur**，菜单刚出来就消失（用户报障："弹出菜单，但又立刻消失"）。
     * 所以弹出后一小段时间内的 blur 一律当激活抖动忽略，见 show() 里的 shownAt。
     */
    win.on('blur', () => {
      if (Date.now() - shownAt < BLUR_GRACE_MS) {
        // 抖动：把焦点要回来。只是"忽略"不够——窗口会停在失焦态，之后点别处也不会再有 blur，
        // 菜单就成了看得见却关不掉的幽灵（下面 show() 里的兜底会把它收掉，但那就又"消失"了）。
        if (!win.isDestroyed()) win.focus();
        return;
      }
      hide();
    });
    win.on('closed', () => {
      win = null;
    });
    return win;
  }

  function hide() {
    if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  }

  function show(items) {
    const target = ensureWindow();
    anchor = screen.getCursorScreenPoint();
    place();
    const push = () => {
      if (!win || win.isDestroyed()) return;
      win.webContents.send('pet:tray-menu', { items: Array.isArray(items) ? items : [] });
    };
    if (target.webContents.isLoading()) target.webContents.once('did-finish-load', push);
    else push();
    shownAt = Date.now();
    target.show();
    /**
     * 焦点要**等右键那一串窗口激活结束再要**。
     *
     * 立刻 focus 会被任务栏抢回去（实测 show → focus → 9ms 后 blur，窗口随即被 blur 处理器收起）。
     * 延迟一拍再要，shell 那边已经处理完这次点击，焦点才留得住；万一还是没留住，
     * 上面 blur 处理器里的宽限期会兜住，菜单至少不会刚出来就没。
     */
    setTimeout(() => {
      if (win && !win.isDestroyed() && win.isVisible() && !win.isFocused()) win.focus();
    }, 120);
    // 兜底：宽限期过了还没拿到焦点，说明这个菜单既关不掉（没有 blur 可等）也没法用键盘，
    // 留着只会变成"点别处也不消失"的幽灵菜单——直接收起。
    setTimeout(() => {
      if (win && !win.isDestroyed() && win.isVisible() && !win.isFocused()) hide();
    }, BLUR_GRACE_MS + 200);
  }

  function destroy() {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  // IPC 只注册一次（createTrayMenu 可能被调用多次：托盘重建）
  if (!trayMenuIpcInstalled) {
    trayMenuIpcInstalled = true;
    const ownerOf = (event) => (win && !win.isDestroyed() && event.sender === win.webContents ? win : null);
    ipcMain.on('pet:tray-size', (event, payload) => {
      if (!ownerOf(event)) return;
      const width = Number(payload && payload.width);
      const height = Number(payload && payload.height);
      if (!(width > 0 && height > 0)) return;
      // 兜底夹取：菜单项异常多时不至于铺满屏幕
      size = { width: Math.min(Math.max(width, 120), 560), height: Math.min(Math.max(height, 60), 760) };
      place();
    });
    ipcMain.on('pet:tray-close', (event) => {
      if (ownerOf(event)) hide();
    });
    ipcMain.on('pet:tray-action', (event, payload) => {
      if (!ownerOf(event)) return;
      hide();
      const action = payload && typeof payload === 'object' ? String(payload.action || '') : '';
      if (action) onAction(action);
    });
  }

  return { show, hide, destroy };
}

module.exports = {
  prepareRuntime,
  createTrayMenu,
  createDesktop,
  petScale,
  reportPrimaryScale,
};

if (require.main === module) runStandalone();
