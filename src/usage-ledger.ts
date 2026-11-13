import { Worker } from 'node:worker_threads';
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
export class UsageLedger {
    readonly path: string;
    constructor(readonly stateDir: string) { this.path = join(stateDir, 'usage-ledger-v2.sqlite'); }
    private async request<T>(operation: string, events?: LedgerEvent[], options?: unknown): Promise<T> {
        if (!['load', 'review', 'locks', 'version'].includes(operation)) {
            await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
            return withProcessLease(this.path + '.lock', () => this.performRequest<T>(operation, events, options));
        }
        return this.performRequest<T>(operation, events, options);
    }
    private performRequest<T>(operation: string, events?: LedgerEvent[], options?: unknown): Promise<T> {
        return new Promise((resolve, reject) => {
            const worker = new Worker(new URL('./usage-ledger-worker.js', import.meta.url), {
                workerData: { path: this.path, legacyPath: join(this.stateDir, 'usage-ledger.json'), operation, events, options },
                execArgv: ['--disable-warning=ExperimentalWarning'],
                resourceLimits: { maxOldGenerationSizeMb: 256 },
            });
            const timeoutMs = ['save', 'aggregate', 'revalue'].includes(operation) ? 90000 : 30000;
            const timer = setTimeout(() => { void worker.terminate(); reject(new Error('用量总账操作超时，原始账本已保留')); }, timeoutMs);
            worker.once('message', result => {
                clearTimeout(timer);
                if (result.ok)
                    resolve(result.value as T);
                else
                    reject(new Error(result.error));
            });
            worker.once('error', error => { clearTimeout(timer); reject(error); });
            worker.once('exit', code => { clearTimeout(timer); if (code !== 0)
                reject(new Error('用量总账工作线程异常退出')); });
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
