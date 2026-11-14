/**
 * 向上展开 Popover 详情卡片全向防裁切与微指示三角圆角避障几何算法
 * 遵循 GRAVITYBOX-SPEC-HUD-001 第 3.5 节
 */

/**
 * 计算向上弹出 Popover 的绝对屏幕坐标，实现水平与垂直全向视口防裁切及小三角圆角避障
 * @param {HTMLElement} capsuleEl 触发胶囊 DOM 元素
 * @param {number} popoverWidth Popover 卡片标准宽度 (px)
 * @param {number} [popoverHeight=190] Popover 卡片预估或实测高度 (默认 190px)
 * @param {number} [safeMargin=12] 距离视口四周边缘的安全留白 (默认 12px)
 * @param {number} [verticalGap=8] 胶囊顶边与 Popover 底边的垂直间隙 (默认 8px)
 * @param {number} [borderRadius=12] Popover 卡片圆角半径 (默认 12px)
 */
export function computeUpwardPopoverPosition(
  capsuleEl,
  popoverWidth,
  popoverHeight = 190,
  safeMargin = 12,
  verticalGap = 8,
  borderRadius = 12
) {
  const rect = capsuleEl.getBoundingClientRect();
  const win = typeof window !== 'undefined' ? window : globalThis.window || { innerWidth: 1024, innerHeight: 768 };
  const viewportWidth = Number(win.innerWidth) || 1024;
  const viewportHeight = Number(win.innerHeight) || 768;

  // 1. 动态有效宽度计算：当视口宽度不足容纳标准卡片与双向留白时，平滑收缩卡片有效宽度
  const availableViewportWidth = viewportWidth - 2 * safeMargin;
  const effectivePopoverWidth = Math.max(120, Math.min(popoverWidth, availableViewportWidth));

  // 2. 胶囊在视口中的绝对水平中心
  const capsuleCenterX = rect.left + rect.width / 2;

  // 3. 理想水平坐标 (Popover 中心与胶囊中心对齐)
  const idealLeft = capsuleCenterX - effectivePopoverWidth / 2;

  // 4. 水平边界夹紧约束 (Clamping)，确保右边缘严格不穿出视口
  const minLeft = safeMargin;
  const maxLeft = Math.max(minLeft, viewportWidth - effectivePopoverWidth - safeMargin);
  const clampedLeft = Math.max(minLeft, Math.min(idealLeft, maxLeft));

  // 5. 向上/向下垂直坐标与顶部防裁切检查：当上方空间不足容纳最小卡片且下方空间更充裕时自动向下翻转
  const topAvailableSpace = rect.top - verticalGap;
  const bottomAvailableSpace = viewportHeight - rect.bottom - verticalGap;
  const direction =
    topAvailableSpace < Math.min(popoverHeight, 140) && bottomAvailableSpace > topAvailableSpace
      ? 'down'
      : 'up';
  const bottom = Math.round(viewportHeight - rect.top + verticalGap);
  const top = Math.round(rect.bottom + verticalGap);
  const maxAllowedHeight =
    direction === 'down'
      ? Math.max(100, bottomAvailableSpace - safeMargin)
      : Math.max(100, topAvailableSpace - safeMargin);

  // 7. 指示小三角平直底边避障计算 (小三角半宽 7px, 圆角半径 borderRadius)
  const minArrow = borderRadius + 7; // 12 + 7 = 19px
  const maxArrow = Math.max(minArrow, effectivePopoverWidth - borderRadius - 7); // effectiveWidth - 19px
  const rawArrowPixel = capsuleCenterX - clampedLeft;
  const clampedArrowPixel = Math.max(minArrow, Math.min(rawArrowPixel, maxArrow));
  const arrowOffsetPercent = Number(((clampedArrowPixel / effectivePopoverWidth) * 100).toFixed(1));

  // 8. 判定对齐模式
  let alignment = 'center';
  if (clampedLeft === minLeft) {
    alignment = 'clamped-left';
  } else if (clampedLeft === maxLeft) {
    alignment = 'clamped-right';
  }

  return {
    left: Math.round(clampedLeft),
    bottom: Math.round(bottom),
    top: Math.round(top),
    direction,
    width: Math.round(effectivePopoverWidth),
    maxHeight: Math.round(maxAllowedHeight),
    arrowOffsetPercent,
    arrowPixelOffset: Math.round(clampedArrowPixel),
    alignment,
  };
}

const POPOVER_GEOMETRY_CACHE = typeof WeakMap === 'function' ? new WeakMap() : null;

/**
 * 清除指定 Popover 的布局几何缓存（应在弹窗隐藏或重新打开时调用）
 * @param {HTMLElement} popoverEl
 */
export function resetPopoverGeometryCache(popoverEl) {
  if (popoverEl && POPOVER_GEOMETRY_CACHE) {
    POPOVER_GEOMETRY_CACHE.delete(popoverEl);
  }
}

/**
 * 应用 Popover 定位并执行包含块零偏置补偿（应对宿主祖先元素存在 transform / contain 的场景）
 * @param {HTMLElement} popoverEl Popover 外层元素
 * @param {HTMLElement | null} arrowEl 小三角指示元素
 * @param {ReturnType<typeof computeUpwardPopoverPosition>} pos 计算坐标
 * @param {{ force?: boolean }} [options]
 */
export function applyPopoverGeometry(popoverEl, arrowEl, pos, options = {}) {
  if (!popoverEl || !pos) return;
  const force = Boolean(options?.force);
  const prevCached = POPOVER_GEOMETRY_CACHE?.get(popoverEl);
  if (
    !force &&
    prevCached &&
    prevCached.width === pos.width &&
    prevCached.maxHeight === pos.maxHeight &&
    prevCached.direction === pos.direction &&
    Math.abs(prevCached.left - pos.left) <= 3 &&
    Math.abs((prevCached.top ?? 0) - (pos.top ?? 0)) <= 1 &&
    Math.abs((prevCached.bottom ?? 0) - (pos.bottom ?? 0)) <= 1 &&
    Math.abs(prevCached.arrowPixelOffset - pos.arrowPixelOffset) <= 3
  ) {
    return;
  }

  popoverEl.style.width = `${pos.width}px`;
  popoverEl.style.maxHeight = `${pos.maxHeight}px`;
  popoverEl.style.left = `${pos.left}px`;
  if (pos.direction === 'down' && typeof pos.top === 'number') {
    popoverEl.style.top = `${pos.top}px`;
    popoverEl.style.bottom = 'auto';
    popoverEl.classList?.add?.('is-downward');
  } else {
    popoverEl.style.bottom = `${pos.bottom}px`;
    popoverEl.style.top = 'auto';
    popoverEl.classList?.remove?.('is-downward');
  }

  if (arrowEl) {
    arrowEl.style.left = `${pos.arrowPixelOffset}px`;
  }

  // 包含块偏置校准：若宿主父级存在 transform/filter/contain 导致 fixed 相对非视口定位，立即补偿差值
  // 测量期间临时抑制自身入场动画 transform，杜绝 translateY(4px)/scale(0.985) 被误判为祖先包含块偏移
  if (typeof popoverEl.getBoundingClientRect === 'function') {
    const win = typeof window !== 'undefined' ? window : globalThis.window;
    const vh = Number(win?.innerHeight) || 0;
    if (vh > 0) {
      const prevTransform = popoverEl.style.transform || '';
      const prevTransition = popoverEl.style.transition || '';
      popoverEl.style.transition = 'none';
      popoverEl.style.transform = 'none';
      const actualRect = popoverEl.getBoundingClientRect();
      popoverEl.style.transform = prevTransform;
      popoverEl.style.transition = prevTransition;
      if (actualRect && (actualRect.width > 0 || actualRect.height > 0)) {
        const deltaX = actualRect.left - pos.left;
        if (pos.direction === 'down' && typeof pos.top === 'number') {
          const deltaY = actualRect.top - pos.top;
          if (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) {
            popoverEl.style.left = `${Math.round(pos.left - deltaX)}px`;
            popoverEl.style.top = `${Math.round(pos.top - deltaY)}px`;
          }
        } else {
          const expectedBottomY = vh - pos.bottom;
          const deltaY = actualRect.bottom - expectedBottomY;
          if (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) {
            popoverEl.style.left = `${Math.round(pos.left - deltaX)}px`;
            popoverEl.style.bottom = `${Math.round(pos.bottom + deltaY)}px`;
          }
        }
      }
    }
  }

  if (POPOVER_GEOMETRY_CACHE) {
    POPOVER_GEOMETRY_CACHE.set(popoverEl, {
      width: pos.width,
      maxHeight: pos.maxHeight,
      left: pos.left,
      top: pos.top,
      bottom: pos.bottom,
      direction: pos.direction,
      arrowPixelOffset: pos.arrowPixelOffset,
    });
  }
}

globalThis.__GRAVITYBOX_HUD_POPOVER__ = {
  computeUpwardPopoverPosition,
  applyPopoverGeometry,
  resetPopoverGeometryCache,
};
