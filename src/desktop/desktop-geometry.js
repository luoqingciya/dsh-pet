// @ts-check
/** Desktop motion may enter the macOS menu-bar strip; menus must stay in the work area. */
'use strict';

const { HIT_BOX, STAGE_W, CANVAS_H, FEET_Y } = require('./pointer-target.js');

/** 一块矩形（Electron 的 bounds / workArea 同构） */
/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 */

/** 一台显示器（只用到这几项） */
/**
 * @typedef {{
 *   id: number,
 *   bounds: Rect,
 *   workArea: Rect,
 * }} DisplayInfo
 */

/** 桌面几何：宠物可以走的「外壳」+ 每屏区域 + 面板矩形 */
/**
 * @typedef {{
 *   hull: Rect,
 *   areas: Rect[],
 *   workAreas: Rect[],
 *   panels: Rect[],
 *   primaryIndex: number,
 *   topInsetRatio: number,
 * }} DeskGeometry
 */

/**
 * 由显示器列表算出桌面几何。
 *
 * macOS 上额外把「可见头部的可达区域」上探到菜单栏下沿（`panels[i].y`），但保留 Dock 的底部排除；
 * 其余平台直接用 workArea。`topInsetRatio` 给渲染端换算「头顶可以伸进菜单栏多少」。
 *
 * @param {DisplayInfo[]} displays 显示器列表（主屏在前，与 Electron 一致）
 * @param {number} primaryId 主屏 id
 * @param {NodeJS.Platform | string} platform 平台标识
 * @returns {DeskGeometry}
 */
function buildDeskGeometry(displays, primaryId, platform) {
  const workAreas = displays.map((d) => ({ ...d.workArea }));
  const panels = displays.map((d) => ({ ...d.bounds }));
  const areas = workAreas.map((a, i) => {
    if (platform !== 'darwin') return { ...a };
    // Keep the Dock exclusion at the bottom/sides, but let the visible head reach the panel top.
    return { ...a, y: panels[i].y, height: a.y + a.height - panels[i].y };
  });
  const x = Math.min(...areas.map((a) => a.x));
  const y = Math.min(...areas.map((a) => a.y));
  return {
    hull: {
      x,
      y,
      width: Math.max(...areas.map((a) => a.x + a.width)) - x,
      height: Math.max(...areas.map((a) => a.y + a.height)) - y,
    },
    areas,
    workAreas,
    panels,
    primaryIndex: Math.max(
      0,
      displays.findIndex((d) => d.id === primaryId),
    ),
    topInsetRatio: platform === 'darwin' ? (HIT_BOX.y0 + CANVAS_H - FEET_Y) / STAGE_W : 0,
  };
}

module.exports = { buildDeskGeometry };
