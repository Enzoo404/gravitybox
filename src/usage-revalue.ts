import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { aggregateLedger, type AggregateOptions } from './usage-aggregate.js';
import { matchPricingKeys, resolvePricingForTimestamp } from './pricing.js';
import { resolveDatabaseModelFullName } from './usage-types.js';
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function feesDigest(db: DatabaseSync): string {
    const hash = createHash('sha256');
    for (const row of db.prepare('SELECT event_key,unit_price,usd FROM rate_locks ORDER BY event_key').iterate())
        hash.update(JSON.stringify([row.event_key, row.unit_price, row.usd])).update('\n');
    return hash.digest('hex');
}
function revision(db: DatabaseSync): number { return Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM event_revisions').get()?.n); }
export function revalueLedger(db: DatabaseSync, path: string, options: AggregateOptions & {
    action: 'preview' | 'apply' | 'restore';
    mode?: 'force_all' | 'unpriced_only';
    previewId?: string;
    confirmed?: boolean;
}) {
    const reviews = join(dirname(path), 'ledger-reviews');
    if (options.action === 'preview') {
        mkdirSync(reviews, { recursive: true, mode: 0o700 });
        try {
            const previewReceipts = readdirSync(reviews)
                .filter(name => /^[0-9a-f-]{36}\.json$/i.test(name))
                .map(name => {
                    const receiptFile = join(reviews, name);
                    try {
                        const parsed = JSON.parse(readFileSync(receiptFile, 'utf8'));
                        if (parsed?.phase && parsed.phase !== 'preview') return null;
                        const mtime = lstatSync(receiptFile).mtimeMs;
                        return { id: name.slice(0, -5), mtime };
                    } catch {
                        return null;
                    }
                })
                .filter((item): item is { id: string; mtime: number } => item !== null)
                .sort((a, b) => a.mtime - b.mtime);
            if (previewReceipts.length >= 5) {
                for (const stale of previewReceipts.slice(0, previewReceipts.length - 4)) {
                    for (const suffix of ['.json', '-before.sqlite', '-candidate.sqlite', '-rates-before.json']) {
                        try { unlinkSync(join(reviews, stale.id + suffix)); } catch {}
                    }
                }
            }
        } catch {}
        const id = randomUUID(), backup = join(reviews, id + '-before.sqlite'), candidate = join(reviews, id + '-candidate.sqlite');
        const sourceRevision = revision(db), sourceFeesDigest = feesDigest(db);
        db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
        const baseline = new DatabaseSync(backup);
        const ratesPath = join(dirname(path), 'usage-rate-locks.json');
        const rateBytes = existsSync(ratesPath) ? readFileSync(ratesPath) : null;
        const rateDigest = rateBytes ? createHash('sha256').update(rateBytes).digest('hex') : null;
        if (rateBytes)
            writeFileSync(join(reviews, id + '-rates-before.json'), rateBytes, { mode: 0o600 });
        try {
            if (rateBytes) {
                const rates = JSON.parse(rateBytes.toString());
                if (rates.version !== 1 || !rates.entries)
                    throw Error('历史费率账本无法验证，未生成重估候选');
                const insert = baseline.prepare('INSERT OR IGNORE INTO rate_locks VALUES(?,?,?)');
                for (const [key, value] of Object.entries<any>(rates.entries)) {
                    const price = value.price ?? rates.profiles?.[value.p];
                    if (!price || !Number.isFinite(value.usd) || value.usd < 0)
                        throw Error('历史费率条目无效，原件已保留');
                    insert.run(key, JSON.stringify(price), value.usd);
                }
            }
            baseline.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        }
        finally {
            baseline.close();
        }
        copyFileSync(backup, candidate);
        chmodSync(backup, 0o600);
        chmodSync(candidate, 0o600);
        const next = new DatabaseSync(candidate);
        let before = 0, after = 0, unknown = 0;
        try {
            before = Number(next.prepare('SELECT COALESCE(SUM(l.usd),0) AS usd FROM events e JOIN rate_locks l ON l.event_key=e.event_key').get()?.usd);
            const remove = next.prepare('DELETE FROM rate_locks WHERE event_key=?');
            for (const row of next.prepare('SELECT e.event_key,e.payload,l.unit_price,l.usd FROM events e LEFT JOIN rate_locks l ON l.event_key=e.event_key').iterate()) {
                const event = JSON.parse(String(row.payload));
                const normalizedModel = resolveDatabaseModelFullName(event.model, null);
                const price = resolvePricingForTimestamp(
                    options.prices[normalizedModel] ?? options.prices[matchPricingKeys(normalizedModel)],
                    event.timestamp_seconds,
                    normalizedModel
                );
                if (!price) {
                    unknown++;
                    continue;
                } // Current prices are never invented for an unsupported historical interval.
                const locked = row.unit_price ? JSON.parse(String(row.unit_price)) : null;
                const unpriced = !locked || Number(row.usd) === 0 && [locked.input, locked.output, locked.cached, locked.cacheWrite ?? 0].every(value => value === 0);
                if (options.mode !== 'unpriced_only' || unpriced)
                    remove.run(String(row.event_key));
            }
            after = aggregateLedger(next, { ...options, accountId: 'all', accounts: [], ignoreLegacyRates: true }).all_time.estimated_usd;
            const original = new DatabaseSync(backup, { readOnly: true });
            const lookup = original.prepare('SELECT usd FROM rate_locks WHERE event_key=?');
            const changes: {
                key: string;
                before: number | null;
                after: number;
            }[] = [];
            let changedCount = 0;
            for (const row of next.prepare('SELECT event_key,usd FROM rate_locks').iterate()) {
                const old = lookup.get(String(row.event_key));
                if (!old || Number(old.usd) !== Number(row.usd)) {
                    changedCount++;
                    if (changes.length < 100)
                        changes.push({ key: String(row.event_key), before: old ? Number(old.usd) : null, after: Number(row.usd) });
                }
            }
            original.close();
            if (revision(db) !== sourceRevision || feesDigest(db) !== sourceFeesDigest)
                throw Error('预览期间用量已变化，请重新生成预览');
            const receipt = { schema: 1, previewId: id, sourceRevision, sourceFeesDigest, rateDigest, priceDigest: digest(options.prices), backup, candidate, mode: options.mode ?? 'force_all', before: Math.round(before * 1e8) / 1e8, after, changedCount, unverifiableCount: unknown, samples: changes, requiresConfirmation: true };
            writeFileSync(join(reviews, id + '.json'), JSON.stringify(receipt, null, 2), { mode: 0o600, flag: 'wx' });
            return receipt;
        }
        finally {
            next.close();
        }
    }
    if (!options.confirmed || !options.previewId || !/^[a-f0-9-]{36}$/.test(options.previewId))
        throw Error('请先查看历史重估预览，再明确确认该预览；原费率未改变');
    const receiptPath = join(reviews, options.previewId + '.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const ratesPath = join(dirname(path), 'usage-rate-locks.json');
    const currentRateDigest = existsSync(ratesPath) ? createHash('sha256').update(readFileSync(ratesPath)).digest('hex') : null;
    if (receipt.schema !== 1 || receipt.sourceRevision !== revision(db) || options.action === 'apply' && (receipt.priceDigest !== digest(options.prices) || receipt.rateDigest !== currentRateDigest))
        throw Error('预览后账本或价格已变化，请重新预览，未覆盖当前记录');
    if (options.action === 'restore' && (receipt.phase !== 'applied' || receipt.appliedFeesDigest !== feesDigest(db)))
        throw Error('确认重估后费率已变化，停止覆盖；原备份仍保留');
    if (options.action === 'apply' && receipt.sourceFeesDigest !== feesDigest(db))
        throw Error('预览后历史费率已变化，请重新预览');
    const selected = options.action === 'restore' ? receipt.backup : receipt.candidate;
    if (selected !== join(reviews, options.previewId + (options.action === 'restore' ? '-before.sqlite' : '-candidate.sqlite')))
        throw Error('历史重估恢复路径无效');
    db.exec(`ATTACH DATABASE '${selected.replace(/'/g, "''")}' AS reviewed`);
    try {
        db.exec('BEGIN IMMEDIATE; DELETE FROM rate_locks; INSERT INTO rate_locks SELECT * FROM reviewed.rate_locks; INSERT INTO rate_changes VALUES((SELECT COALESCE(MAX(version),0)+1 FROM rate_changes),0); COMMIT;');
    }
    catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
    finally {
        db.exec('DETACH DATABASE reviewed');
    }
    if (options.action === 'restore') {
        const beforeRatesPath = join(reviews, options.previewId + '-rates-before.json');
        if (existsSync(beforeRatesPath)) {
            const tmpRates = `${ratesPath}.${process.pid}.${randomUUID()}.tmp`;
            writeFileSync(tmpRates, readFileSync(beforeRatesPath), { mode: 0o600 });
            renameSync(tmpRates, ratesPath);
        } else if (receipt.rateDigest === null && existsSync(ratesPath)) {
            unlinkSync(ratesPath);
        }
    } else if (existsSync(ratesPath)) {
        const profiles: unknown[] = [];
        const profileMap = new Map<string, number>();
        const entries: Record<string, { usd: number; p: number }> = Object.create(null);
        for (const row of db.prepare('SELECT event_key, unit_price, usd FROM rate_locks').iterate() as Iterable<any>) {
            const unitRaw = String(row.unit_price);
            let idx = profileMap.get(unitRaw);
            if (idx === undefined) {
                idx = profiles.length;
                profileMap.set(unitRaw, idx);
                profiles.push(JSON.parse(unitRaw));
            }
            entries[String(row.event_key)] = { usd: Number(row.usd), p: idx };
        }
        const tmpRates = `${ratesPath}.${process.pid}.${randomUUID()}.tmp`;
        writeFileSync(tmpRates, JSON.stringify({ version: 1, profiles, entries }) + '\n', { mode: 0o600 });
        renameSync(tmpRates, ratesPath);
    }
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, phase: options.action === 'restore' ? 'restored' : 'applied', appliedFeesDigest: feesDigest(db), completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    return { before: receipt.before, after: options.action === 'restore' ? receipt.before : receipt.after, previewId: receipt.previewId, backupPath: receipt.backup,
        message: options.action === 'restore' ? '已恢复该预览保存的原费率；备份与差异仍保留' : '历史费用已按已确认预览重估；原费率备份及差异可回退' };
}
