import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { existsSync, lstatSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import type { LedgerEvent } from './usage-ledger.js';
import { aggregateLedger, ledgerEventPage } from './usage-aggregate.js';
import { revalueLedger } from './usage-revalue.js';
export function validLedgerEvent(event: unknown): event is LedgerEvent {
    if (!event || typeof event !== 'object')
        return false;
    const row = event as LedgerEvent;
    return typeof row.event_key === 'string' && row.event_key.length > 0 && typeof row.model === 'string'
        && ['input_tokens', 'output_tokens', 'cached_tokens', 'total_tokens', 'timestamp_seconds'].every(key => {
            const value = row[key as keyof LedgerEvent];
            return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
        }) && (row.cache_write_tokens === undefined || Number.isSafeInteger(row.cache_write_tokens) && row.cache_write_tokens >= 0)
        && row.total_tokens === row.input_tokens + row.output_tokens + row.cached_tokens + (row.cache_write_tokens ?? 0);
}
function regular(path: string) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
        throw Error('用量总账文件身份不匹配，已停止写入');
}
function run(): unknown {
    const { path, legacyPath, operation, events, options } = workerData;
    const result = new Map<string, LedgerEvent>();
    let legacyEvents: LedgerEvent[] = [];
    // Validate before opening a writable database. Never overwrite or "repair" a damaged baseline.
    if (existsSync(legacyPath)) {
        regular(legacyPath);
        if (lstatSync(legacyPath).size > 64 * 1024 * 1024)
            throw Error('旧JSON总账超过自动读取预算，原文件保留，请先预览迁移');
        const legacy = JSON.parse(readFileSync(legacyPath, 'utf8'));
        if (![1, 2].includes(legacy?.version) || !Array.isArray(legacy.events) || !legacy.events.every(validLedgerEvent)) {
            throw Error('旧用量总账损坏或版本不支持；原文件已保留，停止写回');
        }
        legacyEvents = legacy.events;
        if (operation === 'load')
            for (const event of legacy.events)
                result.set(event.event_key, {
                    ...event, account_id: undefined, account_email: undefined, account_confidence: 'legacy',
                });
    }
    if (operation === 'review') {
        const suspicious = legacyEvents.filter(event => event.db_file === 'recovered_session.db' || !event.source_id);
        const synthetic = suspicious.filter(event => event.db_file === 'recovered_session.db');
        return { readOnly: true, baselinePath: existsSync(legacyPath) ? legacyPath : null,
            baselineSha256: existsSync(legacyPath) ? createHash('sha256').update(readFileSync(legacyPath)).digest('hex') : null,
            originalEventCount: legacyEvents.length, syntheticCount: synthetic.length, identityReviewCount: suspicious.length - synthetic.length,
            proposedExcludedTokens: synthetic.reduce((sum, event) => sum + event.total_tokens, 0),
            proposedExcludedRequests: synthetic.length,
            samples: suspicious.slice(0, 50).map(event => ({ eventKey: event.event_key, reason: event.db_file === 'recovered_session.db' ? '缺少原始用量，旧版本从金额反推' : '旧记录缺少稳定身份/归属证据，需核对',
                before: { model: event.model, tokens: event.total_tokens, timestamp: event.timestamp_seconds, account: event.account_email ?? event.account_id ?? null }, after: event.db_file === 'recovered_session.db' ? '仅保留金额凭据，Token/请求不计入可核验统计' : '保留原件，等待源数据核对' })),
            message: '旧JSON只读保留；当前预览不覆盖、删除或提交任何历史修订。新记录使用独立索引，可恢复原件核对。' };
    }
    if (!existsSync(path) && operation === 'count')
        return legacyEvents.length;
    if (!existsSync(path) && operation === 'locks')
        return {};
    if (!existsSync(path) && operation === 'events')
        throw Error('统计快照的总账已不可用，请重新读取');
    if (!existsSync(path) && operation === 'load')
        return [...result.values()];
    if (existsSync(path))
        regular(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path))
        writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    const db = new DatabaseSync(path, { readOnly: ['load', 'locks', 'version'].includes(operation) });
    try {
        if (operation === 'load') {
            if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== 2)
                throw Error('用量总账版本不支持');
            for (const row of db.prepare('SELECT payload,observed_at FROM events ORDER BY timestamp, event_key').iterate()) {
                const event = JSON.parse(String(row.payload));
                if (!validLedgerEvent(event))
                    throw Error('用量总账事件损坏，停止写回');
                if (Number(row.observed_at) > 0) event.source_observed_at = Number(row.observed_at);
                result.set(event.event_key!, event);
            }
            return [...result.values()];
        }
        const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
        if (version !== 0 && version !== 2 || version === 0 && Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()?.n) > 0)
            throw Error('用量总账版本或结构不支持，原件已保留');
        if (operation === 'version')
            return JSON.stringify([db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM event_revisions').get()?.n, db.prepare('SELECT COALESCE(MAX(version),0) AS n FROM rate_changes').get()?.n]);
        if (operation === 'locks') {
            if (version !== 2)
                throw Error('费率索引版本不支持');
            return Object.fromEntries(db.prepare('SELECT event_key,usd,unit_price FROM rate_locks LIMIT 50001').all().map(row => {
                const price = JSON.parse(String(row.unit_price));
                if (!Number.isFinite(row.usd) || Number(row.usd) < 0 || !['input', 'output', 'cached'].every(key => Number.isFinite(price[key]) && price[key] >= 0))
                    throw Error('费率索引损坏，停止重估');
                return [String(row.event_key), { usd: Number(row.usd), price }];
            }));
        }
        db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
        db.exec([
            "CREATE TABLE IF NOT EXISTS events(event_key TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, account_id TEXT, model TEXT NOT NULL, payload TEXT NOT NULL);",
            "CREATE INDEX IF NOT EXISTS events_time ON events(timestamp);",
            "CREATE INDEX IF NOT EXISTS events_account_time ON events(account_id,timestamp);",
            "PRAGMA user_version=2;",
        ].join('\n'));
        db.exec([
            "CREATE TABLE IF NOT EXISTS event_revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL,timestamp INTEGER NOT NULL,payload TEXT NOT NULL);",
            "CREATE INDEX IF NOT EXISTS revisions_key ON event_revisions(event_key,seq);",
            "CREATE INDEX IF NOT EXISTS revisions_time ON event_revisions(timestamp,seq);",
            "CREATE TABLE IF NOT EXISTS rate_locks(event_key TEXT PRIMARY KEY,unit_price TEXT NOT NULL,usd REAL NOT NULL);",
            "CREATE TABLE IF NOT EXISTS event_aliases(legacy_key TEXT PRIMARY KEY,event_key TEXT NOT NULL);",
            "CREATE TABLE IF NOT EXISTS rate_changes(version INTEGER PRIMARY KEY,min_event_seq INTEGER NOT NULL);",
            "CREATE TABLE IF NOT EXISTS snapshot_pins(snapshot_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,expires INTEGER NOT NULL);",
            "CREATE TABLE IF NOT EXISTS ledger_maintenance(key TEXT PRIMARY KEY,last_run INTEGER NOT NULL);",
        ].join('\n'));
        if (!(db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).some(column => column.name === 'observed_at')) db.exec('ALTER TABLE events ADD COLUMN observed_at REAL NOT NULL DEFAULT 0');
        db.exec('INSERT INTO event_revisions(event_key,timestamp,payload) SELECT event_key,timestamp,payload FROM events WHERE NOT EXISTS(SELECT 1 FROM event_revisions LIMIT 1);');
        if (operation === 'events')
            return ledgerEventPage(db, options);
        if (operation === 'renew') {
            const revision = Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM event_revisions').get()?.n);
            if (options.revision !== revision || !options.snapshotId)
                return false;
            db.prepare('INSERT INTO snapshot_pins VALUES(?,?,?) ON CONFLICT(snapshot_id) DO UPDATE SET expires=excluded.expires').run(options.snapshotId, revision, Date.now() + 600000);
            return true;
        }
        const lastPrune = Number(db.prepare("SELECT last_run FROM ledger_maintenance WHERE key='revisions'").get()?.last_run ?? 0);
        if (operation === 'prune' || operation === 'save' && Date.now() - lastPrune > 60000) {
            db.prepare('DELETE FROM snapshot_pins WHERE expires<?').run(Date.now());
            const cutoff = Number(db.prepare('SELECT COALESCE(MIN(revision),(SELECT COALESCE(MAX(seq),0) FROM event_revisions)) AS revision FROM snapshot_pins').get()?.revision);
            db.exec('BEGIN IMMEDIATE');
            try {
                db.prepare('DELETE FROM event_revisions WHERE seq<? AND seq<>(SELECT MAX(n.seq) FROM event_revisions n WHERE n.event_key=event_revisions.event_key AND n.seq<=?)').run(cutoff, cutoff);
                db.prepare("INSERT OR REPLACE INTO ledger_maintenance VALUES('revisions',?)").run(Date.now());
                db.exec('COMMIT');
            }
            catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
            if (operation === 'prune')
                return { pruned: true };
        }
        if (operation === 'count')
            return Number(db.prepare('SELECT COUNT(*) AS count FROM events').get()?.count) + legacyEvents.length;
        if (operation === 'revalue')
            return revalueLedger(db, path, options);
        if (operation === 'save-locks') {
            const previous = db.prepare('SELECT unit_price FROM rate_locks WHERE event_key=?');
            const sequence = db.prepare('SELECT MIN(seq) AS seq FROM event_revisions WHERE event_key=?');
            const put = db.prepare('INSERT INTO rate_locks VALUES(?,?,?) ON CONFLICT(event_key) DO UPDATE SET unit_price=excluded.unit_price,usd=excluded.usd');
            let minSeq = Number.POSITIVE_INFINITY;
            db.exec('BEGIN IMMEDIATE');
            try {
                for (const [key, entry] of Object.entries<any>(options.entries)) {
                    if (!Number.isFinite(entry.usd) || entry.usd < 0 || !entry.price)
                        throw Error('拒绝写入无效费率锁');
                    const price = JSON.stringify(entry.price);
                    if (previous.get(key)?.unit_price !== price) {
                        const seq = sequence.get(key)?.seq;
                        if (typeof seq === 'number')
                            minSeq = Math.min(minSeq, seq);
                    }
                    put.run(key, price, entry.usd);
                }
                if (Number.isFinite(minSeq))
                    db.prepare('INSERT INTO rate_changes VALUES((SELECT COALESCE(MAX(version),0)+1 FROM rate_changes),?)').run(minSeq);
                db.exec('COMMIT');
            }
            catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
            return { saved: Object.keys(options.entries).length };
        }
        if (operation === 'aggregate') {
            const ratesPath = join(dirname(path), 'usage-rate-locks.json');
            if (existsSync(ratesPath)) {
                regular(ratesPath);
                if (lstatSync(ratesPath).size > 16 * 1024 * 1024)
                    throw Error('旧费率JSON超过自动迁移预算，原件保留，请先预览迁移');
                const rates = JSON.parse(readFileSync(ratesPath, 'utf8'));
                if (rates.version !== 1 || !rates.entries || typeof rates.entries !== 'object')
                    throw Error('旧费率账本无效，原件已保留');
                const insertRate = db.prepare('INSERT OR IGNORE INTO rate_locks VALUES(?,?,?)');
                db.exec('BEGIN IMMEDIATE');
                try {
                    for (const [key, item] of Object.entries<any>(rates.entries)) {
                        const price = item.price ?? rates.profiles?.[item.p];
                        if (!price || !Number.isFinite(item.usd) || item.usd < 0)
                            throw Error('旧费率记录无效');
                        insertRate.run(key, JSON.stringify(price), item.usd);
                    }
                    db.exec('COMMIT');
                }
                catch (error) {
                    db.exec('ROLLBACK');
                    throw error;
                }
            }
            const insert = db.prepare('INSERT OR IGNORE INTO events(event_key,timestamp,account_id,model,payload) VALUES(?,?,?,?,?)');
            const revision = db.prepare('INSERT INTO event_revisions(event_key,timestamp,payload) VALUES(?,?,?)');
            db.exec('BEGIN IMMEDIATE');
            try {
                for (const event of legacyEvents)
                    if (event.db_file !== 'recovered_session.db') {
                        const payload = JSON.stringify({ ...event, account_id: undefined, account_email: undefined, account_confidence: 'legacy' });
                        if (insert.run(event.event_key!, event.timestamp_seconds, null, event.model, payload).changes)
                            revision.run(event.event_key!, event.timestamp_seconds, payload);
                    }
                db.exec('COMMIT');
            }
            catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
            return { ...aggregateLedger(db, options), ledger_review_records: legacyEvents.filter(event => !event.source_id || event.db_file === 'recovered_session.db').length };
        }
        if (!Array.isArray(events) || !events.every(validLedgerEvent))
            throw Error('拒绝写入无效用量事件');
        const upsert = db.prepare('INSERT INTO events(event_key,timestamp,account_id,model,payload,observed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET timestamp=excluded.timestamp,account_id=excluded.account_id,model=excluded.model,payload=excluded.payload,observed_at=excluded.observed_at WHERE payload<>excluded.payload');
        const revision = db.prepare('INSERT INTO event_revisions(event_key,timestamp,payload) VALUES(?,?,?)');
        const previous = db.prepare('SELECT payload,observed_at FROM events WHERE event_key=?');
        const alias = db.prepare('INSERT OR REPLACE INTO event_aliases VALUES(?,?)');
        db.exec('BEGIN IMMEDIATE');
        try {
            for (const event of events) {
                const stored = previous.get(event.event_key!);
                if (stored) {
                    if (Number(stored.observed_at) > (event.source_observed_at ?? 0)) continue;
                    const old = JSON.parse(String(stored.payload));
                    event.ingested_at = old.ingested_at ?? event.ingested_at;
                    if (old.account_confidence === 'observed' && !event.account_id) {
                        event.account_id = old.account_id;
                        event.account_email = old.account_email;
                        event.account_confidence = 'observed';
                    }
                    if (!event.timestamp_seconds)
                        event.timestamp_seconds = old.timestamp_seconds;
                    const comparable = { ...event, source_observed_at: old.source_observed_at };
                    if (JSON.stringify(comparable) === String(stored.payload)) {
                        db.prepare('UPDATE events SET observed_at=MAX(observed_at,?) WHERE event_key=?').run(event.source_observed_at ?? 0,event.event_key!);
                        continue;
                    }
                }
                const payload = JSON.stringify(event);
                if (event.legacy_event_key)
                    alias.run(event.legacy_event_key, event.event_key!);
                if (upsert.run(event.event_key!, event.timestamp_seconds, event.account_id ?? null, event.model, payload, event.source_observed_at ?? 0).changes)
                    revision.run(event.event_key!, event.timestamp_seconds, payload);
            }
            db.exec('COMMIT');
        }
        catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
        chmodSync(path, 0o600);
        return { saved: events.length };
    }
    finally {
        db.close();
    }
}
try {
    parentPort?.postMessage({ ok: true, value: run() });
}
catch (error) {
    parentPort?.postMessage({ ok: false, error: (error as Error).message });
}
