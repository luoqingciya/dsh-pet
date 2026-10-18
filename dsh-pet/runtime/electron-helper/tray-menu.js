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

  // 渲染完量一次真实尺寸：主进程按它收缩窗口，透明区域不留（少挡下层点击）
  const panel = menu.el.querySelector('.dsh-pet-menu-column') || menu.el;
  const rect = panel.getBoundingClientRect();
  window.petBridge.trayMenuSize({
    width: Math.ceil(rect.right) + 4,
    height: Math.ceil(rect.bottom) + 4,
  });
});
