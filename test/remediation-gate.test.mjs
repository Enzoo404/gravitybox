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
