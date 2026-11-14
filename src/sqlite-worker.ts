import { DatabaseSync } from 'node:sqlite';
import { createHash, type Hash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import {
  projectProtobuf,
  GENERATION_PROJECTION,
  STEP_PROJECTION,
  HUD_STEP_METADATA_PROJECTION,
  HUD_GEN_METADATA_PROJECTION,
} from './protobuf-projection.js';

export interface HudWorkerScanRequest {
  dbPath: string;
  inlineBlobLimitBytes: number;
  knownColumns?: {
    hasDataColumn: boolean;
    hasRenderInfoColumn: boolean;
    hasStepPayloadColumn: boolean;
  };
  cachedTrajectoryId?: string;
  prevParentMetaDigest?: string;
  prevStepPrefixCutoffIdx?: number;
  prevStepPrefixDigest?: string;
  prevGenDigest?: string;
  prevGenPrefixCutoffIdx?: number;
  prevGenPrefixDigest?: string;
}

export interface HudWorkerRawStepRow {
  idx: number;
  step_type: number;
  status: number;
  metadata: Uint8Array | null;
  metadata_len: number;
  data?: Uint8Array | null;
  render_info?: Uint8Array | null;
  step_payload?: Uint8Array | null;
}

export interface HudWorkerScanResult {
  hasDataColumn: boolean;
  hasRenderInfoColumn: boolean;
  hasStepPayloadColumn: boolean;
  hasTrajectoryMeta: boolean;
  hasParentMetadataBlob: boolean;
  parentMetaReadError: boolean;
  parentMetaUnchanged: boolean;
  parentMetaDigest: string;
  trajectoryId?: string;
  metaBlobProjectedSlices: Uint8Array[];
  maxIdx: number;
  stepsMode: 'full' | 'append';
  stepPrefixCutoffIdx: number;
  stepPrefixDigest: string;
  appendedSteps: HudWorkerRawStepRow[];
  genMode: 'full' | 'append' | 'unchanged';
  lastGenIdx: number;
  genDigest: string;
  genPrefixCutoffIdx: number;
  genPrefixDigest: string;
  genBlobs: Array<{ idx: number; data: Uint8Array }>;
}

const TERMINAL_STEP_STATUSES = new Set([3, 5]);

function hashRawStepRow(hash: Hash, r: any): void {
  hash.update(`${r.idx}:${r.step_type}:${r.status}:${r.metadata_len ?? 0}:`);
  if (r.metadata && r.metadata.byteLength > 0) hash.update(r.metadata);
  hash.update(`:${r.data?.byteLength ?? 0}:`);
  if (r.data && r.data.byteLength > 0) hash.update(r.data);
  hash.update(`:${r.render_info?.byteLength ?? 0}:`);
  if (r.render_info && r.render_info.byteLength > 0) hash.update(r.render_info);
  hash.update(`:${r.step_payload?.byteLength ?? 0}:`);
  if (r.step_payload && r.step_payload.byteLength > 0) hash.update(r.step_payload);
  hash.update('\n');
}

function hashRawGenRow(hash: Hash, idx: number, dataLen: number, blob: Uint8Array | null | undefined): void {
  hash.update(`${idx}:${dataLen}:`);
  if (blob && blob.byteLength > 0) hash.update(blob);
  hash.update('\n');
}

function executeHudScan(req: HudWorkerScanRequest): { result: HudWorkerScanResult; transfers: ArrayBuffer[] } {
  const inlineLimit = req.inlineBlobLimitBytes || 65_536;
  const db = new DatabaseSync(req.dbPath, { readOnly: true });
  const transfers = new Set<ArrayBuffer>();
  const detachBuf = (u8: Uint8Array | null | undefined): Uint8Array | null => {
    if (!u8 || u8.byteLength === 0) return null;
    const copy = Uint8Array.from(u8);
    if (copy.buffer instanceof ArrayBuffer) transfers.add(copy.buffer);
    return copy;
  };

  try {
    // 单语句自动提交 (Auto-Commit)，严禁长事务 BEGIN，确保宿主 wal_checkpoint 零阻塞
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 800;');

    let hasDataColumn = req.knownColumns?.hasDataColumn;
    let hasRenderInfoColumn = req.knownColumns?.hasRenderInfoColumn;
    let hasStepPayloadColumn = req.knownColumns?.hasStepPayloadColumn;
    if (
      hasDataColumn === undefined ||
      hasRenderInfoColumn === undefined ||
      hasStepPayloadColumn === undefined
    ) {
      try {
        const cols = db.prepare('PRAGMA table_info(steps)').all() as Array<{ name?: string }>;
        const colSet = new Set(cols.map(c => String(c.name ?? '')));
        hasDataColumn = colSet.has('data');
        hasRenderInfoColumn = colSet.has('render_info');
        hasStepPayloadColumn = colSet.has('step_payload');
      } catch {
        hasDataColumn = false;
        hasRenderInfoColumn = false;
        hasStepPayloadColumn = false;
      }
    }

    let hasTrajectoryMeta = false;
    let hasParentMetadataBlob = false;
    let parentMetaReadError = false;
    let parentMetaUnchanged = false;
    let parentMetaDigest = '';
    let trajectoryId = req.cachedTrajectoryId;
    const metaBlobProjectedSlices: Uint8Array[] = [];

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('trajectory_meta', 'trajectory_metadata_blob', 'gen_metadata')")
      .all() as Array<{ name?: string }>;
    const tableSet = new Set(tables.map(t => String(t.name ?? '')));
    hasTrajectoryMeta = tableSet.has('trajectory_meta');
    const hasGenTable = tableSet.has('gen_metadata');
    if (hasTrajectoryMeta && !trajectoryId) {
      try {
        const tm = db
          .prepare('SELECT trajectory_id FROM trajectory_meta LIMIT 1')
          .get() as { trajectory_id?: string } | undefined;
        if (tm?.trajectory_id) {
          trajectoryId = String(tm.trajectory_id).toLowerCase();
        }
      } catch {}
    }

    if (tableSet.has('trajectory_metadata_blob')) {
      try {
        const tmbRows = db
          .prepare(
            `SELECT id, length(data) AS size, CASE WHEN length(data) <= ${inlineLimit} THEN data ELSE NULL END AS inlineData FROM trajectory_metadata_blob WHERE data IS NOT NULL ORDER BY id ASC LIMIT 4`
          )
          .all() as Array<{ id: string; size: number; inlineData: Uint8Array | null }>;
        if (tmbRows.length > 0) {
          hasParentMetadataBlob = true;
          let allInline = true;
          const pmHash = createHash('sha256');
          for (const r of tmbRows) {
            const sz = Number(r.size ?? 0);
            pmHash.update(`${r.id}:${sz}:`);
            if (r.inlineData && sz <= inlineLimit) {
              if (r.inlineData.byteLength > 0) pmHash.update(r.inlineData);
            } else if (sz > 0) {
              allInline = false;
            }
            pmHash.update('\n');
          }
          if (allInline) {
            parentMetaDigest = pmHash.digest('hex');
          }
          if (allInline && req.prevParentMetaDigest && parentMetaDigest === req.prevParentMetaDigest) {
            parentMetaUnchanged = true;
          } else {
            let chunkStmt: ReturnType<DatabaseSync['prepare']> | undefined;
            for (const r of tmbRows) {
              const sz = Number(r.size ?? 0);
              const inlineBuf = r.inlineData && sz <= inlineLimit ? r.inlineData : null;
              const projected = projectProtobuf(
                sz,
                (offset, length) => {
                  if (inlineBuf) return inlineBuf.subarray(offset, offset + length);
                  chunkStmt ??= db.prepare('SELECT substr(data, ?, ?) AS chunk FROM trajectory_metadata_blob WHERE id = ?');
                  return (chunkStmt.get(offset + 1, length, r.id) as { chunk?: Uint8Array } | undefined)?.chunk ?? new Uint8Array(0);
                },
                { 5: true, 6: true }
              );
              const slice = detachBuf(projected.data);
              if (slice) metaBlobProjectedSlices.push(slice);
            }
          }
        }
      } catch {
        parentMetaReadError = true;
      }
    }

    const buildStepSelectColumns = () => {
      const metaExpr = `CASE WHEN step_type NOT IN (14, 23, 101) AND length(metadata) <= ${inlineLimit} THEN metadata ELSE NULL END as metadata, CASE WHEN step_type NOT IN (14, 23, 101) THEN COALESCE(length(metadata), 0) ELSE 0 END as metadata_len`;
      const extraCols: string[] = [];
      if (hasDataColumn) {
        extraCols.push(`CASE WHEN step_type IN (127, 132) AND length(data) <= ${inlineLimit} THEN data ELSE NULL END as data`);
      }
      if (hasRenderInfoColumn) {
        extraCols.push(`CASE WHEN step_type IN (127, 132) AND length(render_info) <= ${inlineLimit} THEN render_info ELSE NULL END as render_info`);
      }
      if (hasStepPayloadColumn) {
        extraCols.push(`CASE WHEN step_type IN (127, 132) THEN substr(step_payload, 1, ${inlineLimit}) ELSE NULL END as step_payload`);
      }
      return ['idx', 'step_type', 'status', metaExpr, ...extraCols].join(', ');
    };

    const stepColumnsSql = buildStepSelectColumns();
    let projectStepMetaStmt: ReturnType<DatabaseSync['prepare']> | undefined;
    const canIncludeStepInPrefix = (row: any): boolean => {
      const st = Number(row.status);
      const metaLen = Number(row.metadata_len ?? 0);
      return TERMINAL_STEP_STATUSES.has(st) && metaLen <= inlineLimit;
    };
    const normalizeRawStep = (row: any): HudWorkerRawStepRow => {
      const idx = Number(row.idx);
      const metadataLen = Number(row.metadata_len ?? 0);
      let effectiveMeta: Uint8Array | null = row.metadata && row.metadata.byteLength > 0 ? detachBuf(row.metadata) : null;
      if (!effectiveMeta && Number.isSafeInteger(metadataLen) && metadataLen > inlineLimit) {
        try {
          projectStepMetaStmt ??= db.prepare('SELECT substr(metadata, ?, ?) AS chunk FROM steps WHERE idx = ?');
          const projected = projectProtobuf(
            metadataLen,
            (offset, length) => (projectStepMetaStmt!.get(offset + 1, length, idx) as { chunk?: Uint8Array } | undefined)?.chunk ?? new Uint8Array(0),
            HUD_STEP_METADATA_PROJECTION
          );
          effectiveMeta = detachBuf(projected.data);
        } catch {
          throw Error("HUD 步骤元数据投影失败");
        }
      }
      return {
        idx,
        step_type: Number(row.step_type),
        status: Number(row.status),
        metadata: effectiveMeta,
        metadata_len: metadataLen,
        data: detachBuf(row.data),
        render_info: detachBuf(row.render_info),
        step_payload: detachBuf(row.step_payload),
      };
    };

    let stepsMode: 'full' | 'append' = 'full';
    let stepPrefixCutoffIdx = -1;
    let stepPrefixDigest = '';
    let maxIdx = -1;
    const appendedSteps: HudWorkerRawStepRow[] = [];

    if (
      req.prevStepPrefixCutoffIdx !== undefined &&
      req.prevStepPrefixCutoffIdx >= 0 &&
      req.prevStepPrefixDigest
    ) {
      const prefixHasher = createHash('sha256');
      let prefixRowCount = 0;
      let prefixMaxIdx = -1;
      let prefixAllInline = true;
      for (const r of db
        .prepare(`SELECT ${stepColumnsSql} FROM steps WHERE idx < ? ORDER BY idx ASC`)
        .iterate(req.prevStepPrefixCutoffIdx) as Iterable<any>) {
        if (!canIncludeStepInPrefix(r)) {
          prefixAllInline = false;
          break;
        }
        hashRawStepRow(prefixHasher, r);
        prefixRowCount++;
        prefixMaxIdx = Number(r.idx);
      }
      if (
        prefixAllInline &&
        prefixRowCount > 0 &&
        prefixHasher.copy().digest('hex') === req.prevStepPrefixDigest
      ) {
        stepsMode = 'append';
        const tailRows = db
          .prepare(`SELECT ${stepColumnsSql} FROM steps WHERE idx >= ? ORDER BY idx ASC`)
          .all(req.prevStepPrefixCutoffIdx) as any[];
        maxIdx = tailRows.length > 0 ? Number(tailRows[tailRows.length - 1]!.idx) : prefixMaxIdx;
        let advanceCount = 0;
        while (advanceCount < tailRows.length - 2 && canIncludeStepInPrefix(tailRows[advanceCount])) {
          hashRawStepRow(prefixHasher, tailRows[advanceCount]);
          advanceCount++;
        }
        if (advanceCount > 0) {
          stepPrefixCutoffIdx = Number(tailRows[advanceCount]!.idx);
          stepPrefixDigest = prefixHasher.digest('hex');
        } else {
          stepPrefixCutoffIdx = req.prevStepPrefixCutoffIdx;
          stepPrefixDigest = req.prevStepPrefixDigest;
        }
        for (const r of tailRows) {
          appendedSteps.push(normalizeRawStep(r));
        }
      }
    }

    if (stepsMode === 'full') {
      const rows = db
        .prepare(`SELECT ${stepColumnsSql} FROM steps ORDER BY idx ASC`)
        .all() as any[];
      maxIdx = rows.length > 0 ? Number(rows[rows.length - 1]!.idx) : -1;
      let prefixEnd = 0;
      const prefixHasher = createHash('sha256');
      while (prefixEnd < rows.length - 2 && canIncludeStepInPrefix(rows[prefixEnd])) {
        hashRawStepRow(prefixHasher, rows[prefixEnd]);
        prefixEnd++;
      }
      if (prefixEnd > 0) {
        stepPrefixCutoffIdx = Number(rows[prefixEnd]!.idx);
        stepPrefixDigest = prefixHasher.digest('hex');
      }
      for (const r of rows) {
        appendedSteps.push(normalizeRawStep(r));
      }
    }

    let genMode: 'full' | 'append' | 'unchanged' = 'full';
    let lastGenIdx = -1;
    let genDigest = '';
    let genPrefixCutoffIdx = -1;
    let genPrefixDigest = '';
    const genBlobs: Array<{ idx: number; data: Uint8Array }> = [];

    if (hasGenTable) {
      let chunkStmt: ReturnType<DatabaseSync['prepare']> | undefined;
      const resolveRawGenBlob = (idx: number, dataLen: number, inlineData: Uint8Array | null | undefined): Uint8Array | null => {
        if (dataLen <= 0) return null;
        if (dataLen <= inlineLimit) {
          return inlineData && inlineData.byteLength > 0 ? inlineData : null;
        }
        try {
          chunkStmt ??= db.prepare('SELECT substr(data, ?, ?) AS chunk FROM gen_metadata WHERE idx = ?');
          const projected = projectProtobuf(
            dataLen,
            (offset, length) => (chunkStmt!.get(offset + 1, length, idx) as { chunk?: Uint8Array } | undefined)?.chunk ?? new Uint8Array(0),
            HUD_GEN_METADATA_PROJECTION
          );
          return projected.data;
        } catch {
          throw Error("HUD 请求元数据投影失败");
        }
      };

      const genColsSql = `idx, length(data) AS dataLen, CASE WHEN length(data) <= ${inlineLimit} THEN data ELSE NULL END AS inlineData`;
      let usedIncrementalGen = false;

      if (
        req.prevGenPrefixCutoffIdx !== undefined &&
        req.prevGenPrefixCutoffIdx >= 0 &&
        req.prevGenPrefixDigest
      ) {
        const genPrefixHasher = createHash('sha256');
        let prefixGenCount = 0;
        let prefixMaxGenIdx = -1;
        let prefixAllInline = true;
        for (const r of db
          .prepare(`SELECT ${genColsSql} FROM gen_metadata WHERE data IS NOT NULL AND idx < ? ORDER BY idx ASC`)
          .iterate(req.prevGenPrefixCutoffIdx) as Iterable<any>) {
          const idx = Number(r.idx);
          const dataLen = Number(r.dataLen ?? 0);
          if (dataLen > inlineLimit) {
            prefixAllInline = false;
            break;
          }
          hashRawGenRow(genPrefixHasher, idx, dataLen, r.inlineData);
          prefixGenCount++;
          prefixMaxGenIdx = idx;
        }
        if (
          prefixAllInline &&
          prefixGenCount > 0 &&
          genPrefixHasher.copy().digest('hex') === req.prevGenPrefixDigest
        ) {
          usedIncrementalGen = true;
          const tailGenRows = db
            .prepare(`SELECT ${genColsSql} FROM gen_metadata WHERE data IS NOT NULL AND idx >= ? ORDER BY idx ASC`)
            .all(req.prevGenPrefixCutoffIdx) as any[];
          lastGenIdx = tailGenRows.length > 0 ? Number(tailGenRows[tailGenRows.length - 1]!.idx) : prefixMaxGenIdx;
          const fullGenHasher = genPrefixHasher.copy();
          const resolvedTail: Array<{ idx: number; dataLen: number; rawBlob: Uint8Array | null }> = [];
          for (const r of tailGenRows) {
            const idx = Number(r.idx);
            const dataLen = Number(r.dataLen ?? 0);
            const rawBlob = resolveRawGenBlob(idx, dataLen, r.inlineData);
            hashRawGenRow(fullGenHasher, idx, dataLen, rawBlob);
            resolvedTail.push({ idx, dataLen, rawBlob });
          }
          genDigest = fullGenHasher.digest('hex');
          let advanceGen = 0;
          while (advanceGen < resolvedTail.length - 1 && resolvedTail[advanceGen]!.dataLen <= inlineLimit) {
            const item = resolvedTail[advanceGen]!;
            hashRawGenRow(genPrefixHasher, item.idx, item.dataLen, item.rawBlob);
            advanceGen++;
          }
          if (advanceGen > 0) {
            genPrefixCutoffIdx = resolvedTail[advanceGen]!.idx;
            genPrefixDigest = genPrefixHasher.digest('hex');
          } else {
            genPrefixCutoffIdx = req.prevGenPrefixCutoffIdx;
            genPrefixDigest = req.prevGenPrefixDigest;
          }
          if (req.prevGenDigest && genDigest === req.prevGenDigest) {
            genMode = 'unchanged';
          } else {
            genMode = 'append';
            for (const item of resolvedTail) {
              const detached = detachBuf(item.rawBlob);
              if (detached) genBlobs.push({ idx: item.idx, data: detached });
            }
          }
        }
      }

      if (!usedIncrementalGen) {
        const allGenRows = db
          .prepare(`SELECT ${genColsSql} FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx ASC`)
          .all() as any[];
        lastGenIdx = allGenRows.length > 0 ? Number(allGenRows[allGenRows.length - 1]!.idx) : -1;
        const fullGenHasher = createHash('sha256');
        const prefixGenHasher = createHash('sha256');
        const resolvedAll: Array<{ idx: number; dataLen: number; rawBlob: Uint8Array | null }> = [];
        for (const r of allGenRows) {
          const idx = Number(r.idx);
          const dataLen = Number(r.dataLen ?? 0);
          const rawBlob = resolveRawGenBlob(idx, dataLen, r.inlineData);
          hashRawGenRow(fullGenHasher, idx, dataLen, rawBlob);
          resolvedAll.push({ idx, dataLen, rawBlob });
        }
        genDigest = fullGenHasher.digest('hex');
        let prefixEnd = 0;
        while (prefixEnd < resolvedAll.length - 1 && resolvedAll[prefixEnd]!.dataLen <= inlineLimit) {
          const item = resolvedAll[prefixEnd]!;
          hashRawGenRow(prefixGenHasher, item.idx, item.dataLen, item.rawBlob);
          prefixEnd++;
        }
        if (prefixEnd > 0) {
          genPrefixCutoffIdx = resolvedAll[prefixEnd]!.idx;
          genPrefixDigest = prefixGenHasher.digest('hex');
        }
        if (req.prevGenDigest !== undefined && genDigest === req.prevGenDigest) {
          genMode = 'unchanged';
        } else {
          genMode = 'full';
          for (const item of resolvedAll) {
            const detached = detachBuf(item.rawBlob);
            if (detached) genBlobs.push({ idx: item.idx, data: detached });
          }
        }
      }
    }

    return {
      result: {
        hasDataColumn: Boolean(hasDataColumn),
        hasRenderInfoColumn: Boolean(hasRenderInfoColumn),
        hasStepPayloadColumn: Boolean(hasStepPayloadColumn),
        hasTrajectoryMeta,
        hasParentMetadataBlob,
        parentMetaReadError,
        parentMetaUnchanged,
        parentMetaDigest,
        trajectoryId,
        metaBlobProjectedSlices,
        maxIdx,
        stepsMode,
        stepPrefixCutoffIdx,
        stepPrefixDigest,
        appendedSteps,
        genMode,
        lastGenIdx,
        genDigest,
        genPrefixCutoffIdx,
        genPrefixDigest,
        genBlobs,
      },
      transfers: [...transfers],
    };
  } finally {
    try {
      db.close();
    } catch {}
  }
}
// The bundled SQLite supports closed WAL databases that the older system CLI cannot open.
// readOnly protects database contents; SQLite manages its own read coordination sidecars.
let database: DatabaseSync | undefined;
let sessionError: string | undefined;
let sessionDataVersion = 0;

function openSession(path: string) {
  try { database?.exec('ROLLBACK;'); database?.close(); } catch {}
  database = undefined;
  sessionError = undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250;');
    sessionDataVersion = Number(database.prepare('PRAGMA data_version').get()?.data_version);
  } catch (error) {
    sessionError = (error as Error).message;
  }
}

function closeSession() {
  try { database?.exec('ROLLBACK;'); database?.close(); } catch {}
  database = undefined;
  sessionError = undefined;
}

if (typeof workerData?.path === 'string' && workerData.path.length > 0) {
  openSession(workerData.path);
}

parentPort?.on('message', (request: { id: string; open?: string; sql?: string; verify?: boolean; close?: boolean; reusable?: boolean; projection?: {table:string;column:string;idx:number}; hudScan?: HudWorkerScanRequest }) => {
  if (request.hudScan) {
    try {
      const { result, transfers } = executeHudScan(request.hudScan);
      parentPort?.postMessage({ id: request.id, ok: true, hudResult: result }, transfers);
    } catch (error) {
      parentPort?.postMessage({ id: request.id, ok: false, error: (error as Error).message });
    }
    return;
  }
  if (typeof request.open === 'string') {
    openSession(request.open);
    return;
  }
  if (request.close) {
    closeSession();
    if (request.reusable) {
      parentPort?.postMessage({ id: request.id, closed: true });
    } else {
      parentPort?.close();
    }
    return;
  }
  if (sessionError || !database) {
    parentPort?.postMessage({ id: request.id, ok: false, rows: [], error: sessionError || 'SQLite 读取连接已关闭' });
    return;
  }
  try {
    let rows: Record<string,any>[];
    if (request.verify) {
      const unchanged = sessionDataVersion === Number(database.prepare('PRAGMA data_version').get()?.data_version);
      parentPort?.postMessage({ id: request.id, ok: unchanged, rows: [], ...(unchanged ? {} : { error: '数据库在读取期间变化，请重试' }) });
      return;
    }
    if(request.projection){
      database.exec('BEGIN;');
      try {
      const {table,column,idx}=request.projection;
      if(!Number.isSafeInteger(idx)||!((table==='gen_metadata'&&column==='data')||(table==='steps'&&column==='metadata')))throw Error('元数据投影请求无效');
      const sizes=database.prepare(`SELECT length(${column}) AS size FROM ${table} WHERE idx=?`).all(idx);
      if(sizes.length!==1)throw Error('元数据索引不存在或不唯一');
      const statement=database.prepare(`SELECT substr(${column},?,?) AS chunk FROM ${table} WHERE idx=?`);
      const projected=projectProtobuf(Number(sizes[0]!.size),(offset,length)=>statement.get(offset+1,length,idx)!.chunk as Uint8Array,table==='gen_metadata'?GENERATION_PROJECTION:STEP_PROJECTION);
      // Small Buffers may share Node's non-transferable slab. Give IPC its own ArrayBuffer.
      rows=[{idx,size:sizes[0]!.size,data_blob:Uint8Array.from(projected.data),projected:true,projectionBytesRead:projected.bytesRead}];
      } finally { database.exec('ROLLBACK;'); }
    } else rows = database.prepare(request.sql!).all();
    const transfers = new Set<ArrayBuffer>();
    for (const row of rows) for (const value of Object.values(row)) {
      if (value instanceof Uint8Array && value.buffer instanceof ArrayBuffer) transfers.add(value.buffer);
    }
    parentPort?.postMessage({ id: request.id, ok: true, rows }, [...transfers]);
  } catch (error) { parentPort?.postMessage({ id: request.id, ok: false, rows: [], error: (error as Error).message }); }
});
