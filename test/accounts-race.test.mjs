import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import 'node:crypto';
import { AccountsManager } from '../dist/accounts.js';
import { commitAccountAndIndex } from '../dist/files.js';

function makeAccount(id, email, label = null) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    email,
    name: '测试用户',
    token: {
      access_token: `access-${id}`,
      refresh_token: `refresh-${id}`,
      expires_in: 3600,
      expiry_timestamp: now + 3600,
      token_type: 'Bearer',
      email,
      project_id: null,
      is_gcp_tos: false,
      id_token: null,
    },
    device_profile: { machine_id: 'mach', mac_address: '11:22:33:44:55:66' },
    quota: null,
    disabled: false,
    protected_models: [],
    validation_blocked: false,
    created_at: now,
    last_used: now,
    custom_label: label,
  };
}

test('S2 并发事务: upsertAccount 在并发刷新间隙不覆盖更新后的云端配额 (H2 防退回)', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-race-upsert-'));
  try {
    const mgr = new AccountsManager(sandbox);
    const initial = await mgr.upsertAccount({
      email: 'race-quota@test.com',
      refreshToken: 'tok-init',
      customLabel: '原始备注',
    });

    const refreshedQuota = {
      models: [{ name: 'gemini-2.5-pro', percentage: 95, reset_time: '2026-10-18T00:00:00Z' }],
      quota_groups: [],
      is_forbidden: false,
      subscription_tier: 'ULTRA',
      last_updated: Math.floor(Date.now() / 1000),
      model_forwarding_rules: {},
    };

    // 并发触发：一方面后台配额刷新完成，另一方面用户并发修改备注
    const refreshPromise = mgr.saveRefreshedAccount({
      ...initial,
      quota: refreshedQuota,
    });

    const editPromise = mgr.upsertAccount({
      id: initial.id,
      email: initial.email,
      customLabel: '并发修改的新备注',
    });

    await Promise.all([refreshPromise, editPromise]);

    const finalAccount = await mgr.getAccount(initial.id);
    assert.ok(finalAccount);
    assert.equal(finalAccount.custom_label, '并发修改的新备注', '用户修改的备注必须保留');
    assert.equal(finalAccount.quota?.subscription_tier, 'ULTRA', '后台刷新的配额绝不能被 upsert 回退为 null');
    assert.equal(finalAccount.quota?.models[0]?.percentage, 95);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('S2 并发事务: updateAccount 原子读-改-写支持高频并发累加不丢更新', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-race-update-'));
  try {
    const mgr = new AccountsManager(sandbox);
    const acc = await mgr.upsertAccount({
      email: 'atomic-update@test.com',
      refreshToken: 'tok-atomic',
      customLabel: '0',
    });

    // 5 路并发通过 updateAccount 累加计数
    const updates = Array.from({ length: 5 }, (_, i) =>
      mgr.updateAccount(acc.id, current => {
        const count = parseInt(current.custom_label || '0', 10);
        current.custom_label = String(count + 1);
        return i;
      })
    );

    const results = await Promise.all(updates);
    assert.equal(results.length, 5);

    const finalAcc = await mgr.getAccount(acc.id);
    assert.equal(finalAcc?.custom_label, '5', '5 次并发原子更新后结果必须为 5，无 Lost Update');
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('S2 并发事务: setCurrentAccount 并发切换保证索引原子性与一致性 (H3)', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-race-setcurrent-'));
  try {
    const mgr = new AccountsManager(sandbox);
    const a1 = await mgr.upsertAccount({ email: 'target1@test.com', refreshToken: 'tok-1' });
    const a2 = await mgr.upsertAccount({ email: 'target2@test.com', refreshToken: 'tok-2' });
    const a3 = await mgr.upsertAccount({ email: 'target3@test.com', refreshToken: 'tok-3' });

    // 三路并发切号
    await Promise.all([
      mgr.setCurrentAccount(a1.id, 'app'),
      mgr.setCurrentAccount(a2.id, 'all'),
      mgr.setCurrentAccount(a3.id, 'app'),
    ]);

    const index = await mgr.loadIndex();
    assert.ok(index.current_account_id);
    assert.ok([a1.id, a2.id, a3.id].includes(index.current_account_id), '当前账号必须是合法候选之一');
    assert.equal(index.accounts.length, 3, '索引账号列表不应在并发切换时损坏或丢失');
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('S2 并发优化: syncFromExternalAgySwitch 并发调用由 Single-Flight 合并 (H8)', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-race-sync-'));
  const extDir = join(sandbox, 'ext');
  await mkdir(join(extDir, 'accounts'), { recursive: true });

  const extAcc = makeAccount('ext-1', 'external-singleflight@test.com');
  await writeFile(join(extDir, 'accounts', 'ext-1.json'), JSON.stringify(extAcc));

  try {
    const mgr = new AccountsManager(sandbox, { externalDir: extDir });
    // 同时发起 3 个并发外部同步调用
    const [r1, r2, r3] = await Promise.all([
      mgr.syncFromExternalAgySwitch(),
      mgr.syncFromExternalAgySwitch(),
      mgr.syncFromExternalAgySwitch(),
    ]);

    assert.equal(r1.imported + r2.imported + r3.imported >= 1, true);
    const index = await mgr.loadIndex();
    assert.equal(index.accounts.filter(a => a.email === 'external-singleflight@test.com').length, 1, '外部账号只能被导入一次');
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('S2 原子持久化: commitAccountAndIndex 成对写入并 fsync (M2/H10)', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-commit-pair-'));
  try {
    const accPath = join(sandbox, 'accounts', 'test-pair.json');
    const idxPath = join(sandbox, 'accounts.json');

    const accData = { id: 'test-pair', email: 'pair@test.com' };
    const idxData = { version: '2.0', accounts: [{ id: 'test-pair', email: 'pair@test.com' }], current_account_id: 'test-pair' };

    await commitAccountAndIndex(accPath, accData, idxPath, idxData);

    const readAcc = JSON.parse(await readFile(accPath, 'utf8'));
    const readIdx = JSON.parse(await readFile(idxPath, 'utf8'));

    assert.equal(readAcc.email, 'pair@test.com');
    assert.equal(readIdx.current_account_id, 'test-pair');
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
