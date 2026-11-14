import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountSwitchService } from '../dist/account-switch.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AccountsManager, MockKeychainAdapter } from '../dist/accounts.js';

const run = promisify(execFile);

async function setupSandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'gb-test-phase4-'));
  const stateDir = join(dir, 'state');
  const profile = join(dir, 'profile');
  await mkdir(join(profile, 'User', 'globalStorage'), { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const db = join(profile, 'User', 'globalStorage', 'state.vscdb');
  await run('/usr/bin/sqlite3', [db, 'CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);']);

  const manager = new AccountsManager(stateDir);
  await manager.init();
  const keychain = new MockKeychainAdapter();
  await keychain.writePassword('gemini', 'antigravity', 'initial-keychain-pass');
  return { dir, stateDir, profile, manager, keychain };
}

function makeAccount(id, email) {
  return {
    id,
    email,
    name: '安全测试账号',
    refreshToken: `1//secret-refresh-${id}`,
    accessToken: `secret-access-${id}`,
    expiresIn: 3600,
    isGcpTos: true,
  };
}

test('A18: 历史切号归档深度不可逆脱敏，杜绝 Base64/Protobuf 凭据残留，按时间戳保留最近 3 份', async () => {
  const env = await setupSandbox();
  try {
    const acc1 = await env.manager.upsertAccount(makeAccount('acc-1', 'user1@example.com'));
    const acc2 = await env.manager.upsertAccount(makeAccount('acc-2', 'user2@example.com'));
    const acc3 = await env.manager.upsertAccount(makeAccount('acc-3', 'user3@example.com'));
    const acc4 = await env.manager.upsertAccount(makeAccount('acc-4', 'user4@example.com'));

    const service = new AccountSwitchService(env.manager, {
      stateDir: env.stateDir,
      profile: env.profile,
      keychain: env.keychain,
      isRunning: async () => false,
    });

    // 连续切号 4 次以触发归档和历史裁剪
    await service.switchAccount(acc1.id);
    // 稍微延迟确保时间戳不同
    await new Promise(r => setTimeout(r, 5));
    await service.switchAccount(acc2.id);
    await new Promise(r => setTimeout(r, 5));
    await service.switchAccount(acc3.id);
    await new Promise(r => setTimeout(r, 5));
    await service.switchAccount(acc4.id);

    const backupsDir = join(env.stateDir, 'account-switch-backups');
    const backups = (await readdir(backupsDir)).filter(f => f.endsWith('.json'));

    // 1. 验证数量上限裁剪：最多保留最近 3 份
    assert.equal(backups.length, 3, `最多保留 3 份历史切号归档，实际为 ${backups.length}`);

    // 2. 验证文件名携带时间戳前缀
    for (const b of backups) {
      assert.match(b, /^\d+_[0-9a-f]{8}\.json$/, '归档文件命名必须为时间戳_uuid格式');
    }

    // 3. 验证归档内容深度不可逆脱敏：不仅 keychainBefore，before 和 after 的数据库行也不得残留凭据
    for (const b of backups) {
      const raw = await readFile(join(backupsDir, b), 'utf8');
      const data = JSON.parse(raw);

      // 绝不得包含原始明文 token
      assert.ok(!raw.includes('secret-access-'), '绝不得包含 access_token');
      assert.ok(!raw.includes('secret-refresh-'), '绝不得包含 refresh_token');

      // 验证 before/after 中的 TOKEN 键被彻底脱敏，绝不保留可还原的 Base64 编码
      if (data.before && data.before['antigravityUnifiedStateSync.oauthToken']) {
        assert.equal(data.before['antigravityUnifiedStateSync.oauthToken'], '[REDACTED_OAUTH_TOKEN]', 'before 中的 oauthToken 必须脱敏为 [REDACTED_OAUTH_TOKEN]');
      }
      if (data.after && data.after['antigravityUnifiedStateSync.oauthToken']) {
        assert.equal(data.after['antigravityUnifiedStateSync.oauthToken'], '[REDACTED_OAUTH_TOKEN]', 'after 中的 oauthToken 必须脱敏为 [REDACTED_OAUTH_TOKEN]');
      }

      assert.equal(data.keychainBefore, data.keychainBefore ? '[REDACTED]' : null);
      assert.equal(data.keychainAfter, '[REDACTED]');
    }
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});
