import { type ApplicationChannel, type ApplicationTarget, applicationTarget } from './application-target.js';
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { readFile, mkdir, lstat, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { atomicJson, atomicText, sanitizeError } from './files.js';
import { withProcessLease } from './process-lock.js';
import { AccountsManager, SystemKeychainAdapter, buildGoOauthPayload, syncAccountToKeychain, type KeychainAdapter, type Account } from './accounts.js';
import { ProtobufWriter as Writer } from './protobuf.js';
import { replaceTopicRow } from './account-state.js';
export { replaceTopicRow } from './account-state.js';
import { bt } from './i18n.js';
import { bundleProcessPrefix, defaultGravityBoxStateDir, isLinux, resolvePsBinary } from './platform.js';

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
type RollbackRecord = {
  version: 1;
  phase: 'prepared' | 'committed';
  databasePath: string;
  hadDatabase: boolean;
  rowsBefore: Rows;
  rowsAfter: Rows;
  files: SavedFile[];
  keychainBefore: string | null;
  keychainAfter: string | null;
  originalJournal: Journal;
};

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
function rowsDigest(rows: Rows): string {
  return sha256(JSON.stringify(Object.entries(rows || {}).sort()));
}

// Keeps BEGIN IMMEDIATE held while the other resources are committed.
// On macOS with `/usr/bin/sqlite3`, SQL goes through stdin so tokens never appear in argv.
// On Linux (or whenever `/usr/bin/sqlite3` is absent), uses Node 22's built-in `node:sqlite` DatabaseSync in-process.
export class DatabaseTransaction {
  private child?: ReturnType<typeof spawn>;
  private nativeDb?: NodeDatabaseSync;
  private nativePath?: string;
  private nativeTxActive = false;
  private output = '';
  private pending?: { marker: string; resolve: (s: string) => void; reject: (e: Error) => void };
  private failed = false;
  private exited: Promise<void>;
  constructor(path: string) {
    if (isLinux || !existsSync('/usr/bin/sqlite3')) {
      this.exited = Promise.resolve();
      this.nativePath = path;
      return;
    }
    this.child = spawn('/usr/bin/sqlite3', ['-batch', '-bail', path], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => this.child!.once('close', () => resolve()));
    this.child.stdin!.on('error', () => this.fail());
    this.child.stderr!.on('data', () => this.fail());
    this.child.on('error', () => this.fail());
    this.child.on('exit', () => this.fail());
    this.child.stdout!.on('data', chunk => {
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
  private async ensureNativeDb(): Promise<NodeDatabaseSync> {
    if (this.nativeDb) return this.nativeDb;
    if (!this.nativePath) throw new Error(bt('switch.err.db_closed'));
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(this.nativePath);
    db.exec('PRAGMA busy_timeout = 3000;');
    this.nativeDb = db;
    return db;
  }
  private fail() { this.failed = true; this.pending?.reject(new Error(bt('switch.err.db_tx_failed'))); this.pending = undefined; }
  async sql(sql: string): Promise<string> {
    if (this.failed) throw new Error(bt('switch.err.db_closed'));
    if (this.nativePath !== undefined) {
      try {
        const db = await this.ensureNativeDb();
        db.exec(sql);
        return '';
      } catch {
        this.failed = true;
        throw new Error(bt('switch.err.db_tx_failed'));
      }
    }
    const marker = `GB_${randomUUID()}`;
    const response = new Promise<string>((resolve, reject) => { this.pending = { marker, resolve, reject }; });
    this.child!.stdin!.write(`${sql}\n.print ${marker}\n`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([response, new Promise<never>((_, reject) => { timer = setTimeout(() => { this.child!.kill(); reject(new Error(bt('switch.err.db_busy'))); }, 6000); })]); }
    finally { clearTimeout(timer); }
  }
  async begin() {
    if (this.nativePath !== undefined) {
      if (this.failed) throw new Error(bt('switch.err.db_closed'));
      try {
        const db = await this.ensureNativeDb();
        db.exec('BEGIN IMMEDIATE;');
        this.nativeTxActive = true;
      } catch (err) {
        this.failed = true;
        const msg = err instanceof Error ? err.message : '';
        throw new Error(/locked|busy/i.test(msg) ? bt('switch.err.db_busy') : bt('switch.err.db_tx_failed'));
      }
      return;
    }
    await this.sql('.timeout 3000\n.mode json\nBEGIN IMMEDIATE;');
  }
  async rows(): Promise<Rows> {
    if (this.nativePath !== undefined) {
      if (this.failed) throw new Error(bt('switch.err.db_closed'));
      try {
        const db = await this.ensureNativeDb();
        const placeholders = KEYS.map(() => '?').join(',');
        const stmt = db.prepare(`SELECT key, value FROM ItemTable WHERE key IN (${placeholders});`);
        const found = stmt.all(...KEYS) as Array<{ key: string; value: string }>;
        return Object.fromEntries(found.map(r => [r.key, String(r.value)]));
      } catch {
        this.failed = true;
        throw new Error(bt('switch.err.db_tx_failed'));
      }
    }
    const raw = await this.sql(`SELECT key,value FROM ItemTable WHERE key IN (${KEYS.map(quote).join(',')});`);
    return Object.fromEntries((JSON.parse(raw || '[]') as { key: string; value: string }[]).map(r => [r.key, r.value]));
  }
  async replace(rows: Rows) {
    if (this.nativePath !== undefined) {
      if (this.failed) throw new Error(bt('switch.err.db_closed'));
      try {
        const db = await this.ensureNativeDb();
        const placeholders = KEYS.map(() => '?').join(',');
        db.prepare(`DELETE FROM ItemTable WHERE key IN (${placeholders});`).run(...KEYS);
        const insert = db.prepare('INSERT INTO ItemTable(key, value) VALUES(?, ?);');
        for (const [k, v] of Object.entries(rows)) {
          insert.run(k, v);
        }
      } catch {
        this.failed = true;
        throw new Error(bt('switch.err.db_tx_failed'));
      }
      return;
    }
    await this.sql(`DELETE FROM ItemTable WHERE key IN (${KEYS.map(quote).join(',')});\n${Object.entries(rows).map(([k, v]) => `INSERT INTO ItemTable(key,value) VALUES(${quote(k)},${quote(v)});`).join('\n')}`);
  }
  async finish(commit: boolean) {
    if (this.nativePath !== undefined) {
      try {
        if (this.nativeDb && this.nativeTxActive) {
          this.nativeTxActive = false;
          this.nativeDb.exec(commit ? 'COMMIT;' : 'ROLLBACK;');
        }
      } catch {
        this.failed = true;
        throw new Error(bt('switch.err.db_tx_failed'));
      } finally {
        try { this.nativeDb?.close(); } catch {}
        this.nativeDb = undefined;
      }
      return;
    }
    try { await this.sql(commit ? 'COMMIT;' : 'ROLLBACK;'); } finally { this.child?.stdin?.end(); }
  }
  async close() {
    if (this.nativePath !== undefined) {
      try {
        if (this.nativeDb && this.nativeTxActive) {
          this.nativeTxActive = false;
          this.nativeDb.exec('ROLLBACK;');
        }
      } catch {}
      try { this.nativeDb?.close(); } catch {}
      this.nativeDb = undefined;
      return;
    }
    this.child?.stdin?.end();
    const timer = setTimeout(() => this.child?.kill(), 1500);
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}


function nextRows(before: Rows, acc: Account): Rows {
  const token = acc.token;
  const personal = /@(gmail|outlook|hotmail|qq|163)\.com$/i.test(acc.email);
  const accessToken = token.access_token && token.access_token !== 'pending_refresh' ? token.access_token : '';
  const expirySec = Number.isFinite(token.expiry_timestamp) && token.expiry_timestamp > 0 ? Math.floor(token.expiry_timestamp) : 0;
  const payload = Buffer.concat([
    Writer.encodeString(1, accessToken), Writer.encodeString(2, 'Bearer'), Writer.encodeString(3, token.refresh_token),
    Writer.encodeLengthDelimited(4, Buffer.concat([Writer.encodeVarintField(1, expirySec), Writer.encodeVarintField(2, 0)])),
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

/**
 * 白名单制文件脱敏：除 accounts.json 仅含非敏感索引摘要外，任何其它文件路径（无论是否有 .json 后缀）
 * 一律视为可能包含 OAuth 凭据并彻底脱敏。
 */
function isNonSensitiveIndexFile(filePath: string): boolean {
  return filePath.endsWith('/accounts.json') || filePath === 'accounts.json';
}

function sanitizeJournalFiles(files: SavedFile[]): SavedFile[] {
  return (files || []).map(f => {
    if (!isNonSensitiveIndexFile(f.path)) {
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
    stateDir: string; profile: string; keychain?: KeychainAdapter; channel?: ApplicationChannel; target?: ApplicationTarget;
    homeDir?: string; geminiDir?: string;
    isRunning?: () => Promise<boolean>; // Isolated tests only; never accepted over IPC.
    databaseFactory?: (path: string) => DatabaseTransaction; // Fault injection, never accepted over IPC.
  }) {
    this.keychain = options.keychain ?? new SystemKeychainAdapter();
    this.target = options.target ?? applicationTarget(options.channel ?? 'stable', undefined, { profile: options.profile });
    this.journalPath = join(options.stateDir, 'account-switch-journal-stable.json');
  }

  private getCliCredentialPaths(): string[] {
    const baseGeminiDir = this.options.geminiDir
      ?? (this.options.homeDir ? join(this.options.homeDir, '.gemini') : undefined)
      ?? (this.options.stateDir === defaultGravityBoxStateDir(homedir()) ? join(homedir(), '.gemini') : undefined);
    if (!baseGeminiDir) return [];
    return [
      join(baseGeminiDir, 'antigravity-cli', 'antigravity-oauth-token'),
      join(baseGeminiDir, 'jetski-standalone-oauth-token'),
    ];
  }

  /**
   * 附属同步本机已存在的同源 agy CLI 凭据文件（非侵入：文件不存在绝不创建；不进入 journal.files 严格摘要锁）。
   */
  private async syncExistingCliCredentials(payloadJson: string | null): Promise<{ syncedPaths: string[]; warnings: string[] }> {
    const syncedPaths: string[] = [];
    const warnings: string[] = [];
    if (!payloadJson) return { syncedPaths, warnings };
    for (const cliPath of this.getCliCredentialPaths()) {
      try {
        const info = await lstat(cliPath).catch((err: NodeJS.ErrnoException) => {
          if (err?.code === 'ENOENT') return null;
          throw err;
        });
        if (!info) continue;
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) {
          warnings.push(`${cliPath}: skipped non-regular or non-user file`);
          continue;
        }
        await atomicText(cliPath, payloadJson.endsWith('\n') ? payloadJson : `${payloadJson}\n`);
        syncedPaths.push(cliPath);
      } catch (error) {
        warnings.push(sanitizeError((error as Error)?.message ?? String(error)));
      }
    }
    return { syncedPaths, warnings };
  }

  private async resolveRollbackCliPayload(journal: Journal): Promise<string | null> {
    if (typeof journal.keychainBefore === 'string' && journal.keychainBefore.startsWith('go-keyring-base64:')) {
      try {
        const raw = Buffer.from(journal.keychainBefore.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.token && typeof parsed.token.refresh_token === 'string' && parsed.token.refresh_token) {
          return JSON.stringify(parsed);
        }
      } catch {}
    }
    const indexSnapshot = (journal.files || []).find(f => isNonSensitiveIndexFile(f.path));
    if (indexSnapshot?.before) {
      try {
        const prevIndex = JSON.parse(indexSnapshot.before) as { current_account_id?: string | null };
        const prevId = prevIndex?.current_account_id;
        if (typeof prevId === 'string' && prevId) {
          const prevAcc = await this.manager.getAccount(prevId).catch(() => null);
          if (prevAcc?.token?.refresh_token) {
            return buildGoOauthPayload(prevAcc);
          }
        }
      } catch {}
    }
    return null;
  }

  setTarget(target: ApplicationTarget) {
    this.target = target;
    this.options.channel = target.channel;
    this.options.profile = target.profile;
    this.journalPath = join(this.options.stateDir, 'account-switch-journal-stable.json');
  }

  private get rollbackPath() { return this.journalPath + '.rollback.json'; }
  private database(path: string) { return this.options.databaseFactory?.(path) ?? new DatabaseTransaction(path); }

  private completedRollback(journal: Journal): Journal {
    return { ...journal, before: sanitizeJournalRows(journal.before), after: sanitizeJournalRows(journal.after),
      afterDigest: undefined, files: sanitizeJournalFiles(journal.files), keychainBefore: null,
      keychainAfter: '', keychainAfterDigest: undefined, status: 'rolled-back' };
  }

  /** Reconcile an interrupted undo using the committed database as the decision point.
   * All resources are compared against both recorded states before any overwrite.
   * The durable record survives a compensation failure and can be retried after restart.
   */
  private async reconcileRollback(): Promise<'none' | 'restored' | 'rolled-back'> {
    let record: RollbackRecord;
    try { await this.regular(this.rollbackPath); record = JSON.parse(await readFile(this.rollbackPath, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none'; throw error; }
    const dbPath = join(this.options.profile, 'User', 'globalStorage', 'state.vscdb');
    const allowed = new Set([join(this.options.stateDir, 'accounts.json')]);
    if (record.version !== 1 || !['prepared', 'committed'].includes(record.phase) || record.databasePath !== dbPath ||
        !Array.isArray(record.files) || record.files.some(f => !allowed.has(f.path) &&
          !(f.path.startsWith(join(this.options.stateDir, 'accounts') + '/') && /^[a-zA-Z0-9_-]+\.json$/.test(f.path.slice(join(this.options.stateDir, 'accounts').length + 1))))) {
      throw new Error(bt('switch.err.rollback_identity'));
    }
    const currentJournal = JSON.parse(await readFile(this.journalPath, 'utf8')) as Journal;
    const original = record.originalJournal;
    const knownJournals = [original, { ...original, status: 'rolling-back' }, this.completedRollback(original)];
    if (!knownJournals.some(value => JSON.stringify(value) === JSON.stringify(currentJournal))) throw new Error(bt('switch.err.journal_modified'));
    if (await this.optionalRegular(dbPath) !== record.hadDatabase) throw new Error(bt('switch.err.db_changed_rollback_kept'));
    const tx = record.hadDatabase ? this.database(dbPath) : undefined;
    try {
      await tx?.begin();
      const rows = tx ? await tx.rows() : {};
      const isBefore = rowsDigest(rows) === rowsDigest(record.rowsBefore), isAfter = rowsDigest(rows) === rowsDigest(record.rowsAfter);
      if (!isBefore && !isAfter) throw new Error(bt('switch.err.db_external_modified'));
      const committed = isAfter && (!isBefore || record.phase === 'committed' || currentJournal.status === 'rolled-back');
      for (const file of record.files) {
        await this.regular(file.path);
        const value = await readFile(file.path, 'utf8');
        if (value !== file.before && value !== file.after) throw new Error(bt('switch.err.account_file_external'));
      }
      const password = await this.keychain.readPassword('gemini', 'antigravity');
      if (password !== record.keychainBefore && password !== record.keychainAfter) throw new Error(bt('switch.err.keychain_external'));
      for (const file of record.files) {
        const desired = committed ? file.after : file.before;
        if (await readFile(file.path, 'utf8') !== desired) await atomicText(file.path, desired);
      }
      const desiredPassword = committed ? record.keychainAfter : record.keychainBefore;
      if (password !== desiredPassword) {
        if (desiredPassword === null) await this.keychain.deletePassword('gemini', 'antigravity');
        else await this.keychain.writePassword('gemini', 'antigravity', desiredPassword);
      }
      // No database rewrite: its observed committed state selected which file/keychain state to keep.
      await tx?.finish(false);
      await atomicJson(this.journalPath, committed ? this.completedRollback(original) : original);
      await unlink(this.rollbackPath);
      this.manager.invalidateRuntimeCaches?.();
      if (committed) {
        const rollbackCliPayload = await this.resolveRollbackCliPayload(original);
        await this.syncExistingCliCredentials(rollbackCliPayload);
      }
      return committed ? 'rolled-back' : 'restored';
    } finally { await tx?.close(); }
  }
  private async guardStopped() {
    const candidatePrefixes = Array.from(
      // Insiders shares official credentials: block switching while it runs, without managing it.
      new Set([
        bundleProcessPrefix(this.target.appPath),
        '/Applications/Antigravity.app/Contents/',
        '/Applications/Antigravity - Insiders.app/Contents/',
      ]),
    );
    const running = this.options.isRunning ? await this.options.isRunning() :
      (await run(resolvePsBinary(), ['-ax', '-ww', '-o', 'args='], { timeout: 3000 })).stdout.split('\n').some(line => {
        const trimmed = line.trim();
        return candidatePrefixes.some(prefix => trimmed.startsWith(prefix));
      });
    if (running) throw new Error(bt('switch.err.stop_app_first'));
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
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error(bt('switch.err.invalid_login_file'));
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
    return withProcessLease(
      path,
      () => this.manager.runExclusive(operation),
      { timeoutMs: 0, busyMessage: bt('switch.err.busy') }
    );
  }
  private async restoreFiles(files: SavedFile[], keychainBefore: string | null, keychainAfter: string, keychainAfterDigest?: string) {
    for (const file of files) {
      const value = await readFile(file.path, 'utf8');
      const matchesBefore = value === file.before;
      const matchesAfter = (file.afterDigest ? sha256(value) === file.afterDigest : false) || value === file.after;
      if (!matchesBefore && !matchesAfter) throw new Error(bt('switch.err.files_changed_after'));
    }
    const current = await this.keychain.readPassword('gemini', 'antigravity');
    const matchesKeychainBefore = current === keychainBefore;
    const matchesKeychainAfter = (keychainAfter && keychainAfter !== '[REDACTED]' && current === keychainAfter) || (keychainAfterDigest && current !== null && sha256(current) === keychainAfterDigest);
    if (!matchesKeychainBefore && !matchesKeychainAfter) throw new Error(bt('switch.err.keychain_updated'));
    for (const file of files) await atomicText(file.path, file.before);
    if (keychainBefore === null) await this.keychain.deletePassword('gemini', 'antigravity');
    else await this.keychain.writePassword('gemini', 'antigravity', keychainBefore);
  }
  async switchAccount(id: string, target = 'all') {
    if (!['all', 'app'].includes(target)) throw new Error(bt('switch.err.desktop_only'));
    return this.locked(async () => {
      await this.guardStopped();
      await this.reconcileRollback();
      let previous: Journal | undefined;
      try { previous = JSON.parse(await readFile(this.journalPath, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(bt('switch.err.journal_unreadable')); }
      if (previous && !['complete', 'rolled-back', 'cleared'].includes(previous.status)) throw new Error(bt('switch.err.previous_incomplete'));
      const acc = await this.manager.getAccount(id);
      if (!acc || acc.disabled || acc.validation_blocked) throw new Error(bt('switch.err.account_unavailable'));
      if (!acc.token?.refresh_token) throw new Error(bt('switch.err.refresh_credentials_first'));
      // Best-effort harvest of outgoing account's fresher local session token before overwriting host credentials.
      const preHarvestIndex = await this.manager.loadIndex().catch(() => null);
      const outgoingId = preHarvestIndex?.current_account_id;
      if (outgoingId && outgoingId !== id && typeof this.manager.harvestTokenForAccountId === 'function') {
        await this.manager.harvestTokenForAccountId(outgoingId, {
          keychain: this.keychain,
          homeDir: this.options.homeDir,
          profileDir: this.options.profile,
        }).catch(() => {});
      }
      const db = join(this.options.profile, 'User', 'globalStorage', 'state.vscdb');
      const hasDb = await this.optionalRegular(db);
      const transaction = hasDb ? this.database(db) : undefined;
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
          if (await readFile(file.path, 'utf8') !== file.before) throw new Error(bt('switch.err.record_changed_retry'));
          await atomicText(file.path, file.after);
        }
        await this.guardStopped();
        if (transaction) await transaction.finish(true);
        committed = true;
        this.manager.invalidateRuntimeCaches?.();
        await this.manager.recordAutoSwitchChoice(acc.id).catch(() => {});
        await atomicJson(this.journalPath, {
          ...journal,
          status: 'complete',
          after: sanitizeJournalRows(after),
          keychainAfter: '[REDACTED]',
          files: filesWithDigest.map(f => ({
            path: f.path,
            before: f.before,
            after: !isNonSensitiveIndexFile(f.path) ? '[REDACTED_ACCOUNT]' : f.after,
            afterDigest: f.afterDigest,
          })),
        });
        const cliSync = await this.syncExistingCliCredentials(buildGoOauthPayload(acc));
        return {
          switchedTo: acc.email,
          message: bt('switch.msg.switched'),
          ...(cliSync.syncedPaths.length ? { cliSynced: cliSync.syncedPaths.length } : {}),
          ...(cliSync.warnings.length ? { cliWarnings: cliSync.warnings } : {}),
        };
      } catch (error) {
        if (!committed) {
          await transaction?.finish(false).catch(() => {});
          if (journal) {
            try { await this.restoreFiles(journal.files, journal.keychainBefore, journal.keychainAfter, journal.keychainAfterDigest); await atomicJson(this.journalPath, this.completedRollback(journal)); }
            catch { throw new Error(bt('switch.err.restore_blocked')); }
          }
          throw new Error(error instanceof Error ? error.message : bt('switch.err.switch_failed_restored'));
        }
        throw new Error(bt('switch.err.committed_journal_unsaved'));
      } finally { await transaction?.close(); }
    });
  }
  async recoveryInfo() {
    try {
      const raw=await readFile(this.journalPath,'utf8'), journal=JSON.parse(raw) as Journal;
      const at=Date.parse(journal.at), expiresAt=Number.isFinite(at)?new Date(at+7*86400000).toISOString():null;
      const interruptedUndo = await this.optionalRegular(this.rollbackPath);
      const pending=interruptedUndo||!['complete','rolled-back','cleared'].includes(journal.status);
      return {available:journal.status!=='cleared'||interruptedUndo,status:interruptedUndo?'rollback-pending':journal.status,createdAt:journal.at,expiresAt,pending,expired:!pending&&(!expiresAt||Date.parse(expiresAt)<Date.now()),digest:sha256(raw),containsCredentials:interruptedUndo||!!Object.keys(journal.before??{}).length||!!journal.keychainBefore};
    } catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return{available:false}; throw new Error(bt('switch.err.recovery_unreadable'));}
  }
  async clearRecovery(expectedDigest: string) {
    return this.locked(async()=>{
      if (await this.optionalRegular(this.rollbackPath)) throw new Error(bt('switch.err.rollback_unfinished_clear'));
      const raw=await readFile(this.journalPath,'utf8'), journal=JSON.parse(raw) as Journal;
      if(sha256(raw)!==expectedDigest)throw new Error(bt('switch.err.recovery_changed_repreview'));
      if(!['complete','rolled-back'].includes(journal.status))throw new Error(bt('switch.err.incomplete_clear_forbidden'));
      await atomicJson(this.journalPath,{version:1,status:'cleared',at:journal.at,clearedAt:new Date().toISOString(),before:{},after:{},files:[],keychainBefore:null,keychainAfter:''});
      return {message:bt('switch.msg.recovery_cleared')};
    });
  }
  async rollback() {
    return this.locked(async () => {
      await this.guardStopped();
      if (await this.reconcileRollback() === 'rolled-back') return { message: bt('switch.msg.interrupted_restored') };
      const journal = JSON.parse(await readFile(this.journalPath, 'utf8')) as Journal;
      if (journal.status === 'rolled-back') throw new Error(bt('switch.err.already_rolled_back'));
      if (journal.status === 'cleared') throw new Error(bt('switch.err.already_cleared'));
      if (journal.status === 'complete' && (!Number.isFinite(Date.parse(journal.at)) || Date.now()-Date.parse(journal.at)>7*86400000)) throw new Error(bt('switch.err.expired_7d'));
      const db = join(this.options.profile, 'User', 'globalStorage', 'state.vscdb');
      const hasDb = await this.optionalRegular(db);
      const transaction = hasDb ? this.database(db) : undefined;
      let record: RollbackRecord | undefined;
      try {
        let rows: Rows = {};
        if (transaction) {
          await transaction.begin();
          rows = await transaction.rows();
          const currentCanonical = JSON.stringify(Object.entries(rows).sort());
          const beforeCanonical = JSON.stringify(Object.entries(journal.before).sort());
          const matchesBefore = currentCanonical === beforeCanonical;
          const currentDigest = rowsDigest(rows);
          const matchesAfterDigest = journal.afterDigest ? currentDigest === journal.afterDigest : false;
          const matchesAfterRows = journal.after ? currentCanonical === JSON.stringify(Object.entries(journal.after).sort()) : false;
          if (!matchesBefore && !matchesAfterDigest && !matchesAfterRows) throw new Error(bt('switch.err.db_changed_abort_rollback'));
        } else {
          if (Object.keys(journal.before || {}).length > 0) throw new Error(bt('switch.err.db_changed_abort_rollback'));
        }
        const snapshots: SavedFile[] = [];
        for (const file of journal.files) {
          await this.regular(file.path);
          snapshots.push({ path: file.path, before: await readFile(file.path, 'utf8'), after: file.before });
        }
        record = { version: 1, phase: 'prepared', databasePath: db, hadDatabase: hasDb, rowsBefore: rows, rowsAfter: journal.before,
          files: snapshots, keychainBefore: await this.keychain.readPassword('gemini', 'antigravity'), keychainAfter: journal.keychainBefore, originalJournal: journal };
        await atomicJson(this.rollbackPath, record);
        await atomicJson(this.journalPath, { ...journal, status: 'rolling-back' });
        await this.restoreFiles(journal.files, journal.keychainBefore, journal.keychainAfter, journal.keychainAfterDigest);
        if (transaction) await transaction.replace(journal.before);
        await this.guardStopped();
        if (transaction) await transaction.finish(true);
        this.manager.invalidateRuntimeCaches?.();
        record.phase = 'committed'; await atomicJson(this.rollbackPath, record);
        await atomicJson(this.journalPath, this.completedRollback(journal));
        await unlink(this.rollbackPath);
        const rollbackCliPayload = await this.resolveRollbackCliPayload(journal);
        const cliSync = await this.syncExistingCliCredentials(rollbackCliPayload);
        return {
          message: bt('switch.msg.restored_previous'),
          ...(cliSync.syncedPaths.length ? { cliSynced: cliSync.syncedPaths.length } : {}),
          ...(cliSync.warnings.length ? { cliWarnings: cliSync.warnings } : {}),
        };
      } catch (error) {
        await transaction?.finish(false).catch(() => {});
        await transaction?.close();
        if (record) {
          try {
            if (await this.reconcileRollback() === 'rolled-back') {
              return { message: bt('switch.msg.restored_previous') };
            }
          } catch {
            throw new Error(bt('switch.err.rollback_blocked'));
          }
        }
        throw error;
      } finally { await transaction?.close(); }
    });
  }
}
