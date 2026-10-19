// @ts-check
/**
 * dsh-petNG desktop helper —— 基础设施（常量 + 全局状态 + 调试钩子）。
 *
 * 经典 script 全局共享（经 index.html 顺序加载，先于 sprite.js / events.js / renderer.js）；
 * 顶层 const/let/function 都进全局词法环境，后续文件可直接引用。
 */
'use strict';

const S = window.PetShared;

const params = new URLSearchParams(location.search);
const CONFIG = {
  configUrl: params.get('configUrl') || 'http://127.0.0.1:7340/dsh-pet-ng-7340/config',
  scale: Number(params.get('scale') || '1'),
  petIndex: Number(params.get('petIndex') || '0'),
  topInsetRatio: Number(params.get('topInsetRatio') || '0'),
};

// ---------- 渲染端坐标系统一约定（DESIGN.md §3.5） ----------
// main 进程对窗口做页面级缩放 setZoomFactor(CONFIG.scale) 后，本窗口的 DOM 度量、事件坐标、
// 桌面几何（VIEW/AREAS/PRIMARY_AREA）与全部 shared 组件（右键菜单/积分弹窗/聊天框）都在
// **同一套 CSS 像素**里——固定 px UI 随缩放自动恢复 DIP 观感，组件代码零换算。
// 主进程侧（窗口 bounds、逐屏几何、碰撞 broker）仍是物理像素：与它交换的值只允许在下面两个
// 收口换算（×scale 发出去 / ÷scale 收进来），任何组件代码不得再乘除（防散修回归）。
/** 本地（CSS）→ 屏幕（物理）：只在发给主进程时用，见上面的收口约定
 * @param {number} v
 * @returns {number} */
function toScreen(v) {
  return v * CONFIG.scale;
}
/** 屏幕（物理）→ 本地（CSS）：只在收主进程数据时用
 * @param {number} v
 * @returns {number} */
function toLocal(v) {
  return v / CONFIG.scale;
}
// bridge 模式（主进程在建窗时写进 query 的 bridge=1）：请求走自定义 scheme，由主进程的
// protocol.handle 直接调宿主路由。页面是 file:// 源，直连 HTTP 会撞 CORS 与私有网络访问限制。
const BRIDGE = params.get('bridge') === '1';
// 视口 = 全部显示器工作区的外接矩形（多显示器时即整个桌面；窗口只是宠物的一块局部画布）。
// 它只是**坐标系原点与比例换算基准**：位置比例（customPos）、漫游 ratio 都按它算。
// x/y = 外接矩形左上角（多显示器时原点非 0）——visibleClampRect 计算「窗口 ∩ 工作区」需要它；
// 缺省 0（单显示器原点即 0）。注意：缺失会令夹取矩形变 NaN，菜单将飞到窗口左上角（#41 回归）。
//
// **边界判定一律不用它**，改用下面 AREAS 的并集：显示器摆放不规则时外接矩形里有大片空洞
// （实测右倒 T 型双屏 23.7% 的面积不属于任何屏），拿它当边界会让宠物走进/飞进不可见区域。
// 字段可变：显示器分辨率/缩放变化、插拔屏、旋转时由 applyDeskGeometry 就地重挂（#P4）。
// 主进程下发的视口（**物理像素**，原样保留给首帧 applyDeskGeometry）；VIEW 才是 ÷scale 后的 CSS 系
const VIEW_SCREEN = {
  x: Number(params.get('workAreaX') || 0),
  y: Number(params.get('workAreaY') || 0),
  w: Number(params.get('workAreaW') || (window.screen && window.screen.availWidth) || 1920),
  h: Number(params.get('workAreaH') || (window.screen && window.screen.availHeight) || 1080),
};
const VIEW = {
  x: toLocal(VIEW_SCREEN.x),
  y: toLocal(VIEW_SCREEN.y),
  w: toLocal(VIEW_SCREEN.w),
  h: toLocal(VIEW_SCREEN.h),
};
/** 逐显示器工作区，**视口相对坐标**（= 屏幕坐标 − VIEW 原点）。抛掷/漫游/菜单夹取都走它们的并集
 *  @type {DshRect[]} */
let AREAS = [];
/** 菜单/聊天框/提示仍限制在工作区，不能随宠物进入菜单栏或 Dock。
 *  @type {DshRect[]} */
let WORK_AREAS = [];
/** 逐显示器**完整面板**（含任务栏区，视口相对坐标，与 AREAS 同序）：抛掷「越界侧有没有邻屏」
 *  的探测用它——任务栏在接缝处挖出的工作区条带不当墙（见 shared/physics.ts）
 *  @type {DshRect[]} */
let PANELS = [];
/** 主屏工作区（视口相对坐标）：角落定位与「回到初始位置」用它——外接矩形的角落可能落在空洞里
 *  @type {DshRect | null} */
let PRIMARY_AREA = null;

/** 把主进程给的桌面几何（{hull, areas, panels, primaryIndex}，屏幕坐标）挂到 VIEW / AREAS / PANELS */
/**
 * 把主进程给的桌面几何挂到 VIEW / AREAS / PANELS。
 * @param {DshDeskGeometryPayload} geo 物理像素
 * @returns {boolean} 几何非法（尺寸为 0 / 空列表）时返回 false，调用方保持原状
 */
function applyDeskGeometry(geo) {
  const hull = geo && geo.hull;
  const list = geo && Array.isArray(geo.areas) ? geo.areas.filter((a) => a && a.width > 0 && a.height > 0) : [];
  if (!hull || !(hull.width > 0) || !(hull.height > 0) || list.length === 0) return false;
  // 主进程几何是物理像素：hull/areas 逐个 ÷scale 进 CSS 系（§3.5 收口约定——几何导入唯一入口）
  VIEW.x = toLocal(hull.x);
  VIEW.y = toLocal(hull.y);
  VIEW.w = toLocal(hull.width);
  VIEW.h = toLocal(hull.height);
  AREAS = S.translateRects(
    list.map((a) => ({ x: toLocal(a.x), y: toLocal(a.y), width: toLocal(a.width), height: toLocal(a.height) })),
    -VIEW.x,
    -VIEW.y,
  );
  const workAreas = geo && Array.isArray(geo.workAreas) && geo.workAreas.length === list.length ? geo.workAreas : list;
  WORK_AREAS = S.translateRects(
    workAreas.map((a) => ({ x: toLocal(a.x), y: toLocal(a.y), width: toLocal(a.width), height: toLocal(a.height) })),
    -VIEW.x,
    -VIEW.y,
  );
  CONFIG.topInsetRatio = Number(geo.topInsetRatio) || 0;
  // 面板与工作区同序；缺失/长度不符（老主进程）退化为工作区，保持旧行为
  const panelsList =
    geo && Array.isArray(geo.panels) && geo.panels.length === list.length
      ? geo.panels.filter((p) => p && p.width > 0 && p.height > 0)
      : null;
  PANELS = S.translateRects(
    (panelsList || list).map((a) => ({
      x: toLocal(a.x),
      y: toLocal(a.y),
      width: toLocal(a.width),
      height: toLocal(a.height),
    })),
    -VIEW.x,
    -VIEW.y,
  );
  const pi = Number(geo.primaryIndex);
  PRIMARY_AREA = AREAS[Number.isInteger(pi) && pi >= 0 && pi < AREAS.length ? pi : 0];
  return true;
}

// 首帧几何走 URL query（position() 定角落时就要用）；运行期变化再经 pet:displays 推送。
// areas/panels 缺失（手动 start-desktop / 老版本主进程）时退化为「整个视口就是一块屏」= 旧行为。
applyDeskGeometry({
  hull: { x: VIEW_SCREEN.x, y: VIEW_SCREEN.y, width: VIEW_SCREEN.w, height: VIEW_SCREEN.h },
  areas: (() => {
    try {
      const parsed = JSON.parse(params.get('areas') || '[]');
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      /* 落到下面的单矩形兜底 */
    }
    return [{ x: VIEW_SCREEN.x, y: VIEW_SCREEN.y, width: VIEW_SCREEN.w, height: VIEW_SCREEN.h }];
  })(),
  panels: (() => {
    try {
      const parsed = JSON.parse(params.get('panels') || '[]');
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      /* 落到下面的面板兜底（= 工作区） */
    }
    return null;
  })(),
  primaryIndex: Number(params.get('primaryIndex') || 0),
  workAreas: (() => {
    try {
      return JSON.parse(params.get('workAreas') || 'null');
    } catch {
      return null;
    }
  })(),
  topInsetRatio: CONFIG.topInsetRatio,
});
const ORIGIN = new URL(CONFIG.configUrl).origin;
/** 宿主 /dsh-pet-ng-7340 前缀：bridge 走自定义 scheme（主进程转发），否则 HTTP 直连宿主 */
const BASE = BRIDGE ? 'dsh-pet-ng-bridge://dsh-pet-ng/dsh-pet-ng-7340' : ORIGIN + '/dsh-pet-ng-7340';
const STATE_URL = BASE + '/state'; // 轮询统一状态 S：前端 1s 轮询的唯一数据源（余额/工作状态/通知/说话）
const BALANCE_URL = BASE + '/balance'; // 余额刷新动作（POST，写 S；数据本身从 /state 读）
const WHISPER_URL = BASE + '/whisper';
const BUBBLE_DURATION_MS = 10 * 1000; // 余额/碎碎念气泡展示时长（与浏览器一致：定时自动消失，与动画解耦）
// 窗口四周外扩 = 该比例 × 宠物尺寸：为气泡 / 未来可能的弹窗预留显示空间；
// 外扩区透明且点击穿透（只有身体命中区可交互）。单点可调——按实际观感改这里。
const WINDOW_MARGIN_RATIO = 0.5;

// ---------- 全局状态 ----------
/**
 * 一次配置加载的成品（renderer.js 的 loadConfig 填充；null = 尚未加载成功）。
 * 这几个字段就是窗口层跑起来所需的全部配置，其它一律不读。
 * @typedef {object} DesktopConfig
 * @property {import('../shared/types').Pet[]} pets 拍平后的宠物实例（已按 display 过滤前的全量）
 * @property {import('../shared/types').PhysicsParams} physics 拖拽抛掷物理参数
 * @property {boolean} confineToScreen 抛掷是否锁定在当前屏幕
 * @property {import('../shared/types').FontConfig} font 全局字体（族/字号/是否加粗）
 * @property {import('../shared/types').Animations | undefined} animations 主条目的动画池（宠物自带池时的缺省）
 * @property {import('../shared/types').Weights | undefined} animationWeights 主条目的动画权重（同上）
 */
/**
 * 精灵挂载点：`index.html` 静态预置（`<div id="root">`），构造期一定存在。
 * 与 errorEl 同一套理由——断言非空，下游不必逐处判空。
 * @type {HTMLElement}
 */
const rootEl = /** @type {HTMLElement} */ (document.getElementById('root'));
/**
 * 红色错误条：`index.html` 静态预置（`<div id="pet-error" class="pet-error">`），构造期一定存在。
 * 这里断言非空，是为了让下游（renderer.js 的 showError/hideError）不必逐处判空——
 * 万一哪天 index.html 漏了这个节点，启动即抛（大声失败），而不是"报错条静默不显示"。
 * @type {HTMLElement}
 */
const errorEl = /** @type {HTMLElement} */ (document.getElementById('pet-error'));
/** @type {DesktopConfig | null} */
let config = null;
/** @type {PetSprite[]} 本窗口只装一只宠物（petIndex 由主进程注入） */
let sprites = [];
/** 最近一次成功解析的余额（本窗口单宠共用；null = 还没拉到） @type {import('../shared/balance').BalanceState | null} */
let balance = null;
let balanceTick = 0;
/**
 * 上次已提示的不可用原因（`reason:provider`）：自动轮询只在原因变化时再弹
 * （判定在 shared 的 decideBalanceNotice，与浏览器同一份）
 * @type {string | null}
 */
let balanceNoticeKey = null;
let workTick = 0; // 工作状态联动 tick：容器 1s 轮询 /state 的 sections.workStatus，counter 变化才递增（各启用宠物以此触发）
/** 配置加载失败后的重试定时器（5s）；非空表示已排队 @type {ReturnType<typeof setTimeout> | null} */
let bootTimer = null;
let loopsStarted = false;

// ---------- 调试钩子（冒烟自检/排障用；真实运行也可排查错误/配置/气泡） ----------
window.__dshPetDebug = {
  errors: [],
  configOk: false,
  spriteCount: 0,
  lastBubbleTitle: '',
  lastBalanceOk: null,
  menuOpen: false,
  chatOpen: false,
  bootAt: Date.now(),
  // 位置驱动源（漫游/拖拽/抛掷/静止）：sprite 的 setDrive/releaseDrive 会同步维护。
  // 在声明处给初值，是为了让"还没建精灵"和"精灵静止"在排障时都读到确定的值（不是 undefined）。
  drive: 'none',
};
window.addEventListener('error', (event) => {
  window.__dshPetDebug.errors.push(String(event.message || event.error));
});
