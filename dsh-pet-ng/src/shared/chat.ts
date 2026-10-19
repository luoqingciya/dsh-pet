// 对话输入弹窗（src/shared，浏览器 bundle 与桌面 shared-core 共用）：
//  - 纯逻辑：类型 / 发送（走 host /dsh-pet-ng-7340/chat，host 是 memory.json 唯一读写方
//    —— 浏览器与桌面同一实例天然共享同一份记忆，两端只是不同显示方式）；
//  - CHAT_CSS + mountChatDialog：自 menu.ts 之后第二个「两端共用同一份 DOM」例外
//    （菜单组件证明可行的模式：浏览器页面与桌面透明窗渲染完全一致的对话框）。
// 交互语义（与碎碎念同一显示效果，只多一步用户输入）：
//    右键菜单「对话」→ 极简输入框（顶部带**最近记忆**）→ 确认后弹窗消失 →
//    桌宠把回复用碎碎念同款方式展示（说话动画 + 白色气泡 10s 消失）。
//  **回复不再由本组件带回**：POST /chat 是动作端点，只回 {ok}，回复写进 S 的
//    pets.<id>.say，由调用方（容器/桌面外壳）的 /state 轮询展示——onSent 只用来
//    叫醒一拍，让结果 0 延迟可见（见各端实现）。
// 记忆语义：memory.json 全存不删；host 每次请求只截尾部 chatMemoryRounds 轮进上下文。
//   弹窗打开时用 GET /chat 把那段窗口拉回来显示在输入框上方——**这是「记忆」在界面上
//   唯一的可见出口**：从前这个 GET 没有任何消费方，用户只能看到它"记住了"，看不到记住了什么。

/** POST /dsh-pet-ng-7340/chat?pet=<id> {text}：只回是否受理（回复走 /state 的 pets.<id>.say） */
export type ChatSendState =
  | { ok: true }
  | { ok: false; reason: 'provider-missing' | 'generate-error' | 'config-error' | 'bad-request'; message?: string };

const SEND_TIMEOUT_MS = 60_000; // 对话要等 LLM 生成回复，比碎碎念（30s）放宽一倍

/** 发送一句对话（携带记忆去 host 生成回复并写入记忆）。
 *  网络/解析失败显式抛错（调用方决定报错方式，绝不静默伪造）。 */
export async function sendChat(baseUrl: string, text: string): Promise<ChatSendState> {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const raw: unknown = await res.json().catch(() => null);
  if (!raw || typeof raw !== 'object') throw new Error('dsh-petNG: 对话响应非法');
  const o = raw as Record<string, unknown>;
  if (o.ok !== true) {
    return {
      ok: false,
      reason:
        o.reason === 'provider-missing' || o.reason === 'generate-error' || o.reason === 'config-error'
          ? o.reason
          : 'bad-request',
      message: typeof o.message === 'string' ? o.message : undefined,
    };
  }
  return { ok: true };
}

/** 弹窗历史行（role 已归一、正文已截断） */
export interface ChatHistoryRow {
  role: 'user' | 'assistant';
  text: string;
}

/** 单行历史最多几个码点：弹窗只有 160~340px 宽，再长就只剩省略号 */
const HISTORY_TEXT_MAX = 40;
/** 弹窗最多展示几条历史（4 条 = 最近 2 轮）：再多会把输入框挤出可视区 */
const HISTORY_ROWS = 4;

/**
 * 记忆消息 → 弹窗历史行（纯函数，可单测）。
 *
 * 口径：
 *  - 只认 `role` 为 user / assistant 且正文非空的条目（memory.json 只存这两类；手改坏的
 *    旧格式一律丢弃，不猜、不伪造）；
 *  - 取**尾部** limit 条：历史窗口的意义是"刚才聊了什么"，不是"从头看一遍"；
 *  - 超长按码点截断（不把 emoji 截成半个），与 host 的 TASK_TEXT_MAX 同一套切法。
 */
export function historyRows(messages: unknown, limit = HISTORY_ROWS): ChatHistoryRow[] {
  if (!Array.isArray(messages) || limit <= 0) return [];
  const rows: ChatHistoryRow[] = [];
  for (const item of messages) {
    if (!item || typeof item !== 'object') continue;
    const o = item as { role?: unknown; content?: unknown };
    if (o.role !== 'user' && o.role !== 'assistant') continue;
    const text = typeof o.content === 'string' ? o.content.trim() : '';
    if (!text) continue;
    const points = Array.from(text);
    rows.push({
      role: o.role,
      text: points.length > HISTORY_TEXT_MAX ? `${points.slice(0, HISTORY_TEXT_MAX).join('')}…` : text,
    });
  }
  return rows.slice(-limit);
}

/**
 * `GET /chat?pet=<id>` —— 最近记忆窗口（host 已按 chatMemoryRounds 截好尾部）。
 *
 * 弹窗打开时调用：让「记忆轮数」这个设置在界面上有个看得见的出口——否则 memory.json
 * 只在请求上下文里生效，用户永远不知道它记住了什么（这个 GET 从前没有任何消费方）。
 * **读不到一律回空数组**：历史是可选装饰，不该因为一次读失败挡住输入
 * （真正要紧的失败由发送时的错误行表达）。
 */
export async function fetchChatHistory(baseUrl: string, limit = HISTORY_ROWS): Promise<ChatHistoryRow[]> {
  try {
    const res = await fetch(baseUrl, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const raw: unknown = await res.json();
    const messages = (raw as { messages?: unknown } | null)?.messages;
    return historyRows(messages, limit);
  } catch {
    return [];
  }
}

/** 弹窗样式 —— 两端注入同一份（与菜单 MENU_CSS 同理；视觉对齐浏览器/桌面）。
 *  形态：一条自适应输入框（无标题/无按钮）——初始小宽度（160px），
 *  随输入自动增宽（封顶 340px），到上限后自动折行增高；回车发送，Esc 或点外关闭。
 *  输入框上方可选一段历史（`.dsh-pet-ng-chat-history`，空时 `:empty` 收起）。
 *  宽度由 JS 按文本测量覆盖根元素宽度。 */
export const CHAT_CSS = [
  '.dsh-pet-ng-chat{position:fixed;z-index:2147483001;width:160px;max-width:80vw;',
  'background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:10px;',
  'box-shadow:0 10px 32px rgba(0,0,0,.22);color:#2b2b2b;font-size:14px;line-height:1.5;',
  // 字体与桌宠气泡同款（上首软糖体，两端均已注入 @font-face），风格一致不显正式。
  // 字体族走全局配置变量 --dsh-pet-ng-font-family：弹窗挂在 body 下、继承不到宠物根容器，
  // 所以由两端注入在 documentElement（回退参数 = 改造前的原栈）。
  // 字号保持固定 14px：配置里的 font.size 只作用于气泡与悬浮提示，不改变本弹窗。
  "font-family:var(--dsh-pet-ng-font-family,'ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif);",
  'user-select:none}',
  '.dsh-pet-ng-chat *{box-sizing:border-box}',
  '.dsh-pet-ng-chat-input{display:block;width:100%;border:none;outline:none;background:transparent;',
  'padding:8px 11px 9px;font-size:14px;line-height:1.45;color:#2b2b2b;font-family:inherit;',
  'resize:none;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.dsh-pet-ng-chat-input::placeholder{color:rgba(43,43,43,.45)}',
  '.dsh-pet-ng-chat-input:disabled{opacity:.55}',
  // 历史区（GET /chat 的记忆窗口）：`:empty` 时完全不占位——没有历史/读不到时，弹窗与
  // 从前逐像素一致（高度、位置、圆角都不变），不会因为多了个空 div 多出一截内边距。
  // 高度上限**不写在这里**：它跟着 clamp 可视矩形走（贴屏底时可视区可能只有一百多像素），
  // 由 mountChatDialog 按 `c.h` 算好写成内联 max-height——两处各写一份必然漂移。
  '.dsh-pet-ng-chat-history{overflow-y:auto;padding:8px 11px 0;',
  'display:flex;flex-direction:column;gap:3px}',
  '.dsh-pet-ng-chat-history:empty{display:none}',
  '.dsh-pet-ng-chat-row{font-size:12px;line-height:1.45;overflow-wrap:anywhere}',
  '.dsh-pet-ng-chat-row.is-user{color:rgba(43,43,43,.5)}',
  '.dsh-pet-ng-chat-row.is-assistant{color:#2b2b2b}',
  '.dsh-pet-ng-chat-err{color:#d94f3d;font-size:12px;padding:0 12px 8px;white-space:pre-wrap;overflow-wrap:anywhere}',
].join('');

/** 输入框宽度自适应参数：初始小宽 → 随文本增宽 → 封顶后折行增高 */
const CHAT_MIN_W = 160;
const CHAT_MAX_W = 340;
const CHAT_H_PAD = 22; // 输入框水平 padding（11×2），宽度测量补偿

let chatCssInjected = false;
function injectChatCss(): void {
  if (chatCssInjected || typeof document === 'undefined') return;
  chatCssInjected = true;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-petNG';
  tag.dataset.pluginCss = 'dsh-pet-ng/chat';
  tag.textContent = CHAT_CSS;
  document.head.appendChild(tag);
}

/** mountChatDialog 返回值 */
export interface ChatDialogMount {
  /** 根元素（document.body 下） */
  el: HTMLElement;
  /** 关闭并清理（幂等） */
  close: () => void;
}

/** 挂载一个对话输入弹窗（两端共用；位置为视口坐标，超出 clamp 矩形自动夹回）。
 *  形态：一条输入框（无标题/无按钮）+ 顶部最近记忆（GET /chat，最多 4 行，读不到就不显示）；
 *  回车即发送 → 弹窗关闭 → onSent() 交给调用方叫醒一拍 /state
 *  （回复写进了 pets.<id>.say，气泡随下一拍出现）；
 *  Esc / 点弹窗外关闭；生成失败则留在弹窗内显式提示，不伪造回复。
 *
 *  clamp（可选，#41）：弹窗允许占用的矩形（视口局部坐标，默认整个视口）。
 *  桌面模式传「窗口 ∩ 工作区」——宠物贴屏幕底/右时窗口外扩余量伸出屏幕，
 *  约束到该矩形内即可完整显示，**窗口/宠物零移动零闪帧**。 */
export function mountChatDialog(opts: {
  petId: string;
  /** 端点基址：浏览器默认相对 /dsh-pet-ng-7340/chat；桌面传绝对 URL（file:// 页面需绝对） */
  baseUrl?: string;
  x: number;
  y: number;
  /** 发送成功后调用（弹窗此时已关闭）：调用方叫醒一拍 /state 让回复 0 延迟出现。
   *  回复本身不从这里回传——它走 S（动作端点不回数据，数据只有一个出口）。 */
  onSent?: () => void;
  onClose?: () => void;
  /** 弹窗允许占用的矩形（视口局部坐标）；缺省 = 整个视口 */
  clamp?: { x: number; y: number; w: number; h: number };
}): ChatDialogMount {
  injectChatCss();
  const { petId, x, y, onSent, onClose, clamp } = opts;
  const baseUrl = opts.baseUrl ?? '/dsh-pet-ng-7340/chat';
  const withPet = baseUrl + '?pet=' + encodeURIComponent(petId);
  const c =
    clamp && Number.isFinite(clamp.x + clamp.y + clamp.w + clamp.h)
      ? clamp
      : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };

  const root = document.createElement('div');
  root.className = 'dsh-pet-ng-chat';

  const input = document.createElement('textarea');
  input.className = 'dsh-pet-ng-chat-input';
  input.placeholder = '说点什么…';
  input.maxLength = 2000;
  input.rows = 1;

  // 宽度/高度自适应：宽度按文本测量（≤CHAT_MAX_W），封顶后高度随折行增长
  let measureCtx: CanvasRenderingContext2D | null = null;
  const measureText = (text: string): number => {
    const ctx =
      measureCtx ?? (measureCtx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D);
    ctx.font = getComputedStyle(input).font; // 每次取当前计算样式（挂载前后都准）
    return ctx.measureText(text).width;
  };
  const resizeInput = (): void => {
    const textW = measureText(input.value || ' ');
    const w = Math.max(CHAT_MIN_W, Math.min(Math.ceil(textW + CHAT_H_PAD), CHAT_MAX_W));
    root.style.width = w + 'px'; // 根宽度跟随（含 err 行）→ 夹回仍按实际宽
    input.style.height = 'auto';
    input.style.height = Math.max(input.scrollHeight, 22) + 'px';
  };
  input.addEventListener('input', resizeInput);
  resizeInput(); // 以占位符为初始宽度

  const err = document.createElement('div');
  err.className = 'dsh-pet-ng-chat-err';
  err.style.display = 'none';

  // 历史区：GET /chat 的记忆窗口（见 fetchChatHistory）。放在输入框**上方**——先看到
  // "刚才聊了什么"，再决定说什么；没有历史时 `:empty` 收起，视觉与从前一致。
  const history = document.createElement('div');
  history.className = 'dsh-pet-ng-chat-history';
  // 高度上限跟着可视矩形走：宠物贴屏底时 clamp 只剩一百多像素，先压历史再挤输入框。
  // 132 = 约 7 行 12px；至少给输入框留 72px（一行文本 + 上下内边距 + 出错行）。
  history.style.maxHeight = Math.max(0, Math.min(132, c.h - 72)) + 'px';

  root.appendChild(history);
  root.appendChild(input);
  root.appendChild(err);
  document.body.appendChild(root);

  /** 落位：以 (x,y) 为基准，超出 clamp 矩形夹回。
   *  独立成函数是因为历史是**异步**到达的——它一出现高度就变，必须重新夹一次，
   *  否则弹窗会顶出可视区（#41 的同一个坑：贴边时窗口外扩余量本来就在屏幕外）。 */
  const place = (): void => {
    const rr = root.getBoundingClientRect();
    root.style.left = Math.max(c.x + 4, Math.min(x, c.x + c.w - rr.width - 4)) + 'px';
    root.style.top = Math.max(c.y + 4, Math.min(y, c.y + c.h - rr.height - 4)) + 'px';
  };
  resizeInput(); // append 后再量一次（此时样式已生效）
  place();

  let closed = false;
  let sending = false;

  // 历史（GET /chat）：异步到达 → 追加行 → 重新落位。读不到就是空，不打扰用户。
  void fetchChatHistory(withPet).then((rows) => {
    if (closed || rows.length === 0) return;
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'dsh-pet-ng-chat-row is-' + row.role;
      line.textContent = (row.role === 'user' ? '你：' : 'TA：') + row.text;
      history.appendChild(line);
    }
    place();
  });

  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    root.remove();
    if (onClose) onClose();
  };
  const onDocPointerDown = (e: MouseEvent): void => {
    if (closed) return;
    if (root.contains(e.target as Node)) return;
    close();
  };
  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (closed) return;
    if (e.key === 'Escape') close();
  };
  document.addEventListener('mousedown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);

  const doSend = (): void => {
    if (closed || sending) return;
    const text = input.value.trim();
    if (!text) return;
    sending = true;
    input.disabled = true;
    sendChat(withPet, text)
      .then((state) => {
        if (state.ok) {
          close();
          if (onSent) onSent();
        } else {
          err.textContent = '对话失败：' + (state.message ?? state.reason);
          err.style.display = 'block';
        }
      })
      .catch((e) => {
        err.textContent = '对话异常：' + String(e && e.message ? e.message : e);
        err.style.display = 'block';
      })
      .finally(() => {
        sending = false;
        input.disabled = false;
        if (!closed) input.focus();
      });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSend();
    }
  });

  input.focus();
  return { el: root, close };
}
