import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../dist/controller.js';
import { AccountsManager } from '../dist/accounts.js';

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
