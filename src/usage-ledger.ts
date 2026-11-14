import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { withProcessLease } from './process-lock.js';
import type { GenerationEvent } from './usage.js';
import type { AggregateOptions, LedgerSnapshot } from './usage-aggregate.js';
import type { TokenUsageSummary } from './usage.js';
export type LedgerEvent = GenerationEvent & {
    db_file?: string;
    ingested_at?: string;
};
/** The legacy JSON is a read-only recovery baseline; only changed rows enter the indexed store. */
const LEDGER_IDLE_TTL_MS = 30_000;

export class UsageLedger {
    readonly path: string;
    private worker: Worker | null = null;
    private idleTimer: NodeJS.Timeout | null = null;
    private workerQueue: Promise<unknown> = Promise.resolve();
    private inflight: {
        id: string;
        resolve: (value: any) => void;
        reject: (reason: Error) => void;
        timer: NodeJS.Timeout;
    } | null = null;

    constructor(readonly stateDir: string) { this.path = join(stateDir, 'usage-ledger-v2.sqlite'); }

    private destroyWorker(reason?: Error): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        const active = this.inflight;
        this.inflight = null;
        if (active) {
            clearTimeout(active.timer);
            active.reject(reason ?? new Error('用量总账工作线程已退出'));
        }
        const w = this.worker;
        this.worker = null;
        if (w) {
            w.removeAllListeners();
            void w.terminate();
        }
    }

    private ensureWorker(): Worker {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        if (this.worker && this.worker.threadId >= 0) {
            this.worker.ref();
            return this.worker;
        }
        const worker = new Worker(new URL('./usage-ledger-worker.js', import.meta.url), {
            execArgv: ['--disable-warning=ExperimentalWarning'],
            resourceLimits: { maxOldGenerationSizeMb: 256 },
        });
        worker.on('message', (result: any) => {
            const active = this.inflight;
            if (!active || result?.id !== active.id) return;
            this.inflight = null;
            clearTimeout(active.timer);
            this.scheduleIdlePark();
            if (result.ok) active.resolve(result.value);
            else active.reject(new Error(result.error));
        });
        worker.on('error', (error: Error) => {
            this.destroyWorker(error);
        });
        worker.on('exit', (code: number) => {
            if (this.worker === worker) this.worker = null;
            if (this.inflight) {
                this.destroyWorker(new Error(code !== 0 ? '用量总账工作线程异常退出' : '用量总账工作线程已退出'));
            }
        });
        this.worker = worker;
        return worker;
    }

    private scheduleIdlePark(): void {
        if (!this.worker || this.inflight) return;
        this.worker.unref();
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (!this.inflight) this.destroyWorker();
        }, LEDGER_IDLE_TTL_MS);
        this.idleTimer.unref();
    }

    private request<T>(operation: string, events?: LedgerEvent[], options?: unknown): Promise<T> {
        const execute = async (): Promise<T> => {
            if (!['load', 'review', 'locks', 'version'].includes(operation)) {
                await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
                return withProcessLease(this.path + '.lock', () => this.performRequest<T>(operation, events, options));
            }
            return this.performRequest<T>(operation, events, options);
        };
        const next = this.workerQueue.catch(() => {}).then(execute);
        this.workerQueue = next.catch(() => {});
        return next;
    }

    private performRequest<T>(operation: string, events?: LedgerEvent[], options?: unknown): Promise<T> {
        return new Promise((resolve, reject) => {
            let worker: Worker;
            try {
                worker = this.ensureWorker();
            } catch (error) {
                reject(error);
                return;
            }
            const id = randomUUID();
            const timeoutMs = ['save', 'aggregate', 'revalue'].includes(operation) ? 90000 : 30000;
            const timer = setTimeout(() => {
                if (this.inflight?.id === id) {
                    this.destroyWorker(new Error('用量总账操作超时，原始账本已保留'));
                }
            }, timeoutMs);
            this.inflight = { id, resolve, reject, timer };
            worker.postMessage({
                id,
                path: this.path,
                legacyPath: join(this.stateDir, 'usage-ledger.json'),
                operation,
                events,
                options,
            });
        });
    }
    load(): Promise<LedgerEvent[]> { return this.request('load'); }
    async prune(): Promise<void> { await this.request('prune'); }
    review(): Promise<Record<string, any>> { return this.request('review'); }
    locks(): Promise<Record<string, {
        usd: number;
        price: any;
    }>> { return this.request('locks'); }
    async saveLocks(entries: Record<string, {
        usd: number;
        price: unknown;
    }>): Promise<void> { await this.request('save-locks', undefined, { entries }); }
    revalue(options: AggregateOptions & {
        action: 'preview' | 'apply' | 'restore';
        mode?: 'force_all' | 'unpriced_only';
        previewId?: string;
        confirmed?: boolean;
    }): Promise<any> { return this.request('revalue', undefined, options); }
    version(): Promise<string> { return this.request('version'); }
    renew(snapshot: LedgerSnapshot): Promise<boolean> { return this.request('renew', undefined, snapshot); }
    count(): Promise<number> { return this.request('count'); }
    aggregate(options: AggregateOptions): Promise<TokenUsageSummary & {
        ledger_snapshot: LedgerSnapshot;
    }> { return this.request('aggregate', undefined, options); }
    events(options: {
        snapshot: LedgerSnapshot;
        period: string;
        query: string;
        offset: number;
        limit: number;
        targetEmail?: string;
    }): Promise<{
        rows: any[];
        total: number;
        offset: number;
        limit: number;
    }> { return this.request('events', undefined, options); }
    async save(events: LedgerEvent[]): Promise<void> { if (events.length)
        await this.request('save', events); }
}
