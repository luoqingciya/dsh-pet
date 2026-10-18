/**
 * 托盘菜单（自绘）—— 与宠物右键菜单**共用同一个组件**（`S.mountContextMenu`）。
 *
 * 为什么要自绘：Windows 上 `Tray.setContextMenu` 是**原生控件**，字号由系统/进程 DPI 决定；
 * 而应用为了让宠物像素级对齐强制了 `force-device-scale-factor=1` —— 原生菜单不跟这套补偿，
 * 150% 屏上只有 2/3 大，而 `MenuItem` 根本没有字号可调。所以改成"无边框透明小窗 + 同一套 DOM
 * 菜单"，尺寸与缩放按 `uiScale` 补偿（做法与设置窗一致，见 windows.js 的 createTrayMenu）。
 *
 * 通信（preload 暴露的三个原语）：
 *   - 主进程 → `pet:tray-menu`（菜单项数组，每次弹出推一次）
 *   - 渲染端 → `pet:tray-size`（渲染完把真实尺寸报回去，窗口按内容收缩）
 *   - 渲染端 → `pet:tray-action`（点了哪一项）/ `pet:tray-close`（菜单被点外/Esc 关掉）
 */
'use strict';

/**
 * 注入菜单样式（`MENU_CSS`）——**本页必须自己注入**。
 *
 * 宠物窗口是在 renderer.js 的 injectAssets() 里注入的，浏览器端由插件 css 带上；
 * 托盘菜单是一个独立页面（tray-menu.html），谁都不会替它注入。少了这一份：
 *   `.dsh-pet-menu-column` 拿不到 `position:absolute`，退回正常文档流 → 被 `#root`
 *   （height:100%）顶到视口下方，整棵菜单落在可视区之外。窗口是透明的，
 *   于是"右键托盘什么都没发生"（窗口其实已经显示、DOM 也有 5 项，只是没画在可见区）。
 * 用 id 兜底，重复调用不叠加。
 */
function ensureMenuStyle() {
  if (document.getElementById('dsh-pet-menu-style')) return;
  const style = document.createElement('style');
  style.id = 'dsh-pet-menu-style';
  style.textContent = window.PetShared.MENU_CSS;
  document.head.appendChild(style);
}

/** 当前挂载的菜单（重新弹出前先关掉旧的） */
let mounted = null;

function closeMenu() {
  if (mounted) {
    try {
      mounted.close();
    } catch {
      /* 已经关掉了：忽略 */
    }
    mounted = null;
  }
  const root = document.getElementById('root');
  if (root) root.textContent = '';
}

window.petBridge.onTrayMenu((payload) => {
  closeMenu();
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  if (items.length === 0) return;

  // 样式先就位再挂载：面板一进 DOM 就要按绝对定位量尺寸（下面那次 getBoundingClientRect）
  ensureMenuStyle();

  const menu = window.PetShared.mountContextMenu({
    tree: items,
    // 窗口本身贴边留 4px 余量（阴影/圆角不被裁）
    x: 4,
    y: 4,
    onAction: (leaf) => {
      // 先告诉主进程隐藏窗口，再让它执行动作（动作里可能包含退出）
      window.petBridge.trayAction(leaf && leaf.action ? leaf.action : '');
    },
    onClose: () => {
      mounted = null;
      window.petBridge.trayClose();
    },
  });
  mounted = menu;

  // 菜单面板的 `max-height` 在共用样式里是 `min(62vh, 460px)` —— 那是按**全屏宠物窗**定的。
  // 托盘菜单相反：窗口是**按菜单内容收缩**的，用 vh 限高会变成反馈环（窗口缩 → vh 变小 →
  // 面板更矮 → 窗口再缩），而且第一次弹出时窗口还是初始高度，面板直接被 62vh 截断，
  // 最后一项「退出」被切掉（表现为菜单少一项、还得滚）。
  // 这里按内容撑开，高度上限交给主进程的窗口夹取（pet:tray-size 里 760px）。
  // 前提是托盘菜单是一份很短的固定列表（TRAY_ITEMS）；将来真要塞几十项，得改成按屏高限高。
  const panel = menu.el.querySelector('.dsh-pet-menu-column') || menu.el;
  panel.style.maxHeight = 'none';

  // 渲染完量真实尺寸：主进程按它收缩窗口，透明区域不留（少挡下层点击）。
  // 量两次：挂载那一拍窗口还是初始尺寸，若样式/字体结算晚一拍，第一次可能量到中间态；
  // 下一帧复量一次即可收敛（place() 幂等，多报一次只是重设同样的 bounds）。
  const reportSize = () => {
    if (!mounted) return;
    const rect = panel.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    window.petBridge.trayMenuSize({
      width: Math.ceil(rect.right) + 4,
      height: Math.ceil(rect.bottom) + 4,
    });
  };
  reportSize();
  requestAnimationFrame(() => requestAnimationFrame(reportSize));
});
