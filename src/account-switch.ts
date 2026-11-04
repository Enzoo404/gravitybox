import { type ApplicationChannel, type ApplicationTarget, allApplicationTargets, applicationTarget, channelStateDirectory } from './application-target.js';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, lstat, open, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { atomicJson, atomicText } from './files.js';
import { AccountsManager, SystemKeychainAdapter, syncAccountToKeychain, type KeychainAdapter, type Account } from './accounts.js';
import { ProtobufWriter as Writer } from './usage.js';
import { replaceTopicRow } from './account-state.js';
export { replaceTopicRow } from './account-state.js';

const run = promisify(execFile);
const TOKEN = 'antigravityUnifiedStateSync.oauthToken';
const USER = 'antigravityUnifiedStateSync.userStatus';
const INIT = 'jetskiStateSync.agentManagerInitState';
const PROJECT = 'antigravityUnifiedStateSync.enterprisePreferences';
const KEYS = [TOKEN, USER, INIT, PROJECT, 'antigravityOnboarding'];
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
type Rows = Record<string, string>;
type SavedFile = { path: string; before: string; after: string; afterDigest?: string };
type Journal = {
  version: 1;
  status: string;
  before: Rows;
  after: Rows;
  afterDigest?: string;
  files: SavedFile[];
  keychainBefore: string | null;
  keychainAfter: string;
  keychainAfterDigest?: string;
  at: string;
};

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
function rowsDigest(rows: Rows): string {
  return sha256(JSON.stringify(Object.entries(rows || {}).sort()));
}

// sqlite3 stays in BEGIN IMMEDIATE while the other resources are committed. SQL goes through
// stdin, so neither tokens nor database values appear in command arguments or diagnostics.
class DatabaseTransaction {
  private child;
  private output = '';
  private pending?: { marker: string; resolve: (s: string) => void; reject: (e: Error) => void };
  private failed = false;
  constructor(path: string) {
    this.child = spawn('/usr/bin/sqlite3', ['-batch', '-bail', path], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => this.fail());
    this.child.stderr.on('data', () => this.fail());
    this.child.on('error', () => this.fail());
    this.child.on('exit', () => this.fail());
    this.child.stdout.on('data', chunk => {
      this.output += chunk.toString();
      if (this.output.length > 4_000_000) return this.fail();
      const marker = this.pending?.marker;
      if (marker && this.output.includes(marker)) {
        const reply = this.output.slice(0, this.output.indexOf(marker)).trim();
        this.output = this.output.slice(this.output.indexOf(marker) + marker.length).trimStart();
        const pending = this.pending!; this.pending = undefined; pending.resolve(reply);
      }
    });
  }
  private fail() { this.failed = true; this.pending?.reject(new Error('登录数据库操作失败，未提交数据库事务')); this.pending = undefined; }
  async sql(sql: string): Promise<string> {
    if (this.failed) throw new Error('登录数据库连接已关闭');
    const marker = `GB_${randomUUID()}`;
    const response = new Promise<string>((resolve, reject) => { this.pending = { marker, resolve, reject }; });
    this.child.stdin.write(`${sql}\n.print ${marker}\n`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([response, new Promise<never>((_, reject) => { timer = setTimeout(() => { this.child.kill(); reject(new Error('登录数据库繁忙，请稍后重试')); }, 6000); })]); }
    finally { clearTimeout(timer); }
  }
  async begin() { await this.sql('.timeout 3000\n.mode json\nBEGIN IMMEDIATE;'); }
  async rows(): Promise<Rows> {
    const raw = await this.sql(`SELECT key,value FROM ItemTable WHERE key IN (${KEYS.map(quote).join(',')});`);
    return Object.fromEntries((JSON.parse(raw || '[]') as { key: string; value: string }[]).map(r => [r.key, r.value]));
  }
  async replace(rows: Rows) {
    await this.sql(`DELETE FROM ItemTable WHERE key IN (${KEYS.map(quote).join(',')});\n${Object.entries(rows).map(([k, v]) => `INSERT INTO ItemTable(key,value) VALUES(${quote(k)},${quote(v)});`).join('\n')}`);
  }
  async finish(commit: boolean) { try { await this.sql(commit ? 'COMMIT;' : 'ROLLBACK;'); } finally { this.child.stdin.end(); } }
  close() { this.child.stdin.end(); }
}


function nextRows(before: Rows, acc: Account): Rows {
  const token = acc.token;
  const personal = /@(gmail|outlook|hotmail|qq|163)\.com$/i.test(acc.email);
  const payload = Buffer.concat([
    Writer.encodeString(1, token.access_token), Writer.encodeString(2, 'Bearer'), Writer.encodeString(3, token.refresh_token),
    Writer.encodeLengthDelimited(4, Buffer.concat([Writer.encodeVarintField(1, token.expiry_timestamp), Writer.encodeVarintField(2, 0)])),
    ...(token.id_token ? [Writer.encodeString(5, token.id_token)] : []),
    Writer.encodeVarintField(6, !personal && token.is_gcp_tos ? 1 : 0),
  ]);
  const after: Rows = { ...before,
    [TOKEN]: replaceTopicRow(before[TOKEN], 'oauthTokenInfoSentinelKey', payload),
    [USER]: replaceTopicRow(undefined, 'userStatusSentinelKey', Buffer.concat([Writer.encodeString(3, acc.name || acc.email), Writer.encodeString(7, acc.email)])),
    antigravityOnboarding: 'true',
  };
  // Enterprise preferences may contain unrelated rows; preserve them when updating a project.
  // Personal accounts have no project row at all, so the correct move is to drop it rather than
  // block the switch (a personal-target switch used to fail permanently here).
  if (token.project_id) after[PROJECT] = replaceTopicRow(before[PROJECT], 'enterpriseGcpProjectId', Writer.encodeString(3, token.project_id));
  else delete after[PROJECT];
  delete after[INIT];
  return after;
}

function sanitizeJournalRows(rows: Rows): Rows {
  const result: Rows = {};
  for (const [k, v] of Object.entries(rows || {})) {
    if (k === TOKEN || k.toLowerCase().includes('token') || k.toLowerCase().includes('oauth')) {
      result[k] = '[REDACTED_OAUTH_TOKEN]';
    } else {
      result[k] = v;
    }
  }
  return result;
}

function sanitizeJournalFiles(files: SavedFile[]): SavedFile[] {
  return (files || []).map(f => {
    const isAccountFile = f.path.includes('/accounts/') || (!f.path.endsWith('accounts.json') && f.path.endsWith('.json'));
    if (isAccountFile) {
      return {
        path: f.path,
        before: '[REDACTED_ACCOUNT]',
        after: '[REDACTED_ACCOUNT]',
      };
    }
    return f;
  });
}

export class AccountSwitchService {
  private keychain: KeychainAdapter;
  private journalPath: string;
  private target: ApplicationTarget;
  constructor(private manager: AccountsManager, private options: {
    stateDir: string; profile: string; externalDir: string; keychain?: KeychainAdapter; channel?: ApplicationChannel; target?: ApplicationTarget;
    isRunning?: () => Promise<boolean>; // Isolated tests only; never accepted over IPC.
  }) {
    this.keychain = options.keychain ?? new SystemKeychainAdapter();
    this.target = options.target ?? applicationTarget(options.channel ?? 'stable', undefined, { profile: options.profile });
    this.journalPath = join(channelStateDirectory(options.stateDir, this.target.channel), 'account-switch-journal.json');
  }

  setTarget(target: ApplicationTarget) {
    this.target = target;
    this.options.channel = target.channel;
    this.options.profile = target.profile;
    this.journalPath = join(channelStateDirectory(this.options.stateDir, target.channel), 'account-switch-journal.json');
  }

  private assertSupported() {}
  private async guardStopped() {
    const candidatePrefixes = Array.from(
      new Set([this.target.appPath, ...allApplicationTargets().map(t => t.appPath)]),
    ).map(p => p + '/Contents/');
    const running = this.options.isRunning ? await this.options.isRunning() :
      (await run('/bin/ps', ['-ax', '-o', 'args='])).stdout.split('\n').some(line => {
        const trimmed = line.trim();
        return candidatePrefixes.some(prefix => trimmed.startsWith(prefix));
      });
    if (running) throw new Error('请先保存工作并手动退出 Antigravity，再切换账号；GravityBox 不会结束或重启它');
  }
  private async archivePreviousJournal(previous: Journal) {
    const backupsDir = join(this.options.stateDir, 'account-switch-backups');
    const sanitized: Journal = {
      ...previous,
      before: sanitizeJournalRows(previous.before),
      after: sanitizeJournalRows(previous.after),
      keychainBefore: previous.keychainBefore ? '[REDACTED]' : null,
      keychainAfter: previous.keychainAfter ? '[REDACTED]' : '',
      files: sanitizeJournalFiles(previous.files),
    };
    const now = Date.now();
    await atomicJson(join(backupsDir, `${now}_${randomUUID().slice(0, 8)}.json`), sanitized);
    // 最多保留最近 3 份历史切号归档，按确凿时间戳排序清理早期记录
    const list = (await readdir(backupsDir).catch(() => [] as string[])).filter(n => n.endsWith('.json'));
    if (list.length > 3) {
      const filesWithTime = await Promise.all(list.map(async name => {
        const p = join(backupsDir, name);
        const match = name.match(/^(\d+)_/);
        if (match) return { path: p, time: Number(match[1]) };
        const st = await lstat(p).catch(() => null);
        return { path: p, time: st?.mtimeMs ?? 0 };
      }));
      filesWithTime.sort((a, b) => a.time - b.time);
      for (const item of filesWithTime.slice(0, filesWithTime.length - 3)) {
        await unlink(item.path).catch(() => {});
      }
    }
  }

  private async regular(path: string) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error('拒绝修改身份不匹配的登录文件');
  }
  private async optionalRegular(path: string): Promise<boolean> {
    try {
      await this.regular(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    const path = join(this.options.stateDir, 'account-switch.lock');
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch {
      await this.regular(path);
      const owner = Number(await readFile(path, 'utf8'));
      if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('切换锁无法识别，请检查数据目录');
      try { process.kill(owner, 0); throw new Error('已有账号切换或恢复操作，请等待完成'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      await unlink(path); handle = await open(path, 'wx', 0o600);
    }
    await handle.writeFile(String(process.pid));
    try { return await this.manager.runExclusive(operation); } finally { await handle.close(); await unlink(path); }
  }
  private async restoreFiles(files: SavedFile[], keychainBefore: string | null, keychainAfter: string, keychainAfterDigest?: string) {
    for (const file of files) {
      const value = await readFile(file.path, 'utf8');
      const matchesBefore = value === file.before;
      const matchesAfter = (file.afterDigest ? sha256(value) === file.afterDigest : false) || value === file.after;
      if (!matchesBefore && !matchesAfter) throw new Error('切换后登录文件已变化，停止自动回滚以保留新状态');
    }
    const current = await this.keychain.readPassword('gemini', 'antigravity');
    const matchesKeychainBefore = current === keychainBefore;
    const matchesKeychainAfter = (keychainAfter && keychainAfter !== '[REDACTED]' && current === keychainAfter) || (keychainAfterDigest && current !== null && sha256(current) === keychainAfterDigest);
    if (!matchesKeychainBefore && !matchesKeychainAfter) throw new Error('钥匙串已由其他程序更新，停止自动回滚');
    for (const file of files) await atomicText(file.path, file.before);
    if (keychainBefore === null) await this.keychain.deletePassword('gemini', 'antigravity');
    else await this.keychain.writePassword('gemini', 'antigravity', keychainBefore);
  }
  async switchAccount(id: string, target = 'all') {
    this.assertSupported();
    if (!['all', 'app'].includes(target)) throw new Error('目前仅支持切换 Antigravity 桌面账号');
    return this.locked(async () => {
      await this.guardStopped();
      let previous: Journal | undefined;
      try { previous = JSON.parse(await readFile(this.journalPath, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('切换恢复记录无法读取，请先检查数据目录'); }
      if (previous && !['complete', 'rolled-back', 'cleared'].includes(previous.status)) throw new Error('上次切换未完成，请先使用“撤销上次账号切换”恢复');
      const acc = await this.manager.getAccount(id);
      if (!acc || acc.disabled || acc.validation_blocked) throw new Error('目标账号不可用');
      if (!acc.token.access_token || acc.token.access_token === 'pending_refresh' || acc.token.expiry_timestamp <= Date.now() / 1000 + 30) throw new Error('请先刷新此账号配额以更新登录凭据');
      const db = join(this.options.profile, 'User', 'globalStorage', 'state.vscdb');
      const hasDb = await this.optionalRegular(db);
      const transaction = hasDb ? new DatabaseTransaction(db) : undefined;
      let journal: Journal | undefined, committed = false;
      try {
        let before: Rows = {}, after: Rows = {};
        if (transaction) {
          await transaction.begin();
          before = await transaction.rows();
          after = nextRows(before, acc);
        }
        const index = await this.manager.loadIndex();
        const stamp = Math.floor(Date.now() / 1000);
        const accountNext = { ...acc, last_used: stamp };
        const indexNext = { ...index, current_account_id: id, current_target_ide: 'app', accounts: index.accounts.map(a => a.id === id ? { ...a, last_used: stamp } : a) };
        const files: SavedFile[] = [];
        const snapshot = async (path: string, value: unknown) => { await this.regular(path); files.push({ path, before: await readFile(path, 'utf8'), after: JSON.stringify(value, null, 2) + '\n' }); };
        await snapshot(join(this.options.stateDir, 'accounts', `${id}.json`), accountNext);
        await snapshot(join(this.options.stateDir, 'accounts.json'), indexNext);
        const externalIndex = join(this.options.externalDir, 'accounts.json');
        try {
          await this.regular(externalIndex);
          const ext = JSON.parse(await readFile(externalIndex, 'utf8'));
          const matching = ext.accounts?.filter((a: any) => String(a.email).toLowerCase() === acc.email.toLowerCase()) ?? [];
          if (matching.length !== 1) throw new Error('AntiGravity Switch 中未找到唯一对应账号，请先同步账号');
          await snapshot(externalIndex, { ...ext, current_account_id: matching[0].id });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const keychainBefore = await this.keychain.readPassword('gemini', 'antigravity');
        // Build the exact intended value with an in-memory adapter; no system write yet.
        let keychainAfter = '';
        await syncAccountToKeychain(acc, { readPassword: async () => null, deletePassword: async () => {}, writePassword: async (_s, _a, value) => { keychainAfter = value; } });
        const afterDigest = rowsDigest(after);
        const keychainAfterDigest = sha256(keychainAfter);
        const filesWithDigest: SavedFile[] = files.map(f => ({ ...f, afterDigest: sha256(f.after) }));
        journal = { version: 1, status: 'pending', before, after, afterDigest, files: filesWithDigest, keychainBefore, keychainAfter, keychainAfterDigest, at: new Date().toISOString() };
        if (previous) await this.archivePreviousJournal(previous);
        await atomicJson(this.journalPath, journal);
        await this.guardStopped();
        if (transaction) await transaction.replace(after);
        await this.keychain.writePassword('gemini', 'antigravity', keychainAfter);
        for (const file of files) {
          if (await readFile(file.path, 'utf8') !== file.before) throw new Error('账号记录已变化，请刷新后重试');
          await atomicText(file.path, file.after);
        }
        await this.guardStopped();
        if (transaction) await transaction.finish(true);
        committed = true;
        await this.manager.recordAutoSwitchChoice(acc.id).catch(() => {});
        await atomicJson(this.journalPath, {
          ...journal,
          status: 'complete',
          after: sanitizeJournalRows(after),
          keychainAfter: '[REDACTED]',
          files: filesWithDigest.map(f => ({
            path: f.path,
            before: f.before,
            after: f.path.includes('/accounts/') ? '[REDACTED_ACCOUNT]' : f.after,
            afterDigest: f.afterDigest,
          })),
        });
        return { switchedTo: acc.email, message: '登录记录已切换；下次打开 Antigravity 后生效' };
      } catch (error) {
        if (!committed) {
          await transaction?.finish(false).catch(() => {});
          if (journal) {
            try { await this.restoreFiles(journal.files, journal.keychainBefore, journal.keychainAfter, journal.keychainAfterDigest); await atomicJson(this.journalPath, { ...journal, status: 'rolled-back' }); }
            catch { throw new Error('切换未完成，部分恢复被外部变化阻止；恢复记录已保留在数据目录'); }
          }
          throw new Error(error instanceof Error ? error.message : '切换失败，原状态已恢复');
        }
        throw new Error('登录记录已提交，但完成记录未保存；请保留数据目录供恢复核查');
      } finally { transaction?.close(); }
    });
  }
  async recoveryInfo() {
    try {
      const raw=await readFile(this.journalPath,'utf8'), journal=JSON.parse(raw) as Journal;
      const at=Date.parse(journal.at), expiresAt=Number.isFinite(at)?new Date(at+7*86400000).toISOString():null;
      const pending=!['complete','rolled-back','cleared'].includes(journal.status);
      return {available:journal.status!=='cleared',status:journal.status,createdAt:journal.at,expiresAt,pending,expired:!pending&&(!expiresAt||Date.parse(expiresAt)<Date.now()),digest:sha256(raw),containsCredentials:!!Object.keys(journal.before??{}).length||!!journal.keychainBefore};
    } catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return{available:false}; throw new Error('恢复记录无法读取，原文件已保留');}
  }
  async clearRecovery(expectedDigest: string) {
    return this.locked(async()=>{
      const raw=await readFile(this.journalPath,'utf8'), journal=JSON.parse(raw) as Journal;
      if(sha256(raw)!==expectedDigest)throw new Error('恢复记录已变化，请重新预览');
      if(!['complete','rolled-back'].includes(journal.status))throw new Error('未完成的切号恢复材料不可清除');
      await atomicJson(this.journalPath,{version:1,status:'cleared',at:journal.at,clearedAt:new Date().toISOString(),before:{},after:{},files:[],keychainBefore:null,keychainAfter:''});
      return {message:'已清除完成记录中的登录恢复凭据，保留操作时间'};
    });
  }
  async rollback() {
    this.assertSupported();
    return this.locked(async () => {
      await this.guardStopped();
      const journal = JSON.parse(await readFile(this.journalPath, 'utf8')) as Journal;
      if (journal.status === 'rolled-back') throw new Error('上次切换已撤销');
      if (journal.status === 'cleared') throw new Error('恢复材料已由用户清除');
      if (journal.status === 'complete' && (!Number.isFinite(Date.parse(journal.at)) || Date.now()-Date.parse(journal.at)>7*86400000)) throw new Error('完成记录已超过 7 天撤销期；材料保留，可在设置中核对和清除');
      const db = join(this.options.profile, 'User', 'globalStorage', 'state.vscdb');
      const hasDb = await this.optionalRegular(db);
      const transaction = hasDb ? new DatabaseTransaction(db) : undefined;
      try {
        if (transaction) {
          await transaction.begin();
          const rows = await transaction.rows();
          const currentCanonical = JSON.stringify(Object.entries(rows).sort());
          const beforeCanonical = JSON.stringify(Object.entries(journal.before).sort());
          const matchesBefore = currentCanonical === beforeCanonical;
          const currentDigest = rowsDigest(rows);
          const matchesAfterDigest = journal.afterDigest ? currentDigest === journal.afterDigest : false;
          const matchesAfterRows = journal.after ? currentCanonical === JSON.stringify(Object.entries(journal.after).sort()) : false;
          if (!matchesBefore && !matchesAfterDigest && !matchesAfterRows) throw new Error('登录数据库已变化，停止自动回滚以保留新状态');
          await this.restoreFiles(journal.files, journal.keychainBefore, journal.keychainAfter, journal.keychainAfterDigest);
          await transaction.replace(journal.before);
          await this.guardStopped(); await transaction.finish(true);
        } else {
          if (Object.keys(journal.before || {}).length > 0) throw new Error('登录数据库已变化，停止自动回滚以保留新状态');
          await this.restoreFiles(journal.files, journal.keychainBefore, journal.keychainAfter, journal.keychainAfterDigest);
          await this.guardStopped();
        }
        // 撤销完成后清除待恢复凭据，杜绝磁盘长期残留旧 Token
        await atomicJson(this.journalPath, {
          ...journal,
          before: sanitizeJournalRows(journal.before),
          after: sanitizeJournalRows(journal.after),
          afterDigest: undefined,
          files: sanitizeJournalFiles(journal.files),
          keychainBefore: null,
          keychainAfter: '',
          keychainAfterDigest: undefined,
          status: 'rolled-back'
        });
        return { message: '已恢复切换前的账号记录；下次打开 Antigravity 后生效' };
      } catch (error) { await transaction?.finish(false).catch(() => {}); throw error; }
      finally { transaction?.close(); }
    });
  }
}
