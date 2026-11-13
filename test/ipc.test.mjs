import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { const deadline = Date.now() + 12000; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(30); } throw new Error('测试等待超时'); }
function rpc(directory, payload) { return new Promise((resolve, reject) => { const socket = createConnection(join(directory, 'control.sock')); let value = ''; socket.setTimeout(8000, () => { socket.destroy(); reject(new Error('IPC 超时')); }); socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n')); socket.on('error', reject); socket.on('data', chunk => { value += chunk; if (value.includes('\n')) { socket.end(); resolve(JSON.parse(value.split('\n')[0])); } }); }); }

test('真实后台加载个人覆盖并拒绝已撤下的在线补译和编辑入口',async()=>{
 const directory=await mkdtemp('/tmp/gb-ipc-current-');await mkdir(join(directory,'词典'));
 await writeFile(join(directory,'词典/个人覆盖.json'),JSON.stringify({'Synthetic preserved control':'个人覆盖'}));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/main.js',import.meta.url)),'--state-dir',directory,'--app','/nonexistent','--profile',join(directory,'no-profile'),'--home-dir',directory,'--app-support-dir',directory,'--gemini-dir',join(directory,'gemini')],{stdio:['ignore','ignore','pipe'],env:{...process.env,GRAVITYBOX_PROBE_LS:'false'}});
 const closed=new Promise(resolve=>child.once('close',resolve));let errors='';child.stderr.on('data',b=>errors+=b);
 try {
  await until(async()=>{try{return(await rpc(directory,{command:'status'})).ok}catch{return false}});
  const summary=await rpc(directory,{command:'dashboard_summary'});assert.equal(summary.ok,true);assert.equal(summary.dictionary.personal,1);
  for(const command of ['dictionary_set','task_start','preview_translation','dictionary_list','shortcut_set'])assert.equal((await rpc(directory,{command})).ok,false,command+' must stay unavailable');
  assert.equal(JSON.parse(await readFile(join(directory,'词典/个人覆盖.json'),'utf8'))['Synthetic preserved control'],'个人覆盖');
  assert.equal(errors,'');await rpc(directory,{command:'stop'});await until(()=>child.exitCode===0);
 }finally{if(child.exitCode===null)child.kill();await closed;await rm(directory,{recursive:true,force:true})}
});
