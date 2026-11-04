import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AccountsManager } from '../dist/accounts.js';

function account(id, email) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id, email, name: '本地账号',
    token: { access_token: 'tok', refresh_token: `refresh-${id}`, expires_in: 3600, expiry_timestamp: now + 3600, token_type: 'Bearer', email, project_id: null, is_gcp_tos: false, id_token: null },
    device_profile: { machine_id: 'm', mac_address: 'aa:bb:cc:dd:ee:ff' },
    quota: null, disabled: false, protected_models: [], validation_blocked: false,
    created_at: now, last_used: now, custom_label: null,
  };
}

test('崩溃窗口：账号文件已写、索引未写时，启动会自愈索引', async () => {
  const directory = await mkdtemp('/tmp/gb-reconcile-');
  await mkdir(join(directory, 'accounts'), { recursive: true });
  const id = randomUUID();
  await writeFile(join(directory, 'accounts', `${id}.json`), JSON.stringify(account(id, 'crash-window@example.test')));
  // 模拟"账号文件写成功、accounts.json 还没写"的崩溃现场。
  await writeFile(join(directory, 'accounts.json'), JSON.stringify({ version: '2.0', accounts: [], current_account_id: null }));

  const manager = new AccountsManager(directory);
  await manager.init();

  const index = await manager.loadIndex();
  assert.ok(index.accounts.some(item => item.id === id), '孤儿账号文件必须在启动后回到索引');
  assert.equal(index.current_account_id, id);

  const persisted = JSON.parse(await readFile(join(directory, 'accounts.json'), 'utf8'));
  assert.ok(persisted.accounts.some(item => item.id === id), '自愈结果必须落盘，而不是只改内存');
});

test('崩溃窗口：索引里残留幽灵条目时，启动会剔除', async () => {
  const directory = await mkdtemp('/tmp/gb-reconcile-ghost-');
  await mkdir(join(directory, 'accounts'), { recursive: true });
  const ghost = randomUUID();
  await writeFile(join(directory, 'accounts.json'), JSON.stringify({
    version: '2.0',
    accounts: [{ id: ghost, email: 'ghost@example.test', name: null, disabled: false, protected_models: [], created_at: 1, last_used: 1, quota: null }],
    current_account_id: ghost,
  }));

  const manager = new AccountsManager(directory);
  await manager.init();

  const index = await manager.loadIndex();
  assert.equal(index.accounts.length, 0, '账号文件已不存在的条目必须被清理');
  assert.equal(index.current_account_id, null);
});

test('索引与目录一致时不会无谓重写索引', async () => {
  const directory = await mkdtemp('/tmp/gb-reconcile-stable-');
  await mkdir(join(directory, 'accounts'), { recursive: true });
  const id = randomUUID();
  await writeFile(join(directory, 'accounts', `${id}.json`), JSON.stringify(account(id, 'stable@example.test')));
  await writeFile(join(directory, 'accounts.json'), JSON.stringify({
    version: '2.0',
    accounts: [{ id, email: 'stable@example.test', name: '本地账号', disabled: false, protected_models: [], created_at: 1, last_used: 1, quota: null }],
    current_account_id: id,
  }));
  const before = await readFile(join(directory, 'accounts.json'), 'utf8');

  const manager = new AccountsManager(directory);
  await manager.init();
  await manager.getAccount(id);

  assert.equal(await readFile(join(directory, 'accounts.json'), 'utf8'), before, '一致时不应改写索引（避免无意义 fsync）');
});
