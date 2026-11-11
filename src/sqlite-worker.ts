import { DatabaseSync } from 'node:sqlite';
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
  canIncremental?: {
    prevLastStepIdx: number;
    prevStepsCount: number;
    prevHeaderChecksum: string;
    prevSettledChecksum: string;
    prevLastGenIdx: number;
    prevGenChecksum: string;
    recheckStepIndices: number[];
    recheckGenIndices: number[];
  };
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
  trajectoryId?: string;
  metaBlobProjectedSlices: Uint8Array[];
  totalCount: number;
  maxIdx: number;
  headerChecksum: string;
  lastGenIdx: number;
  genChecksum: string;
  fullRescan: boolean;
  fullGenRescan: boolean;
  appendedSteps: HudWorkerRawStepRow[];
  recheckedSteps: HudWorkerRawStepRow[];
  genBlobs: Array<{ idx: number; data: Uint8Array }>;
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
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 250;');

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
    let trajectoryId = req.cachedTrajectoryId;
    const metaBlobProjectedSlices: Uint8Array[] = [];

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('trajectory_meta', 'trajectory_metadata_blob')")
      .all() as Array<{ name?: string }>;
    const tableSet = new Set(tables.map(t => String(t.name ?? '')));
    hasTrajectoryMeta = tableSet.has('trajectory_meta');
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
          .prepare('SELECT id, length(data) AS size FROM trajectory_metadata_blob WHERE data IS NOT NULL LIMIT 4')
          .all() as Array<{ id: string; size: number }>;
        if (tmbRows.length > 0) {
          hasParentMetadataBlob = true;
          const statement = db.prepare('SELECT substr(data, ?, ?) AS chunk FROM trajectory_metadata_blob WHERE id = ?');
          for (const r of tmbRows) {
            const projected = projectProtobuf(
              Number(r.size),
              (offset, length) => (statement.get(offset + 1, length, r.id) as { chunk?: Uint8Array } | undefined)?.chunk ?? new Uint8Array(0),
              { 5: true, 6: true }
            );
            const slice = detachBuf(projected.data);
            if (slice) metaBlobProjectedSlices.push(slice);
          }
        }
      } catch {
        parentMetaReadError = true;
      }
    }

    const summaryRow = db
      .prepare(
        `SELECT
          COUNT(*) AS totalCount,
          COALESCE(MAX(idx), -1) AS maxIdx,
          COALESCE(SUM((idx + 1) * step_type), 0) AS typeSum,
          COALESCE(SUM((idx + 1) * status), 0) AS statusSum,
          COALESCE(SUM((idx + 1) * COALESCE(length(metadata), 0)), 0) AS lenSum
        FROM steps`
      )
      .get() as { totalCount?: number; maxIdx?: number; typeSum?: number; statusSum?: number; lenSum?: number } | undefined;

    const totalCount = Number(summaryRow?.totalCount ?? 0);
    const maxIdx = Number(summaryRow?.maxIdx ?? -1);
    const headerChecksum = `${totalCount}:${maxIdx}:${Number(summaryRow?.typeSum ?? 0)}:${Number(summaryRow?.statusSum ?? 0)}:${Number(summaryRow?.lenSum ?? 0)}`;

    let lastGenIdx = -1;
    let genChecksum = '0:-1:0';
    let hasGenTable = false;
    try {
      const genSummary = db
        .prepare(
          `SELECT
            COUNT(*) AS genCount,
            COALESCE(MAX(idx), -1) AS maxGenIdx,
            COALESCE(SUM((idx + 1) * COALESCE(length(data), 0)), 0) AS genLenSum
          FROM gen_metadata WHERE data IS NOT NULL`
        )
        .get() as { genCount?: number; maxGenIdx?: number; genLenSum?: number } | undefined;
      hasGenTable = true;
      lastGenIdx = Number(genSummary?.maxGenIdx ?? -1);
      genChecksum = `${Number(genSummary?.genCount ?? 0)}:${lastGenIdx}:${Number(genSummary?.genLenSum ?? 0)}`;
    } catch {}

    const inc = req.canIncremental;
    // A writer may change settled metadata without changing its size, status or
    // index, even while appending rows. Header sums cannot prove immutability.
    // The caller already caches unchanged DB/WAL signatures; rebuild the small
    // field projection on every changed signature in this bounded worker.
    let fullRescan = true;
    if (inc) {
      if (totalCount < inc.prevStepsCount || maxIdx < inc.prevLastStepIdx) {
        fullRescan = true;
      } else if (
        maxIdx === inc.prevLastStepIdx &&
        totalCount === inc.prevStepsCount &&
        headerChecksum === inc.prevHeaderChecksum &&
        genChecksum === inc.prevGenChecksum &&
        inc.recheckStepIndices.length === 0 &&
        inc.recheckGenIndices.length === 0
      ) {
        // 文件/WAL 在磁盘发生变化，但行数与长度总和均未变且无待补全记录（如相同字节长度的原地改写），触发全量重扫
        fullRescan = true;
      } else if (inc.prevLastStepIdx >= 0) {
        const recheckFilter =
          inc.recheckStepIndices.length > 0
            ? `AND idx NOT IN (${inc.recheckStepIndices.filter(n => Number.isSafeInteger(n)).join(',')})`
            : '';
        const settledRow = db
          .prepare(
            `SELECT
              COUNT(*) AS cnt,
              COALESCE(SUM((idx + 1) * step_type), 0) AS typeSum,
              COALESCE(SUM((idx + 1) * status), 0) AS statusSum,
              COALESCE(SUM((idx + 1) * COALESCE(length(metadata), 0)), 0) AS lenSum
            FROM steps WHERE idx <= ? ${recheckFilter}`
          )
          .get(inc.prevLastStepIdx) as { cnt?: number; typeSum?: number; statusSum?: number; lenSum?: number } | undefined;
        const settledChecksum = `${Number(settledRow?.cnt ?? 0)}:${Number(settledRow?.typeSum ?? 0)}:${Number(settledRow?.statusSum ?? 0)}:${Number(settledRow?.lenSum ?? 0)}`;
        if (settledChecksum !== inc.prevSettledChecksum) {
          fullRescan = true;
        }
      }
    }

    const buildStepSelectColumns = (singleRow = false) => {
      const metaExpr = singleRow
        ? `CASE WHEN length(metadata) <= ${inlineLimit} THEN metadata ELSE NULL END as metadata, COALESCE(length(metadata), 0) as metadata_len`
        : `CASE WHEN step_type NOT IN (14, 23, 101) AND length(metadata) <= ${inlineLimit} THEN metadata ELSE NULL END as metadata, CASE WHEN step_type NOT IN (14, 23, 101) THEN COALESCE(length(metadata), 0) ELSE 0 END as metadata_len`;
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

    const projectStepMetaStmt = db.prepare('SELECT substr(metadata, ?, ?) AS chunk FROM steps WHERE idx = ?');
    const normalizeRawStep = (row: any): HudWorkerRawStepRow => {
      const idx = Number(row.idx);
      const metadataLen = Number(row.metadata_len ?? 0);
      let effectiveMeta: Uint8Array | null = row.metadata && row.metadata.byteLength > 0 ? detachBuf(row.metadata) : null;
      if (!effectiveMeta && Number.isSafeInteger(metadataLen) && metadataLen > inlineLimit) {
        try {
          const projected = projectProtobuf(
            metadataLen,
            (offset, length) => (projectStepMetaStmt.get(offset + 1, length, idx) as { chunk?: Uint8Array } | undefined)?.chunk ?? new Uint8Array(0),
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

    const startAfterIdx = fullRescan ? -1 : inc!.prevLastStepIdx;
    const appendedSteps: HudWorkerRawStepRow[] = [];
    if (fullRescan || maxIdx > startAfterIdx) {
      const rows = db
        .prepare(`SELECT ${buildStepSelectColumns(false)} FROM steps WHERE idx > ? ORDER BY idx ASC`)
        .all(startAfterIdx) as any[];
      for (const r of rows) {
        appendedSteps.push(normalizeRawStep(r));
      }
    }

    const recheckedSteps: HudWorkerRawStepRow[] = [];
    if (!fullRescan && inc && inc.recheckStepIndices.length > 0) {
      const singleStmt = db.prepare(`SELECT ${buildStepSelectColumns(true)} FROM steps WHERE idx = ? LIMIT 1`);
      for (const activeIdx of inc.recheckStepIndices) {
        const row = singleStmt.get(activeIdx) as any;
        if (row) {
          recheckedSteps.push(normalizeRawStep(row));
        }
      }
    }

    let fullGenRescan = fullRescan || !inc || lastGenIdx < inc.prevLastGenIdx || genChecksum !== inc.prevGenChecksum;
    const genBlobs: Array<{ idx: number; data: Uint8Array }> = [];
    if (hasGenTable && lastGenIdx >= 0) {
      const readGenBlob = (idx: number): Uint8Array | null => {
        const sizeRow = db
          .prepare('SELECT length(data) AS dataLen FROM gen_metadata WHERE idx = ? AND data IS NOT NULL LIMIT 1')
          .get(idx) as { dataLen?: number } | undefined;
        const dataLen = Number(sizeRow?.dataLen ?? 0);
        if (dataLen <= 0) return null;
        if (dataLen <= inlineLimit) {
          const row = db
            .prepare('SELECT data FROM gen_metadata WHERE idx = ? AND data IS NOT NULL LIMIT 1')
            .get(idx) as { data?: Uint8Array | null } | undefined;
          return detachBuf(row?.data);
        }
        try {
          const stmt = db.prepare('SELECT substr(data, ?, ?) AS chunk FROM gen_metadata WHERE idx = ?');
          const projected = projectProtobuf(
            dataLen,
            (offset, length) => (stmt.get(offset + 1, length, idx) as { chunk?: Uint8Array } | undefined)?.chunk ?? new Uint8Array(0),
            HUD_GEN_METADATA_PROJECTION
          );
          return detachBuf(projected.data);
        } catch {
          throw Error("HUD 请求元数据投影失败");
        }
      };

      if (fullGenRescan) {
        const genRows = db
          .prepare('SELECT idx FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx ASC')
          .all() as Array<{ idx: number }>;
        for (const r of genRows) {
          const idx = Number(r.idx);
          const blob = readGenBlob(idx);
          if (blob) genBlobs.push({ idx, data: blob });
        }
      } else if (inc) {
        const targetGenIndices = new Set<number>(inc.recheckGenIndices);
        const newGenRows = db
          .prepare('SELECT idx FROM gen_metadata WHERE data IS NOT NULL AND idx >= ? ORDER BY idx ASC')
          .all(inc.prevLastGenIdx) as Array<{ idx: number }>;
        for (const r of newGenRows) targetGenIndices.add(Number(r.idx));
        for (const idx of [...targetGenIndices].sort((a, b) => a - b)) {
          const blob = readGenBlob(idx);
          if (blob) genBlobs.push({ idx, data: blob });
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
        trajectoryId,
        metaBlobProjectedSlices,
        totalCount,
        maxIdx,
        headerChecksum,
        lastGenIdx,
        genChecksum,
        fullRescan,
        fullGenRescan,
        appendedSteps,
        recheckedSteps,
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

function openSession(path: string) {
  try { database?.exec('ROLLBACK;'); database?.close(); } catch {}
  database = undefined;
  sessionError = undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec('PRAGMA busy_timeout=1000; BEGIN;');
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

parentPort?.on('message', (request: { id: string; open?: string; sql?: string; close?: boolean; reusable?: boolean; projection?: {table:string;column:string;idx:number}; hudScan?: HudWorkerScanRequest }) => {
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
    if(request.projection){
      const {table,column,idx}=request.projection;
      if(!Number.isSafeInteger(idx)||!((table==='gen_metadata'&&column==='data')||(table==='steps'&&column==='metadata')))throw Error('元数据投影请求无效');
      const sizes=database.prepare(`SELECT length(${column}) AS size FROM ${table} WHERE idx=?`).all(idx);
      if(sizes.length!==1)throw Error('元数据索引不存在或不唯一');
      const statement=database.prepare(`SELECT substr(${column},?,?) AS chunk FROM ${table} WHERE idx=?`);
      const projected=projectProtobuf(Number(sizes[0]!.size),(offset,length)=>statement.get(offset+1,length,idx)!.chunk as Uint8Array,table==='gen_metadata'?GENERATION_PROJECTION:STEP_PROJECTION);
      // Small Buffers may share Node's non-transferable slab. Give IPC its own ArrayBuffer.
      rows=[{idx,size:sizes[0]!.size,data_blob:Uint8Array.from(projected.data),projected:true,projectionBytesRead:projected.bytesRead}];
    } else rows = database.prepare(request.sql!).all();
    const transfers = new Set<ArrayBuffer>();
    for (const row of rows) for (const value of Object.values(row)) {
      if (value instanceof Uint8Array && value.buffer instanceof ArrayBuffer) transfers.add(value.buffer);
    }
    parentPort?.postMessage({ id: request.id, ok: true, rows }, [...transfers]);
  } catch (error) { parentPort?.postMessage({ id: request.id, ok: false, rows: [], error: (error as Error).message }); }
});
