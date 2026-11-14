import test from "node:test";
import { describe as describeContractGroup } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { acquireProcessLease, withProcessLease } from "../dist/process-lock.js";
import { atomicJson } from "../dist/files.js";

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("锁与原子写入 · optimization-20261022", { concurrency: false }, async () => {
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const fixture=async fn=>{const dir=await mkdtemp(join(tmpdir(),'gb-opt-'));try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}};

test('跨进程写锁串行化、拒绝活锁、同上下文可重入且完成后释放',()=>fixture(async dir=>{
 const path=join(dir,'lock'); const lease=await acquireProcessLease(path,0);
 await assert.rejects(acquireProcessLease(path,30),/已有|等待|锁|占用/);await lease.release();
 let order=[];
 await Promise.all([withProcessLease(path,async()=>{order.push('a');await withProcessLease(path,async()=>order.push('nested'));await pause(50);order.push('b');}),withProcessLease(path,async()=>order.push('c'))]);
 assert.equal(order.indexOf('nested'),order.indexOf('a')+1);assert.equal(order.indexOf('b'),order.indexOf('a')+2);assert.ok(order.indexOf('c')<order.indexOf('a')||order.indexOf('c')>order.indexOf('b'),'锁保证互斥，不承诺两个调用的抢占顺序');await assert.rejects(access(path));
 const script=`import{withProcessLease}from ${JSON.stringify(pathToFileURL(join(process.cwd(),'dist/process-lock.js')).href)};await withProcessLease(process.argv[1],async()=>{await new Promise(r=>setTimeout(r,180));});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,path],{stdio:'ignore'});
 for(let i=0;i<100;i++){try{await access(path);break;}catch{}await pause(10);}
 await assert.rejects(acquireProcessLease(path,20));await once(child,'exit');assert.equal(child.exitCode,0);const final=await acquireProcessLease(path,0);await final.release();
}));
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("锁与原子写入 · refactor", { concurrency: false }, async () => {

async function state() { const directory = await mkdtemp('/tmp/gb-test-'); await mkdir(join(directory, '词典')); return directory; }
test('原子写入在提交前取消时保留原文件', async () => {
  const directory = await state(); try { const path = join(directory, 'personal.json'); await atomicJson(path, { Save: '原译文' }); const abort = new AbortController(); abort.abort(); await assert.rejects(atomicJson(path, { Save: '新译文' }, abort.signal)); assert.deepEqual(JSON.parse(await readFile(path)), { Save: '原译文' }); } finally { await rm(directory, { recursive: true, force: true }); }
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("锁与原子写入 · repair-20261023", { concurrency: false }, async () => {
async function fixture(t){const d=await mkdtemp(join(tmpdir(),'gb-repair-'));t.after(async()=>{try{await rm(d,{recursive:true,force:true,maxRetries:10,retryDelay:50});}catch{}});return d;}
test('旧空锁及死进程回收锁保留原件后恢复，活锁不被夺取',async t=>{const d=await fixture(t),path=join(d,'writer.lock');await writeFile(path,'');const old=new Date(Date.now()-60000);await utimes(path,old,old);const lease=await acquireProcessLease(path,3000);assert.ok((await readdir(d)).some(n=>n.includes('.orphan-')));await assert.rejects(acquireProcessLease(path,50),/已有/);await lease.release();});
});
