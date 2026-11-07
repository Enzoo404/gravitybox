import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AccountsManager, MockKeychainAdapter } from '../dist/accounts.js';
import { AccountSwitchService, replaceTopicRow } from '../dist/account-switch.js';
import { ProtobufReader as Reader, ProtobufWriter as Writer } from '../dist/usage.js';
const run = promisify(execFile);
const now = () => Math.floor(Date.now() / 1000);
const quota = pct => ({ models: [{ name: 'gemini-test', percentage: pct, percentage_known: true, reset_time: '' }], quota_groups: [{ display_name: 'Gemini', buckets: [{ bucket_id: 'gemini-5h', window: '5h', remaining_fraction: pct / 100, remaining_fraction_known: true, reset_time: '' }] }], last_updated: now(), is_forbidden: false, model_forwarding_rules: {} });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gb-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state'), externalDir = join(root, 'external'), profile = join(root, 'profile');
  await mkdir(join(externalDir, 'accounts'), { recursive: true });
  await mkdir(join(profile, 'User', 'globalStorage'), { recursive: true });
  const db = join(profile, 'User', 'globalStorage', 'state.vscdb');
  await run('/usr/bin/sqlite3', [db, "CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT); INSERT INTO ItemTable VALUES('unrelated','keep'),('jetskiStateSync.agentManagerInitState','old-state');"]);
  const manager = new AccountsManager(stateDir, { externalDir });
  manager.probeLiveLanguageServer = async () => null;
  const a = await manager.upsertAccount({ email: 'a@example.test', refreshToken: 'synthetic-a', accessToken: 'synthetic-access-a', expiresIn: 3600 });
  const b = await manager.upsertAccount({ email: 'b@example.test', refreshToken: 'synthetic-b', accessToken: 'synthetic-access-b', expiresIn: 3600 });
  await writeFile(join(externalDir, 'accounts.json'), JSON.stringify({ version: '2.0', current_account_id: 'external-a', extra: 'preserve', accounts: [{ id: 'external-a', email: a.email }, { id: 'external-b', email: b.email }] }));
  const keychain = new MockKeychainAdapter(); await keychain.writePassword('gemini', 'antigravity', 'old-keychain');
  return { root, stateDir, externalDir, profile, db, manager, a, b, keychain };
}
const rows = async f => JSON.parse((await run('/usr/bin/sqlite3', ['-json', f.db, 'SELECT key,value FROM ItemTable ORDER BY key;'])).stdout);

test('备用号刷新使用本账号凭据与账号范围；项目元信息可保存，失败保留旧记录', async t => {
  const f = await fixture(t), before = quota(62); f.b.quota = before; f.b.token.access_token = 'pending_refresh'; await f.manager.saveAccount(f.b);
  const seen = [];
  const cloud = async (url, options) => {
    seen.push({ url, options });
    if (url.includes('/token')) { assert.match(options.body, /synthetic-b/); return Response.json({ access_token: 'rotated-b', refresh_token: 'rotated-refresh-b', expires_in: 3600 }); }
    assert.equal(options.headers.Authorization, 'Bearer rotated-b');
    if (url.includes('loadCodeAssist')) return Response.json({ cloudaicompanionProject: { id: 'project-b' }, paidTier: { id: 'PRO' } });
    assert.deepEqual(JSON.parse(options.body), {}, '模型和配额按账号查询，不使用项目范围');
    if (url.includes('fetchAvailableModels')) return Response.json({ models: { 'gemini-test': { displayName: 'Gemini Test', quotaInfo: { remainingFraction: 1 } } } });
    return Response.json({ response: { groups: [{ displayName: 'Gemini', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: .24 }] }] } });
  };
  const fresh = await f.manager.refreshQuota(f.b.id, cloud);
  assert.equal(fresh.quota.models[0].percentage, 24); assert.equal(fresh.quota.source, 'cloud'); assert.equal(fresh.token.project_id, 'project-b');
  assert.equal((await f.manager.loadIndex()).current_account_id, f.a.id);
  const oldQuota = JSON.parse(JSON.stringify(fresh.quota));
  await assert.rejects(f.manager.refreshQuota(f.b.id, async () => new Response('', { status: 503 })), /保留上次记录/);
  assert.deepEqual((await f.manager.getAccount(f.b.id)).quota, oldQuota);
  const result = await f.manager.refreshAllQuotas(async () => new Response('', { status: 401 }));
  assert.equal(result.failures.length, 2); assert.equal(result.accounts.length, 0);
  assert.ok((await f.manager.getAccount(f.b.id)).quota_refresh_error);
});

test('Switch 增量同步保留当前账号、顺序与备注，并读取较新凭据和配额', async t => {
  const f = await fixture(t); await f.manager.reorderAccounts([f.b.id, f.a.id]);
  f.b.custom_label = '本机备注'; await f.manager.saveAccount(f.b);
  const ext = { ...f.b, id: 'external-b', custom_label: '外部备注', quota: quota(37), token: { ...f.b.token, access_token: 'new-external', expiry_timestamp: now() + 7200 } };
  await writeFile(join(f.externalDir, 'accounts', 'b.json'), JSON.stringify(ext));
  await writeFile(join(f.externalDir, 'accounts', 'bad.json'), '{invalid-json');
  const sync = await f.manager.syncFromExternalAgySwitch(); assert.equal(sync.updated, 1); assert.equal(sync.skipped, 1); assert.equal(sync.found, 1);
  const index = await f.manager.loadIndex(); assert.equal(index.current_account_id, f.a.id); assert.deepEqual(index.accounts.map(a => a.id), [f.b.id, f.a.id]);
  const saved = await f.manager.getAccount(f.b.id); assert.equal(saved.custom_label, '本机备注'); assert.equal(saved.token.access_token, 'new-external'); assert.equal(saved.quota.source, 'external');
  const fallback = await f.manager.refreshQuota(f.b.id, async () => { throw new Error('offline'); });
  assert.equal(fallback.quota.models[0].percentage, 37); assert.match(fallback.quota_refresh_error, /Switch/);
});

test('未知配额不会变成100%，Argon不覆盖Gemini，未知或过期配额不参与切换', async t => {
  const f = await fixture(t); assert.equal(f.manager.getAccountQuotaOverview(f.a).geminiFiveHourRemaining, null);
  const fused = f.manager.fuseQuota({ models: { 'gemini-flash': { quotaInfo: { remainingFraction: 1 } }, 'gemini-4-argon': { quotaInfo: { remainingFraction: 1 } } } }, { groups: [
    { displayName: 'Gemini 4 Argon', buckets: [{ bucketId: 'argon-week', window: 'weekly', remainingFraction: .8 }] },
    { displayName: 'Gemini', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: .2 }] },
  ] });
  assert.equal(fused.models[0].percentage, 20); assert.equal(fused.models[1].percentage, 80);
  f.a.quota = quota(100); f.a.quota.models[0].percentage_known = false; f.a.quota.quota_groups = []; assert.equal(f.manager.getAccountRemaining(f.a), null);
  f.a.quota = quota(100); f.a.quota.last_updated = now() - 1000; assert.equal(f.manager.getAccountRemaining(f.a), null);
  f.a.quota = { ...quota(10), quota_groups: [] }; assert.equal(f.manager.getAccountQuotaOverview(f.a).geminiWeeklyRemaining, null);
});

test('添加凭据必须核实Google邮箱；未核实不落盘，失败不会泄漏响应内容', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.addAccountWithRefreshToken('bad', async () => new Response('secret-error', { status: 400 })), e => !e.message.includes('secret-error'));
  assert.equal((await f.manager.loadIndex()).accounts.length, 2);
  const acc = await f.manager.addAccountWithRefreshToken('synthetic-refresh', async url => Response.json(url.includes('/token') ? { access_token: 'verified-access', expires_in: 3600 } : { email: 'new@example.test', verified_email: true, name: 'New' }));
  assert.equal(acc.email, 'new@example.test'); assert.equal((await f.manager.loadIndex()).current_account_id, f.a.id);
});

test('切号事务同步SQLite、钥匙串与两端索引，保留其他数据并可撤销', async t => {
  const f = await fixture(t), before = await rows(f);
  const original = { index: await readFile(join(f.stateDir, 'accounts.json'), 'utf8'), external: await readFile(join(f.externalDir, 'accounts.json'), 'utf8') };
  const unrelatedTopic = replaceTopicRow(undefined, 'other-sentinel', Writer.encodeString(1, 'keep-row'));
  await run('/usr/bin/sqlite3', [f.db, `INSERT INTO ItemTable VALUES('antigravityUnifiedStateSync.oauthToken','${unrelatedTopic}');`]);
  const service = new AccountSwitchService(f.manager, { ...f, isRunning: async () => false });
  await service.switchAccount(f.b.id);
  const written = Object.fromEntries((await rows(f)).map(r => [r.key, r.value]));
  assert.equal(written.unrelated, 'keep'); assert.equal(written['jetskiStateSync.agentManagerInitState'], undefined);
  const topic = Buffer.from(written['antigravityUnifiedStateSync.oauthToken'], 'base64');
  assert.ok(topic.includes(Buffer.from('other-sentinel'))); assert.ok(topic.includes(Buffer.from('oauthTokenInfoSentinelKey')));
  const us = Reader.findField(Buffer.from(written['antigravityUnifiedStateSync.userStatus'], 'base64'), 1);
  const payload = Buffer.from(Reader.findString(Reader.findField(us, 2), 1), 'base64'); assert.equal(Reader.findString(payload, 7), f.b.email);
  assert.equal((await f.manager.loadIndex()).current_account_id, f.b.id);
  const external = JSON.parse(await readFile(join(f.externalDir, 'accounts.json'), 'utf8')); assert.equal(external.current_account_id, 'external-b'); assert.equal(external.extra, 'preserve');
  const appSupportDir = join(f.root, 'ApplicationSupport'), currentDb = join(appSupportDir, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
  await mkdir(join(appSupportDir, 'Antigravity', 'User', 'globalStorage'), { recursive: true }); await copyFile(f.db, currentDb);
  const readback = new AccountsManager(join(f.root, 'readback'));
  const saved = await readback.saveCurrentAccount({ homeDir: f.root, appSupportDir, keychain: new MockKeychainAdapter() });
  assert.equal(saved.email, f.b.email); assert.equal(saved.token.refresh_token, f.b.token.refresh_token);
  const journal = join(f.stateDir, 'account-switch-journal-stable.json'); assert.equal((await stat(journal)).mode & 0o777, 0o600);
  await service.rollback();
  assert.equal(await f.keychain.readPassword('gemini', 'antigravity'), 'old-keychain'); assert.equal(await readFile(join(f.stateDir, 'accounts.json'), 'utf8'), original.index); assert.equal(await readFile(join(f.externalDir, 'accounts.json'), 'utf8'), original.external);
  assert.deepEqual((await rows(f)).filter(r => r.key !== 'antigravityUnifiedStateSync.oauthToken'), before);
});

test('Antigravity运行时切号零写入；钥匙串失败与写入期间重开会完整回滚', async t => {
  const f = await fixture(t), before = await rows(f), index = await readFile(join(f.stateDir, 'accounts.json'), 'utf8');
  const blocked = new AccountSwitchService(f.manager, { ...f, isRunning: async () => true });
  await assert.rejects(blocked.switchAccount(f.b.id), /手动退出/); assert.deepEqual(await rows(f), before);
  const write = f.keychain.writePassword.bind(f.keychain); let fail = true;
  f.keychain.writePassword = async (...args) => { if (fail) { fail = false; throw new Error('fixture failure'); } return write(...args); };
  const service = new AccountSwitchService(f.manager, { ...f, isRunning: async () => false });
  await assert.rejects(service.switchAccount(f.b.id), /fixture failure/);
  assert.deepEqual(await rows(f), before); assert.equal(await readFile(join(f.stateDir, 'accounts.json'), 'utf8'), index);
  let guards = 0;
  const reopened = new AccountSwitchService(f.manager, { ...f, isRunning: async () => ++guards === 3 });
  await assert.rejects(reopened.switchAccount(f.b.id), /手动退出/);
  assert.deepEqual(await rows(f), before); assert.equal(await readFile(join(f.stateDir, 'accounts.json'), 'utf8'), index); assert.equal(await f.keychain.readPassword('gemini', 'antigravity'), 'old-keychain');
});

test('外部文件变化时停止回滚，恢复记录保留；无对应Switch账号不进行切号', async t => {
  const f = await fixture(t), before = await rows(f);
  const externalPath = join(f.externalDir, 'accounts.json'); await writeFile(externalPath, JSON.stringify({ accounts: [] }));
  const service = new AccountSwitchService(f.manager, { ...f, isRunning: async () => false });
  await assert.rejects(service.switchAccount(f.b.id), /唯一对应账号/); assert.deepEqual(await rows(f), before);
  await writeFile(externalPath, JSON.stringify({ accounts: [{ id: 'external-b', email: f.b.email }] }));
  const write = f.keychain.writePassword.bind(f.keychain);
  f.keychain.writePassword = async (...args) => { await writeFile(externalPath, '{"changed":"externally"}'); await write(...args); };
  await assert.rejects(service.switchAccount(f.b.id), /恢复被外部变化阻止/);
  assert.equal(await readFile(externalPath, 'utf8'), '{"changed":"externally"}'); assert.deepEqual(await rows(f), before);
});

test('备用账号绝不串号继承Live Language Server配额，仅严格对齐邮箱才复用', async t => {
  const f = await fixture(t);
  f.manager.probeLiveLanguageServer = async () => ({
    email: 'current-live@example.test',
    name: 'Live User',
    tier: 'PRO',
    quota: quota(95),
  });

  // 1. 无邮箱账号绝不能继承 live 配额
  const noEmail = await f.manager.upsertAccount({ email: 'c@example.test', refreshToken: 'tok-c', accessToken: 'acc-c', expiresIn: 3600 });
  const noEmailAcc = await f.manager.getAccount(noEmail.id);
  noEmailAcc.email = '';
  await f.manager.saveAccount(noEmailAcc);

  let cloudCalled = false;
  const mockCloud = async (url) => {
    cloudCalled = true;
    if (url.includes('loadCodeAssist')) return Response.json({ cloudaicompanionProject: { id: 'p' }, paidTier: { id: 'PRO' } });
    if (url.includes('fetchAvailableModels')) return Response.json({ models: { 'gemini-test': { quotaInfo: { remainingFraction: 0.5 } } } });
    return Response.json({ response: { groups: [{ displayName: 'Gemini', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5 }] }] } });
  };

  const refreshedNoEmail = await f.manager.refreshQuota(noEmail.id, mockCloud);
  assert.equal(cloudCalled, true, '无邮箱账号必须走 Cloud API，不得直接窃取 Live 配额');
  assert.equal(refreshedNoEmail.quota.source, 'cloud');
  assert.equal(refreshedNoEmail.quota.models[0].percentage, 50);

  // 2. 邮箱不同账号（如 f.b: b@example.test）走 Cloud API
  cloudCalled = false;
  const refreshedB = await f.manager.refreshQuota(f.b.id, mockCloud);
  assert.equal(cloudCalled, true);
  assert.equal(refreshedB.quota.source, 'cloud');

  // 3. 邮箱严格匹配的账号才允许读取 Live 配额
  const liveMatch = await f.manager.upsertAccount({ email: 'current-live@example.test', refreshToken: 'tok-live', accessToken: 'acc-live', expiresIn: 3600 });
  cloudCalled = false;
  const refreshedLive = await f.manager.refreshQuota(liveMatch.id, mockCloud);
  assert.equal(cloudCalled, false, '邮箱严格匹配应命中 1ms Live 探查，无需调用 Cloud API');
  assert.equal(refreshedLive.quota.source, 'live');
  assert.equal(refreshedLive.quota.models[0].percentage, 95);
});

test('retrieveUserQuotaSummary 不发送已存项目，避免项目范围默认配额及重复请求', async t => {
  const f = await fixture(t);
  f.b.token.project_id = 'bad-project';
  await f.manager.saveAccount(f.b);

  let quotaSummaryCalls = 0;
  const cloud = async (url, options) => {
    if (url.includes('loadCodeAssist')) return Response.json({ paidTier: { id: 'PRO' } });
    if (url.includes('fetchAvailableModels')) {
      return Response.json({ models: { 'gemini-test': { displayName: 'Gemini Test', quotaInfo: { remainingFraction: 1 } } } });
    }
    if (url.includes('retrieveUserQuotaSummary')) {
      quotaSummaryCalls++;
      const body = JSON.parse(options.body || '{}');
      assert.deepEqual(body, {}, '已存 bad-project 不进入配额请求');
      return Response.json({ response: { groups: [{ displayName: 'Gemini', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.42 }] }] } });
    }
    return new Response('Not found', { status: 404 });
  };

  const fresh = await f.manager.refreshQuota(f.b.id, cloud);
  assert.equal(quotaSummaryCalls, 3, '隔离多端点测试每个端点仅查询一次账号范围，无重复空请求');
  assert.equal(fresh.quota.models[0].percentage, 42);
  assert.equal(fresh.quota.source, 'cloud');
  assert.equal(fresh.quota_refresh_error, null);
});

test('并发刷新单飞防重（Single Flight）、Token Rotation 与并发修改备注防丢更新', async t => {
  const f = await fixture(t);
  f.b.custom_label = '初始备注';
  f.b.token.access_token = 'pending_refresh';
  await f.manager.saveAccount(f.b);

  let tokenRefreshes = 0;
  let quotaCalls = 0;
  let delayedResolve;
  const tokenPromise = new Promise(res => { delayedResolve = res; });

  const fetchImpl = async (url, options) => {
    if (url.includes('/token')) {
      tokenRefreshes++;
      await tokenPromise; // 模拟网络延迟
      return Response.json({ access_token: 'new-acc-tok', expires_in: 3600 });
    }
    if (url.includes('loadCodeAssist')) return Response.json({ paidTier: { id: 'PRO' } });
    if (url.includes('fetchAvailableModels')) {
      quotaCalls++;
      return Response.json({ models: { 'gemini-test': { displayName: 'Gemini Test', quotaInfo: { remainingFraction: 1 } } } });
    }
    return Response.json({ response: { groups: [{ displayName: 'Gemini', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.88 }] }] } });
  };

  // 1. 同时发起 3 个并发刷新调用
  const p1 = f.manager.refreshQuota(f.b.id, fetchImpl);
  const p2 = f.manager.refreshQuota(f.b.id, fetchImpl);
  const p3 = f.manager.refreshQuota(f.b.id, fetchImpl);

  // 2. 在网络调用挂起期间，用户并发修改了备注
  const mid = await f.manager.getAccount(f.b.id);
  mid.custom_label = '并发保存的新备注';
  await f.manager.saveAccount(mid);

  // 3. 释放网络调用
  delayedResolve();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

  // 验证 Single Flight 合并防重：底层只发起 1 次 Token 刷新，每个端点查询一次
  assert.equal(tokenRefreshes, 1, '并发刷新必须共享单飞请求，防止多重 Token 轮转造成 400 invalid_grant');
  assert.equal(quotaCalls, 3);
  assert.equal(r1.id, r2.id);
  assert.equal(r2.id, r3.id);

  // 验证并发备注保留：刷新结果保存时绝不覆盖期间用户新增的备注
  const finalAcc = await f.manager.getAccount(f.b.id);
  assert.equal(finalAcc.custom_label, '并发保存的新备注');
  assert.equal(finalAcc.token.access_token, 'new-acc-tok');
  assert.equal(finalAcc.quota.models[0].percentage, 88);

  // 4. 验证凭据轮转抢占保护：若刷新期间账号凭据被其他流程重置，拒绝覆盖以防数据污染
  const staleAccount = JSON.parse(JSON.stringify(finalAcc));
  finalAcc.token.refresh_token = 'brand-new-external-token';
  await f.manager.saveAccount(finalAcc);

  await assert.rejects(
    f.manager.saveRefreshedAccount(staleAccount, 'stale-token'),
    /账号凭据已更新，停止覆盖新的登录记录/
  );
});

test('saveRefreshedAccount 读写间隙若发生并发备注编辑，不能丢失更新覆盖为 old', async t => {
  const f = await fixture(t);
  const acc = await f.manager.upsertAccount({
    email: 'gap-label@example.test',
    refreshToken: 'tok-gap-label',
    customLabel: 'old',
  });

  const refreshedSnapshot = {
    ...acc,
    quota: quota(66),
    token: { ...acc.token, access_token: 'new-cloud-tok' },
  };

  let pauseGateResolve;
  const pauseGate = new Promise(r => { pauseGateResolve = r; });
  let gapReachedResolve;
  const gapReached = new Promise(r => { gapReachedResolve = r; });

  const originalSaveAccount = f.manager.saveAccount.bind(f.manager);
  let intercepted = false;
  f.manager.saveAccount = async (target) => {
    if (!intercepted && target.id === acc.id) {
      intercepted = true;
      // 已在 saveRefreshedAccount 中读出 latest，拦截在此间隙
      gapReachedResolve();
      await pauseGate;
    }
    return originalSaveAccount(target);
  };

  const refreshPromise = f.manager.saveRefreshedAccount(refreshedSnapshot, acc.token.refresh_token);
  await gapReached;

  // 在读写间隙中，用户并发通过 upsertAccount 将 custom_label 修改为 new
  await f.manager.upsertAccount({
    id: acc.id,
    email: acc.email,
    customLabel: 'new',
  });

  // 释放挂起的写入
  pauseGateResolve();
  await refreshPromise;

  const finalAcc = await f.manager.getAccount(acc.id);
  assert.equal(finalAcc.custom_label, 'new', '读写间隙中修改的备注 new 绝不能被覆盖为 old');
});

test('saveRefreshedAccount 读写间隙若发生凭据轮转/重新认证，不能覆盖较新凭据', async t => {
  const f = await fixture(t);
  const acc = await f.manager.upsertAccount({
    email: 'gap-reauth@example.test',
    refreshToken: 'tok-initial',
  });

  const refreshedSnapshot = {
    ...acc,
    quota: quota(77),
    token: { ...acc.token, access_token: 'tok-initial-access' },
  };

  let pauseGateResolve;
  const pauseGate = new Promise(r => { pauseGateResolve = r; });
  let gapReachedResolve;
  const gapReached = new Promise(r => { gapReachedResolve = r; });

  const originalSaveAccount = f.manager.saveAccount.bind(f.manager);
  let intercepted = false;
  f.manager.saveAccount = async (target) => {
    if (!intercepted && target.id === acc.id) {
      intercepted = true;
      gapReachedResolve();
      await pauseGate;
    }
    return originalSaveAccount(target);
  };

  const refreshPromise = f.manager.saveRefreshedAccount(refreshedSnapshot, 'tok-initial');
  await gapReached;

  // 在间隙中，该账号重新认证换成了较新的 refresh_token
  const latestBeforeReauth = await f.manager.getAccount(acc.id);
  latestBeforeReauth.token.refresh_token = 'tok-brand-new-rotated';
  await originalSaveAccount(latestBeforeReauth);

  pauseGateResolve();
  // 必须抛出冲突异常，拒绝写入旧快照覆盖较新凭据
  await assert.rejects(
    refreshPromise,
    /账号凭据已更新，停止覆盖新的登录记录/
  );

  const finalAcc = await f.manager.getAccount(acc.id);
  assert.equal(finalAcc.token.refresh_token, 'tok-brand-new-rotated');
});

test('并发账号保存不丢失 index summaries', async t => {
  const f = await fixture(t);
  const acc1 = await f.manager.upsertAccount({ email: 'c1@example.test', refreshToken: 'tok-1', customLabel: 'label-1' });
  const acc2 = await f.manager.upsertAccount({ email: 'c2@example.test', refreshToken: 'tok-2', customLabel: 'label-2' });

  // 并发修改两个账号的 custom_label
  const p1 = f.manager.saveAccount({ ...acc1, custom_label: 'updated-label-1' });
  const p2 = f.manager.saveAccount({ ...acc2, custom_label: 'updated-label-2' });
  await Promise.all([p1, p2]);

  const index = await f.manager.loadIndex();
  const summary1 = index.accounts.find(a => a.id === acc1.id);
  const summary2 = index.accounts.find(a => a.id === acc2.id);

  assert.equal(summary1?.custom_label, 'updated-label-1');
  assert.equal(summary2?.custom_label, 'updated-label-2');
});




test('备用账号正式配额端点优先返回 Gemini 五小时和每周；不借用当前账号数据',async t=>{
 const f=await fixture(t);let summaryHosts=[];
 const cloud=async(url,options)=>{
  if(url.includes('loadCodeAssist'))return Response.json({cloudaicompanionProject:'standby-project'});
  if(url.includes('fetchAvailableModels'))return Response.json({models:{'gemini-test':{quotaInfo:{remainingFraction:1}}}});
  summaryHosts.push(new URL(url).host);assert.equal(options.headers.Authorization,`Bearer ${f.b.token.access_token}`);
  return Response.json({groups:[{displayName:'Gemini Models',buckets:[{bucketId:'gemini-5h',window:'5h',remainingFraction:.61},{bucketId:'gemini-weekly',window:'weekly',remainingFraction:.37}]}]});
 };
 const fresh=await f.manager.refreshQuota(f.b.id,cloud);const q=f.manager.getAccountQuotaOverview(fresh);
 assert.deepEqual(summaryHosts,['cloudcode-pa.googleapis.com','daily-cloudcode-pa.googleapis.com','daily-cloudcode-pa.sandbox.googleapis.com']);assert.equal(q.geminiFiveHourRemaining,61);assert.equal(q.geminiWeeklyRemaining,37);assert.equal(fresh.quota_refresh_error,null);assert.equal((await f.manager.loadIndex()).current_account_id,f.a.id);
});
test('HTTP 200 缺 Gemini 分组时继续下一端点，合并分组而非提前假成功',async t=>{
 const f=await fixture(t);let calls=0;
 const cloud=async(url)=>{
  if(url.includes('loadCodeAssist'))return Response.json({});
  if(url.includes('fetchAvailableModels'))return Response.json({models:{'gemini-test':{quotaInfo:{remainingFraction:1}}}});
  calls++;
  return Response.json({groups:calls===1?[{displayName:'Claude and GPT models',buckets:[{bucketId:'3p-weekly',window:'weekly',remainingFraction:.22}]}]:[{displayName:'Gemini Models',buckets:[{bucketId:'gemini-5h',window:'5h',remainingFraction:.64},{bucketId:'gemini-weekly',window:'weekly',remainingFraction:.39}]}]});
 };
 const fresh=await f.manager.refreshQuota(f.b.id,cloud);const q=f.manager.getAccountQuotaOverview(fresh);assert.equal(calls,3);assert.equal(q.geminiFiveHourRemaining,64);assert.equal(q.geminiWeeklyRemaining,39);assert.equal(q.claudeWeeklyRemaining,22);
});

test('Google 授权保存核实邮箱且不切换账号，未验证邮箱与取消不得写入',async t=>{
 const f=await fixture(t);const token={access_token:'oauth-access',refresh_token:'oauth-refresh',expires_in:3600};const before=(await f.manager.loadIndex()).accounts.length;
 await assert.rejects(f.manager.addAccountFromOAuth(token,new AbortController().signal,async()=>Response.json({email:'other@test.example',verified_email:false})),/已验证/);
 assert.equal((await f.manager.loadIndex()).accounts.length,before);
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(f.manager.addAccountFromOAuth(token,cancelled.signal,async()=>Response.json({email:'other@test.example',verified_email:true})));
 assert.equal((await f.manager.loadIndex()).accounts.length,before);
 await f.manager.addAccountFromOAuth(token,new AbortController().signal,async()=>Response.json({email:'other@test.example',verified_email:true,name:'Other'}));assert.equal((await f.manager.loadIndex()).accounts.length,before+1);assert.equal((await f.manager.loadIndex()).current_account_id,f.a.id);
});

test('仅有 Gemini 每周配额时保留真实每周值，五小时保持未知且不伪造窗口，Starter订阅不露出',async t=>{
 const f=await fixture(t);
 const cloud=async url=>url.includes('loadCodeAssist')?Response.json({currentTier:{name:'Antigravity Starter Quota'}}):url.includes('fetchAvailableModels')?Response.json({models:{'gemini-test':{quotaInfo:{remainingFraction:1}}}}):Response.json({groups:[{displayName:'Gemini Models',buckets:[{bucketId:'gemini-weekly',window:'weekly',remainingFraction:.73}]}]});
 const fresh=await f.manager.refreshQuota(f.b.id,cloud);const q=f.manager.getAccountQuotaOverview(fresh);assert.equal(q.geminiWeeklyRemaining,73);assert.equal(q.geminiFiveHourRemaining,null);assert.equal(fresh.quota_refresh_error,null);assert.equal(q.subscriptionTier,'');
});
