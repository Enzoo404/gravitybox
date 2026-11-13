import test from "node:test";
import { describe as describeContractGroup } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountsManager, formatResetCountdown, refreshResetDescription, accountCredentialReadiness, generateDeviceProfile, MockKeychainAdapter, syncAccountToKeychain } from "../dist/accounts.js";
import { buildDashboardAggregate } from "../dist/main.js";
import { normalizeIndependentArgonQuota } from "../dist/quota.js";

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("配额与推荐 · audit-p1-backend", { concurrency: false }, async () => {

const BUCKET_RESET_MS = 4 * 60 * 60 * 1000 + 19 * 60 * 1000; // 4h19m

function seededQuota(nowMs, { percentage = 80, gemini = true, claude = false } = {}) {
  const reset = new Date(nowMs + BUCKET_RESET_MS).toISOString();
  const groups = [];
  const bucket = (id, window) => ({ bucket_id: id, window, remaining_fraction: percentage / 100, remaining_fraction_known: true, reset_time: reset });
  if (gemini) groups.push({ display_name: 'Gemini', buckets: [bucket('gemini-5h', '5h'), bucket('gemini-week', 'week')] });
  if (claude) groups.push({ display_name: 'Claude/GPT', buckets: [bucket('claude-week', 'week')] });
  return {
    models: [
      { name: 'gemini-3.8-flash', percentage, percentage_known: true, reset_time: reset },
      ...(claude ? [{ name: 'claude-opus-4-6', percentage, percentage_known: true, reset_time: reset }] : []),
    ],
    quota_groups: groups,
    last_updated: Math.floor(nowMs / 1000),
    is_forbidden: false,
    model_forwarding_rules: {},
    subscription_tier: 'PRO',
    source: 'live',
  };
}

async function makeManager() {
  const dir = await mkdtemp(join(tmpdir(), 'gb-audit-p1-'));
  await mkdir(join(dir, '词典'), { recursive: true });
  return { dir, mgr: new AccountsManager(dir) };
}

// ---------- B01：沿用旧分组不冒充新采样 ----------

test('B01: carried 分组只记 stale_groups，顶层 last_updated 不再刷成 now，且标明部分刷新', async () => {
  const { dir, mgr } = await makeManager();
  const previousProbe = process.env.GRAVITYBOX_PROBE_LS;
  process.env.GRAVITYBOX_PROBE_LS = 'false';
  try {
    const nowMs = Date.now();
    const oldObserved = Math.floor(nowMs / 1000) - 3600; // 1 小时前的 Claude 快照
    const account = await mgr.upsertAccount({
      email: 'carried@example.test', refreshToken: 'tok-refresh', accessToken: 'tok-access', expiresIn: 3600,
    });
    const oldQuota = seededQuota(nowMs, { percentage: 60, gemini: true, claude: true });
    oldQuota.last_updated = oldObserved;
    oldQuota.quota_groups = oldQuota.quota_groups.map(group => ({
      ...group,
      observed_at: oldObserved,
      observedAt: oldObserved,
      last_updated: oldObserved,
      buckets: group.buckets.map(bucket => ({ ...bucket, observed_at: oldObserved, observedAt: oldObserved, last_updated: oldObserved })),
    }));
    account.quota = oldQuota;
    await mgr.saveAccount(account);

    const freshReset = new Date(nowMs + BUCKET_RESET_MS).toISOString();
    const bucket = (id, window, p) => ({ bucketId: id, window, remainingFraction: p, resetTime: freshReset });
    // 本轮只返回 Gemini（Claude 未返回 → 必须沿用并计入 stale_groups）。
    const fakeFetch = async value => {
      const url = String(value);
      const body = url.includes('loadCodeAssist')
        ? {}
        : url.includes('fetchAvailableModels')
        ? { models: { 'gemini-3.8-flash': { quotaInfo: { remainingFraction: 0.8 } } } }
        : { groups: [{ displayName: 'Gemini', buckets: [bucket('gemini-5h', '5h', 0.8), bucket('gemini-week', 'week', 0.7)] }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const refreshed = await mgr.refreshQuota(account.id, fakeFetch);
    const quota = refreshed.quota;
    assert.ok(Array.isArray(quota.stale_groups) && quota.stale_groups.length >= 1, '必须产生 stale_groups');
    const staleClaude = quota.stale_groups.find(item => /claude/i.test(item.name));
    assert.ok(staleClaude, '未返回的 Claude 分组必须列入 stale_groups');
    assert.equal(staleClaude.observed_at <= oldObserved, true, 'stale_groups 必须携带最后真实采样时间');
    assert.equal(quota.last_updated <= oldObserved, true, '顶层 last_updated 不得刷成 now');
    assert.equal(quota.last_updated >= oldObserved - 5, true, '顶层 last_updated 应取最旧分组观察时间');
    assert.match(refreshed.quota_refresh_error, /Claude/);
    assert.equal(quota.refresh_state.complete, false, '沿用旧值必须明确标为部分刷新');
    const oldClaude = quota.quota_groups.find(group => /claude/i.test(group.display_name));
    assert.equal(oldClaude.buckets[0].stale, true);
    assert.equal(oldClaude.buckets[0].source, 'carried');
    const geminiGroup = quota.quota_groups.find(group => /gemini/i.test(group.display_name) && !/argon/i.test(group.display_name));
    assert.ok(geminiGroup && geminiGroup.observed_at > oldObserved, '本轮成功返回的 Gemini 分组应更新观察时间');
  } finally {
    if (previousProbe === undefined) delete process.env.GRAVITYBOX_PROBE_LS; else process.env.GRAVITYBOX_PROBE_LS = previousProbe;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('B01: 真正缺 Gemini 时仍保留明确错误，且 stale_groups 解释沿用数据', async () => {
  const { dir, mgr } = await makeManager();
  const previousProbe = process.env.GRAVITYBOX_PROBE_LS;
  process.env.GRAVITYBOX_PROBE_LS = 'false';
  try {
    const nowMs = Date.now();
    const account = await mgr.upsertAccount({ email: 'gemini-missing@example.test', refreshToken: 'r', accessToken: 'a', expiresIn: 3600 });
    account.quota = seededQuota(nowMs, { percentage: 60, gemini: true, claude: false });
    await mgr.saveAccount(account);
    const fakeFetch = async () => new Response(JSON.stringify({ models: { 'claude-opus-4-6': { quotaInfo: { remainingFraction: 0.6 } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    // fetchAvailableModels 返回模型但没有分组；quota summary 只返回 Claude 分组。
    const fakeFetch2 = async value => {
      const url = String(value);
      const body = url.includes('loadCodeAssist')
        ? {}
        : url.includes('fetchAvailableModels')
        ? { models: { 'claude-opus-4-6': { quotaInfo: { remainingFraction: 0.6 } } } }
        : { groups: [{ displayName: 'Claude/GPT', buckets: [{ bucketId: 'claude-week', window: 'week', remainingFraction: 0.6, resetTime: new Date(nowMs + BUCKET_RESET_MS).toISOString() }] }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const refreshed = await mgr.refreshQuota(account.id, fakeFetch2);
    assert.match(String(refreshed.quota_refresh_error), /Gemini/i, '真正缺失 Gemini 周期仍须明确报错');
    assert.ok(refreshed.quota.stale_groups?.some(item => /gemini/i.test(item.name)), '缺失的 Gemini 分组须同时列入 stale_groups');
    void fakeFetch;
  } finally {
    if (previousProbe === undefined) delete process.env.GRAVITYBOX_PROBE_LS; else process.env.GRAVITYBOX_PROBE_LS = previousProbe;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------- B05：同一载荷倒计时来自同一参考时刻 ----------

test('B05: 顶层/模型/分组/英文描述倒计时由 reset_time 同参考时刻现算', async () => {
  const { dir, mgr } = await makeManager();
  try {
    const nowMs = Date.parse('2026-10-21T19:30:28Z');
    const resetTime = new Date(nowMs + BUCKET_RESET_MS).toISOString();
    const description = 'You have used some of your 5-hour limit, it will fully refresh in 4 hours, 29 minutes.';
    const account = {
      quota: {
        models: [{ name: 'gemini-3.8-flash', percentage: 73, percentage_known: true, reset_time: resetTime }],
        quota_groups: [{
          display_name: 'Gemini',
          buckets: [{ bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 0.73, remaining_fraction_known: true, reset_time: resetTime, description }],
        }],
        last_updated: Math.floor(nowMs / 1000),
        is_forbidden: false,
        model_forwarding_rules: {},
        subscription_tier: 'PRO',
      },
    };
    const overview = mgr.getAccountQuotaOverview(account, { nowMs });
    assert.equal(overview.resetCountdown, '4小时 19分后重置');
    assert.equal(overview.geminiFiveHourResetCountdown, '4小时 19分后重置');
    assert.equal(overview.models[0].reset_countdown, '4小时 19分后重置');
    assert.equal(overview.quotaGroups[0].buckets[0].reset_countdown, '4小时 19分后重置');
    assert.match(String(overview.quotaGroups[0].buckets[0].description), /in 4 hours, 19 minutes/);
    assert.doesNotMatch(String(overview.quotaGroups[0].buckets[0].description), /29 minutes/);
    assert.deepEqual(overview.staleGroups, []);

    // 同一 reset_time 在不同参考时刻必须给出不同值：证明倒计时不依赖真实 Date.now()。
    assert.equal(formatResetCountdown(resetTime, nowMs), '4小时 19分后重置');
    assert.equal(formatResetCountdown(resetTime, nowMs + 60 * 60 * 1000), '3小时 19分后重置');
    assert.equal(refreshResetDescription(description, resetTime, nowMs), description.replace('4 hours, 29 minutes', '4 hours, 19 minutes'));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("配额与推荐 · audit-p2-accounts", { concurrency: false }, async () => {
process.env.GRAVITYBOX_PROBE_LS = 'false';

async function sandbox(prefix = 'gb-p2-accounts-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, '词典'), { recursive: true });
  return dir;
}

// ---------- B03 Argon 保留 / bucket 未知 ----------

test('B03: fuseQuota 保留 Argon 模型，overview 回退可命中 Argon 周额度', async () => {
  const dir = await sandbox('gb-p2-argon-');
  try {
    const mgr = new AccountsManager(dir);
    const reset = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
    const fused = mgr.fuseQuota({
      models: {
        'argon-orion-1': { quotaInfo: { remainingFraction: 0.4, resetTime: reset } },
        'gemini-4-argon': { quotaInfo: { remainingFraction: 0.5, resetTime: reset } },
        'gemini-3.8-flash': { quotaInfo: { remainingFraction: 0.8, resetTime: reset } },
      },
    }, {
      groups: [{ displayName: 'Argon', buckets: [{ bucketId: 'argon-week', window: 'week', remainingFraction: 0.2, resetTime: reset }] }],
    });
    const names = fused.models.map(model => model.name);
    assert.ok(names.includes('argon-orion-1'), 'Argon 模型不得再被过滤丢弃');
    assert.ok(names.includes('gemini-4-argon'), '包含 argon 的模型名不得被丢弃');
    const argonModel = fused.models.find(model => model.name === 'argon-orion-1');
    assert.equal(argonModel.percentage, 20, 'Argon 分组真实周额度应熔合到模型');

    const overview = mgr.getAccountQuotaOverview({ quota: fused }, { nowMs: Date.now() });
    assert.equal(overview.argonWeeklyRemaining, 20, 'overview 应能命中 Argon 周额度');
    assert.deepEqual(overview.staleGroups, []);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('B03: bucket/model 缺剩余额度时显式记为未知，不冒充 0% 或静默消失', async () => {
  const dir = await sandbox('gb-p2-unknown-');
  try {
    const mgr = new AccountsManager(dir);
    const fused = mgr.fuseQuota({
      models: {
        'gemini-4-argon': { quotaInfo: {} }, // 缺 remainingFraction
      },
    }, {
      groups: [{ displayName: 'Argon', buckets: [{ bucketId: 'argon-week', window: 'week' }] }], // 缺 remainingFraction
    });
    const bucket = fused.quota_groups[0].buckets[0];
    assert.equal(bucket.remaining_fraction_known, false, '缺值 bucket 必须显式 known=false');
    assert.equal(bucket.remaining_fraction, 0, '内部数值归零但不得被当作已知 0%');
    const argonModel = fused.models.find(model => model.name === 'gemini-4-argon');
    assert.equal(argonModel.percentage_known, false, '缺值模型必须显式 unknown，而不是已知 0%');

    const overview = mgr.getAccountQuotaOverview({ quota: fused }, { nowMs: Date.now() });
    assert.equal(overview.argonWeeklyRemaining, null, '未知 Argon 额度必须保持 null，不能兜底成 0/100');
    assert.ok(overview.unknownBuckets.some(item => item.group === 'Argon' && item.bucket === 'argon-week'), '未知桶必须显式列出供界面区分“无数据”和“0%”');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("配额与推荐 · cleanup-contracts", { concurrency: false }, async () => {
test('stale bucket samples do not change the group-based staleHours contract', () => {
  const nowMs = Date.parse('2030-01-01T00:00:00Z');
  const now = nowMs / 1000;
  const manager = new AccountsManager('/nonexistent-gravitybox-fixture');
  const result = manager.getAccountQuotaOverview({ quota: {
    models: [], last_updated: now, quota_groups: [{
      display_name: 'Gemini', observed_at: now, buckets: [{
        bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.7,
        observed_at: now - 7200, reset_time: '2030-01-02T00:00:00Z',
      }],
    }],
  } }, { nowMs });
  assert.equal(result.isStale, true);
  assert.equal(result.staleHours, 0);
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("配额与推荐 · optimization-20261022", { concurrency: false }, async () => {

const fixture=async fn=>{const dir=await mkdtemp(join(tmpdir(),'gb-opt-'));try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}};

test('有效额度在 all/家族/具体模型一致；禁用 Argon 不借其他变体通过，凭据状态独立',()=>fixture(async dir=>{
 const manager=new AccountsManager(dir),now=Math.floor(Date.now()/1000);const account=await manager.upsertAccount({email:'synthetic@example.com',refreshToken:'synthetic-refresh',accessToken:'synthetic-access',expiresIn:3600});
 account.quota={last_updated:now,models:[{name:'gemini-2.5-flash',percentage:83,percentage_known:true,observed_at:now}]};
 for(const target of ['all','gemini','gemini-2.5-flash'])assert.equal(manager.getAccountRemaining(account,target),83,target);
 account.quota=manager.fuseQuota({models:{'gemini-4-argon-high':{disabled:false,quotaInfo:{remainingFraction:0.8}},'gemini-4-argon-low':{disabled:true,quotaInfo:{remainingFraction:1}}}},{groups:[]});
 assert.equal(manager.getAccountRemaining(account,'gemini-4-argon-low'),null);assert.equal(accountCredentialReadiness(account).state,'ready');account.token.expiry_timestamp=now-1;assert.equal(accountCredentialReadiness(account).state,'needs_refresh');account.quota_refresh_error='invalid_grant';assert.equal(accountCredentialReadiness(account).state,'needs_authorization');
}));
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("配额与推荐 · optimization-20261023", { concurrency: false }, async () => {
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gb-optimization-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('仅有每周分组桶时，模型独立额度及重置时间不推断为 5 小时窗口', async t => {
  const dir=await fixture(t), manager=new AccountsManager(dir);
  for(const hours of [2,24,7*24]) {
    const quota=manager.fuseQuota({models:{'gemini-test':{quotaInfo:{remainingFraction:.91,resetTime:new Date(Date.now()+hours*3600000).toISOString()}}}},{groups:[{displayName:'Gemini Models',buckets:[{window:'weekly',remainingFraction:.33,resetTime:new Date(Date.now()+7*86400000).toISOString()}]}]});
    const view=manager.getAccountQuotaOverview({quota});
    assert.equal(view.familyWindows.gemini.fiveHour,null);
    assert.equal(view.geminiFiveHourRemaining,null);
    assert.equal(view.geminiWeeklyRemaining,33);
    assert.equal(view.models.find(model=>model.name==='gemini-test').own_percentage,91);
    assert.equal(view.familyModelQuota.gemini.remaining,0.91);
  }
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("配额与推荐 · phase1-credibility", { concurrency: false }, async () => {

test('A01: formatResetCountdown 与过期时效判定 (杜绝过期时间误报即将重置)', async () => {
  // 1. 过去的时间戳必须返回 '重置时间已过'
  assert.equal(formatResetCountdown(Date.now() - 1000), '重置时间已过');
  assert.equal(formatResetCountdown(Date.now() - 3600 * 1000), '重置时间已过');
  assert.equal(formatResetCountdown(Date.now() - 24 * 3600 * 1000), '重置时间已过');

  // 2. 将来 30 秒内返回 '即将重置'
  assert.equal(formatResetCountdown(Date.now() + 30000), '即将重置');

  // 3. 将来 2 小时后返回小时倒计时
  const twoHoursLater = new Date(Date.now() + 2 * 3600 * 1000 + 10 * 60 * 1000).toISOString();
  assert.match(formatResetCountdown(twoHoursLater), /小时.*分后重置/);

  // 4. getAccountQuotaOverview 判定过期快照
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-a01-'));
  try {
    const mgr = new AccountsManager(sandbox);
    const staleAccount = {
      id: 'acc-stale',
      email: 'stale@example.com',
      quota: {
        last_updated: Math.floor(Date.now() / 1000) - 13 * 3600, // 13 小时前
        quota_groups: [
          {
            display_name: 'Gemini',
            buckets: [{ bucket_id: 'gemini-5h', remaining_fraction: 0.8, reset_time: twoHoursLater }],
          },
        ],
      },
    };
    const overview = mgr.getAccountQuotaOverview(staleAccount);
    assert.equal(overview.isStale, true);
    assert.ok(overview.staleHours >= 13);

    const freshAccount = {
      id: 'acc-fresh',
      email: 'fresh@example.com',
      quota: {
        last_updated: Math.floor(Date.now() / 1000) - 300, // 5 分钟前
      },
    };
    const freshOverview = mgr.getAccountQuotaOverview(freshAccount);
    assert.equal(freshOverview.isStale, false);
    assert.equal(freshOverview.staleHours, 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("配额与推荐 · phase1-r-credibility", { concurrency: false }, async () => {

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
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("配额与推荐 · phase2-audit-verification", { concurrency: false }, async () => {
test('阶段2验证 - B02: 残缺配额不覆盖已有 Gemini 双周期且明确警告', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-test-b02-'));
  const mgr = new AccountsManager(root);
  const a = await mgr.upsertAccount({
    email: 'b02@example.test',
    refreshToken: 'tok-refresh',
    accessToken: 'tok-access',
    expiresIn: 3600
  });

  const future = new Date(Date.now() + 3600000).toISOString();
  const bucket = (id, window, p) => ({ bucketId: id, window, remainingFraction: p, resetTime: future });

  a.quota = mgr.fuseQuota(
    { models: { 'gemini-2.5-pro': { quotaInfo: { remainingFraction: 0.5 } } } },
    { groups: [{ displayName: 'Gemini', buckets: [bucket('5h', '5h', 0.5), bucket('week', 'week', 0.3)] }] }
  );
  await mgr.saveAccount(a);
  mgr.probeLiveLanguageServer = async () => null;

  // 模拟接口只返回 Claude 周限额，缺少 Gemini
  const fakeFetch = async url => {
    const u = String(url);
    const body = u.includes('loadCodeAssist')
      ? {}
      : u.includes('fetchAvailableModels')
      ? { models: { 'gemini-2.5-pro': { quotaInfo: { remainingFraction: 0.8 } } } }
      : { groups: [{ displayName: 'Claude/GPT', buckets: [bucket('claude-week', 'week', 0.7)] }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const refreshed = await mgr.refreshQuota(a.id, fakeFetch);
  const overview = mgr.getAccountQuotaOverview(refreshed);

  assert.equal(overview.geminiFiveHourRemaining, null, '旧 5 小时值不得冒充本轮数据');
  assert.equal(overview.familyWindows.gemini.fiveHour.remaining, .5);
  assert.equal(overview.familyWindows.gemini.fiveHour.stale, true);
  assert.equal(overview.geminiWeeklyRemaining, null);
  assert.equal(overview.familyWindows.gemini.weekly.remaining, .3);
  assert.equal(overview.familyWindows.gemini.weekly.stale, true);
  assert.equal(overview.claudeWeeklyRemaining, 70, 'Claude 每周配额必须正确合并');
  assert.ok(refreshed.quota_refresh_error?.includes('Gemini'), '缺失 Gemini 周期时必须有明确警示信息');
});

test('阶段2验证 - B03: Argon 未知配额 (percentage_known=false) 保持为 null，不被兜底成 100%', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-test-b03-'));
  const mgr = new AccountsManager(root);
  const unknown = mgr.getAccountQuotaOverview({
    quota: {
      models: [{ name: 'gemini-4-argon', percentage: 100, percentage_known: false }],
      quota_groups: [],
      last_updated: Date.now() / 1000
    }
  });
  assert.equal(unknown.argonWeeklyRemaining, null, '未知的 Argon 百分比必须保持 null');
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("配额与推荐 · phase2-recommendation-contracts", { concurrency: false }, async () => {
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
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("配额与推荐 · repair-20261023", { concurrency: false }, async () => {
async function fixture(t){const d=await mkdtemp(join(tmpdir(),'gb-repair-'));t.after(async()=>{try{await rm(d,{recursive:true,force:true,maxRetries:10,retryDelay:50});}catch{}});return d;}
test('实时匹配账号的新窗口优先于保存值，明确FREE不丢失',async t=>{const d=await fixture(t),m=new AccountsManager(d),saved={id:'a',email:'synthetic@example.invalid',quota:{marker:80}};const result=await buildDashboardAggregate({listAccounts:async()=>({accounts:[saved],active_account:saved,active_account_id:'a'}),getAutoSwitchConfig:async()=>({enabled:false}),probeLiveLanguageServer:async()=>({email:saved.email,quota:{marker:25}}),getAccount:async()=>saved,getAccountQuotaOverview:a=>({fiveHourRemaining:a.quota.marker}),getUsageSummary:async()=>{throw Error('isolated')},getPricingTable:async()=>({})});assert.equal(result.accounts.fiveHourRemaining,25);assert.equal(m.getAccountQuotaOverview({quota:{models:[],last_updated:Date.now()/1000,subscription_tier:'FREE'}}).subscriptionTier,'FREE');});
test('3501只允许本轮官方项目上下文恢复，不使用旧项目或默认目录满额',async t=>{const d=await fixture(t),origin='https://daily-cloudcode-pa.googleapis.com',m=new AccountsManager(d,{providerContext:{origin,userAgent:'antigravity/2.25.0',appVersion:'2.25.0'}});m.probeLiveLanguageServer=async()=>null;const a=await m.upsertAccount({email:'synthetic@example.invalid',refreshToken:'synthetic-refresh',accessToken:'synthetic-access',expiresIn:3600});a.token.project_id='wrong-old';await m.saveAccount(a);const seen=[];const transport=async(url,options)=>{const body=JSON.parse(options.body);seen.push({url,body});if(url.endsWith(':loadCodeAssist'))return Response.json({cloudaicompanionProject:'fresh-official',currentTier:{id:'free-tier'}});if(url.endsWith(':fetchAvailableModels'))return Response.json({models:{'gemini-test':{quotaInfo:{remainingFraction:1}}}});if(url.endsWith(':retrieveUserQuota'))return Response.json({buckets:[]});if(!body.project)return Response.json({error:{status:'PERMISSION_DENIED',message:'license (#3501)'}},{status:403});assert.equal(body.project,'fresh-official');return Response.json({groups:[{displayName:'Gemini Models',buckets:[{window:'weekly',remainingFraction:.73}]}]})};const fresh=await m.refreshQuota(a.id,transport);assert.equal(m.getAccountQuotaOverview(fresh).geminiWeeklyRemaining,73);assert.equal(m.getAccountQuotaOverview(fresh).geminiFiveHourRemaining,null);assert.equal(fresh.quota.refresh_state.projectContextRecovered,true);assert.ok(seen.every(r=>r.body.project!=='wrong-old'));});
test('Argon独立计量桶可补充模型自身配额，未给周期不冒充每周',()=>{const rows=normalizeIndependentArgonQuota({buckets:[{modelId:'gemini-4-argon',remainingFraction:.42,resetTime:'2030-01-01T00:00:00Z'},{modelId:'gemini-other',remainingFraction:1}]},Date.now()/1000);assert.equal(rows.length,1);assert.equal(rows[0].own_percentage,42);assert.equal(rows[0].family_weekly,null);assert.equal(rows[0].family_5h,null);});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("配额与推荐 · v090-engines", { concurrency: false }, async () => {

test('AccountsManager: 双窗口额度熔合 (Fix #3426 真实 5h 覆盖) 与智能轮换推荐', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-quota-'));
  try {
    const mgr = new AccountsManager(sandbox);
    const reset5h = new Date(Date.now() + 3600000).toISOString();

    // 模拟 fetchAvailableModels 响应（虚高的 100%）
    const fetchAvailableModelsMock = {
      models: {
        'gemini-3.8-flash': {
          quotaInfo: { remainingFraction: 1.0, resetTime: new Date(Date.now() + 5 * 3600000).toISOString() },
          supportsImages: true,
          supportsThinking: true,
        },
        'claude-3-7-sonnet': {
          quotaInfo: { remainingFraction: 1.0, resetTime: new Date(Date.now() + 5 * 3600000).toISOString() },
        },
      },
    };

    // 模拟 retrieveUserQuotaSummary 响应（真实 5h 窗口为 0.08 即 8%）
    const quotaSummaryMock = {
      groups: [
        {
          displayName: 'Gemini',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.08, resetTime: reset5h },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.85, resetTime: new Date(Date.now() + 7 * 86400000).toISOString() },
          ],
        },
      ],
    };

    const fusedQuota = mgr.fuseQuota(fetchAvailableModelsMock, quotaSummaryMock);
    const geminiModel = fusedQuota.models.find(m => m.name === 'gemini-3.8-flash');
    assert.ok(geminiModel);
    // 关键熔合验证：模型配额必须被真实的 5h 桶 (8%) 熔合覆盖，而不是保留虚假的 100%
    assert.equal(geminiModel.percentage, 8);
    assert.equal(geminiModel.quota_bucket_id, 'gemini-5h');
    assert.equal(geminiModel.reset_time, reset5h);

    // 账号配额与轮换测试
    const accLow = await mgr.upsertAccount({
      email: 'low@test.com',
      refreshToken: '1//low',
    });
    accLow.quota = fusedQuota;
    await mgr.saveAccount(accLow);

    // 充足备选账号 (5h 配额为 80%)
    const highQuotaMock = {
      groups: [
        {
          displayName: 'Gemini',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.80, resetTime: reset5h },
          ],
        },
      ],
    };
    const accHigh = await mgr.upsertAccount({
      email: 'high@test.com',
      refreshToken: '1//high',
    });
    accHigh.token.access_token = 'synthetic-valid-access'; accHigh.token.expiry_timestamp = Math.floor(Date.now()/1000)+3600;
    accHigh.quota = mgr.fuseQuota(fetchAvailableModelsMock, highQuotaMock);
    await mgr.saveAccount(accHigh);

    await mgr.setCurrentAccount(accLow.id);

    // 自动轮换配置：红线 10%，准入门槛 30%
    await mgr.setAutoSwitchConfig({
      enabled: true,
      strategy: 'priority',
      reserve_percentage: 10,
      candidate_min_percentage: 30,
      monitored_model: 'gemini',
    });

    const recommendation = await mgr.selectBestAccount();
    assert.equal(recommendation.shouldSwitch, true);
    assert.equal(recommendation.bestCandidate?.email, 'high@test.com');

    // -----------------------------------------------------------------
    // 门禁整改验证 A: saveCurrentAccount 从沙箱 Keychain 提取当前账号
    // -----------------------------------------------------------------
    const mockKeychain = new MockKeychainAdapter();
    const mockPayload = JSON.stringify({
      token: {
        access_token: 'keychain-access-token',
        refresh_token: '1//keychain-refresh-token',
        expires_in: 3600,
        expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
        email: 'extracted-user@antigravity.test',
      },
    });
    const b64 = Buffer.from(mockPayload, 'utf8').toString('base64');
    await mockKeychain.writePassword('gemini', 'antigravity', `go-keyring-base64:${b64}`);

    const savedAcc = await mgr.saveCurrentAccount({
      keychain: mockKeychain,
      homeDir: sandbox,
      appSupportDir: sandbox,
    });
    assert.equal(savedAcc.email, 'extracted-user@antigravity.test');
    assert.equal(savedAcc.token.refresh_token, '1//keychain-refresh-token');

    const indexAfterSave = await mgr.loadIndex();
    assert.equal(indexAfterSave.current_account_id, savedAcc.id);

    // 验证从 google_accounts.json 提取真实 email 兜底 (拒绝占位符)
    await mkdir(join(sandbox, '.gemini'), { recursive: true });
    await writeFile(join(sandbox, '.gemini', 'google_accounts.json'), JSON.stringify({ active: 'fallback@google.test' }));
    const mockKeychainNoEmail = new MockKeychainAdapter();
    const mockPayloadNoEmail = JSON.stringify({
      token: {
        access_token: 'no-email-token',
        refresh_token: '1//no-email-refresh',
      },
    });
    const b64NoEmail = Buffer.from(mockPayloadNoEmail, 'utf8').toString('base64');
    await mockKeychainNoEmail.writePassword('gemini', 'antigravity', `go-keyring-base64:${b64NoEmail}`);
    await assert.rejects(mgr.saveCurrentAccount({
      keychain: mockKeychainNoEmail, homeDir: sandbox, appSupportDir: sandbox,
    }), /无法核实/);

    // -----------------------------------------------------------------
    // 门禁整改验证 B: refreshQuota 真实配额网络拉取、Token 刷新与双窗口全链路
    // -----------------------------------------------------------------
    savedAcc.token.access_token = 'pending_refresh';
    await mgr.saveAccount(savedAcc);

    const mockFetch = async (url) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 'refreshed-oauth-access-token-999',
            expires_in: 3600,
            refresh_token: '1//refreshed-keychain-refresh-token',
          }),
        };
      }
      if (u.includes('loadCodeAssist')) {
        return {
          ok: true,
          json: async () => ({
            cloudaicompanionProject: 'test-project-alpha',
            paid_tier: { id: 'TIER_PRO', name: 'Google One AI Premium' },
          }),
        };
      }
      if (u.includes('fetchAvailableModels')) {
        return {
          ok: true,
          json: async () => ({
            models: {
              'gemini-3.8-flash': {
                quotaInfo: { remainingFraction: 1.0, resetTime: reset5h },
                displayName: 'Gemini 3.8 Flash',
              },
            },
          }),
        };
      }
      if (u.includes('retrieveUserQuotaSummary')) {
        return {
          ok: true,
          json: async () => ({
            groups: [
              {
                displayName: 'Gemini',
                buckets: [
                  { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.45, resetTime: reset5h },
                  { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.78, resetTime: new Date(Date.now() + 7 * 86400000).toISOString() },
                ],
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const refreshedAcc = await mgr.refreshQuota(savedAcc.id, mockFetch);
    assert.equal(refreshedAcc.token.access_token, 'refreshed-oauth-access-token-999');
    assert.equal(refreshedAcc.quota?.subscription_tier, 'Google One AI Premium');
    assert.equal(refreshedAcc.token.project_id, 'test-project-alpha');

    const quotaOverview = mgr.getAccountQuotaOverview(refreshedAcc);
    assert.equal(quotaOverview.fiveHourRemaining, 45);
    assert.equal(quotaOverview.weeklyRemaining, 78);
    assert.equal(quotaOverview.subscriptionTier, 'Google One AI Premium');
    assert.ok(quotaOverview.resetTime);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 3. Keychain 免密写入、倒计时格式化与本地 5 桶配额架构单测
// -------------------------------------------------------------
test('Keychain 免密写入、倒计时格式化与 5 桶配额架构', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-auth-'));
  try {
    const mockKeychain = new MockKeychainAdapter();

    // 1. 验证相对重置时间倒计时格式化
    assert.equal(formatResetCountdown(''), '');
    assert.equal(formatResetCountdown(null), '');
    assert.equal(formatResetCountdown(Date.now() - 1000), '重置时间已过');
    assert.equal(formatResetCountdown(Date.now() + 30000), '即将重置');
    // 2小时后
    const twoHoursLater = new Date(Date.now() + 2 * 3600 * 1000 + 15 * 60 * 1000).toISOString();
    const cd2h = formatResetCountdown(twoHoursLater);
    assert.ok(cd2h.includes('小时') && cd2h.includes('分后重置'));
    // 5天后
    const fiveDaysLater = new Date(Date.now() + 5 * 86400 * 1000 + 4 * 3600 * 1000).toISOString();
    const cd5d = formatResetCountdown(fiveDaysLater);
    assert.ok(cd5d.includes('天') && cd5d.includes('小时后重置'));

    // 2. 验证 syncAccountToKeychain
    const testAccount = {
      id: 'acc-kc-test',
      email: 'pilot@antigravity.dev',
      name: 'Pilot User',
      token: {
        access_token: 'acc-token-456',
        refresh_token: 'ref-token-456',
        expires_in: 3600,
        expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'Bearer',
        email: 'pilot@antigravity.dev',
        project_id: 'proj-789',
        is_gcp_tos: false,
      },
      device_profile: generateDeviceProfile(),
      disabled: false,
      protected_models: [],
      validation_blocked: false,
      created_at: 1000,
      last_used: 1000,
    };

    await syncAccountToKeychain(testAccount, mockKeychain);
    const kcVal = await mockKeychain.readPassword('gemini', 'antigravity');
    assert.ok(kcVal?.startsWith('go-keyring-base64:'));
    const decoded = JSON.parse(Buffer.from(kcVal.slice('go-keyring-base64:'.length), 'base64').toString('utf8'));
    assert.equal(decoded.token.email, 'pilot@antigravity.dev');
    assert.equal(decoded.token.refresh_token, 'ref-token-456');
    // 回归：官方 Go 端按 oauth2.Token 解析，缺 expiry 会被视为永不过期而不刷新，约 1 小时后 401 并跳登录页。
    assert.equal(typeof decoded.token.expiry, 'string');
    assert.equal(Date.parse(decoded.token.expiry) / 1000, testAccount.token.expiry_timestamp);
    assert.equal(decoded.token.token_type, 'Bearer');
    assert.equal(decoded.id_token_email, 'pilot@antigravity.dev');
    assert.equal(decoded.auth_method, 'consumer');
    assert.ok(decoded.token.expires_in > 0 && decoded.token.expires_in <= 3600);

    // 3. 验证 3 分组 5 配额桶与 13 模型多维结构
    const mgr = new AccountsManager(sandbox);
    const quotaData = {
      models: [
        { name: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', percentage: 72, reset_time: twoHoursLater },
        { name: 'claude-3-5-sonnet', display_name: 'Claude 3.5 Sonnet', percentage: 46, reset_time: fiveDaysLater },
        { name: 'gemini-4-argon', display_name: 'Gemini 4 Argon', percentage: 100, reset_time: fiveDaysLater },
      ],
      quota_groups: [
        {
          display_name: 'Gemini Models',
          buckets: [
            { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.91, reset_time: fiveDaysLater },
            { bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 0.72, reset_time: twoHoursLater },
          ],
        },
        {
          display_name: 'Claude and GPT models',
          buckets: [
            { bucket_id: '3p-weekly', window: 'weekly', remaining_fraction: 0.46, reset_time: fiveDaysLater },
            { bucket_id: '3p-5h', window: '5h', remaining_fraction: 1.0, reset_time: twoHoursLater },
          ],
        },
        {
          display_name: 'Gemini 4 Argon',
          buckets: [
            { bucket_id: 'gemini-argon-wtu-weekly', window: 'weekly', remaining_fraction: 1.0, reset_time: fiveDaysLater },
          ],
        },
      ],
      last_updated: Math.floor(Date.now() / 1000),
      is_forbidden: false,
      subscription_tier: 'PRO',
      model_forwarding_rules: {},
    };

    testAccount.quota = quotaData;
    const overview = mgr.getAccountQuotaOverview(testAccount);
    assert.equal(overview.subscriptionTier, 'PRO');
    assert.equal(overview.geminiFiveHourRemaining, 72);
    assert.equal(overview.geminiWeeklyRemaining, 91);
    assert.equal(overview.claudeFiveHourRemaining, 100);
    assert.equal(overview.claudeWeeklyRemaining, 46);
    assert.equal(overview.argonWeeklyRemaining, 100);
    assert.ok(overview.geminiResetCountdown.includes('小时'));
    assert.ok(overview.claudeResetCountdown.includes('天'));
    assert.equal(overview.quotaGroups.length, 3);
    assert.equal(overview.models.length, 3);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
});
