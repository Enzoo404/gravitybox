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
    const testIdTargets = [...String(sel).matchAll(/\[data-testid="([^"]+)"\]/g)].map((match) => match[1]);
    const matchButtonTag = /\bbutton\b/.test(String(sel));
    const matchShimmerClass = String(sel).includes('.animate-shimmer-text');
    const visit = (node) => {
      for (const child of node.children || []) {
        const childTestId = child.getAttribute('data-testid');
        if (
          (sel.includes('.surface-composer') && child.classList.contains('surface-composer')) ||
          (matchShimmerClass && child.classList.contains('animate-shimmer-text')) ||
          (childTestId && testIdTargets.includes(childTestId)) ||
          (matchButtonTag && child.tagName === 'BUTTON')
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
      '#hud-txt-session .hud-subagent-tag',
      '#hud-txt-tokens .hud-tok-total',
      '#hud-txt-tokens .hud-cache-prefix',
      '#hud-txt-tokens .hud-cache-label',
      '#hud-txt-tokens .hud-cache-val',
      '#hud-donut-val',
      '#hud-meter-fill',
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
      '#row-subagent-status',
      '#lbl-subagent-status',
      '#val-subagent-status',
      '#pop-tokens-title',
      '#pop-tokens-badge',
      '#lbl-cache-hit',
      '#val-cache-hit',
      '#lbl-uncached-in',
      '#val-uncached-in',
      '#lbl-cached-read',
      '#val-cached-read',
      '#row-cache-write',
      '#lbl-cache-write',
      '#val-cache-write',
      '#lbl-output-tok',
      '#val-output-tok',
      '#row-reasoning-tok',
      '#lbl-reasoning-tok',
      '#val-reasoning-tok',
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
      '#row-ctx-peak',
      '#lbl-ctx-peak',
      '#val-ctx-peak',
      '#row-ctx-model',
      '#lbl-ctx-model',
      '#val-ctx-model',
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

describe('HUD raw 数值精度与缺值展示', () => {
  function render(metrics, languageMode = 'zh') {
    const instance = new HudInstance('formatting', { languageMode });
    instance.shadow = new FakeShadowRoot('open', null);
    instance.shadow.innerHTML = instance.buildHudHtml();
    instance.applyMetricsToDom(metrics);
    return { instance, text: (selector) => instance.shadow.querySelector(selector).textContent };
  }

  const metrics = {
    session: {
      turns: 12, steps: 1234, outputTps: 82.7364, outputTpsFormatted: '82.74 tok/s',
      averageTtftSeconds: 3.8462, averageTtftFormatted: '3.85 秒',
      modelDurationSeconds: 1348.126, modelDurationFormatted: '22 分 28 秒',
      toolDurationSeconds: 59.999, toolDurationFormatted: '1 分 0 秒',
      compactionCount: 2,
    },
    tokens: {
      totalTokens: 61234567, totalTokensCompact: '61.2M tok', totalTokensFormatted: 'rounded',
      cacheHitRate: 0.96943, cacheHitRateFormatted: '96.94%',
      uncachedInputTokens: 1234567, cachedReadTokens: 59876543, outputTokens: 123457,
      cacheWriteTokens: 1001, reasoningTokens: 12345, candidateTokens: 111112,
    },
    context: {
      hasUsageData: true, usedTokens: 226412, usedTokensCompact: '226.4K',
      usedRatio: 1.13206, usedRatioFormatted: '113.21%',
      capacityTokens: 200000, capacityTokensCompact: '~200K', isFallbackCapacity: true,
      peakContextTokens: 1234567,
      modelDisplayName: 'Gemini Very Long Model Name With Extended Context Preview',
      breakdown: {
        cachedContextTokens: 218100, cachedContextRatio: 109.05,
        uncachedContextTokens: 8312, uncachedContextRatio: 4.156,
        latestOutputTokens: 1240, messageRatio: 20,
      },
    },
  };

  for (const languageMode of ['zh', 'en']) {
    it(`${languageMode}: 胶囊整数、详情按规则保留精度与 M/K 单位，保留全部既有项目`, () => {
      const { instance, text } = render(metrics, languageMode);
      assert.equal(text('#hud-txt-session .hud-speed'), ' · 83 tok/s');
      assert.equal(text('#hud-txt-session .hud-steps'), languageMode === 'en' ? '1,234S' : '1,234 步');
      assert.equal(text('#hud-txt-tokens .hud-tok-total'), '61M tok');
      assert.equal(text('#hud-txt-tokens .hud-cache-val'), '97%');
      assert.equal(text('#hud-txt-context'), '113%');
      assert.equal(text('#val-tps'), '82.74 tok/s');
      assert.equal(text('#val-ttft'), languageMode === 'en' ? '3.85s' : '3.85 秒');
      assert.equal(text('#val-model-dur'), languageMode === 'en' ? '22m 28s' : '22 分 28 秒');
      assert.equal(text('#val-tool-dur'), languageMode === 'en' ? '1m 0s' : '1 分 0 秒');
      assert.equal(text('#val-cache-hit'), '96.94%');
      assert.equal(text('#pop-tokens-badge'), '61.23M tok');
      assert.equal(text('#val-uncached-in'), '1.23M tok');
      assert.equal(text('#val-cached-read'), '59.88M tok');
      assert.equal(text('#val-output-tok'), '123.46K tok');
      assert.equal(text('#val-cache-write'), '1.00K tok');
      assert.equal(text('#val-reasoning-tok'), '12.35K / 111.11K tok');
      assert.equal(text('#pop-ctx-pct'), '113.21%');
      assert.equal(text('#pop-ctx-capacity'), '226.41K / ~200K');
      assert.equal(text('#val-seg-sys'), '218.10K tok');
      assert.equal(text('#val-seg-tool'), '8.31K tok');
      assert.equal(text('#val-seg-msg'), '1.24K tok');
      assert.equal(text('#val-ctx-peak'), languageMode === 'en'
        ? '1.23M tok (2x compacted)' : '1.23M tok (已压缩 2 次)');
      assert.equal(text('#val-ctx-model'), metrics.context.modelDisplayName);
      assert.equal(instance.shadow.querySelector('#seg-msg').style.width, '0%');
      assert.equal(instance.shadow.querySelector('#pop-ctx-track').getAttribute('aria-valuenow'), '100');
      assert.equal(instance.shadow.querySelector('#pop-ctx-track').getAttribute('aria-valuetext'), '113.21%');
      assert.match(instance.shadow.querySelector('#val-tps').getAttribute('aria-description'), /等待|waiting/);
      assert.match(instance.shadow.querySelector('#val-ttft').getAttribute('aria-description'), /原始|original/);
      assert.equal((instance.buildHudHtml().match(/class="hud-popover-row"/g) || []).length, 16);
    });
  }

  it('缺失与实测零严格区分，流式 measuring 信号保持双语', () => {
    for (const missing of [null, undefined, NaN, Infinity]) {
      const { text } = render({
        session: { outputTps: missing, averageTtftSeconds: missing },
        tokens: { cacheHitRate: missing }, context: { usedRatio: missing },
      });
      for (const selector of ['#val-tps', '#val-ttft', '#val-cache-hit', '#pop-ctx-pct']) {
        assert.equal(text(selector), '—');
      }
    }
    const zero = render({ session: { outputTps: 0, averageTtftSeconds: 0, modelDurationSeconds: 0 },
      tokens: { cacheHitRate: 0 }, context: { usedRatio: 0 } });
    assert.equal(zero.text('#val-tps'), '0.00 tok/s');
    assert.equal(zero.text('#val-ttft'), '0.00 秒');
    assert.equal(zero.text('#val-model-dur'), '0 秒');
    assert.equal(zero.text('#val-cache-hit'), '0.00%');
    assert.equal(zero.text('#pop-ctx-pct'), '0.00%');
    const absent = render({ session: { outputTps: 0, outputTpsFormatted: '—',
      averageTtftSeconds: 0, averageTtftFormatted: '—' } });
    assert.equal(absent.text('#val-tps'), '—');
    assert.equal(absent.text('#val-ttft'), '—');
    for (const lang of ['zh', 'en']) {
      const { text } = render({ session: { outputTps: 0, outputTpsFormatted: '计算中...' } }, lang);
      assert.equal(text('#val-tps'), lang === 'en' ? 'Measuring…' : '计算中...');
    }
  });

  it('缺少上下文用量不显示伪零或猜测容量；实测输入进度不计入输出', () => {
    const absent = render({ context: { hasUsageData: false, usedRatio: 0, usedTokens: 0 } });
    assert.equal(absent.text('#hud-txt-context'), '—');
    assert.equal(absent.text('#pop-ctx-capacity'), '— / —');
    assert.equal(absent.text('#val-seg-sys'), '—');
    for (const output of [1, 1000000]) {
      const { instance, text } = render({ context: { ...metrics.context, usedRatio: 0.5,
        capacityTokensCompact: '200K', breakdown: { cachedContextRatio: 40,
          uncachedContextRatio: 10, latestOutputTokens: output } } });
      assert.equal(text('#pop-ctx-capacity'), '226.41K / ~200K');
      assert.equal(instance.shadow.querySelector('#seg-sys').style.width, '40.000%');
      assert.equal(instance.shadow.querySelector('#seg-tool').style.width, '10.000%');
      assert.equal(instance.shadow.querySelector('#seg-msg').style.width, '0%');
      assert.equal(text('#val-seg-msg'), output >= 1_000_000 ? '1.00M tok' : '1 tok');
    }
  });

  it('三张展开卡片保持协调宽度，窄视口保留两侧留白', () => {
    const { instance } = render(metrics);
    const previousWindow = globalThis.window;
    try {
      instance.targetComposer = { getBoundingClientRect: () => ({ width: 520 }) };
      globalThis.window = { innerWidth: 1024, innerHeight: 800 };
      const expectedWidths = { session: '296px', tokens: '296px', context: '312px' };
      for (const [popoverId, expectedWidth] of Object.entries(expectedWidths)) {
        instance.activePopoverId = popoverId;
        const popover = instance.shadow.querySelector(`#hud-popover-${popoverId}`);
        popover.getBoundingClientRect = () => ({
          left: parseFloat(popover.style.left), width: parseFloat(popover.style.width),
          bottom: globalThis.window.innerHeight - parseFloat(popover.style.bottom), height: 190,
        });
        instance.repositionActivePopover();
        assert.equal(popover.style.width, expectedWidth);
      }
      const popover = instance.shadow.querySelector('#hud-popover-context');
      globalThis.window.innerWidth = 260;
      instance.repositionActivePopover();
      assert.equal(popover.style.width, '236px');
      assert.equal(popover.style.left, '12px');
    } finally {
      globalThis.window = previousWindow;
    }
  });
});

describe('HudInstance 与 AntigravityHudManager 生产模块生命周期、垂直居中平衡与防篡改测试', () => {
  it('验证双分栏独立挂载、pb-4 底部包装器垂直居中平衡与恢复、无原生 title、子智能体工作状态感知、sessionRevision 防篡改及 AbortController 50 次重挂载零泄漏', () => {
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
      matchMedia: () => ({ matches: true }),
      getComputedStyle: () => ({ visibility: 'visible', display: 'block', paddingBottom: '0px' }),
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

      // 模拟 Antigravity 原生外层 pb-4 底部包装器 (p7)
      const bottomDock = new FakeElement('div', doc);
      bottomDock.className = 'relative w-full px-4 pb-4 flex-shrink-0 flex flex-col items-center gap-2';
      bottomDock.style.paddingBottom = '16px';

      const inputBox = new FakeElement('div', doc);
      inputBox.setAttribute('data-testid', 'agent-input-box');
      const composer = new FakeElement('div', doc);
      composer.className = 'surface-composer';
      inputBox.appendChild(composer);
      bottomDock.appendChild(inputBox);
      view.appendChild(bottomDock);
      doc.body.appendChild(view);
      return { view, bottomDock, inputBox, composer };
    };

    const paneA = createPane('cascade-alpha', 'conv-alpha-11111111');
    createPane('cascade-beta', 'conv-beta-22222222');

    const events = [];
    const manager = new AntigravityHudManager({
      onBridgeEvent: (evt) => events.push(evt),
    });
    manager.start();

    assert.equal(manager.state().instanceCount, 2, '左右双分栏应各自独立挂载 1 个 HudInstance');

    // 验证 Issue 1: 外层 pb-4 底部内边距被平衡归零，且 HUD 上下 margin 对称居中
    const instA = manager.instances.get('cascade-alpha');
    assert.ok(instA);
    assert.equal(paneA.bottomDock.style.paddingBottom, '0px', '外层 pb-4 容器底部内边距应被自动归零以消除下偏');
    assert.equal(instA.host.style.marginTop, instA.host.style.marginBottom, 'HUD 上下外边距必须完全对称居中');

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
        turns: 9,
        steps: 425,
        compactionCount: 1,
        modelDurationSeconds: 1348,
        modelDurationFormatted: '22 分 28 秒',
        modelDurationFormattedEn: '22m 28s',
        toolDurationSeconds: 360,
        toolDurationFormatted: '6 分 0 秒',
        toolDurationFormattedEn: '6m 0s',
        averageTtftSeconds: 3.8,
        averageTtftFormatted: '3.8 秒',
        averageTtftFormattedEn: '3.8s',
        outputTps: 82,
        outputTpsFormatted: '82 tok/s',
      },
      tokens: {
        totalTokens: 23196078,
        totalTokensCompact: '23.2M tok',
        totalTokensFormatted: '23,196,078 tok',
        cacheHitRate: 0.9694,
        cacheHitRateFormatted: '97%',
        uncachedInputTokens: 708929,
        uncachedInputFormatted: '708,929 tok',
        cachedReadTokens: 22416293,
        cachedReadFormatted: '22,416,293 tok',
        outputTokens: 70856,
        outputFormatted: '70,856 tok',
        reasoningTokens: 20856,
        candidateTokens: 50000,
      },
      context: {
        modelId: 'gemini-3.8-flash',
        modelDisplayName: 'Gemini 3.8 Flash',
        usedTokens: 226412,
        usedTokensCompact: '226K',
        usedTokensFormatted: '226,412 tok',
        peakContextTokens: 226412,
        peakContextCompact: '226K',
        peakContextFormatted: '226,412 tok',
        capacityTokens: 262144,
        capacityTokensCompact: '256K',
        isFallbackCapacity: false,
        usedRatio: 0.8637,
        usedRatioFormatted: '86%',
        breakdown: {
          cachedContextTokens: 218100,
          cachedContextFormatted: '218,100 tok',
          cachedContextRatio: 83.2,
          uncachedContextTokens: 8312,
          uncachedContextFormatted: '8,312 tok',
          uncachedContextRatio: 3.17,
          latestOutputTokens: 1240,
          latestOutputFormatted: '1,240 tok',
          systemTokens: 218100,
          systemTokensCompact: '218,100 tok',
          systemRatio: 83.2,
          toolTokens: 8312,
          toolTokensCompact: '8,312 tok',
          toolRatio: 3.17,
          messageTokens: 1240,
          messageTokensCompact: '1,240 tok',
          messageRatio: 0,
        },
      },
    });

    assert.equal(instA.updateMetrics(sampleMetrics('conv-2', rev2)), false, '不同 conversationId 必须被拦截');
    assert.equal(instA.updateMetrics(sampleMetrics('conv-1', rev1)), false, '过期 sessionRevision 必须被拦截');
    assert.equal(instA.updateMetrics(sampleMetrics('conv-1', rev3)), true, '最新匹配快照正常接收');

    // 验证会话切换后 pinnedPopoverId 必须被重置，不得阻塞新会话中的胶囊悬停
    instA.handleCapsuleClick(capsuleBtn, { stopPropagation() {} });
    assert.equal(instA.pinnedPopoverId, 'session');
    assert.equal(
      capsuleBtn.classList.contains('is-streaming'),
      false,
      '模型未工作时点击展开卡片不得将状态圆点置为工作态'
    );
    const rev4 = instA.switchConversation('conv-3');
    assert.equal(instA.pinnedPopoverId, null, '切换会话后必须清除旧会话锁定的 pinnedPopoverId');
    assert.equal(instA.updateMetrics(sampleMetrics('conv-3', rev4)), true);

    // 验证 Popover 3 展示真实上下文明细而非 1.9K/7.6K 假数据
    assert.equal(instA.shadow.querySelector('#pop-ctx-capacity').textContent, '226.41K / 262.14K');
    assert.equal(instA.shadow.querySelector('#lbl-seg-sys').textContent, '缓存复用上下文');
    assert.equal(instA.shadow.querySelector('#val-seg-sys').textContent, '218.10K tok');
    assert.equal(instA.shadow.querySelector('#lbl-seg-tool').textContent, '本步新增输入');
    assert.equal(instA.shadow.querySelector('#val-seg-tool').textContent, '8.31K tok');
    assert.equal(instA.shadow.querySelector('#val-ctx-peak').textContent, '226.41K tok (已压缩 1 次)');
    assert.equal(instA.shadow.querySelector('#val-ctx-model').textContent, 'Gemini 3.8 Flash');

    // 验证浅色主题显式声明时，即使系统 matchMedia 为 dark 也不得误判为深色
    doc.body.className = 'theme-standalone light light-theme theme-light';
    instA.syncTheme();
    assert.equal(instA.host.hasAttribute('data-theme'), false, '显式浅色主题下不得被系统深色偏好覆盖为 dark');
    doc.body.className = 'theme-standalone dark dark-theme theme-dark';
    instA.syncTheme();
    assert.equal(instA.host.getAttribute('data-theme'), 'dark');

    // 验证双语切换
    manager.setLanguage('en');
    assert.equal(instA.shadow.querySelector('#hud-txt-session .hud-turns').textContent, '9T ');
    assert.equal(instA.shadow.querySelector('#hud-txt-session .hud-steps').textContent, '425S');
    assert.equal(instA.shadow.querySelector('#pop-session-title').textContent, 'Session Stats');
    assert.equal(instA.shadow.querySelector('#lbl-seg-sys').textContent, 'Cached Context');
    manager.setLanguage('zh');
    assert.equal(instA.shadow.querySelector('#hud-txt-session .hud-turns').textContent, '9 轮 ');
    assert.equal(instA.shadow.querySelector('#hud-txt-session .hud-steps').textContent, '425 步');
    assert.equal(instA.shadow.querySelector('#pop-session-title').textContent, '会话统计');
    assert.equal(instA.shadow.querySelector('#lbl-seg-sys').textContent, '缓存复用上下文');

    // 验证 Issue 1 (v2.1): 3 个状态栏胶囊绝不包含任何原生 title 悬浮提示属性，避免遮挡上浮卡片
    assert.equal(
      /\btitle\s*=\s*"/i.test(instA.shadow.innerHTML),
      false,
      'HUD HTML 模板绝不应包含原生 title="..." 属性'
    );
    for (const cap of instA.shadow.querySelectorAll('.capsule')) {
      assert.equal(cap.hasAttribute('title'), false, '胶囊按钮不得携带原生 title 属性');
    }

    // 验证 Issue 2 (v2.1): 子智能体独立运行时 (1 subagent running)，状态栏实时检测并反映工作状态
    const subagentStatusNode = new FakeElement('div', doc);
    subagentStatusNode.setAttribute('data-testid', 'idle-status-text');
    subagentStatusNode.textContent = '1 subagent running';
    paneA.view.appendChild(subagentStatusNode);

    const subState = manager.resolveSubagentState(paneA.view);
    assert.equal(subState.isSubagentRunning, true, '应准确检测到 [data-testid="idle-status-text"] 中的子智能体运行状态');
    assert.equal(subState.runningSubagentCount, 1);
    assert.equal(manager.resolveStreamingState(paneA.view), true, '子智能体运行时流式状态必须为 true');
    assert.equal(
      manager.resolveActivityPhase(paneA.view),
      'executing',
      '无前台生成但有后台任务/子智能体运行时阶段必须为 executing（蓝色呼吸）'
    );

    manager.reconcileMounts();
    assert.equal(instA.isStreaming, true);
    assert.equal(instA.activityPhase, 'executing');
    assert.equal(
      instA.shadow.querySelector('.capsule-session').classList.contains('is-executing'),
      true,
      '脚本/后台任务执行时胶囊必须携带 is-executing 蓝色呼吸类'
    );
    assert.equal(instA.isSubagentRunning, true);
    assert.equal(
      instA.shadow.querySelector('#hud-txt-session .hud-subagent-tag').textContent,
      ' · 子智能体运行中',
      '状态栏分段 1 应实时展示与全局词典一致的 " · 子智能体运行中"'
    );
    assert.equal(
      instA.shadow.querySelector('#row-subagent-status').hasAttribute('hidden'),
      false,
      'Popover 1 应展开子智能体状态行'
    );
    assert.equal(
      instA.shadow.querySelector('#val-subagent-status').textContent,
      '1 个运行中'
    );

    // 验证后端 SQLite 报告子智能体运行而前端 DOM 空闲时，不会触发无限 STREAMING_CHANGED 乒乓风暴
    subagentStatusNode.remove();
    assert.equal(manager.resolveStreamingState(paneA.view), false, '子智能体结束后流式状态恢复为 false');
    const cancelBtn = new FakeElement('button', doc);
    cancelBtn.setAttribute('data-testid', 'input-cancel-button');
    cancelBtn.setAttribute('aria-label', 'Cancel (⌃C)');
    paneA.view.appendChild(cancelBtn);
    assert.equal(
      manager.resolveActivityPhase(paneA.view),
      'generating',
      '宿主出现 input-cancel-button 且无脚本执行时必须识别为 generating（常亮蓝色）'
    );
    manager.reconcileMounts();
    assert.equal(
      instA.shadow.querySelector('.capsule-session').classList.contains('is-generating'),
      true,
      '模型本身思考/输出时胶囊必须携带 is-generating 常亮蓝色类'
    );
    assert.equal(
      instA.shadow.querySelector('.capsule-session').classList.contains('is-executing'),
      false,
      '模型本身思考/输出时不得携带呼吸类'
    );
    const cmdShimmer = new FakeElement('span', doc);
    cmdShimmer.className = 'animate-shimmer-text';
    cmdShimmer.textContent = 'Running npm test';
    paneA.view.appendChild(cmdShimmer);
    assert.equal(
      manager.resolveActivityPhase(paneA.view),
      'executing',
      '模型暂停、脚本命令执行时必须切换为 executing（蓝色呼吸）'
    );
    cmdShimmer.remove();
    cancelBtn.remove();
    assert.equal(
      manager.resolveActivityPhase(paneA.view),
      'idle',
      '模型与脚本均停止后必须立即恢复为 idle（灰色）'
    );
    manager.reconcileMounts();
    const streamingEventsBefore = events.filter((e) => e.type === 'STREAMING_CHANGED').length;
    instA.updateMetrics({
      ...sampleMetrics('conv-3', rev4),
      isStreaming: true,
      isSubagentRunning: true,
      runningSubagentCount: 1,
    });
    manager.reconcileMounts();
    manager.reconcileMounts();
    const streamingEventsAfter = events.filter((e) => e.type === 'STREAMING_CHANGED').length;
    assert.equal(
      streamingEventsAfter,
      streamingEventsBefore,
      '后端子智能体活跃而 DOM 空闲时重复 reconcile 不得反复发送 STREAMING_CHANGED'
    );

    // 验证动态关闭/开启 HUD (setEnabled) 无损还原并可重新挂载
    manager.setEnabled(false);
    assert.equal(manager.state().instanceCount, 0);
    assert.equal(paneA.bottomDock.style.paddingBottom, '16px', '关闭 HUD 时必须立即还原宿主容器 paddingBottom');
    // 模拟崩溃残留内联 paddingBottom: 0px 时挂载后仍能清空回退至 Tailwind pb-4 样式
    paneA.bottomDock.style.paddingBottom = '0px';
    manager.setEnabled(true);
    assert.equal(manager.state().instanceCount, 2, '重新开启 HUD 后应立即恢复双分栏实例');
    manager.setEnabled(false);
    assert.equal(paneA.bottomDock.style.paddingBottom, '', '遇到残留内联 0px 的 pb-4 容器时卸载应清空内联样式以恢复原生类内边距');
    paneA.bottomDock.style.paddingBottom = '16px';
    manager.setEnabled(true);

    // 验证 50 次重挂载零监听器泄漏
    const refreshedInstA = manager.instances.get('cascade-alpha');
    for (let i = 0; i < 50; i++) {
      refreshedInstA.mount(paneA.composer);
    }
    // paneA (4 listeners: resize/pointerdown/keydown/blur) + paneB (4 listeners) = 8
    assert.equal(windowListeners.size, 8, '50 次重挂载后全局监听器数量恒定为 8，无任何累积泄漏');

    manager.dispose();
    assert.equal(manager.state().instanceCount, 0);
    assert.equal(windowListeners.size, 0, 'dispose() 后全局监听器清零');
    assert.equal(paneA.bottomDock.style.paddingBottom, '16px', 'dispose() 后必须无损还原外层容器原始 paddingBottom');
  });
});
