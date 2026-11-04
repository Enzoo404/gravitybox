import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{DictionaryStore,dictionaryFromEntries}from'../dist/dictionary.js';import{Controller}from'../dist/controller.js';import{previewItemId,selectedPreviewItems,scopedKey}from'../dist/candidates.js';
const dictionary=dictionaryFromEntries({});const config={provider:'openai',baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic',model:'fixture'};
const controller=()=>new Controller({appPath:'/unused',profile:'/unused',dictionary,onStatus(){}});
test('预览子集严格限定为批次成员，区别同词的场景，拒绝空/重复/注入 ID',()=>{
 const entries=[{key:'Open',translationKey:scopedKey('Open','button','/settings')},{key:'Open',translationKey:scopedKey('Open','heading','/')}];const ids=entries.map(previewItemId);assert.notEqual(ids[0],ids[1]);assert.deepEqual(selectedPreviewItems(entries,[ids[1]]),[entries[1]]);
 for(const selection of [[],[ids[0],ids[0]],['injected'],null,'all'])assert.throws(()=>selectedPreviewItems(entries,selection));
});
test('来源计数跟随合并后优先级及版本切换，错误重载保留上一份有效数据',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gb-counts-'));const base=join(root,'base'),user=join(root,'user');await mkdir(base);await mkdir(user);const store=new DictionaryStore(base,user);
 try{await writeFile(join(base,'base.json'),JSON.stringify({Save:'保存',Open:'打开'}));await writeFile(join(base,'2.23.2.json'),JSON.stringify({New:'新增'}));await writeFile(join(user,'增量补全-2.23.1.json'),JSON.stringify({Open:'开启'}));await writeFile(join(user,'个人覆盖.json'),JSON.stringify({Save:'存储'}));await store.start();assert.deepEqual(store.layerCounts,{builtin:1,incremental:1,personal:1});await store.selectVersion('2.23.1');assert.deepEqual(store.layerCounts,{builtin:0,incremental:1,personal:1});const version=store.current.version;
  await writeFile(join(user,'个人覆盖.json'),'{broken');await store.reload();assert.equal(store.current.version,version);assert.deepEqual(store.layerCounts,{builtin:0,incremental:1,personal:1});assert.ok(store.lastError);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('巡检编辑仅允许明确 UI，保留场景，修改后失效旧实机验证且不虚构新验证',async()=>{
 const c=controller();c.coverage={schema:1,dictionaryVersion:dictionary.version,entries:[{key:'Inspect view',status:'missing',confidence:'ui',sources:['可见界面 /settings button'],observed:'untranslated'},{key:'File',status:'native',confidence:'ui',sources:['native']},{key:'Updated {time}',status:'dynamic',confidence:'ui',sources:['内置动态规则']},{key:'Ambiguous label',status:'missing',confidence:'ui',sources:['可见界面 /settings button','可见界面 /history heading']}],counts:{}};
 const edit=await c.prepareCoverageEdit('Inspect view');assert.equal(edit.key,scopedKey('Inspect view','button','/settings'));assert.equal(edit.context,'设置 · 按钮');
 for(const key of ['File','Updated {time}','Ambiguous label','Unknown text'])await assert.rejects(c.prepareCoverageEdit(key));
 c.options.dictionary=dictionaryFromEntries({[edit.key]:'检查视图'});const report=await c.coverageReport();assert.equal(report.entries[0].translation,'检查视图');assert.equal(report.entries[0].status,'translated');assert.equal(report.entries[0].observed,undefined);assert.equal(report.counts.verified,undefined);
});
