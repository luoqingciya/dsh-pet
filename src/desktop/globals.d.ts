/**
 * 桌面窗口层（经典 script）的全局声明。
 *
 * 这些文件不是 ES 模块：`index.html` 按顺序加载，顶层声明进全局词法环境，彼此直接引用。
 * TS 不认识这种共享方式，所以在这里补上必要的全局形状——只声明「跨文件约定」的东西，
 * 各文件自己的局部变量不需要声明。
 */

/**
 * 一块矩形（屏幕坐标或视口坐标，由调用方约定）。
 *
 * 就是 `shared/types` 的 `Rect`——**不另起一份形状**：桌面几何在渲染端与 shared 的物理/菜单/
 * 提示组件之间来回传，两份定义迟早会漂。
 */
type DshRect = import('../shared/types').Rect;

/**
 * 主进程下发的桌面几何（**物理像素**，进渲染端后由 constants.js 的 applyDeskGeometry ÷scale）。
 * 形状与 `src/core/desktop-control` 侧一致，见 desktop-geometry.js。
 */
interface DshDeskGeometryPayload {
  hull: DshRect;
  areas: DshRect[];
  /** 缺失/长度不匹配时为 null（老主进程），applyDeskGeometry 会退化处理 */
  workAreas?: DshRect[] | null;
  panels?: DshRect[] | null;
  primaryIndex: number;
  topInsetRatio: number;
}

interface Window {
  /**
   * `src/shared/index.ts` 打包成 `lib/desktop/shared-core.js` 后挂在 window 上的命名空间
   * （IIFE 的 name 就是 `PetShared`，见 scripts/build-desktop-core.mjs）。
   */
  PetShared: typeof import('../shared/index');
  /** 调试钩子：由 constants.js 挂上（冒烟自检/排障用），运行期一定存在 */
  __dshPetDebug: {
    errors: string[];
    configOk: boolean;
    spriteCount: number;
    lastBubbleTitle: string;
    lastBalanceOk: boolean | null;
    menuOpen: boolean;
    chatOpen: boolean;
    bootAt: number;
    // ---- 以下是 sprite.js 在运行期补写的排障快照（真机/冒烟用例读它们定位几何问题）----
    /** 身体命中区（窗口内坐标，CSS px） */
    hitRect?: { x: number; y: number; w: number; h: number };
    /** 左右透明边余量：边界按"身体"贴边用的那个值 */
    sideAllow?: number;
    /** 窗口四周外扩余量（上边距按气泡高度单独算，故不再是四个相等的数） */
    winMargin?: { t: number; r: number; b: number; l: number };
    /** 最近一次上报的宠物包围盒左上角（工作区坐标） */
    dragPos?: { x: number; y: number };
    /** 最近一次松手落点（工作区坐标） */
    lastDragRelease?: { x: number; y: number };
    /** 最近一次松手时的原始指针输入（验证指针屏幕坐标与窗口位移是否一致，如 DPI 缩放问题） */
    lastDragRaw?: {
      petX: number;
      petY: number;
      sxDown: number;
      syDown: number;
      xUp: number;
      yUp: number;
    };
    /** 是否处于"正在用输入"（拖拽/菜单/对话）——主进程据此不翻回穿透 */
    inputBusy?: boolean;
    /** 光标是否在身体命中区（点击穿透翻转的判据） */
    interactive?: boolean;
    /** 悬浮提示是否显示 */
    tooltipOn?: boolean;
    /** 当前位置驱动源（冒烟/排障用：同一时刻只应有一个） */
    drive?: DriveKind;
  };
}

/**
 * 跨窗碰撞 broker 里"一只宠物"的状态。
 *
 * 单位是**物理像素**（与窗口 bounds 一致），进渲染端后由 constants.js 的 toLocal ÷scale。
 * 生产端见 `src/desktop/windows.js` 的 `petStates`（pet:set-bounds 与 pet:report-flight 共同维护）。
 */
interface DshPetState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  bottomPad: number;
}

/**
 * preload 暴露给渲染端的窗口控制原语（`contextBridge.exposeInMainWorld('petBridge', …)`）。
 *
 * 这是窗口层与主进程之间**唯一的**通信面：每个方法对应一条 IPC（见 src/desktop/preload.js
 * 的逐条注释）。渲染端所有 `window.petBridge.xxx()` 都靠这份声明获得类型。
 */
interface PetBridge {
  /** 宠物窗口逐帧跟随：窗口内容区坐标 + 宠物包围盒坐标（工作区）+ 尺寸/速度/余量 */
  setBounds(
    x: number,
    y: number,
    width: number,
    height: number,
    boxX: number,
    boxY: number,
    size: number,
    bottomPad: number,
    vx: number,
    vy: number,
    marginL: number,
    marginT: number,
  ): void;
  /** 点击穿透翻转 */
  setInteractive(interactive: boolean): void;
  /** 渲染端正在用输入（拖拽 / 菜单 / 对话框开着）：busy 期间主进程绝不翻回穿透 */
  setInputBusy(busy: boolean): void;
  setInputRegions(input: unknown): void;
  /** 托盘菜单「打开设置」：交给主进程用系统浏览器打开 */
  openDshSite(url: string): void;
  reportFlight(state: unknown): void;
  /** 主进程广播的**全量**宠物状态（含自己，订阅方自行排除）：碰撞检测用 */
  onFlightStates(cb: (states: Record<string, DshPetState>) => void): void;
  reportCollide(targetId: string, vx: number, vy: number): void;
  /** 「你被撞了」：带新的初速（物理像素），订阅方据此把自己抛出去 */
  onPetHit(cb: (payload: { vx: number; vy: number }) => void): void;
  /** 显示器热更新：主进程重算桌面几何后推来 */
  onDisplays(cb: (geo: DshDeskGeometryPayload) => void): void;
  /** 托盘菜单项（每次弹出推一次） */
  onTrayMenu(cb: (payload: { items: import('../shared/menu').MenuNode[] }) => void): void;
  /** 菜单渲染完报真实尺寸，主进程据此收缩窗口 */
  trayMenuSize(size: { width: number; height: number }): void;
  trayAction(action: string): void;
  trayClose(): void;
}

interface Window {
  /** preload 注入的窗口控制原语 */
  petBridge: PetBridge;
}

/**
 * 渲染端 → 主进程的 IPC 负载。
 *
 * 桥上是 `unknown`（见 electron.d.ts 的 `ipcMain.on`），断言成"带任意键的对象"只是为了能读到键，
 * **不代表相信它**：每个 handler 后面照旧逐个 `Number()` / `Array.isArray()` 校验——那才是真契约。
 */
type IpcPayload = Record<string, unknown>;

/**
 * 宿主注入的 bridge 请求处理函数返回的形状。
 *
 * 与 `src/core/desktop-api` 的 `DesktopResponse` **同形**，但在这里另写一份：
 * 分层规则里 desktop 只能依赖 shared（见 scripts/check-layers.js），跨层 import 类型也不行。
 * 两边改动要一起改——桌面层只用到这四个字段。
 */
interface DshBridgeResponse {
  status: number;
  contentType?: string;
  /** 响应正文（JSON/文本） */
  body?: string;
  /** 素材文件的绝对路径：二进制不过 JSON，窗口层直接读盘 */
  file?: string;
}

/**
 * 宿主注入的 bridge 请求处理函数（`createDesktop({ request })`）。
 *
 * 与 `src/api/router` 的 handlePetRoute 同签名：渲染端的每条请求（配置/余额/碎碎念/素材）
 * 都直接落到宿主路由上，语义与本地 HTTP 服务完全一致。
 */
type DshBridgeHandler = (method: string, url: string, body?: string) => Promise<DshBridgeResponse>;

/** 一只桌面宠物的窗口参数（宿主给的列表归一化后：补上窗口序号，非法尺寸已挡掉） */
interface DshDesktopPet {
  id: string;
  size: number;
  /** 窗口序号（渲染端用它区分多只宠物的 query 与缓存键） */
  index: number;
}

/**
 * 谁在写宠物的位置（同一时刻**只有一个**）。
 *
 * 形状来自 `src/shared/drive`（转移表 `canStartDrive` 也在那儿，纯逻辑 + 单测）；
 * 切换的唯一入口是 `PetSprite.setDrive`。
 *   - `none`  静止：位置由 position()/sendBounds 一次性设定，没有循环在跑
 *   - `move`  漫游：按移动动画的播放进度推进（shared/planMove 规划好的轨迹）
 *   - `drag`  拖拽：过阻尼弹簧跟随指针
 *   - `throw` 抛掷：重力 + 边缘反弹 + 落地摩擦
 */
type DriveKind = import('../shared/drive').DriveKind;

/**
 * `events.js` 以 `PetSprite.prototype.xxx = function` 的形式给精灵挂上的事件联动方法。
 *
 * 为什么不在 class 里写：这些方法只服务「余额 / 碎碎念 / 工作状态」三条外部事件链，与精灵的
 * 渲染/物理/交互本体无关；放在 events.js 里可以让 sprite.js 只关心"怎么动、怎么画"。
 * TS 认识 `this` 的类型（原型赋值的目标表达式给了上下文），但**不会**把属性登记到类上，
 * 所以这里用 interface 与 sprite.js 的 `class PetSprite` 做声明合并补上成员形状。
 *
 * 参数形状与 `events.js` 里对应函数的形参一一对应，改签名时两边一起改。
 */
interface PetSprite {
  /** 工作状态一拍（tick 是容器递增的序号，同序号不重复处理） */
  onWorkTick(snapshot: import('../shared/work-status').WorkStatusSnapshot, tick: number): void;
  /** 余额一拍；manual = 用户主动要的（绕过 balanceEnabled 门控） */
  onBalanceTick(state: import('../shared/balance').BalanceState, tick: number, manual: boolean): void;
  /** 余额成功展示：气泡 + 档位动画 */
  showBalanceNow(state: import('../shared/balance').BalanceState, manual: boolean): void;
  /** 余额不可用：只弹文字说明气泡（没有百分比语义，无从映射档位动画） */
  showBalanceNotice(state: import('../shared/balance').BalanceState, manual: boolean): void;
  /** 碎碎念 / 命令气泡 / 对话回复三合一展示（image 为空串表示不带配图） */
  showWhisper(text: string, image: string, reply: boolean): void;
}
