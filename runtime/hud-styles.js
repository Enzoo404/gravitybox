/**
 * GravityBox Conversation Status HUD & Upward Popover 样式与 Design Tokens
 * 支持浅色/深色双模、@container 响应式容器查询、微光骨架屏动效与外层防裁切小三角
 */

export const HUD_STYLES_CSS = `
:host {
  /* ==================== 浅色模式 (Light Theme) ==================== */
  --hud-bg: rgba(10, 10, 12, 0.045);
  --hud-bg-hover: rgba(10, 10, 12, 0.08);
  --hud-bg-active: rgba(10, 10, 12, 0.12);
  --hud-border: rgba(10, 10, 12, 0.06);
  --hud-border-hover: rgba(10, 10, 12, 0.12);
  --hud-text-primary: #18181B;
  --hud-text-secondary: #71717A;
  --hud-text-muted: #A1A1AA;
  --hud-popover-bg: #FFFFFF;
  --hud-popover-border: rgba(10, 10, 12, 0.08);
  --hud-popover-shadow: 0 10px 30px -4px rgba(0, 0, 0, 0.12), 0 4px 12px -2px rgba(0, 0, 0, 0.06);
  --hud-divider: rgba(10, 10, 12, 0.06);
  --hud-progress-track: rgba(10, 10, 12, 0.06);

  /* 分段进度条语义色彩 (Light) */
  --hud-seg-sys-color: #94A3B8;
  --hud-seg-tool-color: #8B5CF6;
  --hud-seg-msg-color: #3B82F6;
  --hud-warn-color: #F59E0B;
  --hud-danger-color: #EF4444;

  /* 骨架屏扫描动效 Tokens (Light) */
  --hud-skeleton-base: rgba(10, 10, 12, 0.05);
  --hud-skeleton-highlight: rgba(10, 10, 12, 0.12);

  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  box-sizing: border-box;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}

:host-context(body.theme-dark),
:host-context(html.dark),
:host-context([data-theme="dark"]),
:host([data-theme="dark"]) {
  /* ==================== 深色模式 (Dark Theme) ==================== */
  --hud-bg: rgba(255, 255, 255, 0.07);
  --hud-bg-hover: rgba(255, 255, 255, 0.12);
  --hud-bg-active: rgba(255, 255, 255, 0.16);
  --hud-border: rgba(255, 255, 255, 0.09);
  --hud-border-hover: rgba(255, 255, 255, 0.16);
  --hud-text-primary: #F4F4F5;
  --hud-text-secondary: #A1A1AA;
  --hud-text-muted: #71717A;
  --hud-popover-bg: #18181B;
  --hud-popover-border: rgba(255, 255, 255, 0.10);
  --hud-popover-shadow: 0 16px 40px -6px rgba(0, 0, 0, 0.55), 0 6px 16px rgba(0, 0, 0, 0.35);
  --hud-divider: rgba(255, 255, 255, 0.08);
  --hud-progress-track: rgba(255, 255, 255, 0.10);

  /* 分段进度条语义色彩 (Dark) */
  --hud-seg-sys-color: #64748B;
  --hud-seg-tool-color: #A78BFA;
  --hud-seg-msg-color: #60A5FA;
  --hud-warn-color: #FBBF24;
  --hud-danger-color: #F87171;

  /* 骨架屏扫描动效 Tokens (Dark) */
  --hud-skeleton-base: rgba(255, 255, 255, 0.06);
  --hud-skeleton-highlight: rgba(255, 255, 255, 0.16);
}

@keyframes hud-shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

@keyframes hud-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

.hud-container {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  height: 24px;
  overflow: hidden;
  box-sizing: border-box;
  container-type: inline-size;
  container-name: hud;
}

.capsule {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 9px;
  border-radius: 9999px;
  background-color: var(--hud-bg);
  border: 1px solid var(--hud-border);
  color: var(--hud-text-secondary);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", Roboto, sans-serif;
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  outline: none;
  pointer-events: auto;
  user-select: none;
  -webkit-user-select: none;
  box-sizing: border-box;
  overflow: hidden;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
}

.capsule:hover,
.capsule.is-active,
.capsule:focus-visible {
  background-color: var(--hud-bg-hover);
  border-color: var(--hud-border-hover);
  color: var(--hud-text-primary);
}

.capsule:active {
  background-color: var(--hud-bg-active);
}

.capsule.is-skeleton {
  pointer-events: none;
  background: linear-gradient(
    90deg,
    var(--hud-skeleton-base) 25%,
    var(--hud-skeleton-highlight) 50%,
    var(--hud-skeleton-base) 75%
  );
  background-size: 200% 100%;
  animation: hud-shimmer 1.2s infinite linear;
}

.capsule.is-skeleton .capsule-text,
.capsule.is-skeleton .capsule-icon,
.capsule.is-skeleton .capsule-donut {
  opacity: 0.35;
}

.capsule.is-streaming .capsule-icon {
  color: var(--hud-seg-msg-color);
  animation: hud-pulse 1.4s ease-in-out infinite;
}

.capsule-icon,
.capsule-donut {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  margin-right: 5px;
}

.capsule-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  font-variant-numeric: tabular-nums;
}

/* ==================== 弹性收缩权重阶梯与保底尺寸 ==================== */
.capsule-context {
  flex-shrink: 0;
  min-width: fit-content;
}

.capsule-session {
  flex-shrink: 1;
  min-width: 38px;
  max-width: 190px;
}

.capsule-tokens {
  flex-shrink: 2;
  min-width: 38px;
  max-width: 230px;
}

/* 状态 1：标准紧凑 (400px ~ 460px) - 隐藏 "命中" 冗余词汇 */
.hud-container.is-compact .hud-cache-label {
  display: none;
}

@container hud (max-width: 440px) {
  .hud-cache-label {
    display: none;
  }
}

/* 状态 2：极限紧凑 (< 360px) - 仅保留步数与总量 */
.hud-container.is-ultra-compact .hud-turns,
.hud-container.is-ultra-compact .hud-speed,
.hud-container.is-ultra-compact .hud-tok-cache {
  display: none !important;
}

@container hud (max-width: 360px) {
  .hud-turns,
  .hud-speed,
  .hud-tok-cache {
    display: none !important;
  }
}

/* ==================== 向上展开详情卡片 (Upward Popover) ==================== */
/* 外层定位壳设置 overflow: visible，防止底部 -6px 指示小三角被 overflow 裁切 */
.hud-popover {
  position: fixed;
  box-sizing: border-box;
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 48px);
  overflow: visible;
  border-radius: 12px;
  background-color: var(--hud-popover-bg);
  border: 1px solid var(--hud-popover-border);
  box-shadow: var(--hud-popover-shadow);
  z-index: 2147483640;
  pointer-events: auto;
  user-select: text;
  -webkit-user-select: text;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", Roboto, sans-serif;
  color: var(--hud-text-primary);
  opacity: 0;
  transform: translateY(4px) scale(0.985);
  transition: opacity 130ms cubic-bezier(0.16, 1, 0.3, 1), transform 130ms cubic-bezier(0.16, 1, 0.3, 1);
}

.hud-popover.is-visible {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.hud-popover[hidden] {
  display: none !important;
}

.hud-popover-inner {
  box-sizing: border-box;
  width: 100%;
  max-height: inherit;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px 14px;
  border-radius: 12px;
}

.hud-popover-arrow {
  position: absolute;
  bottom: -6px;
  width: 14px;
  height: 6px;
  transform: translateX(-50%);
  pointer-events: none;
  z-index: 2;
}

.hud-popover-arrow svg {
  display: block;
  width: 14px;
  height: 6px;
}

.hud-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  line-height: 1.25;
}

.hud-popover-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 600;
  color: var(--hud-text-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hud-popover-title-regular {
  font-weight: 400;
  color: var(--hud-text-secondary);
}

.hud-popover-title-strong {
  font-weight: 600;
  color: var(--hud-text-primary);
  font-variant-numeric: tabular-nums;
}

.hud-popover-badge {
  font-size: 12px;
  font-weight: 600;
  color: var(--hud-text-primary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  flex-shrink: 0;
}

.hud-popover-badge-muted {
  font-size: 12px;
  font-weight: 500;
  color: var(--hud-text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  flex-shrink: 0;
}

.hud-popover-divider {
  height: 1px;
  width: 100%;
  background-color: var(--hud-divider);
  margin: 8px 0;
}

.hud-popover-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hud-popover-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  line-height: 1.35;
}

.hud-popover-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--hud-text-secondary);
  font-size: 12px;
  font-weight: 400;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hud-popover-val {
  color: var(--hud-text-primary);
  font-size: 12px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  flex-shrink: 0;
}

/* 三段分段进度条 */
.hud-progress-track {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  width: 100%;
  height: 6px;
  border-radius: 9999px;
  background-color: var(--hud-progress-track);
  overflow: hidden;
  margin: 9px 0 10px 0;
}

.hud-progress-seg {
  height: 100%;
  transition: width 180ms ease;
}

.hud-seg-sys {
  background-color: var(--hud-seg-sys-color);
}

.hud-seg-tool {
  background-color: var(--hud-seg-tool-color);
}

.hud-seg-msg {
  background-color: var(--hud-seg-msg-color);
}

.hud-legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}
`;

globalThis.__GRAVITYBOX_HUD_STYLES_CSS__ = HUD_STYLES_CSS;
