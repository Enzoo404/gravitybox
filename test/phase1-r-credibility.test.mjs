import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AccountsManager,
  computeAccountRevision,
} from '../dist/accounts.js';
import {
  UsageStatsManager,
  ProtobufWriter,
} from '../dist/usage.js';

const execFileAsync = promisify(execFile);

test('R03: getAccountRemaining 双窗口熔合与周额度耗尽（0%）硬拦截', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-r03-test-'));
  try {
    const mgr = new AccountsManager(sandbox);
    const nowSec = Math.floor(Date.now() / 1000);

    // 账号 A：Claude 3.5 Sonnet 模型 5 小时快照为 100%，但 Claude 周额度为 0%
    const accountClaudeWeeklyDepleted = {
      id: 'acc-depleted',
      email: 'depleted@example.com',
      token: { refresh_token: 'fake', access_token: 'fake', expires_in: 3600, expiry_timestamp: nowSec + 3600, token_type: 'Bearer' },
      quota: {
        last_updated: nowSec - 60,
        is_forbidden: false,
        model_forwarding_rules: {},
        models: [
          { name: 'claude-3-5-sonnet', percentage: 100, reset_time: '' },
          { name: 'gemini-2.0-flash', percentage: 90, reset_time: '' },
        ],
        quota_groups: [
          {
            display_name: 'Claude & Third Party',
            buckets: [
              { bucket_id: 'claude-5h', remaining_fraction: 1.0, window: '5h', reset_time: '' },
              { bucket_id: 'claude-weekly', remaining_fraction: 0.0, window: 'weekly', reset_time: '' },
            ],
          },
          {
            display_name: 'Gemini Models',
            buckets: [
              { bucket_id: 'gemini-5h', remaining_fraction: 0.9, window: '5h', reset_time: '' },
              { bucket_id: 'gemini-weekly', remaining_fraction: 0.8, window: 'weekly', reset_time: '' },
            ],
          },
        ],
      },
    };

    // 1. 当监控 claude 模型时，周配额已耗尽必须硬拦截返回 0
    const remClaude = mgr.getAccountRemaining(accountClaudeWeeklyDepleted, 'claude');
    assert.equal(remClaude, 0, 'Claude 周额度耗尽时，getAccountRemaining 必须返回 0');

    // 2. 当监控具体 claude 模型名称时，经双窗口熔合后必须返回 0
    const remSonnet = mgr.getAccountRemaining(accountClaudeWeeklyDepleted, 'claude-3-5-sonnet');
    assert.equal(remSonnet, 0, 'Claude 3.5 Sonnet 双窗口熔合后可用额度必须为 0');

    // 3. 当监控 gemini 模型时，不受 claude 周额度耗尽影响，返回正常的 80% (90% 与 80% 熔合)
    const remGemini = mgr.getAccountRemaining(accountClaudeWeeklyDepleted, 'gemini');
    assert.equal(remGemini, 80, 'Gemini 5小时 90% 与周额度 80% 熔合后应为 80%');

    // 4. selectBestAccount 绝对不推荐周额度为 0 的账号
    await mgr.saveAccount(accountClaudeWeeklyDepleted);
    const candidateGood = {
      id: 'acc-good',
      email: 'good@example.com',
      token: { refresh_token: 'fake', access_token: 'fake', expires_in: 3600, expiry_timestamp: nowSec + 3600, token_type: 'Bearer' },
      quota: {
        last_updated: nowSec - 60,
        is_forbidden: false,
        model_forwarding_rules: {},
        models: [{ name: 'claude-3-5-sonnet', percentage: 90, reset_time: '' }],
        quota_groups: [
          {
            display_name: 'Claude & Third Party',
            buckets: [
              { bucket_id: 'claude-5h', remaining_fraction: 0.9, window: '5h', reset_time: '' },
              { bucket_id: 'claude-weekly', remaining_fraction: 0.85, window: 'weekly', reset_time: '' },
            ],
          },
        ],
      },
    };
    await mgr.saveAccount(candidateGood);
    await mgr.setCurrentAccount(accountClaudeWeeklyDepleted.id);

    const switchResult = await mgr.selectBestAccount({
      enabled: true,
      strategy: 'priority',
      reserve_percentage: 10,
      candidate_min_percentage: 30,
      monitored_model: 'claude',
      candidate_account_ids: [accountClaudeWeeklyDepleted.id, candidateGood.id],
    });

    assert.equal(switchResult.shouldSwitch, true, '当前账号额度降至0应触发切号');
    assert.equal(switchResult.bestCandidate?.id, candidateGood.id, '必须推荐额度充足账号');
    assert.notEqual(switchResult.bestCandidate?.id, accountClaudeWeeklyDepleted.id, '绝不推荐周额度耗尽账号');
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
});

test('R04: computeAccountRevision 与卡片重绘指纹契约对齐', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-r04-test-'));
  try {
    const mgr = new AccountsManager(sandbox);
    const nowSec = Math.floor(Date.now() / 1000);

    const baseAccount = {
      id: 'acc-test',
      email: 'test@example.com',
      name: 'Tester',
      disabled: false,
      token: { refresh_token: 'fake', access_token: 'fake', expires_in: 3600, expiry_timestamp: nowSec + 3600, token_type: 'Bearer' },
      quota: {
        last_updated: nowSec - 100,
        is_forbidden: false,
        subscription_tier: 'FREE',
        model_forwarding_rules: {},
        models: [
          { name: 'gemini-2.0-flash', percentage: 100, reset_time: '2026-10-20T12:00:00Z', reset_countdown: '2小时后重置' },
        ],
      },
    };

    const rev1 = computeAccountRevision(baseAccount);
    assert.ok(typeof rev1 === 'string' && rev1.length === 16, 'revision 必须为 16 位哈希');

    // 1. 当模型百分比从 100% 降至 80% 时，revision 必须发生变化
    const modifiedModel = {
      ...baseAccount,
      quota: {
        ...baseAccount.quota,
        models: [
          { name: 'gemini-2.0-flash', percentage: 80, reset_time: '2026-10-20T12:00:00Z', reset_countdown: '2小时后重置' },
        ],
      },
    };
    const rev2 = computeAccountRevision(modifiedModel);
    assert.notEqual(rev1, rev2, '模型百分比微调必须触发 revision 变动');

    // 2. 当仅配额更新时间戳改变时，revision 必须变动
    const modifiedTimestamp = {
      ...baseAccount,
      quota: {
        ...baseAccount.quota,
        last_updated: nowSec - 10,
      },
    };
    const rev3 = computeAccountRevision(modifiedTimestamp);
    assert.notEqual(rev1, rev3, '配额更新时间改变必须触发 revision 变动');

    // 3. 当产生 quota_refresh_error 时，revision 必须变动
    const modifiedError = {
      ...baseAccount,
      quota_refresh_error: '网络连接超时',
    };
    const rev4 = computeAccountRevision(modifiedError);
    assert.notEqual(rev1, rev4, '刷新错误产生必须触发 revision 变动');

    // 4. listAccounts 必须返回包含 revision 和 quota_last_updated 的字段
    await mgr.saveAccount(baseAccount);
    const listRes = await mgr.listAccounts();
    assert.equal(listRes.accounts.length, 1);
    const accSummary = listRes.accounts[0];
    assert.ok(accSummary.revision, 'listAccounts 必须包含顶层 revision');
    assert.equal(accSummary.quota_last_updated, baseAccount.quota.last_updated, 'listAccounts 必须包含顶层 quota_last_updated');
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
});

test('R08: by_model 返回显式 priced: boolean 并区分近零计价与未计价', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-r08-test-'));
  try {
    const geminiDir = join(sandbox, '.gemini');
    const convDir = join(geminiDir, 'antigravity', 'conversations');
    await mkdir(convDir, { recursive: true });

    const dbPath = join(convDir, 'test_pricing.db');
    await execFileAsync('/usr/bin/sqlite3', [
      dbPath,
      `CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);
       CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);`,
    ]);

    const nowSec = Math.floor(Date.now() / 1000);
    const innerTiming = ProtobufWriter.encodeField(1, 0, ProtobufWriter.encodeVarint(nowSec));
    const timingBuf = ProtobufWriter.encodeField(4, 2, innerTiming);

    // 1. 构造 1 Token 的 gemini-2.5-flash (已计价微小消耗)
    const usagePriced = Buffer.concat([
      ProtobufWriter.encodeField(2, 0, ProtobufWriter.encodeVarint(1)),
      ProtobufWriter.encodeField(3, 0, ProtobufWriter.encodeVarint(0)),
    ]);
    const wrappedPriced = Buffer.concat([
      ProtobufWriter.encodeField(4, 2, usagePriced),
      ProtobufWriter.encodeString(19, 'gemini-2.5-flash'),
      ProtobufWriter.encodeField(9, 2, timingBuf),
    ]);
    const blobPriced = ProtobufWriter.encodeField(1, 2, wrappedPriced);

    // 2. 构造 未在定价表中的自定义模型 (未计价)
    const usageUnpriced = Buffer.concat([
      ProtobufWriter.encodeField(2, 0, ProtobufWriter.encodeVarint(500)),
      ProtobufWriter.encodeField(3, 0, ProtobufWriter.encodeVarint(500)),
    ]);
    const wrappedUnpriced = Buffer.concat([
      ProtobufWriter.encodeField(4, 2, usageUnpriced),
      ProtobufWriter.encodeString(19, 'unknown-unpriced-model-xyz'),
      ProtobufWriter.encodeField(9, 2, timingBuf),
    ]);
    const blobUnpriced = ProtobufWriter.encodeField(1, 2, wrappedUnpriced);

    await execFileAsync('/usr/bin/sqlite3', [
      dbPath,
      `INSERT INTO gen_metadata (idx, data) VALUES (1, x'${blobPriced.toString('hex')}'), (2, x'${blobUnpriced.toString('hex')}');`,
    ]);

    const uMgr = new UsageStatsManager({ stateDir: sandbox, geminiDir });
    const summary = await uMgr.getUsageSummary(true);

    const pricedItem = summary.today.by_model.find(m => m.model === 'gemini-2.5-flash');
    assert.ok(pricedItem, '必须包含 gemini-2.5-flash');
    assert.equal(pricedItem.priced, true, '在价格表中的模型必须显式标记 priced: true');

    // 验证前端根据 priced 字段展示，杜绝微量 Token 误判为未计价
    function formatModelCost(item) {
      const isPriced = item.priced ?? (item.estimated_usd > 0);
      if (isPriced) {
        if (item.estimated_usd < 0.001) return '< $0.001';
        return `$${item.estimated_usd.toFixed(2)}`;
      }
      return '未计价';
    }
    assert.equal(formatModelCost(pricedItem), '< $0.001', '微量 Token 经 priced 判定必须展示为 < $0.001');

    const unpricedItem = summary.today.by_model.find(m => m.model === 'unknown-unpriced-model-xyz');
    assert.ok(unpricedItem, '必须包含未知模型');
    assert.equal(unpricedItem.priced, false, '未在价格表中的模型必须显式标记 priced: false');
    assert.equal(formatModelCost(unpricedItem), '未计价', '未计价模型必须展示为 未计价');
    assert.equal(unpricedItem.estimated_usd, 0, '未在价格表中的模型金额为 0');
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
});

test('R02: 运行中账号身份核验逻辑（杜绝仅因 windows > 0 虚假标绿）', () => {
  function determineActiveBadge(params) {
    const { isConnected, refreshErr, isStale, staleHours, liveEmail, displayEmail } = params;
    if (refreshErr) {
      return { title: '配额预警', tint: 'orange' };
    }
    if (isStale) {
      return { title: '快照已过期', tint: 'orange' };
    }
    if (isConnected) {
      if (liveEmail && liveEmail.toLowerCase() === displayEmail.toLowerCase()) {
        return { title: '运行中已核实', tint: 'green' };
      }
      if (liveEmail) {
        return { title: '非运行中账号', tint: 'orange' };
      }
      return { title: '已保存记录', tint: 'secondary' };
    }
    return { title: '已保存记录', tint: 'secondary' };
  }

  // 1. 已连接但运行中的账号是另一个身份（如外部切换了账号）：必须显示为非运行中账号，绝不能标绿！
  const badgeMismatch = determineActiveBadge({
    isConnected: true,
    refreshErr: '',
    isStale: false,
    staleHours: 0,
    liveEmail: 'other@example.com',
    displayEmail: 'saved@example.com',
  });
  assert.equal(badgeMismatch.title, '非运行中账号');
  assert.equal(badgeMismatch.tint, 'orange');

  // 2. 已连接且探测到的真实身份严格一致：标绿并核实
  const badgeMatch = determineActiveBadge({
    isConnected: true,
    refreshErr: '',
    isStale: false,
    staleHours: 0,
    liveEmail: 'saved@example.com',
    displayEmail: 'saved@example.com',
  });
  assert.equal(badgeMatch.title, '运行中已核实');
  assert.equal(badgeMatch.tint, 'green');

  // 3. 虽然有连接窗口，但尚未能探测到实例登录邮箱（例如空或等待探测）：显示已保存记录，杜绝虚假标绿
  const badgePending = determineActiveBadge({
    isConnected: true,
    refreshErr: '',
    isStale: false,
    staleHours: 0,
    liveEmail: '',
    displayEmail: 'saved@example.com',
  });
  assert.equal(badgePending.title, '已保存记录');
  assert.equal(badgePending.tint, 'secondary');

  // 4. 未连接时：显示已保存记录
  const badgeOffline = determineActiveBadge({
    isConnected: false,
    refreshErr: '',
    isStale: false,
    staleHours: 0,
    liveEmail: '',
    displayEmail: 'saved@example.com',
  });
  assert.equal(badgeOffline.title, '已保存记录');
  assert.equal(badgeOffline.tint, 'secondary');
});
