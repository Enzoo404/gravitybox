import test from "node:test";
import { describe as describeContractGroup } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tasks } from "../dist/tasks.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { createConnection } from "node:net";

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("任务与取消 · audit-p1-status", { concurrency: false }, async () => {
// P1 状态契约（A03 / D05）的隔离回归测试：只使用临时 state 目录与本地 fetch 桩，
// 不触碰真实应用、用户数据或 socket 写命令。

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(20);
  }
  throw new Error('测试等待超时');
}

test('D05: task_cancel 对不存在/已结束/id 不匹配任务返回 false，正常取消路径不变', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'gb-p1-tasks-cancel-'));
  let tasks;
  try {
    tasks = new Tasks(stateDir, () => {});
    await tasks.start();

    // 不存在与已结束（无运行任务）都不能假成功。
    assert.equal(tasks.cancel('no-such-task'), false);
    assert.equal(tasks.cancel(), false);

    let aborted = false;
    const taskId = tasks.begin('test', '取消路径测试', signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('已取消任务')); }, { once: true });
    }));
    await until(() => tasks.list().some(task => task.id === taskId && task.state === 'running'));

    assert.equal(tasks.cancel('another-task-id'), false, 'id 不匹配必须返回 false');
    assert.equal(tasks.cancel(taskId), true, '正常取消路径必须返回 true');

    await until(() => tasks.list().find(task => task.id === taskId)?.state === 'cancelled');
    assert.equal(aborted, true);
    assert.equal(tasks.cancel(taskId), false, '已结束任务不能假成功');
  } finally {
    await tasks.stop().catch(() => {});
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("任务与取消 · optimization-20261022", { concurrency: false }, async () => {
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const fixture=async fn=>{const dir=await mkdtemp(join(tmpdir(),'gb-opt-'));try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}};

async function stop(child){if(!child||child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([once(child,'exit'),pause(3000)]);if(child.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}}
const rpc=(dir,p)=>new Promise((resolve,reject)=>{const s=createConnection(join(dir,'control.sock'));let b='';s.on('error',reject);s.on('connect',()=>s.write(JSON.stringify(p)+'\n'));s.setTimeout(10000,()=>{s.destroy();reject(new Error('timeout'));});s.on('data',c=>{b+=c;if(b.includes('\n')){s.end();resolve(JSON.parse(b.split('\n')[0]));}});});
async function ready(dir){for(let i=0;i<300;i++){try{await access(join(dir,'control.sock'));await new Promise((res,rej)=>{const s=createConnection(join(dir,'control.sock'));s.once('connect',()=>{s.destroy();res();});s.once('error',rej);});return;}catch{}await pause(20);}throw Error('backend not ready');}

test('任务快照竞争和重复后台启动均保持唯一、可见的终态', {timeout:20000},()=>fixture(async dir=>{
 const preload=join(dir,'preload.mjs');await writeFile(preload,`import{AccountsManager}from ${JSON.stringify(pathToFileURL(join(process.cwd(),'dist/accounts.js')).href)};AccountsManager.prototype.probeLiveLanguageServer=async()=>{await new Promise(r=>setTimeout(r,350));return null;};AccountsManager.prototype.listAccounts=async()=>({accounts:[],active_account:null,active_account_id:null,revision:'fixture'});AccountsManager.prototype.refreshAllQuotas=async()=>{await new Promise(r=>setTimeout(r,50));return{accounts:[],failures:[]}};`);
 const args=['--import',preload,'dist/main.js','--state-dir',dir,'--app','/nonexistent','--profile',join(dir,'profile'),'--home-dir',dir,'--app-support-dir',dir,'--gemini-dir',dir];const one=spawn(process.execPath,args,{stdio:'ignore',env:{...process.env,GRAVITYBOX_PROBE_LS:'false'}});let two;
 try{await ready(dir);const reading=rpc(dir,{command:'status',includeTasks:true,tasksSince:-1});await pause(30);const start=await rpc(dir,{command:'quota_refresh_start'});const first=await reading;assert.ok(first.tasks.find(t=>t.id===start.taskId&&t.state==='succeeded'));const next=await rpc(dir,{command:'status',includeTasks:true,tasksSince:first.taskRevision});assert.ok(!next.tasks||next.tasks.some(t=>t.id===start.taskId));
 two=spawn(process.execPath,args,{stdio:'ignore'});await once(two,'exit');assert.notEqual(two.exitCode,0);assert.equal((await rpc(dir,{command:'ping'})).pid,one.pid);assert.equal(one.exitCode,null);
 }finally{await stop(two);await stop(one);}
}));

test('高频进度合并写入、例行成功不挤满历史；重要失败保持可见',()=>fixture(async dir=>{
 const tasks=new Tasks(dir,()=>{});await tasks.start();
 tasks.begin('model-test','人工失败',async()=>{throw Error('synthetic failure');});await pause(0);await tasks.stop();assert.equal(tasks.list()[0].state,'failed');
 for(let i=0;i<55;i++){tasks.begin('quota-refresh','自动采样',async()=>({ok:true}));await pause(0);}
 tasks.begin('model-test','burst',async(_s,p)=>{for(let i=0;i<500;i++)p(i,500);return{ok:true};});await pause(0);await tasks.stop();
 assert.ok(tasks.list().some(t=>t.title==='人工失败'));assert.equal(tasks.list().filter(t=>t.kind==='quota-refresh'&&t.state==='succeeded').length,20);
 const persisted=JSON.parse(await readFile(join(dir,'activity.json'),'utf8'));assert.deepEqual(persisted,JSON.parse(JSON.stringify(tasks.list())));
 const archive=(await readFile(join(dir,'activity-history.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(archive.length,35);assert.ok(archive.every(row=>row.task.kind==='quota-refresh'));
}));
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("任务与取消 · refactor", { concurrency: false }, async () => {

async function state() { const directory = await mkdtemp('/tmp/gb-test-'); await mkdir(join(directory, '词典')); return directory; }
test('异步任务立即返回 ID，可取消并保留结果记录', async () => {
  const directory = await state(); const tasks = new Tasks(directory, () => {}); await tasks.start();
  try { const id = tasks.begin('synthetic', '模拟任务', signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))); assert.equal(typeof id, 'string'); assert.equal(tasks.list()[0].state, 'running'); tasks.cancel(id); await tasks.stop(); assert.equal(tasks.list()[0].state, 'cancelled'); const saved = JSON.parse(await readFile(join(directory, 'activity.json'))); assert.equal(saved[0].state, 'cancelled'); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
});
