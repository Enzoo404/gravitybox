import { HudInstance } from './hud-instance.js';
import { computeUpwardPopoverPosition, applyPopoverGeometry } from './hud-popover.js';
import { HUD_STYLES_CSS } from './hud-styles.js';

/**
 * 分栏多会话 HUD 顶层生命周期管理器 (AntigravityHudManager)
 * 支持双分栏多实例挂载、DOM 模型/流式探针、路由安全守卫与无损销毁
 */

const RESTRICTED_HUD_ROUTE = /^\/(?:onboarding|oauth|auth|login|sign-in)(?:\/|$)/i;

export class AntigravityHudManager {
  constructor(options = {}) {
    this.instances = new Map();
    this.mutationObserver = null;
    this.reconcileTimer = null;
    this.routeTimer = null;
    this.active = false;
    this.routeExcluded = false;
    this.languageMode = options.languageMode === 'en' ? 'en' : 'zh';
    this.onBridgeEvent = typeof options.onBridgeEvent === 'function' ? options.onBridgeEvent : null;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.checkRoute();
    this.reconcileMounts();

    if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.body) {
      this.mutationObserver = new MutationObserver(() => {
        if (!this.active) return;
        if (this.reconcileTimer !== null) return;
        this.reconcileTimer = setTimeout(() => {
          this.reconcileTimer = null;
          this.checkRoute();
          if (!this.routeExcluded) {
            this.reconcileMounts();
          }
        }, 60);
      });
      this.mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-cascade-id', 'data-conversation-id', 'data-state', 'data-streaming', 'class'],
      });
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.routeTimer = setInterval(() => {
        if (this.active) {
          this.checkRoute();
          if (!this.routeExcluded) this.reconcileMounts();
        }
      }, 800);
      if (typeof this.routeTimer?.unref === 'function') {
        this.routeTimer.unref();
      }
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
    } else if (this.active) {
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
    if (this.routeExcluded) return;
    const InstanceCtor =
      typeof HudInstance === 'function'
        ? HudInstance
        : globalThis.__GRAVITYBOX_HUD_INSTANCE__?.HudInstance;
    if (!InstanceCtor) return;

    let views = explicitViews;
    if (!views && typeof document !== 'undefined') {
      const found = [...document.querySelectorAll('[data-testid="conversation-view"]')];
      if (found.length > 0) {
        views = found;
      } else {
        // 兼容未包裹 conversation-view 但直接存在 agent-input-box 的视图结构
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

    views.forEach((view, index) => {
      if (!view) return;
      const cascadeId = view.getAttribute?.('data-cascade-id') || `fallback-pane-${index}`;
      activeCascadeIds.add(cascadeId);

      const composer = this.resolveComposerElement(view);
      if (!composer) return;

      const convId = this.resolveConversationId(view, cascadeId);
      const modelId = this.resolveActiveModel(view);
      const isStreaming = this.resolveStreamingState(view);

      let instance = this.instances.get(cascadeId);
      if (!instance) {
        instance = new InstanceCtor(cascadeId, {
          isPrimaryPane: index === 0 && views.length === 1,
          languageMode: this.languageMode,
          onBridgeEvent: this.onBridgeEvent,
        });
        this.instances.set(cascadeId, instance);
        instance.mount(composer);
        if (convId) {
          instance.switchConversation(convId, modelId, isStreaming);
        }
      } else {
        instance.reconcile(composer);
        if (convId && instance.getCurrentConvId() !== convId) {
          instance.switchConversation(convId, modelId, isStreaming);
        } else {
          instance.notifyModelOrStreamingChange(modelId, isStreaming);
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

  resolveConversationId(view, cascadeId) {
    if (view && typeof view.getAttribute === 'function') {
      const directId = view.getAttribute('data-conversation-id');
      if (directId) return directId;
    }
    if (view && typeof view.querySelector === 'function') {
      const anchor = view.querySelector('a[href*="/c/"]');
      if (anchor) {
        const href = anchor.getAttribute?.('href') || anchor.href || '';
        const match = String(href).match(/\/c\/([a-zA-Z0-9_-]+)/);
        if (match && match[1]) return match[1];
      }
    }
    const loc =
      typeof window !== 'undefined' && window.location
        ? window.location
        : globalThis.window?.location;
    if (loc && typeof loc.pathname === 'string') {
      const urlMatch = loc.pathname.match(/\/c\/([a-zA-Z0-9_-]+)/);
      if (urlMatch && urlMatch[1]) return urlMatch[1];
    }
    if (cascadeId && cascadeId !== 'fallback-pane-0') {
      return cascadeId;
    }
    return 'default';
  }

  resolveActiveModel(view) {
    if (!view || typeof view.querySelector !== 'function') return 'gemini-4-argon';
    const trigger =
      view.querySelector('[data-testid="model-selector-trigger"]') ||
      view.querySelector('.model-selector') ||
      (typeof document !== 'undefined'
        ? document.querySelector('[data-testid="model-selector-trigger"], .model-selector')
        : null);
    if (!trigger) return 'gemini-4-argon';

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
    return 'gemini-4-argon';
  }

  resolveStreamingState(view) {
    if (!view || typeof view.querySelectorAll !== 'function') return false;
    const streamingNodes = view.querySelectorAll(
      '[data-state="streaming"], [data-streaming="true"], .codicon-loading'
    );
    if (streamingNodes && streamingNodes.length > 0) return true;

    const buttons = view.querySelectorAll('button, [role="button"]');
    if (buttons && typeof buttons.forEach === 'function') {
      let foundStop = false;
      buttons.forEach((btn) => {
        const label = (
          btn.getAttribute?.('aria-label') ||
          btn.getAttribute?.('title') ||
          btn.textContent ||
          ''
        ).trim();
        if (/^(Stop generating|Stop|Cancel generation|停止生成|停止|中断)$/i.test(label)) {
          foundStop = true;
        }
      });
      if (foundStop) return true;
    }
    return false;
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
      instanceCount: this.instances.size,
      routeExcluded: this.routeExcluded,
      languageMode: this.languageMode,
    };
  }

  dispose() {
    this.active = false;
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
  if (typeof document === 'undefined' || !document.body) return;
  if (globalThis.__GRAVITYBOX_HUD_V1__?.active) {
    globalThis.__GRAVITYBOX_HUD_V1__.reconcileMounts();
    return;
  }
  const initialLang = globalThis.__AGZH_ENGINE_V1__?.getLanguageMode?.() || 'zh';
  const manager = new AntigravityHudManager({ languageMode: initialLang });
  manager.start();

  const hudApi = {
    get active() {
      return manager.active;
    },
    manager,
    reconcileMounts: (views) => manager.reconcileMounts(views),
    dispatchMetrics: (metrics) => manager.dispatchMetrics(metrics),
    setLanguage: (mode) => manager.setLanguage(mode),
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
