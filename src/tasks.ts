import { randomUUID } from 'node:crypto';
import { readFile, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, atomicText, sanitizeError } from './files.js';
export type Task = { id: string; kind: string; state: 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'interrupted'; title: string; createdAt: string; updatedAt: string; done?: number; total?: number; message?: string; cancellable?: boolean; result?: any; preset?: string };
export class Tasks {
  private rows: Task[] = [];
  revision=0;
  private current?: { task: Task; abort: AbortController; work?: Promise<void> };
  private chain = Promise.resolve();
  private pendingSnapshot?: Task[];
  private writing = false;
  private retired: Task[] = [];
  constructor(private stateDir: string, private changed: () => void) {}
  async start() {
    try {
      const saved = JSON.parse(await readFile(join(this.stateDir, 'activity.json'), 'utf8'));
      this.rows = Array.isArray(saved) ? saved.slice(0, 50).map((r: Task) => ({ ...r, ...(r.state === 'running' ? { state: 'interrupted' as const, message: '上次运行已中断；请预览后重试' } : {}) })) : [];
    } catch { this.rows = []; }
  }
  list() { return this.rows.map(row => ({ ...row })); }
  private notify() {
    this.revision++;
    this.pendingSnapshot = this.list();
    if (!this.writing) {
      this.writing=true;
      this.chain=this.chain.catch(()=>{}).then(async()=>{try { while(this.pendingSnapshot) { const snapshot=this.pendingSnapshot;this.pendingSnapshot=undefined;
          if(this.retired.length) {
            const rows=this.retired.slice();
            const historyPath=join(this.stateDir,'activity-history.jsonl');
            const archive=await open(historyPath,'a',0o600);
            try{await archive.writeFile(rows.map(row=>JSON.stringify({archivedAt:new Date().toISOString(),task:row})).join('\n')+'\n');await archive.sync();}finally{await archive.close();}
            this.retired.splice(0,rows.length);
            const info=await stat(historyPath).catch(()=>null);
            if(info&&info.size>2*1024*1024){
              const raw=await readFile(historyPath,'utf8').catch(()=>'');
              const lines=raw.trim().split('\n');
              await atomicText(historyPath,lines.slice(-Math.max(200,Math.floor(lines.length/2))).join('\n')+'\n').catch(()=>{});
            }
          }
          await atomicJson(join(this.stateDir,'activity.json'),snapshot); } } finally {this.writing=false;} });
      this.chain.catch(()=>{});
    }
    this.changed();
  }
  begin(kind: string, title: string, operation: (signal: AbortSignal, progress: (done: number, total: number) => void, commit: () => void) => Promise<any>, meta?: { preset?: string }): string {
    if (this.current) throw new Error('请等待当前任务完成，或先取消');
    const task: Task = { id: randomUUID(), kind, state: 'running', title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), preset: meta?.preset };
    this.rows.unshift(task);
    let routineSuccess=0;
    const retained=this.rows.filter(row=>row.kind!=='quota-refresh'||row.state!=='succeeded'||++routineSuccess<=20).slice(0,50);
    const ids=new Set(retained.map(row=>row.id));this.retired.push(...this.rows.filter(row=>!ids.has(row.id)));this.rows=retained;
    const current = this.current = { task, abort: new AbortController(), work: undefined as Promise<void> | undefined };
    this.notify();
    current.work = (async () => {
      try {
        const result = await operation(current.abort.signal, (done, total) => { task.done = done; task.total = total; task.updatedAt = new Date().toISOString(); this.notify(); }, () => { current.abort.signal.throwIfAborted(); task.cancellable = false; task.message = '正在保存结果…'; this.notify(); });
        current.abort.signal.throwIfAborted();
        task.result = result;
        task.state = result?.ok === false ? (result?.partial || result?.acceptedCount > 0 ? 'partial' : 'failed') : 'succeeded';
        task.message = result?.message ?? '已完成';
      } catch (error) {
        const cancelled=current.abort.signal.aborted||(kind==='deep-scan'&&(error as Error).name==='UserIntervention');
        task.state = cancelled ? 'cancelled' : 'failed';
        task.message = cancelled ? (kind==='deep-scan'?'已取消。若已进入界面遍历，恢复结果会在报告中说明。':'已取消；未继续提交结果') : sanitizeError((error as Error)?.message || '操作未完成').slice(0, 240);
      } finally { task.updatedAt = new Date().toISOString(); this.current = undefined; this.notify(); }
    })();
    return task.id;
  }
  cancel(id?: string): boolean {
    // Only the task that is actually running can be cancelled; finished/unknown ids must not report a fake success.
    const current = this.current;
    if (!current) return false;
    if (id && id !== current.task.id) return false;
    if (current.task.cancellable === false) return false;
    current.abort.abort(new Error('已取消任务'));
    return true;
  }
  async stop() { this.cancel(); await this.current?.work; await this.chain; }
}
