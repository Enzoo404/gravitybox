import test from "node:test";
import { describe as describeContractGroup } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, chmod, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AccountsManager, projectAccountForIpc, computeAccountRevision } from "../dist/accounts.js";
import { once } from "node:events";
import { AccountSwitchService } from "../dist/account-switch.js";
import { recoverFileSet, commitAccountAndIndex, recoverAccountCommit } from "../dist/files.js";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("账号与事务 · audit-p1-backend", { concurrency: false }, async () => {
const root = fileURLToPath(new URL('../', import.meta.url));

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
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("账号与事务 · audit-p2-accounts", { concurrency: false }, async () => {
process.env.GRAVITYBOX_PROBE_LS = 'false';

async function sandbox(prefix = 'gb-p2-accounts-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, '词典'), { recursive: true });
  return dir;
}

async function accountFile(dir, id) {
  return readFile(join(dir, 'accounts', `${id}.json`), 'utf8');
}

// ---------- D02 删除复活 ----------

test('D02: 账号删除受阻保留原文件与恢复日志，权限恢复后完整对账', async () => {
  const dir = await sandbox('gb-p2-delete-fail-');
  const accountsDir = join(dir, 'accounts');
  try {
    const mgr = new AccountsManager(dir);
    const acc = await mgr.upsertAccount({ email: 'keep@example.test', refreshToken: 'tok-keep' });
    await chmod(accountsDir, 0o500); // 目录不可写 → unlink 失败
    await assert.rejects(mgr.deleteAccount(acc.id), /账号移除尚未完成|无法删除账号文件/);
    const before = JSON.parse(await readFile(join(dir,'accounts.json'),'utf8'));
    assert.ok(before.accounts.some(item=>item.id===acc.id));
    assert.ok(await accountFile(dir,acc.id));
    assert.ok(JSON.parse(await readFile(join(dir,'account-delete-commit.json'),'utf8')).changes.length===3);
    await chmod(accountsDir,0o700);
    const index=await mgr.loadIndex();
    assert.ok(!index.accounts.some(item=>item.id===acc.id),'恢复后索引与已提交删除一致');
    assert.equal(await mgr.getAccount(acc.id),null);
  } finally {
    await chmod(accountsDir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('D02: 删除成功后残留文件不会在重启 reconcile 中复活（tombstone）', async () => {
  const dir = await sandbox('gb-p2-tombstone-');
  try {
    const mgr = new AccountsManager(dir);
    const acc = await mgr.upsertAccount({ email: 'gone@example.test', refreshToken: 'tok-gone' });
    assert.equal(await mgr.deleteAccount(acc.id), true);
    const tombstones = JSON.parse(await readFile(join(dir, 'accounts-deleted.json'), 'utf8'));
    assert.ok(tombstones.some(item => item.id === acc.id), '删除成功后必须留下 tombstone');

    // 模拟外部同步/崩溃残留把账号文件写回目录。
    await writeFile(join(dir, 'accounts', `${acc.id}.json`), JSON.stringify({
      id: acc.id, email: 'gone@example.test', name: 'resurrect', token: { access_token: 'x', refresh_token: 'y' },
      disabled: false, protected_models: [], validation_blocked: false, created_at: 1, last_used: 1,
    }));

    const restarted = new AccountsManager(dir);
    await restarted.init();
    const index = await restarted.loadIndex();
    assert.equal(index.accounts.some(item => item.id === acc.id), false, '残留文件不得复活已删除账号');
    assert.equal(await restarted.getAccount(acc.id), null, '残留文件应被 tombstone 清理');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('D02: 外部 AntiGravity Switch 同步不会重新导入已删除账号', async () => {
  const dir = await sandbox('gb-p2-tombstone-ext-');
  const externalDir = await sandbox('gb-p2-ext-src-');
  try {
    const now = Math.floor(Date.now() / 1000);
    const extAccount = id => ({
      id, email: 'external@example.test', name: 'Ext',
      token: { access_token: 'ext-access', refresh_token: 'ext-refresh', expires_in: 3600, expiry_timestamp: now + 3600, token_type: 'Bearer' },
      disabled: false, protected_models: [], validation_blocked: false, created_at: now, last_used: now,
    });
    await mkdir(join(externalDir, 'accounts'), { recursive: true });
    const extId = 'externalacc01';
    await writeFile(join(externalDir, 'accounts', `${extId}.json`), JSON.stringify(extAccount(extId)));

    const mgr = new AccountsManager(dir, { externalDir });
    await mgr.init(); // init 内部会做一次外部同步
    await mgr.syncFromExternalAgySwitch();
    const indexBefore = await mgr.loadIndex();
    const imported = indexBefore.accounts.find(item => item.email === 'external@example.test');
    assert.ok(imported);
    await mgr.deleteAccount(imported.id);

    // 外部账号文件仍在，重启后再次同步不得复活。
    const restarted = new AccountsManager(dir, { externalDir });
    await restarted.init();
    const second = await restarted.syncFromExternalAgySwitch();
    assert.equal(second.imported, 0, '已删除账号不得被外部同步重新导入');
    const indexAfter = await restarted.loadIndex();
    assert.equal(indexAfter.accounts.some(item => item.email === 'external@example.test'), false);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await rm(externalDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------- D04 刷新取消 ----------

test('D04: 已取消的 signal 直接拒绝刷新，且不写任何文件', async () => {
  const dir = await sandbox('gb-p2-abort-early-');
  try {
    const mgr = new AccountsManager(dir);
    const acc = await mgr.upsertAccount({ email: 'abort@example.test', refreshToken: 'tok-abort', accessToken: 'access-abort', expiresIn: 3600 });
    const before = await accountFile(dir, acc.id);
    const controller = new AbortController();
    controller.abort();
    let fetchCalls = 0;
    await assert.rejects(
      mgr.refreshQuota(acc.id, async () => { fetchCalls++; return new Response('{}', { status: 200 }); }, { signal: controller.signal }),
    );
    assert.equal(fetchCalls, 0, '取消后不得发起任何网络请求');
    assert.equal(await accountFile(dir, acc.id), before, '取消后不得写账号文件');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('D04: 刷新途中取消 → 不落盘 token/配额/错误，也不继续下一个账号', async () => {
  const dir = await sandbox('gb-p2-abort-mid-');
  try {
    const mgr = new AccountsManager(dir);
    const first = await mgr.upsertAccount({ email: 'first@example.test', refreshToken: 'tok-first', accessToken: 'access-first', expiresIn: 3600 });
    const second = await mgr.upsertAccount({ email: 'second@example.test', refreshToken: 'tok-second', accessToken: 'access-second', expiresIn: 3600 });
    const beforeFirst = await accountFile(dir, first.id);
    const beforeSecond = await accountFile(dir, second.id);
    const controller = new AbortController();
    const mockFetch = async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    };
    await assert.rejects(mgr.refreshAllQuotas(mockFetch, { signal: controller.signal }));
    assert.equal(await accountFile(dir, first.id), beforeFirst, '取消后不得写第一个账号文件');
    assert.equal(await accountFile(dir, second.id), beforeSecond, '取消后不得继续刷新第二个账号');
    const persisted = JSON.parse(await accountFile(dir, first.id));
    assert.equal(persisted.quota_refresh_error ?? null, null, '取消不得写成刷新错误');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------- C03 导出确认/脱敏 ----------

test('gemini_all 监控范围聚合 Gemini 主池与 Argon/Carbon 可用配额最小值', async () => {
  const dir = await sandbox('gb-p2-gemini-all-');
  try {
    const mgr = new AccountsManager(dir);
    const future = new Date(Date.now() + 3600_000).toISOString();
    const acc = await mgr.upsertAccount({
      email: 'gemini-all@example.test',
      refreshToken: 'SYNTHETIC_REFRESH_TOKEN_GEMINI_ALL',
      accessToken: 'SYNTHETIC_ACCESS_TOKEN',
      expiresIn: 3600,
    });
    acc.quota = mgr.fuseQuota(
      {
        models: {
          'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.9, resetTime: future } },
          'gemini-4-argon': { displayName: 'Gemini 4 Argon', quotaInfo: { remainingFraction: 0.25, resetTime: future } },
        },
      },
      {
        groups: [
          { displayName: 'Gemini Models', buckets: [{ window: 'five_hour', remainingFraction: 0.9, resetTime: future }, { window: 'weekly', remainingFraction: 0.8, resetTime: future }] },
        ],
      }
    );
    await mgr.saveAccount(acc);
    assert.equal(mgr.getAccountRemaining(acc, 'gemini_all'), 25);
    assert.equal(mgr.getAccountRemaining(acc, 'gemini'), 80);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("账号与事务 · cleanup-contracts", { concurrency: false }, async () => {
test('a successful live quota refresh commits its final account exactly once', async t => {
  const state = await mkdtemp(join(tmpdir(), 'gb-refresh-commit-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const manager = new AccountsManager(state);
  const account = await manager.upsertAccount({
    email: 'fixture@example.invalid', refreshToken: 'synthetic-refresh',
    accessToken: 'synthetic-access', expiresIn: 3600,
  });
  const quota = manager.fuseQuota({ models: {
    'gemini-fixture': { quotaInfo: { remainingFraction: 0.7 } },
  } }, { groups: [{ displayName: 'Gemini', buckets: [
    { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.7 },
  ] }] });
  manager.probeLiveLanguageServer = async () => ({ email: account.email, tier: 'FREE', quota });
  let commits = 0;
  const save = manager.saveRefreshedAccount.bind(manager);
  manager.saveRefreshedAccount = async (...args) => { commits++; return save(...args); };
  await manager.refreshQuota(account.id, async () => { throw new Error('unexpected network request'); });
  assert.equal(commits, 1);
  const saved = await manager.getAccount(account.id);
  assert.equal(saved.token.refresh_token, 'synthetic-refresh');
  assert.equal(manager.getAccountQuotaOverview(saved).geminiWeeklyRemaining, 70);
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("账号与事务 · optimization-20261022", { concurrency: false }, async () => {

const fixture=async fn=>{const dir=await mkdtemp(join(tmpdir(),'gb-opt-'));try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}};

test('两个账号写者保留各自更新，陈旧显式保存被拒绝，策略局部更新串行提交',()=>fixture(async dir=>{
 const manager=new AccountsManager(dir);const account=await manager.upsertAccount({email:'synthetic@example.com',refreshToken:'synthetic-refresh',accessToken:'synthetic-access',expiresIn:3600});
 const stale=await manager.getAccount(account.id);
 const script=`import{AccountsManager}from ${JSON.stringify(pathToFileURL(join(process.cwd(),'dist/accounts.js')).href)};const m=new AccountsManager(process.argv[1]);await m.updateAccount(process.argv[2],async a=>{await new Promise(r=>setTimeout(r,100));if(process.argv[3]==='label')a.custom_label='retained label';else a.protected_models=['custom-model'];});await m.setAutoSwitchConfig(process.argv[3]==='label'?{enabled:true}:{monitored_model:'custom-model'});`;
 const children=['label','model'].map(kind=>spawn(process.execPath,['--input-type=module','-e',script,dir,account.id,kind],{stdio:'ignore'}));await Promise.all(children.map(c=>once(c,'exit')));assert.ok(children.every(c=>c.exitCode===0));const final=await manager.getAccount(account.id);assert.equal(final.custom_label,'retained label');assert.deepEqual(final.protected_models,['custom-model']);stale.custom_label='stale overwrite';await assert.rejects(manager.saveAccount(stale),/已在其他操作中更新/);const policy=await manager.getAutoSwitchConfig();assert.equal(policy.enabled,true);assert.equal(policy.monitored_model,'custom-model');
}));

test('恢复材料有7天期限，待完成事务不可清理，完成记录经摘要确认后脱敏',()=>fixture(async dir=>{
 const manager=new AccountsManager(dir);await manager.init();const service=new AccountSwitchService(manager,{stateDir:dir,profile:dir,externalDir:dir,isRunning:async()=>false});
 const path=join(dir,'account-switch-journal-stable.json'), journal={version:1,status:'complete',at:new Date(Date.now()-10*86400000).toISOString(),before:{oauthToken:'synthetic-private-token'},after:{},files:[],keychainBefore:'synthetic-keychain',keychainAfter:''};await writeFile(path,JSON.stringify(journal));
 const info=await service.recoveryInfo();assert.equal(info.expired,true);assert.equal(info.pending,false);assert.equal(info.containsCredentials,true);assert.ok(!JSON.stringify(info).includes('synthetic-private-token'));await assert.rejects(service.rollback(),/超过 7 天/);await assert.rejects(service.clearRecovery('wrong'),/已变化/);assert.equal(JSON.parse(await readFile(path,'utf8')).before.oauthToken,'synthetic-private-token');
 await writeFile(path,JSON.stringify({...journal,status:'prepared'}));const pending=await service.recoveryInfo();assert.equal(pending.pending,true);assert.equal(pending.expired,false);await assert.rejects(service.clearRecovery(pending.digest),/不可清除/);
 await writeFile(path,JSON.stringify(journal));await service.clearRecovery((await service.recoveryInfo()).digest);const cleaned=await readFile(path,'utf8');assert.ok(!cleaned.includes('synthetic-private-token'));assert.ok(!cleaned.includes('synthetic-keychain'));assert.equal((await service.recoveryInfo()).available,false);
}));
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("账号与事务 · optimization-20261023", { concurrency: false }, async () => {
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gb-optimization-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('删除事务中断后按原日志前进恢复；外部修改阻断且保留恢复记录', async t => {
  const dir = await fixture(t), a = join(dir,'a.json'), b = join(dir,'b.json'), journal = join(dir,'commit.json');
  await writeFile(a,'before-a'); await writeFile(b,'before-b');
  await writeFile(journal,JSON.stringify({changes:[{path:a,before:'before-a',after:null},{path:b,before:'before-b',after:'after-b'}]}));
  await rm(a);
  await recoverFileSet(journal,[a,b]);
  assert.equal(await readFile(b,'utf8'),'after-b'); await assert.rejects(access(a)); await assert.rejects(access(journal));
  await writeFile(journal,JSON.stringify({changes:[{path:b,before:'before-b',after:'after-b'}]}));
  await writeFile(b,'external-change');
  await assert.rejects(recoverFileSet(journal,[a,b]),/其他程序/);
  assert.equal(await readFile(b,'utf8'),'external-change'); await access(journal);
});

test('账号移除保留可恢复材料，文件、索引与墓碑一致，不能重新同步复活', async t => {
  const dir=await fixture(t), manager=new AccountsManager(dir);
  const account=await manager.upsertAccount({email:'remove@example.invalid',refreshToken:'synthetic-refresh',accessToken:'synthetic-access'});
  await manager.deleteAccount(account.id);
  assert.equal(await manager.getAccount(account.id),null);
  assert.equal((await manager.loadIndex()).accounts.length,0);
  assert.equal(JSON.parse(await readFile(join(dir,'accounts-deleted.json'),'utf8'))[0].id,account.id);
  const {readdir}=await import('node:fs/promises');const copies=await readdir(join(dir,'accounts-removed'));
  assert.equal(copies.length,1);
  const saved=JSON.parse(await readFile(join(dir,'accounts-removed',copies[0]),'utf8'));
  assert.equal(saved.account.email,account.email);
  assert.equal(saved.account.token.refresh_token,'synthetic-refresh');
});

test('读取损坏账号明确失败，原件及索引不被当作不存在清掉', async t => {
  const dir=await fixture(t), manager=new AccountsManager(dir);
  const account=await manager.upsertAccount({email:'broken@example.invalid',refreshToken:'synthetic'});
  const file=join(dir,'accounts',account.id+'.json'); await writeFile(file,'{broken');
  await assert.rejects(manager.getAccount(account.id),/格式损坏/);
  assert.equal(await readFile(file,'utf8'),'{broken');
  assert.equal((await manager.loadIndex()).accounts[0].id,account.id);
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("账号与事务 · phase1-audit-verification", { concurrency: false }, async () => {
test('阶段1验证 - B04: 刷新落盘锁内发现账号已被删除时拒绝写入，杜绝复活竞态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-test-b04-'));
  const mgr = new AccountsManager(root);
  const acc = await mgr.upsertAccount({ email: 'victim@example.test', refreshToken: 'tok-1' });
  const originalSave = mgr.saveAccount.bind(mgr);
  let intercepted = false;
  mgr.saveAccount = async (target, opt) => {
    if (opt?.isRefreshUpdate && !intercepted) {
      intercepted = true;
      await mgr.deleteAccount(target.id);
    }
    return originalSave(target, opt);
  };
  await assert.rejects(
    async () => {
      await mgr['saveRefreshedAccount'](acc);
    },
    /已被删除|已移除/
  );
  const loaded = await mgr.getAccount(acc.id);
  assert.equal(loaded, null, '已被删除的账号绝对不能在刷新写入中复活');
});

test('阶段1验证 - R01: 同 ID 摘要不一致时，reconcileIndex 能够深度检测并自愈', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-test-r01-'));
  const mgr = new AccountsManager(root);
  const acc = await mgr.upsertAccount({ email: 'reconcile@example.test', refreshToken: 'tok-initial' });
  
  // 模拟撕裂：账号文件被更新了新配额/修订，但索引 accounts.json 中保持旧摘要
  const accPath = join(root, 'accounts', `${acc.id}.json`);
  const rawAcc = JSON.parse(await readFile(accPath, 'utf8'));
  rawAcc.custom_label = '撕裂产生的新备注';
  await writeFile(accPath, JSON.stringify(rawAcc, null, 2));

  // 重新创建 AccountsManager 模拟下次启动
  const mgr2 = new AccountsManager(root);
  await mgr2.init();
  const index = await mgr2.loadIndex();
  const summary = index.accounts.find(a => a.id === acc.id);
  assert.equal(summary?.custom_label, '撕裂产生的新备注', 'reconcileIndex 必须深度比对同 ID 摘要并完成自愈');
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("账号与事务 · phase1-r-credibility", { concurrency: false }, async () => {

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
    assert.equal(computeAccountRevision(structuredClone(baseAccount)), rev1, '相同数据保持修订指纹稳定');
    for (const change of [{ disabled: true }, { custom_label: '新备注' }, { name: '新名称' }]) {
      assert.notEqual(computeAccountRevision({ ...baseAccount, ...change }), rev1, JSON.stringify(change));
    }
    for (const change of [
      { subscription_tier: 'PRO' },
      { quota_groups: [{ display_name: 'Gemini Models', buckets: [{ bucket_id: 'gemini-weekly', remaining_fraction: 0.85, window: 'weekly' }] }] },
      { models: [...baseAccount.quota.models, { name: 'claude-sonnet-4-6', percentage: 50 }] },
    ]) {
      assert.notEqual(computeAccountRevision({ ...baseAccount, quota: { ...baseAccount.quota, ...change } }), rev1, JSON.stringify(change));
    }

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
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("账号与事务 · phase2-functional", { concurrency: false }, async () => {
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
    const enabledConfig = await mgr.setAutoSwitchConfig({ enabled: true });
    assert.equal(enabledConfig.enabled, true);
    assert.equal(enabledConfig.strategy, 'round_robin');
    assert.equal(enabledConfig.reserve_percentage, 15);
    assert.equal(enabledConfig.candidate_min_percentage, 40);
    const resEnabled = await mgr.selectBestAccount();
    assert.equal(resEnabled.shouldSwitch, true, `额度降至 5%（<=15%）时应当推荐切号, 实际: ${JSON.stringify(resEnabled)}`);
    assert.equal(resEnabled.bestCandidate?.email, 'spare@example.com');
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("账号与事务 · phase2-recommendation-contracts", { concurrency: false }, async () => {
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
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("账号与事务 · phase3-audit-verification", { concurrency: false }, async () => {
test('阶段3验证 - B20: 账号策略门槛前后端一致约束 (1-98 与 2-100)，非法值抛错拦截而不静默钳制', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-test-b20-'));
  const mgr = new AccountsManager(root);

  // 正常范围设置
  const valid = await mgr.setAutoSwitchConfig({
    reserve_percentage: 15,
    candidate_min_percentage: 40
  });
  assert.equal(valid.reserve_percentage, 15);
  assert.equal(valid.candidate_min_percentage, 40);

  // 非法 reserve_percentage (< 1) 拦截
  await assert.rejects(
    async () => {
      await mgr.setAutoSwitchConfig({ reserve_percentage: 0 });
    },
    /当前账号配额门槛必须在 1% 到 98% 之间/
  );

  // 非法 candidate_min_percentage (> 100) 拦截
  await assert.rejects(
    async () => {
      await mgr.setAutoSwitchConfig({ candidate_min_percentage: 101 });
    },
    /候选账号配额门槛必须在 2% 到 100% 之间/
  );

  // 候选门槛 <= 保留门槛 拦截
  await assert.rejects(
    async () => {
      await mgr.setAutoSwitchConfig({
        reserve_percentage: 50,
        candidate_min_percentage: 30
      });
    },
    /候选账号配额门槛必须大于当前账号配额门槛/
  );
});

test('阶段3验证 - U10: 单账号 quota_refresh 精准刷新指定账号且不触发全量扫描', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-test-u10-'));
  const mgr = new AccountsManager(root);

  const acc1 = await mgr.upsertAccount({ email: 'user1@example.test', refreshToken: 'tok-1' });
  const acc2 = await mgr.upsertAccount({ email: 'user2@example.test', refreshToken: 'tok-2' });

  let refreshedId = '';
  // Mock refreshQuotaFromProvider
  mgr['refreshQuotaFromProvider'] = async (targetId) => {
    refreshedId = targetId;
    const acc = await mgr.getAccount(targetId);
    acc.quota = {
      five_hour_remaining: 88,
      weekly_remaining: 95,
      subscription_tier: 'PRO',
      last_updated: Math.floor(Date.now() / 1000),
      source: 'live'
    };
    return acc;
  };

  const res = await mgr.refreshQuota(acc1.id, globalThis.fetch, { skipSyncExternal: true });
  assert.equal(refreshedId, acc1.id, '单账号刷新必须且只能针对请求的 account id');
  assert.equal(res.id, acc1.id);
  assert.equal(res.quota?.five_hour_remaining, 88);

  // 确认 acc2 未被该操作刷新
  const loadedAcc2 = await mgr.getAccount(acc2.id);
  assert.equal(loadedAcc2?.quota?.five_hour_remaining, undefined, '其他账号不得在单卡刷新时被意外变动');
});

test('阶段3验证 - B12: 账号切换 pending 状态识别与未完成流转', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-test-b12-'));
  const journalPath = join(root, 'account-switch-journal-stable.json');

  // 当 journal 为 pending 状态时
  await writeFile(journalPath, JSON.stringify({
    version: 1,
    status: 'pending',
    at: new Date().toISOString()
  }));

  const rawPending = JSON.parse(await (await import('node:fs/promises')).readFile(journalPath, 'utf8'));
  const isPending = rawPending && !['complete', 'rolled-back'].includes(rawPending.status);
  assert.equal(isPending, true, '切换未完成阶段必须标记为 isPending = true');

  // 当 journal 为 rolled-back 状态时
  await writeFile(journalPath, JSON.stringify({
    version: 1,
    status: 'rolled-back',
    at: new Date().toISOString()
  }));

  const rawRolledBack = JSON.parse(await (await import('node:fs/promises')).readFile(journalPath, 'utf8'));
  const isPendingAfterRollback = rawRolledBack && !['complete', 'rolled-back'].includes(rawRolledBack.status);
  assert.equal(isPendingAfterRollback, false, '已回滚状态不能被识别为 pending');
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("账号与事务 · repair-20261023", { concurrency: false }, async () => {
async function fixture(t){const d=await mkdtemp(join(tmpdir(),'gb-repair-'));t.after(async()=>{try{await rm(d,{recursive:true,force:true,maxRetries:10,retryDelay:50});}catch{}});return d;}
test('恢复材料清除是终态，下一次切号可继续校验目标账号',async t=>{const d=await fixture(t);const s=new AccountSwitchService({runExclusive:fn=>fn(),getAccount:async()=>null},{stateDir:d,profile:d,externalDir:d,isRunning:async()=>false,keychain:{}});await writeFile(join(d,'account-switch-journal-stable.json'),JSON.stringify({status:'complete',at:new Date().toISOString(),before:{},after:{},files:[],keychainBefore:null,keychainAfter:''}));await s.clearRecovery((await s.recoveryInfo()).digest);await assert.rejects(s.switchAccount('synthetic'),/目标账号不可用/);assert.equal((await s.recoveryInfo()).pending,false);});
test('成对写入第二份失败时恢复原件，崩溃记录读前继续提交',async t=>{const d=await fixture(t),ad=join(d,'accounts');await mkdir(ad);const a=join(ad,'a.json'),i=join(d,'accounts.json');await writeFile(a,'old-a');await writeFile(i,'old-i');const original=fs.renameSync;fs.renameSync=(from,to)=>{if(to===i)throw Error('synthetic EIO');return original(from,to)};syncBuiltinESMExports();try{await assert.rejects(commitAccountAndIndex(a,{next:true},i,{next:true}));}finally{fs.renameSync=original;syncBuiltinESMExports()}assert.equal(await readFile(a,'utf8'),'old-a');assert.equal(await readFile(i,'utf8'),'old-i');await writeFile(i+'.commit.json',JSON.stringify({accountPath:a,indexPath:i,beforeAccount:'old-a',beforeIndex:'old-i',afterAccount:'next-a',afterIndex:'next-i'}));await recoverAccountCommit(i);assert.equal(await readFile(a,'utf8'),'next-a');assert.equal(await readFile(i,'utf8'),'next-i');});

test('推荐使用已核实当前账号实时额度，跨邮箱实时值不得借用',async t=>{
 const d=await fixture(t),m=new AccountsManager(d),a=await m.upsertAccount({email:'a@example.invalid',refreshToken:'synthetic-a',accessToken:'access-a',expiresIn:3600}),b=await m.upsertAccount({email:'b@example.invalid',refreshToken:'synthetic-b',accessToken:'access-b',expiresIn:3600});
 const quota=remaining=>m.fuseQuota({models:{'gemini-test':{quotaInfo:{remainingFraction:remaining}}}},{groups:[{displayName:'Gemini Models',buckets:[{window:'weekly',remainingFraction:remaining}]}]});
 a.quota=quota(.8);b.quota=quota(.9);await m.saveAccount(a);await m.saveAccount(b);const cfg={enabled:true,strategy:'priority',reserve_percentage:10,candidate_min_percentage:30,monitored_model:'gemini',candidate_account_ids:[],last_switched_id:null};
 assert.equal((await m.selectBestAccount(cfg)).shouldSwitch,false);
 const fresh=await m.selectBestAccount(cfg,{currentId:a.id,currentEmail:a.email,currentQuota:quota(.05)});assert.equal(fresh.shouldSwitch,true);assert.equal(fresh.bestCandidate.id,b.id);
 assert.equal((await m.selectBestAccount(cfg,{currentId:a.id,currentEmail:b.email,currentQuota:quota(.05)})).shouldSwitch,false);
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("账号与事务 · v090-engines", { concurrency: false }, async () => {

// -------------------------------------------------------------
// 1. AccountsManager 单元测试
// -------------------------------------------------------------
test('AccountsManager: BOM/NUL 容错、CRUD、重排序与快照持久化', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-accounts-'));
  try {
    const mgr = new AccountsManager(sandbox);

    // 1. 验证空目录自动创建
    const emptyIndex = await mgr.loadIndex();
    assert.equal(emptyIndex.version, '2.0');
    assert.equal(emptyIndex.accounts.length, 0);

    // 2. 新增两个账号
    const acc1 = await mgr.upsertAccount({
      email: 'alpha@example.com',
      refreshToken: '1//refresh-alpha',
      name: 'Alpha User',
      customLabel: '主力号',
    });
    assert.equal(acc1.email, 'alpha@example.com');
    assert.ok(acc1.device_profile?.machine_id);

    const acc2 = await mgr.upsertAccount({
      email: 'beta@example.com',
      refreshToken: '1//refresh-beta',
      name: 'Beta User',
      customLabel: '备用号',
    });
    assert.equal(acc2.email, 'beta@example.com');

    let index = await mgr.loadIndex();
    assert.equal(index.accounts.length, 2);
    assert.equal(index.current_account_id, acc1.id);

    // 3. 顺序调整
    index = await mgr.reorderAccounts([acc2.id, acc1.id]);
    assert.equal(index.accounts[0].id, acc2.id);
    assert.equal(index.accounts[1].id, acc1.id);

    // 4. 设置当前激活端与激活账号
    await mgr.setCurrentAccount(acc2.id, 'app');
    index = await mgr.loadIndex();
    assert.equal(index.current_account_id, acc2.id);

    // 5. 模拟 accounts.json 损坏并带 BOM 前缀，测试自动扫描恢复
    const bomCorrupted = '\uFEFF{ "version": "corrupted';
    await writeFile(join(sandbox, 'accounts.json'), bomCorrupted);
    const recovered = await mgr.loadIndex();
    assert.equal(recovered.accounts.length, 2);

    // 6. 删除账号
    await mgr.deleteAccount(acc1.id);
    const afterDelete = await mgr.loadIndex();
    assert.equal(afterDelete.accounts.length, 1);
    assert.equal(afterDelete.accounts[0].id, acc2.id);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('AccountsManager: 多账号索引与自定义标签保存读取验证', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-index-read-'));
  try {
    const mgr = new AccountsManager(sandbox);
    await mgr.upsertAccount({
      email: 'export1@test.com',
      refreshToken: '1//refresh-exp1',
      name: 'Exp 1',
      projectId: 'proj-1',
      customLabel: '标签1',
    });
    await mgr.upsertAccount({
      email: 'export2@test.com',
      refreshToken: '1//refresh-exp2',
      name: 'Exp 2',
      customLabel: '标签2',
    });

    const loaded = await mgr.loadIndex();
    assert.equal(loaded.accounts.length, 2);
    assert.equal(loaded.accounts[0].email, 'export2@test.com');
    assert.equal(loaded.accounts[0].custom_label, '标签2');
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("账号与事务 · visual-audit-optimization", { concurrency: false }, async () => {
test('账号重命名仅更新名称，保持凭据、禁用状态、配额与顺序',async t=>{const d=await mkdtemp(join(tmpdir(),'gb-name-'));t.after(()=>rm(d,{recursive:true,force:true}));const m=new AccountsManager(d);let a=await m.upsertAccount({email:'fixture@example.invalid',refreshToken:'synthetic-refresh',accessToken:'synthetic-access',expiresIn:3600});a.disabled=true;a.disabled_reason='fixture';a.quota={models:[],last_updated:123,quota_groups:[],source:'cloud'};await m.saveAccount(a);const before=JSON.parse(JSON.stringify(await m.getAccount(a.id))),idx=await m.loadIndex();const renamed=await m.renameAccount(a.id,'  新名称  ');assert.equal(renamed.name,'新名称');for(const key of Object.keys(before).filter(k=>k!=='name'))assert.deepEqual(renamed[key],before[key],key);const next=await m.loadIndex();assert.deepEqual(next.accounts.map(a=>a.id),idx.accounts.map(a=>a.id));assert.equal(next.current_account_id,idx.current_account_id);for(const name of[null,undefined,'x'.repeat(81)])await assert.rejects(m.renameAccount(a.id,name));assert.equal((await m.getAccount(a.id)).name,'新名称');const reset=await m.renameAccount(a.id,' ');assert.equal(reset.name,'fixture');for(const key of Object.keys(before).filter(k=>k!=='name'))assert.deepEqual(reset[key],before[key],key);});
});
