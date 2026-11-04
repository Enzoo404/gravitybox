import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsManager, computeAccountRevision } from '../dist/accounts.js';

test('N03 · P1: 未知配额 (percentage_known=false 或缺值) 严格返回 null，绝不推荐未知账号', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'gb-test-n03-'));
  try {
    const mgr = new AccountsManager(tempDir);
    const unknownAccount = {
      id: 'acc-unknown',
      email: 'unknown@example.com',
      disabled: false,
      validation_blocked: false,
      protected_models: [],
      created_at: Date.now(),
      last_used: 0,
      token: { access_token: 'tok', refresh_token: 'ref', expiry_date: Date.now() + 3600000 },
      quota: {
        last_updated: Math.floor(Date.now() / 1000),
        subscription_tier: 'PRO',
        models: [
          { name: 'gemini-3.8-flash-high', percentage: 100, percentage_known: false, quota_bucket_id: 'b1' },
          { name: 'claude-sonnet-5-5-high', percentage: 100, percentage_known: false, quota_bucket_id: 'b2' },
        ],
        quota_groups: [
          {
            display_name: 'Gemini',
            buckets: [{ bucket_id: 'b1', window: '5h', remaining_fraction: 1.0, remaining_fraction_known: false }]
          },
          {
            display_name: 'Claude',
            buckets: [{ bucket_id: 'b2', window: 'weekly', remaining_fraction: 1.0, remaining_fraction_known: false }]
          }
        ]
      }
    };

    // 1. 各维度查询未知账号均返回 null，绝不再误返回 100
    assert.equal(mgr.getAccountRemaining(unknownAccount, 'all'), null, 'all 下必须返回 null');
    assert.equal(mgr.getAccountRemaining(unknownAccount, 'gemini'), null, 'gemini 下必须返回 null (此前漏洞会误返回 100)');
    assert.equal(mgr.getAccountRemaining(unknownAccount, 'claude'), null, 'claude 下必须返回 null');
    assert.equal(mgr.getAccountRemaining(unknownAccount, '3p'), null, '3p 下必须返回 null');
    assert.equal(mgr.getAccountRemaining(unknownAccount, 'gemini-3.8-flash-high'), null, '具体模型下必须返回 null');

    // 2. 模拟真实切号推荐，配置启用智能推荐
    const activeAccount = {
      ...unknownAccount,
      id: 'acc-active',
      email: 'active@example.com',
      quota: {
        last_updated: Math.floor(Date.now() / 1000),
        subscription_tier: 'PRO',
        models: [{ name: 'gemini-3.8-flash-high', percentage: 5, percentage_known: true }],
        quota_groups: [{ display_name: 'Gemini', buckets: [{ bucket_id: 'b1', window: '5h', remaining_fraction: 0.05, remaining_fraction_known: true }] }]
      }
    };
    await mgr.upsertAccount(activeAccount);
    await mgr.setCurrentAccount('acc-active');
    await mgr.upsertAccount(unknownAccount);

    await mgr.setAutoSwitchConfig({
      enabled: true,
      strategy: 'priority',
      monitored_model: 'gemini',
      reserve_percentage: 10,
      candidate_min_percentage: 30,
      candidate_account_ids: ['acc-unknown']
    });

    const recommendation = await mgr.selectBestAccount();
    // 3. 验证未知账号绝不能成为推荐候选
    assert.equal(recommendation.bestCandidate, null, '未知额度的备选账号绝对不能被推荐');
    assert.doesNotMatch(recommendation.reason, /保留红线/, '推荐理由必须使用清晰自然语言，不得出现「保留红线」等生硬术语');
    assert.match(recommendation.reason, /没有额度充足且可用的账号|配额未知/, '理由应清晰解释无合适备用账号');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('N04 · P1: Argon 周额度独立归属，普通 Gemini 与 Argon 互不污染且硬拦截', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'gb-test-n04-'));
  try {
    const mgr = new AccountsManager(tempDir);

    // 场景 A: 普通 Gemini 周额度 100%，Argon 周额度 0% (已耗尽)
    const argonDepletedAccount = {
      id: 'acc-argon-0',
      email: 'argon0@example.com',
      disabled: false,
      validation_blocked: false,
      protected_models: [],
      created_at: Date.now(),
      last_used: 0,
      token: { access_token: 'tok', refresh_token: 'ref', expiry_date: Date.now() + 3600000 },
      quota: {
        last_updated: Math.floor(Date.now() / 1000),
        subscription_tier: 'PRO',
        models: [
          { name: 'gemini-3.8-flash-high', percentage: 100, percentage_known: true },
          { name: 'gemini-4-argon-high', percentage: 100, percentage_known: true },
        ],
        quota_groups: [
          {
            display_name: 'Gemini',
            buckets: [
              { bucket_id: 'b-g5h', window: '5h', remaining_fraction: 1.0, remaining_fraction_known: true },
              { bucket_id: 'b-gwk', window: 'weekly', remaining_fraction: 1.0, remaining_fraction_known: true },
            ]
          },
          {
            display_name: 'Gemini 4 Argon',
            buckets: [
              { bucket_id: 'b-awk', window: 'weekly', remaining_fraction: 0.0, remaining_fraction_known: true },
            ]
          }
        ]
      }
    };

    // 校验普通 Gemini 仍充裕，而 Argon 必须返回 0
    assert.equal(mgr.getAccountRemaining(argonDepletedAccount, 'gemini'), 100, '普通 Gemini 必须保持 100%');
    assert.equal(mgr.getAccountRemaining(argonDepletedAccount, 'argon'), 0, 'Argon 周额度为 0 时必须返回 0 (此前漏洞会误返回 100)');
    assert.equal(mgr.getAccountRemaining(argonDepletedAccount, 'gemini-4-argon-high'), 0, '具体 Argon 模型周额度为 0 时必须返回 0');

    // 场景 B 反向验证: 普通 Gemini 0%，Argon 100%
    const geminiDepletedAccount = {
      ...argonDepletedAccount,
      id: 'acc-gemini-0',
      email: 'gemini0@example.com',
      quota: {
        last_updated: Math.floor(Date.now() / 1000),
        subscription_tier: 'PRO',
        models: [
          { name: 'gemini-3.8-flash-high', percentage: 100, percentage_known: true },
          { name: 'gemini-4-argon-high', percentage: 100, percentage_known: true },
        ],
        quota_groups: [
          {
            display_name: 'Gemini',
            buckets: [
              { bucket_id: 'b-g5h', window: '5h', remaining_fraction: 1.0, remaining_fraction_known: true },
              { bucket_id: 'b-gwk', window: 'weekly', remaining_fraction: 0.0, remaining_fraction_known: true },
            ]
          },
          {
            display_name: 'Gemini 4 Argon',
            buckets: [
              { bucket_id: 'b-awk', window: 'weekly', remaining_fraction: 1.0, remaining_fraction_known: true },
            ]
          }
        ]
      }
    };

    assert.equal(mgr.getAccountRemaining(geminiDepletedAccount, 'gemini'), 0, '普通 Gemini 周额度为 0 时返回 0');
    assert.equal(mgr.getAccountRemaining(geminiDepletedAccount, 'argon'), 100, 'Argon 周额度 100% 时不受普通 Gemini 误伤');
    assert.equal(mgr.getAccountRemaining(geminiDepletedAccount, 'gemini-4-argon-high'), 100, '具体 Argon 模型返回 100%');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('N13 · P2: 账号修订指纹 (computeAccountRevision) 纳入已知状态标记，倒计时变更可感知', () => {
  const baseAccount = {
    id: 'acc-rev-1',
    email: 'rev@example.com',
    name: '测试用户',
    custom_label: '主力',
    disabled: false,
    quota: {
      last_updated: 1729000000,
      subscription_tier: 'PRO',
      source: 'live',
      models: [
        { name: 'gemini-3.8-flash', percentage: 80, percentage_known: true, reset_time: '2026-10-20T16:00:00Z', reset_countdown: '3小时后重置' }
      ],
      quota_groups: [
        {
          display_name: 'Gemini',
          buckets: [
            { bucket_id: 'b1', remaining_fraction: 0.8, remaining_fraction_known: true, reset_time: '2026-10-20T16:00:00Z' }
          ]
        }
      ]
    }
  };

  const rev1 = computeAccountRevision(baseAccount);

  // 1. 仅改变 model.percentage_known: true -> false
  const accountUnknownModel = JSON.parse(JSON.stringify(baseAccount));
  accountUnknownModel.quota.models[0].percentage_known = false;
  const rev2 = computeAccountRevision(accountUnknownModel);
  assert.notEqual(rev1, rev2, 'percentage_known 改变必须产生不同的 revision 指纹');

  // 2. 仅改变 bucket.remaining_fraction_known: true -> false
  const accountUnknownBucket = JSON.parse(JSON.stringify(baseAccount));
  accountUnknownBucket.quota.quota_groups[0].buckets[0].remaining_fraction_known = false;
  const rev3 = computeAccountRevision(accountUnknownBucket);
  assert.notEqual(rev1, rev3, 'remaining_fraction_known 改变必须产生不同的 revision 指纹');

  // 3. 倒计时推进更新 (reset_countdown)
  const accountAdvancedCountdown = JSON.parse(JSON.stringify(baseAccount));
  accountAdvancedCountdown.quota.models[0].reset_countdown = '2小时 59分后重置';
  const rev4 = computeAccountRevision(accountAdvancedCountdown);
  assert.notEqual(rev1, rev4, '倒计时推进更新必须能触发修订感知');
});
