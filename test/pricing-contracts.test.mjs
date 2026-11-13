import test from "node:test";
import { describe as describeContractGroup } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UsageStatsManager, ProtobufWriter as W, matchPricingKeys, priceStatus, DEFAULT_API_PRICES, PRICING_METADATA, calculateEstimatedUsd } from "../dist/usage.js";

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("费率与价格 · optimization-20261022", { concurrency: false }, async () => {

const fixture=async fn=>{const dir=await mkdtemp(join(tmpdir(),'gb-opt-'));try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}};

test('活跃数据库按 WAL 变更排序，未知模型变体不套用价格，优惠价过期可识别',()=>fixture(async dir=>{
 const conv=join(dir,'antigravity','conversations');await mkdir(conv,{recursive:true});const older=join(conv,'old.db'),newer=join(conv,'new.db');await writeFile(older,'');await writeFile(newer,'');await utimes(older,1,1);await utimes(newer,2000,2000);await writeFile(older+'-wal','wal');const usage=new UsageStatsManager({stateDir:dir,geminiDir:dir});assert.equal((await usage.discoverDatabaseFiles(1))[0],older);
 for(const name of ['my-gpt-4o-unsupported','gemini-2.5-pro-expensive-custom','gemini-3.8-flash-lite','gemini-3.8-flash-exp']) assert.equal(matchPricingKeys(name),name);
 assert.equal(matchPricingKeys('gemini-2.5-flash-high'),'gemini-2.5-flash');assert.equal(priceStatus(DEFAULT_API_PRICES['gemini-3.8-flash'],Date.parse('2027-01-01')),'expired');
}));
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("费率与价格 · phase2-audit-verification", { concurrency: false }, async () => {
test('阶段2验证 - R06: 内置价格表包含结构化审计元数据', () => {
  assert.ok(PRICING_METADATA.version, '必须有版本');
  assert.ok(PRICING_METADATA.sourceUrl, '必须有权威来源URL');
  assert.ok(PRICING_METADATA.effectiveDate, '必须有效日期');
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("费率与价格 · repair-20261023", { concurrency: false }, async () => {
async function fixture(t){const d=await mkdtemp(join(tmpdir(),'gb-repair-'));t.after(async()=>{try{await rm(d,{recursive:true,force:true,maxRetries:10,retryDelay:50});}catch{}});return d;}
test('不凭等长步骤推断时间；精确价格覆盖优先、负价格拒绝',async t=>{const d=await fixture(t),dir=join(d,'antigravity','conversations');await mkdir(dir,{recursive:true});const db=new DatabaseSync(join(dir,'fixture.db'));db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB)');db.prepare('INSERT INTO gen_metadata VALUES(0,?)').run(W.encodeLengthDelimited(1,Buffer.concat([W.encodeString(19,'gemini-3.8-flash-n'),W.encodeLengthDelimited(4,W.encodeVarintField(2,1000000))])));db.prepare('INSERT INTO steps VALUES(99,15,?)').run(W.encodeLengthDelimited(1,W.encodeVarintField(1,Math.floor(Date.now()/1000))));db.close();const m=new UsageStatsManager({geminiDir:d,stateDir:d});await assert.rejects(m.savePricingTable({x:{model:'x',input:-1,output:1,cached:1}}),/无效/);await m.savePricingTable({'gemini-3.8-flash-n':{model:'gemini-3.8-flash-n',input:2,output:3,cached:1}});const s=await m.getUsageSummary(true);assert.equal(s.unknown_time_records,1);assert.equal(s.all_time.estimated_usd,0);assert.equal(s.today.totals.total_tokens,0);assert.equal(matchPricingKeys('gemini-3.8-flash-n'),'gemini-3.8-flash-n');assert.throws(()=>calculateEstimatedUsd(-1,0,0,{model:'x',input:1,output:1,cached:1}),/无效/);});
});
