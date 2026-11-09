import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {AccountsManager, MockKeychainAdapter} from '../dist/accounts.js';
import {AccountSwitchService, DatabaseTransaction} from '../dist/account-switch.js';

async function fixture(t, withDatabase = true) {
  const root = await mkdtemp(join(tmpdir(), 'gb-undo-recovery-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const stateDir=join(root,'state'), profile=join(root,'profile'), externalDir=join(root,'external');
  await mkdir(join(profile,'User/globalStorage'),{recursive:true}); await mkdir(externalDir);
  const db=join(profile,'User/globalStorage/state.vscdb');
  const sql=s=>execFileSync('/usr/bin/sqlite3',[db,s],{encoding:'utf8'}).trim();
  if(withDatabase) sql('CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT);');
  const manager=new AccountsManager(stateDir,{externalDir}), keychain=new MockKeychainAdapter();
  await keychain.writePassword('gemini','antigravity','synthetic-initial');
  const a=await manager.upsertAccount({email:'a@example.invalid',refreshToken:'synthetic-a',accessToken:'access-a',expiresIn:3600});
  const b=await manager.upsertAccount({email:'b@example.invalid',refreshToken:'synthetic-b',accessToken:'access-b',expiresIn:3600});
  const options={stateDir,profile,externalDir,keychain,isRunning:async()=>false};
  const service=new AccountSwitchService(manager,options); await service.switchAccount(b.id);
  const journal=join(stateDir,'account-switch-journal-stable.json'), undo=journal+'.rollback.json';
  const snapshot=async()=>({db:withDatabase?sql('SELECT key,value FROM ItemTable ORDER BY key;'):'absent',index:await readFile(join(stateDir,'accounts.json'),'utf8'),password:await keychain.readPassword('gemini','antigravity'),account:await readFile(join(stateDir,'accounts',b.id+'.json'),'utf8')});
  return {root,stateDir,manager,keychain,service,options,journal,undo,snapshot,sql,a,b};
}

test('撤销最后检查发现应用启动：补偿文件和钥匙串，保持撤销前账号一致且可重试',async t=>{
  const f=await fixture(t), before=await f.snapshot();let calls=0;
  f.options.isRunning=async()=>++calls===2;
  await assert.rejects(f.service.rollback(),/请先保存工作/);
  assert.deepEqual(await f.snapshot(),before);
  assert.equal(JSON.parse(await readFile(f.journal)).status,'complete');
  await assert.rejects(stat(f.undo),{code:'ENOENT'});
  f.options.isRunning=async()=>false;await f.service.rollback();
  assert.equal(JSON.parse(await readFile(join(f.stateDir,'accounts.json'))).current_account_id,f.a.id);
  assert.equal(await f.keychain.readPassword('gemini','antigravity'),'synthetic-initial');
});

test('撤销恢复钥匙串部分写入后报错：精确补偿而不是留下混合账号',async t=>{
  const f=await fixture(t),before=await f.snapshot(),write=f.keychain.writePassword.bind(f.keychain);let fail=true;
  f.keychain.writePassword=async(s,a,v)=>{await write(s,a,v);if(fail&&v==='synthetic-initial'){fail=false;throw Error('synthetic keychain failure');}};
  await assert.rejects(f.service.rollback(),/synthetic keychain failure/);
  assert.deepEqual(await f.snapshot(),before);await f.service.rollback();
});

for (const committed of [false,true]) test(`数据库提交${committed?'已成功但应答丢失':'前失败'}：以实际数据库状态对账`,async t=>{
  const f=await fixture(t),before=await f.snapshot();
  f.options.databaseFactory=path=>{const tx=new DatabaseTransaction(path),finish=tx.finish.bind(tx);tx.finish=async commit=>{if(commit){if(committed)await finish(true);throw Error('synthetic commit failure');}return finish(commit);};return tx;};
  if(committed){await f.service.rollback();assert.equal(JSON.parse(await readFile(f.journal)).status,'rolled-back');assert.equal(await f.keychain.readPassword('gemini','antigravity'),'synthetic-initial');assert.equal(f.sql('SELECT count(*) FROM ItemTable;'),'0');}
  else {await assert.rejects(f.service.rollback(),/synthetic commit failure/);assert.deepEqual(await f.snapshot(),before);}
  await assert.rejects(stat(f.undo),{code:'ENOENT'});
});

test('补偿也失败：持久恢复记录阻止清除，下次服务重建后可恢复',async t=>{
  const f=await fixture(t),before=await f.snapshot(),write=f.keychain.writePassword.bind(f.keychain);let blocked=true;
  f.keychain.writePassword=async(s,a,v)=>{if(blocked){if(v==='synthetic-initial')await write(s,a,v);throw Error('synthetic unavailable');}return write(s,a,v);};
  await assert.rejects(f.service.rollback(),/自动补偿受阻/);
  const recovery=await f.service.recoveryInfo();assert.equal(recovery.pending,true);assert.equal(recovery.status,'rollback-pending');
  assert.equal((await stat(f.undo)).mode&0o777,0o600);
  await assert.rejects(f.service.clearRecovery(recovery.digest),/恢复材料不可清除/);
  blocked=false;
  const next=new AccountSwitchService(new AccountsManager(f.stateDir,{externalDir:f.options.externalDir}),f.options);
  await next.rollback();assert.equal(JSON.parse(await readFile(f.journal)).status,'rolled-back');
  assert.equal(await f.keychain.readPassword('gemini','antigravity'),'synthetic-initial');
  assert.notEqual((await f.snapshot()).db,before.db);
  await assert.rejects(stat(f.undo),{code:'ENOENT'});
});

test('没有登录数据库时仍能精确补偿，并在重试后完成撤销',async t=>{
  const f=await fixture(t,false),before=await f.snapshot();let calls=0;
  f.options.isRunning=async()=>++calls===2;
  await assert.rejects(f.service.rollback(),/请先保存工作/);assert.deepEqual(await f.snapshot(),before);
  f.options.isRunning=async()=>false;await f.service.rollback();
  assert.equal(JSON.parse(await readFile(f.journal)).status,'rolled-back');
  assert.equal(await f.keychain.readPassword('gemini','antigravity'),'synthetic-initial');
});

test('外部账号文件在撤销中途变化：保留新内容，不盲目覆盖或伪报恢复成功',async t=>{
  const f=await fixture(t), index=join(f.stateDir,'accounts.json');let calls=0;
  f.options.isRunning=async()=>{if(++calls===2){await writeFile(index,'{"external":"preserve"}');return true;}return false;};
  await assert.rejects(f.service.rollback(),/自动补偿受阻/);
  assert.equal(await readFile(index,'utf8'),'{"external":"preserve"}');
  assert.equal((await f.service.recoveryInfo()).pending,true);
});
