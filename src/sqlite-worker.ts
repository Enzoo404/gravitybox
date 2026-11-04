import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { projectProtobuf, GENERATION_PROJECTION, STEP_PROJECTION } from './protobuf-projection.js';
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

parentPort?.on('message', (request: { id: string; open?: string; sql?: string; close?: boolean; reusable?: boolean; projection?: {table:string;column:string;idx:number} }) => {
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
