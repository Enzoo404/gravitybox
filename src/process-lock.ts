import { open, lstat, readFile, unlink, link, rename } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const context = new AsyncLocalStorage<Map<string, string>>();
const active = new Map<string, string>();
export type ProcessLease = { release(): Promise<void>; releaseSync(): void };

/** Same-user exclusive lease. Only a provably dead owner may be reclaimed. */
export async function acquireProcessLease(path: string, timeoutMs = 15000): Promise<ProcessLease> {
  const deadline = Date.now() + timeoutMs, nonce = randomUUID();
  while (true) {
    try {
      const temporary=path+'.'+nonce+'.tmp',file=await open(temporary,'wx',0o600);
      try {await file.writeFile(JSON.stringify({pid:process.pid,nonce}));await file.sync();await file.close();await link(temporary,path);}
      finally {await file.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
      const owns = (text: string) => { try { return JSON.parse(text).nonce === nonce; } catch { return false; } };
      return {
        async release() { try { if (owns(await readFile(path, 'utf8'))) await unlink(path); } catch {} },
        releaseSync() { try { if (owns(readFileSync(path, 'utf8'))) unlinkSync(path); } catch {} },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await lstat(path).catch(() => null);
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error('写入锁身份不匹配');
      const text = await readFile(path, 'utf8').catch(() => '');
      let pid = 0;
      try { pid = JSON.parse(text).pid; } catch { /* The owner may still be creating the lease. */ }
      if ((!Number.isSafeInteger(pid)||pid<=0) && Date.now()-info.mtimeMs>15000) {
        // Legacy half-created locks cannot have an owner after their descriptor is closed.
        let closed=false;
        try {await promisify(execFile)('/usr/sbin/lsof',['-t','--',path],{timeout:1500});}
        catch(error) {closed=(error as any).code===1 && !(error as any).stdout && !(error as any).stderr;}
        const check=await lstat(path).catch(()=>null);
        if(closed&&check?.ino===info.ino&&check.dev===info.dev&&await readFile(path,'utf8').catch(()=>null)===text) {await rename(path,path+'.orphan-'+Date.now()+'-'+nonce);continue;}
      }
      if (Number.isSafeInteger(pid) && pid > 0) {
        let dead = false;
        try { process.kill(pid, 0); } catch (failure) { dead = (failure as NodeJS.ErrnoException).code === 'ESRCH'; }
        if (dead) {
          const reclaimPath=path+'.reclaim';
          let reclaim;
          try { reclaim=await open(reclaimPath,'wx',0o600);await reclaim.writeFile(JSON.stringify({pid:process.pid,nonce}));await reclaim.sync(); } catch(failure) {
            if((failure as NodeJS.ErrnoException).code!=='EEXIST')throw failure;
            // Acquire/release the recovery lease through the same stale-owner protocol.
            const cleanup=await acquireProcessLease(reclaimPath,Math.max(1,deadline-Date.now()));await cleanup.release();continue;
          }
          if(reclaim) {
            try {
              const check = await lstat(path).catch(() => null);
              if (check?.ino === info.ino && check.dev === info.dev && await readFile(path, 'utf8').catch(() => '') === text) await unlink(path).catch(() => {});
            } finally { await reclaim.close(); await unlink(reclaimPath).catch(()=>{}); }
            continue;
          }
        }
      }
      if (Date.now() >= deadline) throw new Error('已有后台或账号写入操作正在进行，请稍后重试');
      await delay(30);
    }
  }
}

export async function withProcessLease<T>(path: string, action: () => Promise<T>): Promise<T> {
  const inherited = context.getStore()?.get(path);
  if (inherited && active.get(path) === inherited) return action();
  const lease = await acquireProcessLease(path), id = randomUUID();
  active.set(path, id);
  const next = new Map(context.getStore()); next.set(path, id);
  try { return await context.run(next, action); }
  finally { active.delete(path); await lease.release(); }
}
