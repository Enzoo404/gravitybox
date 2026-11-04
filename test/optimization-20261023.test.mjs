import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsManager } from '../dist/accounts.js';
import { UsageStatsManager } from '../dist/usage.js';
import { recoverFileSet } from '../dist/files.js';
import { canonicalPayload, IdempotencyStore } from '../dist/ipc-idempotency.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gb-optimization-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('删除事务中断后按原日志前进恢复；外部修改阻断且保留恢复记录', async t => {
  const dir = await fixture(t), a = join(dir,'a.json'), b = join(dir,'b.json'), journal = join(dir,'commit.json');
  await writeFile(a,'before-a'); await writeFile(b,'before-b');
  await writeFile(journal,JSON.stringify({changes:[{path:a,before:'before-a',after:null},{path:b,before:'before-b',after:'after-b'}]}));
  await rm(a);
  await recoverFileSet(journal,[a,b]);
  assert.equal(await readFile(b,'utf8'),'after-b'); await assert.rejects(access(a)); await assert.rejects(access(journal));
  await writeFile(journal,JSON.stringify({changes:[{path:b,before:'before-b',after:'after-b'}]}));
  await writeFile(b,'external-change');
  await assert.rejects(recoverFileSet(journal,[a,b]),/其他程序/);
  assert.equal(await readFile(b,'utf8'),'external-change'); await access(journal);
});

test('账号移除保留可恢复材料，文件、索引与墓碑一致，不能重新同步复活', async t => {
  const dir=await fixture(t), manager=new AccountsManager(dir);
  const account=await manager.upsertAccount({email:'remove@example.invalid',refreshToken:'synthetic-refresh',accessToken:'synthetic-access'});
  await manager.deleteAccount(account.id);
  assert.equal(await manager.getAccount(account.id),null);
  assert.equal((await manager.loadIndex()).accounts.length,0);
  assert.equal(JSON.parse(await readFile(join(dir,'accounts-deleted.json'),'utf8'))[0].id,account.id);
  const {readdir}=await import('node:fs/promises');const copies=await readdir(join(dir,'accounts-removed'));
  assert.equal(copies.length,1);
  const saved=JSON.parse(await readFile(join(dir,'accounts-removed',copies[0]),'utf8'));
  assert.equal(saved.account.email,account.email);
  assert.equal(saved.account.token.refresh_token,'synthetic-refresh');
});

test('读取损坏账号明确失败，原件及索引不被当作不存在清掉', async t => {
  const dir=await fixture(t), manager=new AccountsManager(dir);
  const account=await manager.upsertAccount({email:'broken@example.invalid',refreshToken:'synthetic'});
  const file=join(dir,'accounts',account.id+'.json'); await writeFile(file,'{broken');
  await assert.rejects(manager.getAccount(account.id),/格式损坏/);
  assert.equal(await readFile(file,'utf8'),'{broken');
  assert.equal((await manager.loadIndex()).accounts[0].id,account.id);
});

test('仅有每周分组桶时，模型独立额度及重置时间不推断为 5 小时窗口', async t => {
  const dir=await fixture(t), manager=new AccountsManager(dir);
  for(const hours of [2,24,7*24]) {
    const quota=manager.fuseQuota({models:{'gemini-test':{quotaInfo:{remainingFraction:.91,resetTime:new Date(Date.now()+hours*3600000).toISOString()}}}},{groups:[{displayName:'Gemini Models',buckets:[{window:'weekly',remainingFraction:.33,resetTime:new Date(Date.now()+7*86400000).toISOString()}]}]});
    const view=manager.getAccountQuotaOverview({quota});
    assert.equal(view.familyWindows.gemini.fiveHour,null);
    assert.equal(view.geminiFiveHourRemaining,null);
    assert.equal(view.geminiWeeklyRemaining,33);
    assert.equal(view.models.find(model=>model.name==='gemini-test').own_percentage,91);
    assert.equal(view.familyModelQuota.gemini.remaining,0.91);
  }
});

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

test('幂等性保留所有业务id，传输requestId可变，异目标必须冲突', () => {
  assert.deepEqual(canonicalPayload({requestId:'one',idempotencyKey:'k',id:'a',data:{id:'nested'}}),canonicalPayload({requestId:'two',idempotencyKey:'k',id:'a',data:{id:'nested'}}));
  assert.notDeepEqual(canonicalPayload({id:'a'}),canonicalPayload({id:'b'}));
  assert.notDeepEqual(canonicalPayload({data:{id:'a'}}),canonicalPayload({data:{id:'b'}}));
  const store=new IdempotencyStore();assert.equal(store.reserve('k','account-a',()=>{}),'owner');assert.equal(store.reserve('k','account-b',()=>{}),'conflict');
});
