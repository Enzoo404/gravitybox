import test from 'node:test';
import assert from 'node:assert/strict';
import {UsageStatsManager} from '../dist/usage.js';

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
