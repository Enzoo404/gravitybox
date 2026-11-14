import { readdir, lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DataDirectoryName } from './application-target.js';
import { SqliteReadSnapshot } from './sqlite-read.js';
import { ProtobufReader } from './protobuf.js';
import type { LedgerEvent } from './usage-ledger.js';
import {
  resolveDatabaseModelFullName,
  type FileCacheEntry,
  type GenerationEvent,
  type TokenUsageSummary,
} from './usage-types.js';

export interface DiscoveredDbStat {
  mtimeMs: number;
  size: number;
  walMtimeMs: number;
  walSize: number;
  at: number;
}

export interface UsageScanContext {
  discoveredStats: Map<string, DiscoveredDbStat>;
  fileCache: Map<string, FileCacheEntry>;
  setFileCacheEntry: (dbPath: string, entry: FileCacheEntry) => void;
  markFileCacheDirty: () => void;
  lookupObservedContext: (timestampSec: number) => { id?: string; email?: string; account_type: 'consumer' | 'enterprise_vertex' | 'unknown' } | null;
  loadUsageLedger: () => Promise<void>;
  upsertLedger: (event: LedgerEvent) => void;
  getLedgerEvent: (eventKey: string) => LedgerEvent | undefined;
}

export async function querySqlite(
  dbPath: string,
  sql: string,
  signal?: AbortSignal,
  reader?: SqliteReadSnapshot
): Promise<{ ok: boolean; rows: any[]; error?: string }> {
  if (reader) return reader.query(sql);
  const owned = new SqliteReadSnapshot(dbPath, signal);
  try { return await owned.query(sql); } finally { await owned.close(); }
}

export async function discoverDatabaseFiles(
  geminiDir: string,
  dataDirectoryNames: readonly DataDirectoryName[],
  discoveredStats: Map<string, DiscoveredDbStat>,
  maxFiles = Number.POSITIVE_INFINITY
): Promise<{
  paths: string[];
  errors: NonNullable<TokenUsageSummary['database_diagnostics']>;
  discoveredCount: number;
}> {
  const errors: NonNullable<TokenUsageSummary['database_diagnostics']> = [];
  const issue = (path: string, error: unknown) => errors.push({
    id: createHash('sha256').update(path).digest('hex').slice(0, 10),
    state: 'discovery_failed',
    category: (error as NodeJS.ErrnoException).code === 'EACCES' ? '目录访问受限' : '数据库发现失败',
  });
  const list: { path: string; mtime: number }[] = [];
  const now = Date.now();
  discoveredStats.clear();
  const allowedDirs = new Set<string>(dataDirectoryNames);
  try {
    const entries = await readdir(geminiDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !allowedDirs.has(entry.name)) continue;
      const convDir = join(geminiDir, entry.name, 'conversations');
      try {
        const convFiles = await readdir(convDir);
        const fileSet = new Set(convFiles);
        const dbFiles = convFiles.filter(f => f.endsWith('.db'));
        const batchSize = 32;
        for (let i = 0; i < dbFiles.length; i += batchSize) {
          const slice = dbFiles.slice(i, i + batchSize);
          await Promise.all(slice.map(async file => {
            const fullPath = join(convDir, file);
            try {
              const st = await lstat(fullPath);
              if (!st.isFile() || st.isSymbolicLink()) return;
              const wal = fileSet.has(file + '-wal') ? await lstat(fullPath + '-wal').catch(() => null) : null;
              const walMtimeMs = wal?.mtimeMs ?? 0;
              const walSize = wal?.size ?? 0;
              discoveredStats.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, walMtimeMs, walSize, at: now });
              list.push({ path: fullPath, mtime: Math.max(st.mtimeMs, walMtimeMs) });
            } catch (error) { issue(fullPath, error); }
          }));
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issue(convDir, error); }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issue(geminiDir, error); }

  // 检查归档库
  for (const dirName of dataDirectoryNames) {
    const archivePath = join(geminiDir, dirName, 'token_usage_archive.db');
    try {
      const st = await lstat(archivePath);
      if (st.isFile() && !st.isSymbolicLink()) {
        discoveredStats.set(archivePath, { mtimeMs: st.mtimeMs, size: st.size, walMtimeMs: 0, walSize: 0, at: now });
        list.push({ path: archivePath, mtime: st.mtimeMs });
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') issue(archivePath, error); }
  }

  list.sort((a, b) => b.mtime - a.mtime);
  return { paths: list.slice(0, maxFiles).map(x => x.path), errors, discoveredCount: list.length };
}

export async function blobRows(
  dbPath: string,
  table: 'gen_metadata' | 'steps',
  column: 'data' | 'metadata',
  where: string,
  onRows?: (rows: any[]) => void,
  knownIndex?: any[],
  signal?: AbortSignal,
  reader?: SqliteReadSnapshot
): Promise<{ ok: boolean; rows: any[]; error?: string }> {
  const index = knownIndex ? { ok: true, rows: knownIndex } : await querySqlite(dbPath, `SELECT idx, length(${column}) as size FROM ${table} WHERE ${where} ORDER BY idx;`, signal, reader);
  if (!index.ok) return index;
  const result: any[] = [];
  let batch: any[] = [], bytes = 0;
  const flush = async () => {
    signal?.throwIfAborted();
    if (!batch.length) return;
    const ids = batch.map(row => Number(row.idx)).filter(Number.isSafeInteger);
    if (ids.length !== batch.length) throw new Error('数据库记录索引格式不支持');
    const reply = await querySqlite(dbPath, `SELECT idx, length(${column}) as size, ${column} as data_blob FROM ${table} WHERE idx IN (${ids.join(',')}) ORDER BY idx;`, signal, reader);
    if (!reply.ok) throw new Error(reply.error);
    if (onRows) onRows(reply.rows); else result.push(...reply.rows);
    batch = []; bytes = 0;
  };
  try {
    for (const row of index.rows) {
      if (row.size > 16777216) {
        await flush();
        const projected = reader ? await reader.projectBlob(table, column, Number(row.idx)) : null;
        const value = projected?.ok ? projected.rows[0] : { ...row, data_hex: '' };
        if (onRows) onRows([value]); else result.push(value); continue;
      }
      if (batch.length >= 200 || (bytes + row.size > 2 * 1024 * 1024 && batch.length)) await flush();
      batch.push(row); bytes += Number(row.size) || 0;
    }
    await flush();
    result.sort((a, b) => Number(a.idx) - Number(b.idx));
    return { ok: true, rows: result };
  } catch (error) { return { ok: false, rows: [], error: (error as Error).message }; }
}

export function isTransientSqliteReadError(message = ''): boolean {
  return /跨批读取期间变化|busy|locked|no such table|连接已关闭|超出单批预算|unable to open/i.test(message);
}

export async function isInitializingOrRemovedDb(dbPath: string, errorMessage = ''): Promise<boolean> {
  const stat = await lstat(dbPath).catch((err: NodeJS.ErrnoException) => (err?.code === 'ENOENT' ? null : undefined));
  if (stat === null) return true;
  if (stat && /no such table/i.test(errorMessage) && (stat.size <= 4096 || Date.now() - stat.mtimeMs < 60_000)) {
    return true;
  }
  return false;
}

export async function scanDatabaseEvents(ctx: UsageScanContext, dbPath: string, bypassCache = false, signal?: AbortSignal): Promise<{
  events: GenerationEvent[];
  generationsScanned: number;
  skippedLargeRecords: number;
  hasError?: boolean;
  error?: string;
  usedCached?: boolean;
  cacheHit?: boolean;
}> {
  let lastResult = await scanDatabaseEventsOnce(ctx, dbPath, bypassCache, signal);
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!lastResult.hasError || signal?.aborted || !isTransientSqliteReadError(lastResult.error)) break;
    await new Promise(resolve => setTimeout(resolve, attempt * 100));
    if (signal?.aborted) break;
    lastResult = await scanDatabaseEventsOnce(ctx, dbPath, true, signal);
  }
  if (lastResult.hasError && !signal?.aborted && await isInitializingOrRemovedDb(dbPath, lastResult.error)) {
    const cached = ctx.fileCache.get(dbPath);
    return {
      events: cached?.events ?? [],
      generationsScanned: cached?.generationsScanned ?? 0,
      skippedLargeRecords: cached?.skippedLargeRecords ?? 0,
      hasError: false,
      usedCached: Boolean(cached),
    };
  }
  return lastResult;
}

async function scanDatabaseEventsOnce(ctx: UsageScanContext, dbPath: string, bypassCache = false, signal?: AbortSignal): Promise<{
  events: GenerationEvent[];
  generationsScanned: number;
  skippedLargeRecords: number;
  hasError?: boolean;
  error?: string;
  usedCached?: boolean;
  cacheHit?: boolean;
}> {
  let fileStat: any = null;
  let walStat: any = null;
  let sourceId = '';
  try {
    ctx.discoveredStats.delete(dbPath);
    fileStat = await lstat(dbPath);
    sourceId = createHash('sha256').update(JSON.stringify([basename(dbPath), fileStat.dev, fileStat.ino, fileStat.birthtimeMs])).digest('hex');
    try { walStat = await lstat(`${dbPath}-wal`); } catch {}
    if (!bypassCache) {
      const cached = ctx.fileCache.get(dbPath);
      if (
        cached && cached.events.every(event => event.source_id === sourceId) &&
        cached.mtimeMs === fileStat.mtimeMs &&
        cached.size === fileStat.size &&
        cached.walMtimeMs === (walStat?.mtimeMs ?? 0) &&
        cached.walSize === (walStat?.size ?? 0)
      ) {
        return {
          events: cached.events,
          generationsScanned: cached.generationsScanned,
          skippedLargeRecords: cached.skippedLargeRecords,
          hasError: cached.hasError ?? false, error: cached.error,
          cacheHit: true,
        };
      }
    }
  } catch {
    // ignore
  }

  const reader=new SqliteReadSnapshot(dbPath,signal);
  try {
  // 1. Read lengths first, then bounded binary batches without hexadecimal expansion.
  const genRes = await querySqlite(dbPath, 'SELECT idx, length(data) as size FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx;', signal, reader);

  if (!genRes.ok) {
    // 数据库损坏或查询失败：保留历史有效缓存并标记错误，绝不伪造成真实零
    const cached = ctx.fileCache.get(dbPath);
    if (cached) {
      return {
        events: cached.events,
        generationsScanned: cached.generationsScanned,
        skippedLargeRecords: cached.skippedLargeRecords,
        hasError: true,
        error: genRes.error, usedCached: true,
      };
    }
    return {
      events: [],
      generationsScanned: 0,
      skippedLargeRecords: 0,
      hasError: true,
      error: genRes.error,
    };
  }

  const genRows = genRes.rows;
  if (genRows.length > 50_000) {
    const cached = ctx.fileCache.get(dbPath);
    return { events: cached?.events ?? [], generationsScanned: 0, skippedLargeRecords: genRows.length,
      hasError: true, usedCached: !!cached, error: '单库生成记录超过有界读取预算；已保留已有账本，请分批归档后重试' };
  }
  const events: GenerationEvent[] = [];
  let generationsScanned = 0;
  let skippedLargeRecords = 0;
  if (genRows.length === 0) {
    if (fileStat) {
      ctx.setFileCacheEntry(dbPath, {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        walMtimeMs: walStat?.mtimeMs ?? 0,
        walSize: walStat?.size ?? 0,
        events: [],
        generationsScanned: 0,
        skippedLargeRecords: 0,
        hasError: false,
        lastSuccessAt: Math.floor(Date.now() / 1000),
      });
      ctx.markFileCacheDirty();
    }
    return { events: [], generationsScanned: 0, skippedLargeRecords: 0, hasError: false };
  }

  const validTimestamp=(value:number)=>Number.isSafeInteger(value)&&value>=946684800&&value<=Date.now()/1000+86400;
  const pendingStepLinks: { event: GenerationEvent; indices: number[]; execution: Buffer | null; usage: Buffer }[] = [];
  const parseRows = (rows: any[]) => {
    for (const row of rows) {
    generationsScanned++;
    if (row.size > 16 * 1024 * 1024 && !row.projected) {
      // Skip oversized blobs > 16MB
      skippedLargeRecords++;
      continue;
    }
    if (!row.data_blob && !row.data_hex) continue;

    const blob = row.data_blob instanceof Uint8Array ? Buffer.from(row.data_blob.buffer, row.data_blob.byteOffset, row.data_blob.byteLength) : Buffer.from(row.data_hex, 'hex');
    const wrapped = ProtobufReader.findField(blob, 1);
    if (!wrapped) continue;

    const modelId = ProtobufReader.findString(wrapped, 19);
    const label = ProtobufReader.findString(wrapped, 21);
    const usage = ProtobufReader.findField(wrapped, 4);

    if (!usage) continue;
    // ModelUsageStats field 1 is the model enum, not token usage.
    const cacheWriteTokens = ProtobufReader.findVarint(usage, 4) ?? 0;
    const rawInput = ProtobufReader.findVarint(usage, 2) ?? 0;
    const outputTokens = ProtobufReader.findVarint(usage, 3) ?? 0;
    const cachedTokens = ProtobufReader.findVarint(usage, 5) ?? 0;
    const inputTokens = rawInput;
    const totalTokens = inputTokens + cachedTokens + cacheWriteTokens + outputTokens;

    if (totalTokens === 0) continue;

    let timestamp = 0;
    const timingBuf = ProtobufReader.findField(wrapped, 9);
    if (timingBuf) {
      const innerTiming = ProtobufReader.findField(timingBuf, 4);
      if (innerTiming) {
        timestamp = ProtobufReader.findVarint(innerTiming, 1) ?? 0;
      }
    }
    if(!validTimestamp(timestamp))timestamp=0;

    const modelEnum = ProtobufReader.findVarint(wrapped, 3) ?? ProtobufReader.findVarint(usage, 1) ?? null;
    const assignedModel = resolveDatabaseModelFullName(modelId, label, modelEnum);
    const lockModelKey = modelId || label || '未知模型';

    // Only requests first observed after a positively observed identity can be attributed.
    // Unknown timestamps and pre-start history remain unknown, regardless of database mtime.
    const observedCtx = ctx.lookupObservedContext(timestamp);
    const canAttributeToCurrent = Boolean(observedCtx);
    const accountId = observedCtx?.id;
    const accountEmail = observedCtx?.email;
    const accountType = canAttributeToCurrent ? (observedCtx?.account_type ?? 'unknown') : undefined;
    const execution = ProtobufReader.findField(blob, 4)?.toString('hex') ?? '';
    const legacyKey = createHash('sha256').update(JSON.stringify([
      basename(dbPath), row.idx, execution || undefined, lockModelKey, rawInput, cachedTokens, cacheWriteTokens, outputTokens,
    ])).digest('hex');
    const eventObj: GenerationEvent = {
      event_key: createHash('sha256').update(JSON.stringify([
        sourceId, row.idx, execution,
      ])).digest('hex'),
      source_id: sourceId, generation_index: Number(row.idx), legacy_event_key: legacyKey,
      account_confidence: canAttributeToCurrent ? 'observed' : 'unknown',
      model: assignedModel,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cached_tokens: cachedTokens,
      ...(cacheWriteTokens>0?{cache_write_tokens:cacheWriteTokens}:{}),
      total_tokens: totalTokens,
      timestamp_seconds: timestamp,
      ...(accountId ? { account_id: accountId, account_email: accountEmail } : (accountEmail ? { account_email: accountEmail } : {})),
      ...(accountType ? { account_type: accountType } : {}),
    };
    if (timestamp === 0) {
      const indices = ProtobufReader.stepIndices(blob);
      if (indices !== null) {
        pendingStepLinks.push({ event: eventObj, indices, execution: ProtobufReader.findField(blob, 4), usage });
      }
    }
    events.push(eventObj);

  }
  };
  const dataRes = await blobRows(dbPath, 'gen_metadata', 'data', 'data IS NOT NULL', parseRows, genRows, signal, reader);
  if (!dataRes.ok) {
    const previous = ctx.fileCache.get(dbPath);
    return { events: previous?.events ?? events, generationsScanned, skippedLargeRecords, hasError: true, error: dataRes.error, usedCached: !!previous };
  }

  // 2. 仅当存在缺失内联时间戳的生成记录时，按需查询 steps 表（消除 99% 常规库的多余 PRAGMA + steps 查询）
  let stepOk = true;
  if (events.some(event => event.timestamp_seconds <= 0)) {
    const stepTimes=new Map<number,{timestamp:number;usage:Buffer|null;execution:Buffer|null}>();
    const stepSchema=await reader.query('PRAGMA table_info(steps);');
    const stepColumns=new Set(stepSchema.rows.map(row=>row.name));
    const stepRes = !stepSchema.ok || !['idx','metadata','step_type'].every(column=>stepColumns.has(column)) ? {ok:false,error:'时间表结构缺失或不支持',rows:[]} : await blobRows(dbPath, 'steps', 'metadata', 'step_type = 15', rows => {
      for (const row of rows) {
        const metaBuf = row.data_blob instanceof Uint8Array ? Buffer.from(row.data_blob.buffer, row.data_blob.byteOffset, row.data_blob.byteLength) : Buffer.from(row.data_hex || '', 'hex');
        const tsBuf = ProtobufReader.findField(metaBuf, 1);
        const rawTime=tsBuf?ProtobufReader.findVarint(tsBuf,1)??0:0;
        const timestamp=validTimestamp(rawTime)?rawTime:0;
        stepTimes.set(Number(row.idx),{timestamp,usage:ProtobufReader.findField(metaBuf,9),execution:ProtobufReader.findField(metaBuf,12)});
      }
    }, undefined, signal, reader);
    stepOk = stepRes.ok;
    if (stepRes.ok && pendingStepLinks.length > 0) {
      for (const item of pendingStepLinks) {
        const linked = item.indices.map(idx => stepTimes.get(idx)).filter((step): step is NonNullable<typeof step> => !!step);
        if (linked.length === 1 && item.execution && linked[0]!.execution?.equals(item.execution) && linked[0]!.usage?.equals(item.usage)) {
          item.event.timestamp_seconds = linked[0]!.timestamp;
          const obs = ctx.lookupObservedContext(item.event.timestamp_seconds);
          if (obs) {
            item.event.account_id = obs.id;
            item.event.account_email = obs.email;
            item.event.account_type = obs.account_type;
            item.event.account_confidence = 'observed';
          }
        }
      }
    }
  }

  const after = await lstat(dbPath).catch(() => null);
  if (!await reader.verifyUnchanged() || !after || after.dev !== fileStat?.dev || after.ino !== fileStat?.ino) {
    const previous = ctx.fileCache.get(dbPath);
    return { events: previous?.events ?? events, generationsScanned, skippedLargeRecords,
      hasError: true, usedCached: !!previous, error: '数据库在跨批读取期间变化，请重试' };
  }
  const observedAt = performance.timeOrigin + performance.now();
  for (const event of events) event.source_observed_at = observedAt;
  await ctx.loadUsageLedger();
  for (const event of events) {
    ctx.upsertLedger({ ...event, db_file: basename(dbPath) });
    Object.assign(event, ctx.getLedgerEvent(event.event_key!));
  }
  const unknownTime = events.some(event => event.timestamp_seconds <= 0);
  const hasError = !stepOk && unknownTime;
  const timeError = hasError ? '时间信息读取失败，部分记录时间未知' : undefined;
  if (fileStat) {
    ctx.setFileCacheEntry(dbPath, {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      walMtimeMs: walStat?.mtimeMs ?? 0,
      walSize: walStat?.size ?? 0,
      events,
      generationsScanned,
      skippedLargeRecords,
      hasError,
      error: timeError,
      lastSuccessAt: hasError ? ctx.fileCache.get(dbPath)?.lastSuccessAt : Math.floor(Date.now() / 1000),
    });
    if (!hasError) ctx.markFileCacheDirty();
  }

  return { events, generationsScanned, skippedLargeRecords, hasError, error: timeError };
  } finally { await reader.close(); }
}
