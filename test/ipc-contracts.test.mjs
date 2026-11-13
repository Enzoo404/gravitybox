import test from "node:test";
import { describe as describeContractGroup } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AccountsManager } from "../dist/accounts.js";
import { canonicalPayload, IdempotencyStore } from "../dist/ipc-idempotency.js";
import { promisify } from "node:util";
import { ProtobufWriter } from "../dist/usage.js";

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("undefined · audit-p1-backend", { concurrency: false }, async () => {

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const BUCKET_RESET_MS = 4 * 60 * 60 * 1000 + 19 * 60 * 1000; // 4h19m

function seededQuota(nowMs, { percentage = 80, gemini = true, claude = false } = {}) {
  const reset = new Date(nowMs + BUCKET_RESET_MS).toISOString();
  const groups = [];
  const bucket = (id, window) => ({ bucket_id: id, window, remaining_fraction: percentage / 100, remaining_fraction_known: true, reset_time: reset });
  if (gemini) groups.push({ display_name: 'Gemini', buckets: [bucket('gemini-5h', '5h'), bucket('gemini-week', 'week')] });
  if (claude) groups.push({ display_name: 'Claude/GPT', buckets: [bucket('claude-week', 'week')] });
  return {
    models: [
      { name: 'gemini-3.8-flash', percentage, percentage_known: true, reset_time: reset },
      ...(claude ? [{ name: 'claude-opus-4-6', percentage, percentage_known: true, reset_time: reset }] : []),
    ],
    quota_groups: groups,
    last_updated: Math.floor(nowMs / 1000),
    is_forbidden: false,
    model_forwarding_rules: {},
    subscription_tier: 'PRO',
    source: 'live',
  };
}

async function makeManager() {
  const dir = await mkdtemp(join(tmpdir(), 'gb-audit-p1-'));
  await mkdir(join(dir, '词典'), { recursive: true });
  return { dir, mgr: new AccountsManager(dir) };
}

// ---------- C01/C02：IPC 只读推荐不切号，且返回体不含 token ----------

function exchange(directory, request, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(directory, 'control.sock'));
    let value = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('IPC 超时')); }, timeout);
    const finish = error => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => { value += chunk; if (value.includes('\n')) finish(); });
    socket.on('error', finish);
  });
}

async function startBackend(directory) {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('../dist/main.js', import.meta.url)),
    '--state-dir', directory,
    '--app', '/nonexistent',
    '--profile', join(directory, 'profile'),
    '--home-dir', join(directory, 'home'),
    '--app-support-dir', join(directory, 'appsupport'),
    '--gemini-dir', join(directory, 'gemini'),
  ], { stdio: ['ignore', 'ignore', 'pipe'], env:{...process.env,GRAVITYBOX_PROBE_LS:'false'} });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += String(bytes); });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const reply = JSON.parse((await exchange(directory, { command: 'status', includeTasks: false })).split('\n')[0]);
      if (reply.ok) return { child, stderr: () => stderr };
    } catch {}
    await sleep(80);
  }
  child.kill();
  throw new Error(`后台未在时限内启动: ${stderr.slice(0, 400)}`);
}

test('C01/C02: auto_switch_best 默认只读、execute 需确认，IPC 响应不含任何 token', async () => {
  const { dir, mgr } = await makeManager();
  const nowMs = Date.now();
  const secretAccess = 'SECRET_ACCESS_TOKEN_DO_NOT_LEAK_AAA';
  const secretRefresh = 'SECRET_REFRESH_TOKEN_DO_NOT_LEAK_BBB';
  const secretId = 'SECRET_ID_TOKEN_DO_NOT_LEAK_CCC';
  try {
    const current = await mgr.upsertAccount({
      email: 'active@example.test', refreshToken: secretRefresh, accessToken: secretAccess,
      idToken: secretId, expiresIn: 3600,
    });
    current.quota = seededQuota(nowMs, { percentage: 5 });
    await mgr.saveAccount(current);
    const candidate = await mgr.upsertAccount({
      email: 'candidate@example.test', refreshToken: 'SECRET_REFRESH_CANDIDATE_DDD',
      accessToken: 'SECRET_ACCESS_CANDIDATE_EEE', expiresIn: 3600,
    });
    candidate.quota = seededQuota(nowMs, { percentage: 90 });
    await mgr.saveAccount(candidate);
    await mgr.setCurrentAccount(current.id, 'app');
    await mgr.setAutoSwitchConfig({ enabled: true, reserve_percentage: 10, candidate_min_percentage: 30 });

    const backend = await startBackend(dir);
    try {
      // 1) 默认（无 execute）只读：不得切号、不得返回 token。
      const rawDefault = (await exchange(dir, { command: 'auto_switch_best' })).split('\n')[0];
      for (const secret of [secretAccess, secretRefresh, secretId, 'SECRET_REFRESH_CANDIDATE_DDD', 'SECRET_ACCESS_CANDIDATE_EEE']) {
        assert.equal(rawDefault.includes(secret), false, `默认推荐响应不得包含凭据 ${secret.slice(0, 18)}…`);
      }
      for (const key of ['access_token', 'refresh_token', 'id_token']) {
        assert.equal(rawDefault.includes(key), false, `默认推荐响应不得出现字段 ${key}`);
      }
      const replyDefault = JSON.parse(rawDefault);
      assert.equal(replyDefault.ok, true);
      assert.equal(replyDefault.preview, true);
      assert.equal(replyDefault.executed, false);
      assert.equal(replyDefault.currentAccount.token, undefined);
      assert.equal(replyDefault.bestCandidate.token, undefined);
      assert.ok(replyDefault.currentAccount.email, '投影必须保留 native 需要的 email');
      assert.ok(replyDefault.currentAccount.quota, '投影必须保留 native 需要的 quota');

      // 2) 老调用方式 preview:true 仍然兼容且只读。
      const replyPreview = JSON.parse((await exchange(dir, { command: 'auto_switch_best', preview: true })).split('\n')[0]);
      assert.equal(replyPreview.ok, true);
      assert.equal(replyPreview.preview, true);
      assert.equal(replyPreview.executed, false);

      // 3) execute:true 缺少 confirmed:true：必须拒绝且不产生切号记录。
      const replyExecute = JSON.parse((await exchange(dir, { command: 'auto_switch_best', execute: true })).split('\n')[0]);
      assert.equal(replyExecute.ok, false);
      assert.match(replyExecute.error, /确认/);

      // 4) 只读命令的副作用为 0：没有切号 journal，索引仍指向原账号。
      await assert.rejects(readFile(join(dir, 'account-switch-journal-stable.json'), 'utf8'), /ENOENT/);
      const index = JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8'));
      assert.equal(index.current_account_id, current.id, '只读推荐不得修改当前账号');

      // 5) account_get 同样必须投影去 token。
      const rawGet = (await exchange(dir, { command: 'account_get', id: current.id })).split('\n')[0];
      assert.equal(rawGet.includes(secretAccess), false);
      assert.equal(rawGet.includes(secretRefresh), false);
      assert.equal(rawGet.includes(secretId), false);
      const replyGet = JSON.parse(rawGet);
      assert.equal(replyGet.ok, true);
      assert.equal(replyGet.account.token, undefined);
      assert.equal(replyGet.account.email, 'active@example.test');
    } finally {
      backend.child.kill();
      await sleep(250);
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("undefined · optimization-20261023", { concurrency: false }, async () => {

test('幂等性保留所有业务id，传输requestId可变，异目标必须冲突', () => {
  assert.deepEqual(canonicalPayload({requestId:'one',idempotencyKey:'k',id:'a',data:{id:'nested'}}),canonicalPayload({requestId:'two',idempotencyKey:'k',id:'a',data:{id:'nested'}}));
  assert.notDeepEqual(canonicalPayload({id:'a'}),canonicalPayload({id:'b'}));
  assert.notDeepEqual(canonicalPayload({data:{id:'a'}}),canonicalPayload({data:{id:'b'}}));
  const store=new IdempotencyStore();assert.equal(store.reserve('k','account-a',()=>{}),'owner');assert.equal(store.reserve('k','account-b',()=>{}),'conflict');
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("undefined · v090-engines", { concurrency: false }, async () => {
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
});
