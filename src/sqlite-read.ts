import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { HudWorkerScanRequest, HudWorkerScanResult } from './sqlite-worker.js';

const MAX_IDLE_WORKERS = 8;
const IDLE_WORKER_TTL_MS = 35_000;
const idleWorkers: Array<{ worker: Worker; timer: NodeJS.Timeout; cleanup: () => void }> = [];

function acquirePooledWorker(path: string): Worker {
  while (idleWorkers.length > 0) {
    const entry = idleWorkers.pop()!;
    entry.cleanup();
    if (entry.worker.threadId < 0) continue;
    entry.worker.ref();
    if (path.length > 0) {
      entry.worker.postMessage({ id: 'open', open: path });
    }
    return entry.worker;
  }
  return new Worker(new URL('./sqlite-worker.js', import.meta.url), {
    workerData: { path },
    execArgv: ['--disable-warning=ExperimentalWarning'],
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });
}

function releasePooledWorker(worker: Worker) {
  if (idleWorkers.length >= MAX_IDLE_WORKERS || worker.threadId < 0) {
    void worker.terminate();
    return;
  }
  worker.unref();
  const removeIdle = () => {
    const idx = idleWorkers.findIndex(item => item.worker === worker);
    if (idx >= 0) {
      const [removed] = idleWorkers.splice(idx, 1);
      clearTimeout(removed!.timer);
    }
    worker.removeListener('exit', onIdleExit);
    worker.removeListener('error', onIdleError);
  };
  const onIdleExit = () => removeIdle();
  const onIdleError = () => { removeIdle(); void worker.terminate(); };
  worker.once('exit', onIdleExit);
  worker.once('error', onIdleError);
  const timer = setTimeout(() => {
    removeIdle();
    void worker.terminate();
  }, IDLE_WORKER_TTL_MS);
  timer.unref();
  idleWorkers.push({ worker, timer, cleanup: removeIdle });
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
    if (this.pending) {
      this.tainted = true;
      this.fail('SQLite 读取连接已关闭');
    }
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

/**
 * 在只读 Worker 线程池中执行单次无长事务 HUD 数据库增量/全量扫描，
 * 单次请求内自动提交并立即关闭 SQLite 句柄，绝不阻塞主进程事件循环或宿主 wal_checkpoint。
 */
export async function runHudDbScanInWorker(
  hudScan: HudWorkerScanRequest,
  timeoutMs = 3000
): Promise<HudWorkerScanResult> {
  const worker = acquirePooledWorker('');
  const id = randomUUID();
  return new Promise<HudWorkerScanResult>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
    };
    const onMessage = (msg: any) => {
      if (!msg || msg.id !== id || settled) return;
      settled = true;
      cleanup();
      releasePooledWorker(worker);
      if (msg.ok && msg.hudResult) {
        resolve(msg.hudResult as HudWorkerScanResult);
      } else {
        reject(new Error(msg.error || 'HUD 数据库读取失败'));
      }
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      reject(err);
    };
    const onExit = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('HUD 数据库读取工作线程异常退出'));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      reject(new Error('HUD 数据库读取超出单次时间预算'));
    }, timeoutMs);

    worker.on('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
    worker.postMessage({ id, hudScan });
  });
}
