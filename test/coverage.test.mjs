import test from 'node:test';
import assert from 'node:assert/strict';
import { dictionaryFromEntries } from '../dist/dictionary.js';
import { asarSources, staticReferences, createCoverage, recordCoverageVisit, classifyCoverage } from '../dist/coverage.js';
test('扫描区分静态覆盖、原样译文、动态模板、原生界面；不把资源覆盖等同实机完成',()=>{
 const report=createCoverage([{id:'/main.js',scope:'renderer',source:'const x={label:"Open a review",title:"Keep unchanged",description:`Resets in ${time}`}; const a="A standalone notice";'},{id:'app.asar/dist/menu.js',scope:'native',source:'const m={label:"Open a review"}'}],dictionaryFromEntries({'Open a review':'打开审查','Keep unchanged':'Keep unchanged'}),'2.23.1','sha');
 assert.equal(report.entries.find(e=>e.key==='Open a review'&&e.status!=='native').status,'translated');assert.equal(report.entries.find(e=>e.key==='Keep unchanged').status,'unchanged');assert.equal(report.counts.verified,undefined);assert.ok(report.entries.some(e=>e.status==='native'));assert.ok(report.entries.some(e=>e.confidence==='literal'));assert.equal(classifyCoverage('Gemini', 'Gemini'),'preserved');assert.equal(classifyCoverage('teamwork-preview','teamwork-preview'),'unchanged');
 recordCoverageVisit(report,'/c/private-conversation-id',{observations:[{key:'Open a review',state:'verified'},{key:'Secret user input',state:'untranslated'}],unmatchedCount:1,protectedCount:2});
 assert.equal(report.counts.verified,1);assert.equal(report.entries.find(e=>e.status==='native').observed,undefined);assert.equal(report.visits[0].route,'/other');assert.equal(JSON.stringify(report).includes('Secret user input'),false);assert.equal(JSON.stringify(report).includes('private-conversation-id'),false);
});
test('只跟踪静态本机资源引用，排除外部地址、API、查询和父路径',()=>{
 assert.deepEqual(staticReferences('<script src="/main.js"></script><script src="https://remote.invalid/a.js"></script><a href="/api/account"></a><script src="/a.js?token=secret"></script>import("./chunk.js");import("../outside.js")'),['/main.js','./chunk.js']);
});
test('资源中的低置信度候选须经实际界面观察才能晋升为待译，不把品牌计为漏译',()=>{
 const report=createCoverage([{id:'/main.js',scope:'renderer',source:'const x="An observed interface notice";const y={label:"Google Chrome"};'}],dictionaryFromEntries({'Google Chrome':'Google Chrome'}),'2.23.1','sha');
 assert.equal(report.entries.find(e=>e.key==='An observed interface notice').status,'review');recordCoverageVisit(report,'/settings',{observations:[{key:'An observed interface notice',state:'untranslated'},{key:'Google Chrome',state:'untranslated'}]});
 const entry=report.entries.find(e=>e.key==='An observed interface notice');assert.equal(entry.status,'missing');assert.equal(entry.confidence,'ui');assert.equal(report.counts.untranslated,1);
});
test('读取 ASAR 仅扫描自有生产界面文件，并拒绝越界位置',()=>{
 const body=Buffer.from('const x={label:"Open a review"}');const header=Buffer.from(JSON.stringify({files:{dist:{files:{'menu.js':{size:body.length,offset:'0'},'menu.test.js':{size:body.length,offset:'0'}}},node_modules:{files:{'third.js':{size:body.length,offset:'0'}}}}}));const prefix=Buffer.alloc(16);prefix.writeUInt32LE(header.length+8,4);prefix.writeUInt32LE(header.length,12);const archive=Buffer.concat([prefix,header,body]);
 assert.equal(asarSources(archive).length,1);const broken=Buffer.from(archive);broken.writeUInt32LE(9000000,12);assert.throws(()=>asarSources(broken),/无效/);
});
