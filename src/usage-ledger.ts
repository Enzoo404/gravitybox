import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { withProcessLease } from './process-lock.js';
import type { GenerationEvent, SyncReceipt, TokenUsageSummary } from './usage-types.js';
import type { ApiPricing, ApiPricingEntry } from './pricing.js';
import type { AggregateOptions, LedgerSnapshot } from './usage-aggregate.js';
import { bt, getActiveLocale } from './i18n.js';
export type LedgerEvent = GenerationEvent & {
    db_file?: string;
    ingested_at?: string;
};
export interface LedgerRangeEntry {
    event: LedgerEvent;
    usd: number | null;
    unitPrice?: ApiPricing | null;
}
/** The legacy JSON is a read-only recovery baseline; only changed rows enter the indexed store. */
const LEDGER_IDLE_TTL_MS = 30_000;

export class UsageLedger {
    readonly path: string;
    private worker: Worker | null = null;
    private idleTimer: NodeJS.Timeout | null = null;
    private pendingTerminate: Promise<void> | null = null;
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
            active.reject(reason ?? new Error(bt('ledger.err.worker_exited')));
        }
        const w = this.worker;
        this.worker = null;
        if (w) {
            w.removeAllListeners();
            const term = w.terminate().then(() => undefined, () => undefined);
            this.pendingTerminate = term;
            term.finally(() => {
                if (this.pendingTerminate === term) this.pendingTerminate = null;
            });
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
                this.destroyWorker(new Error(code !== 0 ? bt('ledger.err.worker_crashed') : bt('ledger.err.worker_exited')));
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
        const runWithTerminateBarrier = async (): Promise<T> => {
            if (this.pendingTerminate) await this.pendingTerminate;
            try {
                return await this.performRequest<T>(operation, events, options);
            } finally {
                if (this.pendingTerminate) await this.pendingTerminate;
            }
        };
        const execute = async (): Promise<T> => {
            if (!['load', 'review', 'locks', 'receipts', 'version', 'range'].includes(operation)) {
                await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
                return withProcessLease(this.path + '.lock', runWithTerminateBarrier);
            }
            return runWithTerminateBarrier();
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
            const timeoutMs = ['save', 'aggregate', 'revalue', 'purge-forked-clones'].includes(operation) ? 90000 : 30000;
            const timer = setTimeout(() => {
                if (this.inflight?.id === id) {
                    this.destroyWorker(new Error(bt('ledger.err.timeout')));
                }
            }, timeoutMs);
            this.inflight = { id, resolve, reject, timer };
            worker.postMessage({
                id,
                locale: getActiveLocale(),
                path: this.path,
                legacyPath: join(this.stateDir, 'usage-ledger.json'),
                operation,
                events,
                options,
            });
        });
    }
    load(): Promise<LedgerEvent[]> { return this.request('load'); }
    range(options: { startSec: number; endSec: number }): Promise<LedgerRangeEntry[]> { return this.request('range', undefined, options); }
    async prune(): Promise<void> { await this.request('prune'); }
    review(): Promise<Record<string, any>> { return this.request('review'); }
    locks(): Promise<Record<string, {
        usd: number;
        price: any;
    }>> { return this.request('locks'); }
    receipts(): Promise<Record<string, SyncReceipt>> { return this.request('receipts'); }
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
        accountId?: string;
        environmentId?: string;
    }): Promise<{
        rows: any[];
        total: number;
        offset: number;
        limit: number;
    }> { return this.request('events', undefined, options); }
    async purgeForkedClones(
        targets: Array<{ dbFile: string; excludedGenIndices: number[] }>
    ): Promise<{ deleted: number }> {
        const normalized = Array.isArray(targets)
            ? targets
                .map(t => ({
                    dbFile: typeof t?.dbFile === 'string' ? t.dbFile.trim() : '',
                    excludedGenIndices: Array.isArray(t?.excludedGenIndices)
                        ? [...new Set(t.excludedGenIndices.filter(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0))]
                        : [],
                }))
                .filter(t => t.dbFile.length > 0 && t.excludedGenIndices.length > 0)
            : [];
        if (normalized.length === 0) {
            return { deleted: 0 };
        }
        return this.request('purge-forked-clones', undefined, { targets: normalized });
    }
    async save(
        events: LedgerEvent[],
        options?: { billingPrices?: Record<string, ApiPricingEntry>; receipts?: SyncReceipt[] }
    ): Promise<{ saved: number; locksWritten?: number; receiptsWritten?: number }> {
        const eventList = Array.isArray(events) ? events : [];
        const receiptList = Array.isArray(options?.receipts) ? options.receipts : [];
        if (eventList.length === 0 && receiptList.length === 0) {
            return { saved: 0, locksWritten: 0, receiptsWritten: 0 };
        }
        return this.request('save', eventList, options);
    }
}
