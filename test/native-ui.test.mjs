import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readdir,readFile,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
const timeout = process.env.CI ? 360000 : 120000;
test('当前四页原生布局、菜单完整身份、部分计价与真实切号控制流隔离检查',{timeout},async()=>{
 const temp=await mkdtemp(join(tmpdir(),'gb-native-ui-'));
 const binary=join(temp,'GravityBox-layout-preview');
 const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
 const output=join(root,'质检报告',`${version}-改造验收`,'原生布局');await mkdir(output,{recursive:true});
 try {
  const sources=(await readdir(join(root,'native'))).filter(f=>f.endsWith('.swift')).map(f=>join(root,'native',f));
  await run('/usr/bin/swiftc',['-O','-D','NATIVE_UI_TEST','-parse-as-library','-target','arm64-apple-macosx14.0','-framework','Cocoa','-framework','ServiceManagement','-framework','Security','-framework','ApplicationServices',...sources,join(root,'test/native-ui.swift'),'-o',binary],{maxBuffer:2e6});
  const result=await run(binary,[join(temp,'state'),output],{maxBuffer:2e6,env:{...process.env,GRAVITYBOX_UI_RESOURCES:join(root,'assets')}});
  await writeFile(join(output,'render.log'),result.stdout+result.stderr);
  const report=JSON.parse(await readFile(join(output,'native-ui-results.json')));
  assert.equal(report.stableOnlySelectionPassed,true);assert.equal(report.nativeLayouts,24);assert.equal(report.menuCaptures,4);assert.equal(report.safeSwitchSharedFlowPassed,true);assert.equal(report.emailWidthPassed,true);
  for(const name of report.captures){const data=await readFile(join(output,name));assert.equal(data.subarray(1,4).toString(),'PNG');assert.ok(data.length>10000);}
  for(const sheet of ['light-maintenance-sheet.png','dark-maintenance-sheet.png']){const data=await readFile(join(output,sheet));assert.equal(data.subarray(1,4).toString(),'PNG');assert.ok(data.length>10000);}
 }catch(error){await writeFile(join(output,'failure.log'),String(error.stdout??'')+String(error.stderr??'')+String(error));throw error;}
 finally {await rm(temp,{recursive:true,force:true});}
});
