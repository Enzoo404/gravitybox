import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HudInstance } from '../runtime/hud-instance.js';
import { AntigravityHudManager } from '../runtime/hud-manager.js';

class FakeStyleDeclaration {
  constructor() {
    this.cssText = '';
  }
}

class FakeElement {
  constructor(tagName = 'div', ownerDoc = null) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = ownerDoc;
    this.attributes = new Map();
    this.style = new FakeStyleDeclaration();
    this.children = [];
    this.parentNode = null;
    this.shadowRoot = null;
    this.listeners = new Map();
    this.classList = {
      _set: new Set(),
      add: (...tokens) => tokens.forEach((t) => this.classList._set.add(t)),
      remove: (...tokens) => tokens.forEach((t) => this.classList._set.delete(t)),
      toggle: (token, force) => {
        const shouldAdd = force !== undefined ? Boolean(force) : !this.classList._set.has(token);
        if (shouldAdd) this.classList._set.add(token);
        else this.classList._set.delete(token);
        return shouldAdd;
      },
      contains: (token) => this.classList._set.has(token),
    };
    this._innerHTML = '';
    this._textContent = '';
    this._rect = { left: 100, top: 700, width: 520, height: 24, right: 620, bottom: 724 };
  }

  get isConnected() {
    return Boolean(this.parentNode);
  }

  get id() {
    return this.getAttribute('id') || '';
  }
  set id(v) {
    this.setAttribute('id', v);
  }

  get className() {
    return [...this.classList._set].join(' ');
  }
  set className(v) {
    this.classList._set.clear();
    String(v || '')
      .split(/\s+/)
      .filter(Boolean)
      .forEach((t) => this.classList._set.add(t));
  }

  get textContent() {
    return this._textContent;
  }
  set textContent(v) {
    this._textContent = String(v ?? '');
  }

  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(v) {
    this._innerHTML = String(v ?? '');
  }

  get previousElementSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    return idx > 0 ? this.parentNode.children[idx - 1] : null;
  }

  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  hasAttribute(k) {
    return this.attributes.has(k);
  }
  removeAttribute(k) {
    this.attributes.delete(k);
  }

  getBoundingClientRect() {
    return { ...this._rect };
  }
  getClientRects() {
    return [this.getBoundingClientRect()];
  }

  attachShadow({ mode }) {
    const sr = new FakeShadowRoot(mode, this);
    this.shadowRoot = sr;
    return sr;
  }

  insertAdjacentElement(pos, el) {
    if (pos === 'afterend' && this.parentNode) {
      if (el.parentNode) {
        const oldIdx = el.parentNode.children.indexOf(el);
        if (oldIdx !== -1) el.parentNode.children.splice(oldIdx, 1);
      }
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) {
        this.parentNode.children.splice(idx + 1, 0, el);
        el.parentNode = this.parentNode;
      }
    }
  }

  appendChild(el) {
    if (el.parentNode) {
      const oldIdx = el.parentNode.children.indexOf(el);
      if (oldIdx !== -1) el.parentNode.children.splice(oldIdx, 1);
    }
    this.children.push(el);
    el.parentNode = this;
    return el;
  }

  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    }
  }

  addEventListener(type, fn, opts) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    const set = this.listeners.get(type);
    set.add(fn);
    if (opts?.signal) {
      opts.signal.addEventListener('abort', () => set.delete(fn));
    }
  }

  dispatchEvent(evt) {
    const set = this.listeners.get(evt.type);
    if (set) {
      for (const fn of set) fn(evt);
    }
    return !evt.defaultPrevented;
  }

  matches(sel) {
    if (sel.includes('.surface-composer')) return this.classList.contains('surface-composer');
    if (sel.includes('conversation-view')) return this.getAttribute('data-testid') === 'conversation-view';
    if (sel.includes('agent-input-box')) return this.getAttribute('data-testid') === 'agent-input-box';
    return false;
  }

  closest(sel) {
    let cur = this;
    while (cur) {
      if (typeof cur.matches === 'function' && cur.matches(sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  querySelectorAll(sel) {
    const out = [];
    const visit = (node) => {
      for (const child of node.children || []) {
        if (
          (sel.includes('.surface-composer') && child.classList.contains('surface-composer')) ||
          (sel === '[data-testid="conversation-view"]' && child.getAttribute('data-testid') === 'conversation-view') ||
          (sel === '[data-testid="agent-input-box"]' && child.getAttribute('data-testid') === 'agent-input-box')
        ) {
          out.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return out;
  }
}

class FakeShadowRoot {
  constructor(mode, host) {
    this.mode = mode;
    this.host = host;
    this._innerHTML = '';
    this.elementsBySel = new Map();
    this.capsules = [];
    this.popovers = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(html) {
    this._innerHTML = String(html ?? '');
    this.elementsBySel.clear();
    this.capsules = [];
    this.popovers = [];

    const container = new FakeElement('div');
    container.className = 'hud-container';
    this.container = container;

    const selectors = [
      '#hud-txt-session .hud-turns',
      '#hud-txt-session .hud-steps',
      '#hud-txt-session .hud-speed',
      '#hud-txt-tokens .hud-tok-total',
      '#hud-txt-tokens .hud-cache-prefix',
      '#hud-txt-tokens .hud-cache-label',
      '#hud-txt-tokens .hud-cache-val',
      '#hud-donut-val',
      '#hud-txt-context',
      '#pop-session-title',
      '#pop-session-badge',
      '#lbl-model-dur',
      '#val-model-dur',
      '#lbl-tool-dur',
      '#val-tool-dur',
      '#lbl-ttft',
      '#val-ttft',
      '#lbl-tps',
      '#val-tps',
      '#pop-tokens-title',
      '#pop-tokens-badge',
      '#lbl-cache-hit',
      '#val-cache-hit',
      '#lbl-uncached-in',
      '#val-uncached-in',
      '#lbl-cached-read',
      '#val-cached-read',
      '#lbl-output-tok',
      '#val-output-tok',
      '#pop-ctx-prefix',
      '#pop-ctx-pct',
      '#pop-ctx-capacity',
      '#pop-ctx-track',
      '#seg-sys',
      '#seg-tool',
      '#seg-msg',
      '#lbl-seg-sys',
      '#val-seg-sys',
      '#lbl-seg-tool',
      '#val-seg-tool',
      '#lbl-seg-msg',
      '#val-seg-msg',
      '#arrow-session',
      '#arrow-tokens',
      '#arrow-context',
    ];
    for (const sel of selectors) {
      this.elementsBySel.set(sel, new FakeElement('div'));
    }

    for (const capId of ['session', 'tokens', 'context']) {
      const btn = new FakeElement('button');
      btn.className = `capsule capsule-${capId}`;
      btn.setAttribute('data-capsule-id', capId);
      btn.setAttribute('aria-expanded', 'false');
      this.capsules.push(btn);
      this.elementsBySel.set(`.capsule-${capId}`, btn);

      const pop = new FakeElement('div');
      pop.id = `hud-popover-${capId}`;
      pop.className = 'hud-popover';
      pop.setAttribute('data-popover-id', capId);
      pop.setAttribute('hidden', '');
      this.popovers.push(pop);
      this.elementsBySel.set(`#hud-popover-${capId}`, pop);
    }
  }

  querySelector(sel) {
    if (sel === '.hud-container') return this.container;
    if (this.elementsBySel.has(sel)) return this.elementsBySel.get(sel);
    if (sel.startsWith('.capsule[data-capsule-id="')) {
      const m = sel.match(/data-capsule-id="([^"]+)"/);
      return this.capsules.find((c) => c.getAttribute('data-capsule-id') === m?.[1]) || null;
    }
    return null;
  }

  querySelectorAll(sel) {
    if (sel === '.capsule') return this.capsules;
    if (sel === '.hud-popover') return this.popovers;
    return [];
  }
}

describe('HudInstance 与 AntigravityHudManager 生产模块生命周期与防篡改测试', () => {
  it('验证双分栏独立挂载、sessionRevision 防篡改、mousedown preventDefault 零焦点争夺及 AbortController 50 次重挂载零泄漏', () => {
    const windowListeners = new Set();
    const doc = new FakeElement('document');
    doc.body = new FakeElement('body', doc);
    doc.documentElement = new FakeElement('html', doc);
    doc.createElement = (tag) => new FakeElement(tag, doc);
    doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
    doc.querySelector = (sel) => doc.body.querySelector(sel);

    globalThis.document = doc;
    globalThis.window = {
      innerWidth: 1024,
      innerHeight: 800,
      location: { pathname: '/c/4ec6348d-0f58-49db-8aed-6f67dbb78f5d' },
      getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
      addEventListener(type, fn, opts) {
        const rec = { type, fn };
        windowListeners.add(rec);
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => windowListeners.delete(rec));
        }
      },
    };
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    };

    const createPane = (cascadeId, convId) => {
      const view = new FakeElement('div', doc);
      view.setAttribute('data-testid', 'conversation-view');
      view.setAttribute('data-cascade-id', cascadeId);
      view.setAttribute('data-conversation-id', convId);
      const inputBox = new FakeElement('div', doc);
      inputBox.setAttribute('data-testid', 'agent-input-box');
      const composer = new FakeElement('div', doc);
      composer.className = 'surface-composer';
      inputBox.appendChild(composer);
      view.appendChild(inputBox);
      doc.body.appendChild(view);
      return { view, inputBox, composer };
    };

    const paneA = createPane('cascade-alpha', 'conv-alpha-11111111');
    createPane('cascade-beta', 'conv-beta-22222222');

    const events = [];
    const manager = new AntigravityHudManager({
      onBridgeEvent: (evt) => events.push(evt),
    });
    manager.start();

    assert.equal(manager.state().instanceCount, 2, '左右双分栏应各自独立挂载 1 个 HudInstance');

    const instA = manager.instances.get('cascade-alpha');
    assert.ok(instA);
    const capsuleBtn = instA.shadow.querySelectorAll('.capsule')[0];
    let prevented = false;
    capsuleBtn.dispatchEvent({
      type: 'mousedown',
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true, '点击胶囊 mousedown 必须调用 preventDefault() 保护输入框光标不失焦');

    const rev1 = instA.switchConversation('conv-1');
    const rev2 = instA.switchConversation('conv-2');
    const rev3 = instA.switchConversation('conv-1');
    assert.ok(rev3 > rev2 && rev2 > rev1);

    const sampleMetrics = (convId, rev) => ({
      conversationId: convId,
      sessionRevision: rev,
      updatedAt: Date.now(),
      isStreaming: false,
      session: {
        turns: 1,
        steps: 142,
        modelDurationSeconds: 3959,
        modelDurationFormatted: '65 分 59 秒',
        modelDurationFormattedEn: '65m 59s',
        toolDurationSeconds: 751,
        toolDurationFormatted: '12 分 31 秒',
        toolDurationFormattedEn: '12m 31s',
        averageTtftSeconds: 19.7,
        averageTtftFormatted: '19.7 秒',
        averageTtftFormattedEn: '19.7s',
        outputTps: 90,
        outputTpsFormatted: '90 tok/s',
      },
      tokens: {
        totalTokens: 58593793,
        totalTokensCompact: '58.6M tok',
        totalTokensFormatted: '58,593,793 tok',
        cacheHitRate: 0.9665,
        cacheHitRateFormatted: '97%',
        uncachedInputTokens: 1961501,
        uncachedInputFormatted: '1,961,501 tok',
        cachedReadTokens: 56526799,
        cachedReadFormatted: '56,526,799 tok',
        outputTokens: 105493,
        outputFormatted: '105,493 tok',
      },
      context: {
        modelId: 'gemini-4-argon',
        modelDisplayName: 'Gemini 4 Argon',
        usedTokens: 672000,
        usedTokensCompact: '~672K',
        capacityTokens: 1048576,
        capacityTokensCompact: '1M',
        isFallbackCapacity: false,
        usedRatio: 0.6408,
        usedRatioFormatted: '64%',
        breakdown: {
          systemTokens: 1900,
          systemTokensCompact: '~1.9K',
          systemRatio: 0.18,
          toolTokens: 7600,
          toolTokensCompact: '~7.6K',
          toolRatio: 0.72,
          messageTokens: 662500,
          messageTokensCompact: '~662K',
          messageRatio: 63.18,
        },
      },
    });

    assert.equal(instA.updateMetrics(sampleMetrics('conv-2', rev2)), false, '不同 conversationId 必须被拦截');
    assert.equal(instA.updateMetrics(sampleMetrics('conv-1', rev1)), false, '过期 sessionRevision 必须被拦截');
    assert.equal(instA.updateMetrics(sampleMetrics('conv-1', rev3)), true, '最新匹配快照正常接收');

    // 验证双语切换
    manager.setLanguage('en');
    assert.equal(instA.shadow.querySelector('#hud-txt-session .hud-turns').textContent, '1T ');
    assert.equal(instA.shadow.querySelector('#hud-txt-session .hud-steps').textContent, '142S');
    assert.equal(instA.shadow.querySelector('#pop-session-title').textContent, 'Session Stats');
    manager.setLanguage('zh');
    assert.equal(instA.shadow.querySelector('#hud-txt-session .hud-turns').textContent, '1 轮 ');
    assert.equal(instA.shadow.querySelector('#hud-txt-session .hud-steps').textContent, '142 步');
    assert.equal(instA.shadow.querySelector('#pop-session-title').textContent, '会话统计');

    // 验证 50 次重挂载零监听器泄漏
    for (let i = 0; i < 50; i++) {
      instA.mount(paneA.composer);
    }
    // paneA (3 listeners) + paneB (3 listeners) = 6
    assert.equal(windowListeners.size, 6, '50 次重挂载后全局监听器数量恒定为 6，无任何累积泄漏');

    manager.dispose();
    assert.equal(manager.state().instanceCount, 0);
    assert.equal(windowListeners.size, 0, 'dispose() 后全局监听器清零');
  });
});
