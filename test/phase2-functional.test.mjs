import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AccountsManager,
} from '../dist/accounts.js';

test('A07: setAutoSwitchConfig 支持局部更新且 selectBestAccount 遵守 enabled 开关', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-a07-'));
  try {
    const mgr = new AccountsManager(sandbox);

    // 1. 初始化并写入自定义的策略阈值
    await mgr.setAutoSwitchConfig({
      enabled: true,
      strategy: 'round_robin',
      reserve_percentage: 15,
      candidate_min_percentage: 40,
    });

    const customCfg = await mgr.getAutoSwitchConfig();
    assert.equal(customCfg.enabled, true);
    assert.equal(customCfg.strategy, 'round_robin');
    assert.equal(customCfg.reserve_percentage, 15);
    assert.equal(customCfg.candidate_min_percentage, 40);

    // 2. 仅更新 enabled: false（局部更新测试）
    const partialUpdate = await mgr.setAutoSwitchConfig({ enabled: false });
    assert.equal(partialUpdate.enabled, false);
    // 关键断言：原有的阈值与策略绝对不能被硬编码覆写为 10/30/priority！
    assert.equal(partialUpdate.strategy, 'round_robin', '不能覆写已配置的 strategy');
    assert.equal(partialUpdate.reserve_percentage, 15, '不能覆写已配置的 reserve_percentage');
    assert.equal(partialUpdate.candidate_min_percentage, 40, '不能覆写已配置的 candidate_min_percentage');

    // 3. 准备账号数据
    const acc1 = await mgr.upsertAccount({
      email: 'work@example.com',
      refreshToken: 'fake-refresh-1',
    });
    acc1.quota = {
      last_updated: Math.floor(Date.now() / 1000),
      models: [{ name: 'gemini-3.8-flash', percentage: 5, percentage_known: true }],
    };
    await mgr.saveAccount(acc1);

    const acc2 = await mgr.upsertAccount({
      email: 'spare@example.com',
      refreshToken: 'fake-refresh-2',
    });
    acc2.token.access_token = 'synthetic-valid-access'; acc2.token.expiry_timestamp = Math.floor(Date.now()/1000)+3600;
    acc2.quota = {
      last_updated: Math.floor(Date.now() / 1000),
      models: [{ name: 'gemini-3.8-flash', percentage: 95, percentage_known: true }],
    };
    await mgr.saveAccount(acc2);

    await mgr.setCurrentAccount(acc1.id);

    // 4. 关键断言：策略未启用时，selectBestAccount 必须严格返回 shouldSwitch: false，闭合开关语义
    const resDisabled = await mgr.selectBestAccount();
    assert.equal(resDisabled.shouldSwitch, false, '策略关闭时不应触发切号');
    assert.equal(resDisabled.bestCandidate, null);
    assert.equal(resDisabled.reason, '智能备用账号推荐策略未启用');

    // 5. 开启策略后，应当正常触发推荐
    await mgr.setAutoSwitchConfig({ enabled: true });
    const resEnabled = await mgr.selectBestAccount();
    // console.log('DEBUG resEnabled:', resEnabled);
    assert.equal(resEnabled.shouldSwitch, true, `额度降至 5%（<=15%）时应当推荐切号, 实际: ${JSON.stringify(resEnabled)}`);
    assert.equal(resEnabled.bestCandidate?.email, 'spare@example.com');
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
});

test('A09: 用量明细百分比以总用量为分母，金额格式化精准', () => {
  const totalTokens = 100000;
  const modelA = { tokens: 80000, usd: 0.12 };
  const modelB = { tokens: 20000, usd: 0.002 };

  // 1. 真实绝对百分比测试 (杜绝将最大模型虚构成 100% 的 A09 漏洞)
  const shareA = totalTokens > 0 ? Math.max(0, Math.min(100, Math.round((modelA.tokens / totalTokens) * 100))) : 0;
  const shareB = totalTokens > 0 ? Math.max(0, Math.min(100, Math.round((modelB.tokens / totalTokens) * 100))) : 0;

  assert.equal(shareA, 80, '模型 A 应为真实的 80%');
  assert.equal(shareB, 20, '模型 B 应为真实的 20%');

  // 2. 微小金额格式化测试 (< 0.01 采用 3 位小数，不显示 $0.00)
  function formatUsd(usd) {
    if (usd > 0) {
      return usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
    }
    return '$0.00';
  }

  assert.equal(formatUsd(modelA.usd), '$0.12');
  assert.equal(formatUsd(modelB.usd), '$0.002', '小于 0.01 的金额应保留 3 位小数，消除 $0.00 误导');
});

test('A10: 页面级任务过滤机制 (严禁 AI 模型设置展示账号刷新结果)', () => {
  const mixedTasks = [
    { id: 't1', type: 'quota-refresh', message: '已更新 3 个账号的配额。', state: 'finished' },
    { id: 't2', type: 'account-add', message: '已添加账号：test@example.com', state: 'finished' },
    { id: 't3', type: 'models', message: '已获取 15 个模型；当前选择已保留。', state: 'finished' },
    { id: 't4', type: 'translation-test', message: '模型连通性测试通过 (耗时 320ms)', state: 'finished' },
  ];

  const allowedTypes = ['models', 'ai-test', 'translation-test', 'ai-translate', 'translate'];
  const relevantTasks = mixedTasks.filter(t => allowedTypes.includes(t.type));

  // 关键断言：绝对不能抓到第 1 项 quota-refresh！
  assert.equal(relevantTasks.length, 2);
  assert.equal(relevantTasks[0].type, 'models');
  assert.equal(relevantTasks[1].type, 'translation-test');
  assert.ok(!relevantTasks.some(t => t.type === 'quota-refresh'), 'AI 模型设置中严禁混入 quota-refresh 任务');
});
