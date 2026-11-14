import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { UsageStatsManager } from '../dist/usage.js';
import { ProtobufWriter as W, ProtobufReader as P } from '../dist/protobuf.js';
import { calculateEstimatedUsd, matchPricingKeys } from '../dist/pricing.js';
import { projectProtobuf, GENERATION_PROJECTION } from '../dist/protobuf-projection.js';
import { SqliteReadSnapshot } from '../dist/sqlite-read.js';
import { UsageLedger } from '../dist/usage-ledger.js';
import { normalizeModelId } from '../dist/model-identity.js';

test('Vertex AI 模型路径清洗与价格归一化', () => {
  // 1. 规范化函数剥离 Vertex AI / GCP 前缀与 RPC 后缀
  assert.equal(
    normalizeModelId('publishers/google/models/gemini-4-carbon-preview'),
    'gemini-4-carbon-preview'
  );
  assert.equal(
    normalizeModelId('projects/my-enterprise-proj/locations/us-central1/publishers/google/models/gemini-2.5-flash:predict'),
    'gemini-2.5-flash'
  );
  assert.equal(
    normalizeModelId('publishers/google/models/gemini-4-carbon@001'),
    'gemini-4-carbon-001'
  );

  // 2. Pricing key 匹配
  assert.equal(matchPricingKeys('gemini-4-carbon-preview'), 'gemini-4-carbon');
  assert.equal(matchPricingKeys('gemini-4-carbon-001'), 'gemini-4-carbon');
  assert.equal(matchPricingKeys('gemini-2.5-flash'), 'gemini-2.5-flash');
});

test('追加型总账：即使底层数据库被官方清除，历史事件与 Token 依然完好留存', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'gb-ledger-test-'));
  try {
    const manager = new UsageStatsManager({ stateDir: tempDir, geminiDir: '/synthetic/gemini' });

    // 模拟初次读取：包含一个普通数据库和一个即将被删除的企业会话数据库
    const liveDb1 = '/synthetic/gemini/conversations/user-session-1.db';
    const enterpriseDb = '/synthetic/gemini/conversations/enterprise-session-carbon.db';

    manager.discoverDatabaseFiles = async () => [liveDb1, enterpriseDb];
    manager.scanDatabaseEvents = async (dbPath) => {
      if (dbPath === enterpriseDb) {
        return {
          events: [
            {
              event_key: '1111111111111111111111111111111111111111111111111111111111111111',
              model: 'gemini-4-carbon',
              input_tokens: 1000,
              output_tokens: 200,
              cached_tokens: 500,
              total_tokens: 1700,
              timestamp_seconds: 1731400000,
              account_id: 'acc-zhangli-1',
              account_email: 'account-two@example.invalid',
            },
          ],
          generationsScanned: 1,
          skippedLargeRecords: 0,
          cacheHit: false,
          hasError: false,
        };
      }
      return {
        events: [
          {
            event_key: '2222222222222222222222222222222222222222222222222222222222222222',
            model: 'gemini-2.5-flash',
            input_tokens: 500,
            output_tokens: 100,
            cached_tokens: 0,
            total_tokens: 600,
            timestamp_seconds: 1731400010,
            account_type: 'consumer',
            account_id: 'acc-personal-1',
            account_email: 'developer@example.invalid',
          },
        ],
        generationsScanned: 1,
        skippedLargeRecords: 0,
        cacheHit: false,
        hasError: false,
      };
    };

    const firstSummary = await manager.getUsageSummary(true);
    assert.equal(firstSummary.all_time.totals.total_tokens, 2300);
    assert.equal(firstSummary.all_time.totals.request_count, 2);

    // 检查账本文件是否已经持久化
    const ledger = await new UsageLedger(tempDir).load();
    assert.equal(ledger.length, 2);
    assert.ok(ledger.some(event => event.event_key === '1'.repeat(64)));
    assert.ok(ledger.some(event => event.event_key === '2'.repeat(64)));

    // 模拟场景：用户退出企业账号，Antigravity 官方物理删除了 enterpriseSession 数据库！
    const secondManager = new UsageStatsManager({ stateDir: tempDir, geminiDir: '/synthetic/gemini' });
    // 此时磁盘上仅剩 liveDb1，enterpriseDb 已经彻底消失
    secondManager.discoverDatabaseFiles = async () => [liveDb1];
    secondManager.scanDatabaseEvents = async () => ({
      events: [
        {
          event_key: '2222222222222222222222222222222222222222222222222222222222222222',
          model: 'gemini-2.5-flash',
          input_tokens: 500,
          output_tokens: 100,
          cached_tokens: 0,
          total_tokens: 600,
          timestamp_seconds: 1731400010,
          account_type: 'consumer',
          account_id: 'acc-personal-1',
          account_email: 'developer@example.invalid',
        },
      ],
      generationsScanned: 1,
      skippedLargeRecords: 0,
      cacheHit: false,
      hasError: false,
    });

    const secondSummary = await secondManager.getUsageSummary(true);
    // 即使 enterpriseDb 物理不存在，总账自动合并并保留了 carbon-event-1！
    assert.equal(secondSummary.all_time.totals.total_tokens, 2300);
    assert.equal(secondSummary.all_time.totals.request_count, 2);
    const carbonModel = secondSummary.all_time.by_model.find((m) => m.model === 'gemini-4-carbon');
    assert.ok(carbonModel);
    assert.equal(carbonModel.total_tokens, 1700);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('缺少原始事件时仅保留金额凭据，不从费率锁反推用量', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'gb-heal-test-'));
  try {
    // 构造场景：磁盘上没有任何 .db 文件，也没有 usage-ledger.json
    // 但 usage-rate-locks.json 中保留了 86 条 carbon 锁定记录
    const rateLocks = {
      version: 1,
      profiles: [
        {
          model: 'gemini-4-carbon',
          input: 2.0,
          output: 10.0,
          cached: 0.1,
          provenance: { platform: 'Google Cloud Vertex AI' },
        },
      ],
      entries: {
        '3333333333333333333333333333333333333333333333333333333333333333': {
          usd: 0.05,
          p: 0,
        },
      },
    };
    await writeFile(join(tempDir, 'usage-rate-locks.json'), JSON.stringify(rateLocks));

    const manager = new UsageStatsManager({ stateDir: tempDir, geminiDir: '/synthetic/empty' });
    manager.discoverDatabaseFiles = async () => [];

    const summary = await manager.getUsageSummary(true);
    assert.equal(summary.all_time.totals.request_count, 0);
    assert.equal(summary.all_time.totals.total_tokens, 0);
    assert.equal(summary.all_time.estimated_usd, 0);
    assert.equal(summary.all_time.by_model.length, 0);
    assert.deepEqual(summary.historical_amount_receipts, { unmatchedCount: 1, unmatchedUsd: 0.05 });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('账号下钻筛选器：首项全部账号，后续依次排列真实账号（按邮箱），杜绝虚假分类', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'gb-filter-test-'));
  try {
    const manager = new UsageStatsManager({ stateDir: tempDir, geminiDir: '/synthetic/gemini' });
    // 注入当前保存的已知真实账号列表（例如当前账号、第二个账号、第三个账号）
    manager.setKnownAccounts([
      { id: 'acc_siensen', email: 'account-one@example.invalid', name: '测试账号一' },
      { id: 'acc_zhangli', email: 'account-two@example.invalid', name: '测试账号二' },
      { id: 'acc_wenqi', email: 'account-three@example.invalid', name: 'Fixture Three' },
    ]);

    manager.discoverDatabaseFiles = async () => ['synthetic'];
    manager.scanDatabaseEvents = async () => ({
      events: [
        {
          event_key: 'ev-carbon-1',
          model: 'gemini-4-carbon',
          input_tokens: 1000,
          output_tokens: 200,
          cached_tokens: 0,
          total_tokens: 1200,
          timestamp_seconds: 1731420000,
          account_id: 'acc_zhangli',
          account_email: 'account-two@example.invalid',
        },
        {
          event_key: 'ev-flash-1',
          model: 'gemini-2.5-flash',
          input_tokens: 300,
          output_tokens: 100,
          cached_tokens: 0,
          total_tokens: 400,
          timestamp_seconds: 1731420100,
          account_id: 'acc_siensen',
          account_email: 'account-one@example.invalid',
        },
      ],
      generationsScanned: 2,
      skippedLargeRecords: 0,
      cacheHit: false,
      hasError: false,
    });

    // 1. 全部账号模式 (all)
    const allSummary = await manager.getUsageSummary(true, 'all');
    assert.equal(allSummary.all_time.totals.total_tokens, 1600);
    assert.equal(allSummary.all_time.totals.request_count, 2);
    // 依次为：全部账号、account-one@example.invalid、account-two@example.invalid、account-three@example.invalid
    assert.equal(allSummary.available_accounts?.length, 4);
    assert.equal(allSummary.available_accounts[0].id, 'all');
    assert.equal(allSummary.available_accounts[0].label, '全部账号');
    assert.equal(allSummary.available_accounts[1].label, 'account-one@example.invalid');
    assert.equal(allSummary.available_accounts[2].label, 'account-two@example.invalid');
    assert.equal(allSummary.available_accounts[3].label, 'account-three@example.invalid');
    assert.equal(allSummary.selected_account_id, 'all');

    // 2. 筛选测试账号二（account-two@example.invalid）— 包含其 Vertex 项目的 Gemini 4 Carbon
    const zhangliSummary = await manager.getUsageSummary(true, 'acc_zhangli');
    assert.equal(zhangliSummary.all_time.totals.total_tokens, 1200);
    assert.equal(zhangliSummary.all_time.totals.request_count, 1);
    assert.equal(zhangliSummary.all_time.by_model.length, 1);
    assert.equal(zhangliSummary.all_time.by_model[0].model, 'gemini-4-carbon');
    assert.equal(zhangliSummary.selected_account_id, 'acc_zhangli');

    // 3. 筛选当前账号测试账号一（account-one@example.invalid）
    const siensenSummary = await manager.getUsageSummary(true, 'acc_siensen');
    assert.equal(siensenSummary.all_time.totals.total_tokens, 400);
    assert.equal(siensenSummary.all_time.totals.request_count, 1);
    assert.equal(siensenSummary.all_time.by_model.length, 1);
    assert.equal(siensenSummary.all_time.by_model[0].model, 'gemini-2.5-flash');
    assert.equal(siensenSummary.selected_account_id, 'acc_siensen');

    // 4. 事件分页明细筛选测试
    const zhangliEvents = await manager.getUsageEvents('all', '', 0, 10, undefined, false, false, 'acc_zhangli');
    assert.equal(zhangliEvents.total, 1);
    assert.equal(zhangliEvents.rows[0].model, 'gemini-4-carbon');

    const siensenEvents = await manager.getUsageEvents('all', '', 0, 10, undefined, false, false, 'acc_siensen');
    assert.equal(siensenEvents.total, 1);
    assert.equal(siensenEvents.rows[0].model, 'gemini-2.5-flash');

    // 5. 并发请求不同账号时必须各自返回对应账号统计，不得串号
    const [allRes, zhangliRes, siensenRes] = await Promise.all([
      manager.getUsageSummary(false, 'all'),
      manager.getUsageSummary(false, 'acc_zhangli'),
      manager.getUsageSummary(false, 'acc_siensen'),
    ]);
    assert.equal(allRes.all_time.totals.total_tokens, 1600);
    assert.equal(zhangliRes.all_time.totals.total_tokens, 1200);
    assert.equal(siensenRes.all_time.totals.total_tokens, 400);
    assert.notEqual(zhangliRes.snapshot_id, siensenRes.snapshot_id);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('同账号无论个人订阅还是企业 Vertex AI 均合并归入该账号', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'gb-same-gmail-merge-'));
  try {
    const manager = new UsageStatsManager({ stateDir: tempDir, geminiDir: '/synthetic/gemini' });
    manager.setKnownAccounts([
      { id: 'acc_same', email: 'sameuser@example.com', name: 'SameUser' },
      { id: 'acc_other', email: 'other@example.com', name: 'OtherUser' },
    ]);

    const now = Math.floor(Date.now() / 1000);
    manager.discoverDatabaseFiles = async () => ['synthetic'];
    manager.scanDatabaseEvents = async () => ({
      events: [
        {
          event_key: 'ch-consumer-1',
          model: 'gemini-3.8-flash-n',
          input_tokens: 1000,
          output_tokens: 200,
          cached_tokens: 0,
          total_tokens: 1200,
          timestamp_seconds: now - 120,
          account_id: 'acc_same',
          account_email: 'sameuser@example.com',
          account_type: 'consumer',
          account_confidence: 'observed',
        },
        {
          event_key: 'ch-vertex-1',
          model: 'gemini-4-carbon',
          input_tokens: 2000,
          output_tokens: 500,
          cached_tokens: 0,
          total_tokens: 2500,
          timestamp_seconds: now - 60,
          account_id: 'acc_same',
          account_email: 'sameuser@example.com',
          account_type: 'enterprise_vertex',
          account_confidence: 'observed',
        },
      ],
      generationsScanned: 2,
      skippedLargeRecords: 0,
      cacheHit: false,
      hasError: false,
    });

    const allRes = await manager.getUsageSummary(true, 'all');
    assert.equal(allRes.all_time.totals.total_tokens, 3700);
    assert.equal(allRes.all_time.totals.request_count, 2);

    const sameAccount = await manager.getUsageSummary(true, 'acc_same');
    assert.equal(sameAccount.all_time.totals.total_tokens, 3700);
    assert.equal(sameAccount.all_time.totals.request_count, 2);
    assert.equal(sameAccount.available_accounts?.find(a => a.id === 'acc_same')?.total_tokens, 3700);

    const otherAccount = await manager.getUsageSummary(true, 'acc_other');
    assert.equal(otherAccount.all_time.totals.total_tokens, 0);
    assert.equal(otherAccount.all_time.totals.request_count, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

async function withUsageFixture(fn) {
  const d = await mkdtemp(join(tmpdir(), 'gb-usage-regression-'));
  try {
    await fn(d);
  } finally {
    await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
  }
}

const protoTime = (ts = Math.floor(Date.now() / 1000)) =>
  W.encodeLengthDelimited(9, W.encodeLengthDelimited(4, W.encodeVarintField(1, ts)));

test('官方ModelUsageStats的模型枚举不计入Token；空用量记录不计为消费或未知日期', () => withUsageFixture(async d => {
  const dir = join(d, 'antigravity', 'conversations');
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'usage.db'));
  db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB)');
  const insert = db.prepare('INSERT INTO gen_metadata VALUES(?,?)');
  const blob = fields => W.encodeLengthDelimited(1, fields);
  insert.run(0, blob(W.encodeLengthDelimited(4, W.encodeVarintField(1, 1322))));
  insert.run(1, blob(Buffer.concat([
    W.encodeString(19, 'gemini-2.5-flash'),
    W.encodeLengthDelimited(4, Buffer.concat([
      W.encodeVarintField(1, 1318),
      W.encodeVarintField(2, 10),
      W.encodeVarintField(3, 5),
      W.encodeVarintField(5, 3),
    ])),
    protoTime(),
  ])));
  db.close();
  const s = await new UsageStatsManager({ geminiDir: d, stateDir: d }).getUsageSummary(true);
  assert.equal(s.all_time.totals.input_tokens, 10);
  assert.equal(s.all_time.totals.total_tokens, 18);
  assert.equal(s.all_time.totals.request_count, 1);
  assert.equal(s.unknown_time_records, 0);
  assert.equal(s.availability, 'complete');
}));

test('缓存写入独立统计，未配置写入费率时不虚构费用；模型ID优先于可能重名的展示名', () => withUsageFixture(async d => {
  const dir = join(d, 'antigravity', 'conversations');
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'usage.db'));
  db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB)');
  const usage = Buffer.concat([
    W.encodeVarintField(1, 1318),
    W.encodeVarintField(2, 10),
    W.encodeVarintField(3, 5),
    W.encodeVarintField(4, 7),
    W.encodeVarintField(5, 3),
  ]);
  db.prepare('INSERT INTO gen_metadata VALUES(0,?)').run(
    W.encodeLengthDelimited(1, Buffer.concat([
      W.encodeString(19, 'gemini-2.5-flash-high'),
      W.encodeString(21, 'Gemini Flash'),
      W.encodeLengthDelimited(4, usage),
      protoTime(),
    ]))
  );
  db.close();
  const m = new UsageStatsManager({ geminiDir: d, stateDir: d });
  const s = await m.getUsageSummary(true);
  assert.equal(s.all_time.totals.total_tokens, 25);
  assert.equal(s.all_time.totals.cache_write_tokens, 7);
  assert.equal(s.all_time.by_model[0].model, 'gemini-2.5-flash-high');
  assert.equal(s.all_time.by_model[0].priced, false);
  assert.equal(s.today.totals.total_tokens, s.today_hourly.reduce((n, e) => n + e.total_tokens, 0));
  assert.equal(s.today_hourly[0].cache_write_tokens, 7);
  assert.equal((await m.getUsageEvents('all')).rows[0].estimated_usd, null);
  assert.throws(() => calculateEstimatedUsd(10, 5, 3, { model: 'synthetic', input: 1, output: 2, cached: 0.1 }, 7), /写入费率/);
  assert.equal(calculateEstimatedUsd(10, 5, 3, { model: 'synthetic', input: 1, output: 2, cached: 0.1, cacheWrite: 3 }, 7), 0.0000413);
}));

const protoUsage = n => W.encodeVarintField(2, n);
const protoExec = Buffer.from('synthetic-execution');
function protoGeneration(n, indices, exec = protoExec) {
  return Buffer.concat([
    W.encodeLengthDelimited(1, Buffer.concat([W.encodeLengthDelimited(4, protoUsage(n)), W.encodeString(19, 'gemini-2.5-flash')])),
    ...(indices === undefined ? [] : [W.encodeLengthDelimited(2, Buffer.concat(indices.map(W.encodeVarint)))]),
    W.encodeLengthDelimited(4, exec),
  ]);
}
function protoStep(n, ts, exec = protoExec) {
  return Buffer.concat([
    W.encodeLengthDelimited(1, W.encodeVarintField(1, ts)),
    W.encodeLengthDelimited(9, protoUsage(n)),
    W.encodeLengthDelimited(12, exec),
  ]);
}

test('超大元数据按字段投影：跨过800MB虚拟正文，读取和输出有界，尾部用量保留', () => {
  const payload = 800 * 1024 * 1024;
  const head = Buffer.concat([W.encodeVarint(8 * 8 + 2), W.encodeVarint(payload)]);
  const tail = protoGeneration(19, [130, 131]);
  const size = head.length + payload + tail.length;
  let totalRead = 0;
  const result = projectProtobuf(size, (offset, length) => {
    totalRead += length;
    const out = Buffer.alloc(length);
    for (const [start, part] of [[0, head], [head.length + payload, tail]]) {
      const l = Math.max(start, offset);
      const r = Math.min(start + part.length, offset + length);
      if (r > l) part.copy(out, l - offset, l - start, r - start);
    }
    return out;
  }, GENERATION_PROJECTION);
  assert.ok(totalRead < 256 * 1024);
  assert.ok(result.data.length < 1024);
  assert.equal(P.findVarint(P.findField(P.findField(result.data, 1), 4), 2), 19);
  assert.deepEqual(P.stepIndices(result.data), [130, 131]);
  assert.throws(() => projectProtobuf(3, () => Buffer.from([10, 8, 0]), GENERATION_PROJECTION), /越界/);
  const hugeTarget = Buffer.concat([W.encodeVarint(2 * 8 + 2), W.encodeVarint(100000), Buffer.alloc(100000)]);
  assert.throws(() => projectProtobuf(hugeTarget.length, (o, n) => hugeTarget.subarray(o, o + n), GENERATION_PROJECTION), /安全上限/);
});

test('真实SQLite超大BLOB的紧凑结果可传输，21MB记录被统计且原库哈希不变', () => withUsageFixture(async d => {
  const path = join(d, 'large.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB)');
  const blob = Buffer.concat([W.encodeLengthDelimited(8, Buffer.alloc(21 * 1024 * 1024)), protoGeneration(71, undefined)]);
  db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(0, blob);
  db.close();
  const sha = async () => createHash('sha256').update(await readFile(path)).digest('hex');
  const before = await sha();
  const reader = new SqliteReadSnapshot(path);
  try {
    const p = await reader.projectBlob('gen_metadata', 'data', 0);
    assert.equal(p.ok, true, p.error);
    assert.ok(p.rows[0].data_blob.length < 1024);
    assert.ok(p.rows[0].projectionBytesRead < 256 * 1024);
  } finally {
    await reader.close();
  }
  const scan = await new UsageStatsManager({ stateDir: d, geminiDir: d }).scanDatabaseEvents(path);
  assert.equal(scan.skippedLargeRecords, 0);
  assert.equal(scan.events[0].total_tokens, 71);
  assert.equal(await sha(), before);
}));

test('官方step_indices关联不依赖表行数相等，并核对执行标识与完整用量', () => withUsageFixture(async d => {
  const ts = Math.floor(Date.now() / 1000);
  const path = join(d, 'links.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB)');
  const insert = db.prepare('INSERT INTO gen_metadata VALUES(?,?)');
  insert.run(0, protoGeneration(11, [130, 131]));
  insert.run(1, protoGeneration(17, [140]));
  insert.run(2, protoGeneration(23, [150]));
  insert.run(3, protoGeneration(31, [160, 170]));
  insert.run(4, protoGeneration(41, [180]));
  const add = db.prepare('INSERT INTO steps VALUES(?,15,?)');
  add.run(130, protoStep(11, ts));
  add.run(140, protoStep(18, ts));
  add.run(150, protoStep(23, ts, Buffer.from('another-execution')));
  add.run(160, protoStep(31, ts));
  add.run(170, protoStep(31, ts));
  db.close();
  const scan = await new UsageStatsManager({ stateDir: d, geminiDir: d }).scanDatabaseEvents(path);
  assert.deepEqual(scan.events.map(e => e.timestamp_seconds), [ts, 0, 0, 0, 0]);
  assert.equal(scan.events.reduce((s, e) => s + e.total_tokens, 0), 123);
}));

test('损坏或缺失关联不按相等行数猜日期，packed/unpacked uint32均受边界约束', () => withUsageFixture(async d => {
  const ts = Math.floor(Date.now() / 1000);
  assert.deepEqual(P.stepIndices(Buffer.concat([W.encodeVarintField(2, 130), W.encodeVarintField(2, 300)])), [130, 300]);
  assert.deepEqual(P.stepIndices(Buffer.from([18, 1, 128])), []);
  const path = join(d, 'missing.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB)');
  db.prepare('INSERT INTO gen_metadata VALUES(0,?)').run(protoGeneration(5, [999]));
  db.prepare('INSERT INTO steps VALUES(7,15,?)').run(protoStep(5, ts));
  db.close();
  const scan = await new UsageStatsManager({ stateDir: d, geminiDir: d }).scanDatabaseEvents(path);
  assert.equal(scan.events[0].timestamp_seconds, 0);
}));

test('已关闭的WAL数据库可只读读取，数据库内容保持不变', () => withUsageFixture(async d => {
  const path = join(d, 'closed.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE sample(n);INSERT INTO sample VALUES(7);');
  db.close();
  const before = createHash('sha256').update(await readFile(path)).digest('hex');
  const reader = new SqliteReadSnapshot(path);
  try {
    const r = await reader.query('SELECT * FROM sample;');
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.rows, [{ n: 7 }]);
  } finally {
    await reader.close();
  }
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), before);
}));

test('默认统计全部会话库，超过30库也不会截断今日和累计用量', () => withUsageFixture(async d => {
  const conv = join(d, 'gemini', 'antigravity', 'conversations');
  await mkdir(conv, { recursive: true });
  const ts = Math.floor(Date.now() / 1000);
  for (let i = 1; i <= 40; i++) {
    const db = new DatabaseSync(join(conv, `${i}.db`));
    if (i < 5) db.exec('PRAGMA journal_mode=WAL;');
    db.exec('CREATE TABLE gen_metadata(idx INTEGER,data BLOB);');
    const body = Buffer.concat([
      W.encodeString(19, 'gemini-2.5-flash'),
      W.encodeLengthDelimited(4, W.encodeVarintField(2, i)),
      W.encodeLengthDelimited(9, W.encodeLengthDelimited(4, W.encodeVarintField(1, ts))),
    ]);
    db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(0, W.encodeLengthDelimited(1, body));
    db.close();
  }
  const m = new UsageStatsManager({ stateDir: d, geminiDir: join(d, 'gemini') });
  const s = await m.getUsageSummary();
  assert.equal(s.databases_scanned, 40);
  assert.equal(s.databases_discovered, 40);
  assert.equal(s.failed_databases_count, 0);
  assert.equal(s.today.totals.total_tokens, 820);
  assert.equal(s.all_time.totals.total_tokens, 820);
  assert.match(s.scan_scope_description, /全部 40/);
}));

test('新建未初始化空库与已移除临时库不计入失败，且故障库恢复后自动绕过错误缓存自愈', () => withUsageFixture(async d => {
  const conv = join(d, 'gemini', 'antigravity', 'conversations');
  await mkdir(conv, { recursive: true });
  const emptyInitPath = join(conv, 'initializing.db');
  const emptyDb = new DatabaseSync(emptyInitPath);
  emptyDb.close();
  const recoverablePath = join(conv, 'recovering.db');
  await writeFile(recoverablePath, 'not-a-valid-sqlite-header');

  const m = new UsageStatsManager({ stateDir: d, geminiDir: join(d, 'gemini') });
  const initScan = await m.scanDatabaseEvents(emptyInitPath);
  assert.equal(initScan.error, undefined);
  assert.equal(initScan.events.length, 0);

  const missingScan = await m.scanDatabaseEvents(join(conv, 'vanished.db'));
  assert.equal(missingScan.error, undefined);
  assert.equal(missingScan.events.length, 0);

  const firstSummary = await m.getUsageSummary();
  assert.equal(firstSummary.failed_databases_count, 1);

  await rm(recoverablePath, { force: true });
  const ts = Math.floor(Date.now() / 1000);
  const repairedDb = new DatabaseSync(recoverablePath);
  repairedDb.exec('CREATE TABLE gen_metadata(idx INTEGER,data BLOB);');
  const body = Buffer.concat([
    W.encodeString(19, 'gemini-2.5-flash'),
    W.encodeLengthDelimited(4, W.encodeVarintField(2, 42)),
    W.encodeLengthDelimited(9, W.encodeLengthDelimited(4, W.encodeVarintField(1, ts))),
  ]);
  repairedDb.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(0, W.encodeLengthDelimited(1, body));
  repairedDb.close();

  const healedSummary = await m.getUsageSummary(false);
  assert.equal(healedSummary.failed_databases_count, 0);
  assert.equal(healedSummary.availability, 'complete');
  assert.equal(healedSummary.today.totals.total_tokens, 42);
}));
