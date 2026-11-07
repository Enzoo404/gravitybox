import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  AccountsManager,
  formatResetCountdown,
  refreshResetDescription,
  projectAccountForIpc,
} from '../dist/accounts.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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

// ---------- C01/C02：IPC 只读推荐不切号，且返回体不含 token ----------

function exchange(directory, request, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(directory, 'control.sock'));
    let value = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('IPC 超时')); }, timeout);
    const finish = error => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => { value += chunk; if (value.includes('\n')) finish(); });
    socket.on('error', finish);
  });
}

async function startBackend(directory) {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('../dist/main.js', import.meta.url)),
    '--state-dir', directory,
    '--app', '/nonexistent',
    '--profile', join(directory, 'profile'),
    '--home-dir', join(directory, 'home'),
    '--app-support-dir', join(directory, 'appsupport'),
    '--gemini-dir', join(directory, 'gemini'),
  ], { stdio: ['ignore', 'ignore', 'pipe'], env:{...process.env,GRAVITYBOX_PROBE_LS:'false'} });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += String(bytes); });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const reply = JSON.parse((await exchange(directory, { command: 'status', includeTasks: false })).split('\n')[0]);
      if (reply.ok) return { child, stderr: () => stderr };
    } catch {}
    await sleep(80);
  }
  child.kill();
  throw new Error(`后台未在时限内启动: ${stderr.slice(0, 400)}`);
}

test('C01/C02: auto_switch_best 默认只读、execute 需确认，IPC 响应不含任何 token', async () => {
  const { dir, mgr } = await makeManager();
  const nowMs = Date.now();
  const secretAccess = 'SECRET_ACCESS_TOKEN_DO_NOT_LEAK_AAA';
  const secretRefresh = 'SECRET_REFRESH_TOKEN_DO_NOT_LEAK_BBB';
  const secretId = 'SECRET_ID_TOKEN_DO_NOT_LEAK_CCC';
  try {
    const current = await mgr.upsertAccount({
      email: 'active@example.test', refreshToken: secretRefresh, accessToken: secretAccess,
      idToken: secretId, expiresIn: 3600,
    });
    current.quota = seededQuota(nowMs, { percentage: 5 });
    await mgr.saveAccount(current);
    const candidate = await mgr.upsertAccount({
      email: 'candidate@example.test', refreshToken: 'SECRET_REFRESH_CANDIDATE_DDD',
      accessToken: 'SECRET_ACCESS_CANDIDATE_EEE', expiresIn: 3600,
    });
    candidate.quota = seededQuota(nowMs, { percentage: 90 });
    await mgr.saveAccount(candidate);
    await mgr.setCurrentAccount(current.id, 'app');
    await mgr.setAutoSwitchConfig({ enabled: true, reserve_percentage: 10, candidate_min_percentage: 30 });

    const backend = await startBackend(dir);
    try {
      // 1) 默认（无 execute）只读：不得切号、不得返回 token。
      const rawDefault = (await exchange(dir, { command: 'auto_switch_best' })).split('\n')[0];
      for (const secret of [secretAccess, secretRefresh, secretId, 'SECRET_REFRESH_CANDIDATE_DDD', 'SECRET_ACCESS_CANDIDATE_EEE']) {
        assert.equal(rawDefault.includes(secret), false, `默认推荐响应不得包含凭据 ${secret.slice(0, 18)}…`);
      }
      for (const key of ['access_token', 'refresh_token', 'id_token']) {
        assert.equal(rawDefault.includes(key), false, `默认推荐响应不得出现字段 ${key}`);
      }
      const replyDefault = JSON.parse(rawDefault);
      assert.equal(replyDefault.ok, true);
      assert.equal(replyDefault.preview, true);
      assert.equal(replyDefault.executed, false);
      assert.equal(replyDefault.currentAccount.token, undefined);
      assert.equal(replyDefault.bestCandidate.token, undefined);
      assert.ok(replyDefault.currentAccount.email, '投影必须保留 native 需要的 email');
      assert.ok(replyDefault.currentAccount.quota, '投影必须保留 native 需要的 quota');

      // 2) 老调用方式 preview:true 仍然兼容且只读。
      const replyPreview = JSON.parse((await exchange(dir, { command: 'auto_switch_best', preview: true })).split('\n')[0]);
      assert.equal(replyPreview.ok, true);
      assert.equal(replyPreview.preview, true);
      assert.equal(replyPreview.executed, false);

      // 3) execute:true 缺少 confirmed:true：必须拒绝且不产生切号记录。
      const replyExecute = JSON.parse((await exchange(dir, { command: 'auto_switch_best', execute: true })).split('\n')[0]);
      assert.equal(replyExecute.ok, false);
      assert.match(replyExecute.error, /确认/);

      // 4) 只读命令的副作用为 0：没有切号 journal，索引仍指向原账号。
      await assert.rejects(readFile(join(dir, 'account-switch-journal-stable.json'), 'utf8'), /ENOENT/);
      const index = JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8'));
      assert.equal(index.current_account_id, current.id, '只读推荐不得修改当前账号');

      // 5) account_get 同样必须投影去 token。
      const rawGet = (await exchange(dir, { command: 'account_get', id: current.id })).split('\n')[0];
      assert.equal(rawGet.includes(secretAccess), false);
      assert.equal(rawGet.includes(secretRefresh), false);
      assert.equal(rawGet.includes(secretId), false);
      const replyGet = JSON.parse(rawGet);
      assert.equal(replyGet.ok, true);
      assert.equal(replyGet.account.token, undefined);
      assert.equal(replyGet.account.email, 'active@example.test');
    } finally {
      backend.child.kill();
      await sleep(250);
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

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

// ---------- C02：投影函数边界 ----------

test('C02: projectAccountForIpc 去 token 且保留原生所需字段', async () => {
  const account = {
    id: 'acc-1', email: 'a@example.test', name: 'A', token: { access_token: 'SECRET_A', refresh_token: 'SECRET_R', id_token: 'SECRET_I' },
    quota: seededQuota(Date.now()), subscription_tier: 'PRO', quota_refresh_error: null,
    quota_last_updated: 123, disabled: false, protected_models: [], validation_blocked: false,
    created_at: 1, last_used: 2, custom_label: null,
  };
  const projected = projectAccountForIpc(account);
  const text = JSON.stringify(projected);
  assert.equal(projected.token, undefined);
  for (const secret of ['SECRET_A', 'SECRET_R', 'SECRET_I', 'access_token', 'refresh_token', 'id_token']) {
    assert.equal(text.includes(secret), false, `投影不得包含 ${secret}`);
  }
  for (const key of ['id', 'email', 'name', 'quota', 'subscription_tier', 'quota_refresh_error', 'revision']) {
    assert.ok(key in projected, `投影必须保留 ${key}`);
  }
  assert.equal(projected.subscription_tier, 'PRO');
  assert.equal(projected.quota.last_updated, Math.floor(Date.now() / 1000));
  assert.equal(projectAccountForIpc(null), null);
  void root;
});
