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
    modelId: 'gemini-3.8-flash',
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
  assert.equal(m.context.usedRatioFormatted, '0.00%');
  assert.equal(m.context.capacityTokens, 200000, 'Antigravity 标准上下文容量应为 200K 而非虚假 1M');
  assert.equal(m.context.capacityTokensCompact, '~200K');
});

test('Case B: 进行中的步骤不参与已完成请求的速度计算 - 真实引擎模块验证', () => {
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
    reasoningTokens: 0,
    candidateTokens: 50
  }];

  const m = buildConversationHudMetrics({
    conversationId: 'conv-instant',
    sessionRevision: 1,
    steps,
    modelId: 'gemini-3.8-flash',
    isStreaming: false
  });
  assert.equal(Number.isFinite(m.session.outputTps), true, 'TPS 不能为 Infinity');
  assert.equal(m.session.outputTpsFormatted, '—', '未完成请求没有可核验完整耗时，显示破折号');

  // 流式状态下瞬时窗口展示 "计算中..."
  const mStreaming = buildConversationHudMetrics({
    conversationId: 'conv-instant',
    sessionRevision: 2,
    steps,
    modelId: 'gemini-3.8-flash',
    isStreaming: true
  });
  assert.equal(mStreaming.session.outputTpsFormatted, '计算中...');
});

test('Case C: 真实单步上下文构成 (缓存复用 vs 本步新增输入) - 零虚构 1.9K/7.6K 基线', () => {
  const steps = [{
    idx: 1,
    stepType: 15,
    status: 2,
    startTimeSeconds: 100.0,
    firstTokenSeconds: 101.0,
    endTimeSeconds: 102.0,
    rawInputTokens: 8312,
    cachedReadTokens: 218100,
    cacheWriteTokens: 0,
    outputTokens: 1240,
    reasoningTokens: 440,
    candidateTokens: 800
  }];

  const m = buildConversationHudMetrics({
    conversationId: 'conv-real-context',
    sessionRevision: 1,
    steps,
    modelId: 'Gemini 3.8 Flash High'
  });
  assert.equal(m.context.usedTokens, 226412);
  assert.equal(m.context.peakContextTokens, 226412);
  assert.equal(m.context.capacityTokens, 200000, '观测峰值不得推导窗口容量');
  assert.equal(m.context.capacityTokensCompact, '~200K');
  assert.equal(m.context.isFallbackCapacity, true);
  assert.equal(m.context.breakdown.cachedContextTokens, 218100, '缓存复用上下文必须 100% 源自最后一步 cachedReadTokens');
  assert.equal(m.context.breakdown.uncachedContextTokens, 8312, '本步新增输入必须 100% 源自最后一步 rawInputTokens');
  assert.equal(m.context.breakdown.latestOutputTokens, 1240, '本步生成输出必须 100% 源自最后一步 outputTokens');
  assert.ok(m.context.breakdown.systemRatio >= 0);
  assert.ok(m.context.breakdown.toolRatio >= 0);
  assert.equal(m.context.breakdown.messageRatio, 0);
});

test('Case D: 超出默认阈值与未知模型 ~200K 回退及显式 DB 容量覆盖', () => {
  const steps = [{
    idx: 1,
    stepType: 15,
    status: 2,
    startTimeSeconds: 100.0,
    firstTokenSeconds: 101.0,
    endTimeSeconds: 105.0,
    rawInputTokens: 50000,
    cachedReadTokens: 100000,
    cacheWriteTokens: 0,
    outputTokens: 1000,
    reasoningTokens: 200,
    candidateTokens: 800
  }];

  const mUnknown = buildConversationHudMetrics({
    conversationId: 'conv-unknown',
    sessionRevision: 1,
    steps,
    modelId: 'custom-unknown-llm-v9'
  });
  assert.equal(mUnknown.context.capacityTokens, 200000);
  assert.equal(mUnknown.context.capacityTokensCompact, '~200K', '未知模型容量应回退为 ~200K 而非虚假 1M');
  assert.equal(mUnknown.context.usedRatio, 0.75);
  assert.equal(mUnknown.context.usedRatioFormatted, '75.00%');

  // 当底层 gen_metadata 显式提供 maxContextTokens 时严格以底层数据为准
  const mExplicit = buildConversationHudMetrics({
    conversationId: 'conv-explicit-cap',
    sessionRevision: 1,
    steps,
    modelId: 'gemini-3.8-flash',
    genMetadata: {
      maxContextTokens: 160000,
      modelDisplayName: 'Gemini 3.8 Flash'
    }
  });
  assert.equal(mExplicit.context.capacityTokens, 160000);
  assert.equal(mExplicit.context.capacityTokensCompact, '160K');
  assert.equal(mExplicit.context.hasExplicitDbCapacity, true);
});

test('Case E: 客户端时间戳逆序、多类型工具步耗时聚合与实机真实数据严密对账', () => {
  const steps = [
    {
      idx: 1,
      stepType: 15,
      status: 3,
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
      status: 3,
      startTimeSeconds: 200.0,
      firstTokenSeconds: null,
      endTimeSeconds: 195.0, // 工具逆序
      rawInputTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      candidateTokens: 0
    },
    {
      idx: 3,
      stepType: 21, // CORTEX_STEP_TYPE_RUN_COMMAND
      status: 3,
      startTimeSeconds: 300.0,
      firstTokenSeconds: null,
      endTimeSeconds: 304.5
    },
    {
      idx: 4,
      stepType: 23, // CORTEX_STEP_TYPE_CHECKPOINT (上下文压缩)
      status: 3,
      startTimeSeconds: 305.0,
      firstTokenSeconds: null,
      endTimeSeconds: 305.2
    }
  ];

  const m = buildConversationHudMetrics({
    conversationId: 'conv-clock-skew',
    sessionRevision: 1,
    steps
  });
  assert.equal(m.session.modelDurationSeconds, 0, '模型用时遭遇时间逆序时应截断为 0');
  assert.equal(m.session.toolDurationSeconds, 4.5, '非 132 的真实工具步骤 (如 RUN_COMMAND=21) 耗时必须纳入统计');
  assert.equal(m.session.toolSteps, 2);
  assert.equal(m.session.compactionCount, 1, 'CHECKPOINT (step_type=23) 应被准确记录为上下文压缩次数');
  assert.equal(m.session.averageTtftFormatted, '—', '缺少首 token 时 TTFT 显示为破折号');

  // 实机真机测试截图 3 对账: 708,929 + 22,416,293 + 70,856 = 23,196,078 (97% 命中)
  const realMachineSteps = [
    { idx: 1, stepType: 101, status: 3, startTimeSeconds: 1, firstTokenSeconds: null, endTimeSeconds: 1, rawInputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, candidateTokens: 0 },
    { idx: 2, stepType: 15, status: 3, startTimeSeconds: 10, firstTokenSeconds: 15.6, endTimeSeconds: 237.0, rawInputTokens: 708929, cachedReadTokens: 22416293, cacheWriteTokens: 0, outputTokens: 70856, reasoningTokens: 20856, candidateTokens: 50000 }
  ];
  const mRef = buildConversationHudMetrics({
    conversationId: 'conv-real-machine',
    sessionRevision: 1,
    steps: realMachineSteps,
    modelId: '+ Gemini 3.8 Flash High ^'
  });
  assert.equal(mRef.tokens.totalTokens, 23196078);
  assert.equal(mRef.tokens.totalTokensCompact, '23.2M tok');
  assert.equal(mRef.tokens.totalTokensFormatted, '23,196,078 tok');
  assert.equal(mRef.tokens.cacheHitRateFormatted, '96.93%');
  assert.equal(mRef.session.averageTtftFormatted, '5.60 秒');
  assert.equal(mRef.session.outputTpsFormatted, '312.14 tok/s');
  assert.equal(mRef.context.modelId, 'gemini-3.8-flash');
  assert.equal(mRef.context.modelDisplayName, 'Gemini 3.8 Flash');

  // 验证模型容量目录映射 (Antigravity 真实标准阈值)
  assert.equal(resolveModelCapacity('gemini-3.8-flash').capacityCompact, '200K');
  assert.equal(resolveModelCapacity('gemini-3.1-pro').capacityCompact, '200K');
  assert.equal(resolveModelCapacity('claude-3-7-sonnet').capacityCompact, '200K');
  assert.equal(resolveModelCapacity('gpt-4o').capacityCompact, '128K');
});

test('Case F: 推理输出使用完整请求耗时，不推算思维链时间或改写原始可见等待', () => {
  // 复现用户实机截图数据:
  // 模型总用时 = 22 分 43 秒 (1,363s)，其中 viewable_at - created_at = 1,179s (含 TTFT + 50,329 思维链 token)，
  // completed_at - viewable_at = 184.09s (仅含 15,023 回复 token)，总输出 = 65,352 tok (50,329 思维链 + 15,023 回复)
  const thinkingSessionSteps = [
    { idx: 1, stepType: 14, status: 3, startTimeSeconds: 1, endTimeSeconds: 1 },
    {
      idx: 2,
      stepType: 15,
      status: 3,
      startTimeSeconds: 100.0,
      firstTokenSeconds: 100.0 + 1178.91, // viewable_at: 思维链结束时刻
      endTimeSeconds: 100.0 + 1363.0,     // finished_generating_at: 回复结束时刻 (dtPost = 184.09s)
      rawInputTokens: 442089,
      cachedReadTokens: 14997295,
      cacheWriteTokens: 0,
      outputTokens: 65352,
      reasoningTokens: 50329,
      candidateTokens: 15023,
    },
  ];

  const m = buildConversationHudMetrics({
    conversationId: 'conv-thinking-calibrated',
    sessionRevision: 1,
    steps: thinkingSessionSteps,
    modelId: 'Gemini 3.8 Flash High',
  });

  assert.equal(m.tokens.totalTokens, 15504736);
  assert.equal(m.tokens.cacheHitRateFormatted, '97.14%');
  assert.equal(m.session.modelDurationFormatted, '22 分 43 秒');
  // 校准后 TPS 必须反映真实物理流式速率 (~82 tok/s)，绝不再出现将 65,352 除以 184s 得出的 355 tok/s
  assert.equal(m.session.outputTps, 65352 / 1363);
  assert.equal(m.session.outputTpsFormatted, '47.95 tok/s');
  assert.equal(m.session.averageTtftFormatted, '1178.91 秒');
});
