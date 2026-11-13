import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AccountSwitchService } from '../dist/account-switch.js';
import { AccountsManager, MockKeychainAdapter } from '../dist/accounts.js';

const run = promisify(execFile);

function makeAccount(id, email, opts = {}) {
  return {
    id,
    email,
    name: '安全测试账号',
    refreshToken: `1//token-refresh-${id}`,
    accessToken: `token-access-${id}`,
    expiresIn: 3600,
    projectId: opts.projectId || null,
    isGcpTos: true,
  };
}

async function setupSandbox() {
  const root = await mkdtemp(join(tmpdir(), 'gb-switch-sec-'));
  const stateDir = join(root, 'state');
  const profile = join(root, 'profile');
  await mkdir(join(profile, 'User', 'globalStorage'), { recursive: true });

  const db = join(profile, 'User', 'globalStorage', 'state.vscdb');
  await run('/usr/bin/sqlite3', [db, 'CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);']);

  const manager = new AccountsManager(stateDir);
  await manager.init();

  const keychain = new MockKeychainAdapter();
  await keychain.writePassword('gemini', 'antigravity', 'initial-keychain-pass');

  return { root, stateDir, profile, db, manager, keychain };
}

test('S3 凭据安全: 切换历史归档自动脱敏，且最多保留最近 3 份历史快照', async () => {
  const env = await setupSandbox();
  try {
    const acc1 = await env.manager.upsertAccount(makeAccount('acc1', 'user1@test.com'));
    const acc2 = await env.manager.upsertAccount(makeAccount('acc2', 'user2@test.com'));
    const acc3 = await env.manager.upsertAccount(makeAccount('acc3', 'user3@test.com'));
    const acc4 = await env.manager.upsertAccount(makeAccount('acc4', 'user4@test.com'));

    const service = new AccountSwitchService(env.manager, {
      stateDir: env.stateDir,
      profile: env.profile,
      keychain: env.keychain,
      isRunning: async () => false,
    });

    // 连续执行 4 次账号切换，每次切换都会把上一份 journal 归档入 account-switch-backups
    await service.switchAccount(acc1.id);
    await service.switchAccount(acc2.id);
    await service.switchAccount(acc3.id);
    await service.switchAccount(acc4.id);

    const backupsDir = join(env.stateDir, 'account-switch-backups');
    const backups = (await readdir(backupsDir)).filter(f => f.endsWith('.json'));

    // 1. 验证数量上限裁剪：不能无限膨胀，最多保留最近 3 份
    assert.ok(backups.length <= 3, `备份文件数量为 ${backups.length}，不得超过 3 份`);

    // 2. 验证凭据脱敏：备份历史文件内绝不能包含未脱敏的明文 refresh token
    for (const b of backups) {
      const content = await readFile(join(backupsDir, b), 'utf8');
      assert.ok(!content.includes('1//token-refresh-acc'), '历史备份中绝不得包含真实 refresh token');
      assert.ok(content.includes('[REDACTED]'), '历史钥匙串凭据必须被明确脱敏为 [REDACTED]');
    }
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('S3 凭据安全: 撤销切号 (rollback) 完成后自动清除敏感凭据', async () => {
  const env = await setupSandbox();
  try {
    const acc = await env.manager.upsertAccount(makeAccount('acc-rb', 'rollback-sec@test.com'));

    const service = new AccountSwitchService(env.manager, {
      stateDir: env.stateDir,
      profile: env.profile,
      keychain: env.keychain,
      isRunning: async () => false,
    });

    await service.switchAccount(acc.id);

    const journalFile = join(env.stateDir, 'account-switch-journal-stable.json');
    let jData = JSON.parse(await readFile(journalFile, 'utf8'));
    assert.equal(jData.status, 'complete');
    assert.ok(jData.keychainBefore);

    // 执行回滚
    const res = await service.rollback();
    assert.ok(res.message);

    // 回滚完成后，journal 必须将 keychainBefore 与 keychainAfter 清空脱敏
    jData = JSON.parse(await readFile(journalFile, 'utf8'));
    assert.equal(jData.status, 'rolled-back');
    assert.equal(jData.keychainBefore, null, '回滚完成后 keychainBefore 必须被置空');
    assert.equal(jData.keychainAfter, '', '回滚完成后 keychainAfter 必须被置空');
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('S3 切号事务: 从带有企业项目偏好的账号切换至个人账号无障碍 (H4 修复验证)', async () => {
  const env = await setupSandbox();
  try {
    // 预先在数据库中插入包含企业项目行的 ItemTable 数据
    await run('/usr/bin/sqlite3', [env.db, `INSERT INTO ItemTable VALUES('antigravityUnifiedStateSync.enterprisePreferences','old-enterprise-proj');`]);

    const personalAcc = await env.manager.upsertAccount(makeAccount('pers-1', 'myuser@example.test', { projectId: null }));

    const service = new AccountSwitchService(env.manager, {
      stateDir: env.stateDir,
      profile: env.profile,
      keychain: env.keychain,
      isRunning: async () => false,
    });

    // 切换至无 project_id 的个人账号，必须成功并且把数据库中的企业项目偏好删除
    const switchRes = await service.switchAccount(personalAcc.id);
    assert.equal(switchRes.switchedTo, 'myuser@example.test');

    const raw = (await run('/usr/bin/sqlite3', ['-json', env.db, "SELECT key,value FROM ItemTable WHERE key='antigravityUnifiedStateSync.enterprisePreferences';"])).stdout.trim();
    const dbRows = raw ? JSON.parse(raw) : [];
    assert.equal(dbRows.length, 0, '切换至个人账号后，企业项目行必须被清理删除');
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('S3 凭据安全: 初始钥匙串为空 (null) 时切号与回滚无障碍完成', async () => {
  const env = await setupSandbox();
  try {
    // 显式清除初始密码，模拟钥匙串原本为空的场景
    await env.keychain.deletePassword('gemini', 'antigravity');
    const acc = await env.manager.upsertAccount(makeAccount('acc-null-kc', 'null-kc@test.com'));

    const service = new AccountSwitchService(env.manager, {
      stateDir: env.stateDir,
      profile: env.profile,
      keychain: env.keychain,
      isRunning: async () => false,
    });

    await service.switchAccount(acc.id);
    const passAfterSwitch = await env.keychain.readPassword('gemini', 'antigravity');
    assert.ok(passAfterSwitch, '切号后钥匙串必须写入新凭据');

    // 执行回滚，即使 keychainBefore 为 null 也必须顺利通过
    const res = await service.rollback();
    assert.ok(res.message.includes('已恢复'));

    const passAfterRollback = await env.keychain.readPassword('gemini', 'antigravity');
    assert.equal(passAfterRollback, null, '回滚后钥匙串必须精确恢复为 null');
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('S3 智能调度: Round-Robin 算法在多账号轮转时严格按序完整遍历，杜绝死循环振荡', async () => {
  const env = await setupSandbox();
  try {
    await env.manager.setAutoSwitchConfig({
      enabled: true,
      strategy: 'round_robin',
      reserve_percentage: 10,
      candidate_min_percentage: 20,
    });

    const a1 = await env.manager.upsertAccount(makeAccount('acc-rr-1', 'rr1@test.com'));
    const a2 = await env.manager.upsertAccount(makeAccount('acc-rr-2', 'rr2@test.com'));
    const a3 = await env.manager.upsertAccount(makeAccount('acc-rr-3', 'rr3@test.com'));
    const a4 = await env.manager.upsertAccount(makeAccount('acc-rr-4', 'rr4@test.com'));

    const richQuota = {
      last_updated: Math.floor(Date.now() / 1000),
      models: [{ name: 'gemini-3.8-flash', percentage: 90, percentage_known: true }],
    };
    for (const a of [a1, a2, a3, a4]) {
      a.quota = richQuota;
      await env.manager.saveAccount(a);
    }

    await env.manager.setCurrentAccount(a1.id);
    const chosenSequence = [];

    // 连续轮转 4 轮，确保 4 个账号每个都被完整遍历选中，绝不在前两个账号反复横跳
    for (let turn = 0; turn < 4; turn++) {
      const idx = await env.manager.loadIndex();
      const cur = await env.manager.getAccount(idx.current_account_id);
      // 当前账号额度降低，触发切号
      cur.quota = {
        last_updated: Math.floor(Date.now() / 1000),
        models: [{ name: 'gemini-3.8-flash', percentage: 5, percentage_known: true }],
      };
      await env.manager.saveAccount(cur);

      const decision = await env.manager.selectBestAccount();
      assert.equal(decision.shouldSwitch, true);
      assert.ok(decision.bestCandidate);
      chosenSequence.push(decision.bestCandidate.id);

      await env.manager.recordAutoSwitchChoice(decision.bestCandidate.id);
      await env.manager.setCurrentAccount(decision.bestCandidate.id);

      // 恢复旧账号额度为充裕状态
      cur.quota = richQuota;
      await env.manager.saveAccount(cur);
    }

    // 验证选中的账号集合包含全部 4 个账号，无一遗漏饥饿
    const uniqueChosen = new Set(chosenSequence);
    assert.equal(uniqueChosen.size, 4, `4 轮轮换必须包含全部候选账号，实际选择序列: ${chosenSequence.join(' -> ')}`);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

