import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=promisify(execFile);
test('原生额度展示契约：权限、未知、陈旧、周期及菜单一致', {timeout:60000}, async t=>{
  const temporary=await mkdtemp(join(tmpdir(),'gb-native-quota-'));t.after(()=>rm(temporary,{recursive:true,force:true}));
  const binary=join(temporary,'quota');
  await run('/usr/bin/swiftc',['-parse-as-library','-target','arm64-apple-macosx14.0','-framework','Cocoa','native/Presentation.swift','native/QuotaPresentation.swift','test/native-quota.swift','-o',binary]);
  const result=await run(binary);assert.match(result.stdout,/30 native quota assertions passed/);
});
