import test from "node:test";
import { describe as describeContractGroup } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UsageStatsManager, ProtobufWriter as W, matchPricingKeys, DEFAULT_API_PRICES, ProtobufWriter, calculateEstimatedUsd, ProtobufReader } from "../dist/usage.js";
import { SqliteReadSnapshot } from "../dist/sqlite-read.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("用量与历史 · optimization-20261022", { concurrency: false }, async () => {
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const fixture=async fn=>{const dir=await mkdtemp(join(tmpdir(),'gb-opt-'));try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}};
const blob=(tokens=100,padding=0)=>Buffer.concat([W.encodeLengthDelimited(1,Buffer.concat([W.encodeString(19,'gemini-2.5-flash'),W.encodeLengthDelimited(4,W.encodeVarintField(2,tokens))])), ...(padding?[W.encodeLengthDelimited(99,Buffer.alloc(padding))]:[])]);

test('缺失时间保持累计，失败标记跨缓存命中保留；冷态全部失败不冒充零用量',()=>fixture(async dir=>{
 const dbPath=join(dir,'one.db'), db=new DatabaseSync(dbPath);db.exec('CREATE TABLE gen_metadata(idx INTEGER,data BLOB)');db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(0,blob());db.close();
 const usage=new UsageStatsManager({stateDir:dir,geminiDir:dir});usage.discoverDatabaseFiles=async()=>[dbPath];
 const first=await usage.getUsageSummary();assert.equal(first.all_time.totals.total_tokens,100);assert.equal(first.today.totals.total_tokens,0);assert.equal(first.unknown_time_records,1);assert.equal(first.availability,'partial');assert.equal(first.has_error,true);
 const cached=await usage.scanDatabaseEvents(dbPath);assert.equal(cached.hasError,true);assert.equal(cached.events[0].timestamp_seconds,0);
 const broken=join(dir,'broken.db');await writeFile(broken,'invalid database');const cold=new UsageStatsManager({stateDir:dir,geminiDir:dir});cold.discoverDatabaseFiles=async()=>[broken];const failed=await cold.getUsageSummary();assert.equal(failed.availability,'unavailable');assert.equal(failed.failed_databases_count,1);assert.equal(failed.database_diagnostics[0].state,'failed');assert.ok(!JSON.stringify(failed.database_diagnostics).includes(dir));
}));

test('用量按块读取总计超过32MB的hex输出，边界单条和有效记录均保留',()=>fixture(async dir=>{
 const dbPath=join(dir,'big.db'),db=new DatabaseSync(dbPath);db.exec('CREATE TABLE gen_metadata(idx INTEGER,data BLOB)');const insert=db.prepare('INSERT INTO gen_metadata VALUES(?,?)');insert.run(0,blob(11,9*1024*1024));insert.run(1,blob(17,9*1024*1024));insert.run(2,blob(23,16*1024*1024-100));db.close();
 const usage=new UsageStatsManager({stateDir:dir,geminiDir:dir});const result=await usage.scanDatabaseEvents(dbPath);assert.equal(result.events.length,3);assert.deepEqual(result.events.map(e=>e.input_tokens),[11,17,23]);assert.equal(result.skippedLargeRecords,0);
}));

test('用量取消中止在途读取，并发读共享同一轮，不返回假零',()=>fixture(async dir=>{
 const usage=new UsageStatsManager({stateDir:dir,geminiDir:dir});let calls=0;
 usage.discoverDatabaseFiles=async()=>[join(dir,'synthetic.db')];
 usage.scanDatabaseEvents=async(_p,_b,signal)=>{calls++;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return{events:[],generationsScanned:0,skippedLargeRecords:0,hasError:true,error:'读取已取消'};};
 const first=usage.getUsageSummary(),second=usage.getUsageSummary();await pause(0);assert.equal(usage.cancelRead(),true);const [a,b]=await Promise.all([first,second]);assert.equal(calls,1);assert.equal(a,b);assert.equal(a.availability,'unavailable');assert.match(a.database_diagnostics[0].category,/取消/);
}));

test('分批读取释放事务并拒绝把数据库变化冒充一致快照',()=>fixture(async dir=>{
 const path=join(dir,'snapshot.db'),db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL; CREATE TABLE data(id INTEGER PRIMARY KEY,value INTEGER); INSERT INTO data VALUES(1,100);');
 const reader=new SqliteReadSnapshot(path);try{assert.equal((await reader.query('SELECT value FROM data WHERE id=1;')).rows[0].value,100);db.exec('UPDATE data SET value=200; INSERT INTO data VALUES(2,300);');const same=await reader.query('SELECT * FROM data ORDER BY id;');assert.deepEqual(same.rows,[{id:1,value:200},{id:2,value:300}]);assert.equal(await reader.verifyUnchanged(),false);const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();assert.equal(checkpoint.busy,0);}finally{await reader.close();}
 const next=new SqliteReadSnapshot(path);try{const result=await next.query('SELECT * FROM data ORDER BY id;');assert.equal(result.ok,true,result.error);assert.deepEqual(result.rows,[{id:1,value:200},{id:2,value:300}]);}finally{await next.close();db.close();}
}));
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("用量与历史 · optimization-20261023", { concurrency: false }, async () => {

test('明细固定快照经历多次后台刷新保持稳定，同ID生成时间不可覆盖', async () => {
  const manager=new UsageStatsManager({geminiDir:'/synthetic'}), now=Math.floor(Date.now()/1000);
  let events=[{model:'custom-model',input_tokens:1,output_tokens:2,cached_tokens:0,total_tokens:3,timestamp_seconds:now}];
  manager.discoverDatabaseFiles=async()=>['fixture'];
  manager.scanDatabaseEvents=async()=>({events:events.map(x=>({...x})),generationsScanned:events.length,skippedLargeRecords:0});
  const first=await manager.getUsageEvents('all','',0,200,undefined,true);
  const unchanged=await manager.getUsageSummary(true);
  assert.equal(unchanged.generated_at,first.generated_at);
  for(let i=0;i<6;i++){events.push({...events[0],input_tokens:i+2,total_tokens:i+4,timestamp_seconds:now+i+1});await manager.getUsageSummary(true);}
  const old=await manager.getUsageEvents('all','',0,200,first.snapshot_id);
  assert.equal(old.total,1);assert.equal(old.generated_at,first.generated_at);
  manager.releaseSnapshot(first.snapshot_id);
});

test('今日统计与明细采用自然日半开边界，未来一日不能归入今日', async () => {
  const manager=new UsageStatsManager({geminiDir:'/synthetic'}), date=new Date();date.setHours(0,0,0,0);
  const begin=date.getTime()/1000;date.setDate(date.getDate()+1);const end=date.getTime()/1000;
  const make=timestamp_seconds=>({model:'custom',input_tokens:1,output_tokens:0,cached_tokens:0,total_tokens:1,timestamp_seconds});
  manager.discoverDatabaseFiles=async()=>['fixture'];manager.scanDatabaseEvents=async()=>({events:[make(begin-1),make(begin),make(end-1),make(end)],generationsScanned:4,skippedLargeRecords:0});
  const summary=await manager.getUsageSummary();const rows=await manager.getUsageEvents('today');
  assert.equal(summary.today.totals.request_count,2);assert.equal(rows.total,2);
  assert.equal(summary.today_hourly.reduce((n,x)=>n+x.request_count,0),2);
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("用量与历史 · phase1-credibility", { concurrency: false }, async () => {
const execFileAsync = promisify(execFile);

test('A03: 未知模型禁止套用默认价计费，统计未计价覆盖率', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-a03-'));
  try {
    const geminiDir = join(sandbox, '.gemini');
    const convDir = join(geminiDir, 'antigravity', 'conversations');
    await mkdir(convDir, { recursive: true });

    // 构造测试 SQLite 数据库，包含一个未知模型和一个已知模型
    const dbPath = join(convDir, 'test_unknown_pricing.db');
    await execFileAsync('/usr/bin/sqlite3', [
      dbPath,
      `CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);
       CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);`,
    ]);

    // 构造已知模型 gemini-3.8-flash: 1000 in, 500 out, 100 cached
    const knownUsage = Buffer.concat([
      ProtobufWriter.encodeField(1, 0, ProtobufWriter.encodeVarint(0)),
      ProtobufWriter.encodeField(2, 0, ProtobufWriter.encodeVarint(1000)),
      ProtobufWriter.encodeField(3, 0, ProtobufWriter.encodeVarint(500)),
      ProtobufWriter.encodeField(5, 0, ProtobufWriter.encodeVarint(100)),
    ]);
    const knownWrapped = Buffer.concat([
      ProtobufWriter.encodeField(4, 2, knownUsage),
      ProtobufWriter.encodeString(19, 'gemini-3.8-flash'),
    ]);
    const knownBlob = ProtobufWriter.encodeField(1, 2, knownWrapped);

    // 构造未知模型 audit-unknown-model: 1,000,000 in, 500,000 out
    const unknownUsage = Buffer.concat([
      ProtobufWriter.encodeField(1, 0, ProtobufWriter.encodeVarint(0)),
      ProtobufWriter.encodeField(2, 0, ProtobufWriter.encodeVarint(1000000)),
      ProtobufWriter.encodeField(3, 0, ProtobufWriter.encodeVarint(500000)),
    ]);
    const unknownWrapped = Buffer.concat([
      ProtobufWriter.encodeField(4, 2, unknownUsage),
      ProtobufWriter.encodeString(19, 'audit-unknown-model'),
    ]);
    const unknownBlob = ProtobufWriter.encodeField(1, 2, unknownWrapped);

    await execFileAsync('/usr/bin/sqlite3', [
      dbPath,
      `INSERT INTO gen_metadata (idx, data) VALUES (1, x'${knownBlob.toString('hex')}');
       INSERT INTO gen_metadata (idx, data) VALUES (2, x'${unknownBlob.toString('hex')}');`,
    ]);

    const mgr = new UsageStatsManager({ geminiDir });
    const summary = await mgr.getUsageSummary(true);

    const unknownModelEntry = summary.all_time.by_model.find(m => m.model === 'audit-unknown-model');
    assert.ok(unknownModelEntry, '必须包含未知模型记录');
    assert.equal(unknownModelEntry.total_tokens, 1500000);
    // 关键断言：未知模型费用严禁套用 Flash 价格 ($0.75+$1.875=$2.625)，必须为 0
    assert.equal(unknownModelEntry.estimated_usd, 0, '未匹配价格的模型费用必须为 0');

    // 关键断言：统计已计价与未计价模型数量
    assert.equal(summary.all_time.priced_models, 0);
    assert.equal(summary.all_time.unpriced_models, 2);
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
});

test('A04: 准确披露扫描范围与抽样上限 (杜绝隐藏 30 库上限自称全量)', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-a04-'));
  try {
    const geminiDir = join(sandbox, '.gemini');
    const convDir = join(geminiDir, 'antigravity', 'conversations');
    await mkdir(convDir, { recursive: true });

    // 创建 35 个合法的空 SQLite 数据库
    for (let i = 1; i <= 35; i++) {
      const p = join(convDir, `conv_${String(i).padStart(3, '0')}.db`);
      await execFileAsync('/usr/bin/sqlite3', [p, 'CREATE TABLE dummy (id INT);']);
    }

    const mgr = new UsageStatsManager({ geminiDir });
    const discoveredPaths = await mgr.discoverDatabaseFiles(30);
    assert.equal(discoveredPaths.length, 30, '显式范围参数可限制为30库');
    assert.equal(mgr.lastDiscoveredDatabaseCount, 35, '必须记录发现的真实总数 35');

    const summary = await mgr.getUsageSummary(true);
    assert.equal(summary.databases_scanned, 35);
    assert.equal(summary.databases_discovered, 35);
    assert.ok(summary.scan_scope_description.includes('全部 35 个会话数据库'));
    assert.ok(summary.scan_scope_description.includes('35 个'));
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
});

test('A05: 缺失时间戳保持为 0，不污染今日消耗与每小时分布', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-a05-'));
  try {
    const geminiDir = join(sandbox, '.gemini');
    const convDir = join(geminiDir, 'antigravity', 'conversations');
    await mkdir(convDir, { recursive: true });

    const dbPath = join(convDir, 'zero_timestamp.db');
    await execFileAsync('/usr/bin/sqlite3', [
      dbPath,
      `CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);
       CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);`,
    ]);

    // 构造一个完全没有 timing 且 steps 无对应时间戳的记录 (100,000 tokens)
    const usage = Buffer.concat([
      ProtobufWriter.encodeField(2, 0, ProtobufWriter.encodeVarint(80000)),
      ProtobufWriter.encodeField(3, 0, ProtobufWriter.encodeVarint(20000)),
    ]);
    const wrapped = Buffer.concat([
      ProtobufWriter.encodeField(4, 2, usage),
      ProtobufWriter.encodeString(19, 'gemini-3.8-flash'),
    ]);
    const blob = ProtobufWriter.encodeField(1, 2, wrapped);

    await execFileAsync('/usr/bin/sqlite3', [
      dbPath,
      `INSERT INTO gen_metadata (idx, data) VALUES (1, x'${blob.toString('hex')}');`,
    ]);

    const mgr = new UsageStatsManager({ geminiDir });
    const scanResult = await mgr.scanDatabaseEvents(dbPath);
    assert.equal(scanResult.events.length, 1);
    // 关键断言 1：事件时间戳必须为 0，不能被赋为当前时间戳 Date.now()
    assert.equal(scanResult.events[0].timestamp_seconds, 0, '缺失时间戳必须保持为 0');

    const summary = await mgr.getUsageSummary(true);
    // 关键断言 2：今日消耗不能包含该 100,000 tokens
    assert.equal(summary.today.totals.total_tokens, 0, '无时间戳历史事件不能算入今日消耗');
    // 关键断言 3：每小时分布中不应出现该记录
    assert.equal(summary.today_hourly.length, 0, '每小时分布不能包含无时间戳事件');
    // 关键断言 4：全量历史统计必须如实包含
    assert.equal(summary.all_time.totals.total_tokens, 100000, '全量统计应包含该事件');
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("用量与历史 · phase1-r-credibility", { concurrency: false }, async () => {
const execFileAsync = promisify(execFile);

test('R08: by_model 返回显式 priced: boolean 并区分近零计价与未计价', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-r08-test-'));
  try {
    const geminiDir = join(sandbox, '.gemini');
    const convDir = join(geminiDir, 'antigravity', 'conversations');
    await mkdir(convDir, { recursive: true });

    const dbPath = join(convDir, 'test_pricing.db');
    await execFileAsync('/usr/bin/sqlite3', [
      dbPath,
      `CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);
       CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);`,
    ]);

    const nowSec = Math.floor(Date.now() / 1000);
    const innerTiming = ProtobufWriter.encodeField(1, 0, ProtobufWriter.encodeVarint(nowSec));
    const timingBuf = ProtobufWriter.encodeField(4, 2, innerTiming);

    // 1. 构造 1 Token 的 gemini-2.5-flash (已计价微小消耗)
    const usagePriced = Buffer.concat([
      ProtobufWriter.encodeField(2, 0, ProtobufWriter.encodeVarint(1)),
      ProtobufWriter.encodeField(3, 0, ProtobufWriter.encodeVarint(0)),
    ]);
    const wrappedPriced = Buffer.concat([
      ProtobufWriter.encodeField(4, 2, usagePriced),
      ProtobufWriter.encodeString(19, 'gemini-2.5-flash'),
      ProtobufWriter.encodeField(9, 2, timingBuf),
    ]);
    const blobPriced = ProtobufWriter.encodeField(1, 2, wrappedPriced);

    // 2. 构造 未在定价表中的自定义模型 (未计价)
    const usageUnpriced = Buffer.concat([
      ProtobufWriter.encodeField(2, 0, ProtobufWriter.encodeVarint(500)),
      ProtobufWriter.encodeField(3, 0, ProtobufWriter.encodeVarint(500)),
    ]);
    const wrappedUnpriced = Buffer.concat([
      ProtobufWriter.encodeField(4, 2, usageUnpriced),
      ProtobufWriter.encodeString(19, 'unknown-unpriced-model-xyz'),
      ProtobufWriter.encodeField(9, 2, timingBuf),
    ]);
    const blobUnpriced = ProtobufWriter.encodeField(1, 2, wrappedUnpriced);

    await execFileAsync('/usr/bin/sqlite3', [
      dbPath,
      `INSERT INTO gen_metadata (idx, data) VALUES (1, x'${blobPriced.toString('hex')}'), (2, x'${blobUnpriced.toString('hex')}');`,
    ]);

    const uMgr = new UsageStatsManager({ stateDir: sandbox, geminiDir });
    const summary = await uMgr.getUsageSummary(true);

    const pricedItem = summary.today.by_model.find(m => m.model === 'gemini-2.5-flash');
    assert.ok(pricedItem, '必须包含 gemini-2.5-flash');
    assert.equal(pricedItem.priced, true, '在价格表中的模型必须显式标记 priced: true');

    assert.ok(pricedItem.estimated_usd > 0 && pricedItem.estimated_usd < 0.001, '微量费用由真实计价引擎保留，展示格式由原生测试验证');

    const unpricedItem = summary.today.by_model.find(m => m.model === 'unknown-unpriced-model-xyz');
    assert.ok(unpricedItem, '必须包含未知模型');
    assert.equal(unpricedItem.priced, false, '未在价格表中的模型必须显式标记 priced: false');
    assert.equal(unpricedItem.estimated_usd, 0, '未在价格表中的模型金额为 0');
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("用量与历史 · phase2-audit-verification", { concurrency: false }, async () => {
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
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("用量与历史 · preview-usage-events", { concurrency: false }, async () => {
test('请求明细：本地自然日边界、搜索、倒序分页、未知时间、未计价模型与隐私范围', async () => {
  const manager = new UsageStatsManager({geminiDir: '/synthetic/unused'});
  const now = Math.floor(Date.now()/1000);
  const start = new Date(); start.setHours(0,0,0,0);
  const today = start.getTime()/1000;
  const events = [
    {model:'custom-model', input_tokens:1,output_tokens:2,cached_tokens:3,total_tokens:6,timestamp_seconds:0},
    {model:'gemini-2.5-flash',input_tokens:10,output_tokens:20,cached_tokens:30,total_tokens:60,timestamp_seconds:today-1},
    ...Array.from({length:502},(_,i)=>({model:'gemini-2.5-flash',input_tokens:1,output_tokens:2,cached_tokens:3,total_tokens:6,timestamp_seconds:now+i})),
  ];
  manager.discoverDatabaseFiles = async()=>['synthetic'];
  manager.scanDatabaseEvents = async()=>({events,generationsScanned:events.length,skippedLargeRecords:0});
  const summary = await manager.getUsageSummary();
  const page = await manager.getUsageEvents('today','GEMINI',0,99999);
  assert.equal(page.total,summary.today.totals.request_count);
  assert.equal(page.rows.length,500);
  assert.ok(page.rows[0].timestamp_seconds >= page.rows.at(-1).timestamp_seconds);
  const second = await manager.getUsageEvents('today','',500,200);
  assert.equal(second.rows.length,2);
  assert.equal(page.rows.reduce((n,e)=>n+e.total_tokens,0)+second.rows.reduce((n,e)=>n+e.total_tokens,0),summary.today.totals.total_tokens);
  const unknown = await manager.getUsageEvents('all','custom');
  assert.equal(unknown.rows[0].timestamp_seconds,0);
  assert.equal(unknown.rows[0].estimated_usd,null);
  assert.equal(unknown.rows[0].priced,false);
  assert.deepEqual(Object.keys(unknown.rows[0]).sort(),['model','input_tokens','output_tokens','cached_tokens','total_tokens','timestamp_seconds','estimated_usd','priced'].sort());
  assert.equal((await manager.getUsageEvents('today','custom')).total,0);
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("用量与历史 · repair-20261023", { concurrency: false }, async () => {
async function fixture(t){const d=await mkdtemp(join(tmpdir(),'gb-repair-'));t.after(async()=>{try{await rm(d,{recursive:true,force:true,maxRetries:10,retryDelay:50});}catch{}});return d;}
test('目录发现错误保持不可用，真正空目录可为完整空数据',async t=>{const d=await fixture(t),file=join(d,'not-dir');await writeFile(file,'synthetic');const bad=await new UsageStatsManager({geminiDir:file,stateDir:d}).getUsageSummary(true);assert.equal(bad.availability,'unavailable');assert.ok(bad.failed_databases_count>0);assert.equal((await new UsageStatsManager({geminiDir:d,stateDir:d}).getUsageSummary()).availability,'complete');});
test('强制刷新跟随弱读取补强扫描，多个强请求合并',async t=>{const d=await fixture(t),m=new UsageStatsManager({geminiDir:d,stateDir:d});let unblock,flags=[];m.collectUsage=async force=>{flags.push(force);if(!force)await new Promise(r=>unblock=r);return{synthetic:true}};const weak=m.getUsageSummary();const a=m.getUsageSummary(true),b=m.getUsageSummary(true);unblock();await Promise.all([weak,a,b]);assert.deepEqual(flags,[false,true]);});
test('明细固定快照分页，跨午夜摘要失效但既有导出快照可继续',async t=>{const d=await fixture(t),m=new UsageStatsManager({geminiDir:d,stateDir:d});const ActualDate=Date;let clock=new Date(2026,9,23,23,59,55).getTime();class Clock extends ActualDate{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock}}globalThis.Date=Clock;t.after(()=>globalThis.Date=ActualDate);m.discoverDatabaseFiles=async()=>['synthetic'];m.scanDatabaseEvents=async()=>({events:[{model:'gemini-2.5-flash',input_tokens:10,output_tokens:0,cached_tokens:0,total_tokens:10,timestamp_seconds:(clock-10000)/1000}],generationsScanned:1,skippedLargeRecords:0});const before=await m.getUsageSummary(true),id=before.snapshot_id;clock+=10000;const after=await m.getUsageSummary();assert.equal(after.today.totals.total_tokens,0);assert.notEqual(after.snapshot_id,id);assert.equal((await m.getUsageEvents('today','',0,200,id)).total,1);await assert.rejects(m.getUsageEvents('all','',0,200,'missing'),/过期/);});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("用量与历史 · v090-engines", { concurrency: false }, async () => {
const execFileAsync = promisify(execFile);

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

    // 验证当数据库 gen_metadata 同时包含 field 19 (response_model: "gemini-3.8-flash-n") 与 field 21 ("Gemini 3.8 Flash (High)") 时，提取真实 response_model 名称且不包含推理程度 High
    const dbFull = join(convDir, 'test-full-model.db');
    const wrappedFull = Buffer.concat([
      ProtobufWriter.encodeString(19, 'gemini-3.8-flash-n'),
      ProtobufWriter.encodeString(21, 'Gemini 3.8 Flash (High)'),
      field4,
      field9,
    ]);
    const hexFull = ProtobufWriter.encodeLengthDelimited(1, wrappedFull).toString('hex');
    await execFileAsync('/usr/bin/sqlite3', [
      dbFull,
      `CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, status INTEGER, step_payload BLOB);
       CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
       INSERT INTO gen_metadata (idx, data) VALUES (1, X'${hexFull}');`,
    ]);
    const summaryFull = await usageMgr.getUsageSummary(true);
    assert.ok(summaryFull.today.by_model.some(m => m.model === 'gemini-3.8-flash-n' && m.priced === true));
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
});
