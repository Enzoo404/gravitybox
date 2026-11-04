import { open, lstat, unlink, mkdir, readFile } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AtomicWriteOptions {
  durability?: 'strict' | 'relaxed';
}

/** Write completely before committing; cancellation and rename share one event-loop turn. */
export async function atomicText(path: string, text: string, signal?: AbortSignal, options?: AtomicWriteOptions): Promise<void> {
  const strict = options?.durability !== 'relaxed';
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error('拒绝覆盖非本用户的普通文件');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    signal?.throwIfAborted();
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(text);
      // fsync the payload before the rename: rename is atomic for the namespace, not for the data.
      if (strict) await handle.sync();
    } finally { await handle.close(); }
    signal?.throwIfAborted();
    renameSync(temp, path);
    if (strict) {
      // Persist the directory entry as well, otherwise a power loss can roll the rename back.
      const dir = await open(dirname(path), 'r').catch(() => null);
      if (dir) { try { await dir.sync(); } catch { /* filesystems without directory fsync */ } finally { await dir.close(); } }
    }
  } finally { await unlink(temp).catch(() => {}); }
}

export async function atomicJson(path: string, value: unknown, signal?: AbortSignal, options?: AtomicWriteOptions): Promise<void> {
  await atomicText(path, JSON.stringify(value, null, 2) + '\n', signal, options);
}

type FileChange = { path: string; before: string | null; after: string | null };
/** A recoverable file-set transaction. Caller holds the accounts write lease. */
export async function recoverFileSet(journalPath: string, allowedPaths: string[]): Promise<void> {
  const raw = await readOptional(journalPath);
  if (raw === null) return;
  const changes = JSON.parse(raw).changes as FileChange[];
  if (!Array.isArray(changes) || !changes.length || changes.some(change =>
    !allowedPaths.includes(change.path) || ![change.before, change.after].every(value => value === null || typeof value === 'string')))
    throw new Error('账号删除恢复记录无效，原件已保留');
  for (const change of changes) {
    const current = await readOptional(change.path);
    if (current !== change.before && current !== change.after) throw new Error('账号删除文件已被其他程序修改，恢复材料已保留');
  }
  for (const change of changes) {
    if (await readOptional(change.path) === change.after) continue;
    if (change.after === null) await unlink(change.path);
    else await atomicText(change.path, change.after);
  }
  await unlink(journalPath);
}

export async function commitFileSet(journalPath: string, values: { path: string; after: string | null }[]): Promise<void> {
  const changes: FileChange[] = [];
  for (const value of values) {
    const info = await lstat(value.path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.())) throw new Error('账号删除文件身份不匹配');
    changes.push({ ...value, before: await readOptional(value.path) });
  }
  await atomicJson(journalPath, { schema: 1, changes });
  // A crash is completed forward by init; errors retain the journal rather than claiming failure rolled back.
  try { await recoverFileSet(journalPath, changes.map(change => change.path)); }
  catch { throw new Error('账号移除尚未完成，恢复材料已保留；请重新读取账号完成对账'); }
}

type AccountCommit = { accountPath:string; indexPath:string; beforeAccount:string|null; beforeIndex:string|null; afterAccount:string; afterIndex:string };
async function readOptional(path:string) {try{return await readFile(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
async function restoreCommit(record:AccountCommit, forward:boolean) {
  for(const [path,before,after] of [[record.accountPath,record.beforeAccount,record.afterAccount],[record.indexPath,record.beforeIndex,record.afterIndex]] as const) {
    const current=await readOptional(path);
    if(current!==before&&current!==after)throw Error('账号提交文件已被其他程序修改，恢复材料已保留');
  }
  for(const [path,value] of [[record.accountPath,forward?record.afterAccount:record.beforeAccount],[record.indexPath,forward?record.afterIndex:record.beforeIndex]] as const) {
    if(await readOptional(path)===value)continue;
    if(value===null)await unlink(path);else await atomicText(path,value);
  }
}
/** Called under the account write lease before reading the index. */
export async function recoverAccountCommit(indexPath:string):Promise<void> {
  const journalPath=indexPath+'.commit.json',raw=await readOptional(journalPath);if(raw===null)return;
  const record=JSON.parse(raw) as AccountCommit;
  if(record.indexPath!==indexPath||dirname(record.accountPath)!==join(dirname(indexPath),'accounts')||!record.accountPath.endsWith('.json'))throw Error('账号提交恢复记录无效');
  await restoreCommit(record,true);await unlink(journalPath);
}
/** Journal before either replacement; errors roll back, crashes are reconciled before reads. */
export async function commitAccountAndIndex(accountPath:string,accountData:unknown,indexPath:string,indexData:unknown,signal?:AbortSignal):Promise<void> {
  await mkdir(dirname(accountPath),{recursive:true,mode:0o700});
  await mkdir(dirname(indexPath),{recursive:true,mode:0o700});
  for(const target of [accountPath,indexPath]) {
    try {const info=await lstat(target);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid?.())throw Error('拒绝覆盖非本用户的普通文件');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  const journalPath=indexPath+'.commit.json';
  const record:AccountCommit={accountPath,indexPath,beforeAccount:await readOptional(accountPath),beforeIndex:await readOptional(indexPath),afterAccount:JSON.stringify(accountData,null,2)+'\n',afterIndex:JSON.stringify(indexData,null,2)+'\n'};
  signal?.throwIfAborted();await atomicJson(journalPath,record,signal);
  try {
    signal?.throwIfAborted();await atomicText(accountPath,record.afterAccount);await atomicText(indexPath,record.afterIndex);await unlink(journalPath);
  } catch(error) {
    try {await restoreCommit(record,false);await unlink(journalPath);}catch{throw Error('账号提交未完成，恢复材料已保留；请重新读取账号以恢复');}
    throw error;
  }
}


const REDACTED_KEY = '[REDACTED_API_KEY]';
const REDACTED_TOKEN = '[REDACTED_TOKEN]';
const SECRET_SENTINEL = (index: number) => `\u0000${index}\u0000`;

export function sanitizeError(msg: string, secrets: (string | undefined | null)[] = []): string {
  let cleaned = String(msg ?? '');
  const values = secrets.filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);
  const unique = [...new Set(values)].sort((a, b) => b.length - a.length);
  unique.forEach((secret, index) => { cleaned = cleaned.split(secret).join(SECRET_SENTINEL(index)); });
  cleaned = cleaned.replace(/\b((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic|digest|token)\s+[^\s,;]+/gi, `$1${REDACTED_TOKEN}`);
  cleaned = cleaned.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, `$1 ${REDACTED_TOKEN}`);
  cleaned = cleaned.replace(/(\bhttps?:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi, `$1${REDACTED_KEY}$3`);
  cleaned = cleaned.replace(/\b(?:sk-[A-Za-z0-9_-]{4,}|AIza[A-Za-z0-9_-]{4,}|ya29\.[A-Za-z0-9._-]+|gh[pousr]_[A-Za-z0-9]{4,}|xox[baprs]-[A-Za-z0-9-]{4,}|AKIA[0-9A-Z]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, REDACTED_KEY);
  cleaned = cleaned.replace(/\u0000(\d+)\u0000/g, REDACTED_KEY);
  return cleaned.length > 300 ? `${cleaned.slice(0, 300)}...` : cleaned;
}
