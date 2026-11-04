import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';

import { AccountsManager, generateDeviceProfile, MockKeychainAdapter, formatResetCountdown, syncAccountToKeychain } from '../dist/accounts.js';
import {
  UsageStatsManager,
  ProtobufReader,
  ProtobufWriter,
  matchPricingKeys,
  calculateEstimatedUsd,
  DEFAULT_API_PRICES,
} from '../dist/usage.js';

const execFileAsync = promisify(execFile);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await sleep(30);
  }
  throw new Error('等待超时');
}

function rpc(directory, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(directory, 'control.sock'));
    let value = '';
    socket.setTimeout(4000, () => {
      socket.destroy();
      reject(new Error('IPC 超时'));
    });
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('error', reject);
    socket.on('data', chunk => {
      value += chunk;
      if (value.includes('\n')) {
        socket.end();
        try {
          resolve(JSON.parse(value.split('\n')[0]));
        } catch (e) {
          reject(e);
        }
      }
    });
  });
}

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

test('AccountsManager: Schema v2 导出与合并导入测试', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-export-'));
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

    // 导出（恢复用备份必须显式确认包含凭据；默认导出仅脱敏摘要）
    const exported = await mgr.exportAccounts(undefined, { confirm: true });
    assert.equal(exported.schema_version, 2);
    assert.equal(exported.accounts.length, 2);
    // 验证安全红线：绝不能导出临时 access_token 或 device_profile
    assert.equal(Object.hasOwn(exported.accounts[0], 'access_token'), false);
    assert.equal(Object.hasOwn(exported.accounts[0], 'device_profile'), false);
    assert.equal(exported.accounts[0].email, 'export2@test.com');

    // 导入到全新的沙箱中
    const importSandbox = await mkdtemp(join(tmpdir(), 'gb-test-import-'));
    try {
      const importMgr = new AccountsManager(importSandbox);
      const res = await importMgr.importAccounts(exported);
      assert.equal(res.imported, 2);
      assert.equal(res.updated, 0);

      const importedIndex = await importMgr.loadIndex();
      assert.equal(importedIndex.accounts.length, 2);

      // 重复导入应触发增量更新而非重复新增
      const res2 = await importMgr.importAccounts(exported);
      assert.equal(res2.imported, 0);
      assert.equal(res2.updated, 2);

      // 脱敏摘要不得被当作可恢复凭据导入。
      const masked = await mgr.exportAccounts();
      assert.equal(masked.tokens_included, false);
      await assert.rejects(() => importMgr.importAccounts(masked), /脱敏/);
    } finally {
      await rm(importSandbox, { recursive: true, force: true });
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('AccountsManager: 双窗口额度熔合 (Fix #3426 真实 5h 覆盖) 与智能轮换推荐', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-quota-'));
  try {
    const mgr = new AccountsManager(sandbox);
    const reset5h = new Date(Date.now() + 3600000).toISOString();

    // 模拟 fetchAvailableModels 响应（虚高的 100%）
    const fetchAvailableModelsMock = {
      models: {
        'gemini-3.8-flash': {
          quotaInfo: { remainingFraction: 1.0, resetTime: new Date(Date.now() + 5 * 3600000).toISOString() },
          supportsImages: true,
          supportsThinking: true,
        },
        'claude-3-7-sonnet': {
          quotaInfo: { remainingFraction: 1.0, resetTime: new Date(Date.now() + 5 * 3600000).toISOString() },
        },
      },
    };

    // 模拟 retrieveUserQuotaSummary 响应（真实 5h 窗口为 0.08 即 8%）
    const quotaSummaryMock = {
      groups: [
        {
          displayName: 'Gemini',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.08, resetTime: reset5h },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.85, resetTime: new Date(Date.now() + 7 * 86400000).toISOString() },
          ],
        },
      ],
    };

    const fusedQuota = mgr.fuseQuota(fetchAvailableModelsMock, quotaSummaryMock);
    const geminiModel = fusedQuota.models.find(m => m.name === 'gemini-3.8-flash');
    assert.ok(geminiModel);
    // 关键熔合验证：模型配额必须被真实的 5h 桶 (8%) 熔合覆盖，而不是保留虚假的 100%
    assert.equal(geminiModel.percentage, 8);
    assert.equal(geminiModel.quota_bucket_id, 'gemini-5h');
    assert.equal(geminiModel.reset_time, reset5h);

    // 账号配额与轮换测试
    const accLow = await mgr.upsertAccount({
      email: 'low@test.com',
      refreshToken: '1//low',
    });
    accLow.quota = fusedQuota;
    await mgr.saveAccount(accLow);

    // 充足备选账号 (5h 配额为 80%)
    const highQuotaMock = {
      groups: [
        {
          displayName: 'Gemini',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.80, resetTime: reset5h },
          ],
        },
      ],
    };
    const accHigh = await mgr.upsertAccount({
      email: 'high@test.com',
      refreshToken: '1//high',
    });
    accHigh.token.access_token = 'synthetic-valid-access'; accHigh.token.expiry_timestamp = Math.floor(Date.now()/1000)+3600;
    accHigh.quota = mgr.fuseQuota(fetchAvailableModelsMock, highQuotaMock);
    await mgr.saveAccount(accHigh);

    await mgr.setCurrentAccount(accLow.id);

    // 自动轮换配置：红线 10%，准入门槛 30%
    await mgr.setAutoSwitchConfig({
      enabled: true,
      strategy: 'priority',
      reserve_percentage: 10,
      candidate_min_percentage: 30,
      monitored_model: 'gemini',
    });

    const recommendation = await mgr.selectBestAccount();
    assert.equal(recommendation.shouldSwitch, true);
    assert.equal(recommendation.bestCandidate?.email, 'high@test.com');

    // -----------------------------------------------------------------
    // 门禁整改验证 A: saveCurrentAccount 从沙箱 Keychain 提取当前账号
    // -----------------------------------------------------------------
    const mockKeychain = new MockKeychainAdapter();
    const mockPayload = JSON.stringify({
      token: {
        access_token: 'keychain-access-token',
        refresh_token: '1//keychain-refresh-token',
        expires_in: 3600,
        expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
        email: 'extracted-user@antigravity.test',
      },
    });
    const b64 = Buffer.from(mockPayload, 'utf8').toString('base64');
    await mockKeychain.writePassword('gemini', 'antigravity', `go-keyring-base64:${b64}`);

    const savedAcc = await mgr.saveCurrentAccount({
      keychain: mockKeychain,
      homeDir: sandbox,
      appSupportDir: sandbox,
    });
    assert.equal(savedAcc.email, 'extracted-user@antigravity.test');
    assert.equal(savedAcc.token.refresh_token, '1//keychain-refresh-token');

    const indexAfterSave = await mgr.loadIndex();
    assert.equal(indexAfterSave.current_account_id, savedAcc.id);

    // 验证从 google_accounts.json 提取真实 email 兜底 (拒绝占位符)
    await mkdir(join(sandbox, '.gemini'), { recursive: true });
    await writeFile(join(sandbox, '.gemini', 'google_accounts.json'), JSON.stringify({ active: 'fallback@google.test' }));
    const mockKeychainNoEmail = new MockKeychainAdapter();
    const mockPayloadNoEmail = JSON.stringify({
      token: {
        access_token: 'no-email-token',
        refresh_token: '1//no-email-refresh',
      },
    });
    const b64NoEmail = Buffer.from(mockPayloadNoEmail, 'utf8').toString('base64');
    await mockKeychainNoEmail.writePassword('gemini', 'antigravity', `go-keyring-base64:${b64NoEmail}`);
    await assert.rejects(mgr.saveCurrentAccount({
      keychain: mockKeychainNoEmail, homeDir: sandbox, appSupportDir: sandbox,
    }), /无法核实/);

    // -----------------------------------------------------------------
    // 门禁整改验证 B: refreshQuota 真实配额网络拉取、Token 刷新与双窗口全链路
    // -----------------------------------------------------------------
    savedAcc.token.access_token = 'pending_refresh';
    await mgr.saveAccount(savedAcc);

    const mockFetch = async (url) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 'refreshed-oauth-access-token-999',
            expires_in: 3600,
            refresh_token: '1//refreshed-keychain-refresh-token',
          }),
        };
      }
      if (u.includes('loadCodeAssist')) {
        return {
          ok: true,
          json: async () => ({
            cloudaicompanionProject: 'test-project-alpha',
            paid_tier: { id: 'TIER_PRO', name: 'Google One AI Premium' },
          }),
        };
      }
      if (u.includes('fetchAvailableModels')) {
        return {
          ok: true,
          json: async () => ({
            models: {
              'gemini-3.8-flash': {
                quotaInfo: { remainingFraction: 1.0, resetTime: reset5h },
                displayName: 'Gemini 3.8 Flash',
              },
            },
          }),
        };
      }
      if (u.includes('retrieveUserQuotaSummary')) {
        return {
          ok: true,
          json: async () => ({
            groups: [
              {
                displayName: 'Gemini',
                buckets: [
                  { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.45, resetTime: reset5h },
                  { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.78, resetTime: new Date(Date.now() + 7 * 86400000).toISOString() },
                ],
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const refreshedAcc = await mgr.refreshQuota(savedAcc.id, mockFetch);
    assert.equal(refreshedAcc.token.access_token, 'refreshed-oauth-access-token-999');
    assert.equal(refreshedAcc.quota?.subscription_tier, 'Google One AI Premium');
    assert.equal(refreshedAcc.token.project_id, 'test-project-alpha');

    const quotaOverview = mgr.getAccountQuotaOverview(refreshedAcc);
    assert.equal(quotaOverview.fiveHourRemaining, 45);
    assert.equal(quotaOverview.weeklyRemaining, 78);
    assert.equal(quotaOverview.subscriptionTier, 'Google One AI Premium');
    assert.ok(quotaOverview.resetTime);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 2. UsageStatsManager 单元测试
// -------------------------------------------------------------
test('UsageStatsManager: Protobuf 解码、SQLite 扫描与 API 价格估算', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-usage-'));
  try {
    // 0. 验证模型价格匹配归一化 (兼容带空格、Thinking 后缀与大写变体)
    assert.equal(matchPricingKeys('Gemini 3.8 Flash (High)'), 'gemini-3.8-flash');
    assert.equal(matchPricingKeys('Claude 3.7 Sonnet (Thinking)'), 'claude-3-7-sonnet');
    assert.equal(matchPricingKeys('gpt-4o-mini-2024-07-18'), 'gpt-4o-mini');

    // 1. 验证纯 TS Protobuf 编解码工具
    const testNum = 12345;
    const varintBuf = ProtobufWriter.encodeVarint(testNum);
    const readVal = ProtobufReader.readVarint(varintBuf, 0);
    assert.equal(readVal?.[0], testNum);

    // 2. 模拟构造一个 Antigravity 会话数据库
    const convDir = join(sandbox, 'antigravity', 'conversations');
    await mkdir(convDir, { recursive: true });
    const dbPath = join(convDir, 'test-conv.db');

    // 构造 Protobuf wrapped 消息：
    // Field 19 (modelId) = "gemini-3.8-flash"
    // Field 4 (usage):
    //   Field 1 is the model enum, never token usage
    //   Field 2 (input_tokens) = 1500
    //   Field 3 (output) = 1000
    //   Field 5 (cached) = 4000
    // Field 9 (timing) -> Field 4 (timingInfo) -> Field 1 (timestamp) = now
    const nowSec = Math.floor(Date.now() / 1000);
    const field19 = ProtobufWriter.encodeString(19, 'gemini-3.8-flash');
    const usageMsg = Buffer.concat([
      ProtobufWriter.encodeVarintField(1, 1318),
      ProtobufWriter.encodeVarintField(2, 1500),
      ProtobufWriter.encodeVarintField(3, 1000),
      ProtobufWriter.encodeVarintField(5, 4000),
    ]);
    const field4 = ProtobufWriter.encodeLengthDelimited(4, usageMsg);
    const timingInner = ProtobufWriter.encodeLengthDelimited(4, ProtobufWriter.encodeVarintField(1, nowSec));
    const field9 = ProtobufWriter.encodeLengthDelimited(9, timingInner);

    const wrapped = Buffer.concat([field19, field4, field9]);
    const genBlob = ProtobufWriter.encodeLengthDelimited(1, wrapped);
    const hexBlob = genBlob.toString('hex');

    // 使用系统 sqlite3 创建表并插入模拟生成记录
    const sqlInit = `
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, status INTEGER, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      INSERT INTO gen_metadata (idx, data) VALUES (1, X'${hexBlob}');
    `;
    await execFileAsync('/usr/bin/sqlite3', [dbPath, sqlInit]);

    // 运行 UsageStatsManager
    const usageMgr = new UsageStatsManager({ geminiDir: sandbox, stateDir: sandbox });
    const summary = await usageMgr.getUsageSummary();

    assert.equal(summary.databases_scanned, 1);
    assert.equal(summary.generations_scanned, 1);
    assert.equal(summary.today.totals.input_tokens, 1500);
    assert.equal(summary.today.totals.output_tokens, 1000);
    assert.equal(summary.today.totals.cached_tokens, 4000);
    assert.equal(summary.today.totals.total_tokens, 6500);
    assert.equal(summary.today.totals.request_count, 1);

    // 验证 API 美元估算公式：
    // gemini-3.8-flash: input 0.75, output 3.75, cached 0.075 per 1M
    // Model enum is excluded; estimate uses only actual input, output and cache reads.
    const expectedUsd = calculateEstimatedUsd(1500, 1000, 4000, DEFAULT_API_PRICES['gemini-3.8-flash']);
    assert.equal(summary.today.estimated_usd, expectedUsd);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 3. Keychain 免密写入、倒计时格式化与本地 5 桶配额架构单测
// -------------------------------------------------------------
test('Keychain 免密写入、倒计时格式化与 5 桶配额架构', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-auth-'));
  try {
    const mockKeychain = new MockKeychainAdapter();

    // 1. 验证相对重置时间倒计时格式化
    assert.equal(formatResetCountdown(''), '');
    assert.equal(formatResetCountdown(null), '');
    assert.equal(formatResetCountdown(Date.now() - 1000), '重置时间已过');
    assert.equal(formatResetCountdown(Date.now() + 30000), '即将重置');
    // 2小时后
    const twoHoursLater = new Date(Date.now() + 2 * 3600 * 1000 + 15 * 60 * 1000).toISOString();
    const cd2h = formatResetCountdown(twoHoursLater);
    assert.ok(cd2h.includes('小时') && cd2h.includes('分后重置'));
    // 5天后
    const fiveDaysLater = new Date(Date.now() + 5 * 86400 * 1000 + 4 * 3600 * 1000).toISOString();
    const cd5d = formatResetCountdown(fiveDaysLater);
    assert.ok(cd5d.includes('天') && cd5d.includes('小时后重置'));

    // 2. 验证 syncAccountToKeychain
    const testAccount = {
      id: 'acc-kc-test',
      email: 'pilot@antigravity.dev',
      name: 'Pilot User',
      token: {
        access_token: 'acc-token-456',
        refresh_token: 'ref-token-456',
        expires_in: 3600,
        expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'Bearer',
        email: 'pilot@antigravity.dev',
        project_id: 'proj-789',
        is_gcp_tos: false,
      },
      device_profile: generateDeviceProfile(),
      disabled: false,
      protected_models: [],
      validation_blocked: false,
      created_at: 1000,
      last_used: 1000,
    };

    await syncAccountToKeychain(testAccount, mockKeychain);
    const kcVal = await mockKeychain.readPassword('gemini', 'antigravity');
    assert.ok(kcVal?.startsWith('go-keyring-base64:'));
    const decoded = JSON.parse(Buffer.from(kcVal.slice('go-keyring-base64:'.length), 'base64').toString('utf8'));
    assert.equal(decoded.token.email, 'pilot@antigravity.dev');
    assert.equal(decoded.token.refresh_token, 'ref-token-456');
    // 回归：官方 Go 端按 oauth2.Token 解析，缺 expiry 会被视为永不过期而不刷新，约 1 小时后 401 并跳登录页。
    assert.equal(typeof decoded.token.expiry, 'string');
    assert.equal(Date.parse(decoded.token.expiry) / 1000, testAccount.token.expiry_timestamp);
    assert.equal(decoded.token.token_type, 'Bearer');
    assert.equal(decoded.id_token_email, 'pilot@antigravity.dev');
    assert.equal(decoded.auth_method, 'consumer');
    assert.ok(decoded.token.expires_in > 0 && decoded.token.expires_in <= 3600);

    // 3. 验证 3 分组 5 配额桶与 13 模型多维结构
    const mgr = new AccountsManager(sandbox);
    const quotaData = {
      models: [
        { name: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', percentage: 72, reset_time: twoHoursLater },
        { name: 'claude-3-5-sonnet', display_name: 'Claude 3.5 Sonnet', percentage: 46, reset_time: fiveDaysLater },
        { name: 'gemini-4-argon', display_name: 'Gemini 4 Argon', percentage: 100, reset_time: fiveDaysLater },
      ],
      quota_groups: [
        {
          display_name: 'Gemini Models',
          buckets: [
            { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.91, reset_time: fiveDaysLater },
            { bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 0.72, reset_time: twoHoursLater },
          ],
        },
        {
          display_name: 'Claude and GPT models',
          buckets: [
            { bucket_id: '3p-weekly', window: 'weekly', remaining_fraction: 0.46, reset_time: fiveDaysLater },
            { bucket_id: '3p-5h', window: '5h', remaining_fraction: 1.0, reset_time: twoHoursLater },
          ],
        },
        {
          display_name: 'Gemini 4 Argon',
          buckets: [
            { bucket_id: 'gemini-argon-wtu-weekly', window: 'weekly', remaining_fraction: 1.0, reset_time: fiveDaysLater },
          ],
        },
      ],
      last_updated: Math.floor(Date.now() / 1000),
      is_forbidden: false,
      subscription_tier: 'PRO',
      model_forwarding_rules: {},
    };

    testAccount.quota = quotaData;
    const overview = mgr.getAccountQuotaOverview(testAccount);
    assert.equal(overview.subscriptionTier, 'PRO');
    assert.equal(overview.geminiFiveHourRemaining, 72);
    assert.equal(overview.geminiWeeklyRemaining, 91);
    assert.equal(overview.claudeFiveHourRemaining, 100);
    assert.equal(overview.claudeWeeklyRemaining, 46);
    assert.equal(overview.argonWeeklyRemaining, 100);
    assert.ok(overview.geminiResetCountdown.includes('小时'));
    assert.ok(overview.claudeResetCountdown.includes('天'));
    assert.equal(overview.quotaGroups.length, 3);
    assert.equal(overview.models.length, 3);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// 4. IPC 指令全面集成测试 (通过启动子进程验证新 IPC Action)
// -------------------------------------------------------------
test('Main IPC 集成测试: 0.9.0 账号管理、额度策略、Token 用量与四端检测接口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gb-ipc-090-'));
  await mkdir(join(directory, '词典'));
  await writeFile(join(directory, '词典/个人覆盖.json'), '{ "Base": "基础" }\n');

  const mockGeminiDir = join(directory, 'gemini');
  const mockHomeDir = join(directory, 'home');
  const mockAppSupportDir = join(directory, 'app-support');
  await mkdir(mockGeminiDir, { recursive: true });
  await mkdir(mockHomeDir, { recursive: true });
  await mkdir(mockAppSupportDir, { recursive: true });

  // 1. 注入沙箱真实会话数据库，产生真实 Token 用量
  const mockConvDir = join(mockGeminiDir, 'antigravity', 'conversations');
  await mkdir(mockConvDir, { recursive: true });
  const mockDbPath = join(mockConvDir, 'ipc-metrics.db');
  const nowSec = Math.floor(Date.now() / 1000);
  const f19 = ProtobufWriter.encodeString(19, 'gemini-3.8-flash');
  const uMsg = Buffer.concat([
    ProtobufWriter.encodeVarintField(1, 1318),
    ProtobufWriter.encodeVarintField(2, 600),
    ProtobufWriter.encodeVarintField(3, 800),
    ProtobufWriter.encodeVarintField(5, 1200),
  ]);
  const f4 = ProtobufWriter.encodeLengthDelimited(4, uMsg);
  const tInner = ProtobufWriter.encodeLengthDelimited(4, ProtobufWriter.encodeVarintField(1, nowSec));
  const f9 = ProtobufWriter.encodeLengthDelimited(9, tInner);
  const genBlob = ProtobufWriter.encodeLengthDelimited(1, Buffer.concat([f19, f4, f9]));

  await execFileAsync('/usr/bin/sqlite3', [
    mockDbPath,
    `CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, status INTEGER, step_payload BLOB);
     CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
     INSERT INTO gen_metadata (idx, data) VALUES (1, X'${genBlob.toString('hex')}');`,
  ]);

  // 2. 注入沙箱独立凭据，供 account_save_current 提取
  const standaloneDir = join(mockHomeDir, '.gemini');
  await mkdir(standaloneDir, { recursive: true });
  await writeFile(
    join(standaloneDir, 'jetski-standalone-oauth-token'),
    JSON.stringify({
      token: {
        access_token: 'ipc-current-acc-token',
        refresh_token: '1//ipc-current-ref-token',
        expires_in: 3600,
        expiry_timestamp: nowSec + 3600,
        email: 'ipc-current@antigravity.test',
      },
    })
  );

  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../dist/main.js', import.meta.url)),
      '--state-dir',
      directory,
      '--app',
      '/nonexistent',
      '--profile',
      join(directory, 'profile'),
      '--gemini-dir',
      mockGeminiDir,
      '--home-dir',
      mockHomeDir,
      '--app-support-dir',
      mockAppSupportDir,
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, GRAVITYBOX_PROBE_LS: 'false' },
    }
  );

  let errors = '';
  child.stderr.on('data', b => {
    errors += b;
  });

  try {
    await until(async () => {
      try {
        return (await rpc(directory, { command: 'status' })).ok;
      } catch {
        return false;
      }
    });

    // 1. 测试扩展后的 dashboard_summary
    const summary = await rpc(directory, { command: 'dashboard_summary' });
    assert.equal(summary.ok, true);
    assert.ok(summary.dictionary);
    assert.equal(typeof summary.dictionary.total, 'number');
    assert.ok(summary.accounts);
    assert.equal(typeof summary.accounts.total, 'number');
    assert.equal(typeof summary.accounts.activeEmail, 'string');
    assert.equal(typeof summary.accounts.activeTier, 'string');
    assert.equal(typeof summary.accounts.resetTime, 'string');
    assert.equal(summary.accounts.geminiFiveHourRemaining, null);
    assert.equal(summary.accounts.geminiWeeklyRemaining, null);
    assert.equal(summary.accounts.claudeFiveHourRemaining, null);
    assert.equal(summary.accounts.claudeWeeklyRemaining, null);
    assert.equal(summary.accounts.argonWeeklyRemaining, null);
    assert.ok(summary.usage);
    assert.equal(summary.sync, undefined);
    // 门禁整改验证：验证非零 Token 与 5 桶配额数组
    assert.ok(summary.usage.todayTokens > 0);
    assert.ok(summary.usage.totalTokens > 0);
    assert.ok(Array.isArray(summary.accounts.quotaGroups));
    assert.ok(Array.isArray(summary.accounts.models));

    // 1.1 测试 account_save_current (从沙箱注入的 jetski-standalone-oauth-token 自动提取并保存)
    const saveCurrRes = await rpc(directory, { command: 'account_save_current' });
    assert.equal(saveCurrRes.ok, true);
    assert.equal(saveCurrRes.account.email, 'ipc-current@antigravity.test');

    // 2. 测试 account_upsert 与 account_list
    const addRes = await rpc(directory, {
      command: 'account_upsert',
      data: {
        email: 'ipc-user@gravity.test',
        refreshToken: '1//ipc-refresh',
        name: 'IPC User',
        customLabel: '测试号',
      },
    });
    assert.equal(addRes.ok, true);
    assert.equal(addRes.account.email, 'ipc-user@gravity.test');

    const listRes = await rpc(directory, { command: 'account_list' });
    assert.equal(listRes.ok, true);
    assert.equal(listRes.accounts.length, 2);
    assert.equal(typeof listRes.activeId, 'string');
    assert.ok(listRes.accounts.some(a => a.email === 'ipc-user@gravity.test'));
    assert.ok(listRes.accounts.some(a => a.email === 'ipc-current@antigravity.test'));
    assert.equal(listRes.accounts[0].fiveHourRemaining, null);
    assert.equal(listRes.accounts[0].weeklyRemaining, null);
    assert.equal(typeof listRes.accounts[0].subscription_tier, 'string');
    assert.equal(typeof listRes.accounts[0].resetTime, 'string');
    assert.equal(listRes.accounts[0].quota.five_hour_remaining, null);

    // 2.1 测试 account_export 兼容 data 与 export
    const exportRes = await rpc(directory, { command: 'account_export' });
    assert.equal(exportRes.ok, true);
    assert.ok(exportRes.export);
    assert.ok(exportRes.data);

    // 3. 测试 auto_switch_get 与 auto_switch_set
    const setCfgRes = await rpc(directory, {
      command: 'auto_switch_set',
      config: {
        enabled: true,
        strategy: 'round_robin',
        reserve_percentage: 15,
        candidate_min_percentage: 40,
      },
    });
    assert.equal(setCfgRes.ok, true);
    assert.equal(setCfgRes.config.reserve_percentage, 15);
    assert.equal(setCfgRes.config.strategy, 'round_robin');

    const getCfgRes = await rpc(directory, { command: 'auto_switch_get' });
    assert.equal(getCfgRes.ok, true);
    assert.equal(getCfgRes.config.reserve_percentage, 15);

    // 3.1 测试 auto_switch_best
    const bestRes = await rpc(directory, { command: 'auto_switch_best' });
    assert.equal(bestRes.ok, true);
    assert.ok('account' in bestRes);
    assert.ok('message' in bestRes);

    // 4. 测试 usage_summary 与 api_pricing_get
    const usageRes = await rpc(directory, { command: 'usage_summary', period: 'today' });
    assert.equal(usageRes.ok, true);
    assert.equal(usageRes.period, 'today');
    assert.equal(usageRes.summary.today, undefined, '导出不能夹带其他周期的汇总');
    assert.equal(typeof usageRes.snapshotId, 'string');
    assert.equal(typeof usageRes.summary.totalTokens, 'number');
    assert.equal(typeof usageRes.summary.promptTokens, 'number');
    assert.ok(Array.isArray(usageRes.byModel));

    const pricingRes = await rpc(directory, { command: 'api_pricing_get' });
    assert.equal(pricingRes.ok, true);
    assert.ok(pricingRes.prices['gemini-3.8-flash']);

    // 5. 验证 dashboard_summary 返回 5 桶配额与 13 模型明细，且不含 sync 字段
    const dashRes = await rpc(directory, { command: 'dashboard_summary' });
    assert.equal(dashRes.ok, true);
    assert.equal(dashRes.sync, undefined);
    assert.ok(dashRes.accounts);
    assert.equal(dashRes.accounts.geminiFiveHourRemaining, null);
    assert.equal(dashRes.accounts.geminiWeeklyRemaining, null);
    assert.equal(dashRes.accounts.claudeFiveHourRemaining, null);
    assert.equal(dashRes.accounts.claudeWeeklyRemaining, null);
    assert.equal(dashRes.accounts.argonWeeklyRemaining, null);
    assert.ok(Array.isArray(dashRes.accounts.quotaGroups));
    assert.ok(Array.isArray(dashRes.accounts.models));

    // 6. 验证 stderr 保持为空 (零告警)
    assert.equal(errors, '');

    await rpc(directory, { command: 'stop' });
    await until(async () => child.exitCode === 0);
    await sleep(50);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
