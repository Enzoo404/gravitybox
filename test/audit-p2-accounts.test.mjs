import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountsManager } from '../dist/accounts.js';

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

test('C03: exportAccounts 默认脱敏；只有 confirm:true 才包含 refresh_token', async () => {
  const dir = await sandbox('gb-p2-export-');
  try {
    const mgr = new AccountsManager(dir);
    const secret = 'SYNTHETIC_REFRESH_TOKEN_1234567890';
    await mgr.upsertAccount({ email: 'export@example.test', refreshToken: secret, accessToken: 'SYNTHETIC_ACCESS_TOKEN', expiresIn: 3600 });

    const masked = await mgr.exportAccounts();
    assert.equal(masked.tokens_included, false);
    assert.equal(masked.confirm_required, true);
    assert.equal(masked.accounts[0].refresh_token, '[REDACTED]');
    assert.equal(Object.hasOwn(masked.accounts[0], 'access_token'), false, '导出不得包含临时 access_token');
    assert.equal(JSON.stringify(masked).includes(secret), false, '缺省导出响应不得泄漏真实 refresh_token');

    const confirmed = await mgr.exportAccounts(undefined, { confirm: true });
    assert.equal(confirmed.tokens_included, true);
    assert.equal(confirmed.confirm_required, false);
    assert.equal(confirmed.accounts[0].refresh_token, secret, '确认导出才可包含 refresh_token（迁移/恢复用）');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

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
