import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,writeFile,readFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{execFile}from'node:child_process';import{promisify}from'node:util';
import{readMaintenanceManifest,reconcileMoves,executeMoves}from'../dist/maintenance-journal.js';import{atomicJson}from'../dist/files.js';
const run=promisify(execFile);
test('F04: every clear/restore crash boundary retains an executable reverse plan, including the final commit write',async t=>{
 for(const purpose of ['clear','restore'])for(let crash=1;crash<=5;crash++){
  const dir=await mkdtemp(join(tmpdir(),'gb-journal-crash-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const moves=Array.from({length:4},(_,i)=>({from:join(dir,'source-'+i),to:join(dir,'destination-'+i)}));for(const [i,m]of moves.entries())await writeFile(m.from,'payload-'+i);
  const journal=join(dir,'manifest.json');
  const script=`import{executeMoves}from ${JSON.stringify(new URL('../dist/maintenance-journal.js',import.meta.url).href)};import{atomicJson}from ${JSON.stringify(new URL('../dist/files.js',import.meta.url).href)};const moves=JSON.parse(process.argv[1]),path=process.argv[2],stage=Number(process.argv[3]);let calls=0;await executeMoves(path,{},moves,async()=>{if(++calls===moves.length+stage&&stage<=4)process.exit(72)},${purpose==='restore'?'{restoredAt:"test"}':'{}'},async(file,value)=>{if(value.transaction.phase==='committed'&&stage===5)process.exit(72);await atomicJson(file,value)});`;
  await assert.rejects(run(process.execPath,['--input-type=module','-e',script,JSON.stringify(moves),journal,String(crash)]),e=>e.code===72);
  await reconcileMoves(journal,await readMaintenanceManifest(journal),async()=>{});
  for(const [i,m]of moves.entries())assert.equal(await readFile(m.from,'utf8'),'payload-'+i);
 }
});
test('F04: final journal write failure rolls back bytes; an external replacement is retained for manual recovery',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'gb-journal-io-'));t.after(()=>rm(dir,{recursive:true,force:true}));const from=join(dir,'from'),to=join(dir,'to'),file=join(dir,'manifest.json');await writeFile(from,'original');
 await assert.rejects(executeMoves(file,{},[{from,to}],async()=>{}, {},async(path,value)=>{if(value.transaction.phase==='committed')throw Error('synthetic full disk');await atomicJson(path,value)}),/synthetic full disk/);
 assert.equal(await readFile(from,'utf8'),'original');
 let calls=0;await assert.rejects(executeMoves(file,{},[{from,to}],async()=>{if(++calls===2)await writeFile(to,'external') }),/路径/);assert.equal(await readFile(to,'utf8'),'external');assert.equal(await readFile(from,'utf8'),'original');
});
