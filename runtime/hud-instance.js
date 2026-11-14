import { compactNumber, durationText, formatTurnDurationCompact } from '../dist/metric-format.js';
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

function isRawNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

const trimZeros = (text) => text.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');

/**
 * 紧凑数字表示法：固定有效数字（而非固定小数位），并始终去除尾零。
 * sig：有效数字位数，弹窗明细 3 位（默认），常驻栏 2 位。
 */
function formatDetailCompactNumber(value, sig = 3) { return compactNumber(value, sig); }

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
    const cleanedText = String(fallback).replace(/[,~\s]|tok$/gi, '');
    const parsedValue = Number(cleanedText);
    if (Number.isFinite(parsedValue) && parsedValue >= 0) {
      return formatCompactCount(parsedValue);
    }
    return String(fallback).replace(/\d+\.\d+/g, (number) => String(Math.round(Number(number))));
  }
  return formatDetailCompactNumber(value, 2);
}

function formatMetric(value, formatted, digits, suffix) {
  if (formatted === '—' || !isRawNumber(value)) return '—';
  return `${digits === 0 ? Math.round(value) : value.toFixed(digits)}${suffix}`;
}

/** 弹窗百分比：3 位有效数字并去尾零（94.15 → 94.2、42.00 → 42、5.25 → 5.25、100 → 100）。 */
function formatPopoverPercent(value, formatted) {
  if (formatted === '—' || !isRawNumber(value)) return '—';
  const percent = value * 100;
  if (percent === 0) return '0%';
  if (percent >= 100) return `${Math.round(percent)}%`;
  return `${trimZeros(Number(percent.toPrecision(3)).toString())}%`;
}

function formatPercent(value, formatted, digits) {
  return formatMetric(isRawNumber(value) ? value * 100 : NaN, formatted, digits, '%');
}

function formatDuration(value, formatted, isEn) {
  if (formatted === '—' || !isRawNumber(value)) return '—';
  return durationText(value, isEn ? 'en' : 'zh');
}

/**
 * 上下文进度条同色系渐进演进配色（0% → 100%）：
 * 浅色模式由清透天蓝渐深至深钴蓝；深色模式由柔和冰蓝过渡至饱满电光蓝（避免深底吞色）。
 */
function computeContextProgressColor(ratio, isDark = false) {
  const r = Math.min(1, Math.max(0, Number(ratio) || 0));
  const stops = isDark
    ? [
        [147, 197, 253], // #93C5FD
        [88, 155, 255],  // #589BFF
        [37, 99, 235],   // #2563EB
      ]
    : [
        [132, 186, 255], // #84BAFF
        [49, 134, 255],  // #3186FF
        [20, 73, 196],   // #1449C4
      ];
  const [start, end, t] =
    r <= 0.5 ? [stops[0], stops[1], r * 2] : [stops[1], stops[2], (r - 0.5) * 2];
  const ch = (idx) => Math.round(start[idx] + (end[idx] - start[idx]) * t);
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

function createDefaultMetrics(conversationId = 'default', sessionRevision = 1) {
  return {
    conversationId,
    sessionRevision,
    updatedAt: Date.now(),
    availability: 'loading', observedAt: null,
    isStreaming: false,
    activityPhase: 'idle',
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
      modelDurationFormatted: '0秒',
      modelDurationFormattedEn: '0s',
      toolDurationSeconds: 0,
      toolDurationFormatted: '0秒',
      toolDurationFormattedEn: '0s',
      averageTtftSeconds: 0,
      averageTtftFormatted: '—',
      averageTtftFormattedEn: '—',
      outputTps: 0,
      outputTpsFormatted: '—',
      currentTurnDurationSeconds: 0,
      currentTurnDurationFormatted: '0秒',
      currentTurnDurationFormattedEn: '0s',
      currentTurnDurationCompactZh: '本轮 0s',
      currentTurnDurationCompactEn: 'Turn 0s',
      currentTurnModelDurationSeconds: 0,
      currentTurnToolDurationSeconds: 0,
      inFlightModelDurationSeconds: 0,
      activeModelStepCount: 0,
      inFlightToolDurationSeconds: 0,
      activeToolStepCount: 0,
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
      modelDisplayName: '—',
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
    this.paneSlotId = options.paneSlotId || this.cascadeId;
    this.isPrimaryPane = Boolean(options.isPrimaryPane);
    this.isSubpane = Boolean(options.isSubpane);
    this.languageMode = options.languageMode === 'en' ? 'en' : 'zh';
    this.onBridgeEvent = typeof options.onBridgeEvent === 'function' ? options.onBridgeEvent : null;
    this.allocateRevision = typeof options.allocateRevision === 'function' ? options.allocateRevision : null;
    this.currentConvId = null;
    this.sessionRevision = 0;
    this.lastMetricsSequence = 0;
    this.lastAppliedUpdatedAt = 0;
    this.currentModelId = '';
    this.domIsStreaming = false;
    this.domActivityPhase = 'idle';
    this.backendActivityPhase = null;
    this.activityPhase = 'idle';
    this.domIsSubagentRunning = false;
    this.domRunningSubagentCount = 0;
    this.backendIsSubagentRunning = false;
    this.backendRunningSubagentCount = 0;
    this.childConversationIds = [];
    this.isStreaming = false;
    this.hasActiveWork = false;
    this.isSubagentRunning = false;
    this.runningSubagentCount = 0;
    this.abortController = null;
    this.resizeObserver = null;
    this.host = null;
    this.shadow = null;
    this.isDarkTheme = false;
    this.domRefs = null;
    this.domRefsShadow = null;
    this.targetComposer = null;
    this.activePopoverId = null;
    this.pinnedPopoverId = null;
    this.hoverEnterTimer = null;
    this.hoverLeaveTimer = null;
    this.turnClockTimer = null;
    this.turnClockAnchor = null;
    this.modelClockAnchor = null;
    this.toolClockAnchor = null;
    this.turnHighWaterMark = null;
    this.lastMetrics = createDefaultMetrics('default', 0);
  }

  resetToEmptyState() {
    this.stopTurnClock();
    this.turnHighWaterMark = null;
    this.currentConvId = null;
    this.currentModelId = '';
    this.domIsStreaming = false;
    this.domActivityPhase = 'idle';
    this.backendActivityPhase = null;
    this.activityPhase = 'idle';
    this.domIsSubagentRunning = false;
    this.domRunningSubagentCount = 0;
    this.backendIsSubagentRunning = false;
    this.backendRunningSubagentCount = 0;
    this.childConversationIds = [];
    this.isStreaming = false;
    this.hasActiveWork = false;
    this.isSubagentRunning = false;
    this.runningSubagentCount = 0;
    this.pinnedPopoverId = null;
    this.lastMetrics = createDefaultMetrics('default', 0);
    if (this.shadow) {
      this.applyMetricsToDom(this.lastMetrics);
    }
    this.renderSkeleton();
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
    childConversationIds = null,
    activityPhase = null
  ) {
    if (!newConvId) return this.sessionRevision;
    const changed = this.currentConvId !== newConvId;
    this.currentConvId = newConvId;
    if (changed) this.currentModelId = modelId || '';
    else if (modelId) this.currentModelId = modelId;
    this.domIsSubagentRunning = Boolean(isSubagentRunning);
    this.domRunningSubagentCount = Math.max(0, Number(runningSubagentCount) || 0);
    // domIsStreaming 与 domActivityPhase 仅由当前分栏前台模型/流式状态决定，不与独立子智能体混用
    this.domIsStreaming = Boolean(isStreaming);
    this.domActivityPhase = !this.domIsStreaming
      ? 'idle'
      : activityPhase === 'executing'
      ? 'executing'
      : 'generating';
    if (Array.isArray(childConversationIds)) {
      this.childConversationIds = [...new Set(childConversationIds.filter(Boolean))];
    } else if (changed) {
      this.childConversationIds = [];
    }
    if (changed) {
      this.stopTurnClock();
      this.turnHighWaterMark = null;
      this.backendIsSubagentRunning = false;
      this.backendRunningSubagentCount = 0;
      this.backendActivityPhase = null;
      this.isSubagentRunning = this.domIsSubagentRunning;
      this.runningSubagentCount = this.domRunningSubagentCount;
      this.isStreaming = this.domIsStreaming;
      this.hasActiveWork = Boolean(this.domIsStreaming || this.isSubagentRunning);
      this.activityPhase = this.computeMergedActivityPhase();
      this.sessionRevision = this.allocateRevision
        ? Math.max(this.sessionRevision + 1, this.allocateRevision())
        : this.sessionRevision + 1;
      this.lastMetricsSequence = 0;
      this.lastAppliedUpdatedAt = 0;
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
      this.isStreaming = this.domIsStreaming;
      this.hasActiveWork = Boolean(
        this.domIsStreaming ||
          this.isSubagentRunning ||
          (this.lastMetrics?.session?.activeModelStepCount || 0) > 0 ||
          (this.lastMetrics?.session?.activeToolStepCount || 0) > 0
      );
      this.activityPhase = this.computeMergedActivityPhase();
      this.syncStreamingClass();
    }
    return this.sessionRevision;
  }

  computeMergedActivityPhase() {
    // 当前分栏前台模型未处于流式轮次时，即使仍有后台工具或独立子智能体运行，小圆点也必须保持灰色 idle
    if (!this.domIsStreaming) return 'idle';
    if (this.domActivityPhase === 'executing' || this.backendActivityPhase === 'executing') {
      return 'executing';
    }
    return 'generating';
  }

  notifyModelOrStreamingChange(
    modelId,
    isStreaming,
    isSubagentRunning = false,
    runningSubagentCount = 0,
    childConversationIds = null,
    activityPhase = null
  ) {
    let changed = false;
    if (modelId && modelId !== this.currentModelId) {
      this.currentModelId = modelId;
      changed = true;
      this.emitBridgeEvent('MODEL_CHANGED');
    }
    const nextDomSubagentRunning = Boolean(isSubagentRunning);
    const nextDomSubagentCount = Math.max(0, Number(runningSubagentCount) || 0);
    const nextDomStreaming = Boolean(isStreaming);
    const nextDomPhase = !nextDomStreaming
      ? 'idle'
      : activityPhase === 'executing'
      ? 'executing'
      : 'generating';
    const nextChildIds = Array.isArray(childConversationIds)
      ? [...new Set(childConversationIds.filter(Boolean))]
      : this.childConversationIds;
    const childIdsChanged = nextChildIds.join(',') !== this.childConversationIds.join(',');

    if (
      nextDomStreaming !== this.domIsStreaming ||
      nextDomPhase !== this.domActivityPhase ||
      nextDomSubagentRunning !== this.domIsSubagentRunning ||
      nextDomSubagentCount !== this.domRunningSubagentCount ||
      childIdsChanged
    ) {
      if (
        (this.domActivityPhase === 'executing' && nextDomPhase === 'generating') ||
        nextDomPhase === 'idle'
      ) {
        this.backendActivityPhase = null;
      }
      this.domIsStreaming = nextDomStreaming;
      this.domActivityPhase = nextDomPhase;
      this.domIsSubagentRunning = nextDomSubagentRunning;
      this.domRunningSubagentCount = nextDomSubagentCount;
      this.childConversationIds = nextChildIds;
      this.isSubagentRunning = Boolean(this.domIsSubagentRunning || this.backendIsSubagentRunning);
      this.runningSubagentCount = Math.max(
        this.domRunningSubagentCount,
        this.backendRunningSubagentCount
      );
      this.isStreaming = this.domIsStreaming;
      this.hasActiveWork = Boolean(
        this.domIsStreaming ||
          this.isSubagentRunning ||
          (this.lastMetrics?.session?.activeModelStepCount || 0) > 0 ||
          (this.lastMetrics?.session?.activeToolStepCount || 0) > 0
      );
      this.activityPhase = this.computeMergedActivityPhase();
      this.syncStreamingClass();
      if (this.lastMetrics && this.shadow) {
        this.applyMetricsToDom({
          ...this.lastMetrics,
          isStreaming: this.hasActiveWork,
          activityPhase: this.activityPhase,
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
      paneSlotId: this.paneSlotId,
      sessionRevision: this.sessionRevision,
      modelId: this.currentModelId,
      isStreaming: this.domIsStreaming,
      activityPhase: this.domActivityPhase,
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
    // 三重防线校验：杜绝跨会话污染、同会话跨分栏串扰、A->B->A 迟到包及同代乱序旧包回退
    if (metrics.conversationId !== this.currentConvId) {
      return false;
    }
    if (metrics.paneSlotId && this.paneSlotId && metrics.paneSlotId !== this.paneSlotId) {
      return false;
    }
    if (typeof metrics.sessionRevision === 'number') {
      if (this.sessionRevision > 0 && metrics.sessionRevision !== this.sessionRevision) {
        return false;
      }
      if (metrics.sessionRevision < this.sessionRevision) {
        return false;
      }
    }
    if (typeof metrics.metricsSequence === 'number' && metrics.metricsSequence > 0) {
      if (metrics.metricsSequence <= this.lastMetricsSequence) {
        return false;
      }
      this.lastMetricsSequence = metrics.metricsSequence;
    } else if (
      typeof metrics.updatedAt === 'number' &&
      this.lastAppliedUpdatedAt > 0 &&
      metrics.sessionRevision === this.lastMetrics?.sessionRevision &&
      metrics.updatedAt < this.lastAppliedUpdatedAt
    ) {
      return false;
    }
    if (typeof metrics.updatedAt === 'number' && metrics.updatedAt > 0) {
      this.lastAppliedUpdatedAt = metrics.updatedAt;
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
    const activeModelSteps = Math.max(0, Number(metrics.session?.activeModelStepCount) || 0);
    const activeToolSteps = Math.max(0, Number(metrics.session?.activeToolStepCount) || 0);
    this.isStreaming = Boolean(this.domIsStreaming);
    this.hasActiveWork = Boolean(
      this.domIsStreaming ||
        mergedSubagentRunning ||
        metrics.isStreaming ||
        activeModelSteps > 0 ||
        activeToolSteps > 0
    );
    this.backendActivityPhase =
      metrics.activityPhase === 'generating' ||
      metrics.activityPhase === 'executing' ||
      metrics.activityPhase === 'idle'
        ? metrics.activityPhase
        : null;
    this.activityPhase = this.computeMergedActivityPhase();
    this.lastMetrics = {
      ...metrics,
      isStreaming: this.isStreaming,
      activityPhase: this.activityPhase,
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

    this.isDarkTheme = isDark;
    if (isDark) {
      if (this.host.getAttribute('data-theme') !== 'dark') {
        this.host.setAttribute('data-theme', 'dark');
      }
    } else if (this.host.hasAttribute('data-theme')) {
      this.host.removeAttribute('data-theme');
    }
    const meterFillEl = this.getShadowEl('#hud-meter-fill');
    if (meterFillEl && this.lastMetrics?.context?.hasUsageData) {
      const ratioClamped = Math.min(1.0, Math.max(0, Number(this.lastMetrics.context.usedRatio) || 0));
      meterFillEl.setAttribute('fill', computeContextProgressColor(ratioClamped, isDark));
    }
  }

  syncVerticalCentering() {
    if (!this.host || !this.targetComposer) return;
    // Own only our box. Never rewrite the host application's ancestor padding.
    this.host.style.marginTop = '4px';
    this.host.style.marginBottom = '4px';
    const win = typeof window !== 'undefined' ? window : globalThis.window;
    if (typeof this.host.getBoundingClientRect !== 'function') return;
    const composer = this.targetComposer.getBoundingClientRect?.();
    const rect = this.host.getBoundingClientRect();
    const vh = Number(win?.innerHeight) || 0;
    // Align the normal bottom-docked composer; centred welcome-page composers
    // keep their natural layout instead of being moved towards the viewport edge.
    if (composer && vh && composer.top > vh / 2 && rect.height > 0) {
      const topGap = rect.top - composer.bottom;
      const bottomGap = vh - rect.bottom;
      if (bottomGap >= 0 && bottomGap < 48) {
        const previous = parseFloat(this.host.style.getPropertyValue?.('--hud-offset') || '0') || 0;
        const offset = Math.max(-8, Math.min(8, previous + (bottomGap - topGap) / 2));
        this.host.style.setProperty?.('--hud-offset', `${offset}px`);
        this.host.style.translate = `0 var(--hud-offset, 0px)`;
        return;
      }
    }
    this.host.style.setProperty?.('--hud-offset', '0px');
    this.host.style.translate = 'none';
  }

  mount(targetComposer) {
    if (!targetComposer) return;
    this.cleanupListeners();
    this.targetComposer = targetComposer;

    const doc = targetComposer.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;

    this.host = doc.createElement('div');
    this.host.id = this.isPrimaryPane
      ? '__gravitybox_hud_host__'
      : `__gravitybox_hud_host_${this.cascadeId}__`;
    this.host.className = '__gravitybox_hud_host__';
    this.host.setAttribute('data-gravitybox-protect', 'true');
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

    this.resetDomCache();
    this.shadow = this.host.attachShadow({ mode: 'open' });
    const stylesCss =
      typeof HUD_STYLES_CSS === 'string'
        ? HUD_STYLES_CSS
        : globalThis.__GRAVITYBOX_HUD_STYLES_CSS__ || '';
    this.shadow.innerHTML = `<style>${stylesCss}</style>${this.buildHudHtml()}`;
    this.domRefsShadow = this.shadow;

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
    const width =
      typeof targetComposer.getBoundingClientRect === 'function'
        ? targetComposer.getBoundingClientRect()?.width ?? 0
        : targetComposer.clientWidth ?? 0;
    if (width > 0) {
      this.handleContainerResize(width);
    }
  }

  buildHudHtml() {
    return `
      <div class="hud-container" id="hud-toolbar" role="toolbar" aria-label="Antigravity 会话遥测状态栏">
        <div class="hud-dock-surface">
          <!-- 分段 1: 会话与执行耗时 (移除原生 title 提示，杜绝遮挡上浮卡片) -->
          <button type="button" class="capsule capsule-session" data-capsule-id="session" aria-haspopup="dialog" aria-expanded="false" aria-label="会话统计明细">
            <span class="hud-status-dot" aria-hidden="true"></span>
            <span class="capsule-text" id="hud-txt-session">
              <span class="hud-turns">0 轮 </span><span class="hud-turn-dur"><span class="hud-turn-dot">· </span><span class="hud-turn-text">本轮 0s</span></span><span class="hud-speed"> · —</span><span class="hud-subagent-tag"></span>
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

          <!-- 分段 3: 当前上下文实况 (左侧显示上下文压缩次数徽章，0 次隐藏，>=1 次显示) -->
          <button type="button" class="capsule capsule-context" data-capsule-id="context" aria-haspopup="dialog" aria-expanded="false" aria-label="当前上下文实况明细">
            <span class="hud-compaction-badge" id="hud-compaction-badge" hidden></span>
            <svg class="capsule-donut" viewBox="0 0 56 8" preserveAspectRatio="none" aria-hidden="true">
              <rect x="0.5" y="1.5" width="55" height="5" rx="2.5" fill="var(--hud-progress-track)" stroke="var(--hud-divider)" stroke-width="0.6"/>
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
              <span class="hud-popover-val" id="val-model-dur">0秒</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-tool-dur">工具调用用时</span>
              <span class="hud-popover-val" id="val-tool-dur">0秒</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-ttft">首 token 平均（TTFT）</span>
              <span class="hud-popover-val" id="val-ttft">—</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-tps">输出速度（TPS）</span>
              <span class="hud-popover-val" id="val-tps">—</span>
            </div>
            <div class="hud-popover-row" id="row-turn-dur">
              <span class="hud-popover-label" id="lbl-turn-dur">本轮用时</span>
              <span class="hud-popover-val" id="val-turn-dur">0秒</span>
            </div>
            <div class="hud-popover-row" id="row-subagent-status" hidden>
              <span class="hud-popover-label" id="lbl-subagent-status">子智能体状态</span>
              <span class="hud-popover-val" id="val-subagent-status">—</span>
            </div>
          </div>
          <div class="hud-popover-status-note" id="hud-session-status-note" hidden></div>
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

  resetDomCache() {
    this.domRefs = null;
    this.domRefsShadow = null;
  }

  ensureDomCache() {
    if (!this.shadow) {
      this.resetDomCache();
      return null;
    }
    if (this.domRefsShadow !== this.shadow || !this.domRefs) {
      this.domRefsShadow = this.shadow;
      this.domRefs = { bySelector: new Map(), capsules: null };
    }
    return this.domRefs;
  }

  getShadowEl(selector) {
    const cache = this.ensureDomCache();
    if (!cache) return null;
    if (cache.bySelector.has(selector)) return cache.bySelector.get(selector);
    const el = this.shadow.querySelector(selector);
    if (el) cache.bySelector.set(selector, el);
    return el;
  }

  getShadowCapsules() {
    const cache = this.ensureDomCache();
    if (!cache) return [];
    if (!cache.capsules && typeof this.shadow.querySelectorAll === 'function') {
      cache.capsules = [...this.shadow.querySelectorAll('.capsule')];
    }
    return cache.capsules || [];
  }

  renderSkeleton() {
    if (!this.shadow) return;
    const capsules = this.getShadowCapsules();
    for (const c of capsules) {
      if (c.classList) {
        c.classList.add('is-skeleton');
        c.classList.remove('has-compaction');
      }
    }
    const compBadgeEl = this.getShadowEl('#hud-compaction-badge');
    if (compBadgeEl) {
      compBadgeEl.textContent = '';
      compBadgeEl.setAttribute('hidden', '');
      compBadgeEl.removeAttribute('aria-label');
      compBadgeEl.removeAttribute('data-compaction-tier');
      compBadgeEl.classList?.remove('is-compaction-low', 'is-compaction-warn', 'is-compaction-danger');
    }
    this.hideAllPopovers();
  }

  syncStreamingClass() {
    if (!this.shadow) return;
    const isEn = this.languageMode === 'en';
    const sessionCapsule = this.getShadowEl('.capsule-session');
    const sessionPopover = this.getShadowEl('#hud-popover-session');
    const phase =
      this.activityPhase === 'generating' || this.activityPhase === 'executing'
        ? this.activityPhase
        : 'idle';
    const applyPhaseClasses = (targetElement) => {
      if (!targetElement || !targetElement.classList) return;
      if (phase !== 'idle') {
        targetElement.classList.add('is-streaming');
      } else {
        targetElement.classList.remove('is-streaming');
      }
      if (phase === 'generating') {
        targetElement.classList.add('is-generating');
      } else {
        targetElement.classList.remove('is-generating');
      }
      if (phase === 'executing') {
        targetElement.classList.add('is-executing');
      } else {
        targetElement.classList.remove('is-executing');
      }
    };
    if (sessionCapsule && sessionCapsule.classList) {
      applyPhaseClasses(sessionCapsule);
      if (this.isSubagentRunning) {
        sessionCapsule.classList.add('is-subagent-active');
      } else {
        sessionCapsule.classList.remove('is-subagent-active');
      }
    }
    applyPhaseClasses(sessionPopover);

    const subagentTagEl = this.getShadowEl('#hud-txt-session .hud-subagent-tag');
    const subagentRow = this.getShadowEl('#row-subagent-status');
    const lblSubEl = this.getShadowEl('#lbl-subagent-status');
    const valSubEl = this.getShadowEl('#val-subagent-status');
    const activeSubagents = Math.max(1, this.runningSubagentCount || 1);
    const activeSubagentsBar = formatCompactCount(activeSubagents);
    const activeSubagentsPop = formatDetailCompactNumber(activeSubagents);
    const subStepsCount = Math.max(0, Number(this.lastMetrics?.session?.subagentSteps) || 0);
    const subStepsPop = formatDetailCompactNumber(subStepsCount);
    const subStepSuffix =
      subStepsCount > 0 ? (isEn ? ` (${subStepsPop} steps)` : `（${subStepsPop} 步）`) : '';

    if (this.isSubagentRunning) {
      if (subagentTagEl) {
        subagentTagEl.textContent = isEn
          ? activeSubagents > 1
            ? ` · ${activeSubagentsBar} Subagents`
            : ' · Subagent'
          : activeSubagents > 1
          ? ` · ${activeSubagentsBar} 子智能体运行中`
          : ' · 子智能体运行中';
      }
      if (subagentRow) {
        subagentRow.removeAttribute('hidden');
      }
      if (lblSubEl) {
        lblSubEl.textContent = isEn ? 'Subagents' : '子智能体状态';
      }
      if (valSubEl) {
        valSubEl.textContent = isEn
          ? `${activeSubagentsPop} running${subStepSuffix}`
          : `${activeSubagentsPop} 个运行中${subStepSuffix}`;
      }
    } else {
      if (subagentTagEl) {
        subagentTagEl.textContent = '';
      }
      const totalSubagents = Math.max(0, Number(this.lastMetrics?.session?.subagentCount) || 0);
      if (totalSubagents > 0) {
        if (subagentRow) subagentRow.removeAttribute('hidden');
        if (lblSubEl) lblSubEl.textContent = isEn ? 'Subagents' : '子智能体状态';
        if (valSubEl) {
          const totalSubPop = formatDetailCompactNumber(totalSubagents);
          valSubEl.textContent = isEn
            ? `${totalSubPop} scheduled${subStepSuffix}`
            : `已调度 ${totalSubPop} 个${subStepSuffix}`;
        }
      } else if (subagentRow) {
        subagentRow.setAttribute('hidden', '');
      }
    }
  }

  formatCompactTurnDuration(sec, isEn) {
    return formatTurnDurationCompact(sec, isEn ? 'en' : 'zh');
  }

  stopTurnClock() {
    if (this.turnClockTimer) {
      clearInterval(this.turnClockTimer);
      this.turnClockTimer = null;
    }
    this.turnClockAnchor = null;
    this.modelClockAnchor = null;
    this.toolClockAnchor = null;
  }

  getLiveClockSeconds(anchor, nowMs = Date.now()) {
    if (!anchor) return 0;
    return Math.max(0, anchor.baseSeconds + ((nowMs - anchor.anchorMs) / 1000) * anchor.rate);
  }

  syncSubClock(anchorKey, backendTotal, completedBase, rate, isWorkingNow, nowMs) {
    if (!isWorkingNow || !this.shadow) {
      this[anchorKey] = null;
      return;
    }
    const existing = this[anchorKey];
    if (!existing) {
      this[anchorKey] = {
        baseSeconds: backendTotal,
        anchorMs: nowMs,
        rate,
        lastCompletedBase: completedBase,
        lastRenderedSec: Math.round(backendTotal),
      };
      return;
    }
    const prevElapsed = this.getLiveClockSeconds(existing, nowMs);
    const completedAdvanced = completedBase > existing.lastCompletedBase + 1e-6;
    if (rate !== existing.rate) {
      let nextBase = backendTotal;
      if (rate === 0 && !completedAdvanced && backendTotal <= prevElapsed) {
        nextBase = Math.max(backendTotal, prevElapsed);
      } else if (rate > 0 && existing.rate === 0) {
        nextBase = Math.max(backendTotal, prevElapsed);
      }
      this[anchorKey] = {
        baseSeconds: nextBase,
        anchorMs: nowMs,
        rate,
        lastCompletedBase: completedBase,
        lastRenderedSec: existing.lastRenderedSec,
      };
      return;
    }
    if (rate > 0) {
      if (
        backendTotal > prevElapsed + 0.6 ||
        (completedAdvanced && Math.abs(backendTotal - prevElapsed) > 0.6)
      ) {
        this[anchorKey] = {
          baseSeconds: backendTotal,
          anchorMs: nowMs,
          rate,
          lastCompletedBase: completedBase,
          lastRenderedSec: existing.lastRenderedSec,
        };
      } else if (completedAdvanced) {
        existing.lastCompletedBase = completedBase;
      }
    } else if (completedAdvanced || backendTotal > prevElapsed + 0.6) {
      this[anchorKey] = {
        baseSeconds: backendTotal,
        anchorMs: nowMs,
        rate: 0,
        lastCompletedBase: completedBase,
        lastRenderedSec: existing.lastRenderedSec,
      };
    }
  }

  updateSubClockDom(anchor, selector, isEn, nowMs) {
    if (!anchor || !this.shadow || anchor.rate <= 0) return;
    const elapsedSec = this.getLiveClockSeconds(anchor, nowMs);
    const roundedSec = Math.max(0, Math.round(elapsedSec));
    if (roundedSec === anchor.lastRenderedSec) return;
    anchor.lastRenderedSec = roundedSec;
    const el = this.getShadowEl(selector);
    if (el) {
      const nextText = durationText(elapsedSec, isEn ? 'en' : 'zh');
      if (el.textContent !== nextText) {
        el.textContent = nextText;
      }
    }
  }

  syncTurnClock(metrics, isWorkingNow) {
    const s = metrics?.session || {};
    const backendSec = isRawNumber(s.currentTurnDurationSeconds) ? Math.max(0, s.currentTurnDurationSeconds) : 0;
    const turns = isRawNumber(s.turns) ? s.turns : 0;
    const hasSubagentInTurn = Boolean(
      this.isSubagentRunning ||
      metrics?.isSubagentRunning ||
      (isRawNumber(s.subagentCount) && s.subagentCount > 0) ||
      (isRawNumber(s.subagentSteps) && s.subagentSteps > 0) ||
      (this.turnHighWaterMark && this.turnHighWaterMark.turns === turns && this.turnHighWaterMark.hasSubagent)
    );
    if (!isWorkingNow || !this.shadow) {
      if (this.turnClockAnchor) {
        const liveSec = this.turnClockAnchor.baseSeconds + (Date.now() - this.turnClockAnchor.anchorMs) / 1000;
        const prevHigh = this.turnHighWaterMark && this.turnHighWaterMark.turns === turns
          ? this.turnHighWaterMark.seconds
          : 0;
        this.turnHighWaterMark = {
          turns,
          seconds: Math.max(backendSec, liveSec, prevHigh),
          hasSubagent: hasSubagentInTurn,
        };
      }
      this.stopTurnClock();
      return;
    }
    const nowMs = Date.now();
    const modelBase = isRawNumber(s.modelDurationSeconds) ? Math.max(0, s.modelDurationSeconds) : 0;
    const modelInFlight = isRawNumber(s.inFlightModelDurationSeconds) ? Math.max(0, s.inFlightModelDurationSeconds) : 0;
    const modelBackendTotal = modelBase + modelInFlight;
    const activeModels = isRawNumber(s.activeModelStepCount) ? Math.max(0, Math.floor(s.activeModelStepCount)) : 0;
    const toolBase = isRawNumber(s.toolDurationSeconds) ? Math.max(0, s.toolDurationSeconds) : 0;
    const toolInFlight = isRawNumber(s.inFlightToolDurationSeconds) ? Math.max(0, s.inFlightToolDurationSeconds) : 0;
    const toolBackendTotal = toolBase + toolInFlight;
    const activeTools = isRawNumber(s.activeToolStepCount) ? Math.max(0, Math.floor(s.activeToolStepCount)) : 0;
    let modelRate = activeModels;
    let toolRate = activeTools;
    if (activeModels === 0 && activeTools === 0) {
      if (this.activityPhase === 'executing') toolRate = 1;
      else modelRate = 1;
    }
    this.syncSubClock('modelClockAnchor', modelBackendTotal, modelBase, modelRate, isWorkingNow, nowMs);
    this.syncSubClock('toolClockAnchor', toolBackendTotal, toolBase, toolRate, isWorkingNow, nowMs);

    if (!this.turnClockAnchor) {
      const sameTurnResumeFloor =
        this.turnHighWaterMark &&
        this.turnHighWaterMark.turns === turns &&
        this.turnHighWaterMark.hasSubagent
          ? this.turnHighWaterMark.seconds
          : 0;
      const startSec = Math.max(backendSec, sameTurnResumeFloor);
      this.turnClockAnchor = { baseSeconds: startSec, anchorMs: nowMs, turns, lastRenderedSec: Math.round(startSec) };
    } else if (turns > this.turnClockAnchor.turns) {
      const liveSec = this.turnClockAnchor.baseSeconds + (nowMs - this.turnClockAnchor.anchorMs) / 1000;
      if (this.turnClockAnchor.turns === 0 && turns === 1 && backendSec >= 2 && backendSec < liveSec) {
        // Delayed SQLite flush of turn 1's USER_INPUT row mid-turn: keep live timer uninterrupted.
        this.turnClockAnchor.turns = turns;
      } else {
        this.turnClockAnchor = { baseSeconds: backendSec, anchorMs: nowMs, turns, lastRenderedSec: Math.round(backendSec) };
        this.turnHighWaterMark = null;
      }
    } else {
      const liveSec = this.turnClockAnchor.baseSeconds + (nowMs - this.turnClockAnchor.anchorMs) / 1000;
      if (backendSec > liveSec + 0.5) {
        this.turnClockAnchor = { baseSeconds: backendSec, anchorMs: nowMs, turns, lastRenderedSec: Math.round(backendSec) };
      }
    }
    const currentLive = this.turnClockAnchor.baseSeconds + (nowMs - this.turnClockAnchor.anchorMs) / 1000;
    const prevHigh = this.turnHighWaterMark && this.turnHighWaterMark.turns === turns
      ? this.turnHighWaterMark.seconds
      : 0;
    this.turnHighWaterMark = {
      turns,
      seconds: Math.max(backendSec, currentLive, prevHigh),
      hasSubagent: hasSubagentInTurn,
    };
    if (!this.turnClockTimer) {
      this.turnClockTimer = setInterval(() => this.tickTurnClock(), 250);
      if (typeof this.turnClockTimer?.unref === 'function') {
        this.turnClockTimer.unref();
      }
    }
  }

  setTurnDurationText(label, showDot) {
    if (!this.shadow) return;
    const turnDurEl = this.getShadowEl('#hud-txt-session .hud-turn-dur');
    if (!turnDurEl) return;
    const resolvedShowDot =
      showDot !== undefined
        ? showDot
        : Boolean(this.getShadowEl('#hud-txt-session .hud-turns')?.textContent);
    const dotEl = this.getShadowEl('#hud-txt-session .hud-turn-dot');
    const textEl = this.getShadowEl('#hud-txt-session .hud-turn-text');
    if (dotEl && textEl) {
      const nextDot = resolvedShowDot ? '· ' : '';
      if (dotEl.textContent !== nextDot) {
        dotEl.textContent = nextDot;
      }
      if (textEl.textContent !== label) {
        textEl.textContent = label;
      }
      return;
    }
    const nextTurnText = resolvedShowDot ? `· ${label}` : label;
    if (turnDurEl.textContent !== nextTurnText) {
      turnDurEl.textContent = nextTurnText;
    }
  }

  tickTurnClock() {
    if (
      !this.turnClockAnchor ||
      !this.shadow ||
      !(this.hasActiveWork || this.isStreaming || this.isSubagentRunning)
    ) {
      this.stopTurnClock();
      return;
    }
    const nowMs = Date.now();
    const isEn = this.languageMode === 'en';
    this.updateSubClockDom(this.modelClockAnchor, '#val-model-dur', isEn, nowMs);
    this.updateSubClockDom(this.toolClockAnchor, '#val-tool-dur', isEn, nowMs);
    const elapsedSec = this.turnClockAnchor.baseSeconds + (nowMs - this.turnClockAnchor.anchorMs) / 1000;
    if (this.turnHighWaterMark && this.turnHighWaterMark.turns === this.turnClockAnchor.turns) {
      this.turnHighWaterMark.seconds = Math.max(this.turnHighWaterMark.seconds, elapsedSec);
    }
    const roundedSec = Math.max(0, Math.round(elapsedSec));
    if (roundedSec === this.turnClockAnchor.lastRenderedSec) return;
    this.turnClockAnchor.lastRenderedSec = roundedSec;
    this.setTurnDurationText(this.formatCompactTurnDuration(elapsedSec, isEn));
    const valTurnDurEl = this.getShadowEl('#val-turn-dur');
    if (valTurnDurEl) {
      const nextCardText = durationText(elapsedSec, isEn ? 'en' : 'zh');
      if (valTurnDurEl.textContent !== nextCardText) {
        valTurnDurEl.textContent = nextCardText;
      }
    }
  }

  applyMetricsToDom(metrics) {
    if (!this.shadow || !metrics) return;
    const isEn = this.languageMode === 'en';
    const q = (sel) => this.getShadowEl(sel);

    const capsules = this.getShadowCapsules();
    for (const c of capsules) {
      if (c.classList) c.classList.remove('is-skeleton');
    }
    this.syncStreamingClass();

    const s = metrics.session || {};
    const t = metrics.tokens || {};
    const c = metrics.context || {};
    const b = c.breakdown || {};
    const unavailable = metrics.availability === 'unavailable' || metrics.availability === 'loading';
    const hasContextUsage = !unavailable && c.hasUsageData !== false;

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

    // 1. 更新分段 1 (会话统计 + 子智能体实时工作状态 - 采用紧凑数字表示法)
    const turnsEl = q('#hud-txt-session .hud-turns');
    const turnDurEl = q('#hud-txt-session .hud-turn-dur');
    const speedEl = q('#hud-txt-session .hud-speed');
    const subagentTagEl = q('#hud-txt-session .hud-subagent-tag');
    const rawTurns = isRawNumber(s.turns) ? s.turns : 0;
    const rawSteps = isRawNumber(s.steps) ? s.steps : 0;
    const turnsBarCount = formatCompactCount(rawTurns);
    const turnsPopCount = formatDetailCompactNumber(rawTurns);
    const stepsPopCount = formatDetailCompactNumber(rawSteps);
    const activeSubagentsBar = formatCompactCount(activeSubagents);
    const isWorkingNow = Boolean(this.hasActiveWork || this.isStreaming || this.isSubagentRunning);
    const clockActive = isWorkingNow && !unavailable;
    this.syncTurnClock(metrics, clockActive);
    const clockNowMs = Date.now();
    const subagentTurnFloor =
      !isWorkingNow &&
      this.turnHighWaterMark &&
      this.turnHighWaterMark.turns === rawTurns &&
      this.turnHighWaterMark.hasSubagent
        ? this.turnHighWaterMark.seconds
        : 0;
    const rawBackendTurnSec = isRawNumber(s.currentTurnDurationSeconds) ? Math.max(0, s.currentTurnDurationSeconds) : null;
    const effectiveIdleTurnSec =
      rawBackendTurnSec !== null
        ? Math.max(rawBackendTurnSec, subagentTurnFloor)
        : subagentTurnFloor > 0
        ? subagentTurnFloor
        : null;
    const liveElapsedSec = clockActive && this.turnClockAnchor
      ? Math.max(
          rawBackendTurnSec ?? 0,
          this.turnClockAnchor.baseSeconds + (clockNowMs - this.turnClockAnchor.anchorMs) / 1000
        )
      : effectiveIdleTurnSec;
    const liveModelSec = clockActive && this.modelClockAnchor
      ? this.getLiveClockSeconds(this.modelClockAnchor, clockNowMs)
      : s.modelDurationSeconds;
    const liveToolSec = clockActive && this.toolClockAnchor
      ? this.getLiveClockSeconds(this.toolClockAnchor, clockNowMs)
      : s.toolDurationSeconds;
    if (this.modelClockAnchor && isRawNumber(liveModelSec)) {
      this.modelClockAnchor.lastRenderedSec = Math.max(0, Math.round(liveModelSec));
    }
    if (this.toolClockAnchor && isRawNumber(liveToolSec)) {
      this.toolClockAnchor.lastRenderedSec = Math.max(0, Math.round(liveToolSec));
    }
    const tpsText = (digits) =>
      s.outputTpsFormatted === '计算中...' ||
      (isWorkingNow && !(Number(s.samples?.timed) > 0) && s.outputTpsFormatted === '—')
        ? (isEn ? 'Measuring…' : '计算中...')
        : formatMetric(s.outputTps, s.outputTpsFormatted, digits, ' tok/s');

    if (turnsEl) {
      turnsEl.textContent =
        this.isSubpane && rawTurns === 0 && rawSteps > 0
          ? ''
          : isEn
          ? `${turnsBarCount}T `
          : `${turnsBarCount} 轮 `;
    }
    if (turnDurEl) {
      let compactDur;
      if (liveElapsedSec !== null && (isWorkingNow || subagentTurnFloor > (rawBackendTurnSec ?? 0))) {
        compactDur = this.formatCompactTurnDuration(liveElapsedSec, isEn);
      } else {
        compactDur = isEn
          ? (s.currentTurnDurationCompactEn || (liveElapsedSec !== null ? this.formatCompactTurnDuration(liveElapsedSec, true) : 'Turn 0s'))
          : (s.currentTurnDurationCompactZh || (liveElapsedSec !== null ? this.formatCompactTurnDuration(liveElapsedSec, false) : '本轮 0s'));
      }
      this.setTurnDurationText(compactDur, Boolean(turnsEl?.textContent));
    }
    if (speedEl) speedEl.textContent = ` · ${tpsText(0)}`;
    if (subagentTagEl) {
      if (subagentRunning) {
        subagentTagEl.textContent = isEn
          ? activeSubagents > 1
            ? ` · ${activeSubagentsBar} Subagents`
            : ' · Subagent'
          : activeSubagents > 1
          ? ` · ${activeSubagentsBar} 子智能体运行中`
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

    // 3. 更新分段 3 (上下文实况 + 左侧上下文压缩次数徽章)
    const ctxCapsule = q('.capsule-context');
    const compBadgeEl = q('#hud-compaction-badge');
    const ctxTxtEl = q('#hud-txt-context');
    const meterFillEl = q('#hud-meter-fill');
    const compCount = Math.max(0, Math.floor(Number(s.compactionCount) || 0));
    if (compBadgeEl) {
      compBadgeEl.classList?.remove('is-compaction-low', 'is-compaction-warn', 'is-compaction-danger');
      if (compCount >= 1) {
        const compTier = compCount >= 3 ? 'danger' : compCount === 2 ? 'warn' : 'low';
        const compBarText = formatCompactCount(compCount);
        compBadgeEl.textContent = compBarText;
        compBadgeEl.removeAttribute('hidden');
        compBadgeEl.setAttribute('data-compaction-tier', compTier);
        compBadgeEl.classList?.add(`is-compaction-${compTier}`);
        compBadgeEl.setAttribute(
          'aria-label',
          isEn ? `Compacted ${compBarText} times` : `已压缩 ${compBarText} 次`
        );
        ctxCapsule?.classList?.add('has-compaction');
      } else {
        compBadgeEl.textContent = '';
        compBadgeEl.setAttribute('hidden', '');
        compBadgeEl.removeAttribute('aria-label');
        compBadgeEl.removeAttribute('data-compaction-tier');
        ctxCapsule?.classList?.remove('has-compaction');
      }
    }

    const ratioClamped = hasContextUsage ? Math.min(1.0, Math.max(0, Number(c.usedRatio) || 0)) : 0;
    const usedCompact = hasContextUsage ? formatCompactCount(c.usedTokens, c.usedTokensCompact) : '—';
    const contextRatio = hasContextUsage ? c.usedRatio : undefined;
    const pctText = `${hasContextUsage && isRawNumber(contextRatio) && c.isFallbackCapacity ? '~' : ''}${formatPercent(contextRatio, c.usedRatioFormatted, 0)}`;

    if (ctxTxtEl) {
      ctxTxtEl.textContent = pctText;
      ctxTxtEl.setAttribute('data-used-tokens', usedCompact);
    }

    const isDark = Boolean(this.isDarkTheme || this.host?.getAttribute?.('data-theme') === 'dark');
    const strokeColor = computeContextProgressColor(ratioClamped, isDark);

    if (meterFillEl) {
      const fillWidth = Number((54 * ratioClamped).toFixed(2));
      meterFillEl.setAttribute('width', String(fillWidth));
      meterFillEl.setAttribute('fill', strokeColor);
    }

    // 4. 更新 Popover 1 (会话统计 - 采用紧凑数字表示法)
    const setTxt = (sel, val) => {
      const el = q(sel);
      if (el) el.textContent = val;
    };
    setTxt('#pop-session-title', isEn ? 'Session Stats' : '会话统计');
    setTxt(
      '#pop-session-badge',
      isEn ? `${turnsPopCount} turns ${stepsPopCount} steps` : `${turnsPopCount} 轮 ${stepsPopCount} 步`
    );
    setTxt('#lbl-model-dur', isEn ? 'Model Duration' : '模型用时');
    setTxt(
      '#val-model-dur',
      formatDuration(liveModelSec, s.modelDurationFormatted, isEn)
    );
    setTxt('#lbl-tool-dur', isEn ? 'Tool Duration' : '工具调用用时');
    setTxt(
      '#val-tool-dur',
      formatDuration(liveToolSec, s.toolDurationFormatted, isEn)
    );
    setTxt('#lbl-ttft', isEn ? 'Avg TTFT' : '首 token 平均（TTFT）');
    setTxt(
      '#val-ttft',
      formatMetric(s.averageTtftSeconds, s.averageTtftFormatted, 2, isEn ? 's' : ' 秒')
    );
    setTxt('#lbl-tps', isEn ? 'Output Speed (TPS)' : '输出速度（TPS）');
    setTxt('#val-tps', tpsText(2));
    setTxt('#lbl-turn-dur', isEn ? 'Turn Duration' : '本轮用时');
    const cardTurnSec = liveElapsedSec !== null && (isWorkingNow || subagentTurnFloor > (rawBackendTurnSec ?? 0))
      ? liveElapsedSec
      : s.currentTurnDurationSeconds;
    const turnDurFormatted = isEn
      ? (isRawNumber(cardTurnSec) && (isWorkingNow || subagentTurnFloor > (rawBackendTurnSec ?? 0) || s.currentTurnDurationFormattedEn !== '—')
        ? durationText(cardTurnSec, 'en')
        : (s.currentTurnDurationFormattedEn || '—'))
      : (isRawNumber(cardTurnSec) && (isWorkingNow || subagentTurnFloor > (rawBackendTurnSec ?? 0) || s.currentTurnDurationFormatted !== '—')
        ? durationText(cardTurnSec, 'zh')
        : (s.currentTurnDurationFormatted || '—'));
    setTxt('#val-turn-dur', turnDurFormatted);
    const modelTurnSec = durationText(Number(s.currentTurnModelDurationSeconds || 0), isEn ? 'en' : 'zh');
    const toolTurnSec = durationText(Number(s.currentTurnToolDurationSeconds || 0), isEn ? 'en' : 'zh');
    q('#val-turn-dur')?.setAttribute(
      'aria-description',
      isEn
        ? `Model: ${modelTurnSec}, Tools: ${toolTurnSec}`
        : `思考：${modelTurnSec}，工具：${toolTurnSec}`
    );
    const statusNoteEl = q('#hud-session-status-note');
    if (statusNoteEl) {
      if (metrics.availability === 'partial' || metrics.availability === 'cached') {
        const obs = metrics.observedAt
          ? new Date(metrics.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          : '';
        statusNoteEl.textContent =
          metrics.availability === 'cached'
            ? (isEn ? `Cached snapshot${obs ? ` (${obs})` : ''}` : `沿用缓存快照${obs ? `（${obs}）` : ''}`)
            : (isEn ? `Partial data${obs ? ` (${obs})` : ''}` : `部分数据或子库未就绪${obs ? `（${obs}）` : ''}`);
        statusNoteEl.removeAttribute('hidden');
      } else {
        statusNoteEl.textContent = '';
        statusNoteEl.setAttribute('hidden', '');
      }
    }
    q('#val-ttft')?.setAttribute('aria-description', isEn
      ? 'Average of the host’s original TTFT field.'
      : '按宿主原始 TTFT 字段统计的平均值。');
    q('#val-tps')?.setAttribute('aria-description', isEn
      ? 'Calculated from host generation time, including waiting time.'
      : '按宿主生成时间计算，包含等待时间。');

    const subagentRow = q('#row-subagent-status');
    const subStepsCount = Math.max(0, Number(s.subagentSteps) || 0);
    const subStepsPop = formatDetailCompactNumber(subStepsCount);
    const activeSubagentsPop = formatDetailCompactNumber(activeSubagents);
    const totalSubagentsPop = formatDetailCompactNumber(totalSubagents);
    const subStepSuffix =
      subStepsCount > 0 ? (isEn ? ` (${subStepsPop} steps)` : `（${subStepsPop} 步）`) : '';
    if (subagentRow) {
      if (subagentRunning || totalSubagents > 0) {
        subagentRow.removeAttribute('hidden');
        setTxt('#lbl-subagent-status', isEn ? 'Subagents' : '子智能体状态');
        if (subagentRunning) {
          setTxt(
            '#val-subagent-status',
            isEn
              ? `${activeSubagentsPop} running${subStepSuffix}`
              : `${activeSubagentsPop} 个运行中${subStepSuffix}`
          );
        } else {
          setTxt(
            '#val-subagent-status',
            isEn
              ? `${totalSubagentsPop} scheduled${subStepSuffix}`
              : `已调度 ${totalSubagentsPop} 个${subStepSuffix}`
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
    setTxt('#val-cache-hit', formatPopoverPercent(t.cacheHitRate, t.cacheHitRateFormatted));
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
    setTxt('#pop-ctx-pct', `${hasContextUsage && isRawNumber(contextRatio) && c.isFallbackCapacity ? '~' : ''}${formatPopoverPercent(contextRatio, c.usedRatioFormatted)}`);
    const capacityText = isRawNumber(c.capacityTokens) && c.capacityTokens > 0
      ? `${c.isFallbackCapacity ? '~' : ''}${formatDetailCompactNumber(c.capacityTokens)}` : '—';
    const usedText = hasContextUsage && isRawNumber(c.usedTokens) ? formatDetailCompactNumber(c.usedTokens) : '—';
    setTxt(
      '#pop-ctx-capacity',
      `${usedText} / ${capacityText}`
    );

    const trackEl = q('#pop-ctx-track');
    if (trackEl) {
      trackEl.setAttribute('aria-valuenow', String(Math.round(ratioClamped * 100)));
      trackEl.setAttribute('aria-valuetext', formatPopoverPercent(contextRatio, c.usedRatioFormatted));
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
      const hasPeakData = hasContextUsage || (isRawNumber(c.peakContextTokens) && c.peakContextTokens > 0);
      if (!hasPeakData) {
        setTxt('#val-ctx-peak', '—');
      } else {
        const peakVal = formatTokenCount(
          c.peakContextTokens ?? c.usedTokens,
          c.peakContextFormatted || c.usedTokensFormatted
        );
        const compPopText = formatDetailCompactNumber(compCount);
        const compSuffix =
          compCount > 0 ? (isEn ? ` (${compPopText}x compacted)` : ` (已压缩 ${compPopText} 次)`) : '';
        setTxt('#val-ctx-peak', `${peakVal}${compSuffix}`);
      }
    }
    const modelRow = q('#row-ctx-model');
    if (modelRow) {
      setTxt('#lbl-ctx-model', isEn ? 'Active Model' : '当前模型');
      setTxt('#val-ctx-model', c.modelDisplayName || c.modelId || '—');
    }

    // 7. 同步中英文无障碍标签 (aria-label) 与可核查精确整数摘要 (data-exact-summary)
    const toolbarEl = q('.hud-container');
    if (toolbarEl) {
      toolbarEl.setAttribute(
        'aria-label',
        isEn ? 'Antigravity Conversation Telemetry Bar' : 'Antigravity 会话遥测状态栏'
      );
      if (metrics.availability) {
        toolbarEl.setAttribute('data-availability', String(metrics.availability));
      }
    }
    const phase =
      this.activityPhase === 'generating' || this.activityPhase === 'executing'
        ? this.activityPhase
        : 'idle';
    const phaseText = isEn
      ? phase === 'generating'
        ? 'Generating'
        : phase === 'executing'
        ? 'Executing'
        : 'Idle'
      : phase === 'generating'
      ? '模型生成中'
      : phase === 'executing'
      ? '工具执行中'
      : '空闲';

    const capSession = q('.capsule-session');
    const capTokens = q('.capsule-tokens');
    const capContext = q('.capsule-context');
    const sessionReadout = (q('#hud-txt-session')?.textContent || '').replace(/\s+/g, ' ').trim();
    const tokensReadout = (q('#hud-txt-tokens')?.textContent || '').replace(/\s+/g, ' ').trim();
    const contextReadout = pctText;
    if (capSession) {
      capSession.setAttribute(
        'aria-label',
        isEn
          ? `Session Stats (${phaseText}): ${sessionReadout}`
          : `会话统计明细（${phaseText}）：${sessionReadout}`
      );
    }
    if (capTokens) {
      capTokens.setAttribute(
        'aria-label',
        isEn ? `Token Usage: ${tokensReadout}` : `Token 用量明细：${tokensReadout}`
      );
    }
    if (capContext) {
      const compNote =
        compCount >= 1
          ? isEn
            ? `, Compacted ${formatCompactCount(compCount)} times`
            : `，已压缩 ${formatCompactCount(compCount)} 次`
          : '';
      capContext.setAttribute(
        'aria-label',
        isEn
          ? `Current Context: ${contextReadout}${compNote}`
          : `当前上下文实况明细：${contextReadout}${compNote}`
      );
    }

    const popSession = q('#hud-popover-session');
    const popTokens = q('#hud-popover-tokens');
    const popContext = q('#hud-popover-context');
    if (popSession) {
      popSession.setAttribute('aria-label', isEn ? 'Session Stats Details' : '会话统计明细');
      popSession.setAttribute(
        'data-exact-summary',
        `turns=${rawTurns}; steps=${rawSteps}; modelSec=${Number(s.modelDurationSeconds || 0).toFixed(2)}; toolSec=${Number(s.toolDurationSeconds || 0).toFixed(2)}; ttftSec=${Number(s.averageTtftSeconds || 0).toFixed(2)}; tps=${Number(s.outputTps || 0).toFixed(2)}`
      );
    }
    if (popTokens) {
      popTokens.setAttribute('aria-label', isEn ? 'Token Usage Details' : 'Token 用量明细');
      popTokens.setAttribute(
        'data-exact-summary',
        `total=${Math.floor(Number(t.totalTokens) || 0)}; uncachedInput=${Math.floor(Number(t.uncachedInputTokens) || 0)}; cachedRead=${Math.floor(Number(t.cachedReadTokens) || 0)}; cacheWrite=${Math.floor(Number(t.cacheWriteTokens) || 0)}; output=${Math.floor(Number(t.outputTokens) || 0)}; reasoning=${Math.floor(Number(t.reasoningTokens) || 0)}; reply=${Math.floor(Number(t.candidateTokens) || 0)}`
      );
    }
    if (popContext) {
      popContext.setAttribute('aria-label', isEn ? 'Current Context Details' : '当前上下文实况明细');
      popContext.setAttribute(
        'data-exact-summary',
        `used=${Math.floor(Number(c.usedTokens) || 0)}; capacity=${Math.floor(Number(c.capacityTokens) || 0)}; peak=${Math.floor(Number(c.peakContextTokens ?? c.usedTokens) || 0)}; compactions=${compCount}; model=${c.modelDisplayName || c.modelId || ''}`
      );
    }

    if (unavailable) {
      const isLoad = metrics.availability === 'loading';
      const isNewConv = metrics.conversationId === 'default';
      const sessionEmptyLabel = isLoad
        ? (isEn ? 'Loading…' : '读取中…')
        : isNewConv
        ? (isEn ? 'New Chat' : '新会话')
        : (isEn ? 'No Data' : '暂无数据');
      for (const button of capsules) button.setAttribute('aria-label', isEn ? 'Data unavailable' : '数据暂不可用');
      setTxt('#hud-txt-session .hud-turns', '');
      this.setTurnDurationText(sessionEmptyLabel, false);
      setTxt('#hud-txt-session .hud-speed', '');
      for (const sel of ['#hud-txt-tokens .hud-tok-total','#hud-txt-tokens .hud-cache-val','#hud-txt-context','#pop-session-badge','#pop-tokens-badge','#val-cache-hit','#val-uncached-in','#val-cached-read','#val-output-tok','#val-model-dur','#val-tool-dur','#val-ttft','#val-tps','#val-turn-dur','#val-ctx-peak']) setTxt(sel, '—');
    }
    if (this.activePopoverId) this.repositionActivePopover();
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

    // 先在未激活过渡态完成定位与祖先包含块校准，触发一次布局后再附加 is-visible 以保留 130ms 入场过渡动画
    this.repositionActivePopover();
    const activePop = this.shadow.querySelector(`#hud-popover-${id}`);
    if (activePop && activePop.classList) {
      void activePop.offsetWidth;
      activePop.classList.add('is-visible');
    }
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
      const measuredHeight =
        typeof popover.scrollHeight === 'number' && popover.scrollHeight > 40
          ? Math.min(popover.scrollHeight, 480)
          : 195;
      const pos = calcFn(capsule, standardWidth, measuredHeight, 12, 8, 12);
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
    this.stopTurnClock();
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
    if (this.host) {
      this.host.remove();
      this.host = null;
    }
    this.shadow = null;
    this.resetDomCache();
    this.targetComposer = null;
    this.activePopoverId = null;
    this.pinnedPopoverId = null;
  }
}

globalThis.__GRAVITYBOX_HUD_INSTANCE__ = { HudInstance };
