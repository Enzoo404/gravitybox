import { HUD_STYLES_CSS } from './hud-styles.js';
import { computeUpwardPopoverPosition, applyPopoverGeometry } from './hud-popover.js';

/**
 * 单分栏自治 HUD 实例 (HudInstance - Antigravity Native v2.1)
 * 包含：
 * 1. 输入框底边与应用底端之间的精确垂直居中平衡器 (syncVerticalCentering)
 * 2. Antigravity 原生一体化分段遥测条与向上展开卡片（完全移除原生 title 悬浮提示避免遮挡）
 * 3. 子智能体运行状态实时感知与展示（支持 DOM + SQLite 双栈子智能体追踪）
 * 4. 100% 真实会话底层指标渲染（零虚构 1M 上限，零硬编码 1.9K/7.6K 提示词，修正思维链模型 TPS/TTFT）
 * 5. Open Shadow DOM 双向隔离、AbortController 信号守卫与双重令牌防篡改
 */

const POPOVER_WIDTHS = {
  session: 296,
  tokens: 296,
  context: 312,
};

const DONUT_CIRCUMFERENCE = 37.699;

function isRawNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function formatInteger(value) {
  return Math.floor(value).toLocaleString('en-US');
}

function formatDetailCompactNumber(value, trimTrailingZeros = false) {
  if (value >= 999_995) {
    const formatted = (value / 1_000_000).toFixed(2);
    const cleaned = trimTrailingZeros ? formatted.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1') : formatted;
    return `${cleaned}M`;
  }
  if (value >= 1_000) {
    const formatted = (value / 1_000).toFixed(2);
    const cleaned = trimTrailingZeros ? formatted.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1') : formatted;
    return `${cleaned}K`;
  }
  return formatInteger(value);
}

function formatTokenCount(value, fallback) {
  if (isRawNumber(value)) {
    return `${formatDetailCompactNumber(value)} tok`;
  }
  if (!fallback) return '0 tok';
  if (fallback === '—') return '—';
  const cleanedText = String(fallback).replace(/[,~\s]|tok$/gi, '');
  const parsedValue = Number(cleanedText);
  if (Number.isFinite(parsedValue) && parsedValue >= 0) {
    return `${formatDetailCompactNumber(parsedValue)} tok`;
  }
  return String(fallback).endsWith('tok') ? String(fallback) : `${fallback} tok`;
}

function formatCompactCount(value, fallback = '0') {
  if (!isRawNumber(value)) {
    return String(fallback).replace(/\d+\.\d+/g, (number) => String(Math.round(Number(number))));
  }
  if (value >= 999_500) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return formatInteger(value);
}

function formatMetric(value, formatted, digits, suffix) {
  if (formatted === '—' || !isRawNumber(value)) return '—';
  return `${digits === 0 ? Math.round(value) : value.toFixed(digits)}${suffix}`;
}

function formatPercent(value, formatted, digits) {
  return formatMetric(isRawNumber(value) ? value * 100 : NaN, formatted, digits, '%');
}

function formatDuration(value, formatted, isEn) {
  if (formatted === '—' || !isRawNumber(value)) return '—';
  const totalSeconds = Math.round(value);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return isEn ? `${seconds}s` : `${seconds} 秒`;
  return isEn ? `${minutes}m ${seconds}s` : `${minutes} 分 ${seconds} 秒`;
}

function createDefaultMetrics(conversationId = 'default', sessionRevision = 1) {
  return {
    conversationId,
    sessionRevision,
    updatedAt: Date.now(),
    isStreaming: false,
    isSubagentRunning: false,
    runningSubagentCount: 0,
    session: {
      turns: 0,
      steps: 0,
      modelSteps: 0,
      toolSteps: 0,
      compactionCount: 0,
      subagentCount: 0,
      runningSubagentCount: 0,
      subagentSteps: 0,
      modelDurationSeconds: 0,
      modelDurationFormatted: '0 秒',
      modelDurationFormattedEn: '0s',
      toolDurationSeconds: 0,
      toolDurationFormatted: '0 秒',
      toolDurationFormattedEn: '0s',
      averageTtftSeconds: 0,
      averageTtftFormatted: '—',
      averageTtftFormattedEn: '—',
      outputTps: 0,
      outputTpsFormatted: '—',
    },
    tokens: {
      totalTokens: 0,
      totalTokensCompact: '0 tok',
      totalTokensFormatted: '0 tok',
      cacheHitRate: 0,
      cacheHitRateFormatted: '0%',
      uncachedInputTokens: 0,
      uncachedInputFormatted: '0 tok',
      cachedReadTokens: 0,
      cachedReadFormatted: '0 tok',
      outputTokens: 0,
      outputFormatted: '0 tok',
    },
    context: {
      hasUsageData: false,
      modelId: 'gemini-3.8-flash',
      modelDisplayName: 'Gemini 3.8 Flash',
      usedTokens: 0,
      usedTokensCompact: '0',
      usedTokensFormatted: '0 tok',
      peakContextTokens: 0,
      peakContextCompact: '0',
      peakContextFormatted: '0 tok',
      capacityTokens: 0,
      capacityTokensCompact: '—',
      usedRatio: 0,
      usedRatioFormatted: '0%',
      stepCacheRatio: 0,
      stepCacheRatioFormatted: '0%',
      breakdown: {
        cachedContextTokens: 0,
        cachedContextFormatted: '0 tok',
        cachedContextRatio: 0,
        uncachedContextTokens: 0,
        uncachedContextFormatted: '0 tok',
        uncachedContextRatio: 0,
        latestOutputTokens: 0,
        latestOutputFormatted: '0 tok',
        systemTokens: 0,
        systemTokensCompact: '0 tok',
        systemRatio: 0,
        toolTokens: 0,
        toolTokensCompact: '0 tok',
        toolRatio: 0,
        messageTokens: 0,
        messageTokensCompact: '0 tok',
        messageRatio: 0,
      },
    },
  };
}

export class HudInstance {
  constructor(cascadeId, options = {}) {
    this.cascadeId = cascadeId || 'default-pane';
    this.isPrimaryPane = Boolean(options.isPrimaryPane);
    this.languageMode = options.languageMode === 'en' ? 'en' : 'zh';
    this.onBridgeEvent = typeof options.onBridgeEvent === 'function' ? options.onBridgeEvent : null;
    this.currentConvId = null;
    this.sessionRevision = 0;
    this.currentModelId = 'gemini-3.8-flash';
    this.domIsStreaming = false;
    this.domIsSubagentRunning = false;
    this.domRunningSubagentCount = 0;
    this.backendIsSubagentRunning = false;
    this.backendRunningSubagentCount = 0;
    this.childConversationIds = [];
    this.isStreaming = false;
    this.isSubagentRunning = false;
    this.runningSubagentCount = 0;
    this.abortController = null;
    this.resizeObserver = null;
    this.host = null;
    this.shadow = null;
    this.targetComposer = null;
    this.modifiedAncestors = new Map();
    this.activePopoverId = null;
    this.pinnedPopoverId = null;
    this.hoverEnterTimer = null;
    this.hoverLeaveTimer = null;
    this.lastMetrics = createDefaultMetrics('default', 0);
  }

  getCurrentConvId() {
    return this.currentConvId;
  }

  getSessionRevision() {
    return this.sessionRevision;
  }

  switchConversation(
    newConvId,
    modelId = null,
    isStreaming = false,
    isSubagentRunning = false,
    runningSubagentCount = 0,
    childConversationIds = null
  ) {
    if (!newConvId) return this.sessionRevision;
    const changed = this.currentConvId !== newConvId;
    this.currentConvId = newConvId;
    if (modelId) this.currentModelId = modelId;
    this.domIsSubagentRunning = Boolean(isSubagentRunning);
    this.domRunningSubagentCount = Math.max(0, Number(runningSubagentCount) || 0);
    this.domIsStreaming = Boolean(isStreaming || this.domIsSubagentRunning);
    if (Array.isArray(childConversationIds)) {
      this.childConversationIds = [...new Set(childConversationIds.filter(Boolean))];
    } else if (changed) {
      this.childConversationIds = [];
    }
    if (changed) {
      this.backendIsSubagentRunning = false;
      this.backendRunningSubagentCount = 0;
      this.isSubagentRunning = this.domIsSubagentRunning;
      this.runningSubagentCount = this.domRunningSubagentCount;
      this.isStreaming = this.domIsStreaming;
      this.sessionRevision++;
      this.pinnedPopoverId = null;
      this.lastMetrics = createDefaultMetrics(newConvId, this.sessionRevision);
      this.renderSkeleton();
      this.syncStreamingClass();
      this.emitBridgeEvent('SESSION_ATTACHED');
    } else {
      this.isSubagentRunning = Boolean(this.domIsSubagentRunning || this.backendIsSubagentRunning);
      this.runningSubagentCount = Math.max(
        this.domRunningSubagentCount,
        this.backendRunningSubagentCount
      );
      this.isStreaming = Boolean(this.domIsStreaming || this.isSubagentRunning);
      this.syncStreamingClass();
    }
    return this.sessionRevision;
  }

  notifyModelOrStreamingChange(
    modelId,
    isStreaming,
    isSubagentRunning = false,
    runningSubagentCount = 0,
    childConversationIds = null
  ) {
    let changed = false;
    if (modelId && modelId !== this.currentModelId) {
      this.currentModelId = modelId;
      changed = true;
      this.emitBridgeEvent('MODEL_CHANGED');
    }
    const nextDomSubagentRunning = Boolean(isSubagentRunning);
    const nextDomSubagentCount = Math.max(0, Number(runningSubagentCount) || 0);
    const nextDomStreaming = Boolean(isStreaming || nextDomSubagentRunning);
    const nextChildIds = Array.isArray(childConversationIds)
      ? [...new Set(childConversationIds.filter(Boolean))]
      : this.childConversationIds;
    const childIdsChanged = nextChildIds.join(',') !== this.childConversationIds.join(',');

    if (
      nextDomStreaming !== this.domIsStreaming ||
      nextDomSubagentRunning !== this.domIsSubagentRunning ||
      nextDomSubagentCount !== this.domRunningSubagentCount ||
      childIdsChanged
    ) {
      this.domIsStreaming = nextDomStreaming;
      this.domIsSubagentRunning = nextDomSubagentRunning;
      this.domRunningSubagentCount = nextDomSubagentCount;
      this.childConversationIds = nextChildIds;
      this.isSubagentRunning = Boolean(this.domIsSubagentRunning || this.backendIsSubagentRunning);
      this.runningSubagentCount = Math.max(
        this.domRunningSubagentCount,
        this.backendRunningSubagentCount
      );
      this.isStreaming = Boolean(this.domIsStreaming || this.isSubagentRunning);
      this.syncStreamingClass();
      if (this.lastMetrics && this.shadow) {
        this.applyMetricsToDom({
          ...this.lastMetrics,
          isStreaming: this.isStreaming,
          isSubagentRunning: this.isSubagentRunning,
          runningSubagentCount: this.runningSubagentCount,
        });
      }
      changed = true;
      this.emitBridgeEvent('STREAMING_CHANGED');
    }
    return changed;
  }

  requestRefresh() {
    if (!this.currentConvId) return;
    this.emitBridgeEvent('REQUEST_REFRESH');
  }

  emitBridgeEvent(type) {
    if (!this.currentConvId) return;
    const payload = {
      type,
      conversationId: this.currentConvId,
      cascadeId: this.cascadeId,
      sessionRevision: this.sessionRevision,
      modelId: this.currentModelId,
      isStreaming: this.domIsStreaming,
      isSubagentRunning: this.domIsSubagentRunning,
      runningSubagentCount: this.domRunningSubagentCount,
      ...(this.childConversationIds.length > 0
        ? { childConversationIds: this.childConversationIds }
        : {}),
      timestamp: Date.now(),
    };
    if (this.onBridgeEvent) {
      try {
        this.onBridgeEvent(payload);
      } catch {}
    }
    if (typeof globalThis.__gravityboxHudBridge === 'function') {
      try {
        globalThis.__gravityboxHudBridge(JSON.stringify(payload));
      } catch {}
    }
  }

  updateMetrics(metrics) {
    if (!metrics || typeof metrics !== 'object') return false;
    // 双重防线校验：杜绝跨会话交叉污染与 A->B->A 极速连切迟到数据篡改
    if (
      metrics.conversationId !== this.currentConvId ||
      (typeof metrics.sessionRevision === 'number' && metrics.sessionRevision < this.sessionRevision)
    ) {
      return false;
    }
    this.backendIsSubagentRunning = Boolean(metrics.isSubagentRunning);
    this.backendRunningSubagentCount = Math.max(
      0,
      Number(metrics.runningSubagentCount) || 0,
      Number(metrics.session?.runningSubagentCount) || 0
    );
    const mergedSubagentRunning = Boolean(
      this.backendIsSubagentRunning || this.domIsSubagentRunning
    );
    const mergedSubagentCount = Math.max(
      this.backendRunningSubagentCount,
      this.domRunningSubagentCount
    );
    this.isSubagentRunning = mergedSubagentRunning;
    this.runningSubagentCount = mergedSubagentCount;
    this.isStreaming = Boolean(metrics.isStreaming || this.domIsStreaming || mergedSubagentRunning);
    this.lastMetrics = {
      ...metrics,
      isStreaming: this.isStreaming,
      isSubagentRunning: mergedSubagentRunning,
      runningSubagentCount: mergedSubagentCount,
    };
    this.applyMetricsToDom(this.lastMetrics);
    return true;
  }

  setLanguage(mode) {
    const next = mode === 'en' ? 'en' : 'zh';
    if (this.languageMode === next) return;
    this.languageMode = next;
    if (this.lastMetrics && this.shadow) {
      this.applyMetricsToDom(this.lastMetrics);
    }
  }

  syncTheme() {
    if (!this.host || typeof document === 'undefined') return;
    const bodyCls = document.body?.classList;
    const htmlCls = document.documentElement?.classList;
    const bodyDataTheme = (document.body?.getAttribute?.('data-theme') || '').toLowerCase();
    const htmlDataTheme = (document.documentElement?.getAttribute?.('data-theme') || '').toLowerCase();

    const explicitDark =
      bodyCls?.contains('theme-dark') ||
      bodyCls?.contains('dark') ||
      bodyCls?.contains('dark-theme') ||
      bodyCls?.contains('vs-dark') ||
      htmlCls?.contains('dark') ||
      htmlCls?.contains('theme-dark') ||
      bodyDataTheme.includes('dark') ||
      htmlDataTheme.includes('dark');

    const explicitLight =
      bodyCls?.contains('theme-light') ||
      bodyCls?.contains('light') ||
      bodyCls?.contains('light-theme') ||
      htmlCls?.contains('light') ||
      htmlCls?.contains('theme-light') ||
      bodyDataTheme.includes('light') ||
      htmlDataTheme.includes('light');

    let isDark = false;
    if (explicitDark) {
      isDark = true;
    } else if (explicitLight) {
      isDark = false;
    } else {
      let resolvedByComputed = false;
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try {
          const csScheme = (window.getComputedStyle(document.documentElement).colorScheme || '').toLowerCase();
          if (csScheme === 'dark') {
            isDark = true;
            resolvedByComputed = true;
          } else if (csScheme === 'light') {
            isDark = false;
            resolvedByComputed = true;
          } else if (document.body) {
            const bg = window.getComputedStyle(document.body).backgroundColor || '';
            const rgb = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
            if (rgb) {
              const lum = 0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3]);
              if (lum > 0 || !bg.includes('0, 0, 0, 0')) {
                isDark = lum < 128;
                resolvedByComputed = true;
              }
            }
          }
        } catch {}
      }
      if (!resolvedByComputed) {
        isDark = Boolean(
          typeof window !== 'undefined' &&
            window.matchMedia?.('(prefers-color-scheme: dark)')?.matches
        );
      }
    }

    if (isDark) {
      if (this.host.getAttribute('data-theme') !== 'dark') {
        this.host.setAttribute('data-theme', 'dark');
      }
    } else if (this.host.hasAttribute('data-theme')) {
      this.host.removeAttribute('data-theme');
    }
  }

  syncVerticalCentering() {
    if (!this.host || !this.targetComposer) return;

    const win = typeof window !== 'undefined' ? window : globalThis.window;
    let cur = this.targetComposer.parentNode;
    let depth = 0;
    let foundBottomWrapper = false;

    while (cur && depth < 7) {
      if (cur.nodeType === 1) {
        const testId = cur.getAttribute?.('data-testid');
        const dropScope = cur.getAttribute?.('data-media-drop-scope');
        if (testId === 'conversation-view' || dropScope === 'subpane') break;

        const cls = typeof cur.className === 'string' ? cur.className : '';
        const hasTailwindBottomPad = /\bpb-(?:3|4|5|6|8)\b/.test(cls);
        const alreadyTracked = this.modifiedAncestors.has(cur);
        let computedPb = 0;
        if (!hasTailwindBottomPad && !alreadyTracked && win && typeof win.getComputedStyle === 'function') {
          try {
            computedPb = parseFloat(win.getComputedStyle(cur).paddingBottom || '0') || 0;
          } catch {}
        }

        if (hasTailwindBottomPad || alreadyTracked || computedPb >= 10) {
          if (!alreadyTracked) {
            const rawInlinePb = cur.style?.paddingBottom ?? '';
            const savedPb = hasTailwindBottomPad && rawInlinePb === '0px' ? '' : rawInlinePb;
            this.modifiedAncestors.set(cur, savedPb);
          }
          if (cur.style && cur.style.paddingBottom !== '0px') {
            cur.style.paddingBottom = '0px';
          }
          foundBottomWrapper = true;
        }
      }
      cur = cur.parentNode;
      depth++;
    }

    const targetTop = foundBottomWrapper ? '7px' : '4px';
    const targetBottom = foundBottomWrapper ? '7px' : '0px';
    if (this.host.style.marginTop !== targetTop) {
      this.host.style.marginTop = targetTop;
    }
    if (this.host.style.marginBottom !== targetBottom) {
      this.host.style.marginBottom = targetBottom;
    }
  }

  restoreModifiedAncestors() {
    for (const [el, origPb] of this.modifiedAncestors.entries()) {
      try {
        if (el && el.style) {
          el.style.paddingBottom = origPb;
        }
      } catch {}
    }
    this.modifiedAncestors.clear();
  }

  mount(targetComposer) {
    if (!targetComposer) return;
    this.cleanupListeners();
    this.restoreModifiedAncestors();
    this.targetComposer = targetComposer;

    const doc = targetComposer.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;

    this.host = doc.createElement('div');
    this.host.id = this.isPrimaryPane
      ? '__gravitybox_hud_host__'
      : `__gravitybox_hud_host_${this.cascadeId}__`;
    this.host.className = '__gravitybox_hud_host__';
    this.host.setAttribute('data-agzh-protect', 'true');
    this.host.setAttribute('data-gravitybox-hud', 'v2');
    this.host.setAttribute('data-cascade-id', this.cascadeId);

    Object.assign(this.host.style, {
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      width: '100%',
      height: '24px',
      marginTop: '4px',
      marginBottom: '0px',
      pointerEvents: 'none',
      userSelect: 'none',
      transform: 'none',
      filter: 'none',
      boxSizing: 'border-box',
    });

    this.syncTheme();

    this.shadow = this.host.attachShadow({ mode: 'open' });
    const stylesCss =
      typeof HUD_STYLES_CSS === 'string'
        ? HUD_STYLES_CSS
        : globalThis.__GRAVITYBOX_HUD_STYLES_CSS__ || '';
    this.shadow.innerHTML = `<style>${stylesCss}</style>${this.buildHudHtml()}`;

    if (typeof targetComposer.insertAdjacentElement === 'function') {
      targetComposer.insertAdjacentElement('afterend', this.host);
    } else if (targetComposer.parentNode) {
      targetComposer.parentNode.appendChild(this.host);
    }

    this.syncVerticalCentering();
    const initialWidth =
      typeof targetComposer.getBoundingClientRect === 'function'
        ? targetComposer.getBoundingClientRect()?.width ?? 0
        : targetComposer.clientWidth ?? 0;
    if (initialWidth > 0) {
      this.handleContainerResize(initialWidth);
    }
    this.bindEvents(targetComposer);
    if (this.lastMetrics) {
      this.applyMetricsToDom(this.lastMetrics);
    }
  }

  reconcile(targetComposer) {
    if (!targetComposer) return;
    if (!this.host || !this.host.isConnected) {
      this.mount(targetComposer);
      return;
    }
    this.targetComposer = targetComposer;
    if (this.host.previousElementSibling !== targetComposer) {
      if (typeof targetComposer.insertAdjacentElement === 'function') {
        targetComposer.insertAdjacentElement('afterend', this.host);
      }
    }
    this.syncVerticalCentering();
    this.syncTheme();
  }

  buildHudHtml() {
    return `
      <div class="hud-container" id="hud-toolbar" role="toolbar" aria-label="Antigravity 会话遥测状态栏">
        <div class="hud-dock-surface">
          <!-- 分段 1: 会话与执行耗时 (移除原生 title 提示，杜绝遮挡上浮卡片) -->
          <button type="button" class="capsule capsule-session" data-capsule-id="session" aria-haspopup="dialog" aria-expanded="false" aria-label="会话统计明细">
            <span class="hud-status-dot" aria-hidden="true"></span>
            <span class="capsule-text" id="hud-txt-session">
              <span class="hud-turns">0 轮 </span><span class="hud-steps">0 步</span><span class="hud-speed"> · —</span><span class="hud-subagent-tag"></span>
            </span>
          </button>

          <span class="hud-seg-sep" aria-hidden="true"></span>

          <!-- 分段 2: 累计 Token 账本 (移除原生 title 提示，杜绝遮挡上浮卡片) -->
          <button type="button" class="capsule capsule-tokens" data-capsule-id="tokens" aria-haspopup="dialog" aria-expanded="false" aria-label="Token 用量明细">
            <svg class="capsule-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1.2L9.9 6.1L14.8 8L9.9 9.9L8 14.8L6.1 9.9L1.2 8L6.1 6.1L8 1.2Z" fill="currentColor"/>
            </svg>
            <span class="capsule-text" id="hud-txt-tokens">
              <span class="hud-tok-total">0 tok</span><span class="hud-tok-cache"><span class="hud-cache-dot"> · </span><span class="hud-cache-prefix">缓存</span><span class="hud-cache-label">命中</span><span class="hud-cache-space"> </span><span class="hud-cache-val">0%</span></span>
            </span>
          </button>

          <span class="hud-seg-sep" aria-hidden="true"></span>

          <!-- 分段 3: 当前上下文实况 (移除原生 title 提示，杜绝遮挡上浮卡片) -->
          <button type="button" class="capsule capsule-context" data-capsule-id="context" aria-haspopup="dialog" aria-expanded="false" aria-label="当前上下文实况明细">
            <svg class="capsule-donut" viewBox="0 0 56 8" aria-hidden="true">
              <rect x="0.5" y="1.5" width="55" height="5" rx="2.5" fill="var(--hud-progress-track)" stroke="var(--hud-divider)" stroke-width="0.6"/>
              <circle class="donut-val" id="hud-donut-val" cx="4" cy="4" r="6" stroke="var(--hud-seg-sys-color)" stroke-width="0" fill="none" stroke-dasharray="37.699" stroke-dashoffset="37.699"/>
              <rect id="hud-meter-fill" x="1" y="2" width="0" height="4" rx="2" fill="var(--hud-seg-sys-color)"/>
            </svg>
            <span class="capsule-text" id="hud-txt-context">0%</span>
          </button>
        </div>
      </div>

      <!-- 向上展开详情卡片 1: 会话统计 -->
      <div class="hud-popover" id="hud-popover-session" data-popover-id="session" popover="manual" role="dialog" aria-label="会话统计明细" hidden>
        <div class="hud-popover-inner">
          <div class="hud-popover-header">
            <span class="hud-popover-title">
              <span class="hud-status-dot" style="margin-right:2px" aria-hidden="true"></span>
              <span id="pop-session-title">会话统计</span>
            </span>
            <span class="hud-popover-badge" id="pop-session-badge">0 轮 0 步</span>
          </div>
          <div class="hud-popover-divider"></div>
          <div class="hud-popover-grid">
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-model-dur">模型用时</span>
              <span class="hud-popover-val" id="val-model-dur">0 秒</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-tool-dur">工具调用用时</span>
              <span class="hud-popover-val" id="val-tool-dur">0 秒</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-ttft">首 token 平均（TTFT）</span>
              <span class="hud-popover-val" id="val-ttft">—</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-tps">输出速度（TPS）</span>
              <span class="hud-popover-val" id="val-tps">—</span>
            </div>
            <div class="hud-popover-row" id="row-subagent-status" hidden>
              <span class="hud-popover-label" id="lbl-subagent-status">子智能体状态</span>
              <span class="hud-popover-val" id="val-subagent-status">—</span>
            </div>
          </div>
        </div>
        <div class="hud-popover-arrow" id="arrow-session">
          <svg viewBox="0 0 14 6" aria-hidden="true">
            <path d="M0 0 L7 6 L14 0 Z" fill="var(--hud-popover-bg)" stroke="none"/>
            <path d="M0.5 0 L7 5.5 L13.5 0" fill="none" stroke="var(--hud-popover-border)" stroke-width="1" stroke-linejoin="round"/>
          </svg>
        </div>
      </div>

      <!-- 向上展开详情卡片 2: Token 用量 -->
      <div class="hud-popover" id="hud-popover-tokens" data-popover-id="tokens" popover="manual" role="dialog" aria-label="Token 用量明细" hidden>
        <div class="hud-popover-inner">
          <div class="hud-popover-header">
            <span class="hud-popover-title">
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" style="color:var(--hud-accent-blue)">
                <path d="M8 1.2L9.9 6.1L14.8 8L9.9 9.9L8 14.8L6.1 9.9L1.2 8L6.1 6.1L8 1.2Z" fill="currentColor"/>
              </svg>
              <span id="pop-tokens-title">Token 用量</span>
            </span>
            <span class="hud-popover-badge" id="pop-tokens-badge">0 tok</span>
          </div>
          <div class="hud-popover-divider"></div>
          <div class="hud-popover-grid">
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-cache-hit">缓存命中</span>
              <span class="hud-popover-val" id="val-cache-hit">0%</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-uncached-in">未缓存输入</span>
              <span class="hud-popover-val" id="val-uncached-in">0 tok</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-cached-read">缓存读取</span>
              <span class="hud-popover-val" id="val-cached-read">0 tok</span>
            </div>
            <div class="hud-popover-row" id="row-cache-write" hidden>
              <span class="hud-popover-label" id="lbl-cache-write">缓存写入</span>
              <span class="hud-popover-val" id="val-cache-write">0 tok</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-output-tok">输出</span>
              <span class="hud-popover-val" id="val-output-tok">0 tok</span>
            </div>
            <div class="hud-popover-row" id="row-reasoning-tok" hidden>
              <span class="hud-popover-label" id="lbl-reasoning-tok">思维链 / 回复</span>
              <span class="hud-popover-val" id="val-reasoning-tok">0 / 0 tok</span>
            </div>
          </div>
        </div>
        <div class="hud-popover-arrow" id="arrow-tokens">
          <svg viewBox="0 0 14 6" aria-hidden="true">
            <path d="M0 0 L7 6 L14 0 Z" fill="var(--hud-popover-bg)" stroke="none"/>
            <path d="M0.5 0 L7 5.5 L13.5 0" fill="none" stroke="var(--hud-popover-border)" stroke-width="1" stroke-linejoin="round"/>
          </svg>
        </div>
      </div>

      <!-- 向上展开详情卡片 3: 当前上下文实况 -->
      <div class="hud-popover" id="hud-popover-context" data-popover-id="context" popover="manual" role="dialog" aria-label="当前上下文实况明细" hidden>
        <div class="hud-popover-inner">
          <div class="hud-popover-header">
            <span class="hud-popover-title">
              <span class="hud-popover-title-regular" id="pop-ctx-prefix">当前上下文 </span>
              <span class="hud-popover-title-strong" id="pop-ctx-pct">0%</span>
            </span>
            <span class="hud-popover-badge-muted" id="pop-ctx-capacity">— / —</span>
          </div>
          <div class="hud-progress-track" id="pop-ctx-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div class="hud-progress-seg hud-seg-sys" id="seg-sys" style="width: 0%"></div>
            <div class="hud-progress-seg hud-seg-tool" id="seg-tool" style="width: 0%"></div>
            <div class="hud-progress-seg hud-seg-msg" id="seg-msg" style="width: 0%"></div>
          </div>
          <div class="hud-popover-grid">
            <div class="hud-popover-row">
              <span class="hud-popover-label">
                <span class="hud-legend-dot" style="background-color: var(--hud-seg-sys-color)"></span>
                <span id="lbl-seg-sys">缓存复用上下文</span>
              </span>
              <span class="hud-popover-val" id="val-seg-sys">0 tok</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label">
                <span class="hud-legend-dot" style="background-color: var(--hud-seg-tool-color)"></span>
                <span id="lbl-seg-tool">本步新增输入</span>
              </span>
              <span class="hud-popover-val" id="val-seg-tool">0 tok</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label">
                <span class="hud-legend-dot" style="background-color: var(--hud-seg-msg-color)"></span>
                <span id="lbl-seg-msg">本步生成输出</span>
              </span>
              <span class="hud-popover-val" id="val-seg-msg">0 tok</span>
            </div>
            <div class="hud-popover-row" id="row-ctx-peak">
              <span class="hud-popover-label" id="lbl-ctx-peak">会话历史峰值</span>
              <span class="hud-popover-val" id="val-ctx-peak">0 tok</span>
            </div>
            <div class="hud-popover-row" id="row-ctx-model">
              <span class="hud-popover-label" id="lbl-ctx-model">当前模型</span>
              <span class="hud-popover-val" id="val-ctx-model">Gemini 3.8 Flash</span>
            </div>
          </div>
        </div>
        <div class="hud-popover-arrow" id="arrow-context">
          <svg viewBox="0 0 14 6" aria-hidden="true">
            <path d="M0 0 L7 6 L14 0 Z" fill="var(--hud-popover-bg)" stroke="none"/>
            <path d="M0.5 0 L7 5.5 L13.5 0" fill="none" stroke="var(--hud-popover-border)" stroke-width="1" stroke-linejoin="round"/>
          </svg>
        </div>
      </div>
    `;
  }

  renderSkeleton() {
    if (!this.shadow) return;
    const capsules = this.shadow.querySelectorAll('.capsule');
    for (const c of capsules) {
      if (c.classList) c.classList.add('is-skeleton');
    }
    this.hideAllPopovers();
  }

  syncStreamingClass() {
    if (!this.shadow) return;
    const isEn = this.languageMode === 'en';
    const sessionCapsule = this.shadow.querySelector('.capsule-session');
    const sessionPopover = this.shadow.querySelector('#hud-popover-session');
    const isWorking = Boolean(this.isStreaming || this.isSubagentRunning);
    if (sessionCapsule && sessionCapsule.classList) {
      if (isWorking) {
        sessionCapsule.classList.add('is-streaming');
      } else {
        sessionCapsule.classList.remove('is-streaming');
      }
      if (this.isSubagentRunning) {
        sessionCapsule.classList.add('is-subagent-active');
      } else {
        sessionCapsule.classList.remove('is-subagent-active');
      }
    }
    if (sessionPopover && sessionPopover.classList) {
      if (isWorking) {
        sessionPopover.classList.add('is-streaming');
      } else {
        sessionPopover.classList.remove('is-streaming');
      }
    }

    const subagentTagEl = this.shadow.querySelector('#hud-txt-session .hud-subagent-tag');
    const subagentRow = this.shadow.querySelector('#row-subagent-status');
    const lblSubEl = this.shadow.querySelector('#lbl-subagent-status');
    const valSubEl = this.shadow.querySelector('#val-subagent-status');
    const activeSubagents = Math.max(1, this.runningSubagentCount || 1);

    if (this.isSubagentRunning) {
      if (subagentTagEl) {
        subagentTagEl.textContent = isEn
          ? activeSubagents > 1
            ? ` · ${activeSubagents} Subagents`
            : ' · Subagent'
          : activeSubagents > 1
          ? ` · ${activeSubagents} 子智能体运行中`
          : ' · 子智能体运行中';
      }
      if (subagentRow) {
        subagentRow.removeAttribute('hidden');
      }
      if (lblSubEl) {
        lblSubEl.textContent = isEn ? 'Subagents' : '子智能体状态';
      }
      if (valSubEl) {
        valSubEl.textContent = isEn ? `${activeSubagents} running` : `${activeSubagents} 个运行中`;
      }
    } else if (subagentTagEl) {
      subagentTagEl.textContent = '';
    }
  }

  applyMetricsToDom(metrics) {
    if (!this.shadow || !metrics) return;
    const isEn = this.languageMode === 'en';
    const q = (sel) => this.shadow.querySelector(sel);

    const capsules = this.shadow.querySelectorAll('.capsule');
    for (const c of capsules) {
      if (c.classList) c.classList.remove('is-skeleton');
    }
    this.syncStreamingClass();

    const s = metrics.session || {};
    const t = metrics.tokens || {};
    const c = metrics.context || {};
    const b = c.breakdown || {};
    const hasContextUsage = c.hasUsageData !== false;

    const subagentRunning = Boolean(
      metrics.isSubagentRunning ||
        this.isSubagentRunning ||
        (Number(s.runningSubagentCount) || 0) > 0 ||
        this.runningSubagentCount > 0
    );
    const activeSubagents = Math.max(
      Number(metrics.runningSubagentCount) || 0,
      Number(s.runningSubagentCount) || 0,
      this.runningSubagentCount,
      subagentRunning ? 1 : 0
    );
    const totalSubagents = Math.max(Number(s.subagentCount) || 0, activeSubagents);

    // 1. 更新分段 1 (会话统计 + 子智能体实时工作状态)
    const turnsEl = q('#hud-txt-session .hud-turns');
    const stepsEl = q('#hud-txt-session .hud-steps');
    const speedEl = q('#hud-txt-session .hud-speed');
    const subagentTagEl = q('#hud-txt-session .hud-subagent-tag');
    const turnsCount = formatInteger(isRawNumber(s.turns) ? s.turns : 0);
    const stepsCount = formatInteger(isRawNumber(s.steps) ? s.steps : 0);
    const tpsText = (digits) => s.outputTpsFormatted === '计算中...'
      ? (isEn ? 'Measuring…' : '计算中...')
      : formatMetric(s.outputTps, s.outputTpsFormatted, digits, ' tok/s');

    if (turnsEl) turnsEl.textContent = isEn ? `${turnsCount}T ` : `${turnsCount} 轮 `;
    if (stepsEl) stepsEl.textContent = isEn ? `${stepsCount}S` : `${stepsCount} 步`;
    if (speedEl) speedEl.textContent = ` · ${tpsText(0)}`;
    if (subagentTagEl) {
      if (subagentRunning) {
        subagentTagEl.textContent = isEn
          ? activeSubagents > 1
            ? ` · ${activeSubagents} Subagents`
            : ' · Subagent'
          : activeSubagents > 1
          ? ` · ${activeSubagents} 子智能体运行中`
          : ' · 子智能体运行中';
      } else {
        subagentTagEl.textContent = '';
      }
    }

    // 2. 更新分段 2 (Token 用量)
    const tokTotalEl = q('#hud-txt-tokens .hud-tok-total');
    const cachePrefixEl = q('#hud-txt-tokens .hud-cache-prefix');
    const cacheLabelEl = q('#hud-txt-tokens .hud-cache-label');
    const cacheValEl = q('#hud-txt-tokens .hud-cache-val');
    if (tokTotalEl) tokTotalEl.textContent = `${formatCompactCount(t.totalTokens, String(t.totalTokensCompact || '0').replace(/ tok$/, ''))} tok`;
    if (cachePrefixEl) cachePrefixEl.textContent = isEn ? 'Cache' : '缓存';
    if (cacheLabelEl) cacheLabelEl.textContent = isEn ? ' Hit' : '命中';
    if (cacheValEl) cacheValEl.textContent = formatPercent(t.cacheHitRate, t.cacheHitRateFormatted, 0);

    // 3. 更新分段 3 (上下文实况)
    const ctxTxtEl = q('#hud-txt-context');
    const donutValEl = q('#hud-donut-val');
    const meterFillEl = q('#hud-meter-fill');
    const ratioClamped = hasContextUsage ? Math.min(1.0, Math.max(0, Number(c.usedRatio) || 0)) : 0;
    const usedCompact = hasContextUsage ? formatCompactCount(c.usedTokens, c.usedTokensCompact) : '—';
    const contextRatio = hasContextUsage ? c.usedRatio : undefined;
    const pctText = formatPercent(contextRatio, c.usedRatioFormatted, 0);

    if (ctxTxtEl) {
      ctxTxtEl.textContent = pctText;
      ctxTxtEl.setAttribute('data-used-tokens', usedCompact);
    }

    const strokeColor =
      ratioClamped >= 0.9
        ? 'var(--hud-danger-color)'
        : ratioClamped >= 0.75
        ? 'var(--hud-warn-color)'
        : 'var(--hud-seg-sys-color)';

    if (donutValEl) {
      const offset = Number((DONUT_CIRCUMFERENCE * (1 - ratioClamped)).toFixed(2));
      donutValEl.setAttribute('stroke-dashoffset', String(offset));
      donutValEl.setAttribute('stroke', strokeColor);
    }
    if (meterFillEl) {
      const fillWidth = Number((54 * ratioClamped).toFixed(2));
      meterFillEl.setAttribute('width', String(fillWidth));
      meterFillEl.setAttribute('fill', strokeColor);
    }

    // 4. 更新 Popover 1 (会话统计)
    const setTxt = (sel, val) => {
      const el = q(sel);
      if (el) el.textContent = val;
    };
    setTxt('#pop-session-title', isEn ? 'Session Stats' : '会话统计');
    setTxt(
      '#pop-session-badge',
      isEn ? `${turnsCount} turns ${stepsCount} steps` : `${turnsCount} 轮 ${stepsCount} 步`
    );
    setTxt('#lbl-model-dur', isEn ? 'Model Duration' : '模型用时');
    setTxt(
      '#val-model-dur',
      formatDuration(s.modelDurationSeconds, s.modelDurationFormatted, isEn)
    );
    setTxt('#lbl-tool-dur', isEn ? 'Tool Duration' : '工具调用用时');
    setTxt(
      '#val-tool-dur',
      formatDuration(s.toolDurationSeconds, s.toolDurationFormatted, isEn)
    );
    setTxt('#lbl-ttft', isEn ? 'Avg TTFT' : '首 token 平均（TTFT）');
    setTxt(
      '#val-ttft',
      formatMetric(s.averageTtftSeconds, s.averageTtftFormatted, 2, isEn ? 's' : ' 秒')
    );
    setTxt('#lbl-tps', isEn ? 'Output Speed (TPS)' : '输出速度（TPS）');
    setTxt('#val-tps', tpsText(2));
    q('#val-ttft')?.setAttribute('aria-description', isEn
      ? 'Average of the host’s original TTFT field.'
      : '按宿主原始 TTFT 字段统计的平均值。');
    q('#val-tps')?.setAttribute('aria-description', isEn
      ? 'Calculated from host generation time, including waiting time.'
      : '按宿主生成时间计算，包含等待时间。');

    const subagentRow = q('#row-subagent-status');
    const subStepsCount = Math.max(0, Number(s.subagentSteps) || 0);
    const subStepSuffix =
      subStepsCount > 0 ? (isEn ? ` (${subStepsCount} steps)` : `（${subStepsCount} 步）`) : '';
    if (subagentRow) {
      if (subagentRunning || totalSubagents > 0) {
        subagentRow.removeAttribute('hidden');
        setTxt('#lbl-subagent-status', isEn ? 'Subagents' : '子智能体状态');
        if (subagentRunning) {
          setTxt(
            '#val-subagent-status',
            isEn
              ? `${activeSubagents} running${subStepSuffix}`
              : `${activeSubagents} 个运行中${subStepSuffix}`
          );
        } else {
          setTxt(
            '#val-subagent-status',
            isEn
              ? `${totalSubagents} completed${subStepSuffix}`
              : `已调度 ${totalSubagents} 个${subStepSuffix}`
          );
        }
      } else {
        subagentRow.setAttribute('hidden', '');
      }
    }

    // 5. 更新 Popover 2 (Token 用量)
    setTxt('#pop-tokens-title', isEn ? 'Token Usage' : 'Token 用量');
    setTxt('#pop-tokens-badge', formatTokenCount(t.totalTokens, t.totalTokensFormatted));
    setTxt('#lbl-cache-hit', isEn ? 'Cache Hit' : '缓存命中');
    setTxt('#val-cache-hit', formatPercent(t.cacheHitRate, t.cacheHitRateFormatted, 2));
    setTxt('#lbl-uncached-in', isEn ? 'Uncached Input' : '未缓存输入');
    setTxt('#val-uncached-in', formatTokenCount(t.uncachedInputTokens, t.uncachedInputFormatted));
    setTxt('#lbl-cached-read', isEn ? 'Cached Read' : '缓存读取');
    setTxt('#val-cached-read', formatTokenCount(t.cachedReadTokens, t.cachedReadFormatted));
    const cacheWriteRow = q('#row-cache-write');
    if (cacheWriteRow) {
      if (Number(t.cacheWriteTokens) > 0) {
        cacheWriteRow.removeAttribute('hidden');
        setTxt('#lbl-cache-write', isEn ? 'Cache Write' : '缓存写入');
        setTxt(
          '#val-cache-write',
          formatTokenCount(t.cacheWriteTokens, t.cacheWriteFormatted)
        );
      } else {
        cacheWriteRow.setAttribute('hidden', '');
      }
    }
    setTxt('#lbl-output-tok', isEn ? 'Output' : '输出');
    setTxt('#val-output-tok', formatTokenCount(t.outputTokens, t.outputFormatted));

    const reasoningRow = q('#row-reasoning-tok');
    if (reasoningRow) {
      if (Number(t.reasoningTokens) > 0) {
        reasoningRow.removeAttribute('hidden');
        setTxt('#lbl-reasoning-tok', isEn ? 'Reasoning / Reply' : '思维链 / 回复');
        setTxt(
          '#val-reasoning-tok',
          `${formatDetailCompactNumber(t.reasoningTokens)} / ${formatDetailCompactNumber(t.candidateTokens || 0)} tok`
        );
      } else {
        reasoningRow.setAttribute('hidden', '');
      }
    }

    // 6. 更新 Popover 3 (当前上下文实况 - 100% 真实底层数据)
    setTxt('#pop-ctx-prefix', isEn ? 'Current Context ' : '当前上下文 ');
    setTxt('#pop-ctx-pct', formatPercent(contextRatio, c.usedRatioFormatted, 2));
    const capacityText = isRawNumber(c.capacityTokens) && c.capacityTokens > 0
      ? `${c.isFallbackCapacity ? '~' : ''}${formatDetailCompactNumber(c.capacityTokens, true)}` : '—';
    const usedText = hasContextUsage && isRawNumber(c.usedTokens) ? formatDetailCompactNumber(c.usedTokens) : '—';
    setTxt(
      '#pop-ctx-capacity',
      `${usedText} / ${capacityText}`
    );

    const trackEl = q('#pop-ctx-track');
    if (trackEl) {
      trackEl.setAttribute('aria-valuenow', String(Math.round(ratioClamped * 100)));
      trackEl.setAttribute('aria-valuetext', formatPercent(contextRatio, c.usedRatioFormatted, 2));
    }
    const segSysEl = q('#seg-sys');
    const segToolEl = q('#seg-tool');
    const segMsgEl = q('#seg-msg');
    const wSys = hasContextUsage ? Math.max(0, Number(b.cachedContextRatio ?? b.systemRatio) || 0) : 0;
    const wTool = hasContextUsage ? Math.max(0, Number(b.uncachedContextRatio ?? b.toolRatio) || 0) : 0;
    if (segSysEl) segSysEl.style.width = `${wSys.toFixed(3)}%`;
    if (segToolEl) segToolEl.style.width = `${wTool.toFixed(3)}%`;
    if (segMsgEl) segMsgEl.style.width = '0%';

    setTxt('#lbl-seg-sys', isEn ? 'Cached Context' : '缓存复用上下文');
    setTxt('#val-seg-sys', hasContextUsage ? formatTokenCount(b.cachedContextTokens ?? b.systemTokens, b.cachedContextFormatted || b.systemTokensCompact) : '—');
    setTxt('#lbl-seg-tool', isEn ? 'New Uncached Input' : '本步新增输入');
    setTxt('#val-seg-tool', hasContextUsage ? formatTokenCount(b.uncachedContextTokens ?? b.toolTokens, b.uncachedContextFormatted || b.toolTokensCompact) : '—');
    setTxt('#lbl-seg-msg', isEn ? 'Latest Step Output' : '本步生成输出');
    setTxt('#val-seg-msg', hasContextUsage ? formatTokenCount(b.latestOutputTokens ?? b.messageTokens, b.latestOutputFormatted || b.messageTokensCompact) : '—');

    const peakRow = q('#row-ctx-peak');
    if (peakRow) {
      setTxt('#lbl-ctx-peak', isEn ? 'Session Peak Context' : '会话历史峰值');
      const peakVal = formatTokenCount(
        c.peakContextTokens ?? c.usedTokens,
        c.peakContextFormatted || c.usedTokensFormatted
      );
      const compCount = Number(s.compactionCount) || 0;
      const compSuffix =
        compCount > 0 ? (isEn ? ` (${compCount}x compacted)` : ` (已压缩 ${compCount} 次)`) : '';
      setTxt('#val-ctx-peak', `${peakVal}${compSuffix}`);
    }
    const modelRow = q('#row-ctx-model');
    if (modelRow) {
      setTxt('#lbl-ctx-model', isEn ? 'Active Model' : '当前模型');
      setTxt('#val-ctx-model', c.modelDisplayName || c.modelId || 'Gemini 3.8 Flash');
    }

    if (this.activePopoverId) {
      this.repositionActivePopover();
    }
  }

  bindEvents(targetComposer) {
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    const win = typeof window !== 'undefined' ? window : globalThis.window;

    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('resize', () => this.handleWindowResize(), { signal });
      win.addEventListener('pointerdown', (e) => this.handleGlobalPointerDown(e), {
        signal,
        passive: true,
        capture: true,
      });
      win.addEventListener('keydown', (e) => this.handleGlobalKeyDown(e), { signal });
      win.addEventListener(
        'blur',
        () => {
          if (!this.pinnedPopoverId && this.activePopoverId) {
            this.hideAllPopovers();
          }
        },
        { signal }
      );
    }

    if (this.shadow && typeof this.shadow.querySelectorAll === 'function') {
      const capsules = this.shadow.querySelectorAll('.capsule');
      capsules.forEach((capsule) => {
        if (typeof capsule.addEventListener !== 'function') return;
        capsule.addEventListener(
          'mousedown',
          (e) => {
            e.preventDefault();
          },
          { signal }
        );
        capsule.addEventListener('mouseenter', () => this.handleCapsuleHover(capsule), { signal });
        capsule.addEventListener('mouseleave', () => this.handleCapsuleLeave(), { signal });
        capsule.addEventListener('click', (e) => this.handleCapsuleClick(capsule, e), { signal });
        capsule.addEventListener('keydown', (e) => this.handleCapsuleKeydown(capsule, e), {
          signal,
        });
      });

      const popovers = this.shadow.querySelectorAll('.hud-popover');
      popovers.forEach((popover) => {
        if (typeof popover.addEventListener !== 'function') return;
        popover.addEventListener(
          'mouseenter',
          () => {
            if (this.hoverLeaveTimer) {
              clearTimeout(this.hoverLeaveTimer);
              this.hoverLeaveTimer = null;
            }
          },
          { signal }
        );
        popover.addEventListener(
          'mouseleave',
          () => {
            if (!this.pinnedPopoverId) {
              this.handleCapsuleLeave();
            }
          },
          { signal }
        );
      });
    }

    if (typeof ResizeObserver === 'function' && targetComposer) {
      this.resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const width = entry.contentRect?.width ?? targetComposer.clientWidth ?? 0;
          if (width > 0) this.handleContainerResize(width);
        }
        this.syncVerticalCentering();
      });
      try {
        this.resizeObserver.observe(targetComposer);
      } catch {}
    }
  }

  handleContainerResize(width) {
    if (!this.shadow) return;
    const container = this.shadow.querySelector('.hud-container');
    if (!container || !container.classList) return;

    if (width > 0 && width < 360) {
      container.classList.add('is-ultra-compact');
      container.classList.remove('is-compact');
    } else if (width >= 360 && width <= 440) {
      container.classList.add('is-compact');
      container.classList.remove('is-ultra-compact');
    } else {
      container.classList.remove('is-compact', 'is-ultra-compact');
    }

    if (this.activePopoverId) {
      this.repositionActivePopover();
    }
  }

  handleWindowResize() {
    this.syncVerticalCentering();
    if (this.targetComposer) {
      const rect =
        typeof this.targetComposer.getBoundingClientRect === 'function'
          ? this.targetComposer.getBoundingClientRect()
          : null;
      if (rect && rect.width > 0) {
        this.handleContainerResize(rect.width);
      }
    }
    if (this.activePopoverId) {
      this.repositionActivePopover();
    }
  }

  handleCapsuleHover(capsule) {
    const id = capsule.getAttribute('data-capsule-id');
    if (!id) return;
    if (this.hoverLeaveTimer) {
      clearTimeout(this.hoverLeaveTimer);
      this.hoverLeaveTimer = null;
    }
    if (this.pinnedPopoverId && this.pinnedPopoverId !== id) {
      return;
    }
    if (this.activePopoverId === id) return;
    if (this.hoverEnterTimer) clearTimeout(this.hoverEnterTimer);
    this.hoverEnterTimer = setTimeout(() => {
      this.hoverEnterTimer = null;
      this.showPopover(id);
    }, 90);
  }

  handleCapsuleLeave() {
    if (this.hoverEnterTimer) {
      clearTimeout(this.hoverEnterTimer);
      this.hoverEnterTimer = null;
    }
    if (this.pinnedPopoverId) return;
    if (this.hoverLeaveTimer) clearTimeout(this.hoverLeaveTimer);
    this.hoverLeaveTimer = setTimeout(() => {
      this.hoverLeaveTimer = null;
      if (!this.pinnedPopoverId) {
        this.hideAllPopovers();
      }
    }, 150);
  }

  handleCapsuleClick(capsule, event) {
    event?.stopPropagation?.();
    const id = capsule.getAttribute('data-capsule-id');
    if (!id) return;
    if (this.hoverEnterTimer) {
      clearTimeout(this.hoverEnterTimer);
      this.hoverEnterTimer = null;
    }
    if (this.pinnedPopoverId === id) {
      this.pinnedPopoverId = null;
      this.hideAllPopovers();
    } else {
      this.pinnedPopoverId = id;
      this.showPopover(id);
    }
  }

  handleCapsuleKeydown(capsule, event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.handleCapsuleClick(capsule, event);
    } else if (event.key === 'Escape') {
      this.pinnedPopoverId = null;
      this.hideAllPopovers();
    }
  }

  handleGlobalPointerDown(event) {
    if (!this.activePopoverId && !this.pinnedPopoverId) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (this.host && path.includes(this.host)) return;
    this.pinnedPopoverId = null;
    this.hideAllPopovers();
  }

  handleGlobalKeyDown(event) {
    if (event.key === 'Escape' && (this.activePopoverId || this.pinnedPopoverId)) {
      this.pinnedPopoverId = null;
      this.hideAllPopovers();
    }
  }

  showPopover(id) {
    if (!this.shadow) return;
    this.activePopoverId = id;
    const capsules = this.shadow.querySelectorAll('.capsule');
    capsules.forEach((cap) => {
      const match = cap.getAttribute('data-capsule-id') === id;
      cap.setAttribute('aria-expanded', match ? 'true' : 'false');
      if (cap.classList) {
        if (match) cap.classList.add('is-active');
        else cap.classList.remove('is-active');
      }
    });

    const popovers = this.shadow.querySelectorAll('.hud-popover');
    popovers.forEach((pop) => {
      const match = pop.getAttribute('data-popover-id') === id;
      if (match) {
        pop.removeAttribute('hidden');
        try {
          if (typeof pop.showPopover === 'function') {
            pop.showPopover();
          }
        } catch {}
        if (pop.classList) pop.classList.add('is-visible');
      } else {
        try {
          if (typeof pop.hidePopover === 'function') {
            pop.hidePopover();
          }
        } catch {}
        if (pop.classList) pop.classList.remove('is-visible');
        pop.setAttribute('hidden', '');
      }
    });

    this.repositionActivePopover();
  }

  repositionActivePopover() {
    if (!this.shadow || !this.activePopoverId) return;
    const id = this.activePopoverId;
    const capsule = this.shadow.querySelector(`.capsule[data-capsule-id="${id}"]`);
    const popover = this.shadow.querySelector(`#hud-popover-${id}`);
    const arrow = this.shadow.querySelector(`#arrow-${id}`);
    if (!capsule || !popover) return;

    const standardWidth = POPOVER_WIDTHS[id] || 296;
    const calcFn =
      typeof computeUpwardPopoverPosition === 'function'
        ? computeUpwardPopoverPosition
        : globalThis.__GRAVITYBOX_HUD_POPOVER__?.computeUpwardPopoverPosition;
    const applyFn =
      typeof applyPopoverGeometry === 'function'
        ? applyPopoverGeometry
        : globalThis.__GRAVITYBOX_HUD_POPOVER__?.applyPopoverGeometry;

    if (typeof calcFn === 'function') {
      const pos = calcFn(capsule, standardWidth, 195, 12, 8, 12);
      if (typeof applyFn === 'function') {
        applyFn(popover, arrow, pos);
      }
    }
  }

  hideAllPopovers() {
    this.activePopoverId = null;
    this.pinnedPopoverId = null;
    if (!this.shadow || typeof this.shadow.querySelectorAll !== 'function') return;
    const capsules = this.shadow.querySelectorAll('.capsule');
    capsules.forEach((cap) => {
      cap.setAttribute('aria-expanded', 'false');
      if (cap.classList) cap.classList.remove('is-active');
    });
    const popovers = this.shadow.querySelectorAll('.hud-popover');
    popovers.forEach((pop) => {
      try {
        if (typeof pop.hidePopover === 'function') {
          pop.hidePopover();
        }
      } catch {}
      if (pop.classList) pop.classList.remove('is-visible');
      pop.setAttribute('hidden', '');
    });
  }

  cleanupListeners() {
    if (this.hoverEnterTimer) {
      clearTimeout(this.hoverEnterTimer);
      this.hoverEnterTimer = null;
    }
    if (this.hoverLeaveTimer) {
      clearTimeout(this.hoverLeaveTimer);
      this.hoverLeaveTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  dispose() {
    if (this.currentConvId) {
      this.emitBridgeEvent('SESSION_DETACHED');
    }
    this.cleanupListeners();
    this.restoreModifiedAncestors();
    if (this.host) {
      this.host.remove();
      this.host = null;
    }
    this.shadow = null;
    this.targetComposer = null;
    this.activePopoverId = null;
    this.pinnedPopoverId = null;
  }
}

globalThis.__GRAVITYBOX_HUD_INSTANCE__ = { HudInstance };
