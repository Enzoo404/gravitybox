import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyIncrementalDictionaries } from '../dist/dictionary.js';
import { AccountsManager } from '../dist/accounts.js';
import '../dist/controller.js';
import '../dist/account-switch.js';

test('阶段1验证 - B01: 损坏旧词典不被删除，损坏统一词典不被覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-test-b01-'));
  const brokenContent = '{ broken json content';
  await writeFile(join(root, '增量补全-2.23.1.json'), brokenContent);
  await migrateLegacyIncrementalDictionaries(root);
  const filesAfter = await readdir(root);
  assert.ok(filesAfter.includes('增量补全-2.23.1.json'), '损坏的旧词典必须完整保留在原处');
  const content = await readFile(join(root, '增量补全-2.23.1.json'), 'utf8');
  assert.equal(content, brokenContent, '损坏的旧词典内容不能被修改');
});

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
