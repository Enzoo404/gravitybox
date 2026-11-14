import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, lstat, utimes, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageStatsManager } from '../dist/usage.js';
import { ProtobufWriter as W } from '../dist/protobuf.js';
import { resolvePricingForTimestamp, DEFAULT_API_PRICES } from '../dist/pricing.js';
import { UsageLedger } from '../dist/usage-ledger.js';
import { CacheMaintenance } from '../dist/maintenance.js';
import { executeMoves, reconcileMoves, readMaintenanceManifest } from '../dist/maintenance-journal.js';
import { AccountsManager } from '../dist/accounts.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gb-remediation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, 'state'), gemini = join(dir, 'gemini'), conv = join(gemini, 'antigravity', 'conversations');
  const profile = join(dir, 'profile'), trash = join(dir, 'trash');
  for (const path of [state, conv, profile, trash]) await mkdir(path, { recursive: true });
  return { dir, state, gemini, conv, profile, trash };
}
function blob(input, output, timestamp = Math.floor(Date.now() / 1000) - 3) {
  return W.encodeLengthDelimited(1, Buffer.concat([W.encodeString(19, 'gemini-2.5-flash'),
    W.encodeLengthDelimited(4, Buffer.concat([W.encodeVarintField(2, input), W.encodeVarintField(3, output)])),
    ...(timestamp ? [W.encodeLengthDelimited(9, W.encodeLengthDelimited(4, W.encodeVarintField(1, timestamp)))] : [])]));
}
function database(path, data) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB,status INTEGER)');
  db.prepare('INSERT INTO gen_metadata VALUES(1,?)').run(data); db.close();
}

test('F01: amount receipts never manufacture requests, tokens or dates; legacy evidence stays unchanged', async t => {
  const f = await fixture(t);
  await writeFile(join(f.state, 'usage-rate-locks.json'), JSON.stringify({ version: 1, profiles: [{ model: 'gemini-4-carbon', input: 2, output: 10, cached: .1 }], entries: { ['a'.repeat(64)]: { usd: .05, p: 0 } } }));
  const m = new UsageStatsManager({ stateDir: f.state, geminiDir: f.gemini });
  const summary = await m.getUsageSummary(true);
  assert.equal(summary.all_time.totals.total_tokens, 0);
  assert.equal(summary.all_time.totals.request_count, 0);
  assert.deepEqual(summary.historical_amount_receipts, { unmatchedCount: 1, unmatchedUsd: .05 });
  assert.equal(summary.availability, 'partial');
  assert.equal(summary.has_error, false, 'legacy unmatched receipts alone must not set has_error when all DB reads succeed');
  assert.equal(existsSync(join(f.state, 'usage-ledger.json')), false);
});

test('F02/F18: evolving rows upsert once, backfilled timestamps survive offline reads, unknown ownership stays unknown', async t => {
  const f = await fixture(t), path = join(f.conv, '11111111-1111-4111-8111-111111111111.db');
  database(path, blob(100, 50, 0));
  const m = new UsageStatsManager({ stateDir: f.state, geminiDir: f.gemini });
  m.setCurrentAccountContext({ id: 'current', email: 'current@example.invalid' });
  const first = await m.getUsageSummary(true);
  assert.equal(first.all_time.totals.total_tokens, 150);
  assert.equal((await m.getUsageEvents('all')).rows[0].account_id, undefined);
  let db = new DatabaseSync(path); db.prepare('UPDATE gen_metadata SET data=?').run(blob(100, 100)); db.close();
  const second = await m.getUsageSummary(true);
  assert.equal(second.all_time.totals.total_tokens, 200);
  assert.equal(second.all_time.totals.request_count, 1);
  await rename(path, path + '.offline');
  const restarted = new UsageStatsManager({ stateDir: f.state, geminiDir: f.gemini });
  const offline = await restarted.getUsageSummary(true);
  assert.equal(offline.today.totals.total_tokens, 200);
  assert.equal(offline.unknown_time_records, 0);
  assert.equal((await new UsageLedger(f.state).load()).length, 1);
});

test('F03: corrupt/future legacy ledgers remain byte-for-byte intact with a persistent warning', async t => {
  for (const legacy of ['{broken', JSON.stringify({ version: 999, events: [] })]) {
    const f = await fixture(t); await writeFile(join(f.state, 'usage-ledger.json'), legacy);
    database(join(f.conv, '22222222-2222-4222-8222-222222222222.db'), blob(100, 50));
    const m = new UsageStatsManager({ stateDir: f.state, geminiDir: f.gemini });
    const summary = await m.getUsageSummary(true);
    assert.equal(await readFile(join(f.state, 'usage-ledger.json'), 'utf8'), legacy);
    assert.equal(existsSync(join(f.state, 'usage-ledger-v2.sqlite')), false);
    assert.ok(summary.pricing_warnings.some(w => w.includes('总账')));
    assert.equal(summary.has_error, true);
  }
});

test('F04: failed manifest creation precedes every move; a prepared crash plan can reconcile without overwriting', async t => {
  const f = await fixture(t); await mkdir(join(f.profile, 'Cache')); await writeFile(join(f.profile, 'Cache', 'sample'), 'cache');
  const m = new CacheMaintenance(f.profile, f.trash, async () => false, { geminiDir: f.gemini });
  const scan = await m.scan(); const now = Date.now, stamp = now();
  await mkdir(join(f.trash, `GravityBox-缓存-${stamp}`, '恢复清单.json'), { recursive: true });
  Date.now = () => stamp;
  try { await assert.rejects(m.clear(scan.token, ['Cache'])); }
  finally { Date.now = now; }
  assert.equal(await readFile(join(f.profile, 'Cache', 'sample'), 'utf8'), 'cache');
  const source = join(f.dir, 'source'), target = join(f.dir, 'target'), journal = join(f.dir, 'journal.json');
  await writeFile(source, 'original');
  const stat = await lstat(source); const identity = `${stat.dev}:${stat.ino}`;
  await writeFile(journal, JSON.stringify({ transaction: { phase: 'prepared', purpose: 'clear', moves: [{ from: source, to: target, identity }] } }));
  await rename(source, target);
  await reconcileMoves(journal, await readMaintenanceManifest(journal), async () => {});
  assert.equal(await readFile(source, 'utf8'), 'original');
  const original = join(f.dir, 'original'), displaced = join(f.dir, 'displaced'), snapshot = join(f.dir, 'snapshot');
  await writeFile(original, 'regenerated'); await writeFile(snapshot, 'old snapshot');
  await executeMoves(journal, {}, [{ from: original, to: displaced }, { from: snapshot, to: original }], async () => {}, { restoredAt: 'test' });
  assert.equal(await readFile(original, 'utf8'), 'old snapshot');
  assert.equal(await readFile(displaced, 'utf8'), 'regenerated');
});

test('F05/F08: missing summaries and missing parents never make a root DB safe; archived children protect siblings', async t => {
  const f = await fixture(t); const path = join(f.conv, '33333333-3333-4333-8333-333333333333.db'); database(path, blob(10, 1));
  const old = new Date(Date.now() - 10 * 86400000); await utimes(path, old, old);
  const db = new DatabaseSync(join(f.gemini, 'antigravity', 'conversation_summaries.db'));
  db.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,parent_conversation_id TEXT,status TEXT);CREATE TABLE conversations_fts(conversation_id TEXT,archived INTEGER);');
  const root = '44444444-4444-4444-8444-444444444444', archived = '55555555-5555-4555-8555-555555555555', sibling = '66666666-6666-4666-8666-666666666666';
  const insert = db.prepare('INSERT INTO conversation_summaries VALUES(?,?,?)');
  for (const [id, parent] of [[root, ''], [archived, root], [sibling, root]]) insert.run(id, parent, 'CASCADE_RUN_STATUS_IDLE');
  db.prepare('INSERT INTO conversations_fts VALUES(?,1)').run(archived); db.close();
  const m = new CacheMaintenance(f.profile, f.trash, async () => false, { geminiDir: f.gemini });
  const scan = await m.scan();
  assert.equal(scan.entries.some(e => e.name === 'OrphanAgentData'), false);
  assert.equal((await m.loadConversationIndex(join(f.gemini, 'antigravity'))).archivedTreeIds.has(sibling), true);
});

test('F06/F07: verified Flash rate has a documented local validity boundary; stale archive blocks cleanup', async t => {
  const price = resolvePricingForTimestamp(DEFAULT_API_PRICES['gemini-2.5-flash'], Date.parse('2026-11-12T12:00:00Z') / 1000);
  assert.deepEqual([price.input, price.output, price.cached], [.3, 2.5, .03]);
  assert.equal(resolvePricingForTimestamp(DEFAULT_API_PRICES['gemini-2.5-flash'], Date.parse('2026-11-01T12:00:00Z') / 1000), null);
  const f = await fixture(t), path = join(f.conv, '77777777-7777-4777-8777-777777777777.db'); database(path, blob(10, 1));
  const m = new UsageStatsManager({ stateDir: f.state, geminiDir: f.gemini });
  m.scanDatabaseEvents = async () => ({ events: [], generationsScanned: 0, skippedLargeRecords: 0, hasError: true, usedCached: true });
  await assert.rejects(m.archiveDatabasesBeforeClear([path]), /中止清理/);
});

test('F14: validate the full policy patch before the first mutation', async t => {
  const f = await fixture(t), m = new AccountsManager(f.state);
  await m.setAutoSwitchConfig({ enabled: true });
  const previous = await readFile(join(f.state, 'auto_switch.json'), 'utf8');
  for (const bad of [{ monitored_model: 42 }, { candidate_account_ids: 'broken' }, { enabled: 'yes' }, { candidate_account_ids: ['a', 'a'] }, { reserve_percentage: null }]) {
    await assert.rejects(m.setAutoSwitchConfig(bad));
    assert.equal(await readFile(join(f.state, 'auto_switch.json'), 'utf8'), previous);
  }
});

test('F06: history changes require a concrete preview, keep a full before copy, reject drift and can roll back',async t=>{
 const f=await fixture(t),m=new UsageStatsManager({stateDir:f.state,geminiDir:f.gemini});
 const timestamp=Math.floor(Date.now()/1000)-5;
 m.discoverDatabaseFiles=async()=>['synthetic'];
 m.scanDatabaseEvents=async()=>({events:[{event_key:'b'.repeat(64),model:'review-model',input_tokens:1000000,output_tokens:0,cached_tokens:0,total_tokens:1000000,timestamp_seconds:timestamp}],generationsScanned:1,skippedLargeRecords:0});
 await m.savePricingTable({'review-model':{model:'review-model',input:1,output:2,cached:.1}});
 assert.equal((await m.getUsageSummary(true)).all_time.estimated_usd,1);
 await m.savePricingTable({'review-model':{model:'review-model',input:2,output:3,cached:.1}});
 assert.equal((await m.getUsageSummary(true)).all_time.estimated_usd,1,'Published history stays locked before explicit review');
 await assert.rejects(m.revalueHistory(true),/预览/);
 const preview=await m.previewRevalueHistory();assert.equal(preview.before,1);assert.equal(preview.after,2);assert.ok(existsSync(preview.backup));assert.ok(existsSync(preview.candidate));
 assert.equal((await m.getUsageSummary(true)).all_time.estimated_usd,1,'Preview must not modify the active amount');
 await m.revalueHistory(true,{previewId:preview.previewId});assert.equal((await m.getUsageSummary(true)).all_time.estimated_usd,2);
 await m.restoreRevalueHistory(preview.previewId,true);assert.equal((await m.getUsageSummary(true)).all_time.estimated_usd,1);
 const stale=await m.previewRevalueHistory();await m.savePricingTable({'review-model':{model:'review-model',input:3,output:4,cached:.1}});await assert.rejects(m.revalueHistory(true,{previewId:stale.previewId}),/变化/);
});

test('F15: indexed aggregation pins a revision and streams large history without a main-process history array',async t=>{
 const f=await fixture(t),ledger=new UsageLedger(f.state),timestamp=Math.floor(Date.now()/1000)-5;
 const count=50001;
 for(let offset=0;offset<count;offset+=5000)await ledger.save(Array.from({length:Math.min(5000,count-offset)},(_,i)=>({event_key:(offset+i).toString(16).padStart(64,'0'),source_id:'large-fixture',generation_index:offset+i,model:'review-model',input_tokens:1,output_tokens:2,cached_tokens:3,total_tokens:6,timestamp_seconds:timestamp})));
 const m=new UsageStatsManager({stateDir:f.state,geminiDir:f.gemini});await m.savePricingTable({'review-model':{model:'review-model',input:1,output:2,cached:.1}});
 const report=await m.getUsageSummary(true);assert.equal(report.all_time.totals.total_tokens,count*6);assert.equal(m.usageLedgerEvents.size,0);
 const snapshot=report.snapshot_id;assert.equal((await m.getUsageEvents('all','',0,5,snapshot)).total,count);
 await ledger.save([{event_key:'e'.repeat(64),source_id:'large-fixture',model:'review-model',input_tokens:1,output_tokens:2,cached_tokens:3,total_tokens:6,timestamp_seconds:timestamp}]);
 assert.equal((await m.getUsageEvents('all','',0,5,snapshot)).total,count,'Appending new events must not change the pinned export');
});

test('F02/F15: later observations reject stale writes without appending a revision for unchanged facts',async t=>{
 const f=await fixture(t),ledger=new UsageLedger(f.state);
 const event={event_key:'c'.repeat(64),source_id:'ordered-fixture',source_observed_at:100,model:'review-model',input_tokens:100,output_tokens:50,cached_tokens:0,total_tokens:150,timestamp_seconds:Math.floor(Date.now()/1000)-5};
 await ledger.save([event]);const before=await ledger.version();
 await ledger.save([{...event,source_observed_at:200}]);assert.equal(await ledger.version(),before,'Observation-only renewal must not duplicate request revisions');
 await ledger.save([{...event,source_observed_at:150,input_tokens:1,total_tokens:51}]);const rows=await ledger.load();assert.equal(rows[0].total_tokens,150);assert.equal(rows[0].source_observed_at,200);
});

test('F04/F07: closed WAL database archives, clears and restores cleanly despite SHM read-mark updates', async t => {
  const f = await fixture(t);
  const agentDir = join(f.gemini, 'antigravity');
  const parent = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const child = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const index = new DatabaseSync(join(agentDir, 'conversation_summaries.db'));
  index.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,parent_conversation_id TEXT,status TEXT);CREATE TABLE conversations_fts(conversation_id TEXT,archived INTEGER)');
  const ins = index.prepare('INSERT INTO conversation_summaries VALUES(?,?,?)');
  ins.run(parent, '', 'CASCADE_RUN_STATUS_IDLE');
  ins.run(child, parent, 'CASCADE_RUN_STATUS_IDLE');
  index.close();

  const livePath = join(f.dir, 'live-wal.db');
  const live = new DatabaseSync(livePath);
  live.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,metadata BLOB)');
  const ts = Math.floor(Date.now() / 1000) - 10 * 86400;
  live.prepare('INSERT INTO gen_metadata VALUES(1,?)').run(blob(100, 50, ts));
  const source = join(f.conv, `${child}.db`);
  for (const suffix of ['', '-wal', '-shm']) await copyFile(livePath + suffix, source + suffix);
  live.close();
  const old = new Date(Date.now() - 10 * 86400000);
  for (const suffix of ['', '-wal', '-shm']) await utimes(source + suffix, old, old);

  const usage = new UsageStatsManager({ stateDir: f.state, geminiDir: f.gemini });
  const maintenance = new CacheMaintenance(f.profile, f.trash, async () => false, {
    geminiDir: f.gemini,
    stateDir: f.state,
    archiveDatabases: paths => usage.archiveDatabasesBeforeClear(paths),
    onMutated: () => usage.invalidateCache(),
  });
  const scan = await maintenance.scan({ retentionDays: 7 });
  const cleared = await maintenance.clear(scan.token, ['AgentSubagentDatabases']);
  assert.equal(cleared.moved, 1);
  assert.equal((await usage.getUsageSummary(true)).all_time.totals.total_tokens, 150);
  await maintenance.restore(basename(cleared.restorePath));
  assert.equal((await usage.getUsageSummary(true)).all_time.totals.total_tokens, 150);
});

test('usage calibration: gemini-3.8-flash-control priced, event_aliases prevents double-counting, and largeLedger fallback never returns 0', async t => {
  const f = await fixture(t);
  const price = resolvePricingForTimestamp(DEFAULT_API_PRICES['gemini-3.8-flash-control'], Math.floor(Date.parse('2026-11-12T12:00:00Z') / 1000));
  assert.deepEqual([price.input, price.output, price.cached], [0.75, 3.75, 0.075]);

  const ts = Math.floor(Date.now() / 1000) - 60;
  const legacyKey = 'f'.repeat(64);
  const v2Key = 'e'.repeat(64);
  const ledger = new UsageLedger(f.state);
  // Seed legacy duplicate without db_file + upgraded v2 event linked via legacy_event_key
  await ledger.save([
    { event_key: legacyKey, model: 'gemini-3.8-flash-control', input_tokens: 1000, output_tokens: 500, cached_tokens: 0, total_tokens: 1500, timestamp_seconds: ts },
    { event_key: v2Key, source_id: 'src-1', generation_index: 1, legacy_event_key: legacyKey, model: 'gemini-3.8-flash-control', input_tokens: 1000, output_tokens: 500, cached_tokens: 0, total_tokens: 1500, timestamp_seconds: ts },
  ]);

  const m = new UsageStatsManager({ stateDir: f.state, geminiDir: f.gemini });
  const count50k = Array.from({ length: 50001 }, (_, i) => ({
    event_key: (i + 100).toString(16).padStart(64, '0'),
    source_id: 'pad',
    generation_index: i + 100,
    model: 'gemini-3.8-flash-control',
    input_tokens: 1,
    output_tokens: 0,
    cached_tokens: 0,
    total_tokens: 1,
    timestamp_seconds: ts,
  }));
  for (let i = 0; i < count50k.length; i += 5000) await ledger.save(count50k.slice(i, i + 5000));

  const s = await m.getUsageSummary(true);
  assert.equal(s.all_time.totals.total_tokens, 50001 + 1500, 'event_aliases must deduplicate upgraded legacy rows without db_file');
  assert.equal(s.unpriced_models, 0);
  assert.equal(s.priced_models, 1);

  // Verify same-email context update keeps observation floor across both consumer and enterprise_vertex
  m.setCurrentAccountContext({ id: 'user@example.invalid', email: 'user@example.invalid', account_type: 'consumer' });
  const beforeSec = m.accountContextObservedAtSec;
  await new Promise(r => setTimeout(r, 1100));
  m.setCurrentAccountContext({ id: 'uuid-1234', email: 'user@example.invalid', account_type: 'consumer' });
  assert.equal(m.accountContextObservedAtSec, beforeSec);
  m.setCurrentAccountContext({ id: 'uuid-1234', email: 'user@example.invalid', account_type: 'enterprise_vertex' });
  assert.equal(m.accountContextObservedAtSec, beforeSec, 'same email switching between consumer and enterprise_vertex must keep observation floor');

  // Verify persisted observation timeline survives manager restart for events after observation
  const f2 = await fixture(t);
  const firstMgr = new UsageStatsManager({ stateDir: f2.state, geminiDir: f2.gemini });
  firstMgr.setCurrentAccountContext({ id: 'acc-live', email: 'live@example.invalid', account_type: 'enterprise_vertex' });
  await new Promise(r => setTimeout(r, 1100));
  const eventTs = Math.floor(Date.now() / 1000);
  database(join(f2.conv, '33333333-3333-4333-8333-333333333333.db'), blob(100, 50, eventTs));
  const secondMgr = new UsageStatsManager({ stateDir: f2.state, geminiDir: f2.gemini });
  const resAfterRestart = await secondMgr.getUsageSummary(true, 'acc-live');
  assert.equal(resAfterRestart.all_time.totals.total_tokens, 150);
  assert.equal(resAfterRestart.all_time.totals.request_count, 1);
});
