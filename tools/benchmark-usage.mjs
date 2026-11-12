import {mkdtemp,rm,writeFile,stat} from 'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{performance,monitorEventLoopDelay}from'node:perf_hooks';
import{UsageLedger}from'../dist/usage-ledger.js';import{UsageStatsManager}from'../dist/usage.js';
const counts=process.argv.slice(2).filter(x=>/^\d+$/.test(x)).map(Number);if(!counts.length)counts.push(10000,100000,1000000);
const results=[];
for(const count of counts){const directory=await mkdtemp(join(tmpdir(),'gb-ledger-benchmark-'));try{
 const ledger=new UsageLedger(directory),now=Math.floor(Date.now()/1000),batchSize=5000;
 const delay=monitorEventLoopDelay({resolution:10});delay.enable();const start=performance.now();
 for(let offset=0;offset<count;offset+=batchSize){const batch=Array.from({length:Math.min(batchSize,count-offset)},(_,j)=>{const index=offset+j;return{event_key:index.toString(16).padStart(64,'0'),source_id:'benchmark',generation_index:index,model:'benchmark-model',input_tokens:1,output_tokens:2,cached_tokens:3,total_tokens:6,timestamp_seconds:now-3,account_confidence:'unknown'};});await ledger.save(batch);}
 const seededMs=performance.now()-start;
 const manager=new UsageStatsManager({stateDir:directory,geminiDir:join(directory,'absent')});await manager.savePricingTable({'benchmark-model':{model:'benchmark-model',input:1,output:2,cached:.1}});
 const scanStart=performance.now(),report=await manager.getUsageSummary(true),summaryMs=performance.now()-scanStart;
 if(report.all_time.totals.request_count!==count||report.all_time.totals.total_tokens!==6*count)throw Error('Benchmark totals mismatch');
 const pageStart=performance.now(),page=await manager.getUsageEvents('all','',0,500,report.snapshot_id),pageMs=performance.now()-pageStart;if(page.total!==count||page.rows.length!==Math.min(500,count))throw Error('Benchmark pagination mismatch');
 const sizeBefore=(await stat(ledger.path)).size;const updateStart=performance.now();await ledger.save([{event_key:'f'.repeat(64),source_id:'benchmark',generation_index:count,model:'benchmark-model',input_tokens:1,output_tokens:2,cached_tokens:3,total_tokens:6,timestamp_seconds:now-2}]);const updateMs=performance.now()-updateStart;
 const oldPage=await manager.getUsageEvents('all','',0,500,report.snapshot_id);if(oldPage.total!==count)throw Error('Pinned revision changed after append');
 delay.disable();results.push({count,seededMs,summaryMs,pageMs,oneEventUpdateMs:updateMs,mainRssMb:process.memoryUsage().rss/1048576,mainHeapMb:process.memoryUsage().heapUsed/1048576,eventLoopMaxMs:delay.max/1e6,indexBytesBeforeUpdate:sizeBefore,indexBytesAfterUpdate:(await stat(ledger.path)).size,correct:true});console.log(JSON.stringify(results.at(-1)));
 }finally{await rm(directory,{recursive:true,force:true});}}
const outputIndex=process.argv.indexOf('--out');if(outputIndex>=0)await writeFile(process.argv[outputIndex+1],JSON.stringify(results,null,2));
