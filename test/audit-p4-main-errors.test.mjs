import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountsManager } from '../dist/accounts.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 以“仅导入”模式加载主进程模块：临时 state 目录 + 禁止自动 run()，不触碰真实用户数据/socket。
const importState = await mkdtemp(join(tmpdir(), 'gb-p4-import-'));
const savedArgv = process.argv.slice();
process.argv.push('--state-dir', importState, '--app', '/nonexistent', '--profile', join(importState, 'profile'),
  '--gemini-dir', join(importState, 'gemini'), '--home-dir', importState, '--app-support-dir', importState);
process.env.GRAVITYBOX_IMPORT_ONLY = '1';
const { buildDashboardAggregate, normalizeSubscriptionTier } = await import('../dist/main.js');
process.argv.length = 0; process.argv.push(...savedArgv);
delete process.env.GRAVITYBOX_IMPORT_ONLY;
after(async () => { await rm(importState, { recursive: true, force: true }); });

const TIERS = ['FREE', 'PRO', 'ULTRA', '待确认'];

function healthyDeps(overrides = {}) {
  const account = { id: 'acc-1', email: 'user@example.test', name: '用户', quota: { subscription_tier: 'PRO', last_updated: 1 } };
  return {
    listAccounts: async () => ({ active_account_id: 'acc-1', active_account: account, accounts: [account], revision: 'rev-1' }),
    getAutoSwitchConfig: async () => ({ enabled: false }),
    probeLiveLanguageServer: async () => null,
    getAccount: async () => account,
    getAccountQuotaOverview: () => ({
      subscriptionTier: 'PRO', fiveHourRemaining: 66, weeklyRemaining: 80, geminiFiveHourRemaining: 66,
      geminiWeeklyRemaining: 80, geminiFiveHourResetCountdown: '', geminiWeeklyResetCountdown: '', geminiResetCountdown: '',
      claudeFiveHourRemaining: null, claudeWeeklyRemaining: null, claudeFiveHourResetCountdown: '',
      claudeWeeklyResetCountdown: '', claudeResetCountdown: '', argonWeeklyRemaining: null,
      argonWeeklyResetCountdown: '', argonResetCountdown: '', resetTime: null, resetCountdown: '',
      quotaGroups: [], staleGroups: [], models: [], lastUpdated: 1, isStale: false, staleHours: 0,
    }),
    getUsageSummary: async () => ({
      today: { totals: { total_tokens: 1234, input_tokens: 1000, output_tokens: 234, cached_tokens: 0, request_count: 5 }, estimated_usd: 0.5 },
      all_time: { totals: { total_tokens: 9999, input_tokens: 8000, output_tokens: 1999, cached_tokens: 0, request_count: 40 }, estimated_usd: 3.2 },
      unpriced_models: 1, priced_models: 2, databases_scanned: 3, databases_discovered: 5,
      scan_scope_description: '最近活跃 3 个会话库', has_error: false, failed_databases_count: 0,
    }),
    getPricingTable: async () => ({ a: {}, b: {} }),
    ...overrides,
  };
}

// B12: accounts 失败但 usage 成功 —— 必须给出脱敏 accountsError 且保留 usage 可用数据。
test('B12: accounts 聚合失败返回脱敏 accountsError，usage 数据保留', async () => {
  const leakedPath = '/Users/alice/Library/Application Support/GravityBox/accounts.json';
  const leakedToken = 'sk-live-abcdefghijklmnop';
  const deps = healthyDeps({
    listAccounts: async () => { throw new Error(`读取账号索引失败 ${leakedPath} Authorization: Bearer ${leakedToken}`); },
  });
  const result = await buildDashboardAggregate(deps);
  assert.equal(result.accounts, null);
  assert.ok(result.accountsError.length > 0, 'accounts 失败必须有明确错误');
  assert.equal(result.accountsError.includes('/Users/'), false, '错误不得泄漏绝对路径');
  assert.equal(result.accountsError.includes('alice'), false, '错误不得泄漏用户名/路径');
  assert.equal(result.accountsError.includes('sk-live'), false, '错误不得泄漏密钥');
  assert.equal(result.accountsError.includes('Bearer sk-live'), false, '错误不得泄漏认证头');
  assert.ok(result.usage, 'usage 成功时仍须返回可用部分数据');
  assert.equal(result.usageError, '');
  assert.equal(result.usage.todayTokens, 1234);
  assert.equal(result.usage.totalTokens, 9999);
});

// B12: usage 失败但 accounts 成功 —— accounts 数据保留且套餐已规范化。
test('B12: usage 聚合失败返回脱敏 usageError，accounts 数据保留', async () => {
  const deps = healthyDeps({
    getUsageSummary: async () => { throw new Error('读取用量库失败 /private/var/folders/x/usage.sqlite token=ya29.abcdefghijklmnop'); },
  });
  const result = await buildDashboardAggregate(deps);
  assert.equal(result.usage, null);
  assert.ok(result.usageError.length > 0);
  assert.equal(result.usageError.includes('/private/'), false, '错误不得泄漏绝对路径');
  assert.equal(result.usageError.includes('ya29.'), false, '错误不得泄漏凭据');
  assert.ok(result.accounts, 'accounts 成功时仍须返回可用部分数据');
  assert.equal(result.accountsError, '');
  assert.equal(result.accounts.activeEmail, 'user@example.test');
  assert.equal(result.accounts.activeTier, 'PRO');
});

// B12: accounts 与 usage 同时失败 —— 同一响应可读，两段互不吞并。
test('B12: accounts 与 usage 同时失败时两段错误分别返回且不抛出', async () => {
  const deps = healthyDeps({
    listAccounts: async () => { throw new Error('账号索引损坏'); },
    getUsageSummary: async () => { throw new Error('用量缓存损坏'); },
  });
  const result = await buildDashboardAggregate(deps);
  assert.equal(result.accounts, null);
  assert.equal(result.usage, null);
  assert.match(result.accountsError, /账号索引损坏/);
  assert.match(result.usageError, /用量缓存损坏/);
});

// B13: 套餐枚举归一化。
test('B13: subscriptionTier 空值/未知值统一为 待确认，合法值收敛为 FREE/PRO/ULTRA', async () => {
  const cases = [
    ['FREE', 'FREE'], ['free', 'FREE'], ['Free', 'FREE'], ['starter', 'FREE'],
    ['PRO', 'PRO'], ['pro', 'PRO'], ['Google AI Pro', 'PRO'],
    ['ULTRA', 'ULTRA'], ['Ultra', 'ULTRA'], ['Gemini Ultra', 'ULTRA'],
    ['', '待确认'], ['   ', '待确认'], [null, '待确认'], [undefined, '待确认'], ['mystery-tier', '待确认'], [123, '待确认'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeSubscriptionTier(input), expected, `tier ${JSON.stringify(input)} 应归一为 ${expected}`);
    assert.ok(TIERS.includes(normalizeSubscriptionTier(input)));
  }
});

// B13: 聚合结果里的 activeTier 不得出现空串或任意原始值。
test('B13: 聚合 accounts.activeTier 对空串/未知值回落 待确认', async () => {
  for (const [raw, expected] of [['', '待确认'], [null, '待确认'], ['mystery', '待确认'], ['PRO', 'PRO'], ['ULTRA', 'ULTRA']]) {
    const deps = healthyDeps();
    deps.getAccountQuotaOverview = () => ({
      subscriptionTier: raw, fiveHourRemaining: null, weeklyRemaining: null, geminiFiveHourRemaining: null,
      geminiWeeklyRemaining: null, geminiFiveHourResetCountdown: '', geminiWeeklyResetCountdown: '', geminiResetCountdown: '',
      claudeFiveHourRemaining: null, claudeWeeklyRemaining: null, claudeFiveHourResetCountdown: '',
      claudeWeeklyResetCountdown: '', claudeResetCountdown: '', argonWeeklyRemaining: null,
      argonWeeklyResetCountdown: '', argonResetCountdown: '', resetTime: null, resetCountdown: '',
      quotaGroups: [], staleGroups: [], models: [], lastUpdated: null, isStale: false, staleHours: 0,
    });
    const result = await buildDashboardAggregate(deps);
    assert.equal(result.accounts.activeTier, expected);
    assert.ok(TIERS.includes(result.accounts.activeTier));
  }
});

// 源码探针：确认 IPC 各出口都走统一归一化/错误字段，防止后续回退。
test('B12/B13: main.ts 聚合与账号 IPC 出口已接线（源码探针）', async () => {
  const main = await readFile(join(root, 'src/main.ts'), 'utf8');
  assert.match(main, /export async function buildDashboardAggregate/, '聚合必须抽为可注入依赖的函数');
  assert.match(main, /accountsError: aggregate\.accountsError/, 'dashboard_summary 必须返回 accountsError');
  assert.match(main, /usageError: aggregate\.usageError/, 'dashboard_summary 必须返回 usageError');
  assert.match(main, /accounts: aggregate\.accounts,\s*usage: aggregate\.usage,/, 'dashboard_summary 必须返回可用部分数据');
  const accountProjections = main.match(/projectAccountForIpc\(/g) ?? [];
  assert.equal(accountProjections.length, 1, '除归一化 helper 外不得再有裸 projectAccountForIpc 出口');
  assert.ok(main.includes('projectAccountForIpcNormalized'), '账号 IPC 项目必须经过套餐归一化');
  assert.match(main, /activeSubscriptionTier = normalizeSubscriptionTier\(/);
  const tierAssignments = main.match(/activeSubscriptionTier = normalizeSubscriptionTier\(/g) ?? [];
  assert.equal(tierAssignments.length, 3, 'status 的三个套餐赋值都必须归一化');
  assert.match(main, /subscription_tier: normalizeSubscriptionTier\(q\.subscriptionTier\)/);
  assert.match(main, /const normalizedQuota = acc\.quota \?/, 'quota_refresh 的 quota 负载也必须归一化套餐');
  assert.match(main, /subscription_tier: normalizeSubscriptionTier\(\(account as any\)\.subscription_tier/, 'account_reorder 的账号负载也必须归一化套餐');
  assert.doesNotMatch(main, /subscription_tier: q\.subscriptionTier/, '不得再直出原始套餐值');
  assert.doesNotMatch(main, /subscription_tier: projected\?\.subscription_tier \?\? null/, '不得再把空套餐穿透为 null');
});

// 真实后台契约：dashboard_summary 仍 ok:true，并稳定携带 errors 字段与枚举套餐。
function rpc(directory, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(directory, 'control.sock'));
    const chunks = [];
    socket.setTimeout(8000, () => { socket.destroy(); reject(new Error('IPC 超时')); });
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('error', reject);
    socket.on('data', chunk => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (!buffer.includes(0x0a)) return;
      socket.end();
      try { resolve(JSON.parse(buffer.toString('utf8').split('\n')[0])); } catch { reject(new Error('响应格式错误')); }
    });
  });
}
async function until(fn, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(30); }
  throw new Error('测试等待超时');
}

test('B12/B13: 真实后台 dashboard_summary 返回可读错误字段与枚举套餐', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gb-p4-contract-'));
  const manager = new AccountsManager(directory);
  const fixture = await manager.upsertAccount({email:'quota-contract@example.test',refreshToken:'synthetic-contract-refresh'});
  fixture.quota = manager.fuseQuota({models:{'gemini-pro':{quotaInfo:{remainingFraction:.85}},
    'gemini-4-argon':{disabled:false,quotaInfo:{remainingFraction:.45}}}},
    {groups:[{displayName:'Gemini',buckets:[{bucketId:'gemini-weekly',window:'weekly',remainingFraction:.7}]}]});
  await manager.saveAccount(fixture); await manager.setCurrentAccount(fixture.id);
  const child = spawn(process.execPath, [
    join(root, 'dist/main.js'),
    '--state-dir', directory,
    '--app', '/nonexistent',
    '--profile', join(directory, 'nonexistent-profile'),
    '--gemini-dir', join(directory, 'gemini'),
    '--home-dir', directory,
    '--app-support-dir', directory,
  ], { stdio: ['ignore', 'ignore', 'pipe'], env:{...process.env,GRAVITYBOX_PROBE_LS:'false'} });
  let errors = '';
  child.stderr.on('data', bytes => { errors += bytes; });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    await until(async () => { try { return (await rpc(directory, { command: 'status' })).ok; } catch { return false; } });
    const status = await rpc(directory, { command: 'status' });
    assert.ok(TIERS.includes(status.status.activeSubscriptionTier), `status 套餐必须是枚举值，实际 ${status.status.activeSubscriptionTier}`);

    const dashboard = await rpc(directory, { command: 'dashboard_summary' });
    assert.equal(dashboard.ok, true);
    assert.equal(typeof dashboard.accountsError, 'string');
    assert.equal(typeof dashboard.usageError, 'string');
    assert.equal(dashboard.accountsError, '');
    assert.equal(dashboard.usageError, '');
    assert.ok(dashboard.accounts && typeof dashboard.accounts === 'object');
    assert.ok(dashboard.usage && typeof dashboard.usage === 'object');
    assert.ok(TIERS.includes(dashboard.accounts.activeTier), `activeTier 必须是枚举值，实际 ${dashboard.accounts.activeTier}`);

    const accounts = await rpc(directory, { command: 'account_list' });
    assert.equal(accounts.ok, true);
    assert.equal(accounts.accounts.length,1);
    const contractAccount=accounts.accounts[0];
    assert.equal(contractAccount.familyWindows.gemini.weekly.remaining,.7);
    assert.equal(contractAccount.familyWindows.gemini.fiveHour,null);
    assert.equal(contractAccount.argonStatus.period,'unspecified');
    assert.equal(contractAccount.argonStatus.remaining,.45);
    assert.deepEqual(contractAccount.quota.argonStatus,contractAccount.argonStatus);
    assert.deepEqual(dashboard.accounts.familyWindows,contractAccount.familyWindows);
    assert.deepEqual(dashboard.accounts.argonStatus,contractAccount.argonStatus);
    assert.equal(JSON.stringify(accounts).includes('synthetic-contract-refresh'),false);
    for (const account of accounts.accounts) {
      assert.ok(TIERS.includes(account.subscription_tier), `账号套餐必须是枚举值，实际 ${account.subscription_tier}`);
      if (account.quota) assert.ok(TIERS.includes(account.quota.subscription_tier));
    }

    assert.equal((await rpc(directory, { command: 'stop' })).ok, true);
    await closed;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
  assert.doesNotMatch(errors, /\[GravityBox\]/, '后台进程不得输出异常日志');
});
