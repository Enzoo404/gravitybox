import test from 'node:test';
import { execSqlite, querySqliteJson } from './sqlite-helper.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AccountSwitchService, DatabaseTransaction } from '../dist/account-switch.js';
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
  execSqlite(db, 'CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');

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

    // 连续执行 4 次账号切换，每次切换都会把上一份 journal 归档入 account-switch-backups（保留微小间隔确保时间戳不同）
    await service.switchAccount(acc1.id);
    await new Promise(r => setTimeout(r, 5));
    await service.switchAccount(acc2.id);
    await new Promise(r => setTimeout(r, 5));
    await service.switchAccount(acc3.id);
    await new Promise(r => setTimeout(r, 5));
    await service.switchAccount(acc4.id);

    const backupsDir = join(env.stateDir, 'account-switch-backups');
    const backups = (await readdir(backupsDir)).filter(f => f.endsWith('.json'));

    // 1. 验证数量上限裁剪：不能无限膨胀，按时间戳最多保留最近 3 份
    assert.equal(backups.length, 3, `最多保留 3 份历史切号归档，实际为 ${backups.length}`);

    // 2. 验证文件名携带时间戳前缀
    for (const b of backups) {
      assert.match(b, /^\d+_[0-9a-f]{8}\.json$/, '归档文件命名必须为时间戳_uuid格式');
    }

    // 3. 验证凭据深度不可逆脱敏：不仅 keychainBefore/After，before 和 after 的数据库行也不得残留明文或可还原 Base64 凭据
    let sawRedactedBeforeToken = false;
    for (const b of backups) {
      const content = await readFile(join(backupsDir, b), 'utf8');
      const data = JSON.parse(content);

      // 绝不得包含原始明文 access_token / refresh_token
      assert.ok(!content.includes('token-access-'), '历史备份中绝不得包含明文 access_token');
      assert.ok(!content.includes('1//token-refresh-acc'), '历史备份中绝不得包含真实 refresh token');
      assert.ok(!content.includes('token-refresh-'), '历史备份中绝不得包含明文 refresh_token');
      assert.ok(content.includes('[REDACTED]'), '历史钥匙串凭据必须被明确脱敏为 [REDACTED]');

      // 验证 before/after 中的 TOKEN 键被彻底脱敏，绝不保留可还原的 Base64 编码
      if (data.before && data.before['antigravityUnifiedStateSync.oauthToken']) {
        sawRedactedBeforeToken = true;
        assert.equal(data.before['antigravityUnifiedStateSync.oauthToken'], '[REDACTED_OAUTH_TOKEN]', 'before 中的 oauthToken 必须脱敏为 [REDACTED_OAUTH_TOKEN]');
      }
      assert.equal(data.after?.['antigravityUnifiedStateSync.oauthToken'], '[REDACTED_OAUTH_TOKEN]', 'after 中的 oauthToken 必须脱敏为 [REDACTED_OAUTH_TOKEN]');

      assert.equal(data.keychainBefore, data.keychainBefore ? '[REDACTED]' : null);
      assert.equal(data.keychainAfter, '[REDACTED]');
    }
    assert.ok(sawRedactedBeforeToken, '历史归档中应至少包含一条带 before.oauthToken 的脱敏快照');
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
    execSqlite(env.db, `INSERT INTO ItemTable VALUES('antigravityUnifiedStateSync.enterprisePreferences','old-enterprise-proj');`);

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

    const dbRows = querySqliteJson(env.db, "SELECT key,value FROM ItemTable WHERE key='antigravityUnifiedStateSync.enterprisePreferences';");
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

test('P0-09: switchAccount 提交前失败回滚时日志脱敏，且 reconcileRollback 复用 databaseFactory', async () => {
  const env = await setupSandbox();
  try {
    const acc1 = await env.manager.upsertAccount(makeAccount('acc-p009-1', 'p009-1@test.com'));
    const failService = new AccountSwitchService(env.manager, {
      stateDir: env.stateDir,
      profile: env.profile,
      keychain: env.keychain,
      isRunning: async () => false,
      databaseFactory: path => {
        const tx = new DatabaseTransaction(path);
        const origFinish = tx.finish.bind(tx);
        tx.finish = async commit => {
          await origFinish(false);
          if (commit) throw new Error('simulated pre-commit failure');
        };
        return tx;
      },
    });

    await assert.rejects(failService.switchAccount(acc1.id), /simulated pre-commit failure/);
    const journalPath = join(env.stateDir, 'account-switch-journal-stable.json');
    const journalRaw = await readFile(journalPath, 'utf8');
    const journal = JSON.parse(journalRaw);
    assert.equal(journal.status, 'rolled-back');
    assert.equal(journal.keychainBefore, null);
    assert.equal(journal.keychainAfter, '');
    assert.equal(journal.keychainAfterDigest, undefined);
    assert.ok(!journalRaw.includes('1//token-refresh-acc-p009-1'));
    assert.ok(!journalRaw.includes('token-access-acc-p009-1'));
    assert.ok(!journalRaw.includes('initial-keychain-pass'));
    assert.equal(await env.keychain.readPassword('gemini', 'antigravity'), 'initial-keychain-pass');

    const okService = new AccountSwitchService(env.manager, {
      stateDir: env.stateDir,
      profile: env.profile,
      keychain: env.keychain,
      isRunning: async () => false,
    });
    await okService.switchAccount(acc1.id);

    let factoryCalls = 0;
    const rollbackService = new AccountSwitchService(env.manager, {
      stateDir: env.stateDir,
      profile: env.profile,
      keychain: env.keychain,
      isRunning: async () => false,
      databaseFactory: path => {
        factoryCalls += 1;
        const tx = new DatabaseTransaction(path);
        if (factoryCalls === 1) {
          const origFinish = tx.finish.bind(tx);
          tx.finish = async commit => {
            if (commit) {
              await origFinish(false);
              throw new Error('simulated rollback crash');
            }
            return origFinish(commit);
          };
        }
        return tx;
      },
    });

    await assert.rejects(rollbackService.rollback(), /simulated rollback crash/);
    assert.equal(factoryCalls, 2, 'reconcileRollback 必须通过 this.database() 调用注入的 databaseFactory');
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('v1.1.3 Issue #19 & 合规切号: 同源 agy CLI 凭据非侵入同步、无 .env 过期 access_token 切号放行、CLI 刷新后 7 天回滚兼容与双源对称还原', async () => {
  const env = await setupSandbox();
  const geminiDir = join(env.root, '.gemini');
  const agyCliTokenPath = join(geminiDir, 'antigravity-cli', 'antigravity-oauth-token');
  const jetskiTokenPath = join(geminiDir, 'jetski-standalone-oauth-token');
  const geminiCliOauthPath = join(geminiDir, 'oauth_creds.json');
  const geminiCliAccountsPath = join(geminiDir, 'google_accounts.json');

  try {
    // 创建账号 A（当前账号）与账号 B（access_token 已过期，且未配置 .env，但有合法 refresh_token）
    const accA = await env.manager.upsertAccount({
      email: 'cli-a@example.test',
      name: 'CLI User A',
      refreshToken: '1//refresh-cli-a',
      accessToken: 'ya29.access-cli-a',
      expiryTimestamp: 1700000100,
      projectId: 'proj-cli-a',
    });
    const accB = await env.manager.upsertAccount({
      email: 'cli-b@example.test',
      name: 'CLI User B',
      refreshToken: '1//refresh-cli-b',
      accessToken: 'pending_refresh',
      expiryTimestamp: 1600000000, // 早已过期
      projectId: 'proj-cli-b',
    });

    const service = new AccountSwitchService(env.manager, {
      stateDir: env.stateDir,
      profile: env.profile,
      geminiDir,
      keychain: env.keychain,
      isRunning: async () => false,
    });

    // 1. 非侵入原则验证：当 ~/.gemini 下文件不存在时，切号绝不主动创建 CLI 凭据文件
    await service.switchAccount(accA.id);
    await assert.rejects(readFile(agyCliTokenPath, 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(jetskiTokenPath, 'utf8'), { code: 'ENOENT' });

    // 2. 预置已存在的同源 CLI 凭据文件与不应触碰的 gemini-cli 文件
    await mkdir(join(geminiDir, 'antigravity-cli'), { recursive: true });
    await writeFile(agyCliTokenPath, '{"initial":"agy"}', { mode: 0o600 });
    await writeFile(jetskiTokenPath, '{"initial":"jetski"}', { mode: 0o600 });
    await writeFile(geminiCliOauthPath, '{"gemini_cli":"untouched"}', { mode: 0o600 });
    await writeFile(geminiCliAccountsPath, '{"accounts":["untouched"]}', { mode: 0o600 });

    // 先切回 A 使钥匙串和 CLI 文件同步为 A，然后再切到 access_token 已过期的 B
    await service.switchAccount(accA.id);
    const cliAAfterFirst = JSON.parse(await readFile(agyCliTokenPath, 'utf8'));
    assert.equal(cliAAfterFirst.token.email, 'cli-a@example.test');
    assert.equal(cliAAfterFirst.id_token_email, 'cli-a@example.test');
    assert.equal(cliAAfterFirst.token.refresh_token, '1//refresh-cli-a');

    // 3. 验证无 .env 且 access_token 已过期的账号 B 切号不拦截，且同步写入两个同源 CLI 文件
    const switchBRes = await service.switchAccount(accB.id);
    assert.equal(switchBRes.switchedTo, 'cli-b@example.test');

    for (const cliPath of [agyCliTokenPath, jetskiTokenPath]) {
      const raw = await readFile(cliPath, 'utf8');
      assert.equal(raw.startsWith('go-keyring-base64:'), false, 'CLI 文件必须是纯 UTF-8 JSON，不得带 go-keyring-base64 前缀');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.token.email, 'cli-b@example.test');
      assert.equal(parsed.id_token_email, 'cli-b@example.test');
      assert.equal(parsed.token.refresh_token, '1//refresh-cli-b');
      assert.equal(parsed.token.project_id, 'proj-cli-b');
      assert.equal(parsed.token.expiry_timestamp, 1600000000);
      assert.equal(typeof parsed.token.expiry, 'string');
    }

    // 验证 @google/gemini-cli 的文件完全未被触碰
    assert.equal(await readFile(geminiCliOauthPath, 'utf8'), '{"gemini_cli":"untouched"}');
    assert.equal(await readFile(geminiCliAccountsPath, 'utf8'), '{"accounts":["untouched"]}');

    // 4. 模拟用户在终端运行 agy 导致 CLI 凭据文件被外部自动刷新改写
    await writeFile(agyCliTokenPath, JSON.stringify({
      token: {
        access_token: 'ya29.refreshed-by-agy-cli',
        refresh_token: '1//refresh-cli-b',
        email: 'cli-b@example.test',
        expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      },
      id_token_email: 'cli-b@example.test',
    }), { mode: 0o600 });

    // 验证 CLI 文件不在 journal.files 中，因此外部修改绝不阻断桌面端 7 天回滚，且回滚后 CLI 文件对称还原回账号 A
    const rbRes = await service.rollback();
    assert.ok(rbRes.message.includes('已恢复'));

    for (const cliPath of [agyCliTokenPath, jetskiTokenPath]) {
      const restored = JSON.parse(await readFile(cliPath, 'utf8'));
      assert.equal(restored.token.email, 'cli-a@example.test', `回滚后 ${cliPath} 必须对称还原为切号前账号 A`);
      assert.equal(restored.token.refresh_token, '1//refresh-cli-a');
    }

    // 5. 验证历史归档对任意非 accounts.json 文件（含无后缀路径）严格脱敏
    await service.switchAccount(accB.id);
    const backupsDir = join(env.stateDir, 'account-switch-backups');
    const backups = (await readdir(backupsDir)).filter(f => f.endsWith('.json'));
    for (const b of backups) {
      const content = await readFile(join(backupsDir, b), 'utf8');
      assert.ok(!content.includes('1//refresh-cli-'), '归档快照严禁残留明文 refresh_token');
    }

    // 6. 崩溃中断恢复路径（reconcileRollback committed=true）也必须对称回滚已存在的 agy CLI 凭据文件
    // 读取当前真实 ItemTable 行构造合法的 interrupted rollback 状态（从 B 回滚到 A 时在 DB COMMIT 之后中断）
    const dbPath = join(env.profile, 'User', 'globalStorage', 'state.vscdb');
    const { DatabaseSync } = await import('node:sqlite');
    const dbConn = new DatabaseSync(dbPath);
    const currentDbRows = {};
    try {
      const rows = dbConn.prepare(
        "SELECT key, value FROM ItemTable WHERE key IN ('antigravityUnifiedStateSync.oauthToken','antigravityUnifiedStateSync.userStatus','jetskiStateSync.agentManagerInitState','antigravityUnifiedStateSync.enterprisePreferences','antigravityOnboarding')"
      ).all();
      for (const row of rows) currentDbRows[row.key] = row.value;
    } finally {
      dbConn.close();
    }
    const beforeDbRows = { ...currentDbRows, 'antigravityUnifiedStateSync.oauthToken': 'old-raw-a' };
    const indexPath = join(env.stateDir, 'accounts.json');
    const indexNow = await readFile(indexPath, 'utf8');
    const indexPrevObj = JSON.parse(indexNow);
    indexPrevObj.current_account_id = accA.id;
    const indexPrev = JSON.stringify(indexPrevObj);
    const keychainB = await env.keychain.readPassword('gemini', 'antigravity');
    // 构造一个带 Account A OAuth 的 go-keyring-base64 payload 放在 originalJournal.keychainBefore
    const keychainA = 'go-keyring-base64:' + Buffer.from(JSON.stringify({
      token: {
        access_token: 'ya29.restored-a',
        refresh_token: '1//refresh-cli-a',
        token_type: 'Bearer',
        expiry_timestamp: 1900000000,
        email: 'cli-a@example.test',
      },
      id_token_email: 'cli-a@example.test',
    })).toString('base64');

    const journalPath = join(env.stateDir, 'account-switch-journal-stable.json');
    const rollbackPath = `${journalPath}.rollback.json`;
    const originalJournal = {
      version: 1,
      status: 'rolling-back',
      at: new Date().toISOString(),
      fromId: accA.id,
      toId: accB.id,
      before: beforeDbRows,
      after: currentDbRows,
      files: [{ path: indexPath, before: indexPrev, after: indexNow }],
      keychainBefore: keychainA,
      keychainAfter: keychainB ?? '',
    };
    // 模拟 DB/文件/Keychain 已提交为 A，但进程在删除 rollback.json 及同步 CLI 前崩溃
    await writeFile(indexPath, indexPrev);
    await env.keychain.writePassword('gemini', 'antigravity', keychainA);
    const dbWriteConn = new DatabaseSync(dbPath);
    try {
      dbWriteConn.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
        'antigravityUnifiedStateSync.oauthToken',
        'old-raw-a'
      );
    } finally {
      dbWriteConn.close();
    }
    await writeFile(journalPath, JSON.stringify(originalJournal));
    await writeFile(rollbackPath, JSON.stringify({
      version: 1,
      phase: 'committed',
      databasePath: dbPath,
      hadDatabase: true,
      rowsBefore: currentDbRows,
      rowsAfter: beforeDbRows,
      files: [{ path: indexPath, before: indexNow, after: indexPrev }],
      keychainBefore: keychainB ?? '',
      keychainAfter: keychainA,
      originalJournal,
    }));

    const interruptedRes = await service.rollback();
    assert.ok(interruptedRes.message.includes('中断') || interruptedRes.message.includes('恢复'));
    for (const cliPath of [agyCliTokenPath, jetskiTokenPath]) {
      const restored = JSON.parse(await readFile(cliPath, 'utf8'));
      assert.equal(restored.token.email, 'cli-a@example.test', `中断恢复后 ${cliPath} 也必须对称还原为账号 A`);
      assert.equal(restored.token.refresh_token, '1//refresh-cli-a');
    }
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});


