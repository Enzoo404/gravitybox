import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ConversationMetricsEngine, buildConversationHudMetrics } from '../dist/hud.js';
import { compactNumber, durationText } from '../dist/metric-format.js';
import { UsageStatsManager, ProtobufWriter as W, resolvePricingForTimestamp } from '../dist/usage.js';
import { AntigravityHudManager } from '../runtime/hud-manager.js';
import { HudInstance } from '../runtime/hud-instance.js';

const u = (i = 100, o = 50) => Buffer.concat([W.encodeVarintField(2, i), W.encodeVarintField(3, o)]);
const timestamp = (field, value) => W.encodeLengthDelimited(field, W.encodeVarintField(1, value));
const meta = (i = 100, o = 50) => Buffer.concat([timestamp(1, 100), timestamp(7, 102), W.encodeLengthDelimited(9, u(i, o))]);
const setup = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gb-hud-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
};
test('manager recreation retains a monotonic epoch; transcript links never identify a pane', () => {
  const instance = new HudInstance('slot'); instance.switchConversation('A','claude-opus-5-5'); instance.switchConversation('B');
  assert.equal(instance.currentModelId,''); assert.equal(instance.lastMetrics.context.modelDisplayName,'—'); assert.equal(instance.lastMetrics.availability,'loading');
  const first = new AntigravityHudManager(), second = new AntigravityHudManager();
  const a = first.allocateSessionRevision(), b = second.allocateSessionRevision();
  assert.ok(b > a);
  const view = { getAttribute: () => null, querySelector: selector => selector === 'a[href*="/c/"]' ? { getAttribute: () => '/c/unrelated-transcript-link' } : null };
  assert.equal(second.resolveConversationId(view, null, 2), null);
  const previous = globalThis.window;
  globalThis.window = { location: { pathname: '/c/main-window' } };
  try { assert.equal(second.resolveConversationId({ ...view, getAttribute: name => name === 'data-media-drop-scope' ? 'subpane' : null }, null, 1), 'default'); }
  finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});
test('cleared model timing requires completion evidence; compact units carry before formatting', () => {
  const row = { stepType: 15, status: 5, hasUsage: true, rawInputTokens: 100, outputTokens: 50,
    startTimeSeconds: 100, endTimeSeconds: 102, firstTokenSeconds: 101, finishedGeneratingSeconds: 102 };
  const result = buildConversationHudMetrics({ steps: [row] });
  assert.equal(result.session.modelDurationSeconds, 2); assert.equal(result.session.outputTps, 25);
  assert.equal(buildConversationHudMetrics({ steps: [{ ...row, finishedGeneratingSeconds: null }] }).session.modelDurationSeconds, 0);
  assert.equal(compactNumber(999500), '1M'); assert.equal(compactNumber(995000, 2), '1M');
  assert.equal(compactNumber(999500000), '1B'); assert.equal(durationText(4826), '1 小时 20 分 26 秒');
});
test('changed historical metadata with same length plus append cannot evade a warm cache', async t => {
  const dir = await setup(t), path = join(dir, 'history.db'), db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,metadata BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);');
  const insert = db.prepare('INSERT INTO steps VALUES(?,15,3,?)'); for (let i = 0; i < 110; i++) insert.run(i, meta());
  const engine = new ConversationMetricsEngine({ conversationsDir: dir });
  const first = await engine.getConversationMetrics({ conversationId: 'history' }); assert.equal(first.tokens.totalTokens, 16500);
  assert.equal(meta(101).length, meta(100).length);
  db.prepare('UPDATE steps SET metadata=? WHERE idx=0').run(meta(101)); insert.run(110, meta());
  const warm = await engine.getConversationMetrics({ conversationId: 'history' });
  assert.equal(warm.tokens.totalTokens, 111 * 150 + 1, 'independent arithmetic oracle');
  db.exec('ALTER TABLE steps RENAME TO broken_steps;');
  const fallback = await engine.getConversationMetrics({ conversationId: 'history' });
  assert.equal(fallback.availability, 'cached'); assert.equal(fallback.observedAt, warm.observedAt);
  db.close();
  const missing = await engine.getConversationMetrics({ conversationId: 'missing' });
  assert.equal(missing.availability, 'unavailable'); assert.equal(missing.context.hasUsageData, false);
});
test('independent WAL writer and production worker progress concurrently; quiescent totals match oracle', async t => {
  const dir = await setup(t), path = join(dir, 'writer.db'), db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,metadata BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);'); db.close();
  const source = `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=1000'); let i=0;const st=db.prepare('INSERT INTO steps VALUES(?,15,3,?)'); const tick=()=>{st.run(i++,Buffer.from(process.argv[2],'hex')); if(i<80)setTimeout(tick,4);else{console.log(JSON.stringify(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()));db.close()}};tick();`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning','-e', source, path, meta().toString('hex')]);
  let failure = ''; child.stderr.on('data', b => failure += b); t.after(() => { if (child.exitCode == null) child.kill(); });
  const exited = new Promise((resolve,reject) => { child.once('error',reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(failure))); });
  const engine = new ConversationMetricsEngine({ conversationsDir: dir }); let heartbeats = 0;
  const heartbeat = setInterval(() => heartbeats++, 2);
  try { for (let i=0;i<12;i++) { await engine.getConversationMetrics({conversationId:'writer'}); await new Promise(r=>setTimeout(r,10)); } await exited; }
  finally { clearInterval(heartbeat); }
  assert.ok(heartbeats > 10, 'main loop stays responsive while worker reads');
  const final = await engine.getConversationMetrics({conversationId:'writer'});
  assert.equal(final.session.steps,80); assert.equal(final.tokens.totalTokens,80*150);
});
test('event prices survive manager restart and price-table replacement; unknown-time/gaps stay unpriced', async t => {
  const dir = await setup(t), conv = join(dir,'antigravity','conversations'); await mkdir(conv,{recursive:true});
  const db = new DatabaseSync(join(conv,'price.db'));
  db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);');
  const now = Math.floor(Date.now()/1000), blob = W.encodeLengthDelimited(1, Buffer.concat([
    W.encodeString(19,'audit-model'), W.encodeLengthDelimited(4,u(1000000,0)), W.encodeLengthDelimited(9,timestamp(4,now)),
  ])); db.prepare('INSERT INTO gen_metadata VALUES(0,?)').run(blob);db.close();
  const manager = new UsageStatsManager({geminiDir:dir,stateDir:dir});
  const prices = input => ({'audit-model':{model:'audit-model',input,output:1,cached:0}});
  await manager.savePricingTable(prices(2)); assert.equal((await manager.getUsageSummary(true)).all_time.estimated_usd,2);
  await manager.savePricingTable(prices(4)); assert.equal((await manager.getUsageSummary(true)).all_time.estimated_usd,2);
  const restarted = new UsageStatsManager({geminiDir:dir,stateDir:dir}); assert.equal((await restarted.getUsageSummary(true)).all_time.estimated_usd,2);
  assert.equal(Object.keys(JSON.parse(await readFile(join(dir,'usage-rate-locks.json'),'utf8')).entries).length,1);
  await assert.rejects(restarted.revalueHistory(false), /明确确认/);
  assert.equal((await restarted.revalueHistory(true)).after,4);
  assert.equal((await new UsageStatsManager({geminiDir:dir,stateDir:dir}).getUsageSummary(true)).all_time.estimated_usd,4);
  assert.equal(resolvePricingForTimestamp(prices(2)['audit-model'],0),null);
  assert.equal(resolvePricingForTimestamp([{input:1,output:1,cached:0,validUntil:'2026-01-01T00:00:00Z'}],now),null);
});

test('legacy rate-locks format is automatically and losslessly migrated to slim profiles format', async t => {
  const dir = await setup(t);
  const legacyEntryKey1 = 'a'.repeat(64);
  const legacyEntryKey2 = 'b'.repeat(64);
  const legacyPricing = { model: 'gemini-3.8-flash-n', input: 0.5, output: 3, cached: 0.125 };
  const legacyPayload = {
    version: 1,
    entries: {
      [legacyEntryKey1]: { usd: 0.046283, price: legacyPricing },
      [legacyEntryKey2]: { usd: 0.012345, price: legacyPricing }
    }
  };
  await writeFile(join(dir, 'usage-rate-locks.json'), JSON.stringify(legacyPayload, null, 2));

  const manager = new UsageStatsManager({ geminiDir: dir, stateDir: dir });
  // Trigger read and summary generation
  const summary = await manager.getUsageSummary(true);
  assert.ok(summary);

  const rawSaved = await readFile(join(dir, 'usage-rate-locks.json'), 'utf8');
  const migrated = JSON.parse(rawSaved);
  assert.equal(migrated.version, 1);
  assert.ok(Array.isArray(migrated.profiles));
  assert.equal(migrated.profiles.length, 1);
  assert.equal(migrated.profiles[0].model, 'gemini-3.8-flash-n');
  assert.equal(Object.keys(migrated.entries).length, 2);
  assert.equal(migrated.entries[legacyEntryKey1].usd, 0.046283);
  assert.equal(migrated.entries[legacyEntryKey1].p, 0);
  assert.equal(migrated.entries[legacyEntryKey2].usd, 0.012345);
  assert.equal(migrated.entries[legacyEntryKey2].p, 0);

  // Restart manager and verify it reads the migrated slim format correctly
  const restarted = new UsageStatsManager({ geminiDir: dir, stateDir: dir });
  const summaryAfterRestart = await restarted.getUsageSummary(true);
  assert.ok(summaryAfterRestart);
});
