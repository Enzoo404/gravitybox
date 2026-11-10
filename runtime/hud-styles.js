/**
 * GravityBox Conversation Status HUD & Upward Popover 样式与 Design Tokens (v2.1 Antigravity Native UI)
 * 原生融合 Google Antigravity (.surface-composer / bg-card / Zenith Blue) 设计语言
 * 支持浅色/深色双模、@container 响应式容器查询、微光骨架屏动效与外层防裁切小三角
 */

export const HUD_STYLES_CSS = `
:host {
  /* ==================== 浅色模式 (Antigravity Light Theme) ==================== */
  --hud-dock-bg: rgba(10, 10, 12, 0.032);
  --hud-dock-border: rgba(10, 10, 12, 0.075);
  --hud-dock-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.65);
  --hud-bg: transparent;
  --hud-bg-hover: rgba(255, 255, 255, 0.88);
  --hud-bg-active: #FFFFFF;
  --hud-border: transparent;
  --hud-border-hover: rgba(10, 10, 12, 0.07);
  --hud-seg-shadow-hover: 0 1px 2.5px rgba(10, 10, 12, 0.06);
  --hud-text-primary: #0A0A0C;
  --hud-text-secondary: #52525B;
  --hud-text-muted: #71717A;
  --hud-popover-bg: rgba(255, 255, 255, 0.98);
  --hud-popover-border: rgba(10, 10, 12, 0.085);
  --hud-popover-shadow: 0 12px 32px -4px rgba(10, 10, 12, 0.12), 0 4px 12px -2px rgba(10, 10, 12, 0.06);
  --hud-badge-bg: rgba(10, 10, 12, 0.045);
  --hud-divider: rgba(10, 10, 12, 0.08);
  --hud-progress-track: rgba(10, 10, 12, 0.065);

  /* Antigravity 原生品牌语义色 (Zenith Blue & Sky Cyan) */
  --hud-accent-blue: #3186FF;
  --hud-accent-cyan: #0EA5E9;
  --hud-accent-emerald: #10B981;
  --hud-seg-sys-color: #3186FF;
  --hud-seg-tool-color: #38BDF8;
  --hud-seg-msg-color: #10B981;
  --hud-warn-color: #F59E0B;
  --hud-danger-color: #EF4444;

  /* 骨架屏扫描动效 Tokens (Light) */
  --hud-skeleton-base: rgba(10, 10, 12, 0.04);
  --hud-skeleton-highlight: rgba(10, 10, 12, 0.10);

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
  /* ==================== 深色模式 (Antigravity Dark Theme) ==================== */
  --hud-dock-bg: rgba(255, 255, 255, 0.04);
  --hud-dock-border: rgba(255, 255, 255, 0.085);
  --hud-dock-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  --hud-bg: transparent;
  --hud-bg-hover: rgba(255, 255, 255, 0.085);
  --hud-bg-active: rgba(255, 255, 255, 0.12);
  --hud-border: transparent;
  --hud-border-hover: rgba(255, 255, 255, 0.10);
  --hud-seg-shadow-hover: 0 1px 3px rgba(0, 0, 0, 0.35);
  --hud-text-primary: #F4F4F6;
  --hud-text-secondary: #A1A1AA;
  --hud-text-muted: #71717A;
  --hud-popover-bg: #16171B;
  --hud-popover-border: rgba(255, 255, 255, 0.10);
  --hud-popover-shadow: 0 16px 40px -6px rgba(0, 0, 0, 0.60), 0 6px 16px rgba(0, 0, 0, 0.40);
  --hud-badge-bg: rgba(255, 255, 255, 0.07);
  --hud-divider: rgba(255, 255, 255, 0.09);
  --hud-progress-track: rgba(255, 255, 255, 0.10);

  /* Antigravity 原生品牌语义色 (Dark) */
  --hud-accent-blue: #589BFF;
  --hud-accent-cyan: #38BDF8;
  --hud-accent-emerald: #34D399;
  --hud-seg-sys-color: #589BFF;
  --hud-seg-tool-color: #38BDF8;
  --hud-seg-msg-color: #34D399;
  --hud-warn-color: #FBBF24;
  --hud-danger-color: #F87171;

  /* 骨架屏扫描动效 Tokens (Dark) */
  --hud-skeleton-base: rgba(255, 255, 255, 0.05);
  --hud-skeleton-highlight: rgba(255, 255, 255, 0.13);
}

@keyframes hud-shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

@keyframes hud-pulse-dot {
  0%, 100% {
    transform: scale(1);
    opacity: 1;
    box-shadow: 0 0 0 0 rgba(49, 134, 255, 0.45);
  }
  50% {
    transform: scale(1.12);
    opacity: 0.85;
    box-shadow: 0 0 0 3px rgba(49, 134, 255, 0);
  }
}

/* Antigravity 原生一体化分段遥测底座 */
.hud-container {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 0;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  height: 24px;
  overflow: hidden;
  box-sizing: border-box;
  container-type: inline-size;
  container-name: hud;
}

.hud-dock-surface {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 2px;
  max-width: 100%;
  min-width: 0;
  height: 24px;
  padding: 2px 3px;
  border-radius: 8px;
  background-color: var(--hud-dock-bg);
  border: 1px solid var(--hud-dock-border);
  box-shadow: var(--hud-dock-shadow);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-sizing: border-box;
  overflow: hidden;
  pointer-events: auto;
}

.hud-seg-sep {
  width: 1px;
  height: 11px;
  background-color: var(--hud-divider);
  flex-shrink: 0;
  margin: 0 1px;
  pointer-events: none;
}

.capsule {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border-radius: 5.5px;
  background-color: var(--hud-bg);
  border: 1px solid var(--hud-border);
  color: var(--hud-text-secondary);
  font-family: "Google Sans Text", "Google Sans", -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: -0.005em;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  outline: none;
  pointer-events: auto;
  user-select: none;
  -webkit-user-select: none;
  box-sizing: border-box;
  overflow: hidden;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, box-shadow 120ms ease;
}

.capsule:hover,
.capsule.is-active,
.capsule:focus-visible {
  background-color: var(--hud-bg-hover);
  border-color: var(--hud-border-hover);
  color: var(--hud-text-primary);
  box-shadow: var(--hud-seg-shadow-hover);
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
.capsule.is-skeleton .capsule-donut,
.capsule.is-skeleton .hud-status-dot {
  opacity: 0.35;
}

/* Antigravity 原生状态指示点 (替代秒表图标) */
.hud-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background-color: var(--hud-text-muted);
  flex-shrink: 0;
  margin-right: 5px;
  transition: background-color 150ms ease, box-shadow 150ms ease;
}

.capsule:hover .hud-status-dot,
.capsule.is-active .hud-status-dot {
  background-color: var(--hud-accent-blue);
}

.capsule.is-streaming .hud-status-dot {
  background-color: var(--hud-accent-blue);
  animation: hud-pulse-dot 1.4s ease-in-out infinite;
}

.capsule-icon {
  width: 11px;
  height: 11px;
  flex-shrink: 0;
  margin-right: 4px;
  color: var(--hud-accent-blue);
  opacity: 0.85;
}

/* Antigravity 原生横向微缩计量条 (替代 DeepSeek 圆环图) */
.capsule-donut {
  width: 18px;
  height: 8px;
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
  min-width: 88px;
  justify-content: center;
  padding-inline: 12px;
}

.capsule-session {
  flex-shrink: 1;
  min-width: 38px;
  max-width: 320px;
}

.hud-subagent-tag {
  color: var(--hud-accent-blue);
  font-weight: 500;
}

.capsule-tokens {
  flex-shrink: 2;
  min-width: 38px;
  max-width: 260px;
}

/* 状态 1：标准紧凑 (360px ~ 440px) - 隐藏 "命中" 冗余词汇 */
.hud-container.is-compact .hud-cache-label {
  display: none;
}

@container hud (max-width: 440px) {
  .hud-cache-label {
    display: none;
  }
}

/* 状态 2：极限紧凑 (< 360px) - 仅保留核心步数、总量与上下文读数 */
.hud-container.is-ultra-compact .hud-turns,
.hud-container.is-ultra-compact .hud-speed,
.hud-container.is-ultra-compact .hud-subagent-tag,
.hud-container.is-ultra-compact .hud-tok-cache,
.hud-container.is-ultra-compact .hud-ctx-pct-suffix {
  display: none !important;
}

@container hud (max-width: 360px) {
  .capsule-context {
    min-width: fit-content;
    padding-inline: 7px;
  }
  .hud-turns,
  .hud-speed,
  .hud-subagent-tag,
  .hud-tok-cache,
  .hud-ctx-pct-suffix {
    display: none !important;
  }
}

/* ==================== 向上展开详情卡片 (Antigravity Native Upward Popover) ==================== */
/* 外层定位壳设置 overflow: visible，防止底部 -6px 指示小三角被 overflow 裁切 */
.hud-popover {
  position: fixed;
  inset: auto;
  margin: 0;
  padding: 0;
  box-sizing: border-box;
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 48px);
  overflow: visible;
  border-radius: 12px;
  background-color: var(--hud-popover-bg);
  border: 1px solid var(--hud-popover-border);
  box-shadow: var(--hud-popover-shadow);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  z-index: 2147483640;
  pointer-events: auto;
  user-select: text;
  -webkit-user-select: text;
  font-family: "Google Sans Text", "Google Sans", -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
  color: var(--hud-text-primary);
  opacity: 0;
  transform: translateY(4px) scale(0.985);
  transition: opacity 130ms cubic-bezier(0.16, 1, 0.3, 1), transform 130ms cubic-bezier(0.16, 1, 0.3, 1);
}

/* 透明悬停桥接层：消除鼠标从底部状态栏移向 Popover 时跨越 8px 间隙导致的闪烁关闭 */
.hud-popover::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: -10px;
  height: 10px;
  background: transparent;
  pointer-events: auto;
}

.hud-popover.is-visible {
  opacity: 1;
  transform: translateY(0) scale(1);
}

@starting-style {
  .hud-popover.is-visible {
    opacity: 0;
    transform: translateY(4px) scale(0.985);
  }
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
  bottom: -5.5px;
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
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  line-height: 1.25;
}

.hud-popover-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--hud-text-primary);
  min-width: 0;
  flex-wrap: wrap;
  white-space: normal;
  overflow-wrap: anywhere;
}

.hud-popover-title-regular {
  font-weight: 500;
  color: var(--hud-text-secondary);
}

.hud-popover-title-strong {
  font-weight: 600;
  color: var(--hud-text-primary);
  font-variant-numeric: tabular-nums;
}

.hud-popover-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 6.5px;
  border-radius: 6px;
  background-color: var(--hud-badge-bg);
  font-size: 11px;
  font-weight: 600;
  color: var(--hud-text-primary);
  font-variant-numeric: tabular-nums;
  max-width: 100%;
  box-sizing: border-box;
  white-space: normal;
  overflow-wrap: anywhere;
}

.hud-popover-badge-muted {
  display: inline-flex;
  align-items: center;
  padding: 2px 6.5px;
  border-radius: 6px;
  background-color: var(--hud-badge-bg);
  font-size: 11px;
  font-weight: 500;
  color: var(--hud-text-secondary);
  font-variant-numeric: tabular-nums;
  max-width: 100%;
  box-sizing: border-box;
  white-space: normal;
  overflow-wrap: anywhere;
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
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
  align-items: start;
  gap: 8px;
  line-height: 1.35;
}

.hud-popover-row[hidden] {
  display: none !important;
}

.hud-popover-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--hud-text-secondary);
  font-size: 11.5px;
  font-weight: 400;
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}

.hud-popover-val {
  color: var(--hud-text-primary);
  font-size: 11.5px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  min-width: 0;
  text-align: right;
  white-space: normal;
  overflow-wrap: anywhere;
}

@media (prefers-reduced-motion: reduce) {
  .capsule,
  .hud-status-dot,
  .hud-popover,
  .hud-progress-seg {
    transition: none !important;
  }
  .capsule.is-skeleton,
  .capsule.is-streaming .hud-status-dot {
    animation: none !important;
  }
}

/* Antigravity 原生上下文构成进度条 */
.hud-progress-track {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  width: 100%;
  height: 5px;
  border-radius: 9999px;
  background-color: var(--hud-progress-track);
  overflow: hidden;
  margin: 8px 0 10px 0;
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
  width: 7px;
  height: 7px;
  border-radius: 9999px;
  flex-shrink: 0;
}
`;

globalThis.__GRAVITYBOX_HUD_STYLES_CSS__ = HUD_STYLES_CSS;
