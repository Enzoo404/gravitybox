import { HudInstance } from './hud-instance.js';
import { computeUpwardPopoverPosition, applyPopoverGeometry } from './hud-popover.js';
import { HUD_STYLES_CSS } from './hud-styles.js';

/**
 * 分栏多会话 HUD 顶层生命周期管理器 (AntigravityHudManager v2.1)
 * 支持双分栏多实例挂载、精确会话 UUID 解析、DOM 模型/流式/子智能体探针、路由安全守卫与无损销毁
 */

const RESTRICTED_HUD_ROUTE = /^\/(?:onboarding|oauth|auth|login|sign-in)(?:\/|$)/i;

export class AntigravityHudManager {
  constructor(options = {}) {
    this.instances = new Map();
    this.mutationObserver = null;
    this.domReadyAbort = null;
    this.reconcileTimer = null;
    this.routeTimer = null;
    this.active = false;
    this.enabled = options.enabled !== false;
    this.routeExcluded = false;
    this.languageMode = options.languageMode === 'en' ? 'en' : 'zh';
    this.onBridgeEvent = typeof options.onBridgeEvent === 'function' ? options.onBridgeEvent : null;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.checkRoute();

    const attachDomObservers = () => {
      if (!this.active || this.mutationObserver) return;
      if (typeof document === 'undefined' || !document.body) return;
      if (this.enabled && !this.routeExcluded) {
        this.reconcileMounts();
      }
      if (typeof MutationObserver !== 'function') return;
      this.mutationObserver = new MutationObserver(() => {
        if (!this.active || !this.enabled) return;
        if (this.reconcileTimer !== null) return;
        this.reconcileTimer = setTimeout(() => {
          this.reconcileTimer = null;
          this.checkRoute();
          if (this.enabled && !this.routeExcluded) {
            this.reconcileMounts();
          }
        }, 60);
      });
      this.mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'data-cascade-id',
          'data-conversation-id',
          'data-state',
          'data-streaming',
          'data-testid',
          'data-theme',
          'aria-label',
          'class',
        ],
      });
      if (document.documentElement && typeof document.documentElement.nodeType === 'number') {
        try {
          this.mutationObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'data-theme', 'style'],
          });
        } catch {}
      }
    };

    if (typeof document !== 'undefined' && document.body) {
      attachDomObservers();
    } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.domReadyAbort = new AbortController();
      window.addEventListener(
        'DOMContentLoaded',
        () => {
          this.domReadyAbort = null;
          attachDomObservers();
        },
        { once: true, signal: this.domReadyAbort.signal }
      );
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.routeTimer = setInterval(() => {
        if (this.active) {
          if (!this.mutationObserver && typeof document !== 'undefined' && document.body) {
            attachDomObservers();
          }
          this.checkRoute();
          if (this.enabled && !this.routeExcluded) this.reconcileMounts();
        }
      }, 650);
      if (typeof this.routeTimer?.unref === 'function') {
        this.routeTimer.unref();
      }
    }
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.enabled === next) return;
    this.enabled = next;
    if (!this.enabled) {
      if (this.reconcileTimer !== null) {
        clearTimeout(this.reconcileTimer);
        this.reconcileTimer = null;
      }
      for (const instance of this.instances.values()) {
        instance.dispose();
      }
      this.instances.clear();
    } else if (this.active && !this.routeExcluded) {
      this.reconcileMounts();
    }
  }

  syncAllSessions() {
    if (!this.active || !this.enabled || this.routeExcluded) return;
    this.reconcileMounts();
    for (const instance of this.instances.values()) {
      instance.requestRefresh?.();
    }
  }

  checkRoute() {
    if (typeof location === 'undefined') return;
    const restricted = RESTRICTED_HUD_ROUTE.test(location.pathname || '');
    this.setRouteExcluded(restricted);
  }

  setRouteExcluded(excluded) {
    const next = Boolean(excluded);
    if (this.routeExcluded === next) return;
    this.routeExcluded = next;
    if (this.routeExcluded) {
      for (const instance of this.instances.values()) {
        instance.dispose();
      }
      this.instances.clear();
    } else if (this.active && this.enabled) {
      this.reconcileMounts();
    }
  }

  setLanguage(mode) {
    const next = mode === 'en' ? 'en' : 'zh';
    this.languageMode = next;
    for (const instance of this.instances.values()) {
      instance.setLanguage(next);
    }
  }

  /**
   * 扫描并协调所有活跃会话分栏 (支持传入模拟 views 列表或自动从 document 查询)
   */
  reconcileMounts(explicitViews = null) {
    if (this.routeExcluded || !this.enabled) return;
    const InstanceCtor =
      typeof HudInstance === 'function'
        ? HudInstance
        : globalThis.__GRAVITYBOX_HUD_INSTANCE__?.HudInstance;
    if (!InstanceCtor) return;

    let views = explicitViews;
    if (!views && typeof document !== 'undefined') {
      const found = [...document.querySelectorAll('[data-testid="conversation-view"]')];
      const subConvs = [...document.querySelectorAll('[data-testid="subagent-tab-conversation"][data-cascade-id]')];
      for (const subConv of subConvs) {
        const subpane = subConv.closest?.('[data-media-drop-scope="subpane"]') || subConv.parentElement;
        if (!subpane || found.includes(subpane)) continue;
        if (this.isSubpaneVisible(subpane)) {
          found.push(subpane);
        }
      }
      if (found.length > 0) {
        views = found;
      } else {
        const standaloneBoxes = [...document.querySelectorAll('[data-testid="agent-input-box"]')];
        if (standaloneBoxes.length > 0) {
          views = standaloneBoxes.map((box) => box.parentElement || box);
        }
      }
    }
    if (!views || !views.length) {
      for (const [id, instance] of this.instances.entries()) {
        instance.dispose();
        this.instances.delete(id);
      }
      return;
    }

    const activeCascadeIds = new Set();
    const domSubagentIds = this.collectDomSubagentIds();

    views.forEach((view, index) => {
      if (!view) return;
      const subConvNode =
        view.getAttribute?.('data-media-drop-scope') === 'subpane'
          ? view.querySelector?.('[data-testid="subagent-tab-conversation"][data-cascade-id]')
          : null;
      const rawCascadeId =
        view.getAttribute?.('data-cascade-id') || subConvNode?.getAttribute?.('data-cascade-id');
      const cascadeId =
        rawCascadeId && rawCascadeId !== 'conversation'
          ? rawCascadeId
          : `pane-${index}`;
      activeCascadeIds.add(cascadeId);

      const composer = this.resolveComposerElement(view);
      if (!composer) return;

      const isSubpane = Boolean(subConvNode || view.getAttribute?.('data-media-drop-scope') === 'subpane');
      const convId = this.resolveConversationId(view, rawCascadeId, views.length);
      const modelId = this.resolveActiveModel(view);
      const subagentState = this.resolveSubagentState(view);
      const activityPhase = this.resolveActivityPhase(view, subagentState);
      const isStreaming = activityPhase !== 'idle';
      const paneChildIds = isSubpane ? [] : domSubagentIds;

      let instance = this.instances.get(cascadeId);
      if (!instance) {
        instance = new InstanceCtor(cascadeId, {
          isPrimaryPane: index === 0 && !isSubpane,
          languageMode: this.languageMode,
          onBridgeEvent: this.onBridgeEvent,
        });
        this.instances.set(cascadeId, instance);
        instance.mount(composer);
        if (convId) {
          instance.switchConversation(
            convId,
            modelId,
            isStreaming,
            subagentState.isSubagentRunning,
            subagentState.runningSubagentCount,
            paneChildIds,
            activityPhase
          );
        }
      } else {
        instance.reconcile(composer);
        if (convId && instance.getCurrentConvId() !== convId) {
          instance.switchConversation(
            convId,
            modelId,
            isStreaming,
            subagentState.isSubagentRunning,
            subagentState.runningSubagentCount,
            paneChildIds,
            activityPhase
          );
        } else {
          instance.notifyModelOrStreamingChange(
            modelId,
            isStreaming,
            subagentState.isSubagentRunning,
            subagentState.runningSubagentCount,
            paneChildIds,
            activityPhase
          );
        }
      }
    });

    // 自动回收已关闭的分栏实例
    for (const [id, instance] of this.instances.entries()) {
      if (!activeCascadeIds.has(id)) {
        instance.dispose();
        this.instances.delete(id);
      }
    }
  }

  isSubpaneVisible(subpane) {
    if (!subpane || typeof subpane.getBoundingClientRect !== 'function') return false;
    const win = typeof window !== 'undefined' ? window : globalThis.window;
    const vw = Number(win?.innerWidth) || 0;
    if (win && typeof win.getComputedStyle === 'function') {
      try {
        const cs = win.getComputedStyle(subpane);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
          return false;
        }
      } catch {}
    }
    const rect = subpane.getBoundingClientRect();
    if (!rect || rect.width < 120 || rect.height < 120) return false;
    if (vw > 0 && (rect.left >= vw - 8 || rect.right <= 8)) return false;
    return true;
  }

  collectDomSubagentIds() {
    const ids = new Set();
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const loc =
      typeof window !== 'undefined' && window.location
        ? window.location
        : globalThis.window?.location;
    if (loc && typeof loc.search === 'string' && loc.search.includes('subagent_convo__')) {
      const matches = loc.search.matchAll(/subagent_convo__([0-9a-f-]{36})/gi);
      for (const m of matches) {
        if (m[1] && uuidRe.test(m[1])) ids.add(m[1].toLowerCase());
      }
    }
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
      const nodes = document.querySelectorAll(
        '[data-testid="subagent-tab-conversation"][data-cascade-id], [id^="subagentView-"]'
      );
      if (nodes && typeof nodes.forEach === 'function') {
        nodes.forEach((n) => {
          const cid = n.getAttribute?.('data-cascade-id') || '';
          if (uuidRe.test(cid)) ids.add(cid.toLowerCase());
          const rawId = n.getAttribute?.('id') || '';
          if (rawId.startsWith('subagentView-')) {
            const sub = rawId.slice('subagentView-'.length);
            if (uuidRe.test(sub)) ids.add(sub.toLowerCase());
          }
        });
      }
    }
    return [...ids];
  }

  resolveComposerElement(view) {
    if (!view || typeof view.querySelector !== 'function') return null;
    return (
      view.querySelector('[data-testid="agent-input-box"] > .surface-composer') ||
      view.querySelector('[data-testid="agent-input-box"] .surface-composer') ||
      view.querySelector('.surface-composer') ||
      view.querySelector('[data-testid="agent-input-box"]') ||
      (view.matches?.('[data-testid="agent-input-box"]') ? view : null)
    );
  }

  /**
   * 精确解析每个分栏对应的会话 UUID：
   * 1. data-conversation-id 属性
   * 2. 分栏自身携带的非默认 data-cascade-id（修复双分栏下被 window.location 覆盖的缺陷）
   * 3. 分栏内部 /c/<uuid> 锚点
   * 4. 单栏模式下回退至 window.location.pathname 中的 /c/<uuid>
   */
  resolveConversationId(view, rawCascadeId, totalViews = 1) {
    if (view && typeof view.getAttribute === 'function') {
      const directId = view.getAttribute('data-conversation-id');
      if (directId && directId !== 'conversation') return directId;
    }
    if (
      rawCascadeId &&
      rawCascadeId !== 'conversation' &&
      rawCascadeId !== 'default' &&
      !rawCascadeId.startsWith('fallback-pane-') &&
      !rawCascadeId.startsWith('pane-')
    ) {
      const loc =
        typeof window !== 'undefined' && window.location
          ? window.location
          : globalThis.window?.location;
      const urlMatch =
        totalViews === 1 && loc && typeof loc.pathname === 'string'
          ? loc.pathname.match(/\/c\/([a-zA-Z0-9_-]+)/)
          : null;
      if (urlMatch && urlMatch[1] && urlMatch[1] !== '_new' && !/^[0-9a-f-]{36}$/i.test(rawCascadeId)) {
        return urlMatch[1];
      }
      return rawCascadeId;
    }
    if (view && typeof view.querySelector === 'function') {
      const anchor = view.querySelector('a[href*="/c/"]');
      if (anchor) {
        const href = anchor.getAttribute?.('href') || anchor.href || '';
        const match = String(href).match(/\/c\/([a-zA-Z0-9_-]+)/);
        if (match && match[1] && match[1] !== '_new') return match[1];
      }
    }
    const loc =
      typeof window !== 'undefined' && window.location
        ? window.location
        : globalThis.window?.location;
    if (loc && typeof loc.pathname === 'string') {
      const urlMatch = loc.pathname.match(/\/c\/([a-zA-Z0-9_-]+)/);
      if (urlMatch && urlMatch[1] && urlMatch[1] !== '_new') return urlMatch[1];
    }
    return 'default';
  }

  resolveActiveModel(view) {
    if (!view || typeof view.querySelector !== 'function') return 'gemini-3.8-flash';
    const trigger =
      view.querySelector('[data-testid="model-selector-trigger"]') ||
      view.querySelector('.model-selector') ||
      (typeof document !== 'undefined'
        ? document.querySelector('[data-testid="model-selector-trigger"], .model-selector')
        : null);

    if (trigger) {
      const dataModel =
        trigger.getAttribute?.('data-model-id') || trigger.getAttribute?.('data-value');
      if (dataModel && dataModel.trim()) return dataModel.trim();

      const aria = trigger.getAttribute?.('aria-label') || trigger.getAttribute?.('title') || '';
      const ariaMatch = aria.match(/(?:current:|当前：)\s*(.+)$/i);
      if (ariaMatch && ariaMatch[1]) return ariaMatch[1].trim();

      const text = (trigger.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && !/^(Model|模型|Select model|选择模型)$/i.test(text)) {
        return text;
      }
    }

    // 兼容无 data-testid="model-selector-trigger" 时的工具栏模型按钮探测
    if (typeof view.querySelectorAll === 'function') {
      const buttons = view.querySelectorAll('.surface-composer button, [data-testid="agent-input-box"] button');
      if (buttons && typeof buttons.forEach === 'function') {
        let matchedModel = null;
        buttons.forEach((btn) => {
          if (matchedModel) return;
          const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          if (/\b(?:Gemini|Claude|GPT|o1|o3|o4)\b/i.test(t)) {
            matchedModel = t;
          }
        });
        if (matchedModel) return matchedModel;
      }
    }

    return 'gemini-3.8-flash';
  }

  /**
   * 检测当前分栏是否存在后台正在工作的子智能体 (Issue 2 核心修复)：
   * 对应 Antigravity 2.30.0 `Gjc` / `Fjc` / `zdc` / `Zcc` 组件：
   * 1. `[data-testid="idle-status-text"]` 文本（如 `"1 subagent running"`, `"2 subagents running"`, `"Working"`, `"1 个子智能体正在运行"`）
   * 2. `[data-testid="running-subagent-steps-toggle"]`, `[data-testid="running-subagent-browser-steps"]`, `[data-testid="browser-subagent-thinking"]`
   * 3. `[aria-label^="Open Subagent:"]` / `[data-testid="browser-subagent-row"]` 中不含 `agent-status-done` / `agent-status-killed` / `agent-status-canceled` 的活跃卡片
   */
  resolveSubagentState(view) {
    const fallback = { isSubagentRunning: false, runningSubagentCount: 0 };
    if (!view || typeof view.querySelectorAll !== 'function') return fallback;

    let runningCount = 0;
    let detected = false;

    const idleStatusNodes = view.querySelectorAll('[data-testid="idle-status-text"]');
    if (idleStatusNodes && typeof idleStatusNodes.forEach === 'function') {
      idleStatusNodes.forEach((node) => {
        const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt) return;
        const countMatch = txt.match(/(\d+)\s*(?:个)?\s*(?:subagents?(?:\/tasks?)?|tasks?|子智能体|子代理|后台任务)/i);
        if (
          countMatch &&
          /(?:running|working|运行中|正在运行|执行中|处理中)/i.test(txt)
        ) {
          detected = true;
          const parsed = parseInt(countMatch[1], 10);
          if (parsed > runningCount) runningCount = parsed;
        } else if (
          /\b(?:subagents?(?:\/tasks?)?\s+running|working)\b|(?:子智能体|子代理).*(?:运行|工作|执行)/i.test(
            txt
          )
        ) {
          detected = true;
          if (runningCount < 1) runningCount = 1;
        }
      });
    }

    const activeSubagentMarkers = view.querySelectorAll(
      '[data-testid="running-subagent-steps-toggle"], [data-testid="running-subagent-browser-steps"], [data-testid="browser-subagent-thinking"]'
    );
    if (activeSubagentMarkers && activeSubagentMarkers.length > 0) {
      detected = true;
      if (runningCount < activeSubagentMarkers.length) {
        runningCount = Math.max(1, runningCount);
      }
    }

    // 检查 Started :: <Role> 子智能体引用芯片是否仍处于加载态（未出现 done / killed / canceled 图标）
    const agentRefs = view.querySelectorAll(
      '[aria-label^="Open Subagent:"], [aria-label^="打开子智能体："], [aria-label^="打开子智能体:"], [aria-label^="打开子代理："], [aria-label^="打开子代理:"]'
    );
    if (agentRefs && typeof agentRefs.forEach === 'function') {
      let activeRefCount = 0;
      agentRefs.forEach((ref) => {
        if (typeof ref.querySelector !== 'function') return;
        const finishedIcon = ref.querySelector(
          '[data-testid="agent-status-done"], [data-testid="agent-status-killed"], [data-testid="agent-status-canceled"], [data-testid="agent-status-error"], [data-testid="agent-status-failed"]'
        );
        if (!finishedIcon) {
          activeRefCount++;
        }
      });
      if (activeRefCount > 0) {
        detected = true;
        if (activeRefCount > runningCount) runningCount = activeRefCount;
      }
    }

    const buttons = view.querySelectorAll('button, [role="button"]');
    if (buttons && typeof buttons.forEach === 'function') {
      buttons.forEach((btn) => {
        const label = (
          btn.getAttribute?.('aria-label') ||
          btn.getAttribute?.('title') ||
          btn.textContent ||
          ''
        ).trim();
        if (/^(?:Stop All Subagents|Stop subagent|停止所有子智能体|停止子智能体)$/i.test(label)) {
          detected = true;
          if (runningCount < 1) runningCount = 1;
        }
      });
    }

    return {
      isSubagentRunning: detected,
      runningSubagentCount: detected ? Math.max(1, runningCount) : 0,
    };
  }

  resolveActivityPhase(view, precomputedSubagentState = null) {
    if (!view || typeof view.querySelectorAll !== 'function') return 'idle';
    const subState = precomputedSubagentState || this.resolveSubagentState(view);

    const foregroundTurnNodes = view.querySelectorAll(
      '[data-testid="input-cancel-button"], [data-testid="send-button-loading"], [data-testid="send-button-pending"], [data-testid="agent-loading"], [data-state="streaming"], [data-streaming="true"], .codicon-loading'
    );
    let hasForegroundTurn = Boolean(foregroundTurnNodes && foregroundTurnNodes.length > 0);

    if (!hasForegroundTurn) {
      const buttons = view.querySelectorAll('button, [role="button"]');
      if (buttons && typeof buttons.forEach === 'function') {
        buttons.forEach((btn) => {
          const label = (
            btn.getAttribute?.('aria-label') ||
            btn.getAttribute?.('title') ||
            btn.textContent ||
            ''
          ).trim();
          if (
            /^(?:Stop generating|Stop|Cancel generation|Cancel\s*[（(][^）)]+[）)]|停止生成|停止|中断|取消\s*[（(][^）)]+[）)])$/i.test(
              label
            )
          ) {
            hasForegroundTurn = true;
          }
        });
      }
    }

    const toolStatusNodes = view.querySelectorAll('[data-testid="ephemeral-tool-status"]');
    let hasApprovalWait = false;
    let hasEphemeralToolRunning = false;
    let hasEphemeralThinking = false;
    if (toolStatusNodes && typeof toolStatusNodes.forEach === 'function') {
      toolStatusNodes.forEach((node) => {
        const statusText = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!statusText) return;
        if (/(?:Waiting for your approval|等待您的批准)/i.test(statusText)) {
          hasApprovalWait = true;
        } else if (/^(?:Thinking\b|Thought\b|Compacting\b|思考|正在思考|思维|压缩)/i.test(statusText)) {
          hasEphemeralThinking = true;
        } else {
          hasEphemeralToolRunning = true;
        }
      });
    }

    const taskRunningNodes = view.querySelectorAll(
      '[data-testid="status-task-running"], [data-testid="status-loading-spinner"]'
    );
    const hasTaskSpinner = Boolean(taskRunningNodes && taskRunningNodes.length > 0);

    let hasToolCardShimmer = false;
    let hasModelThinkingShimmer = false;
    const shimmerNodes = view.querySelectorAll('.animate-shimmer-text');
    if (shimmerNodes && typeof shimmerNodes.forEach === 'function') {
      shimmerNodes.forEach((node) => {
        const parentTestId = node.closest?.('[data-testid]')?.getAttribute?.('data-testid') || '';
        if (parentTestId === 'idle-status-text') return;
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (
          parentTestId === 'agent-loading' ||
          /^(?:Thinking\b|Thought\b|Compacting\b|思考|正在思考|思维|压缩)/i.test(text)
        ) {
          hasModelThinkingShimmer = true;
        } else if (text) {
          hasToolCardShimmer = true;
        }
      });
    }

    if (!hasForegroundTurn) {
      if (hasApprovalWait) return 'idle';
      if (subState.isSubagentRunning || hasTaskSpinner || hasEphemeralToolRunning || hasToolCardShimmer) {
        return 'executing';
      }
      if (hasEphemeralThinking || hasModelThinkingShimmer) {
        return 'generating';
      }
      return 'idle';
    }

    if (
      hasApprovalWait &&
      !hasModelThinkingShimmer &&
      !hasEphemeralThinking &&
      !hasToolCardShimmer &&
      !hasEphemeralToolRunning
    ) {
      return 'idle';
    }

    if (hasModelThinkingShimmer || hasEphemeralThinking) {
      return 'generating';
    }

    if (hasEphemeralToolRunning || hasToolCardShimmer || hasTaskSpinner) {
      return 'executing';
    }

    return 'generating';
  }

  resolveStreamingState(view, precomputedSubagentState = null) {
    return this.resolveActivityPhase(view, precomputedSubagentState) !== 'idle';
  }

  dispatchMetrics(metrics) {
    if (!metrics || typeof metrics !== 'object') return false;
    let handled = false;
    for (const instance of this.instances.values()) {
      if (instance.getCurrentConvId() === metrics.conversationId) {
        if (instance.updateMetrics(metrics)) {
          handled = true;
        }
      }
    }
    return handled;
  }

  state() {
    return {
      active: this.active,
      enabled: this.enabled,
      instanceCount: this.instances.size,
      routeExcluded: this.routeExcluded,
      languageMode: this.languageMode,
    };
  }

  dispose() {
    this.active = false;
    if (this.domReadyAbort) {
      this.domReadyAbort.abort();
      this.domReadyAbort = null;
    }
    if (this.reconcileTimer !== null) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.routeTimer !== null) {
      clearInterval(this.routeTimer);
      this.routeTimer = null;
    }
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }
    for (const instance of this.instances.values()) {
      instance.dispose();
    }
    this.instances.clear();
  }
}

// 在浏览器/CDP 隔离世界中自动挂载并暴露全局控制句柄
(function attachGlobalHudController() {
  globalThis.__GRAVITYBOX_ATTACH_HUD__ = attachGlobalHudController;
  if (typeof document === 'undefined') return;
  const boot = globalThis.__AGZH_BOOT__;
  if (boot !== undefined && !globalThis.__AGZH_ENGINE_V1__) return;
  const initialEnabled = boot?.hudEnabled !== false;
  if (globalThis.__GRAVITYBOX_HUD_V1__?.active) {
    globalThis.__GRAVITYBOX_HUD_V1__.setEnabled?.(initialEnabled);
    globalThis.__GRAVITYBOX_HUD_V1__.reconcileMounts();
    return;
  }
  if (!document.body && boot === undefined) return;
  const initialLang = globalThis.__AGZH_ENGINE_V1__?.getLanguageMode?.() || 'zh';
  const manager = new AntigravityHudManager({
    languageMode: initialLang,
    enabled: initialEnabled,
  });
  manager.start();

  const hudApi = {
    get active() {
      return manager.active;
    },
    get enabled() {
      return manager.enabled;
    },
    manager,
    reconcileMounts: (views) => manager.reconcileMounts(views),
    syncAllSessions: () => manager.syncAllSessions(),
    dispatchMetrics: (metrics) => manager.dispatchMetrics(metrics),
    setLanguage: (mode) => manager.setLanguage(mode),
    setEnabled: (enabled) => manager.setEnabled(enabled),
    setRouteExcluded: (excluded) => manager.setRouteExcluded(excluded),
    computeUpwardPopoverPosition:
      typeof computeUpwardPopoverPosition === 'function'
        ? computeUpwardPopoverPosition
        : globalThis.__GRAVITYBOX_HUD_POPOVER__?.computeUpwardPopoverPosition,
    dispose: () => {
      manager.dispose();
      delete globalThis.__gravityboxUpdateHudMetrics;
      delete globalThis.__GRAVITYBOX_HUD_V1__;
    },
  };

  globalThis.__GRAVITYBOX_HUD_V1__ = hudApi;
  globalThis.__gravityboxUpdateHudMetrics = (metrics) => manager.dispatchMetrics(metrics);
})();
