import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversationHudMetrics,
  resolveModelCapacity
} from '../dist/hud.js';

test('Case A: 新会话空状态 (0 Token, 0 轮次, 0 步数) - 真实引擎模块验证', () => {
  const m = buildConversationHudMetrics({
    conversationId: 'conv-empty',
    sessionRevision: 1,
    steps: [],
    modelId: 'gemini-4-argon',
    isStreaming: false
  });
  assert.equal(m.session.turns, 0);
  assert.equal(m.session.steps, 0);
  assert.equal(m.tokens.totalTokens, 0);
  assert.equal(m.tokens.cacheHitRate, 0, '缓存命中率分母为 0 时应安全返回 0 而不是 NaN');
  assert.equal(Number.isNaN(m.tokens.cacheHitRate), false);
  assert.equal(m.session.averageTtftFormatted, '—');
  assert.equal(m.session.outputTpsFormatted, '—');
  assert.equal(Number.isFinite(m.session.outputTps), true);
  assert.equal(m.context.usedRatio, 0);
  assert.equal(m.context.usedRatioFormatted, '0%');
});

test('Case B: 超瞬时生成 (活跃时间 <= 0 或极小 0.001s < 0.1s 窗口保护) - 真实引擎模块验证', () => {
  const steps = [{
    idx: 1,
    stepType: 15,
    status: 2,
    startTimeSeconds: 100.0,
    firstTokenSeconds: 101.0,
    endTimeSeconds: 101.001, // 活跃生成时间 = 0.001s < 0.1s
    rawInputTokens: 1000,
    cachedReadTokens: 2000,
    cacheWriteTokens: 0,
    outputTokens: 50,
    reasoningTokens: 10,
    candidateTokens: 40
  }];

  const m = buildConversationHudMetrics({
    conversationId: 'conv-instant',
    sessionRevision: 1,
    steps,
    modelId: 'gemini-4-argon',
    isStreaming: false
  });
  assert.equal(Number.isFinite(m.session.outputTps), true, 'TPS 不能为 Infinity');
  assert.equal(m.session.outputTpsFormatted, '—', '瞬时窗口 < 0.1s 无历史步时应安全展示破折号');

  // 流式状态下瞬时窗口展示 "计算中..."
  const mStreaming = buildConversationHudMetrics({
    conversationId: 'conv-instant',
    sessionRevision: 2,
    steps,
    modelId: 'gemini-4-argon',
    isStreaming: true
  });
  assert.equal(mStreaming.session.outputTpsFormatted, '计算中...');
});

test('Case C: 极小上下文 (总已用 Token 500 远小于 9.5K 系统基线) - 级联裁剪杜绝负百分比', () => {
  const steps = [{
    idx: 1,
    stepType: 15,
    status: 2,
    startTimeSeconds: 100.0,
    firstTokenSeconds: 101.0,
    endTimeSeconds: 102.0,
    rawInputTokens: 500,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 50,
    reasoningTokens: 0,
    candidateTokens: 50
  }];

  const m = buildConversationHudMetrics({
    conversationId: 'conv-small',
    sessionRevision: 1,
    steps,
    modelId: 'gemini-4-argon'
  });
  assert.equal(m.context.usedTokens, 500);
  assert.equal(m.context.breakdown.systemTokens, 500);
  assert.equal(m.context.breakdown.toolTokens, 0);
  assert.equal(m.context.breakdown.messageTokens, 0, '消息 Token 不应为负数');
  assert.ok(m.context.breakdown.systemRatio > 0);
  assert.equal(m.context.breakdown.toolRatio, 0);
  assert.equal(m.context.breakdown.messageRatio, 0, 'W_msg 必须精确为 0，绝不能出现负百分比');
});

test('Case D: 超长上下文 (总已用 Token 超过 1M 物理上限) & 未知模型 ~1M 回退', () => {
  const steps = [{
    idx: 1,
    stepType: 15,
    status: 2,
    startTimeSeconds: 100.0,
    firstTokenSeconds: 101.0,
    endTimeSeconds: 105.0,
    rawInputTokens: 1200000,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1000,
    reasoningTokens: 200,
    candidateTokens: 800
  }];

  const m = buildConversationHudMetrics({
    conversationId: 'conv-overflow',
    sessionRevision: 1,
    steps,
    modelId: 'custom-unknown-llm-v9'
  });
  assert.equal(m.context.capacityTokens, 1048576);
  assert.equal(m.context.capacityTokensCompact, '~1M', '未知模型容量应带 ~ 约数前缀');
  assert.equal(m.context.usedRatio, 1.0, 'UI 渲染比例必须被截断在 1.0 (100%)，防止撑破进度条');
  assert.equal(m.context.usedRatioFormatted, '100%');
});

test('Case E: 客户端时间戳逆序与首 Token 丢失 & 实机截图 2/3/4 严密对账', () => {
  const steps = [
    {
      idx: 1,
      stepType: 15,
      status: 2,
      startTimeSeconds: 105.0,
      firstTokenSeconds: null,
      endTimeSeconds: 102.0, // 逆序
      rawInputTokens: 1000,
      cachedReadTokens: 1000,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 0,
      candidateTokens: 100
    },
    {
      idx: 2,
      stepType: 132,
      status: 2,
      startTimeSeconds: 200.0,
      firstTokenSeconds: null,
      endTimeSeconds: 195.0, // 工具逆序
      rawInputTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      candidateTokens: 0
    }
  ];

  const m = buildConversationHudMetrics({
    conversationId: 'conv-clock-skew',
    sessionRevision: 1,
    steps
  });
  assert.equal(m.session.modelDurationSeconds, 0, '模型用时遭遇时间逆序时应截断为 0');
  assert.equal(m.session.toolDurationSeconds, 0, '工具用时遭遇时间逆序时应截断为 0');
  assert.equal(m.session.averageTtftFormatted, '—', '缺少首 token 时 TTFT 显示为破折号');

  // 实机截图 3 数据对账: 1,961,501 + 56,526,799 + 105,493 = 58,593,793 (97% 命中)
  const screenshotSteps = [
    { idx: 1, stepType: 101, status: 2, startTimeSeconds: 1, firstTokenSeconds: null, endTimeSeconds: 1, rawInputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, candidateTokens: 0 },
    { idx: 2, stepType: 15, status: 2, startTimeSeconds: 10, firstTokenSeconds: 29.7, endTimeSeconds: 1201.9, rawInputTokens: 1961501, cachedReadTokens: 56526799, cacheWriteTokens: 0, outputTokens: 105493, reasoningTokens: 25493, candidateTokens: 80000 }
  ];
  const mRef = buildConversationHudMetrics({
    conversationId: 'conv-ref',
    sessionRevision: 1,
    steps: screenshotSteps,
    modelId: 'gemini-4-argon'
  });
  assert.equal(mRef.tokens.totalTokens, 58593793);
  assert.equal(mRef.tokens.totalTokensCompact, '58.6M tok');
  assert.equal(mRef.tokens.totalTokensFormatted, '58,593,793 tok');
  assert.equal(mRef.tokens.cacheHitRateFormatted, '97%');
  assert.equal(mRef.session.averageTtftFormatted, '19.7 秒');
  assert.equal(mRef.session.outputTpsFormatted, '90 tok/s');

  // 验证模型容量目录映射
  assert.equal(resolveModelCapacity('gemini-2.5-pro').capacityCompact, '2M');
  assert.equal(resolveModelCapacity('claude-3-7-sonnet').capacityCompact, '200K');
  assert.equal(resolveModelCapacity('gpt-4o').capacityCompact, '128K');
});
