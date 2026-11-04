import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

const MAX_IDLE_WORKERS = 8;
const IDLE_WORKER_TTL_MS = 35_000;
const idleWorkers: Array<{ worker: Worker; timer: NodeJS.Timeout }> = [];

function acquirePooledWorker(path: string): Worker {
  while (idleWorkers.length > 0) {
    const entry = idleWorkers.pop()!;
    clearTimeout(entry.timer);
    entry.worker.ref();
    entry.worker.postMessage({ id: 'open', open: path });
    return entry.worker;
  }
  return new Worker(new URL('./sqlite-worker.js', import.meta.url), {
    workerData: { path },
    execArgv: ['--disable-warning=ExperimentalWarning'],
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });
}

function releasePooledWorker(worker: Worker) {
  if (idleWorkers.length >= MAX_IDLE_WORKERS) {
    void worker.terminate();
    return;
  }
  worker.unref();
  const timer = setTimeout(() => {
    const idx = idleWorkers.findIndex(item => item.worker === worker);
    if (idx >= 0) idleWorkers.splice(idx, 1);
    void worker.terminate();
  }, IDLE_WORKER_TTL_MS);
  timer.unref();
  idleWorkers.push({ worker, timer });
}

/** One background, read-only SQLite transaction per database scan. */
export class SqliteReadSnapshot {
  private worker: Worker;
  private failure?: string;
  private ended = false;
  private tainted = false;
  private pending?: { id: string; resolve: (value: any) => void; timer: NodeJS.Timeout };
  private closeWaiter?: { id: string; resolve: () => void };
  private onExit: () => void;
  private onError: (error: Error) => void;
  private onMessage: (result: any) => void;

  constructor(path: string, private signal?: AbortSignal) {
    this.worker = acquirePooledWorker(path);
    this.onExit = () => {
      this.ended = true;
      this.tainted = true;
      this.fail(this.failure || 'SQLite 读取连接已关闭');
      this.closeWaiter?.resolve();
    };
    this.onError = (error: Error) => {
      this.tainted = true;
      this.fail(error.message);
    };
    this.onMessage = (result: any) => {
      if (result.startupError) { this.fail(result.startupError); return; }
      if (result.closed && result.id === this.closeWaiter?.id) {
        const waiter = this.closeWaiter;
        this.closeWaiter = undefined;
        waiter?.resolve();
        return;
      }
      if (result.id !== this.pending?.id) return;
      const pending = this.pending!;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(result);
    };
    this.worker.once('exit', this.onExit);
    this.worker.on('error', this.onError);
    this.worker.on('message', this.onMessage);
    signal?.addEventListener('abort', this.abort, { once: true });
  }
  private abort = () => {
    this.tainted = true;
    this.fail(String(this.signal?.reason?.message ?? '读取已取消'));
    void this.worker.terminate();
  };
  private fail(message: string) {
    this.failure = message;
    if (this.pending) {
      const p = this.pending;
      this.pending = undefined;
      clearTimeout(p.timer);
      p.resolve({ ok: false, rows: [], error: message });
    }
  }
  async query(sql: string): Promise<{ok:boolean;rows:any[];error?:string}> {
    return this.request({sql});
  }
  async projectBlob(table:'gen_metadata'|'steps', column:'data'|'metadata', idx:number): Promise<{ok:boolean;rows:any[];error?:string}> {
    return this.request({projection:{table,column,idx}});
  }
  private async request(payload: object): Promise<{ok:boolean;rows:any[];error?:string}> {
    if(this.signal?.aborted)return{ok:false,rows:[],error:String(this.signal.reason?.message??'读取已取消')};
    if(this.ended||this.failure)return{ok:false,rows:[],error:this.failure||'SQLite 读取连接已关闭'};
    if(this.pending)return{ok:false,rows:[],error:'同一只读快照不能并发查询'};
    const id=randomUUID();
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{this.tainted=true;this.fail('数据库读取超出单批预算');void this.worker.terminate();},8000);
      this.pending={id,resolve,timer};this.worker.postMessage({id,...payload});
    });
  }
  async close() {
    this.signal?.removeEventListener('abort', this.abort);
    if (!this.ended && !this.tainted) {
      const closeId = `close-${randomUUID()}`;
      let timer: NodeJS.Timeout | undefined;
      const closedPromise = new Promise<boolean>(resolve => {
        this.closeWaiter = { id: closeId, resolve: () => resolve(true) };
        timer = setTimeout(() => { this.closeWaiter = undefined; resolve(false); }, 1000);
      });
      this.worker.postMessage({ id: closeId, close: true, reusable: true });
      const reusableOk = await closedPromise;
      clearTimeout(timer);
      this.detachListeners();
      if (reusableOk && !this.ended && !this.tainted) {
        releasePooledWorker(this.worker);
        return;
      }
    }
    this.detachListeners();
    void this.worker.terminate();
  }
  private detachListeners() {
    this.worker.removeListener('exit', this.onExit);
    this.worker.removeListener('error', this.onError);
    this.worker.removeListener('message', this.onMessage);
  }
}
