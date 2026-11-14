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
      '#hud-txt-session .hud-turn-dur',
      '#hud-txt-session .hud-speed',
      '#hud-txt-session .hud-subagent-tag',
      '#hud-txt-tokens .hud-tok-total',
      '#hud-txt-tokens .hud-cache-prefix',
      '#hud-txt-tokens .hud-cache-label',
      '#hud-txt-tokens .hud-cache-val',
      '#hud-compaction-badge',
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
      '#row-turn-dur',
      '#lbl-turn-dur',
      '#val-turn-dur',
      '#row-subagent-status',
      '#lbl-subagent-status',
      '#val-subagent-status',
      '#hud-session-status-note',
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
      modelDurationSeconds: 1348.126, modelDurationFormatted: '22分28秒',
      toolDurationSeconds: 59.999, toolDurationFormatted: '1分',
      compactionCount: 2,
      currentTurnDurationSeconds: 18.4,
      currentTurnDurationFormatted: '18秒',
      currentTurnDurationFormattedEn: '18s',
      currentTurnDurationCompactZh: '本轮 18s',
      currentTurnDurationCompactEn: 'Turn 18s',
      currentTurnModelDurationSeconds: 14.2,
      currentTurnToolDurationSeconds: 4.2,
    },
    tokens: {
      totalTokens: 61234567, totalTokensCompact: '61.2M tok', totalTokensFormatted: 'rounded',
      cacheHitRate: 0.96943, cacheHitRateFormatted: '96.94%',
      uncachedInputTokens: 1234567, cachedReadTokens: 59876543, outputTokens: 123457,
      cacheWriteTokens: 1001, reasoningTokens: 12345, candidateTokens: 111112,
    },
    context: {
      hasUsageData: true, usedTokens: 226412, usedTokensCompact: '226.4K',
      usedRatio: 1.13206, usedRatioFormatted: '113%',
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
    it(`${languageMode}: 胶囊与展开卡片统一采用紧凑数字表示法（Compact Number Notation）与压缩徽章控制`, () => {
      const { instance, text } = render(metrics, languageMode);
      assert.equal(text('#hud-txt-session .hud-speed'), ' · 83 tok/s');
      assert.equal(text('#hud-txt-session .hud-turn-dur'), languageMode === 'en' ? '· Turn 18s' : '· 本轮 18s');
      assert.equal(text('#pop-session-badge'), languageMode === 'en' ? '12 turns 1.23K steps' : '12 轮 1.23K 步');
      assert.equal(text('#hud-txt-tokens .hud-tok-total'), '61M tok');
      assert.equal(text('#hud-txt-tokens .hud-cache-val'), '97%');
      assert.equal(text('#hud-compaction-badge'), '2');
      assert.equal(instance.shadow.querySelector('#hud-compaction-badge').hasAttribute('hidden'), false);
      assert.equal(instance.shadow.querySelector('.capsule-context').classList.contains('has-compaction'), true);
      assert.equal(text('#hud-txt-context'), '~113%');
      assert.equal(text('#val-tps'), '82.74 tok/s');
      assert.equal(text('#val-turn-dur'), languageMode === 'en' ? '18s' : '18秒');
      assert.equal(text('#val-ttft'), languageMode === 'en' ? '3.85s' : '3.85 秒');
      assert.equal(text('#val-model-dur'), languageMode === 'en' ? '22m28s' : '22分28秒');
      assert.equal(text('#val-tool-dur'), languageMode === 'en' ? '1m' : '1分');
      assert.equal(text('#val-cache-hit'), '96.9%');
      assert.equal(text('#pop-tokens-badge'), '61.2M tok');
      assert.equal(text('#val-uncached-in'), '1.23M tok');
      assert.equal(text('#val-cached-read'), '59.9M tok');
      assert.equal(text('#val-output-tok'), '123K tok');
      assert.equal(text('#val-cache-write'), '1K tok');
      assert.equal(text('#val-reasoning-tok'), '12.3K / 111K tok');
      assert.equal(text('#pop-ctx-pct'), '~113%');
      assert.equal(text('#pop-ctx-capacity'), '226K / ~200K');
      assert.equal(text('#val-seg-sys'), '218K tok');
      assert.equal(text('#val-seg-tool'), '8.31K tok');
      assert.equal(text('#val-seg-msg'), '1.24K tok');
      assert.equal(text('#val-ctx-peak'), languageMode === 'en'
        ? '1.23M tok (2x compacted)' : '1.23M tok (已压缩 2 次)');
      assert.equal(text('#val-ctx-model'), metrics.context.modelDisplayName);
      assert.equal(instance.shadow.querySelector('#seg-msg').style.width, '0%');
      assert.equal(instance.shadow.querySelector('#pop-ctx-track').getAttribute('aria-valuenow'), '100');
      assert.equal(instance.shadow.querySelector('#pop-ctx-track').getAttribute('aria-valuetext'), '113%');
      assert.match(instance.shadow.querySelector('#val-tps').getAttribute('aria-description'), /等待|waiting/);
      assert.match(instance.shadow.querySelector('#val-ttft').getAttribute('aria-description'), /原始|original/);
      const builtHtml = instance.buildHudHtml();
      assert.equal((builtHtml.match(/class="hud-popover-row"/g) || []).length, 17);
      assert.equal(builtHtml.includes('hud-data-state'), false, 'HUD 展开卡片不应包含时间与计时请求数行');
      assert.equal(builtHtml.includes('hud-copy-stats'), false, 'HUD 展开卡片不应包含复制精确统计按钮');
      assert.equal(builtHtml.includes('复制精确统计'), false);
      assert.equal(builtHtml.includes('Copy Exact Stats'), false);

      // 当压缩次数为 0 时隐藏徽章，移除 has-compaction 类
      const zeroComp = render({
        ...metrics,
        session: { ...metrics.session, compactionCount: 0, turns: 1500, steps: 2500000, subagentCount: 1200, subagentSteps: 3450 },
      }, languageMode);
      assert.equal(zeroComp.instance.shadow.querySelector('#hud-compaction-badge').hasAttribute('hidden'), true);
      assert.equal(zeroComp.text('#hud-compaction-badge'), '');
      assert.equal(zeroComp.instance.shadow.querySelector('.capsule-context').classList.contains('has-compaction'), false);
      assert.equal(zeroComp.text('#hud-txt-session .hud-turns'), languageMode === 'en' ? '1.5KT ' : '1.5K 轮 ');
      assert.equal(zeroComp.text('#pop-session-badge'), languageMode === 'en' ? '1.5K turns 2.5M steps' : '1.5K 轮 2.5M 步');
      assert.equal(zeroComp.text('#val-subagent-status'), languageMode === 'en' ? '1.2K scheduled (3.45K steps)' : '已调度 1.2K 个（3.45K 步）');
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
    assert.equal(zero.text('#val-model-dur'), '0秒');
    assert.equal(zero.text('#val-cache-hit'), '0%');
    assert.equal(zero.text('#pop-ctx-pct'), '0%');
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
      assert.equal(text('#pop-ctx-capacity'), '226K / ~200K');
      assert.equal(instance.shadow.querySelector('#seg-sys').style.width, '40.000%');
      assert.equal(instance.shadow.querySelector('#seg-tool').style.width, '10.000%');
      assert.equal(instance.shadow.querySelector('#seg-msg').style.width, '0%');
      assert.equal(text('#val-seg-msg'), output >= 1_000_000 ? '1M tok' : '1 tok');
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
    const instA = manager.instances.get(manager.viewToSlotId.get(paneA.view));
    assert.ok(instA);
    assert.equal(paneA.bottomDock.style.paddingBottom, '16px', 'HUD 不得修改宿主 pb-4 内边距');
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
        modelDurationFormatted: '22分28秒',
        modelDurationFormattedEn: '22m28s',
        toolDurationSeconds: 360,
        toolDurationFormatted: '6分',
        toolDurationFormattedEn: '6m',
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
    assert.equal(instA.shadow.querySelector('#pop-ctx-capacity').textContent, '226K / 262K');
    assert.equal(instA.shadow.querySelector('#lbl-seg-sys').textContent, '缓存复用上下文');
    assert.equal(instA.shadow.querySelector('#val-seg-sys').textContent, '218K tok');
    assert.equal(instA.shadow.querySelector('#lbl-seg-tool').textContent, '本步新增输入');
    assert.equal(instA.shadow.querySelector('#val-seg-tool').textContent, '8.31K tok');
    assert.equal(instA.shadow.querySelector('#val-ctx-peak').textContent, '226K tok (已压缩 1 次)');
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
    assert.equal(instA.shadow.querySelector('#pop-session-badge').textContent, '9 turns 425 steps');
    assert.equal(instA.shadow.querySelector('#pop-session-title').textContent, 'Session Stats');
    assert.equal(instA.shadow.querySelector('#lbl-seg-sys').textContent, 'Cached Context');
    manager.setLanguage('zh');
    assert.equal(instA.shadow.querySelector('#hud-txt-session .hud-turns').textContent, '9 轮 ');
    assert.equal(instA.shadow.querySelector('#pop-session-badge').textContent, '9 轮 425 步');
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

    // 验证方案 A: 主对话模型已停止而子智能体独立运行时 (1 subagent running)，状态栏保留子智能体运行态与计时，但小圆点保持灰色 idle
    const subagentStatusNode = new FakeElement('div', doc);
    subagentStatusNode.setAttribute('data-testid', 'idle-status-text');
    subagentStatusNode.textContent = '1 subagent running';
    paneA.view.appendChild(subagentStatusNode);

    const subState = manager.resolveSubagentState(paneA.view);
    assert.equal(subState.isSubagentRunning, true, '应准确检测到 [data-testid="idle-status-text"] 中的子智能体运行状态');
    assert.equal(subState.runningSubagentCount, 1);
    assert.equal(manager.resolveStreamingState(paneA.view), false, '仅子智能体运行时主栏前台流式状态为 false');
    assert.equal(
      manager.resolveActivityPhase(paneA.view),
      'idle',
      '主对话模型已停止而仅子智能体运行时，主对话小圆点必须保持 idle（灰色）'
    );

    manager.reconcileMounts();
    assert.equal(instA.isStreaming, false);
    assert.equal(instA.activityPhase, 'idle');
    assert.equal(instA.hasActiveWork, true);
    assert.equal(
      instA.shadow.querySelector('.capsule-session').classList.contains('is-streaming'),
      false,
      '仅后台子智能体运行时主栏胶囊不得携带 is-streaming'
    );
    assert.equal(
      instA.shadow.querySelector('.capsule-session').classList.contains('is-executing'),
      false,
      '仅后台子智能体运行时主栏胶囊不得携带 is-executing 呼吸类'
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

    // 移除子智能体状态文本，确认无前台残留
    subagentStatusNode.remove();
    assert.equal(manager.resolveStreamingState(paneA.view), false, '子智能体结束后流式状态保持为 false');

    // 验证后台普通终端任务 ("1 task running" / "1 个后台任务正在运行")、普通 Working 状态与权限指示器不会误报为子智能体运行中
    const bgTaskStatusNode = new FakeElement('div', doc);
    bgTaskStatusNode.setAttribute('data-testid', 'idle-status-text');
    bgTaskStatusNode.textContent = '1 task running';
    paneA.view.appendChild(bgTaskStatusNode);
    assert.equal(
      manager.resolveSubagentState(paneA.view).isSubagentRunning,
      false,
      '普通后台任务 "1 task running" 绝不能误报为子智能体运行中'
    );
    bgTaskStatusNode.textContent = '1 个后台任务正在运行';
    assert.equal(
      manager.resolveSubagentState(paneA.view).isSubagentRunning,
      false,
      '汉化后的 "1 个后台任务正在运行" 绝不能误报为子智能体运行中'
    );
    bgTaskStatusNode.textContent = 'Working';
    assert.equal(
      manager.resolveSubagentState(paneA.view).isSubagentRunning,
      false,
      '主智能体普通 "Working" 状态不得误报为子智能体运行中'
    );
    bgTaskStatusNode.remove();
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
    const thinkingShimmer = new FakeElement('span', doc);
    thinkingShimmer.className = 'animate-shimmer-text';
    thinkingShimmer.textContent = 'Thinking';
    paneA.view.appendChild(thinkingShimmer);

    const cmdShimmer = new FakeElement('span', doc);
    cmdShimmer.className = 'animate-shimmer-text';
    cmdShimmer.textContent = 'Running npm test';
    paneA.view.appendChild(cmdShimmer);
    assert.equal(
      manager.resolveActivityPhase(paneA.view),
      'executing',
      '前台轮次中思考文本与工具运行并存时必须识别为 executing（蓝色呼吸）'
    );

    // 前台模型停止（Cancel 按钮消失）但后台工具 shimmer 与 .codicon-loading 仍存在时，小圆点必须立即恢复灰色 idle
    const codiconLoading = new FakeElement('span', doc);
    codiconLoading.className = 'codicon-loading';
    paneA.view.appendChild(codiconLoading);
    cancelBtn.remove();
    assert.equal(
      manager.resolveActivityPhase(paneA.view),
      'idle',
      '停止按钮消失后，即使工具 shimmer 与 .codicon-loading 仍存在也必须恢复为 idle（灰色）'
    );
    codiconLoading.remove();
    thinkingShimmer.remove();
    cmdShimmer.remove();
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
    assert.equal(paneA.bottomDock.style.paddingBottom, '0px', 'HUD 不得猜测或修改宿主既有内联样式');
    paneA.bottomDock.style.paddingBottom = '16px';
    manager.setEnabled(true);

    // 验证 50 次重挂载零监听器泄漏
    const refreshedInstA = manager.instances.get(manager.viewToSlotId.get(paneA.view));
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

  it('unavailable 态显示清晰中文/英文标签（不显示 ———），普通文本包含 subagent 不误触发子智能体运行态', () => {
    const inst = new HudInstance('slot-empty');
    const host = new FakeElement('div');
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = inst.buildHudHtml();
    inst.shadow = sr;
    inst.applyMetricsToDom({
      ...inst.lastMetrics,
      conversationId: 'missing-conv',
      availability: 'unavailable',
    });
    assert.equal(sr.querySelector('#hud-txt-session .hud-turns').textContent, '');
    assert.equal(sr.querySelector('#hud-txt-session .hud-turn-dur').textContent, '暂无数据');
    assert.equal(sr.querySelector('#hud-txt-session .hud-speed').textContent, '');

    inst.applyMetricsToDom({
      ...inst.lastMetrics,
      conversationId: 'conv-partial',
      availability: 'partial',
      observedAt: 1731420000000,
    });
    assert.equal(sr.querySelector('#hud-session-status-note').hasAttribute('hidden'), false);
    assert.match(sr.querySelector('#hud-session-status-note').textContent, /部分数据或子库未就绪/);

    const mgr = new AntigravityHudManager();
    const view = new FakeElement('div');
    const toolNode = new FakeElement('div');
    toolNode.setAttribute('data-testid', 'tool-call');
    toolNode.textContent = 'run_command: grep subagent running';
    view.appendChild(toolNode);
    assert.equal(mgr.resolveSubagentState(view).isSubagentRunning, false);
  });

  it('流式生成期间本轮用时客户端时钟平滑 1 秒步进且结束后回落权威耗时，销毁零残留定时器', async () => {
    const inst = new HudInstance({ cascadeId: 'pane-turn-clock', isPrimaryPane: true });
    const composer = new FakeElement('div');
    composer.setAttribute('data-testid', 'agent-input-box');
    const wrapper = new FakeElement('div');
    wrapper.classList.add('pb-4');
    wrapper.appendChild(composer);
    inst.mount(composer);
    const sr = inst.host.shadowRoot;

    inst.switchConversation('conv-turn-clock', 'gemini-3.8-flash', true);
    inst.updateMetrics({
      conversationId: 'conv-turn-clock',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 1,
      isStreaming: true,
      session: {
        turns: 1,
        steps: 2,
        currentTurnDurationSeconds: 10,
        currentTurnDurationFormatted: '10秒',
        currentTurnDurationFormattedEn: '10s',
        currentTurnDurationCompactZh: '本轮 10s',
        currentTurnDurationCompactEn: 'Turn 10s',
      },
      tokens: { totalTokens: 100 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });

    assert.equal(sr.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· 本轮 10s');
    assert.equal(sr.querySelector('#val-turn-dur').textContent, '10秒');
    assert.ok(inst.turnClockTimer !== null, '流式活跃时必须启动平滑时钟');

    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.ok(
      ['· 本轮 11s', '· 本轮 12s'].includes(sr.querySelector('#hud-txt-session .hud-turn-dur').textContent),
      `即使后端暂无新推包，1.15s 后常驻栏也应前进到 11s/12s，实际 ${sr.querySelector('#hud-txt-session .hud-turn-dur').textContent}`
    );
    assert.ok(
      ['11秒', '12秒'].includes(sr.querySelector('#val-turn-dur').textContent),
      `展开卡片应同步每秒更新，实际 ${sr.querySelector('#val-turn-dur').textContent}`
    );

    // 后端在流式结束时推回最终权威数据库耗时 14.2s，DOM 同步为 14s 且定时器停止
    inst.notifyModelOrStreamingChange(null, false, false, 0, null, 'idle');
    inst.updateMetrics({
      conversationId: 'conv-turn-clock',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 2,
      isStreaming: false,
      session: {
        turns: 1,
        steps: 3,
        currentTurnDurationSeconds: 14.2,
        currentTurnDurationFormatted: '14秒',
        currentTurnDurationFormattedEn: '14s',
        currentTurnDurationCompactZh: '本轮 14s',
        currentTurnDurationCompactEn: 'Turn 14s',
      },
      tokens: { totalTokens: 200 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });
    assert.equal(inst.turnClockTimer, null, '进入 idle 后必须立即停止客户端时钟');
    assert.equal(sr.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· 本轮 14s');
    assert.equal(sr.querySelector('#val-turn-dur').textContent, '14秒');
    inst.dispose();
  });

  it('子智能体切换间隙或 turns 延迟落库时，本轮用时保持单调递增不暂停、不回退', () => {
    const inst = new HudInstance({ cascadeId: 'pane-subagent-monotonic', isPrimaryPane: true });
    const composer = new FakeElement('div');
    composer.setAttribute('data-testid', 'agent-input-box');
    inst.mount(composer);
    const sr = inst.host.shadowRoot;

    // 1. 子智能体运行到 23s，且起初 turns 尚未写入 DB（turns=0）
    inst.switchConversation('conv-subagent-clock', 'gemini-3.8-flash', true, true, 1);
    inst.updateMetrics({
      conversationId: 'conv-subagent-clock',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 1,
      isStreaming: true,
      isSubagentRunning: true,
      runningSubagentCount: 1,
      session: {
        turns: 0,
        steps: 3,
        subagentCount: 1,
        currentTurnDurationSeconds: 23.0,
        currentTurnDurationFormatted: '23秒',
        currentTurnDurationFormattedEn: '23s',
        currentTurnDurationCompactZh: '本轮 23s',
        currentTurnDurationCompactEn: 'Turn 23s',
      },
      tokens: { totalTokens: 100 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });
    assert.equal(sr.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· 本轮 23s');

    // 2. 子智能体切换瞬间短暂出现 idle 抖动且后端仅上报 20s，绝不能从 23s 回退到 20s
    inst.notifyModelOrStreamingChange(null, false, false, 0, null, 'idle');
    inst.updateMetrics({
      conversationId: 'conv-subagent-clock',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 2,
      isStreaming: false,
      isSubagentRunning: false,
      runningSubagentCount: 0,
      session: {
        turns: 0,
        steps: 3,
        subagentCount: 1,
        currentTurnDurationSeconds: 20.0,
        currentTurnDurationFormatted: '20秒',
        currentTurnDurationFormattedEn: '20s',
        currentTurnDurationCompactZh: '本轮 20s',
        currentTurnDurationCompactEn: 'Turn 20s',
      },
      tokens: { totalTokens: 100 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });
    assert.equal(sr.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· 本轮 23s');
    assert.equal(sr.querySelector('#val-turn-dur').textContent, '23秒');

    // 3. 父对话恢复流式并延迟落库 turns: 0 -> 1 且 backendSec=20s，计时仍应从 >=23s 继续前进
    inst.notifyModelOrStreamingChange('gemini-3.8-flash', true, true, 1, null, 'executing');
    inst.updateMetrics({
      conversationId: 'conv-subagent-clock',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 3,
      isStreaming: true,
      isSubagentRunning: true,
      runningSubagentCount: 1,
      session: {
        turns: 1,
        steps: 4,
        subagentCount: 1,
        currentTurnDurationSeconds: 20.0,
        currentTurnDurationFormatted: '20秒',
        currentTurnDurationFormattedEn: '20s',
        currentTurnDurationCompactZh: '本轮 20s',
        currentTurnDurationCompactEn: 'Turn 20s',
      },
      tokens: { totalTokens: 120 },
      context: { hasUsageData: true, usedRatio: 0.12 },
    });
    assert.equal(sr.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· 本轮 23s');
    assert.ok(inst.turnClockTimer !== null, '子智能体恢复活跃后客户端时钟必须继续运行');
    inst.dispose();
  });

  it('模型用时与工具调用用时共用客户端走表器：按活跃阶段分相每秒递增、切换不回退闪烁、结束后校准权威值', async () => {
    const inst = new HudInstance({ cascadeId: 'pane-sub-clocks', isPrimaryPane: true });
    const composer = new FakeElement('div');
    composer.setAttribute('data-testid', 'agent-input-box');
    inst.mount(composer);
    const sr = inst.host.shadowRoot;

    // 1. 模型思考阶段 (activeModelStepCount=1, activeToolStepCount=0)：模型用时走表，工具用时冻结
    inst.switchConversation('conv-sub-clocks', 'gemini-3.8-flash', true, false, 0, null, 'generating');
    inst.updateMetrics({
      conversationId: 'conv-sub-clocks',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 1,
      isStreaming: true,
      activityPhase: 'generating',
      session: {
        turns: 1,
        steps: 3,
        modelDurationSeconds: 10,
        modelDurationFormatted: '10秒',
        modelDurationFormattedEn: '10s',
        inFlightModelDurationSeconds: 5,
        activeModelStepCount: 1,
        toolDurationSeconds: 4,
        toolDurationFormatted: '4秒',
        toolDurationFormattedEn: '4s',
        inFlightToolDurationSeconds: 0,
        activeToolStepCount: 0,
        currentTurnDurationSeconds: 9,
        currentTurnDurationFormatted: '9秒',
        currentTurnDurationFormattedEn: '9s',
        currentTurnDurationCompactZh: '本轮 9s',
        currentTurnDurationCompactEn: 'Turn 9s',
      },
      tokens: { totalTokens: 100 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });
    assert.equal(sr.querySelector('#val-model-dur').textContent, '15秒');
    assert.equal(sr.querySelector('#val-tool-dur').textContent, '4秒');

    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.ok(
      ['16秒', '17秒'].includes(sr.querySelector('#val-model-dur').textContent),
      `模型活跃阶段模型用时应每秒推进，实际 ${sr.querySelector('#val-model-dur').textContent}`
    );
    assert.equal(sr.querySelector('#val-tool-dur').textContent, '4秒', '模型思考时工具用时不得同时走表');

    // 2. 刚切入工具阶段但 DB 尚未落盘上一步模型耗时 (modelDurationSeconds 暂仍为 10, active=0)，模型用时不得回退到 10s
    inst.notifyModelOrStreamingChange(null, true, false, 0, null, 'executing');
    inst.updateMetrics({
      conversationId: 'conv-sub-clocks',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 2,
      isStreaming: true,
      activityPhase: 'executing',
      session: {
        turns: 1,
        steps: 4,
        modelDurationSeconds: 10,
        modelDurationFormatted: '10秒',
        modelDurationFormattedEn: '10s',
        inFlightModelDurationSeconds: 0,
        activeModelStepCount: 0,
        toolDurationSeconds: 4,
        toolDurationFormatted: '4秒',
        toolDurationFormattedEn: '4s',
        inFlightToolDurationSeconds: 1,
        activeToolStepCount: 1,
        currentTurnDurationSeconds: 11,
        currentTurnDurationFormatted: '11秒',
        currentTurnDurationFormattedEn: '11s',
        currentTurnDurationCompactZh: '本轮 11s',
        currentTurnDurationCompactEn: 'Turn 11s',
      },
      tokens: { totalTokens: 100 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });
    const heldModelText = sr.querySelector('#val-model-dur').textContent;
    assert.ok(['16秒', '17秒'].includes(heldModelText), `切换瞬间模型用时应保持高水位不回退，实际 ${heldModelText}`);
    assert.equal(sr.querySelector('#val-tool-dur').textContent, '5秒');

    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.equal(sr.querySelector('#val-model-dur').textContent, heldModelText, '工具执行期间模型用时应暂停走表');
    assert.ok(
      ['6秒', '7秒'].includes(sr.querySelector('#val-tool-dur').textContent),
      `工具活跃阶段工具用时应每秒推进，实际 ${sr.querySelector('#val-tool-dur').textContent}`
    );

    // 3. 结束后归位到数据库权威耗时且时钟停止
    inst.notifyModelOrStreamingChange(null, false, false, 0, null, 'idle');
    inst.updateMetrics({
      conversationId: 'conv-sub-clocks',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 3,
      isStreaming: false,
      activityPhase: 'idle',
      session: {
        turns: 1,
        steps: 5,
        modelDurationSeconds: 16.4,
        modelDurationFormatted: '16秒',
        modelDurationFormattedEn: '16s',
        inFlightModelDurationSeconds: 0,
        activeModelStepCount: 0,
        toolDurationSeconds: 6.3,
        toolDurationFormatted: '6秒',
        toolDurationFormattedEn: '6s',
        inFlightToolDurationSeconds: 0,
        activeToolStepCount: 0,
        currentTurnDurationSeconds: 12.7,
        currentTurnDurationFormatted: '13秒',
        currentTurnDurationFormattedEn: '13s',
        currentTurnDurationCompactZh: '本轮 13s',
        currentTurnDurationCompactEn: 'Turn 13s',
      },
      tokens: { totalTokens: 200 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });
    assert.equal(inst.turnClockTimer, null);
    assert.equal(inst.modelClockAnchor, null);
    assert.equal(inst.toolClockAnchor, null);
    assert.equal(sr.querySelector('#val-model-dur').textContent, '16秒');
    assert.equal(sr.querySelector('#val-tool-dur').textContent, '6秒');
    inst.dispose();
  });

  it('独立子智能体分栏 (isSubpane) 采用同一套小圆点状态机语义，且不自报嵌套子智能体', () => {
    const doc = new FakeElement('document');
    doc.body = new FakeElement('body', doc);
    const mgr = new AntigravityHudManager();
    const subView = new FakeElement('div', doc);
    subView.setAttribute('data-testid', 'subagent-tab-conversation');
    subView.setAttribute('data-cascade-id', 'sub-conv-1');
    subView.setAttribute('data-media-drop-scope', 'subpane');

    // 1. 子智能体分栏自身思考中 -> generating（常亮蓝），且不误报 nested subagent
    const thinkingMarker = new FakeElement('div', doc);
    thinkingMarker.setAttribute('data-testid', 'browser-subagent-thinking');
    subView.appendChild(thinkingMarker);
    assert.equal(mgr.resolveSubagentState(subView, { isSubpane: true }).isSubagentRunning, false);
    assert.equal(mgr.resolveActivityPhase(subView, null, { isSubpane: true }), 'generating');

    // 2. 子智能体自身执行工具（Stop subagent + 工具 shimmer）-> executing（呼吸蓝）
    thinkingMarker.remove();
    const stopSubBtn = new FakeElement('button', doc);
    stopSubBtn.setAttribute('aria-label', 'Stop subagent');
    subView.appendChild(stopSubBtn);
    const toolShimmer = new FakeElement('span', doc);
    toolShimmer.className = 'animate-shimmer-text';
    toolShimmer.textContent = 'Running read_file';
    subView.appendChild(toolShimmer);
    assert.equal(mgr.resolveSubagentState(subView, { isSubpane: true }).isSubagentRunning, false);
    assert.equal(mgr.resolveActivityPhase(subView, null, { isSubpane: true }), 'executing');

    // 3. 子智能体停止，即使残留 .codicon-loading 与旧 shimmer -> idle（灰色）
    stopSubBtn.remove();
    const staleLoading = new FakeElement('span', doc);
    staleLoading.className = 'codicon-loading';
    subView.appendChild(staleLoading);
    assert.equal(mgr.resolveActivityPhase(subView, null, { isSubpane: true }), 'idle');

    mgr.dispose();
  });

  it('上下文进度条采用单色渐深蓝平滑演进，压缩次数徽章严格呈 1 轻蓝 / 2 实心琥珀 / 3+ 实心正红三级联动', () => {
    const parseRgb = (str) => {
      const m = String(str).match(/rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)/i);
      assert.ok(m, `应输出 rgb() 格式颜色，实际 ${str}`);
      return [Number(m[1]), Number(m[2]), Number(m[3])];
    };
    const renderMeter = ({ compactionCount = 0, usedRatio = 0.2, dark = false }) => {
      const instance = new HudInstance();
      const host = new FakeElement('div');
      const shadow = host.attachShadow({ mode: 'open' });
      host.shadowRoot = shadow;
      if (dark) host.setAttribute('data-theme', 'dark');
      instance.host = host;
      instance.shadow = shadow;
      shadow.innerHTML = instance.buildHudHtml();
      instance.isDarkTheme = dark;
      instance.switchConversation('conv-ctx-meter');
      instance.applyMetricsToDom({
        conversationId: 'conv-ctx-meter',
        sessionRevision: instance.getSessionRevision(),
        updatedAt: Date.now(),
        isStreaming: false,
        session: { turns: 1, steps: 2, compactionCount },
        tokens: { totalTokens: 1000 },
        context: { hasUsageData: true, usedTokens: 1000, usedRatio, isFallbackCapacity: false },
      });
      return instance;
    };

    // 1. 浅色模式下 15% -> 50% -> 95% 保持单调加深的同一蓝色系，95% 也不跳变黄/红
    const r15 = renderMeter({ compactionCount: 1, usedRatio: 0.15 });
    const r50 = renderMeter({ compactionCount: 2, usedRatio: 0.5 });
    const r95 = renderMeter({ compactionCount: 4, usedRatio: 0.95 });

    const fill15 = parseRgb(r15.shadow.querySelector('#hud-meter-fill').getAttribute('fill'));
    const fill50 = parseRgb(r50.shadow.querySelector('#hud-meter-fill').getAttribute('fill'));
    const fill95 = parseRgb(r95.shadow.querySelector('#hud-meter-fill').getAttribute('fill'));
    assert.ok(fill15[2] > fill15[0] && fill50[2] > fill50[0] && fill95[2] > fill95[0], '所有阶段必须保持蓝色主通道占优');
    assert.ok(fill15[0] > fill50[0] && fill50[0] > fill95[0], '浅色模式红色分量应随占比递增而单调加深');
    assert.ok(fill15[1] > fill50[1] && fill50[1] > fill95[1], '浅色模式绿色分量应随占比递增而单调加深');

    // 2. 深色模式下同样保持冰蓝 -> 品牌亮蓝 -> 电光深蓝单调加深
    const dark10Inst = renderMeter({ compactionCount: 1, usedRatio: 0.1, dark: true });
    const dark90Inst = renderMeter({ compactionCount: 3, usedRatio: 0.9, dark: true });
    const dark10 = parseRgb(dark10Inst.shadow.querySelector('#hud-meter-fill').getAttribute('fill'));
    const dark90 = parseRgb(dark90Inst.shadow.querySelector('#hud-meter-fill').getAttribute('fill'));
    assert.ok(dark10[2] > dark10[0] && dark90[2] > dark90[0], '深色模式同样必须保持单色蓝通道占优');
    assert.ok(dark10[0] > dark90[0] && dark10[1] > dark90[1], '深色模式由浅冰蓝平滑过渡到高饱电光蓝');

    // 3. 压缩次数徽章三级语义类与属性：1 -> low, 2 -> warn, 3+ -> danger, 0 -> 隐藏并清除
    const badge1 = r15.shadow.querySelector('#hud-compaction-badge');
    const badge2 = r50.shadow.querySelector('#hud-compaction-badge');
    const badge4 = r95.shadow.querySelector('#hud-compaction-badge');
    assert.equal(badge1.getAttribute('data-compaction-tier'), 'low');
    assert.equal(badge1.classList.contains('is-compaction-low'), true);
    assert.equal(badge2.getAttribute('data-compaction-tier'), 'warn');
    assert.equal(badge2.classList.contains('is-compaction-warn'), true);
    assert.equal(badge4.getAttribute('data-compaction-tier'), 'danger');
    assert.equal(badge4.classList.contains('is-compaction-danger'), true);

    const cleared = renderMeter({ compactionCount: 0, usedRatio: 0.3 });
    const badge0 = cleared.shadow.querySelector('#hud-compaction-badge');
    assert.equal(badge0.hasAttribute('hidden'), true);
    assert.equal(badge0.getAttribute('data-compaction-tier'), null);
    assert.equal(badge0.classList.contains('is-compaction-warn'), false);
    assert.equal(badge0.classList.contains('is-compaction-danger'), false);
  });
});
