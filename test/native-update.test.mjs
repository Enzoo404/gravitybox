import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
test('原生更新：严格哈希、原子替换、启动失败回退、断点恢复和用户数据保留',{timeout:90000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'gb-native-update-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const binary=join(root,'probe');
  await run('/usr/bin/swiftc',['-parse-as-library','-target','arm64-apple-macosx14.0','-framework','Cocoa','-framework','CryptoKit','native/UpdateInstaller.swift','test/native-update.swift','-o',binary],{maxBuffer:2e6});
  const result=await run(binary,[join(root,'fixtures')],{maxBuffer:2e6});
  assert.match(result.stdout,/atomic swap, rollback, interrupted recovery, health acknowledgement and data preservation passed/);
});
