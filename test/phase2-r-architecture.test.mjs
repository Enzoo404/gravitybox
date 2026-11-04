import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsManager } from '../dist/accounts.js';

test('A07 / R07: 推荐策略配置局部原子更新与 enabled 开关严格闭环', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-phase2-a07-'));
  try {
    const mgr = new AccountsManager(sandbox);

    // 1. 预先设置个性化策略参数（reserve = 18%, strategy = 'round_robin'）
    await mgr.setAutoSwitchConfig({
      enabled: false,
      strategy: 'round_robin',
      reserve_percentage: 18,
      candidate_min_percentage: 35,
    });

    // 2. 前端界面仅勾选开启开关（传入 { enabled: true }）
    const updated = await mgr.setAutoSwitchConfig({ enabled: true });

    // 关键断言 1：必须保持自定义的 reserve_percentage 和 strategy 不被重置为默认值
    assert.equal(updated.enabled, true, 'enabled 必须被更新为 true');
    assert.equal(updated.reserve_percentage, 18, '不得将用户的自定义 reserve_percentage 覆盖为默认值 10');
    assert.equal(updated.candidate_min_percentage, 35, '不得将用户的自定义 candidate_min_percentage 覆盖为默认值 30');
    assert.equal(updated.strategy, 'round_robin', '不得将用户的自定义 strategy 覆盖为 priority');

    // 3. 验证 selectBestAccount 严格受 enabled 开关控制
    const nowSec = Math.floor(Date.now() / 1000);
    const lowAccount = {
      id: 'acc-low',
      email: 'low@example.com',
      token: { refresh_token: 'fake', access_token: 'fake', expires_in: 3600, expiry_timestamp: nowSec + 3600, token_type: 'Bearer' },
      quota: {
        last_updated: nowSec - 60,
        is_forbidden: false,
        models: [{ name: 'gemini-2.0-flash', percentage: 5, percentage_known: true }],
      },
    };
    const richAccount = {
      id: 'acc-rich',
      email: 'rich@example.com',
      token: { refresh_token: 'fake', access_token: 'fake', expires_in: 3600, expiry_timestamp: nowSec + 3600, token_type: 'Bearer' },
      quota: {
        last_updated: nowSec - 60,
        is_forbidden: false,
        models: [{ name: 'gemini-2.0-flash', percentage: 90, percentage_known: true }],
      },
    };

    await mgr.saveAccount(lowAccount);
    await mgr.saveAccount(richAccount);
    await mgr.setCurrentAccount(lowAccount.id);

    // 当策略关闭时：
    await mgr.setAutoSwitchConfig({ enabled: false });
    const resDisabled = await mgr.selectBestAccount();
    assert.equal(resDisabled.shouldSwitch, false, '策略未启用时绝对不得触发切号推荐');
    assert.equal(resDisabled.bestCandidate, null, '策略未启用时不推荐备选账号');
    assert.match(resDisabled.reason, /未启用/);

    // 当策略开启时：
    await mgr.setAutoSwitchConfig({ enabled: true });
    const resEnabled = await mgr.selectBestAccount();
    assert.equal(resEnabled.shouldSwitch, true, '策略开启且低于保留线时必须触发推荐');
    assert.equal(resEnabled.bestCandidate?.id, richAccount.id, '必须推荐达标账号');
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
});

test('A08: 模型基准配额与每周限额约束的语义格式化算法', () => {
  function formatModelNotice(params) {
    const { name, pct, claudeWeekly, geminiWeekly, argonWeekly, countdown } = params;
    const lower = name.toLowerCase();
    const isClaude = lower.includes('claude') || lower.includes('gpt');
    const isGemini = lower.includes('gemini') && !lower.includes('argon');
    const isArgon = lower.includes('argon');

    let capNotice = '';
    if (isClaude && claudeWeekly !== undefined && claudeWeekly !== null) {
      if (claudeWeekly <= 0) capNotice = '周额度已耗尽 (0%)';
      else if (pct !== null && claudeWeekly < pct) capNotice = `受每周 ${claudeWeekly}% 约束`;
    } else if (isGemini && geminiWeekly !== undefined && geminiWeekly !== null) {
      if (geminiWeekly <= 0) capNotice = '周额度已耗尽 (0%)';
      else if (pct !== null && geminiWeekly < pct) capNotice = `受每周 ${geminiWeekly}% 约束`;
    } else if (isArgon && argonWeekly !== undefined && argonWeekly !== null) {
      if (argonWeekly <= 0) capNotice = '周额度已耗尽 (0%)';
      else if (pct !== null && argonWeekly < pct) capNotice = `受每周 ${argonWeekly}% 约束`;
    }

    if (!capNotice) return countdown;
    return countdown ? `${countdown} · ${capNotice}` : capNotice;
  }

  // 1. Claude 模型 5 小时快照为 100%，但 Claude 每周仅剩 11%：必须标出“受每周 11% 约束”
  const notice1 = formatModelNotice({
    name: 'Claude 3.5 Sonnet',
    pct: 100,
    claudeWeekly: 11,
    countdown: '3小时后重置',
  });
  assert.equal(notice1, '3小时后重置 · 受每周 11% 约束');

  // 2. Claude 周额度为 0% 时：明确提示“周额度已耗尽 (0%)”
  const notice2 = formatModelNotice({
    name: 'Claude 3.7 Sonnet',
    pct: 80,
    claudeWeekly: 0,
    countdown: '1小时后重置',
  });
  assert.equal(notice2, '1小时后重置 · 周额度已耗尽 (0%)');

  // 3. Gemini 每周额度充裕（95%），高于模型当前 5 小时快照（80%）：不显示受限提示
  const notice3 = formatModelNotice({
    name: 'Gemini 2.5 Flash',
    pct: 80,
    geminiWeekly: 95,
    countdown: '4小时后重置',
  });
  assert.equal(notice3, '4小时后重置');
});
