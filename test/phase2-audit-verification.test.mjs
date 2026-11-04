import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AccountsManager } from '../dist/accounts.js';
import { UsageStatsManager, ProtobufWriter as W, PRICING_METADATA } from '../dist/usage.js';

test('阶段2验证 - B02: 残缺配额不覆盖已有 Gemini 双周期且明确警告', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-test-b02-'));
  const mgr = new AccountsManager(root);
  const a = await mgr.upsertAccount({
    email: 'b02@example.test',
    refreshToken: 'tok-refresh',
    accessToken: 'tok-access',
    expiresIn: 3600
  });

  const future = new Date(Date.now() + 3600000).toISOString();
  const bucket = (id, window, p) => ({ bucketId: id, window, remainingFraction: p, resetTime: future });

  a.quota = mgr.fuseQuota(
    { models: { 'gemini-2.5-pro': { quotaInfo: { remainingFraction: 0.5 } } } },
    { groups: [{ displayName: 'Gemini', buckets: [bucket('5h', '5h', 0.5), bucket('week', 'week', 0.3)] }] }
  );
  await mgr.saveAccount(a);
  mgr.probeLiveLanguageServer = async () => null;

  // 模拟接口只返回 Claude 周限额，缺少 Gemini
  const fakeFetch = async url => {
    const u = String(url);
    const body = u.includes('loadCodeAssist')
      ? {}
      : u.includes('fetchAvailableModels')
      ? { models: { 'gemini-2.5-pro': { quotaInfo: { remainingFraction: 0.8 } } } }
      : { groups: [{ displayName: 'Claude/GPT', buckets: [bucket('claude-week', 'week', 0.7)] }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const refreshed = await mgr.refreshQuota(a.id, fakeFetch);
  const overview = mgr.getAccountQuotaOverview(refreshed);

  assert.equal(overview.geminiFiveHourRemaining, null, '旧 5 小时值不得冒充本轮数据');
  assert.equal(overview.familyWindows.gemini.fiveHour.remaining, .5);
  assert.equal(overview.familyWindows.gemini.fiveHour.stale, true);
  assert.equal(overview.geminiWeeklyRemaining, null);
  assert.equal(overview.familyWindows.gemini.weekly.remaining, .3);
  assert.equal(overview.familyWindows.gemini.weekly.stale, true);
  assert.equal(overview.claudeWeeklyRemaining, 70, 'Claude 每周配额必须正确合并');
  assert.ok(refreshed.quota_refresh_error?.includes('Gemini'), '缺失 Gemini 周期时必须有明确警示信息');
});

test('阶段2验证 - B03: Argon 未知配额 (percentage_known=false) 保持为 null，不被兜底成 100%', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-test-b03-'));
  const mgr = new AccountsManager(root);
  const unknown = mgr.getAccountQuotaOverview({
    quota: {
      models: [{ name: 'gemini-4-argon', percentage: 100, percentage_known: false }],
      quota_groups: [],
      last_updated: Date.now() / 1000
    }
  });
  assert.equal(unknown.argonWeeklyRemaining, null, '未知的 Argon 百分比必须保持 null');
});

test('阶段2验证 - B05: WAL 模式写入能正确感知并触发缓存失效', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-test-b05-'));
  const convs = join(root, 'antigravity', 'conversations');
  await mkdir(convs, { recursive: true });
  const dbPath = join(convs, 'wal.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;CREATE TABLE steps(idx INTEGER,step_type INTEGER,metadata BLOB);CREATE TABLE gen_metadata(idx INTEGER,data BLOB);');

  function makeBlob() {
    const usage = Buffer.concat([W.encodeVarintField(2, 10), W.encodeVarintField(3, 2)]);
    return W.encodeLengthDelimited(1, Buffer.concat([W.encodeString(19, 'gemini-2.5-flash'), W.encodeLengthDelimited(4, usage)]));
  }

  const stmt = db.prepare('INSERT INTO gen_metadata VALUES(?,?)');
  stmt.run(1, makeBlob());

  const u = new UsageStatsManager({ geminiDir: root, stateDir: await mkdtemp(join(tmpdir(), 'gb-b05-state-')) });
  const first = await u.scanDatabaseEvents(dbPath);
  assert.equal(first.events.length, 1);

  // WAL 追加新事件
  stmt.run(2, makeBlob());
  const second = await u.scanDatabaseEvents(dbPath);
  assert.equal(second.events.length, 2, 'WAL 变动必须立即使缓存失效并读取到新事件');
  db.close();
});

test('阶段2验证 - B06: 数据库损坏时返回 hasError 并不被谎报为 0 消耗', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-test-b06-'));
  const convs = join(root, 'antigravity', 'conversations');
  await mkdir(convs, { recursive: true });
  await writeFile(join(convs, 'corrupt.db'), 'not a real sqlite db');

  const u = new UsageStatsManager({ geminiDir: root, stateDir: await mkdtemp(join(tmpdir(), 'gb-b06-state-')) });
  const bad = await u.getUsageSummary();
  assert.ok(bad.has_error || bad.hasError, '数据库损坏必须标记 has_error');
  assert.equal(bad.failed_databases_count, 1, '损坏数据库数量必须记录为 1');
});

test('阶段2验证 - B07: 缺少模型名的记录分配为未知模型且未计价', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-test-b07-'));
  const convs = join(root, 'antigravity', 'conversations');
  await mkdir(convs, { recursive: true });
  const dbPath = join(convs, 'unnamed.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps(idx INTEGER,step_type INTEGER,metadata BLOB);CREATE TABLE gen_metadata(idx INTEGER,data BLOB);');

  // 不包含 modelId 的 blob
  const usage = Buffer.concat([W.encodeVarintField(2, 50), W.encodeVarintField(3, 10)]);
  const unnamedBlob = W.encodeLengthDelimited(1, W.encodeLengthDelimited(4, usage));
  db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(1, unnamedBlob);
  db.close();

  const u = new UsageStatsManager({ geminiDir: root, stateDir: await mkdtemp(join(tmpdir(), 'gb-b07-state-')) });
  const res = await u.scanDatabaseEvents(dbPath);
  assert.equal(res.events.length, 1);
  assert.ok(res.events[0].model.includes('未知模型'), '缺少模型名应明确标为未知模型，绝不冒充 Gemini');
  
  const summary = await u.getUsageSummary();
  const unknownModelStat = summary.all_time.by_model.find(m => m.model.includes('未知模型'));
  assert.equal(unknownModelStat?.priced, false, '未知模型绝不能被计价');
});

test('阶段2验证 - R06: 内置价格表包含结构化审计元数据', () => {
  assert.ok(PRICING_METADATA.version, '必须有版本');
  assert.ok(PRICING_METADATA.sourceUrl, '必须有权威来源URL');
  assert.ok(PRICING_METADATA.effectiveDate, '必须有效日期');
});
