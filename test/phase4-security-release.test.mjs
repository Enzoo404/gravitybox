import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountSwitchService } from '../dist/account-switch.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AccountsManager, MockKeychainAdapter } from '../dist/accounts.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

async function setupSandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'gb-test-phase4-'));
  const stateDir = join(dir, 'state');
  const profile = join(dir, 'profile');
  const externalDir = join(dir, 'external');
  await mkdir(join(profile, 'User', 'globalStorage'), { recursive: true });
  await mkdir(join(externalDir, 'accounts'), { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const db = join(profile, 'User', 'globalStorage', 'state.vscdb');
  await run('/usr/bin/sqlite3', [db, 'CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);']);

  const manager = new AccountsManager(stateDir);
  await manager.init();
  const keychain = new MockKeychainAdapter();
  await keychain.writePassword('gemini', 'antigravity', 'initial-keychain-pass');
  return { dir, stateDir, profile, externalDir, manager, keychain };
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

    await writeFile(join(env.externalDir, 'accounts.json'), JSON.stringify({
      accounts: [
        { id: 'ext-1', email: 'user1@example.com' },
        { id: 'ext-2', email: 'user2@example.com' },
        { id: 'ext-3', email: 'user3@example.com' },
        { id: 'ext-4', email: 'user4@example.com' },
      ],
      current_account_id: 'ext-1',
    }));

    const service = new AccountSwitchService(env.manager, {
      stateDir: env.stateDir,
      profile: env.profile,
      externalDir: env.externalDir,
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

test('A20: 构建元数据注入 revision，关于窗口动态展示修订号，AGENTS 对齐真实边界', async () => {
  const pkgScript = await readFile(join(root, 'tools/package-mac.mjs'), 'utf8');
  const assistantSrc = await readFile(join(root, 'native/Assistant.swift'), 'utf8');
  const agentsDoc = await readFile(join(root, 'AGENTS.md'), 'utf8');

  // 1. 打包脚本通过共享构造器注入 revision；检查实际输出，避免把实现位置写死在脚本内。
  const { buildInfoPayload } = await import('../tools/release-scope.mjs');
  const digest = '1234abcd' + 'f'.repeat(56);
  const metadata = buildInfoPayload({
    version: '0.9.0', build: 900, node: '22.23.2',
    verification: { digest, at: '2026-10-21T00:00:00Z' },
    scope: { mode: 'targeted', targetAppVersions: ['2.24.0'], historicalUnverified: ['2.23.0', '2.23.1'] },
  });
  assert.equal(metadata.revision, '1234abcd', '构建元数据必须由摘要提取 revision');
  assert.equal(metadata.sourceDigest, digest, '必须保留完整来源摘要');
  assert.match(pkgScript, /JSON\.stringify\(buildInfoPayload\(/, 'package-mac 必须写入构造器生成的元数据');

  // 2. 关于窗口动态提取 revision
  assert.match(assistantSrc, /info\["revision"\] as\? String/, 'Assistant.about 必须从 build-info 提取 revision');
  assert.match(assistantSrc, /buildStr = buildStr.isEmpty/ , '关于弹窗必须拼接展示 revision');

  // 3. AGENTS 文档对齐真实边界，无虚构承诺
  assert.doesNotMatch(agentsDoc, /从单点汉化跃迁为六大核心模块.*双窗口低额度轮换.*四端登录态同步/, '不得保留旧版虚构的自动轮换与四端同步完成承诺');
  assert.match(agentsDoc, /智能备用账号推荐策略/, '必须准确描述为智能备用账号推荐策略');
  assert.match(agentsDoc, /2026-10-19 全量产品审计 20 项问题（A01~A20）系统性重构整改/, '必须记录 2026-10-19 审计整改记录');
});
