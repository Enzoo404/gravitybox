import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpHudBridge, buildConversationHudMetrics } from '../dist/hud.js';

test('bridge targets physical slots and drops A→B→A late results', async () => {
  const pending = [], sent = [];
  const engine = { getConversationMetrics: options => new Promise(resolve => pending.push({ options, resolve })), clearCache() {} };
  const bridge = new CdpHudBridge({ engine, pollIntervalMs: 0 });
  await bridge.attachToTarget('target', { send: async () => ({}), evaluate: async expression => sent.push(expression) }, () => 1);
  const attach = (id, revision, slot = 'left') => bridge.handleRawBindingPayload('target', JSON.stringify({
    type: 'SESSION_ATTACHED', cascadeId: id, paneSlotId: slot, conversationId: id, sessionRevision: revision,
    isStreaming: false, isSubagentRunning: false, modelId: 'gemini-3.8-flash', timestamp: Date.now(),
  }));
  attach('A', 1); attach('B', 2); attach('A', 3); attach('A', 4, 'right');
  for (const request of pending) request.resolve(buildConversationHudMetrics({ ...request.options, steps: [] }));
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 2);
  assert.ok(sent.some(x => x.includes('"paneSlotId":"left"') && x.includes('"sessionRevision":3')));
  assert.ok(sent.some(x => x.includes('"paneSlotId":"right"') && x.includes('"sessionRevision":4')));
  assert.equal(bridge.getActivePanes().length, 2);
  bridge.dispose();
});

test('foreground idle plus running child keeps activityPhase idle while preserving isSubagentRunning and no cross-conversation fallback', async () => {
  const calls = [];
  const bridge = new CdpHudBridge({ pollIntervalMs: 0, engine: {
    getConversationMetrics: async options => { calls.push(options); return buildConversationHudMetrics({ ...options, steps: [] }); }, clearCache() {},
  } });
  const event = data => bridge.handleRawBindingPayload('t', JSON.stringify({ type: 'REQUEST_REFRESH', cascadeId: 'pane', timestamp: Date.now(), ...data }));
  event({ conversationId: 'A', sessionRevision: 1, modelId: 'claude-opus-5-5', isStreaming: true, activityPhase: 'generating' });
  event({ conversationId: 'A', sessionRevision: 1, isStreaming: false, isSubagentRunning: true, activityPhase: 'idle' });
  event({ conversationId: 'B', sessionRevision: 2 });
  await new Promise(r => setImmediate(r));
  assert.equal(calls[1].activityPhase, 'idle');
  assert.equal(calls[1].isSubagentRunning, true);
  assert.equal(calls[2].isStreaming, false);
  assert.notEqual(calls[2].modelId, 'claude-opus-5-5');
  bridge.dispose();
});

test('bridge fingerprint rounds inFlight model/tool durations to throttle sub-second polls', async () => {
  const sent = [];
  let inFlightModel = 10.1;
  const engine = {
    getConversationMetrics: async options => {
      const m = buildConversationHudMetrics({ ...options, observedAt: 1_700_000_000_000, steps: [] });
      m.session.inFlightModelDurationSeconds = inFlightModel;
      m.session.activeModelStepCount = 1;
      return m;
    },
    clearCache() {},
  };
  const bridge = new CdpHudBridge({ engine, pollIntervalMs: 0 });
  await bridge.attachToTarget('t', { send: async () => ({}), evaluate: async expr => sent.push(expr) }, () => 1);
  bridge.handleRawBindingPayload('t', JSON.stringify({
    type: 'SESSION_ATTACHED', cascadeId: 'p', paneSlotId: 'left', conversationId: 'conv-1', sessionRevision: 1,
    isStreaming: true, activityPhase: 'generating', timestamp: Date.now(),
  }));
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 1);

  // 同秒微增量 (10.1 -> 10.4) 应被指纹节流抑制
  inFlightModel = 10.4;
  await bridge.pollActiveSessions(true);
  assert.equal(sent.length, 1);

  // 跨过整秒阈值 (10.4 -> 11.2) 应推送更新
  inFlightModel = 11.2;
  await bridge.pollActiveSessions(true);
  assert.equal(sent.length, 2);
  bridge.dispose();
});
