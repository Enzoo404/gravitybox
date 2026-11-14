import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {verifyBundleSource} from '../tools/coverage-report.mjs';import {extractUiStringsAst} from '../tools/extract-ui-ast.mjs';
import {buildPricingFeed} from '../tools/sync-pricing-feed.mjs';import {CdpHudBridge} from '../dist/hud/hud-bridge.js';
test('F16: trusted snapshot detects deletion, relabeling, counts, duplicates and covered-text substitution',async()=>{
 const original=JSON.parse(await readFile(new URL('../ui-strings/2.24.0.json',import.meta.url)));
 const good=await verifyBundleSource(original,{noVendor:true});assert.equal(good.verified,true);assert.equal(good.byteVerified,false);assert.equal(good.actualSha256,undefined);
 for(const mutate of [v=>v.strings.pop(),v=>v.strings[0].kinds=['template'],v=>v.strings[0].count++,v=>v.strings.push(v.strings[0]),v=>v.strings[0].text='Cancel']){
  const altered=structuredClone(original);mutate(altered);assert.equal((await verifyBundleSource(altered,{noVendor:true})).verified,false);
 }
});
test('F16: AST extractor recognizes actual UI syntax, excludes comments and leaves user execution untouched',()=>{
 const source='// label:"A fake comment"\nconst x={label:"Save changes",description:`Delete ${count} items`};React.createElement("button",{},"Open panel");React.createElement();';
 const rows=extractUiStringsAst(source);assert.ok(rows.some(r=>r.text==='Save changes'));assert.ok(rows.some(r=>r.text==='Open panel'));assert.ok(rows.some(r=>r.kinds.includes('template')));assert.ok(!rows.some(r=>r.text.includes('fake comment')));
});
test('F06: the public feed is generated from the shipped catalog and identical validity intervals',async()=>{
 const catalog=JSON.parse(await readFile(new URL('../assets/model-catalog.json',import.meta.url)));const feed=JSON.parse(await readFile(new URL('../assets/pricing-feed.json',import.meta.url)));assert.deepEqual(buildPricingFeed(catalog),feed);
});
test('F11: old attach and detach events cannot replace or remove a newer physical slot',async()=>{
 const bridge=new CdpHudBridge({pollIntervalMs:0,engine:{getConversationMetrics:async options=>({...options}),clearCache(){}}});
 const event=(conversationId,sessionRevision,type='SESSION_ATTACHED')=>bridge.handleRawBindingPayload('target',JSON.stringify({type,conversationId,sessionRevision,paneSlotId:'slot'}));
 event('new',10);event('old',9);assert.equal(bridge.getActivePanes()[0].conversationId,'new');event('old',9,'SESSION_DETACHED');assert.equal(bridge.getActivePanes().length,1);event('new',10,'SESSION_DETACHED');assert.equal(bridge.getActivePanes().length,0);bridge.dispose();
});
test('P0-Batch1: 单账号下钻时请求明细保持严格时间倒序且 HUD 增量追加与上下文压缩结果精确一致',async t=>{
 const {mkdtemp,mkdir,rm,utimes}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {DatabaseSync}=await import('node:sqlite');
 const {UsageStatsManager}=await import('../dist/usage.js');
 const {ProtobufWriter:W}=await import('../dist/protobuf.js');
 const {ConversationMetricsEngine}=await import('../dist/hud.js');
 const dir=await mkdtemp(join(tmpdir(),'gb-p0-batch1-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));

 // 1) 验证按具体账号筛选 getUsageSummary 后，getUsageEvents 依然严格按时间戳倒序返回
 const convDir=join(dir,'antigravity','conversations');
 await mkdir(convDir,{recursive:true});
 const nowSec=Math.floor(Date.now()/1000);
 const makeUsageGen=(model,input,tsSec)=>W.encodeLengthDelimited(1,Buffer.concat([
  W.encodeString(19,model),
  W.encodeLengthDelimited(4,Buffer.concat([W.encodeVarintField(2,input),W.encodeVarintField(3,10)])),
  W.encodeLengthDelimited(9,W.encodeLengthDelimited(4,W.encodeVarintField(1,tsSec))),
 ]));
 const dbOlder=join(convDir,'older.db'),dbNewer=join(convDir,'newer.db');
 for(const [p,ts,inp] of [[dbOlder,nowSec-300,100],[dbNewer,nowSec-60,200]]){
  const db=new DatabaseSync(p);
  db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);');
  db.prepare('INSERT INTO gen_metadata VALUES(0,?)').run(makeUsageGen('gemini-3.8-flash',inp,ts));
  db.close();
 }
 // 故意让较旧事件的数据库拥有更新的文件 mtime，模拟扫描发现顺序与真实事件时间相反
 const futureDate=new Date(Date.now()+5000);
 await utimes(dbOlder,futureDate,futureDate);

 const usageMgr=new UsageStatsManager({geminiDir:dir,stateDir:dir});
 usageMgr.setKnownAccounts([{id:'acc-1',email:'one@example.com',name:'One'}]);
 // 将观察起点设为事件之前，使两条事件均归属到 acc-1
 usageMgr.setCurrentAccountContext({id:'acc-1',email:'one@example.com'});
 (usageMgr).accountContextObservedAtSec=nowSec-600;

 const filteredSummary=await usageMgr.getUsageSummary(true,'acc-1');
 const page=await usageMgr.getUsageEvents('today','',0,20,filteredSummary.snapshot_id,false,false,'acc-1');
 assert.equal(page.rows.length,2);
 assert.ok(page.rows[0].timestamp_seconds>page.rows[1].timestamp_seconds,'单账号筛选快照下的请求明细必须按时间戳倒序排列');

 // 2) 验证 HUD SQLite 增量前缀复用、gen_metadata 增量推进及压缩状态变更自动回退全扫
 const hudDbPath=join(convDir,'hud-inc.db');
 const hudDb=new DatabaseSync(hudDbPath);
 hudDb.exec('PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,metadata BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);');
 const stepBlob=(s,e,inp,out)=>Buffer.concat([
  W.encodeLengthDelimited(1,W.encodeVarintField(1,s)),
  W.encodeLengthDelimited(7,W.encodeVarintField(1,e)),
  W.encodeLengthDelimited(9,Buffer.concat([W.encodeVarintField(2,inp),W.encodeVarintField(3,out)])),
  W.encodeString(12,'exec-1'),
 ]);
 const genBlob=(stepIdx,inp,out,ttftSec,streamSec)=>Buffer.concat([
  W.encodeLengthDelimited(1,Buffer.concat([
   W.encodeLengthDelimited(4,Buffer.concat([W.encodeVarintField(2,inp),W.encodeVarintField(3,out)])),
   W.encodeLengthDelimited(11,W.encodeVarintField(1,ttftSec)),
   W.encodeLengthDelimited(12,W.encodeVarintField(1,streamSec)),
   W.encodeString(19,'gemini-3.8-flash'),
  ])),
  W.encodeVarintField(2,stepIdx),
  W.encodeString(4,'exec-1'),
 ]);
 for(let i=0;i<6;i++){
  hudDb.prepare('INSERT INTO steps VALUES(?,15,3,?)').run(i,stepBlob(100+i*10,105+i*10,100,50));
  hudDb.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(i,genBlob(i,100,50,1,3));
 }
 const hudEngine=new ConversationMetricsEngine({conversationsDir:convDir});
 const mInitial=await hudEngine.getConversationMetrics({conversationId:'hud-inc'});
 assert.equal(mInitial.tokens.totalTokens,6*150);
 assert.equal(mInitial.session.modelDurationSeconds,6*4);

 // 追加第 6、7 步（命中增量前缀复用路径）
 for(let i=6;i<8;i++){
  hudDb.prepare('INSERT INTO steps VALUES(?,15,3,?)').run(i,stepBlob(100+i*10,105+i*10,200,80));
  hudDb.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(i,genBlob(i,200,80,1,4));
 }
 const mAppended=await hudEngine.getConversationMetrics({conversationId:'hud-inc'});
 assert.equal(mAppended.tokens.totalTokens,6*150+2*280);
 assert.equal(mAppended.session.modelDurationSeconds,6*4+2*5);

 // 模拟前缀步骤发生上下文压缩归档 (status: 3 -> 5) 并插入 CHECKPOINT 步 (step_type=23)
 hudDb.prepare('UPDATE steps SET status=5 WHERE idx<4').run();
 hudDb.prepare('INSERT INTO steps VALUES(8,23,3,NULL)').run();
 const mCompacted=await hudEngine.getConversationMetrics({conversationId:'hud-inc'});
 assert.equal(mCompacted.session.compactionCount,1);
 assert.equal(mCompacted.tokens.totalTokens,6*150+2*280);
 hudDb.close();
});
test('P1-Batch2: 归档容量裁剪、只读 StateDb、四档套餐权重与基础词典完整性验证',async t=>{
 const {mkdtemp,rm,readdir}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {DatabaseSync}=await import('node:sqlite');
 const {AccountsManager}=await import('../dist/accounts.js');
 const {readAntigravityStateDb}=await import('../dist/account-probe.js');
 const {UsageLedger}=await import('../dist/usage-ledger.js');
 const {stripModelProviderPrefix}=await import('../dist/model-identity.js');
 const {formatTurnDurationCompact}=await import('../dist/metric-format.js');
 const dir=await mkdtemp(join(tmpdir(),'gb-p1-batch2-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));

 // 1) accounts-removed 最多保留最近 10 份快照
 const mgr=new AccountsManager(dir);
 for(let i=0;i<13;i++){
  const acc=await mgr.upsertAccount({email:`u${i}@example.invalid`,refreshToken:`rt-${i}`});
  await mgr.deleteAccount(acc.id);
 }
 const removedFiles=(await readdir(join(dir,'accounts-removed'))).filter(f=>f.endsWith('.json'));
 assert.ok(removedFiles.length<=10,`accounts-removed 应裁剪至 <=10 份，实际 ${removedFiles.length}`);

 // 2) 四档套餐等级权重：ULTRA > PRO > 待确认 > FREE（真实 PRO 严格优先于等级未确认账号）
 const makeQuota=(rem,tier)=>({...mgr.fuseQuota(
  {models:{'gemini-3.8-flash':{quotaInfo:{remainingFraction:rem}}}},
  {groups:[{displayName:'Gemini Models',buckets:[{window:'5h',remainingFraction:rem}]}]}
 ),subscription_tier:tier});
 const accPro=await mgr.upsertAccount({email:'pro@example.invalid',refreshToken:'rt-pro',accessToken:'at-pro',expiresIn:3600});
 const accUnknown=await mgr.upsertAccount({email:'unk@example.invalid',refreshToken:'rt-unk',accessToken:'at-unk',expiresIn:3600});
 const accCur=await mgr.upsertAccount({email:'cur@example.invalid',refreshToken:'rt-cur',accessToken:'at-cur',expiresIn:3600});
 accPro.quota=makeQuota(0.8,'PRO');
 accUnknown.quota=makeQuota(0.95,'');
 accCur.quota=makeQuota(0.05,'PRO');
 await mgr.saveAccount(accPro);await mgr.saveAccount(accUnknown);await mgr.saveAccount(accCur);
 const rec=await mgr.selectBestAccount(
  {enabled:true,strategy:'priority',reserve_percentage:20,candidate_min_percentage:30,monitored_model:'gemini',candidate_account_ids:[accUnknown.id,accPro.id]},
  {currentId:accCur.id,currentEmail:accCur.email,currentQuota:accCur.quota}
 );
 assert.equal(rec.bestCandidate?.id,accPro.id,'真实 PRO 账号优先级必须高于等级未确认账号');

 // 3) ledger-reviews 未应用的预览自动裁剪上限 (<=5)，且池化 UsageLedger Worker 连续请求稳定
 const ledger=new UsageLedger(dir);
 const nowTs=Math.floor(Date.now()/1000);
 await ledger.save([
  {event_key:'ev-1',source_id:'s1',model:'gemini-3.8-flash',input_tokens:100,output_tokens:50,cached_tokens:0,total_tokens:150,timestamp_seconds:nowTs},
  {event_key:'ev-placeholder',source_id:'s2',model:'MODEL_PLACEHOLDER_M669',input_tokens:1000000,output_tokens:0,cached_tokens:0,total_tokens:1000000,timestamp_seconds:nowTs},
 ]);
 let placeholderPreview;
 for(let i=0;i<7;i++){
  placeholderPreview=await ledger.revalue({action:'preview',prices:{'gemini-3.8-flash':{input:0.5,output:1.5,cached:0.05}},accounts:[]});
 }
 assert.equal(placeholderPreview.unverifiableCount,0,'MODEL_PLACEHOLDER_M669 应在 revalueLedger 中归一化至 gemini-3.8-flash');
 assert.ok(placeholderPreview.after>=0.5,'占位符事件重估金额应命中定价');
 const reviewReceipts=(await readdir(join(dir,'ledger-reviews'))).filter(f=>/^[0-9a-f-]{36}\.json$/i.test(f));
 assert.ok(reviewReceipts.length<=5,`ledger-reviews 未应用预览应裁剪至 <=5 份，实际 ${reviewReceipts.length}`);

 // 4) Worker 隔离只读 readAntigravityStateDb 与公共格式化工具核验
 const vscdbPath=join(dir,'state.vscdb');
 const vdb=new DatabaseSync(vscdbPath);
 vdb.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT);');
 vdb.prepare('INSERT INTO ItemTable VALUES(?,?)').run('antigravityAuthStatus','{"email":"test@example.com"}');
 vdb.close();
 const stateMap=await readAntigravityStateDb(vscdbPath,['antigravityAuthStatus']);
 assert.equal(stateMap.get('antigravityAuthStatus'),'{"email":"test@example.com"}');
 assert.equal(stripModelProviderPrefix('publishers/google/models/gemini-4-carbon:generateContent'),'gemini-4-carbon');
 assert.equal(formatTurnDurationCompact(125,'zh'),'本轮 2m');

 // 5) 基础词典修复核验
 const baseDict=JSON.parse(await readFile(new URL('../dict/base.json',import.meta.url),'utf8'));
 assert.equal(baseDict['Browser Subagent'],'浏览器子智能体');
 assert.equal(baseDict['The browser subagent can be invoked by typing /browser'],'您可以通过在对话框中输入 /browser 来调用浏览器子智能体');
});
test('P2-Batch3: Protobuf 超长损毁 varint 安全保护、JSX 运行时 AST 提取与全版本零 caseOnly 校验',async()=>{
 const {ProtobufReader}=await import('../dist/protobuf.js');
 const {generateDeviceProfile}=await import('../dist/accounts.js');
 const {reconcile}=await import('../tools/coverage-report.mjs');
 const {readdir}=await import('node:fs/promises');

 // 1) 超过 10 字节的恶意未终止 varint 返回 null 而不越界或精度溢出
 const malformedVarint=Buffer.alloc(14,0x81);
 assert.equal(ProtobufReader.readVarint(malformedVarint,0),null);
 // 标准 10 字节负一 (-1 int64: ff * 9 + 01) 安全解析为 -1
 const minusOne=Buffer.from([0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0x01]);
 assert.deepEqual(ProtobufReader.readVarint(minusOne,0),[-1,10]);

 // 2) 加密随机数生成的设备指纹格式严格为 64 位小写 hex
 const devProfile=generateDeviceProfile();
 assert.match(devProfile.machine_id,/^[0-9a-f]{64}$/);
 assert.match(devProfile.mac_machine_id,/^[0-9a-f]{64}$/);

 // 3) includeJsxRuntime 可提取 React 18/19 jsx/jsxs 自动运行时、三元分支与数组子节点，默认模式保持原快照稳定
 const jsxSample='(0,r.jsx)("button",{children:saving?"Saving changes":"Save changes"});(0,r.jsxs)("h2",{children:["Account settings"]});';
 assert.equal(extractUiStringsAst(jsxSample).length,0,'默认 v1 模式不改变历史冻结快照边界');
 const jsxExtracted=extractUiStringsAst(jsxSample,{includeJsxRuntime:true}).map(r=>r.text);
 assert.ok(jsxExtracted.includes('Saving changes'));
 assert.ok(jsxExtracted.includes('Save changes'));
 assert.ok(jsxExtracted.includes('Account settings'));

 // 4) 全部 12 个受支持版本的 ui-strings 精确大小写命中（caseOnly === 0）
 const baseDict=JSON.parse(await readFile(new URL('../dict/base.json',import.meta.url),'utf8'));
 const entryMap=new Map(Object.entries(baseDict).map(([k,v])=>[k,{value:v,source:'dict/base.json'}]));
 for(const file of (await readdir(new URL('../ui-strings/',import.meta.url))).filter(f=>f.endsWith('.json'))){
  const snap=JSON.parse(await readFile(new URL(`../ui-strings/${file}`,import.meta.url),'utf8'));
  const rep=reconcile(snap,entryMap);
  assert.equal(rep.caseOnly.length,0,`${file} 不应存在大小写不一致的兜底词条`);
  assert.equal(rep.missing.length,0,`${file} 不应存在漏译词条`);
 }
});
