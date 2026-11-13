import test from "node:test";
import { describe as describeContractGroup } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleCache } from "../dist/bundle-cache.js";
import { Controller } from "../dist/controller.js";
import { dictionaryFromEntries } from "../dist/dictionary.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("连接与控制 · evolution", { concurrency: false }, async () => {
test('连接缓存不保留源字符串，同实例复用；文件、进程、版本或来源变化重新计算',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gravity-cache-'));try{
    await mkdir(join(dir,'Contents/Resources'),{recursive:true});await writeFile(join(dir,'Contents/Resources/app.asar'),'first');
    let reads=0;const fetcher=async()=>{await new Promise(r=>setTimeout(r,10));return {hash:`hash-${++reads}`,source:'example',bytes:7};};const cache=new BundleCache();
    const first=await Promise.all([cache.read(dir,1,'2.23.1','http://127.0.0.1:1',fetcher),cache.read(dir,1,'2.23.1','http://127.0.0.1:1',fetcher)]);assert.equal(first.filter(r=>!r.cacheHit).length,1);assert.equal(reads,1);
    const hit=await cache.read(dir,1,'2.23.1','http://127.0.0.1:1',fetcher);assert.equal(hit.source,undefined);assert.equal(reads,1);
    await cache.read(dir,2,'2.23.1','http://127.0.0.1:1',fetcher);assert.equal(reads,2);
    await cache.read(dir,2,'2.24.0','http://127.0.0.1:1',fetcher);assert.equal(reads,3);
    await cache.read(dir,2,'2.24.0','http://127.0.0.1:2',fetcher);assert.equal(reads,4);
    await writeFile(join(dir,'Contents/Resources/app.asar'),'changed size');await cache.read(dir,2,'2.24.0','http://127.0.0.1:2',fetcher);assert.equal(reads,5);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('未知指纹仅使用保守页面策略，受验证版本保留完整规则',()=>{
  const c=new Controller({appPath:'/Applications/Antigravity.app',profile:'/tmp/unused',dictionary:dictionaryFromEntries({Settings:'设置'}),onStatus:()=>{}});
  c.status.appVersion='2.23.2';c.status.bundleSha256='new';assert.equal(JSON.parse(c.boot('http://127.0.0.1:1234/').split('\n')[0].split('=')[1].slice(0,-1)).conservative,true);
  c.status.appVersion='2.23.1';c.status.bundleSha256='ad12ecf66061edab6a3835d1360e1bad50787bc7b2f2c9d86568281360864696';assert.match(c.boot('http://127.0.0.1:1234/'),/"conservative":false/);
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("连接与控制 · optimization-20261022", { concurrency: false }, async () => {
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const fixture=async fn=>{const dir=await mkdtemp(join(tmpdir(),'gb-opt-'));try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}};

async function stop(child){if(!child||child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([once(child,'exit'),pause(3000)]);if(child.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}}
const rpc=(dir,p)=>new Promise((resolve,reject)=>{const s=createConnection(join(dir,'control.sock'));let b='';s.on('error',reject);s.on('connect',()=>s.write(JSON.stringify(p)+'\n'));s.setTimeout(10000,()=>{s.destroy();reject(new Error('timeout'));});s.on('data',c=>{b+=c;if(b.includes('\n')){s.end();resolve(JSON.parse(b.split('\n')[0]));}});});
async function ready(dir){for(let i=0;i<300;i++){try{await access(join(dir,'control.sock'));await new Promise((res,rej)=>{const s=createConnection(join(dir,'control.sock'));s.once('connect',()=>{s.destroy();res();});s.once('error',rej);});return;}catch{}await pause(20);}throw Error('backend not ready');}

test('已暂停的汉化在重新启动时保持暂停，不为更新自动注入目标应用',()=>fixture(async dir=>{
 await writeFile(join(dir,'runtime-preferences.json'),JSON.stringify({translationEnabled:false,hudEnabled:false}));
 const child=spawn(process.execPath,['dist/main.js','--state-dir',dir,'--app','/nonexistent','--profile',dir,'--home-dir',dir,'--app-support-dir',dir,'--gemini-dir',dir],{stdio:'ignore',env:{...process.env,GRAVITYBOX_PROBE_LS:'false'}});
 try{await ready(dir);let status;for(let i=0;i<100;i++){status=await rpc(dir,{command:'status',includeTasks:false});if(status.status.mode==='paused')break;await pause(20);}assert.equal(status.status.mode,'paused');assert.equal(status.status.windows,0);assert.equal(JSON.parse(await readFile(join(dir,'runtime-preferences.json'),'utf8')).translationEnabled,false);}finally{await stop(child);}
}));
});
