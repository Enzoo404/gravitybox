import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,utimes,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {createConnection} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {acquireProcessLease,withProcessLease} from '../dist/process-lock.js';
import {UsageStatsManager,ProtobufWriter as W,matchPricingKeys,priceStatus,DEFAULT_API_PRICES} from '../dist/usage.js';
import {SqliteReadSnapshot} from '../dist/sqlite-read.js';
import {AccountSwitchService} from '../dist/account-switch.js';
import {AccountsManager,accountCredentialReadiness} from '../dist/accounts.js';
import '../dist/controller.js';
import '../dist/dictionary.js';
import {Tasks} from '../dist/tasks.js';
import {sourceDigest} from '../tools/release-integrity.mjs';
import {checkDocs} from '../tools/check-docs.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const fixture=async fn=>{const dir=await mkdtemp(join(tmpdir(),'gb-opt-'));try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}};
const blob=(tokens=100,padding=0)=>Buffer.concat([W.encodeLengthDelimited(1,Buffer.concat([W.encodeString(19,'gemini-2.5-flash'),W.encodeLengthDelimited(4,W.encodeVarintField(2,tokens))])), ...(padding?[W.encodeLengthDelimited(99,Buffer.alloc(padding))]:[])]);
async function stop(child){if(!child||child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([once(child,'exit'),pause(3000)]);if(child.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}}
const rpc=(dir,p)=>new Promise((resolve,reject)=>{const s=createConnection(join(dir,'control.sock'));let b='';s.on('error',reject);s.on('connect',()=>s.write(JSON.stringify(p)+'\n'));s.setTimeout(10000,()=>{s.destroy();reject(new Error('timeout'));});s.on('data',c=>{b+=c;if(b.includes('\n')){s.end();resolve(JSON.parse(b.split('\n')[0]));}});});
async function ready(dir){for(let i=0;i<300;i++){try{await access(join(dir,'control.sock'));await new Promise((res,rej)=>{const s=createConnection(join(dir,'control.sock'));s.once('connect',()=>{s.destroy();res();});s.once('error',rej);});return;}catch{}await pause(20);}throw Error('backend not ready');}

test('跨进程写锁串行化、拒绝活锁、同上下文可重入且完成后释放',()=>fixture(async dir=>{
 const path=join(dir,'lock'); const lease=await acquireProcessLease(path,0);
 await assert.rejects(acquireProcessLease(path,30),/已有|等待|锁|占用/);await lease.release();
 let order=[];
 await Promise.all([withProcessLease(path,async()=>{order.push('a');await withProcessLease(path,async()=>order.push('nested'));await pause(50);order.push('b');}),withProcessLease(path,async()=>order.push('c'))]);
 assert.equal(order.indexOf('nested'),order.indexOf('a')+1);assert.equal(order.indexOf('b'),order.indexOf('a')+2);assert.ok(order.indexOf('c')<order.indexOf('a')||order.indexOf('c')>order.indexOf('b'),'锁保证互斥，不承诺两个调用的抢占顺序');await assert.rejects(access(path));
 const script=`import{withProcessLease}from ${JSON.stringify(pathToFileURL(join(process.cwd(),'dist/process-lock.js')).href)};await withProcessLease(process.argv[1],async()=>{await new Promise(r=>setTimeout(r,180));});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,path],{stdio:'ignore'});
 for(let i=0;i<100;i++){try{await access(path);break;}catch{}await pause(10);}
 await assert.rejects(acquireProcessLease(path,20));await once(child,'exit');assert.equal(child.exitCode,0);const final=await acquireProcessLease(path,0);await final.release();
}));

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

test('活跃数据库按 WAL 变更排序，未知模型变体不套用价格，优惠价过期可识别',()=>fixture(async dir=>{
 const conv=join(dir,'antigravity','conversations');await mkdir(conv,{recursive:true});const older=join(conv,'old.db'),newer=join(conv,'new.db');await writeFile(older,'');await writeFile(newer,'');await utimes(older,1,1);await utimes(newer,2000,2000);await writeFile(older+'-wal','wal');const usage=new UsageStatsManager({stateDir:dir,geminiDir:dir});assert.equal((await usage.discoverDatabaseFiles(1))[0],older);
 for(const name of ['my-gpt-4o-unsupported','gemini-2.5-pro-expensive-custom','gemini-3.8-flash-lite','gemini-3.8-flash-exp']) assert.equal(matchPricingKeys(name),name);
 assert.equal(matchPricingKeys('gemini-2.5-flash-high'),'gemini-2.5-flash');assert.equal(priceStatus(DEFAULT_API_PRICES['gemini-3.8-flash'],Date.parse('2027-01-01')),'expired');
}));

test('任务快照竞争和重复后台启动均保持唯一、可见的终态', {timeout:20000},()=>fixture(async dir=>{
 const preload=join(dir,'preload.mjs');await writeFile(preload,`import{AccountsManager}from ${JSON.stringify(pathToFileURL(join(process.cwd(),'dist/accounts.js')).href)};AccountsManager.prototype.probeLiveLanguageServer=async()=>{await new Promise(r=>setTimeout(r,350));return null;};AccountsManager.prototype.listAccounts=async()=>({accounts:[],active_account:null,active_account_id:null,revision:'fixture'});AccountsManager.prototype.refreshAllQuotas=async()=>{await new Promise(r=>setTimeout(r,50));return{accounts:[],failures:[]}};`);
 const args=['--import',preload,'dist/main.js','--state-dir',dir,'--app','/nonexistent','--profile',join(dir,'profile'),'--home-dir',dir,'--app-support-dir',dir,'--gemini-dir',dir];const one=spawn(process.execPath,args,{stdio:'ignore',env:{...process.env,GRAVITYBOX_PROBE_LS:'false'}});let two;
 try{await ready(dir);const reading=rpc(dir,{command:'status',includeTasks:true,tasksSince:-1});await pause(30);const start=await rpc(dir,{command:'quota_refresh_start'});const first=await reading;assert.ok(first.tasks.find(t=>t.id===start.taskId&&t.state==='succeeded'));const next=await rpc(dir,{command:'status',includeTasks:true,tasksSince:first.taskRevision});assert.ok(!next.tasks||next.tasks.some(t=>t.id===start.taskId));
 two=spawn(process.execPath,args,{stdio:'ignore'});await once(two,'exit');assert.notEqual(two.exitCode,0);assert.equal((await rpc(dir,{command:'ping'})).pid,one.pid);assert.equal(one.exitCode,null);
 }finally{await stop(two);await stop(one);}
}));

test('高频进度合并写入、例行成功不挤满历史；重要失败保持可见',()=>fixture(async dir=>{
 const tasks=new Tasks(dir,()=>{});await tasks.start();
 tasks.begin('model-test','人工失败',async()=>{throw Error('synthetic failure');});await pause(0);await tasks.stop();assert.equal(tasks.list()[0].state,'failed');
 for(let i=0;i<55;i++){tasks.begin('quota-refresh','自动采样',async()=>({ok:true}));await pause(0);}
 let progress;tasks.begin('model-test','burst',async(_s,p)=>{progress=p;for(let i=0;i<500;i++)p(i,500);return{ok:true};});await pause(0);await tasks.stop();
 assert.ok(tasks.list().some(t=>t.title==='人工失败'));assert.equal(tasks.list().filter(t=>t.kind==='quota-refresh'&&t.state==='succeeded').length,20);
 const persisted=JSON.parse(await readFile(join(dir,'activity.json'),'utf8'));assert.deepEqual(persisted,JSON.parse(JSON.stringify(tasks.list())));
 const archive=(await readFile(join(dir,'activity-history.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(archive.length,35);assert.ok(archive.every(row=>row.task.kind==='quota-refresh'));
}));

test('文档检查重算源码摘要，旧stamp不能掩盖当前修改',()=>fixture(async dir=>{
 for(const name of ['src','runtime','native','tools','test','dict','ui-strings','assets','licenses','.cache'])await mkdir(join(dir,name));
 for(const name of ['package-lock.json','tsconfig.json','README.md','THIRD_PARTY_NOTICES.md'])await writeFile(join(dir,name),'fixture');await writeFile(join(dir,'package.json'),'{"version":"0.9.0"}');const digest=await sourceDigest(dir);await writeFile(join(dir,'.cache','verified-release.json'),JSON.stringify({digest}));await writeFile(join(dir,'src','change.ts'),'changed');const result=await checkDocs({root:dir,installedApp:join(dir,'missing'),accountsPath:join(dir,'missing.json')});assert.ok(result.issues.some(i=>i.code==='SOURCE_NOT_VERIFIED'));
}));


test('两个账号写者保留各自更新，陈旧显式保存被拒绝，策略局部更新串行提交',()=>fixture(async dir=>{
 const manager=new AccountsManager(dir);const account=await manager.upsertAccount({email:'synthetic@example.com',refreshToken:'synthetic-refresh',accessToken:'synthetic-access',expiresIn:3600});
 const stale=await manager.getAccount(account.id);
 const script=`import{AccountsManager}from ${JSON.stringify(pathToFileURL(join(process.cwd(),'dist/accounts.js')).href)};const m=new AccountsManager(process.argv[1]);await m.updateAccount(process.argv[2],async a=>{await new Promise(r=>setTimeout(r,100));if(process.argv[3]==='label')a.custom_label='retained label';else a.protected_models=['custom-model'];});await m.setAutoSwitchConfig(process.argv[3]==='label'?{enabled:true}:{monitored_model:'custom-model'});`;
 const children=['label','model'].map(kind=>spawn(process.execPath,['--input-type=module','-e',script,dir,account.id,kind],{stdio:'ignore'}));await Promise.all(children.map(c=>once(c,'exit')));assert.ok(children.every(c=>c.exitCode===0));const final=await manager.getAccount(account.id);assert.equal(final.custom_label,'retained label');assert.deepEqual(final.protected_models,['custom-model']);stale.custom_label='stale overwrite';await assert.rejects(manager.saveAccount(stale),/已在其他操作中更新/);const policy=await manager.getAutoSwitchConfig();assert.equal(policy.enabled,true);assert.equal(policy.monitored_model,'custom-model');
}));

test('有效额度在 all/家族/具体模型一致；禁用 Argon 不借其他变体通过，凭据状态独立',()=>fixture(async dir=>{
 const manager=new AccountsManager(dir),now=Math.floor(Date.now()/1000);const account=await manager.upsertAccount({email:'synthetic@example.com',refreshToken:'synthetic-refresh',accessToken:'synthetic-access',expiresIn:3600});
 account.quota={last_updated:now,models:[{name:'gemini-2.5-flash',percentage:83,percentage_known:true,observed_at:now}]};
 for(const target of ['all','gemini','gemini-2.5-flash'])assert.equal(manager.getAccountRemaining(account,target),83,target);
 account.quota=manager.fuseQuota({models:{'gemini-4-argon-high':{disabled:false,quotaInfo:{remainingFraction:0.8}},'gemini-4-argon-low':{disabled:true,quotaInfo:{remainingFraction:1}}}},{groups:[]});
 assert.equal(manager.getAccountRemaining(account,'gemini-4-argon-low'),null);assert.equal(accountCredentialReadiness(account).state,'ready');account.token.expiry_timestamp=now-1;assert.equal(accountCredentialReadiness(account).state,'needs_refresh');account.quota_refresh_error='invalid_grant';assert.equal(accountCredentialReadiness(account).state,'needs_authorization');
}));

test('用量取消中止在途读取，并发读共享同一轮，不返回假零',()=>fixture(async dir=>{
 const usage=new UsageStatsManager({stateDir:dir,geminiDir:dir});let calls=0;
 usage.discoverDatabaseFiles=async()=>[join(dir,'synthetic.db')];
 usage.scanDatabaseEvents=async(_p,_b,signal)=>{calls++;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return{events:[],generationsScanned:0,skippedLargeRecords:0,hasError:true,error:'读取已取消'};};
 const first=usage.getUsageSummary(),second=usage.getUsageSummary();await pause(0);assert.equal(usage.cancelRead(),true);const [a,b]=await Promise.all([first,second]);assert.equal(calls,1);assert.equal(a,b);assert.equal(a.availability,'unavailable');assert.match(a.database_diagnostics[0].category,/取消/);
}));


test('恢复材料有7天期限，待完成事务不可清理，完成记录经摘要确认后脱敏',()=>fixture(async dir=>{
 const manager=new AccountsManager(dir);await manager.init();const service=new AccountSwitchService(manager,{stateDir:dir,profile:dir,externalDir:dir,isRunning:async()=>false});
 const path=join(dir,'account-switch-journal-stable.json'), journal={version:1,status:'complete',at:new Date(Date.now()-10*86400000).toISOString(),before:{oauthToken:'synthetic-private-token'},after:{},files:[],keychainBefore:'synthetic-keychain',keychainAfter:''};await writeFile(path,JSON.stringify(journal));
 const info=await service.recoveryInfo();assert.equal(info.expired,true);assert.equal(info.pending,false);assert.equal(info.containsCredentials,true);assert.ok(!JSON.stringify(info).includes('synthetic-private-token'));await assert.rejects(service.rollback(),/超过 7 天/);await assert.rejects(service.clearRecovery('wrong'),/已变化/);assert.equal(JSON.parse(await readFile(path,'utf8')).before.oauthToken,'synthetic-private-token');
 await writeFile(path,JSON.stringify({...journal,status:'prepared'}));const pending=await service.recoveryInfo();assert.equal(pending.pending,true);assert.equal(pending.expired,false);await assert.rejects(service.clearRecovery(pending.digest),/不可清除/);
 await writeFile(path,JSON.stringify(journal));await service.clearRecovery((await service.recoveryInfo()).digest);const cleaned=await readFile(path,'utf8');assert.ok(!cleaned.includes('synthetic-private-token'));assert.ok(!cleaned.includes('synthetic-keychain'));assert.equal((await service.recoveryInfo()).available,false);
}));


test('已暂停的汉化在重新启动时保持暂停，不为更新自动注入目标应用',()=>fixture(async dir=>{
 await writeFile(join(dir,'runtime-preferences.json'),JSON.stringify({translationEnabled:false,hudEnabled:false}));
 const child=spawn(process.execPath,['dist/main.js','--state-dir',dir,'--app','/nonexistent','--profile',dir,'--home-dir',dir,'--app-support-dir',dir,'--gemini-dir',dir],{stdio:'ignore',env:{...process.env,GRAVITYBOX_PROBE_LS:'false'}});
 try{await ready(dir);let status;for(let i=0;i<100;i++){status=await rpc(dir,{command:'status',includeTasks:false});if(status.status.mode==='paused')break;await pause(20);}assert.equal(status.status.mode,'paused');assert.equal(status.status.windows,0);assert.equal(JSON.parse(await readFile(join(dir,'runtime-preferences.json'),'utf8')).translationEnabled,false);}finally{await stop(child);}
}));


test('分批读取释放事务并拒绝把数据库变化冒充一致快照',()=>fixture(async dir=>{
 const path=join(dir,'snapshot.db'),db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL; CREATE TABLE data(id INTEGER PRIMARY KEY,value INTEGER); INSERT INTO data VALUES(1,100);');
 const reader=new SqliteReadSnapshot(path);try{assert.equal((await reader.query('SELECT value FROM data WHERE id=1;')).rows[0].value,100);db.exec('UPDATE data SET value=200; INSERT INTO data VALUES(2,300);');const same=await reader.query('SELECT * FROM data ORDER BY id;');assert.deepEqual(same.rows,[{id:1,value:200},{id:2,value:300}]);assert.equal(await reader.verifyUnchanged(),false);const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();assert.equal(checkpoint.busy,0);}finally{await reader.close();}
 const next=new SqliteReadSnapshot(path);try{const result=await next.query('SELECT * FROM data ORDER BY id;');assert.equal(result.ok,true,result.error);assert.deepEqual(result.rows,[{id:1,value:200},{id:2,value:300}]);}finally{await next.close();db.close();}
}));
