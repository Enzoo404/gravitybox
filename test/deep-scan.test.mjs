import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm}from'node:fs/promises';
import{tmpdir}from'node:os';import{join}from'node:path';
import{pluginDisplay,readPluginCatalog,appendPluginViews}from'../dist/plugin-catalog.js';
import{DEEP_STEPS,traverseDeep,sanitizeNativeMenus,deepMarkdown}from'../dist/deep-scan.js';
test('插件扫描仅读取展示字段，拒绝符号链接和凭据形状，不执行插件',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'gravitybox-plugin-test-'));try{
  const root=join(temp,'plugins');await mkdir(root);await mkdir(join(root,'safe'));await writeFile(join(root,'safe','plugin.json'),JSON.stringify({name:'safe-plugin',displayName:'Sample',description:'A useful plugin description',mcpServers:{apiKey:'private-key-must-not-appear'},scripts:{install:'must-not-run'}}));
  await mkdir(join(root,'linked'));await writeFile(join(temp,'outside.json'),JSON.stringify({name:'outside',description:'must-not-read'}));await symlink(join(temp,'outside.json'),join(root,'linked','plugin.json'));
  const catalog=await readPluginCatalog(root,new AbortController().signal);assert.equal(catalog.entries.length,1);assert.equal(catalog.inspectedFiles,1);assert.ok(catalog.skipped>0);assert.equal(JSON.stringify(catalog).includes('private-key'),false);assert.equal(catalog.entries[0].onlineEligible,false);assert.equal(pluginDisplay({name:'bad',description:'Bearer secret-value'},'bad'),undefined);
  appendPluginViews(catalog,[{id:'public',name:'Public',description:'Public description',source:'marketplace-view'},{id:'untrusted',name:'Untrusted',description:'not accepted',source:'arbitrary'}]);assert.equal(catalog.entries.length,2);
 }finally{await rm(temp,{recursive:true,force:true})}
});
test('深度遍历只执行登记步骤，取消或失败也尝试恢复并记录恢复状态',async()=>{
 let restored=false;const abort=new AbortController();let restoration;
 const page={async invoke(method){if(method==='begin')return{ok:true};if(method==='step')return{ok:true};if(method==='sample')return{audit:{observations:[]}};if(method==='scroll')return{more:false};if(method==='finish'){restored=true;return{routeRestored:true,editorsMatch:true}}throw new Error('unexpected')}};
 await assert.rejects(traverseDeep(page,abort.signal,async()=>{},(step,index)=>{assert.ok(DEEP_STEPS.some(s=>s.id===step.id));if(index===2)abort.abort()},value=>restoration=value));assert.equal(restored,true);assert.equal(restoration.routeRestored,true);
});
test('遍历开始前被草稿阻止时不操作页面，不把未恢复伪装为成功',async()=>{
 let calls=[];await assert.rejects(traverseDeep({async invoke(method){calls.push(method);return{ok:false,message:'draft present'}}},new AbortController().signal,async()=>{},()=>{}),/draft/);assert.deepEqual(calls,['begin']);
 const result=await traverseDeep({async invoke(method){if(method==='begin')return{ok:true};if(method==='step')return{ok:false,message:'missing'};if(method==='finish')throw new Error('lost')}},new AbortController().signal,async()=>{},()=>{});assert.equal(result.restoration.routeRestored,false);assert.ok(result.steps.some(s=>s.state==='manual'));
});
test('菜单报告只接纳已知标题，权限缺失不伪造结果，插件 Markdown 不加载外部图像',()=>{
 const menu=sanitizeNativeMenus({state:'read',labels:['File','Secret document title','File'],unmatched:1},new Set(['File']));assert.deepEqual(menu.labels,['File']);assert.deepEqual(sanitizeNativeMenus({state:'permission-required',labels:['File']},new Set(['File'])).labels,[]);
 const report={startedAt:'today',state:'partial',steps:[],plugins:{entries:[{name:'Sample',description:'![remote](https://example.invalid/x) <script>',source:'installed-manifest',truncated:false}],inspectedFiles:1},nativeMenus:menu,notes:[]};const md=deepMarkdown(report);assert.equal(md.includes('![remote]('),false);assert.equal(md.includes('<script>'),false);
});
