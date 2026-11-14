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
    this.viewToSlotId = typeof WeakMap === 'function' ? new WeakMap() : null;
    this.nextSlotSeq = 1;
    this.nextRevisionCounter = Number(globalThis.__GRAVITYBOX_HUD_REVISION__) || 0;
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

  allocateSessionRevision() {
    this.nextRevisionCounter = Math.max(this.nextRevisionCounter, Number(globalThis.__GRAVITYBOX_HUD_REVISION__) || 0) + 1;
    globalThis.__GRAVITYBOX_HUD_REVISION__ = this.nextRevisionCounter;
    return this.nextRevisionCounter;
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
        }, 20);
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
          'data-subagent-id',
          'data-agent-state',
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
          if (typeof document !== 'undefined' && document.hidden === true) return;
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

    const panes = views.filter(Boolean).map((view, index) => {
      const subConvNode = view.getAttribute?.('data-media-drop-scope') === 'subpane'
        ? view.querySelector?.('[data-testid="subagent-tab-conversation"][data-cascade-id]') : null;
      const rawCascadeId = view.getAttribute?.('data-cascade-id') || subConvNode?.getAttribute?.('data-cascade-id');
      let slotId = this.viewToSlotId.get(view);
      if (!slotId) { slotId = `slot-${this.nextSlotSeq++}`; this.viewToSlotId.set(view, slotId); }
      return { view, index, subConvNode, rawCascadeId, slotId, composer: this.resolveComposerElement(view) };
    }).filter(p => p.composer);
    const activeSlots = new Set(panes.map(p => p.slotId));
    for (const [slot, instance] of this.instances) {
      if (!activeSlots.has(slot)) { instance.dispose(); this.instances.delete(slot); }
    }
    const domSubagentIds = this.collectDomSubagentIds();
    for (const { view, index, subConvNode, rawCascadeId, slotId, composer } of panes) {
      const isSubpane = Boolean(subConvNode || view.getAttribute?.('data-media-drop-scope') === 'subpane');
      const convId = this.resolveConversationId(view, rawCascadeId, views.length);
      const modelId = this.resolveActiveModel(view, views.length);
      const subagentState = this.resolveSubagentState(view, { isSubpane });
      const activityPhase = this.resolveActivityPhase(view, subagentState, { isSubpane });
      const isStreaming = activityPhase !== 'idle';
      let instance = this.instances.get(slotId);
      if (!instance) {
        instance = new InstanceCtor(slotId, { paneSlotId: slotId, isPrimaryPane: index === 0 && !isSubpane,
          isSubpane, languageMode: this.languageMode, onBridgeEvent: this.onBridgeEvent,
          allocateRevision: () => this.allocateSessionRevision() });
        this.instances.set(slotId, instance); instance.mount(composer);
      } else instance.reconcile(composer);
      instance.isSubpane = isSubpane;
      if (!convId) {
        if (instance.currentConvId) { instance.emitBridgeEvent('SESSION_DETACHED'); }
        instance.resetToEmptyState ? instance.resetToEmptyState() : (instance.currentConvId = null, instance.renderSkeleton());
        continue;
      }
      if (instance.getCurrentConvId() !== convId) {
        instance.switchConversation(convId, modelId, isStreaming, subagentState.isSubagentRunning,
          subagentState.runningSubagentCount, isSubpane ? [] : domSubagentIds, activityPhase);
      } else instance.notifyModelOrStreamingChange(modelId, isStreaming, subagentState.isSubagentRunning,
        subagentState.runningSubagentCount, isSubpane ? [] : domSubagentIds, activityPhase);
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
    const allowUrl = totalViews === 1 && view?.getAttribute?.('data-media-drop-scope') !== 'subpane';
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
        allowUrl && loc && typeof loc.pathname === 'string'
          ? loc.pathname.match(/\/c\/([a-zA-Z0-9_-]+)/)
          : null;
      if (urlMatch && urlMatch[1] && urlMatch[1] !== '_new' && !/^[0-9a-f-]{36}$/i.test(rawCascadeId)) {
        return urlMatch[1];
      }
      return rawCascadeId;
    }
    if (view && typeof view.querySelector === 'function') {
      const anchor = view.querySelector('[data-testid="conversation-header"] a[href*="/c/"], a[data-conversation-link][href*="/c/"]');
      if (anchor) {
        const href = anchor.getAttribute?.('href') || anchor.href || '';
        const match = String(href).match(/\/c\/([a-zA-Z0-9_-]+)/);
        if (match && match[1] && match[1] !== '_new') return match[1];
      }
    }
    if (allowUrl) {
      const loc =
        typeof window !== 'undefined' && window.location
          ? window.location
          : globalThis.window?.location;
      if (loc && typeof loc.pathname === 'string') {
        const urlMatch = loc.pathname.match(/\/c\/([a-zA-Z0-9_-]+)/);
        if (urlMatch && urlMatch[1] && urlMatch[1] !== '_new') return urlMatch[1];
      }
    }
    return totalViews > 1 ? null : 'default';
  }

  resolveActiveModel(view, totalViews = 1) {
    if (!view || typeof view.querySelector !== 'function') return '';
    const localTrigger =
      view.querySelector('[data-testid="model-selector-trigger"]') ||
      view.querySelector('.model-selector');

    const extractFromTrigger = (trigger) => {
      if (!trigger) return null;
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
      return null;
    };

    const localModel = extractFromTrigger(localTrigger);
    if (localModel) return localModel;

    // 优先扫描当前分栏内部的工具栏模型按钮，避免双分栏/子分栏被全局 document 覆盖
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

    if (totalViews === 1 && typeof document !== 'undefined') {
      const globalTrigger = document.querySelector(
        '[data-testid="model-selector-trigger"], .model-selector'
      );
      const globalModel = extractFromTrigger(globalTrigger);
      if (globalModel) return globalModel;
    }

    return '';
  }

  /**
   * 检测当前分栏是否存在后台正在工作的子智能体 (Issue 2 核心修复)：
   * 对应 Antigravity 2.30.0 `Gjc` / `Fjc` / `zdc` / `Zcc` 组件：
   * 1. `[data-testid="idle-status-text"]` 文本（如 `"1 subagent running"`, `"2 subagents running"`, `"Working"`, `"1 个子智能体正在运行"`）
   * 2. `[data-testid="running-subagent-steps-toggle"]`, `[data-testid="running-subagent-browser-steps"]`, `[data-testid="browser-subagent-thinking"]`
   * 3. `[aria-label^="Open Subagent:"]` / `[data-testid="browser-subagent-row"]` 中不含 `agent-status-done` / `agent-status-killed` / `agent-status-canceled` 的活跃卡片
   */
  resolveSubagentState(view, options = {}) {
    const fallback = { isSubagentRunning: false, runningSubagentCount: 0 };
    if (!view || typeof view.querySelectorAll !== 'function') return fallback;

    const isSubpane =
      typeof options?.isSubpane === 'boolean'
        ? options.isSubpane
        : Boolean(
            view.getAttribute?.('data-testid') === 'subagent-tab-conversation' ||
              view.getAttribute?.('data-media-drop-scope') === 'subpane'
          );

    let runningCount = 0;
    let detected = false;

    const idleStatusNodes = view.querySelectorAll('[data-testid="idle-status-text"]');
    if (idleStatusNodes && typeof idleStatusNodes.forEach === 'function') {
      idleStatusNodes.forEach((node) => {
        const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt) return;
        const countMatch = txt.match(/(\d+)\s*(?:个)?\s*(?:subagents?(?:\/tasks?)?|子智能体|子代理)/i);
        if (
          countMatch &&
          /(?:running|working|运行中|正在运行|执行中|处理中)/i.test(txt)
        ) {
          detected = true;
          const parsed = parseInt(countMatch[1], 10);
          if (parsed > runningCount) runningCount = parsed;
        } else if (
          /\bsubagents?(?:\/tasks?)?\s+(?:running|working)\b|(?:子智能体|子代理).*(?:运行|工作|执行)/i.test(
            txt
          )
        ) {
          detected = true;
          if (runningCount < 1) runningCount = 1;
        }
      });
    }

    // 子智能体自身分栏内的 running-subagent / browser-subagent-thinking 与 Stop subagent 属于本栏自身运行态，不作为嵌套子智能体计数
    if (!isSubpane) {
      const activeSubagentMarkers = view.querySelectorAll(
        '[data-testid="running-subagent-steps-toggle"], [data-testid="running-subagent-browser-steps"], [data-testid="browser-subagent-thinking"]'
      );
      if (activeSubagentMarkers && activeSubagentMarkers.length > 0) {
        detected = true;
        const markerContainers = new Set();
        if (typeof activeSubagentMarkers.forEach === 'function') {
          activeSubagentMarkers.forEach((m) => {
            const container =
              m.closest?.('[data-testid="browser-subagent-row"], [id^="subagentView-"], [data-cascade-id]') || m;
            markerContainers.add(container);
          });
        }
        const markerCount = Math.max(1, markerContainers.size);
        if (runningCount < markerCount) {
          runningCount = markerCount;
        }
      }
    }

    // 检查子智能体引用芯片是否仍处于加载态（必须具备明确正向活跃指示器，排除权限来源标签、已完成/未读状态及无指示器的静态卡片）
    const agentRefs = view.querySelectorAll(
      '[aria-label^="Open Subagent:"], [aria-label^="打开子智能体："], [aria-label^="打开子智能体:"], [aria-label^="打开子代理："], [aria-label^="打开子代理:"]'
    );
    if (agentRefs && typeof agentRefs.forEach === 'function') {
      const activeRefOwners = new Set();
      agentRefs.forEach((ref) => {
        if (typeof ref.querySelector !== 'function') return;
        if (
          ref.getAttribute?.('data-testid') === 'subagent-permission-source' ||
          ref.closest?.('[data-testid="subagent-permission-source"]')
        ) {
          return;
        }
        const finishedIcon = ref.querySelector(
          '[data-testid="agent-status-done"], [data-testid="agent-status-killed"], [data-testid="agent-status-canceled"], [data-testid="agent-status-error"], [data-testid="agent-status-failed"], [data-testid="status-unread-dot"]'
        );
        if (finishedIcon) return;
        const hasActiveDotOrSpinner = Boolean(
          ref.querySelector(
            '[data-agent-state-dot], [data-testid="status-loading-spinner"], [data-testid="status-task-running"], .animate-spin, .codicon-loading, .spinner'
          )
        );
        if (hasActiveDotOrSpinner) {
          const owner = ref.closest?.('[data-testid="browser-subagent-row"], [id^="subagentView-"]') || ref;
          const id = owner.getAttribute?.('data-cascade-id') || owner.getAttribute?.('id');
          activeRefOwners.add(id || owner);
        }
      });
      const activeRefCount = activeRefOwners.size;
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
        const isSubagentStopBtn = isSubpane
          ? /^(?:Stop All Subagents|停止所有子智能体)$/i.test(label)
          : /^(?:Stop All Subagents|Stop subagent|停止所有子智能体|停止子智能体)$/i.test(label);
        if (isSubagentStopBtn) {
          detected = true;
          if (runningCount < 1) runningCount = 1;
        }
      });
    }

    // 扫描正在执行中的子智能体调度工具卡片 (要求存在明确子智能体工具语义且具备正向加载指示器，杜绝正文文本误判)
    const activeToolNodes = view.querySelectorAll(
      '[data-testid="tool-call"], [data-testid="tool-invocation"], [data-testid*="subagent-card"], [data-testid="browser-subagent-row"]'
    );
    if (activeToolNodes && typeof activeToolNodes.forEach === 'function') {
      activeToolNodes.forEach((node) => {
        if (isSubpane && node === view) return;
        if (
          node.getAttribute?.('data-testid') === 'subagent-permission-source' ||
          node.closest?.('[data-testid="subagent-permission-source"]')
        ) {
          return;
        }
        const testId = (node.getAttribute?.('data-testid') || '').toLowerCase();
        const headerEl = node.querySelector?.('[data-testid*="tool-name"], [data-testid*="header"], summary, header, button') || node;
        const headerText = (headerEl.textContent || '').replace(/\s+/g, ' ').trim();
        const isSubagentTool =
          testId.includes('subagent') ||
          /\b(?:invoke_subagent|browser_subagent|start_subagent|spawn_subagent)\b/i.test(headerText);
        if (!isSubagentTool) return;
        const finished = node.querySelector?.(
          '[data-testid="agent-status-done"], [data-testid="agent-status-killed"], [data-testid="agent-status-canceled"], [data-testid="agent-status-error"], [data-testid="agent-status-failed"]'
        );
        if (finished) return;
        const hasSpinner = Boolean(
          node.getAttribute?.('data-state') === 'running' ||
          node.querySelector?.(
            '.animate-spin, .codicon-loading, .spinner, [data-testid="status-loading-spinner"], [data-testid="status-task-running"], [data-state="running"]'
          )
        );
        if (hasSpinner) {
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

  resolveActivityPhase(view, precomputedSubagentState = null, options = {}) {
    if (!view || typeof view.querySelectorAll !== 'function') return 'idle';
    const isSubpane =
      typeof options?.isSubpane === 'boolean'
        ? options.isSubpane
        : Boolean(
            view.getAttribute?.('data-testid') === 'subagent-tab-conversation' ||
              view.getAttribute?.('data-media-drop-scope') === 'subpane'
          );
    void precomputedSubagentState;

    // 仅认准当前分栏的前台轮次终止信号（排除 .codicon-loading，避免后台工具或异步任务残留 spinner 伪装前台活跃）
    const foregroundTurnNodes = view.querySelectorAll(
      '[data-testid="input-cancel-button"], [data-testid="send-button-loading"], [data-testid="send-button-pending"], [data-testid="agent-loading"], [data-state="streaming"], [data-streaming="true"]'
    );
    let hasForegroundTurn = Boolean(foregroundTurnNodes && foregroundTurnNodes.length > 0);
    let hasSubpaneThinkingMarker = false;

    if (isSubpane) {
      const subpaneThinking = view.querySelectorAll?.('[data-testid="browser-subagent-thinking"]');
      if (subpaneThinking && subpaneThinking.length > 0) {
        hasForegroundTurn = true;
        hasSubpaneThinkingMarker = true;
      } else {
        const subpaneActiveNodes = view.querySelectorAll(
          '[data-testid="running-subagent-steps-toggle"], [data-testid="running-subagent-browser-steps"]'
        );
        if (subpaneActiveNodes && subpaneActiveNodes.length > 0) {
          hasForegroundTurn = true;
        }
      }
    }

    if (!hasForegroundTurn) {
      const buttons = (this.resolveComposerElement(view) || view).querySelectorAll('button, [role="button"]');
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
            ) ||
            (isSubpane && /^(?:Stop subagent|停止子智能体)$/i.test(label))
          ) {
            hasForegroundTurn = true;
          }
        });
      }
      if (!hasForegroundTurn && isSubpane) {
        const viewButtons = view.querySelectorAll('button, [role="button"]');
        if (viewButtons && typeof viewButtons.forEach === 'function') {
          viewButtons.forEach((btn) => {
            const label = (
              btn.getAttribute?.('aria-label') ||
              btn.getAttribute?.('title') ||
              btn.textContent ||
              ''
            ).trim();
            if (/^(?:Stop subagent|停止子智能体)$/i.test(label)) {
              hasForegroundTurn = true;
            }
          });
        }
      }
    }

    const toolStatusNodes = view.querySelectorAll('[data-testid="ephemeral-tool-status"]');
    let hasApprovalWait = false;
    let hasEphemeralToolRunning = false;
    let hasEphemeralThinking = hasSubpaneThinkingMarker;
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

    // 当前分栏前台模型已停止（无终止/停止按钮）：无论是否存在后台工具或独立子智能体，小圆点一律保持灰色 idle
    if (!hasForegroundTurn) {
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

    // 前台轮次活跃且正在与工具互动（包括同时存在思考文本与工具运行卡片时）：优先显示蓝色呼吸 executing
    if (hasEphemeralToolRunning || hasToolCardShimmer || hasTaskSpinner) {
      return 'executing';
    }

    return 'generating';
  }

  resolveStreamingState(view, precomputedSubagentState = null, options = {}) {
    return this.resolveActivityPhase(view, precomputedSubagentState, options) !== 'idle';
  }

  dispatchMetrics(metrics) {
    if (!metrics || typeof metrics !== 'object') return false;
    let handled = false;
    for (const instance of this.instances.values()) {
      if (metrics.paneSlotId && instance.paneSlotId && instance.paneSlotId !== metrics.paneSlotId) {
        continue;
      }
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
  const boot = globalThis.__GRAVITYBOX_BOOT__;
  if (boot !== undefined && !globalThis.__GRAVITYBOX_ENGINE_V1__) return;
  const initialEnabled = boot?.hudEnabled !== false;
  if (globalThis.__GRAVITYBOX_HUD_V1__?.active) {
    globalThis.__GRAVITYBOX_HUD_V1__.setEnabled?.(initialEnabled);
    globalThis.__GRAVITYBOX_HUD_V1__.reconcileMounts();
    return;
  }
  if (!document.body && boot === undefined) return;
  const initialLang = globalThis.__GRAVITYBOX_ENGINE_V1__?.getLanguageMode?.() || 'zh';
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
      delete globalThis.__GRAVITYBOX_ATTACH_HUD__;
    },
  };

  globalThis.__GRAVITYBOX_HUD_V1__ = hudApi;
  globalThis.__gravityboxUpdateHudMetrics = (metrics) => manager.dispatchMetrics(metrics);
})();
