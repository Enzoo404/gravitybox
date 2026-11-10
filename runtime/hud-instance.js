import { HUD_STYLES_CSS } from './hud-styles.js';
import { computeUpwardPopoverPosition, applyPopoverGeometry } from './hud-popover.js';

/**
 * 单分栏自治 HUD 实例 (HudInstance)
 * 包含 Open Shadow DOM 双向隔离、AbortController 信号守卫、双重令牌防篡改与向上自适应 Popover
 */

const POPOVER_WIDTHS = {
  session: 270,
  tokens: 290,
  context: 280,
};

const DONUT_CIRCUMFERENCE = 37.699;

function createDefaultMetrics(conversationId = 'default', sessionRevision = 1) {
  return {
    conversationId,
    sessionRevision,
    updatedAt: Date.now(),
    isStreaming: false,
    session: {
      turns: 0,
      steps: 0,
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
      modelId: 'gemini-4-argon',
      modelDisplayName: 'Gemini 4 Argon',
      usedTokens: 0,
      usedTokensCompact: '0',
      capacityTokens: 1048576,
      capacityTokensCompact: '1M',
      usedRatio: 0,
      usedRatioFormatted: '0%',
      breakdown: {
        systemTokens: 0,
        systemTokensCompact: '0',
        systemRatio: 0,
        toolTokens: 0,
        toolTokensCompact: '0',
        toolRatio: 0,
        messageTokens: 0,
        messageTokensCompact: '0',
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
    this.currentModelId = 'gemini-4-argon';
    this.isStreaming = false;
    this.abortController = null;
    this.resizeObserver = null;
    this.host = null;
    this.shadow = null;
    this.targetComposer = null;
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

  switchConversation(newConvId, modelId = null, isStreaming = false) {
    if (!newConvId) return this.sessionRevision;
    const changed = this.currentConvId !== newConvId;
    this.currentConvId = newConvId;
    if (modelId) this.currentModelId = modelId;
    this.isStreaming = Boolean(isStreaming);
    if (changed) {
      this.sessionRevision++;
      this.renderSkeleton();
      this.emitBridgeEvent('SESSION_ATTACHED');
    }
    return this.sessionRevision;
  }

  notifyModelOrStreamingChange(modelId, isStreaming) {
    let changed = false;
    if (modelId && modelId !== this.currentModelId) {
      this.currentModelId = modelId;
      changed = true;
      this.emitBridgeEvent('MODEL_CHANGED');
    }
    if (typeof isStreaming === 'boolean' && isStreaming !== this.isStreaming) {
      this.isStreaming = isStreaming;
      this.syncStreamingClass();
      changed = true;
      this.emitBridgeEvent('STREAMING_CHANGED');
    }
    return changed;
  }

  emitBridgeEvent(type) {
    if (!this.currentConvId) return;
    const payload = {
      type,
      conversationId: this.currentConvId,
      cascadeId: this.cascadeId,
      sessionRevision: this.sessionRevision,
      modelId: this.currentModelId,
      isStreaming: this.isStreaming,
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
    this.lastMetrics = metrics;
    this.isStreaming = Boolean(metrics.isStreaming);
    this.applyMetricsToDom(metrics);
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
    const isDark =
      document.body?.classList?.contains('theme-dark') ||
      document.documentElement?.classList?.contains('dark') ||
      document.documentElement?.getAttribute('data-theme') === 'dark' ||
      document.body?.getAttribute('data-theme') === 'dark' ||
      (typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-color-scheme: dark)')?.matches);
    if (isDark) {
      this.host.setAttribute('data-theme', 'dark');
    } else {
      this.host.removeAttribute('data-theme');
    }
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
    this.host.setAttribute('data-agzh-protect', 'true');
    this.host.setAttribute('data-gravitybox-hud', 'v1');
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
    this.syncTheme();
  }

  buildHudHtml() {
    return `
      <div class="hud-container" id="hud-toolbar" role="toolbar" aria-label="会话状态监控">
        <!-- 胶囊 1: 会话统计 (flex-shrink: 1, min-width: 38px) -->
        <button type="button" class="capsule capsule-session" data-capsule-id="session" aria-haspopup="dialog" aria-expanded="false" title="查看会话用时与速度明细">
          <svg class="capsule-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM7.25 4v4.5l3.5 2.1.75-1.23-2.75-1.62V4h-1.5z" fill="currentColor"/>
          </svg>
          <span class="capsule-text" id="hud-txt-session">
            <span class="hud-turns">0 轮 </span><span class="hud-steps">0 步</span><span class="hud-speed"> · —</span>
          </span>
        </button>

        <!-- 胶囊 2: Token 用量 (flex-shrink: 2, min-width: 38px) -->
        <button type="button" class="capsule capsule-tokens" data-capsule-id="tokens" aria-haspopup="dialog" aria-expanded="false" title="查看 Token 与缓存命中分布">
          <svg class="capsule-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 4c0-1.657 2.686-3 6-3s6 1.343 6 3-2.686 3-6 3-6-1.343-6-3zm0 4c0 1.657 2.686 3 6 3s6-1.343 6-3v1.5c0 1.657-2.686 3-6 3s-6-1.343-6-3V8zm0 4c0 1.657 2.686 3 6 3s6-1.343 6-3v1.5c0 1.657-2.686 3-6 3s-6-1.343-6-3V12z" fill="currentColor"/>
          </svg>
          <span class="capsule-text" id="hud-txt-tokens">
            <span class="hud-tok-total">0 tok</span><span class="hud-tok-cache"><span class="hud-cache-dot"> · </span><span class="hud-cache-prefix">缓存</span><span class="hud-cache-label">命中</span><span class="hud-cache-space"> </span><span class="hud-cache-val">0%</span></span>
          </span>
        </button>

        <!-- 胶囊 3: 上下文窗口 (flex-shrink: 0, 永不截断) -->
        <button type="button" class="capsule capsule-context" data-capsule-id="context" aria-haspopup="dialog" aria-expanded="false" title="查看上下文窗口容量分布">
          <svg class="capsule-donut" viewBox="0 0 16 16" aria-hidden="true">
            <circle class="donut-bg" cx="8" cy="8" r="6" stroke="var(--hud-border)" stroke-width="2.2" fill="none"/>
            <circle class="donut-val" id="hud-donut-val" cx="8" cy="8" r="6" stroke="var(--hud-seg-msg-color)" stroke-width="2.2" fill="none"
                    stroke-dasharray="37.699" stroke-dashoffset="37.699" stroke-linecap="round" transform="rotate(-90 8 8)"/>
          </svg>
          <span class="capsule-text" id="hud-txt-context">0%</span>
        </button>
      </div>

      <!-- 向上展开详情卡片 1: 会话统计 (270px) -->
      <div class="hud-popover" id="hud-popover-session" data-popover-id="session" role="dialog" aria-label="会话统计明细" hidden>
        <div class="hud-popover-inner">
          <div class="hud-popover-header">
            <span class="hud-popover-title">
              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM7.25 4v4.5l3.5 2.1.75-1.23-2.75-1.62V4h-1.5z" fill="currentColor"/>
              </svg>
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
          </div>
        </div>
        <div class="hud-popover-arrow" id="arrow-session">
          <svg viewBox="0 0 14 6" aria-hidden="true">
            <path d="M0 0 L7 6 L14 0 Z" fill="var(--hud-popover-bg)" stroke="var(--hud-popover-border)" stroke-width="1"/>
          </svg>
        </div>
      </div>

      <!-- 向上展开详情卡片 2: Token 用量 (290px) -->
      <div class="hud-popover" id="hud-popover-tokens" data-popover-id="tokens" role="dialog" aria-label="Token 用量明细" hidden>
        <div class="hud-popover-inner">
          <div class="hud-popover-header">
            <span class="hud-popover-title">
              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2 4c0-1.657 2.686-3 6-3s6 1.343 6 3-2.686 3-6 3-6-1.343-6-3zm0 4c0 1.657 2.686 3 6 3s6-1.343 6-3v1.5c0 1.657-2.686 3-6 3s-6-1.343-6-3V8zm0 4c0 1.657 2.686 3 6 3s6-1.343 6-3v1.5c0 1.657-2.686 3-6 3s-6-1.343-6-3V12z" fill="currentColor"/>
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
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-output-tok">输出</span>
              <span class="hud-popover-val" id="val-output-tok">0 tok</span>
            </div>
          </div>
        </div>
        <div class="hud-popover-arrow" id="arrow-tokens">
          <svg viewBox="0 0 14 6" aria-hidden="true">
            <path d="M0 0 L7 6 L14 0 Z" fill="var(--hud-popover-bg)" stroke="var(--hud-popover-border)" stroke-width="1"/>
          </svg>
        </div>
      </div>

      <!-- 向上展开详情卡片 3: 上下文窗口 (280px) -->
      <div class="hud-popover" id="hud-popover-context" data-popover-id="context" role="dialog" aria-label="上下文窗口明细" hidden>
        <div class="hud-popover-inner">
          <div class="hud-popover-header">
            <span class="hud-popover-title">
              <span class="hud-popover-title-regular" id="pop-ctx-prefix">上下文已用 </span>
              <span class="hud-popover-title-strong" id="pop-ctx-pct">0%</span>
            </span>
            <span class="hud-popover-badge-muted" id="pop-ctx-capacity">0 / 1M</span>
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
                <span id="lbl-seg-sys">系统提示词</span>
              </span>
              <span class="hud-popover-val" id="val-seg-sys">0</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label">
                <span class="hud-legend-dot" style="background-color: var(--hud-seg-tool-color)"></span>
                <span id="lbl-seg-tool">工具定义</span>
              </span>
              <span class="hud-popover-val" id="val-seg-tool">0</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label">
                <span class="hud-legend-dot" style="background-color: var(--hud-seg-msg-color)"></span>
                <span id="lbl-seg-msg">对话消息</span>
              </span>
              <span class="hud-popover-val" id="val-seg-msg">0</span>
            </div>
          </div>
        </div>
        <div class="hud-popover-arrow" id="arrow-context">
          <svg viewBox="0 0 14 6" aria-hidden="true">
            <path d="M0 0 L7 6 L14 0 Z" fill="var(--hud-popover-bg)" stroke="var(--hud-popover-border)" stroke-width="1"/>
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
    const sessionCapsule = this.shadow.querySelector('.capsule-session');
    if (sessionCapsule && sessionCapsule.classList) {
      if (this.isStreaming) sessionCapsule.classList.add('is-streaming');
      else sessionCapsule.classList.remove('is-streaming');
    }
  }

  applyMetricsToDom(metrics) {
    if (!this.shadow || !metrics) return;
    const isEn = this.languageMode === 'en';
    const q = (sel) => this.shadow.querySelector(sel);

    // 移除骨架屏状态
    const capsules = this.shadow.querySelectorAll('.capsule');
    for (const c of capsules) {
      if (c.classList) c.classList.remove('is-skeleton');
    }
    this.syncStreamingClass();

    const s = metrics.session || {};
    const t = metrics.tokens || {};
    const c = metrics.context || {};
    const b = c.breakdown || {};

    // 1. 更新胶囊 1 (会话统计)
    const turnsEl = q('#hud-txt-session .hud-turns');
    const stepsEl = q('#hud-txt-session .hud-steps');
    const speedEl = q('#hud-txt-session .hud-speed');
    const turnsCount = s.turns ?? 0;
    const stepsCount = s.steps ?? 0;
    const tpsText = s.outputTpsFormatted || '—';

    if (turnsEl) turnsEl.textContent = isEn ? `${turnsCount}T ` : `${turnsCount} 轮 `;
    if (stepsEl) stepsEl.textContent = isEn ? `${stepsCount}S` : `${stepsCount} 步`;
    if (speedEl) speedEl.textContent = ` · ${tpsText}`;

    // 2. 更新胶囊 2 (Token 用量)
    const tokTotalEl = q('#hud-txt-tokens .hud-tok-total');
    const cachePrefixEl = q('#hud-txt-tokens .hud-cache-prefix');
    const cacheLabelEl = q('#hud-txt-tokens .hud-cache-label');
    const cacheValEl = q('#hud-txt-tokens .hud-cache-val');
    if (tokTotalEl) tokTotalEl.textContent = t.totalTokensCompact || '0 tok';
    if (cachePrefixEl) cachePrefixEl.textContent = isEn ? 'Cache' : '缓存';
    if (cacheLabelEl) cacheLabelEl.textContent = isEn ? ' Hit' : '命中';
    if (cacheValEl) cacheValEl.textContent = t.cacheHitRateFormatted || '0%';

    // 3. 更新胶囊 3 (上下文窗口)
    const ctxTxtEl = q('#hud-txt-context');
    const donutValEl = q('#hud-donut-val');
    const ratioClamped = Math.min(1.0, Math.max(0, Number(c.usedRatio) || 0));
    if (ctxTxtEl) ctxTxtEl.textContent = c.usedRatioFormatted || '0%';
    if (donutValEl) {
      const offset = Number((DONUT_CIRCUMFERENCE * (1 - ratioClamped)).toFixed(2));
      donutValEl.setAttribute('stroke-dashoffset', String(offset));
      if (ratioClamped >= 0.9) {
        donutValEl.setAttribute('stroke', 'var(--hud-danger-color)');
      } else if (ratioClamped >= 0.75) {
        donutValEl.setAttribute('stroke', 'var(--hud-warn-color)');
      } else {
        donutValEl.setAttribute('stroke', 'var(--hud-seg-msg-color)');
      }
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
      isEn
        ? s.modelDurationFormattedEn || s.modelDurationFormatted || '0s'
        : s.modelDurationFormatted || '0 秒'
    );
    setTxt('#lbl-tool-dur', isEn ? 'Tool Duration' : '工具调用用时');
    setTxt(
      '#val-tool-dur',
      isEn
        ? s.toolDurationFormattedEn || s.toolDurationFormatted || '0s'
        : s.toolDurationFormatted || '0 秒'
    );
    setTxt('#lbl-ttft', isEn ? 'Avg TTFT' : '首 token 平均（TTFT）');
    setTxt(
      '#val-ttft',
      isEn
        ? s.averageTtftFormattedEn || s.averageTtftFormatted || '—'
        : s.averageTtftFormatted || '—'
    );
    setTxt('#lbl-tps', isEn ? 'Output Speed (TPS)' : '输出速度（TPS）');
    setTxt('#val-tps', tpsText);

    // 5. 更新 Popover 2 (Token 用量)
    setTxt('#pop-tokens-title', isEn ? 'Token Usage' : 'Token 用量');
    setTxt('#pop-tokens-badge', t.totalTokensFormatted || '0 tok');
    setTxt('#lbl-cache-hit', isEn ? 'Cache Hit' : '缓存命中');
    setTxt('#val-cache-hit', t.cacheHitRateFormatted || '0%');
    setTxt('#lbl-uncached-in', isEn ? 'Uncached Input' : '未缓存输入');
    setTxt('#val-uncached-in', t.uncachedInputFormatted || '0 tok');
    setTxt('#lbl-cached-read', isEn ? 'Cached Read' : '缓存读取');
    setTxt('#val-cached-read', t.cachedReadFormatted || '0 tok');
    setTxt('#lbl-output-tok', isEn ? 'Output' : '输出');
    setTxt('#val-output-tok', t.outputFormatted || '0 tok');

    // 6. 更新 Popover 3 (上下文窗口)
    setTxt('#pop-ctx-prefix', isEn ? 'Context Used ' : '上下文已用 ');
    setTxt('#pop-ctx-pct', c.usedRatioFormatted || '0%');
    setTxt(
      '#pop-ctx-capacity',
      `${c.usedTokensCompact || '0'} / ${c.capacityTokensCompact || '1M'}`
    );

    const trackEl = q('#pop-ctx-track');
    if (trackEl) {
      trackEl.setAttribute('aria-valuenow', String(Math.round(ratioClamped * 100)));
    }
    const segSysEl = q('#seg-sys');
    const segToolEl = q('#seg-tool');
    const segMsgEl = q('#seg-msg');
    const wSys = Math.max(0, Number(b.systemRatio) || 0);
    const wTool = Math.max(0, Number(b.toolRatio) || 0);
    const wMsg = Math.max(0, Number(b.messageRatio) || 0);
    if (segSysEl) segSysEl.style.width = `${wSys.toFixed(3)}%`;
    if (segToolEl) segToolEl.style.width = `${wTool.toFixed(3)}%`;
    if (segMsgEl) segMsgEl.style.width = `${wMsg.toFixed(3)}%`;

    setTxt('#lbl-seg-sys', isEn ? 'System Prompt' : '系统提示词');
    setTxt('#val-seg-sys', b.systemTokensCompact || '0');
    setTxt('#lbl-seg-tool', isEn ? 'Tool Definitions' : '工具定义');
    setTxt('#val-seg-tool', b.toolTokensCompact || '0');
    setTxt('#lbl-seg-msg', isEn ? 'Messages' : '对话消息');
    setTxt('#val-seg-msg', b.messageTokensCompact || '0');

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
      });
      win.addEventListener('keydown', (e) => this.handleGlobalKeyDown(e), { signal });
    }

    if (this.shadow && typeof this.shadow.querySelectorAll === 'function') {
      const capsules = this.shadow.querySelectorAll('.capsule');
      capsules.forEach((capsule) => {
        if (typeof capsule.addEventListener !== 'function') return;
        // 核心焦点保护：阻止 mousedown 默认焦点抢占，输入框光标 100% 不丢失
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
    }, 100);
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
    }, 140);
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
        if (pop.classList) pop.classList.add('is-visible');
      } else {
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

    const standardWidth = POPOVER_WIDTHS[id] || 280;
    const calcFn =
      typeof computeUpwardPopoverPosition === 'function'
        ? computeUpwardPopoverPosition
        : globalThis.__GRAVITYBOX_HUD_POPOVER__?.computeUpwardPopoverPosition;
    const applyFn =
      typeof applyPopoverGeometry === 'function'
        ? applyPopoverGeometry
        : globalThis.__GRAVITYBOX_HUD_POPOVER__?.applyPopoverGeometry;

    if (typeof calcFn === 'function') {
      const pos = calcFn(capsule, standardWidth, 190, 12, 8, 12);
      if (typeof applyFn === 'function') {
        applyFn(popover, arrow, pos);
      }
    }
  }

  hideAllPopovers() {
    this.activePopoverId = null;
    if (!this.shadow || typeof this.shadow.querySelectorAll !== 'function') return;
    const capsules = this.shadow.querySelectorAll('.capsule');
    capsules.forEach((cap) => {
      cap.setAttribute('aria-expanded', 'false');
      if (cap.classList) cap.classList.remove('is-active');
    });
    const popovers = this.shadow.querySelectorAll('.hud-popover');
    popovers.forEach((pop) => {
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
