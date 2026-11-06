import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import{promisify}from'node:util';
import{mkdtemp,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';
const run=promisify(execFile);
test('原生语言偏好对独立测试域可精确恢复，不触及 Antigravity 配置', {timeout: process.env.CI ? 180000 : 60000}, async()=>{
 const temp=await mkdtemp(join(tmpdir(),'gravity-native-test-'));try{const binary=join(temp,'test');await run('/usr/bin/swiftc',['-parse-as-library','-target','arm64-apple-macosx14.0','-framework','Cocoa','native/MenuLanguage.swift','test/native-language.swift','-o',binary]);const result=await run(binary,[]);assert.match(result.stdout,/通过/);}finally{await rm(temp,{recursive:true,force:true});}
});
