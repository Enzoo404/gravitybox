import { applicationTarget, type ApplicationTarget } from './application-target.js';
import { bt } from './i18n.js';
import { defaultAppSupportDir, defaultGravityBoxStateDir, resolvePsBinary } from './platform.js';
import { inspectBundle } from './discovery.js';
import { readFileSync, statSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { atomicJson, commitAccountAndIndex, recoverAccountCommit, commitFileSet, recoverFileSet, sanitizeError } from './files.js';
import { ReentrantMutex } from './mutex.js';
import { validateAccountPolicy } from './account-policy.js';
import { withProcessLease } from './process-lock.js';
import { ProtobufReader } from './protobuf.js';
import { decodeTopicRow } from './account-state.js';
import {
  MockKeychainAdapter,
  SystemKeychainAdapter,
  buildGoOauthPayload,
  syncAccountToKeychain,
  type KeychainAdapter,
} from './account-keychain.js';
import {
  CloudQuotaAuthorityError,
  clearLiveEndpointCache,
  cloudOriginFromCommand,
  cloudProviderContextFromCommand,
  extractTopicDataString,
  localRpcFetch,
  mergeSubscriptionTier,
  probeLiveLanguageServerOnce,
  readAntigravityStateDb,
  validCachedCloudProviderContext,
  type CloudProviderContext,
} from './account-probe.js';
import {
  applyFamilyWindows,
  familyWindowsFromGroups,
  mergeGroupsWithPrevious,
  mergeModelsWithPrevious,
  normalizeStoredGroups,
  resolveQuotaStaleSeconds,
} from './quota.js';
import {
  CodedAccountError,
  MISSING_OAUTH_CLIENT_PATTERN,
  accountCredentialReadiness,
  accountErrorCode,
  buildAccountQuotaOverview,
  cleanAndLocalizeRefreshError,
  computeAccountRemaining,
  computeAccountRevision,
  computeStandbyRefreshStatus,
  endpointHost,
  endpointPriority,
  evaluateStandbyCandidate,
  familyLabel,
  formatResetCountdown,
  fuseQuotaData,
  generateDeviceProfile,
  groupToQuotaGroup,
  hasExpiredQuotaWindow,
  localizeStoredQuotaError,
  modelQuotaFromNormalized,
  normalizedModelFromStored,
  pickNextReset,
  projectAccountForIpc,
  quotaSnapshotForRevision,
  refreshResetDescription,
  resolveEffectiveMonitoredModel,
  sanitizeJsonString,
  subscriptionTierRank,
  type Account,
  type AccountErrorCode,
  type AccountIndex,
  type AccountSummary,
  type AutoSwitchConfig,
  type AutoSwitchStrategy,
  type DeviceProfile,
  type LiveLanguageServerStatus,
  type ModelQuota,
  type QuotaBucket,
  type QuotaData,
  type QuotaGroup,
  type QuotaOverview,
  type QuotaOverviewWindowStatus,
  type QuotaRefreshState,
  type StandbyCandidateEvaluation,
  type StandbyRefreshMode,
  type StandbyRefreshStatus,
  type TokenData,
} from './account-quota.js';
import {
  CLOUD_CODE_LOAD_PROJECT_ENDPOINTS,
  QUOTA_API_ENDPOINTS,
  QUOTA_SUMMARY_ENDPOINTS,
  fetchCloudQuotaForAccount,
  getGoogleClientId,
  getGoogleClientSecret,
} from './account-cloud.js';

export {
  MockKeychainAdapter,
  SystemKeychainAdapter,
  buildGoOauthPayload,
  syncAccountToKeychain,
  type KeychainAdapter,
  CloudQuotaAuthorityError,
  cloudOriginFromCommand,
  cloudProviderContextFromCommand,
  localRpcFetch,
  mergeSubscriptionTier,
  validCachedCloudProviderContext,
  type CloudProviderContext,
  accountCredentialReadiness,
  accountErrorCode,
  cleanAndLocalizeRefreshError,
  CodedAccountError,
  computeAccountRevision,
  computeStandbyRefreshStatus,
  endpointHost,
  endpointPriority,
  evaluateStandbyCandidate,
  familyLabel,
  formatResetCountdown,
  generateDeviceProfile,
  localizeStoredQuotaError,
  type AccountErrorCode,
  groupToQuotaGroup,
  hasExpiredQuotaWindow,
  modelQuotaFromNormalized,
  normalizedModelFromStored,
  pickNextReset,
  projectAccountForIpc,
  quotaSnapshotForRevision,
  refreshResetDescription,
  resolveEffectiveMonitoredModel,
  resolveQuotaStaleSeconds,
  sanitizeJsonString,
  type Account,
  type AccountIndex,
  type AccountSummary,
  type AutoSwitchConfig,
  type AutoSwitchStrategy,
  type DeviceProfile,
  type LiveLanguageServerStatus,
  type ModelQuota,
  type QuotaBucket,
  type QuotaData,
  type QuotaGroup,
  type QuotaOverview,
  type QuotaOverviewWindowStatus,
  type QuotaRefreshState,
  type StandbyCandidateEvaluation,
  type StandbyRefreshMode,
  type StandbyRefreshStatus,
  type TokenData,
  CLOUD_CODE_LOAD_PROJECT_ENDPOINTS,
  QUOTA_API_ENDPOINTS,
  QUOTA_SUMMARY_ENDPOINTS,
  getGoogleClientId,
  getGoogleClientSecret,
};

const execFileAsync = promisify(execFile);

export class AccountsManager {
  private target: ApplicationTarget;
  private accountsDir: string;
  private indexPath: string;
  private autoSwitchPath: string;
  private tombstonesPath: string;
  private reconciled = false;
  private dirReadyPromise: Promise<void> | null = null;
  private inFlightRefreshes = new Map<string, Promise<Account>>();
  private mutex = new ReentrantMutex();
  private liveProbeCache: { status: LiveLanguageServerStatus; expiresAt: number } | null = null;
  private inFlightProbe: Promise<LiveLanguageServerStatus | null> | null = null;
  private inFlightForceProbe: Promise<LiveLanguageServerStatus | null> | null = null;
  private probeLiveOnceOverride?: typeof probeLiveLanguageServerOnce;
  private providerOverride?: CloudProviderContext;
  private providerContextCache: { value: CloudProviderContext; expiresAt: number } | null = null;
  private inFlightProviderContext: Promise<CloudProviderContext | null> | null = null;
  private indexCache: { mtimeMs: number; size: number; index: AccountIndex } | null = null;
  private configStaleCache: { mtimeMs: number; size: number; refreshMinutes: number; staleSeconds: number } | null = null;
  private accountCache = new Map<string, { mtimeMs: number; size: number; account: Account; digest: string; revision: string }>();
  private accountFileDigests = new WeakMap<Account, string>();
  private refreshSaveMeta = new WeakMap<Account, { expectedRefreshToken: string; isRefreshUpdate: boolean }>();

  private async withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    return this.mutex.run(() => withProcessLease(join(this.stateDir, 'accounts-write.lock'), action), { label: 'AccountsManager.writeLock' });
  }

  public async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    return this.withWriteLock(action);
  }

  constructor(private stateDir: string, options: { providerContext?: CloudProviderContext; target?: ApplicationTarget; probeLiveOnce?: typeof probeLiveLanguageServerOnce } = {}) {
    this.target = options.target ?? applicationTarget();
    this.providerOverride=options.providerContext;
    this.probeLiveOnceOverride = options.probeLiveOnce;
    this.accountsDir = join(stateDir, 'accounts');
    this.indexPath = join(stateDir, 'accounts.json');
    this.autoSwitchPath = join(stateDir, 'auto_switch.json');
    this.tombstonesPath = join(stateDir, 'accounts-deleted.json');
  }

  public invalidateRuntimeCaches(): void {
    this.liveProbeCache = null;
    clearLiveEndpointCache();
    this.desktopEmailCache = null;
    this.vscdbEmailCache = null;
    this.indexCache = null;
    this.configStaleCache = null;
    this.accountCache.clear();
    this.providerContextCache = null;
  }

  public getConfiguredQuotaRefreshMinutes(): number {
    return this.readConfiguredQuotaRefreshSettings().refreshMinutes;
  }

  public getConfiguredQuotaStaleSeconds(): number {
    return this.readConfiguredQuotaRefreshSettings().staleSeconds;
  }

  private readConfiguredQuotaRefreshSettings(): { refreshMinutes: number; staleSeconds: number } {
    const configPath = join(this.stateDir, 'config.json');
    try {
      const st = statSync(configPath);
      if (this.configStaleCache && this.configStaleCache.mtimeMs === st.mtimeMs && this.configStaleCache.size === st.size) {
        return this.configStaleCache;
      }
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
      const rawMins = typeof parsed?.quotaRefreshMinutes === 'number' && Number.isFinite(parsed.quotaRefreshMinutes)
        ? Math.floor(parsed.quotaRefreshMinutes)
        : 0;
      const staleSeconds = resolveQuotaStaleSeconds(rawMins);
      const next = { mtimeMs: st.mtimeMs, size: st.size, refreshMinutes: rawMins, staleSeconds };
      this.configStaleCache = next;
      return next;
    } catch {
      this.configStaleCache = null;
      return { refreshMinutes: 0, staleSeconds: 900 };
    }
  }

  public setTarget(target: ApplicationTarget): void {
    if (this.target.channel !== target.channel || this.target.appPath !== target.appPath) {
      this.invalidateRuntimeCaches();
      this.inFlightProbe = null;
      this.inFlightProviderContext = null;
    }
    this.target = target;
  }

  public getTarget(): ApplicationTarget {
    return this.target;
  }

  private async resolveProviderContext(fetchImpl: typeof fetch): Promise<CloudProviderContext | null> {
    if(this.providerOverride)return this.providerOverride;
    // Injected transports use explicit fixtures; production follows the signed desktop instance.
    if(fetchImpl!==globalThis.fetch)return null;
    const now=Date.now();
    if(this.providerContextCache&&now<this.providerContextCache.expiresAt)return this.providerContextCache.value;
    if(this.inFlightProviderContext)return await this.inFlightProviderContext;
    const task=(async():Promise<CloudProviderContext>=>{
      const candidate = this.target;
      const text=(await execFileAsync(resolvePsBinary(),['-ax','-ww','-o','args='],{timeout:3000})).stdout;
      let version = '';
      try {
        version = (await inspectBundle(candidate.appPath)).version;
      } catch {}
      const context = text.split('\n').map(line => cloudProviderContextFromCommand(line.trim(), version, candidate)).find(Boolean);
      const providerCachePath = join(this.stateDir, 'quota-provider-stable.json');
      if (context) {
        await atomicJson(providerCachePath, context);
        this.providerContextCache = { value: context, expiresAt: Date.now() + 15000 };
        return context;
      }
      try {
        const cached = JSON.parse(await readFile(providerCachePath, 'utf8')) as CloudProviderContext;
        if (validCachedCloudProviderContext(cached, version, candidate)) {
          this.providerContextCache = { value: cached, expiresAt: Date.now() + 15000 };
          return cached;
        }
      } catch {}
      throw new CloudQuotaAuthorityError(bt('accounts.err.provider_unverified'));
    })();
    this.inFlightProviderContext=task;
    try{return await task;}finally{this.inFlightProviderContext=null;}
  }

  /**
   * 删除标记（tombstone）：账号删除成功后记录 id+email。
   * 作用：崩溃/外部同步/异常残留把账号文件写回目录时，reconcile 不得把它当成“孤儿文件自愈”复活。
   * 用户显式重新添加/保存同一账号时清除标记。
   */
  private async loadTombstones(): Promise<{ id: string; email: string; at: number }[]> {
    try {
      const parsed = JSON.parse(await readFile(this.tombstonesPath, 'utf8'));
      return Array.isArray(parsed)
        ? parsed.filter((item: any) => item && typeof item.id === 'string' && typeof item.email === 'string')
        : [];
    } catch {
      return [];
    }
  }

  private async clearTombstones(id?: string | null, email?: string | null): Promise<void> {
    if (!id && !email) return;
    const list = await this.loadTombstones();
    if (list.length === 0) return;
    const key = (email || '').toLowerCase();
    const next = list.filter(item => item.id !== id && (!key || item.email.toLowerCase() !== key));
    if (next.length !== list.length) await atomicJson(this.tombstonesPath, next);
  }

  async init(): Promise<void> {
    if (!this.dirReadyPromise) {
      this.dirReadyPromise = mkdir(this.accountsDir, { recursive: true, mode: 0o700 }).then(() => undefined).catch(err => {
        this.dirReadyPromise = null;
        throw err;
      });
    }
    await this.dirReadyPromise;
    const journal = join(this.stateDir, 'account-delete-commit.json');
    let hasJournal = false;
    try {
      await lstat(journal);
      hasJournal = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (hasJournal) {
      await this.withWriteLock(async () => {
        let changes: { path: string }[];
        try { changes = JSON.parse(await readFile(journal, 'utf8')).changes; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        const accountPaths = (await readdir(this.accountsDir)).filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name)).map(name => join(this.accountsDir, name));
        for (const change of changes ?? []) if (typeof change.path === 'string' && change.path.startsWith(this.accountsDir + '/') && /^[a-zA-Z0-9_-]+\.json$/.test(change.path.slice(this.accountsDir.length+1))) accountPaths.push(change.path);
        await recoverFileSet(journal, [this.indexPath, this.tombstonesPath, ...accountPaths]);
        this.indexCache = null;
        this.accountCache.clear();
        this.reconciled = false;
      });
    }
    if (!this.reconciled) {
      this.reconciled = true;
      await this.reconcileIndex().catch(() => {});
    }
  }

  /**
   * accounts/ 是事实来源，accounts.json 只是可重建的索引：进程可能在"账号文件已写、
   * 索引未写"之间崩溃，而 loadIndex() 对语法合法的旧索引不会自动 rebuild，
   * 该账号就会永久不出现在列表里。启动时对齐一次目录与索引即可自愈。
   */
  private async reconcileIndex(): Promise<void> {
    const index = await this.loadIndex();
    const names = (await readdir(this.accountsDir).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
    const files = new Set(names.map(name => name.slice(0, -5)));
    const ids = new Set(index.accounts.map(account => account.id));
    const tombstones = await this.loadTombstones();
    const tombIds = new Set(tombstones.map(item => item.id));
    const tombEmails = new Set(tombstones.map(item => item.email.toLowerCase()));
    let dirty = files.size !== ids.size;
    if (!dirty) for (const id of files) if (!ids.has(id)) { dirty = true; break; }
    if (!dirty) for (const id of ids) if (!files.has(id)) { dirty = true; break; }
    // 已删除账号的文件重新出现（外部同步/异常残留）时，必须重建索引以清除，不得复活。
    if (!dirty) for (const id of files) if (tombIds.has(id)) { dirty = true; break; }
    if (!dirty) for (const summary of index.accounts) {
      if (tombIds.has(summary.id) || tombEmails.has(String(summary.email || '').toLowerCase())) { dirty = true; break; }
    }
    if (!dirty) {
      for (const summary of index.accounts) {
        const entry = await this.peekAccountEntry(summary.id);
        if (!entry) {
          dirty = true;
          break;
        }
        const acc = entry.account;
        if (summary.revision && entry.revision !== summary.revision) {
          dirty = true;
          break;
        }
        if (!summary.revision && (acc.email !== summary.email || acc.name !== summary.name || Boolean(acc.disabled) !== Boolean(summary.disabled))) {
          dirty = true;
          break;
        }
      }
    }
    if (dirty) await this.rebuildIndex();
  }

  async loadIndex(): Promise<AccountIndex> {
    await this.init();
    let hasCommitJournal = false;
    try {
      await lstat(`${this.indexPath}.commit.json`);
      hasCommitJournal = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (hasCommitJournal) {
      await this.withWriteLock(() => recoverAccountCommit(this.indexPath));
    }
    try {
      const st = await lstat(this.indexPath);
      if (this.indexCache && this.indexCache.mtimeMs === st.mtimeMs && this.indexCache.size === st.size) {
        return structuredClone(this.indexCache.index);
      }
      const raw = await readFile(this.indexPath);
      const sanitized = sanitizeJsonString(raw);
      if (sanitized.trim()) {
        const parsed = JSON.parse(sanitized);
        if (parsed && Array.isArray(parsed.accounts)) {
          const cleanAccounts = parsed.accounts.map((acc: AccountSummary) => ({
            ...acc,
            quota_refresh_error: acc.quota_refresh_error && /双周期|dual window/i.test(acc.quota_refresh_error) ? null : acc.quota_refresh_error,
            quota: acc.quota ? {
              ...acc.quota,
              subscription_tier: acc.quota.subscription_tier,
            } : acc.quota,
          }));
          const result: AccountIndex = {
            version: '2.0',
            accounts: cleanAccounts,
            current_account_id: parsed.current_account_id ?? null,
            current_target_ide: parsed.current_target_ide ?? null,
            current_ide_account_id: parsed.current_ide_account_id ?? null,
            current_vscode_account_id: parsed.current_vscode_account_id ?? null,
          };
          this.indexCache = { mtimeMs: st.mtimeMs, size: st.size, index: structuredClone(result) };
          return result;
        }
      }
    } catch {
      // Index missing or corrupted, attempt recovery
    }

    return await this.rebuildIndex();
  }

  async saveIndex(index: AccountIndex): Promise<void> {
    await this.init();
    return this.withWriteLock(async () => {
      await atomicJson(this.indexPath, index);
      this.indexCache = null;
    });
  }

  async rebuildIndex(): Promise<AccountIndex> {
    await this.init();
    return this.withWriteLock(async () => {
      let previous: Partial<AccountIndex> = {};
      try { previous = JSON.parse(await readFile(this.indexPath, 'utf8')); } catch {}
      const files = await readdir(this.accountsDir).catch(() => []);
      const summaries: AccountSummary[] = [];
      const tombstones = await this.loadTombstones();
      const tombIds = new Set(tombstones.map(item => item.id));
      const tombEmails = new Set(tombstones.map(item => item.email.toLowerCase()));

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(this.accountsDir, file));
          const acc = JSON.parse(sanitizeJsonString(raw)) as Account;
          if (acc && acc.id && (tombIds.has(acc.id) || tombEmails.has(String(acc.email || '').toLowerCase()))) {
            // 已删除账号的残留文件：清理而不是复活。
            await unlink(join(this.accountsDir, file)).catch(() => {});
            continue;
          }
          if (acc && acc.id && acc.email) {
            summaries.push({
              id: acc.id,
              email: acc.email,
              name: acc.name,
              disabled: acc.disabled ?? false,
              disabled_reason: acc.disabled_reason,
              disabled_at: acc.disabled_at,
              protected_models: acc.protected_models ?? [],
              created_at: acc.created_at ?? Date.now() / 1000,
              last_used: acc.last_used ?? Date.now() / 1000,
              custom_label: acc.custom_label,
              quota: acc.quota,
              quota_refresh_error: acc.quota_refresh_error,
              quota_refresh_error_code: acc.quota_refresh_error_code ?? null,
              revision: computeAccountRevision(acc),
              quota_last_updated: acc.quota?.last_updated ?? 0,
            });
          }
        } catch {
          // ignore corrupted single account file
        }
      }

      // Sort by last_used desc
      const order = new Map((Array.isArray(previous.accounts) ? previous.accounts : []).map((a, i) => [a.id, i]));
      summaries.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || (b.last_used ?? 0) - (a.last_used ?? 0));
      const index: AccountIndex = {
        ...previous,
        version: '2.0',
        accounts: summaries,
        current_account_id: summaries.some(a => a.id === previous.current_account_id) ? previous.current_account_id! : summaries[0]?.id ?? null,
      };
      await atomicJson(this.indexPath, index);
      this.indexCache = null;
      return index;
    });
  }

  private async peekAccountEntry(id: string): Promise<{ account: Account; digest: string; revision: string } | null> {
    await this.init();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(bt('accounts.err.invalid_id'));
    const filePath = join(this.accountsDir, `${id}.json`);
    try {
      const st = await lstat(filePath);
      const cached = this.accountCache.get(id);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        return cached;
      }
      const raw = await readFile(filePath);
      const acc = JSON.parse(sanitizeJsonString(raw)) as Account;
      if (!acc) return null;
      if (acc.quota_refresh_error && /双周期|dual window/i.test(acc.quota_refresh_error)) {
        acc.quota_refresh_error = null;
      }
      const digest = createHash('sha256').update(raw).digest('hex');
      const revision = computeAccountRevision(acc);
      const entry = { mtimeMs: st.mtimeMs, size: st.size, account: acc, digest, revision };
      this.accountCache.set(id, entry);
      return entry;
    } catch (error) {
      this.accountCache.delete(id);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(bt('accounts.err.corrupt_file'));
    }
  }

  async getAccount(id: string): Promise<Account | null> {
    const entry = await this.peekAccountEntry(id);
    if (!entry) return null;
    const clone = structuredClone(entry.account);
    this.accountFileDigests.set(clone, entry.digest);
    return clone;
  }

  async saveAccount(
    account: Account,
    options?: { expectedRefreshToken?: string; expectedFileDigest?: string; isRefreshUpdate?: boolean }
  ): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(account.id)) throw new CodedAccountError('invalid_id', bt('accounts.err.invalid_id'));
    await this.init();

    return this.withWriteLock(async () => {
      const meta = this.refreshSaveMeta.get(account);
      const expectedRefresh = options?.expectedRefreshToken ?? meta?.expectedRefreshToken;
      const isRefreshUpdate = options?.isRefreshUpdate ?? meta?.isRefreshUpdate ?? false;

      const accountPath = join(this.accountsDir, `${account.id}.json`);
      const diskAccount = await this.getAccount(account.id);
      const expectedFileDigest = options?.expectedFileDigest ?? this.accountFileDigests.get(account);
      const diskDigest = diskAccount ? this.accountFileDigests.get(diskAccount) : undefined;
      if (!isRefreshUpdate && expectedFileDigest && (!diskAccount || expectedFileDigest !== diskDigest)) throw new CodedAccountError('conflict_modified', bt('accounts.err.conflict_modified'));

      if (expectedRefresh !== undefined && diskAccount) {
        if (diskAccount.token.refresh_token !== expectedRefresh) {
          throw new CodedAccountError('credentials_updated', bt('accounts.err.credentials_updated'));
        }
      }

      if (isRefreshUpdate && !diskAccount) {
        throw new CodedAccountError('deleted_stop_refresh', bt('accounts.err.deleted_stop_refresh', { id: account.id }));
      }

      let toSave: Account = account;
      if (isRefreshUpdate && diskAccount) {
        toSave = {
          ...diskAccount,
          name: diskAccount.name || account.name,
          token: {
            ...diskAccount.token,
            ...account.token,
          },
          custom_label: diskAccount.custom_label,
          disabled: diskAccount.disabled,
          disabled_reason: diskAccount.disabled_reason,
          disabled_at: diskAccount.disabled_at,
          protected_models: diskAccount.protected_models,
          created_at: diskAccount.created_at,
          quota: account.quota,
          quota_refresh_error: account.quota_refresh_error,
          quota_refresh_error_code: account.quota_refresh_error_code ?? null,
        };
      }

      if (diskAccount?.insiders_quota && !toSave.insiders_quota) {
        toSave = { ...toSave, insiders_quota: diskAccount.insiders_quota,
          insiders_quota_refresh_error: diskAccount.insiders_quota_refresh_error };
      }

      // 显式保存/重新添加同一账号时撤销删除标记；刷新写入不得复活已删除账号。
      if (!isRefreshUpdate) await this.clearTombstones(toSave.id, toSave.email);

      // Update index summary
      const index = await this.loadIndex();
      const summary: AccountSummary = {
        id: toSave.id,
        email: toSave.email,
        name: toSave.name,
        disabled: toSave.disabled,
        disabled_reason: toSave.disabled_reason,
        disabled_at: toSave.disabled_at,
        protected_models: toSave.protected_models ?? [],
        created_at: toSave.created_at,
        last_used: toSave.last_used,
        custom_label: toSave.custom_label,
        quota: toSave.quota,
        quota_refresh_error: toSave.quota_refresh_error,
        quota_refresh_error_code: toSave.quota_refresh_error_code ?? null,
        revision: computeAccountRevision(toSave),
        quota_last_updated: toSave.quota?.last_updated ?? 0,
      };

      const existingIdx = index.accounts.findIndex(a => a.id === toSave.id);
      if (existingIdx >= 0) {
        index.accounts[existingIdx] = summary;
      } else {
        index.accounts.unshift(summary);
      }

      if (!index.current_account_id) {
        index.current_account_id = toSave.id;
      }
      // 成对原子写入账号文件与索引文件，杜绝两次独立落盘中间崩溃引起的索引不一致
      await commitAccountAndIndex(accountPath, toSave, this.indexPath, index);
      this.indexCache = null;
      this.accountCache.delete(toSave.id);
      const nextDigest = createHash('sha256').update(await readFile(accountPath)).digest('hex');
      this.accountFileDigests.set(account, nextDigest);
      this.accountFileDigests.set(toSave, nextDigest);
    });
  }

  /**
   * 原子读-改-写：在锁内读取最新账号数据，执行 mutator，然后落盘更新，
   * 彻底杜绝先读出旧快照、再覆盖期间并发更新（如配额刷新）的 Lost Update 问题。
   */
  async updateAccount<T>(id: string, mutate: (current: Account) => T | Promise<T>): Promise<{ account: Account; result: T }> {
    await this.init();
    return this.withWriteLock(async () => {
      const current = await this.getAccount(id);
      if (!current) throw new Error(bt('accounts.err.not_found_by_id', { id }));
      const result = await mutate(current);
      await this.saveAccount(current);
      return { account: current, result };
    });
  }

  async renameAccount(id: string, name: string): Promise<Account> {
    if (typeof name !== "string" || name.trim().length > 80) throw new Error(bt('accounts.err.name_too_long'));
    return (await this.updateAccount(id, current => { current.name = name.trim() || current.email.split('@')[0] || current.email; })).account;
  }

  private static parseExplicitExpiryTimestamp(rawExpiryTs: unknown, rawExpiryIso: unknown): number | undefined {
    if (typeof rawExpiryTs === 'number' && Number.isFinite(rawExpiryTs) && rawExpiryTs > 0) {
      return rawExpiryTs > 1e11 ? Math.floor(rawExpiryTs / 1000) : Math.floor(rawExpiryTs);
    }
    if (typeof rawExpiryTs === 'string' && /^\d+(\.\d+)?$/.test(rawExpiryTs.trim())) {
      const num = Number(rawExpiryTs.trim());
      if (Number.isFinite(num) && num > 0) {
        return num > 1e11 ? Math.floor(num / 1000) : Math.floor(num);
      }
    }
    if (typeof rawExpiryIso === 'string' && rawExpiryIso.trim()) {
      const ms = Date.parse(rawExpiryIso.trim());
      if (Number.isFinite(ms) && ms > 0) {
        return Math.floor(ms / 1000);
      }
    }
    return undefined;
  }

  async upsertAccount(data: any): Promise<Account> {
    await this.init();
    return this.withWriteLock(async () => {
      const index = await this.loadIndex();
      const email = String(data.email ?? data.token?.email ?? data.id_token_email ?? '').trim();
      const existingSummary = index.accounts.find(
        a => (email && a.email.toLowerCase() === email.toLowerCase()) || (data.id && a.id === data.id)
      );

      let account: Account;
      if (data.id && !/^[a-zA-Z0-9_-]+$/.test(String(data.id))) throw new Error(bt('accounts.err.invalid_id'));
      const now = Math.floor(Date.now() / 1000);
      const refreshToken = data.refreshToken ?? data.refresh_token ?? data.token?.refresh_token ?? data.token?.refreshToken;
      const accessToken = data.accessToken ?? data.access_token ?? data.token?.access_token ?? data.token?.accessToken;
      const rawExpiresIn = data.expiresIn ?? data.expires_in ?? data.token?.expires_in ?? data.token?.expiresIn;
      const expiresIn = typeof rawExpiresIn === 'number' && Number.isFinite(rawExpiresIn) ? Math.floor(rawExpiresIn) : undefined;
      const explicitExpiryTs = AccountsManager.parseExplicitExpiryTimestamp(
        data.expiryTimestamp ?? data.expiry_timestamp ?? data.token?.expiry_timestamp ?? data.token?.expiryTimestamp,
        data.expiry ?? data.token?.expiry
      );
      const customLabel = data.custom_label !== undefined ? data.custom_label : data.customLabel;
      const name = data.name;
      const projectId = data.projectId !== undefined ? data.projectId : (data.project_id !== undefined ? data.project_id : (data.token?.project_id !== undefined ? data.token.project_id : data.token?.projectId));
      const oauthClientKey = data.oauthClientKey !== undefined ? data.oauthClientKey : (data.oauth_client_key !== undefined ? data.oauth_client_key : (data.token?.oauth_client_key !== undefined ? data.token.oauth_client_key : data.token?.oauthClientKey));
      const isGcpTos = data.isGcpTos !== undefined ? data.isGcpTos : (data.is_gcp_tos !== undefined ? data.is_gcp_tos : (data.token?.is_gcp_tos !== undefined ? data.token.is_gcp_tos : data.token?.isGcpTos));
      const idToken = data.idToken !== undefined ? data.idToken : (data.id_token !== undefined ? data.id_token : (data.token?.id_token !== undefined ? data.token.id_token : data.token?.idToken));
      const tokenType = data.token_type ?? data.tokenType ?? data.token?.token_type ?? data.token?.tokenType;

      if (existingSummary) {
        const existing = (await this.getAccount(existingSummary.id))!;
        const hasNewCreds = Boolean(refreshToken || (accessToken && accessToken !== 'pending_refresh'));
        const resolvedExpiryTs = explicitExpiryTs !== undefined
          ? explicitExpiryTs
          : (expiresIn !== undefined ? now + expiresIn : existing.token.expiry_timestamp);
        const resolvedExpiresIn = explicitExpiryTs !== undefined
          ? (expiresIn ?? Math.max(0, explicitExpiryTs - now))
          : (expiresIn ?? existing.token.expires_in);
        const refreshTokenChanged = Boolean(refreshToken && refreshToken !== existing.token.refresh_token);
        const existingAccessValid = Boolean(
          existing.token.access_token && existing.token.access_token !== 'pending_refresh'
        );
        const incomingAccessValid = Boolean(accessToken && accessToken !== 'pending_refresh');
        // Never regress a fresher valid access_token on the same refresh_token with an older/expired disk snapshot.
        const preserveExistingAccess =
          !refreshTokenChanged &&
          existingAccessValid &&
          Number.isFinite(existing.token.expiry_timestamp) &&
          (!incomingAccessValid || existing.token.expiry_timestamp > resolvedExpiryTs);
        const finalAccessToken = preserveExistingAccess
          ? existing.token.access_token
          : (accessToken ?? existing.token.access_token);
        const finalExpiryTs = preserveExistingAccess ? existing.token.expiry_timestamp : resolvedExpiryTs;
        const finalExpiresIn = preserveExistingAccess ? existing.token.expires_in : resolvedExpiresIn;
        const hadMissingOAuthClientError =
          existing.quota_refresh_error_code === 'missing_oauth_client' ||
          (typeof existing.quota_refresh_error === 'string' && MISSING_OAUTH_CLIENT_PATTERN.test(existing.quota_refresh_error.trim()));
        const hasUsableAccessToken = Boolean(
          finalAccessToken &&
          finalAccessToken !== 'pending_refresh' &&
          Number.isFinite(finalExpiryTs) &&
          finalExpiryTs > now + 300
        );
        const oauthConfigured = Boolean(getGoogleClientId() && getGoogleClientSecret());
        const shouldClearQuotaRefreshError =
          hasNewCreds && (!hadMissingOAuthClientError || refreshTokenChanged || hasUsableAccessToken || oauthConfigured);
        account = {
          ...existing,
          name: name !== undefined ? name : existing.name,
          custom_label: customLabel !== undefined ? customLabel : existing.custom_label,
          disabled: false,
          disabled_reason: null,
          disabled_at: null,
          ...(shouldClearQuotaRefreshError ? {
            quota_refresh_error: null,
            quota_refresh_error_code: null,
          } : {}),
          ...(hasNewCreds ? {
            validation_blocked: false,
            validation_blocked_until: null,
            validation_blocked_reason: null,
            validation_url: null,
          } : {}),
          token: {
            ...existing.token,
            refresh_token: refreshToken || existing.token.refresh_token,
            access_token: finalAccessToken,
            expires_in: finalExpiresIn,
            expiry_timestamp: finalExpiryTs,
            token_type: typeof tokenType === 'string' && tokenType ? tokenType : (existing.token.token_type || 'Bearer'),
            email: email || existing.token.email || existing.email,
            project_id: projectId !== undefined ? projectId : existing.token.project_id,
            oauth_client_key: oauthClientKey !== undefined ? oauthClientKey : existing.token.oauth_client_key,
            is_gcp_tos: isGcpTos !== undefined ? Boolean(isGcpTos) : existing.token.is_gcp_tos,
            id_token: idToken !== undefined ? idToken : existing.token.id_token,
          },
        };
      } else {
        if (!refreshToken) throw new CodedAccountError('missing_refresh_token', bt('accounts.err.missing_refresh_token'));
        if (!email) throw new CodedAccountError('missing_email', bt('accounts.err.missing_email'));
        const id = data.id || randomUUID();
        const resolvedExpiryTs = explicitExpiryTs !== undefined
          ? explicitExpiryTs
          : now + (expiresIn ?? 3600);
        const exp = explicitExpiryTs !== undefined
          ? (expiresIn ?? Math.max(0, explicitExpiryTs - now))
          : (expiresIn ?? 3600);
        account = {
          id,
          email,
          name: name ?? null,
          token: {
            access_token: accessToken ?? 'pending_refresh',
            refresh_token: refreshToken,
            expires_in: exp,
            expiry_timestamp: resolvedExpiryTs,
            token_type: typeof tokenType === 'string' && tokenType ? tokenType : 'Bearer',
            email,
            project_id: projectId ?? null,
            oauth_client_key: oauthClientKey ?? null,
            is_gcp_tos: Boolean(isGcpTos ?? false),
            id_token: idToken ?? null,
          },
          device_profile: generateDeviceProfile(),
          quota: null,
          disabled: false,
          protected_models: Array.isArray(data.protected_models) ? data.protected_models.filter((m: unknown): m is string => typeof m === 'string') : [],
          validation_blocked: false,
          created_at: typeof data.created_at === 'number' && Number.isFinite(data.created_at) ? Math.floor(data.created_at) : now,
          last_used: typeof data.last_used === 'number' && Number.isFinite(data.last_used) ? Math.floor(data.last_used) : now,
          custom_label: customLabel ?? null,
        };
      }

      await this.saveAccount(account);
      return account;
    });
  }

  private static extractCandidatesFromParsedJson(parsed: unknown): { items: any[]; isIndexOnly: boolean } {
    if (Array.isArray(parsed)) {
      return { items: parsed, isIndexOnly: false };
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.accounts)) {
        const items = obj.accounts;
        const hasAnyCredentials = items.some((item: any) =>
          Boolean(item && typeof item === 'object' && (item.refresh_token || item.refreshToken || item.token?.refresh_token || item.token?.refreshToken))
        );
        if (items.length > 0 && !hasAnyCredentials && ('current_account_id' in obj || obj.version === '2.0')) {
          return { items: [], isIndexOnly: true };
        }
        return { items, isIndexOnly: false };
      }
      return { items: [obj], isIndexOnly: false };
    }
    return { items: [], isIndexOnly: false };
  }

  /**
   * 批量从 JSON 文件或目录导入账号（单锁批量事务，仅按标准化 email 去重，隔离外部 id 碰撞）
   */
  async importAccountsFromJson(rawPaths: unknown): Promise<{
    imported: number;
    updated: number;
    skipped: Array<{ source: string; reason: string }>;
    expiredWithoutRefreshConfig: number;
  }> {
    if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
      throw new Error(bt('accounts.import.err.no_paths'));
    }
    const inputPaths = Array.from(new Set(
      rawPaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map(p => resolve(p.trim()))
    ));
    if (inputPaths.length === 0) {
      throw new Error(bt('accounts.import.err.no_paths'));
    }

    const MAX_FILE_BYTES = 2 * 1024 * 1024;
    const MAX_ACCOUNTS_PER_IMPORT = 200;
    const uid = process.getuid?.();
    const skipped: Array<{ source: string; reason: string }> = [];
    const candidateFiles: string[] = [];
    const seenFiles = new Set<string>();

    for (const inputPath of inputPaths) {
      const st = await lstat(inputPath).catch(() => null);
      if (!st) {
        skipped.push({ source: inputPath, reason: bt('accounts.import.err.not_found') });
        continue;
      }
      if (st.isSymbolicLink() || (uid !== undefined && st.uid !== uid)) {
        skipped.push({ source: inputPath, reason: bt('accounts.import.err.unsafe_file') });
        continue;
      }
      if (st.isDirectory()) {
        const entries = await readdir(inputPath, { withFileTypes: true }).catch(() => null);
        if (!entries) {
          skipped.push({ source: inputPath, reason: bt('accounts.import.err.unreadable') });
          continue;
        }
        const jsonEntries = entries
          .filter(e => e.name.toLowerCase().endsWith('.json') && e.name !== 'accounts.json' && e.name !== 'accounts-deleted.json' && e.name !== 'auto_switch.json')
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of jsonEntries) {
          const childPath = join(inputPath, entry.name);
          if (seenFiles.has(childPath)) continue;
          const childSt = await lstat(childPath).catch(() => null);
          if (!childSt || !childSt.isFile() || childSt.isSymbolicLink() || (uid !== undefined && childSt.uid !== uid)) {
            skipped.push({ source: childPath, reason: bt('accounts.import.err.unsafe_file') });
            continue;
          }
          if (childSt.size > MAX_FILE_BYTES) {
            skipped.push({ source: childPath, reason: bt('accounts.import.err.file_too_large') });
            continue;
          }
          seenFiles.add(childPath);
          candidateFiles.push(childPath);
        }
      } else if (st.isFile()) {
        if (st.size > MAX_FILE_BYTES) {
          skipped.push({ source: inputPath, reason: bt('accounts.import.err.file_too_large') });
          continue;
        }
        if (!seenFiles.has(inputPath)) {
          seenFiles.add(inputPath);
          candidateFiles.push(inputPath);
        }
      } else {
        skipped.push({ source: inputPath, reason: bt('accounts.import.err.unsafe_file') });
      }
    }

    const rawRecords: Array<{ source: string; data: any }> = [];
    for (const filePath of candidateFiles) {
      let rawBuf: Buffer;
      try {
        rawBuf = await readFile(filePath);
      } catch {
        skipped.push({ source: filePath, reason: bt('accounts.import.err.unreadable') });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(sanitizeJsonString(rawBuf));
      } catch {
        skipped.push({ source: filePath, reason: bt('accounts.import.err.invalid_json') });
        continue;
      }
      const extracted = AccountsManager.extractCandidatesFromParsedJson(parsed);
      if (extracted.isIndexOnly) {
        skipped.push({ source: filePath, reason: bt('accounts.import.err.index_file') });
        continue;
      }
      if (extracted.items.length === 0) {
        skipped.push({ source: filePath, reason: bt('accounts.import.err.empty_records') });
        continue;
      }
      for (let i = 0; i < extracted.items.length; i++) {
        if (rawRecords.length >= MAX_ACCOUNTS_PER_IMPORT) {
          skipped.push({ source: `${filePath}#${i + 1}`, reason: bt('accounts.import.err.limit_exceeded', { max: MAX_ACCOUNTS_PER_IMPORT }) });
          continue;
        }
        rawRecords.push({
          source: extracted.items.length > 1 ? `${filePath}#${i + 1}` : filePath,
          data: extracted.items[i],
        });
      }
    }

    await this.init();
    return this.withWriteLock(async () => {
      const index = await this.loadIndex();
      const now = Math.floor(Date.now() / 1000);
      const oauthConfigured = Boolean(getGoogleClientId() && getGoogleClientSecret());
      let imported = 0;
      let updated = 0;
      let expiredWithoutRefreshConfig = 0;
      const clearedEmails = new Set<string>();
      const clearedIds = new Set<string>();
      const touchedEmailStatus = new Map<string, boolean>();

      for (const { source, data } of rawRecords) {
        if (!data || typeof data !== 'object') {
          skipped.push({ source, reason: bt('accounts.import.err.invalid_record') });
          continue;
        }
        const email = String(data.email ?? data.token?.email ?? data.id_token_email ?? '').trim().toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith('@antigravity.user')) {
          skipped.push({ source, reason: bt('accounts.import.err.invalid_email') });
          continue;
        }
        const rawRefresh = data.refreshToken ?? data.refresh_token ?? data.token?.refresh_token ?? data.token?.refreshToken;
        const refreshToken = typeof rawRefresh === 'string' ? rawRefresh.trim() : '';
        if (!refreshToken || refreshToken.length > 8192 || /[\r\n\x00]/.test(refreshToken)) {
          skipped.push({ source, reason: bt('accounts.import.err.missing_refresh_token') });
          continue;
        }
        const parseOptionalCleanString = (val: unknown, maxLen: number): string | null | undefined => {
          if (val === undefined) return undefined;
          if (val === null) return null;
          if (typeof val !== 'string' || /[\x00]/.test(val)) return undefined;
          const trimmed = val.trim();
          if (!trimmed) return null;
          return trimmed.slice(0, maxLen);
        };
        const rawAccess = data.accessToken ?? data.access_token ?? data.token?.access_token ?? data.token?.accessToken;
        const cleanAccess = typeof rawAccess === 'string' && !/[\r\n\x00]/.test(rawAccess) ? rawAccess.trim().slice(0, 8192) : '';
        const accessToken = cleanAccess || 'pending_refresh';
        const rawExpiresIn = data.expiresIn ?? data.expires_in ?? data.token?.expires_in ?? data.token?.expiresIn;
        const expiresIn = typeof rawExpiresIn === 'number' && Number.isFinite(rawExpiresIn) && rawExpiresIn >= 0 ? Math.floor(rawExpiresIn) : undefined;
        const explicitExpiryTs = AccountsManager.parseExplicitExpiryTimestamp(
          data.expiryTimestamp ?? data.expiry_timestamp ?? data.token?.expiry_timestamp ?? data.token?.expiryTimestamp,
          data.expiry ?? data.token?.expiry
        );
        const customLabel = parseOptionalCleanString(
          data.custom_label !== undefined ? data.custom_label : data.customLabel,
          80
        );
        const name = parseOptionalCleanString(data.name, 80);
        const projectId = parseOptionalCleanString(
          data.projectId !== undefined ? data.projectId : (data.project_id !== undefined ? data.project_id : (data.token?.project_id !== undefined ? data.token.project_id : data.token?.projectId)),
          256
        );
        const oauthClientKey = parseOptionalCleanString(
          data.oauthClientKey !== undefined ? data.oauthClientKey : (data.oauth_client_key !== undefined ? data.oauth_client_key : (data.token?.oauth_client_key !== undefined ? data.token.oauth_client_key : data.token?.oauthClientKey)),
          128
        );
        const isGcpTos = data.isGcpTos !== undefined ? data.isGcpTos : (data.is_gcp_tos !== undefined ? data.is_gcp_tos : (data.token?.is_gcp_tos !== undefined ? data.token.is_gcp_tos : data.token?.isGcpTos));
        const idToken = parseOptionalCleanString(
          data.idToken !== undefined ? data.idToken : (data.id_token !== undefined ? data.id_token : (data.token?.id_token !== undefined ? data.token.id_token : data.token?.idToken)),
          16384
        );
        const tokenType = data.token_type ?? data.tokenType ?? data.token?.token_type ?? data.token?.tokenType;

        const emailKey = email.toLowerCase();
        // 严格仅按标准化小写 email 匹配现有账号，绝不按外部 JSON 里的 id 匹配覆盖其他邮箱
        const existingIdx = index.accounts.findIndex(a => a.email.toLowerCase() === emailKey);
        const existingSummary = existingIdx >= 0 ? index.accounts[existingIdx] : undefined;
        const existing = existingSummary ? await this.getAccount(existingSummary.id).catch(() => null) : null;

        let toSave: Account;
        if (existing && existingSummary) {
          const refreshTokenChanged = refreshToken !== existing.token.refresh_token;
          const nextAccessToken = rawAccess !== undefined
            ? accessToken
            : (refreshTokenChanged ? 'pending_refresh' : existing.token.access_token);
          const forceResetExpiry =
            nextAccessToken === 'pending_refresh' &&
            explicitExpiryTs === undefined &&
            expiresIn === undefined;
          const resolvedExpiryTs = forceResetExpiry
            ? 0
            : explicitExpiryTs !== undefined
              ? explicitExpiryTs
              : (expiresIn !== undefined ? now + expiresIn : existing.token.expiry_timestamp);
          const resolvedExpiresIn = forceResetExpiry
            ? 0
            : explicitExpiryTs !== undefined
              ? Math.max(0, explicitExpiryTs - now)
              : (expiresIn ?? existing.token.expires_in);
          toSave = {
            ...existing,
            email: existing.email || email,
            name: name !== undefined ? name : existing.name,
            custom_label: customLabel !== undefined ? customLabel : existing.custom_label,
            disabled: false,
            disabled_reason: null,
            disabled_at: null,
            quota_refresh_error: null,
            quota_refresh_error_code: null,
            validation_blocked: false,
            validation_blocked_until: null,
            validation_blocked_reason: null,
            validation_url: null,
            ...(Array.isArray(data.protected_models) ? {
              protected_models: data.protected_models.filter((m: unknown): m is string => typeof m === 'string'),
            } : {}),
            token: {
              ...existing.token,
              refresh_token: refreshToken,
              access_token: nextAccessToken,
              expires_in: resolvedExpiresIn,
              expiry_timestamp: resolvedExpiryTs,
              token_type: typeof tokenType === 'string' && tokenType ? tokenType : (existing.token.token_type || 'Bearer'),
              email: email,
              project_id: projectId !== undefined ? projectId : existing.token.project_id,
              oauth_client_key: oauthClientKey !== undefined ? oauthClientKey : existing.token.oauth_client_key,
              is_gcp_tos: isGcpTos !== undefined ? Boolean(isGcpTos) : existing.token.is_gcp_tos,
              id_token: idToken !== undefined ? idToken : existing.token.id_token,
            },
          };
          updated += 1;
        } else {
          // 新增账号始终由 GravityBox 自行生成本地 UUID，杜绝外部 id 碰撞
          const id = randomUUID();
          const resolvedExpiryTs = explicitExpiryTs !== undefined
            ? explicitExpiryTs
            : (expiresIn !== undefined ? now + expiresIn : (accessToken === 'pending_refresh' ? 0 : now + 3600));
          const exp = explicitExpiryTs !== undefined
            ? Math.max(0, explicitExpiryTs - now)
            : (expiresIn ?? (accessToken === 'pending_refresh' ? 0 : 3600));
          toSave = {
            id,
            email,
            name: name ?? null,
            token: {
              access_token: accessToken,
              refresh_token: refreshToken,
              expires_in: exp,
              expiry_timestamp: resolvedExpiryTs,
              token_type: typeof tokenType === 'string' && tokenType ? tokenType : 'Bearer',
              email,
              project_id: projectId ?? null,
              oauth_client_key: oauthClientKey ?? null,
              is_gcp_tos: Boolean(isGcpTos ?? false),
              id_token: idToken ?? null,
            },
            device_profile: generateDeviceProfile(),
            quota: null,
            disabled: false,
            protected_models: Array.isArray(data.protected_models) ? data.protected_models.filter((m: unknown): m is string => typeof m === 'string') : [],
            validation_blocked: false,
            created_at: typeof data.created_at === 'number' && Number.isFinite(data.created_at) && data.created_at > 0 ? Math.floor(data.created_at) : now,
            last_used: typeof data.last_used === 'number' && Number.isFinite(data.last_used) && data.last_used > 0 ? Math.floor(data.last_used) : now,
            custom_label: customLabel ?? null,
          };
          imported += 1;
        }

        const accountPath = join(this.accountsDir, `${toSave.id}.json`);
        await atomicJson(accountPath, toSave);
        this.accountCache.delete(toSave.id);
        clearedEmails.add(emailKey);
        clearedIds.add(toSave.id);

        const isExpiredOrMissingAccess =
          !toSave.token.access_token ||
          toSave.token.access_token === 'pending_refresh' ||
          !Number.isFinite(toSave.token.expiry_timestamp) ||
          toSave.token.expiry_timestamp <= now + 60;
        touchedEmailStatus.set(emailKey, !oauthConfigured && isExpiredOrMissingAccess);

        const summary: AccountSummary = {
          id: toSave.id,
          email: toSave.email,
          name: toSave.name,
          disabled: toSave.disabled,
          disabled_reason: toSave.disabled_reason,
          disabled_at: toSave.disabled_at,
          protected_models: toSave.protected_models ?? [],
          created_at: toSave.created_at,
          last_used: toSave.last_used,
          custom_label: toSave.custom_label,
          quota: toSave.quota,
          quota_refresh_error: toSave.quota_refresh_error,
          quota_refresh_error_code: toSave.quota_refresh_error_code ?? null,
          revision: computeAccountRevision(toSave),
          quota_last_updated: toSave.quota?.last_updated ?? 0,
        };
        if (existingIdx >= 0) {
          index.accounts[existingIdx] = summary;
        } else {
          index.accounts.push(summary);
        }
        if (!index.current_account_id) {
          index.current_account_id = toSave.id;
        }
      }

      if (imported + updated > 0) {
        if (clearedEmails.size > 0 || clearedIds.size > 0) {
          const tombstones = await this.loadTombstones();
          if (tombstones.length > 0) {
            const nextTombstones = tombstones.filter(item => !clearedIds.has(item.id) && !clearedEmails.has(item.email.toLowerCase()));
            if (nextTombstones.length !== tombstones.length) {
              await atomicJson(this.tombstonesPath, nextTombstones);
            }
          }
        }
        await atomicJson(this.indexPath, index);
        this.indexCache = null;
      }

      for (const isExpiredNoOAuth of touchedEmailStatus.values()) {
        if (isExpiredNoOAuth) expiredWithoutRefreshConfig += 1;
      }

      return {
        imported,
        updated,
        skipped,
        expiredWithoutRefreshConfig,
      };
    });
  }

  /**
   * 导出全量账号备份 JSON（强制 confirmed === true，由后端直接以 0600 权限原子落盘，IPC 零凭据返回）
   */
  async exportAccountsBackup(targetPath: string, confirmed: boolean): Promise<{ path: string; count: number }> {
    if (confirmed !== true) {
      throw new Error(bt('accounts.export.err.confirm_required'));
    }
    const cleanPath = typeof targetPath === 'string' ? targetPath.trim() : '';
    if (!cleanPath) {
      throw new Error(bt('accounts.export.err.invalid_path'));
    }
    const resolvedPath = resolve(cleanPath);
    const resolvedStateDir = resolve(this.stateDir);
    const relToState = relative(resolvedStateDir, resolvedPath).replaceAll('\\', '/');
    if (
      relToState === '' ||
      (!relToState.startsWith('..') &&
        !isAbsolute(relToState) &&
        /^(?:accounts\.json|accounts(?:\/|\\|$)|config\.json|account-switch-|usage-|usage\.|rate-locks|remote_pricing\.json|api_pricing\.json|pricing_sync_state\.json|live-ide-models\.json)/i.test(relToState))
    ) {
      throw new Error(bt('accounts.export.err.invalid_path'));
    }
    const uid = process.getuid?.();
    const parentDir = dirname(resolvedPath);
    const parentInfo = await lstat(parentDir).catch(() => null);
    if (!parentInfo || !parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (uid !== undefined && parentInfo.uid !== uid)) {
      throw new Error(bt('accounts.export.err.invalid_parent'));
    }
    const existingInfo = await lstat(resolvedPath).catch((err: NodeJS.ErrnoException) => {
      if (err?.code === 'ENOENT') return null;
      throw err;
    });
    if (existingInfo && (!existingInfo.isFile() || existingInfo.isSymbolicLink() || (uid !== undefined && existingInfo.uid !== uid))) {
      throw new Error(bt('files.refuse_non_user_file'));
    }

    await this.init();
    return this.withWriteLock(async () => {
      const index = await this.loadIndex();
      const exportedAccounts: Array<Record<string, unknown>> = [];
      for (const summary of index.accounts) {
        const acc = await this.getAccount(summary.id);
        if (!acc || !acc.token?.refresh_token) continue;
        exportedAccounts.push({
          email: acc.email,
          name: acc.name ?? null,
          custom_label: acc.custom_label ?? null,
          protected_models: acc.protected_models ?? [],
          created_at: acc.created_at,
          last_used: acc.last_used,
          token: {
            access_token: acc.token.access_token,
            refresh_token: acc.token.refresh_token,
            token_type: acc.token.token_type || 'Bearer',
            expires_in: acc.token.expires_in,
            expiry_timestamp: acc.token.expiry_timestamp,
            email: acc.token.email ?? acc.email,
            project_id: acc.token.project_id ?? null,
            oauth_client_key: acc.token.oauth_client_key ?? null,
            is_gcp_tos: Boolean(acc.token.is_gcp_tos),
            id_token: acc.token.id_token ?? null,
          },
        });
      }
      if (exportedAccounts.length === 0) {
        throw new Error(bt('accounts.export.err.no_accounts'));
      }
      const exportedIso = new Date().toISOString();
      const payload = {
        schema: 'gravitybox.accounts.backup',
        version: '1.0',
        exportedAt: exportedIso,
        exported_at: exportedIso,
        accounts: exportedAccounts,
      };
      await atomicJson(resolvedPath, payload);
      return { path: resolvedPath, count: exportedAccounts.length };
    });
  }

  async addAccountWithRefreshToken(raw: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<Account> {
    const refreshToken = String(raw).trim();
    if (!refreshToken || refreshToken.length > 8192 || /[\r\n\x00]/.test(refreshToken)) throw new CodedAccountError('invalid_refresh_token', bt('accounts.err.invalid_refresh_token'));
    const clientId = getGoogleClientId(), clientSecret = getGoogleClientSecret();
    if (fetchImpl === globalThis.fetch && (!clientId || !clientSecret)) {
      throw new CodedAccountError('missing_oauth_client', bt('oauth.err.missing_client'));
    }
    const tokenReply = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', signal: AbortSignal.timeout(6000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
    }).catch(() => { throw new CodedAccountError('token_network', bt('accounts.err.token_network')); });
    if (!tokenReply.ok) throw new CodedAccountError('token_invalid', bt('accounts.err.token_invalid'));
    const token: any = await tokenReply.json();
    if (typeof token.access_token !== 'string' || !token.access_token) throw new CodedAccountError('token_no_access', bt('accounts.err.token_no_access'));
    const identityReply = await fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(6000),
    }).catch(() => { throw new CodedAccountError('identity_verify_failed', bt('accounts.err.identity_verify_failed')); });
    if (!identityReply.ok) throw new CodedAccountError('identity_verify_failed', bt('accounts.err.identity_verify_failed'));
    const identity: any = await identityReply.json();
    if (typeof identity.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(identity.email) || identity.verified_email === false) throw new CodedAccountError('email_unverified', bt('accounts.err.email_unverified'));
    return this.upsertAccount({ email: identity.email, name: identity.name, accessToken: token.access_token,
      refreshToken: token.refresh_token || refreshToken, expiresIn: Number(token.expires_in) || 3600, idToken: token.id_token });
  }

  async addAccountFromOAuth(token: { access_token: string; refresh_token: string; expires_in?: number; id_token?: string }, signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch): Promise<void> {
    const reply = await fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    if (!reply.ok) throw new CodedAccountError('oauth_verify_failed', bt('accounts.err.oauth_verify_failed'));
    const identity: any = await reply.json();
    if (typeof identity.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(identity.email) || identity.verified_email !== true) throw new CodedAccountError('oauth_unverified_email', bt('accounts.err.oauth_unverified_email'));
    signal.throwIfAborted();
    await this.upsertAccount({ email: identity.email, name: identity.name, accessToken: token.access_token,
      refreshToken: token.refresh_token, expiresIn: Number(token.expires_in) || 3600, idToken: token.id_token });
  }

  async deleteAccount(id: string): Promise<boolean> {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(bt('accounts.err.invalid_id'));
    await this.init();
    return this.withWriteLock(async () => {
      const index = await this.loadIndex();
      const summary = index.accounts.find(item => item.id === id);
      const existing = await this.getAccount(id);
      const email = existing?.email ?? summary?.email ?? '';
      const accountPath = join(this.accountsDir, `${id}.json`);
      const tombstones = (await this.loadTombstones()).filter(item => item.id !== id && item.email.toLowerCase() !== email.toLowerCase());
      if (summary || existing) tombstones.push({ id, email, at: Math.floor(Date.now()/1000) });
      index.accounts = index.accounts.filter(a => a.id !== id);
      if (index.current_account_id === id) index.current_account_id = null;
      const original = await readFile(accountPath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (original !== null) {
        const removedDir = join(this.stateDir, 'accounts-removed');
        await mkdir(removedDir, { recursive: true, mode: 0o700 });
        const parsedOriginal = JSON.parse(original);
        const redactedAccount = parsedOriginal && typeof parsedOriginal === 'object'
          ? {
              ...parsedOriginal,
              token: parsedOriginal.token && typeof parsedOriginal.token === 'object'
                ? {
                    redacted: true,
                    email: parsedOriginal.token.email ?? null,
                    project_id: parsedOriginal.token.project_id ?? null,
                    token_type: parsedOriginal.token.token_type ?? null,
                  }
                : undefined,
            }
          : null;
        await atomicJson(join(removedDir, `${id}-${Date.now()}.json`), {
          schema: 1, removedAt: new Date().toISOString(), account: redactedAccount,
        });
        try {
          const entries = (await readdir(removedDir)).filter(f => f.endsWith('.json'));
          if (entries.length > 10) {
            const withTime = await Promise.all(entries.map(async name => {
              const p = join(removedDir, name);
              const st = await lstat(p).catch(() => null);
              return { p, mtime: st?.mtimeMs ?? 0 };
            }));
            withTime.sort((a, b) => a.mtime - b.mtime);
            for (const stale of withTime.slice(0, withTime.length - 10)) {
              await unlink(stale.p).catch(() => {});
            }
          }
        } catch {}
      }
      await commitFileSet(join(this.stateDir, 'account-delete-commit.json'), [
        { path: this.tombstonesPath, after: JSON.stringify(tombstones.slice(-500), null, 2)+'\n' },
        { path: accountPath, after: null },
        { path: this.indexPath, after: JSON.stringify(index, null, 2)+'\n' },
      ]);
      this.indexCache = null;
      this.accountCache.delete(id);
      return true;
    });
  }

  async reorderAccounts(ids: string[]): Promise<AccountIndex> {
    return this.withWriteLock(async () => {
      const index = await this.loadIndex();
      const idMap = new Map(index.accounts.map(a => [a.id, a]));
      const reordered: AccountSummary[] = [];

      for (const id of ids) {
        const item = idMap.get(id);
        if (item) {
          reordered.push(item);
          idMap.delete(id);
        }
      }
      // Append remaining
      for (const remaining of idMap.values()) {
        reordered.push(remaining);
      }

      index.accounts = reordered;
      await this.saveIndex(index);
      return index;
    });
  }

  async setCurrentAccount(id: string, target?: 'app' | 'ide' | 'vscode' | 'all'): Promise<void> {
    await this.init();
    return this.withWriteLock(async () => {
      const index = await this.loadIndex();
      if (!index.accounts.some(a => a.id === id)) {
        throw new Error(bt('accounts.err.not_found_simple', { id }));
      }

      const now = Math.floor(Date.now() / 1000);
      const acc = await this.getAccount(id);
      if (acc) {
        acc.last_used = now;
        await this.saveAccount(acc);
      }

      const latest = await this.loadIndex();
      switch (target) {
        case 'ide':
          latest.current_ide_account_id = id;
          break;
        case 'vscode':
          latest.current_vscode_account_id = id;
          break;
        case 'all':
          latest.current_account_id = id;
          latest.current_ide_account_id = id;
          latest.current_vscode_account_id = id;
          break;
        default:
          latest.current_account_id = id;
          break;
      }

      latest.current_target_ide = target ?? 'app';
      await this.saveIndex(latest);
      this.desktopEmailCache = null;
      this.liveProbeCache = null;
    });
  }

  // ---- 额度与监控双窗口熔合体系 ----

  fuseQuota(fetchAvailableModelsData: any, quotaSummaryData?: any): QuotaData {
    return fuseQuotaData(fetchAvailableModelsData, quotaSummaryData);
  }

  // ---- 智能轮换调度策略配置与推荐算法 ----

  async getAutoSwitchConfig(): Promise<AutoSwitchConfig> {
    try {
      const raw = await readFile(this.autoSwitchPath, 'utf8');
      const parsed = JSON.parse(raw);
      validateAccountPolicy(parsed);
      const reserve = Math.min(98, Math.max(1, Number(parsed.reserve_percentage ?? parsed.reservePercentage) || 10));
      const candidateMin = Math.min(100, Math.max(2, Number(parsed.candidate_min_percentage ?? parsed.candidateMinPercentage) || 30));
      if (reserve >= candidateMin) throw Error(bt('accounts.err.threshold_relation'));
      return {
        enabled: parsed.enabled ?? false,
        strategy: parsed.strategy === 'round_robin' ? 'round_robin' : 'priority',
        reserve_percentage: reserve,
        reservePercentage: reserve,
        candidate_min_percentage: candidateMin,
        candidateMinPercentage: candidateMin,
        monitored_model: parsed.monitored_model ?? 'all',
        candidate_account_ids: Array.isArray(parsed.candidate_account_ids) ? parsed.candidate_account_ids : [],
        last_switched_id: parsed.last_switched_id ?? undefined,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error(bt('accounts.err.policy_corrupted'));
      return {
        enabled: false,
        strategy: 'priority',
        reserve_percentage: 10,
        reservePercentage: 10,
        candidate_min_percentage: 30,
        candidateMinPercentage: 30,
        monitored_model: 'all',
        candidate_account_ids: [],
      };
    }
  }

  private resolveValidatedPolicyConfig(
    config: Partial<AutoSwitchConfig> & Record<string, any>,
    current: AutoSwitchConfig
  ): AutoSwitchConfig {
    validateAccountPolicy(config);
    const reserveRaw = config.reserve_percentage ?? config.reservePercentage;
    if (reserveRaw !== undefined) {
      const num = Number(reserveRaw);
      if (isNaN(num) || num < 1 || num > 98) {
        throw new Error(bt('accounts.err.reserve_range'));
      }
    }
    const candidateMinRaw = config.candidate_min_percentage ?? config.candidateMinPercentage;
    if (candidateMinRaw !== undefined) {
      const num = Number(candidateMinRaw);
      if (isNaN(num) || num < 2 || num > 100) {
        throw new Error(bt('accounts.err.candidate_range'));
      }
    }
    const reserve = reserveRaw !== undefined ? Number(reserveRaw) : current.reserve_percentage;
    const candidateMin = candidateMinRaw !== undefined ? Number(candidateMinRaw) : current.candidate_min_percentage;
    if (reserve >= candidateMin) {
      throw new Error(bt('accounts.err.threshold_gt'));
    }
    return {
      enabled: config.enabled !== undefined ? Boolean(config.enabled) : current.enabled,
      strategy: config.strategy !== undefined ? (config.strategy === 'round_robin' ? 'round_robin' : 'priority') : current.strategy,
      reserve_percentage: reserve,
      reservePercentage: reserve,
      candidate_min_percentage: candidateMin,
      candidateMinPercentage: candidateMin,
      monitored_model: config.monitored_model !== undefined ? config.monitored_model : current.monitored_model,
      candidate_account_ids: Array.isArray(config.candidate_account_ids) ? config.candidate_account_ids : current.candidate_account_ids,
      last_switched_id: config.last_switched_id !== undefined ? (config.last_switched_id ?? undefined) : current.last_switched_id,
    };
  }

  async setAutoSwitchConfig(config: Partial<AutoSwitchConfig> & Record<string, any>): Promise<AutoSwitchConfig> {
    validateAccountPolicy(config);
    await this.init();
    return this.withWriteLock(async () => {
      const current = await this.getAutoSwitchConfig();
      const updated = this.resolveValidatedPolicyConfig(config, current);
      await atomicJson(this.autoSwitchPath, updated);
      return updated;
    });
  }

  async recordAutoSwitchChoice(accountId: string): Promise<void> {
    await this.setAutoSwitchConfig({ last_switched_id: accountId });
  }

  /**
   * 提取账号指定模型的可用额度百分比（结合 5 小时与周额度进行双窗口熔合与硬拦截）
   */
  getAccountRemaining(account: Account, monitoredModel = 'all'): number | null {
    return computeAccountRemaining(account, monitoredModel, {
      staleAfterSeconds: this.getConfiguredQuotaStaleSeconds(),
    });
  }

  private subscriptionTierRank(account: Account | AccountSummary | null | undefined): number {
    return subscriptionTierRank(account);
  }

  /**
   * 智能挑选最佳切号候选账号（高阶订阅 ULTRA > PRO > FREE 优先，杜绝把免费账号优先推荐于 PRO 账号之上）
   */
  async selectBestAccount(config?: Partial<AutoSwitchConfig> & Record<string, any>, options?: { currentId?:string; currentEmail?:string; currentQuota?:QuotaData }): Promise<{
    currentAccount: Account | null;
    bestCandidate: Account | null;
    shouldSwitch: boolean;
    reason: string;
  }> {
    if (config !== undefined) validateAccountPolicy(config);
    const savedCfg = await this.getAutoSwitchConfig();
    const cfg = config !== undefined ? this.resolveValidatedPolicyConfig(config, savedCfg) : savedCfg;
    const index = await this.loadIndex();
    const currentId = options?.currentId ?? index.current_account_id;
    const storedCurrent = currentId ? await this.getAccount(currentId) : null;
    const currentAccount = storedCurrent && options?.currentQuota && options.currentEmail?.toLowerCase()===storedCurrent.email.toLowerCase()
      ? {...storedCurrent,quota:options.currentQuota} : storedCurrent;

    if (!cfg.enabled) {
      return {
        currentAccount,
        bestCandidate: null,
        shouldSwitch: false,
        reason: bt('accounts.recommend.disabled'),
      };
    }

    if (!currentAccount) {
      return { currentAccount: null, bestCandidate: null, shouldSwitch: false, reason: bt('accounts.recommend.no_current') };
    }

    const effectiveModel = resolveEffectiveMonitoredModel(currentAccount, cfg.monitored_model);
    const currentRem = this.getAccountRemaining(currentAccount, effectiveModel);
    const isLow = currentRem !== null && currentRem <= cfg.reserve_percentage;

    const candidateIds = cfg.candidate_account_ids.length > 0
      ? cfg.candidate_account_ids.filter(id => id !== currentId)
      : index.accounts.map(a => a.id).filter(id => id !== currentId);

    const candidates: Account[] = [];
    for (const cid of candidateIds) {
      const acc = await this.getAccount(cid);
      if (acc) candidates.push(acc);
    }

    // Filter valid & evaluate each candidate across fresh / snapshot / cooldown_elapsed tiers
    const nowMs = Date.now();
    const staleAfterSeconds = this.getConfiguredQuotaStaleSeconds();
    type ScoredCandidate = { acc: Account; evalResult: StandbyCandidateEvaluation; tierRank: number };
    const allValidScored: ScoredCandidate[] = [];
    for (const acc of candidates) {
      const evalResult = evaluateStandbyCandidate(acc, cfg.monitored_model, {
        staleAfterSeconds,
        nowMs,
        minPercentage: cfg.candidate_min_percentage,
      });
      if (!evalResult) continue;
      allValidScored.push({ acc, evalResult, tierRank: this.subscriptionTierRank(acc) });
    }

    if (allValidScored.length === 0) {
      return {
        currentAccount,
        bestCandidate: null,
        shouldSwitch: false,
        reason: bt('accounts.recommend.no_candidates'),
      };
    }

    // 优先在付费高阶账号（ULTRA / PRO / 企业待确认）中挑选；仅当没有任何达标高阶账号时才回退考虑 FREE 账号
    const paidScored = allValidScored.filter(item => item.tierRank >= 2);
    const validScored = paidScored.length > 0 ? paidScored : allValidScored;

    let bestItem: ScoredCandidate;
    if (cfg.strategy === 'round_robin') {
      // 环形轮询：基于全局候选全集池 poolOrder 与游标选择下一个可用账号（包含 fresh/snapshot/cooldown_elapsed）
      const poolOrder = cfg.candidate_account_ids.length > 0
        ? cfg.candidate_account_ids
        : index.accounts.map(a => a.id);
      const cursorId = (cfg.last_switched_id && poolOrder.includes(cfg.last_switched_id))
        ? cfg.last_switched_id
        : currentId;
      const cursorIndex = cursorId ? poolOrder.indexOf(cursorId) : -1;
      if (cursorIndex !== -1) {
        let chosen: ScoredCandidate | undefined;
        for (let i = 1; i < poolOrder.length; i++) {
          const nextId = poolOrder[(cursorIndex + i) % poolOrder.length]!;
          if (nextId === currentId) continue;
          const candidate = validScored.find(item => item.acc.id === nextId);
          if (candidate) {
            chosen = candidate;
            break;
          }
        }
        bestItem = chosen ?? validScored[0]!;
      } else {
        bestItem = validScored[0]!;
      }
    } else {
      // Priority: 先按套餐等级（ULTRA > PRO > 待确认 > FREE）降序，同等级按 fresh(rem desc) > snapshot(rem desc) > cooldown_elapsed(earliestResetMs asc)
      const tierPriority = (tier: StandbyCandidateEvaluation['tier']): number =>
        tier === 'fresh' ? 0 : tier === 'snapshot' ? 1 : 2;
      validScored.sort((a, b) => {
        const tierDiff = b.tierRank - a.tierRank;
        if (tierDiff !== 0) return tierDiff;
        const kindDiff = tierPriority(a.evalResult.tier) - tierPriority(b.evalResult.tier);
        if (kindDiff !== 0) return kindDiff;
        if (a.evalResult.tier === 'cooldown_elapsed') {
          return (a.evalResult.earliestResetMs ?? Number.MAX_SAFE_INTEGER)
            - (b.evalResult.earliestResetMs ?? Number.MAX_SAFE_INTEGER);
        }
        return (b.evalResult.remaining ?? 0) - (a.evalResult.remaining ?? 0);
      });
      bestItem = validScored[0]!;
    }

    const best = bestItem.acc;
    const bestRem = bestItem.evalResult.remaining ?? 0;
    const bestDisplay = best.name ? `${best.name} (${best.email})` : best.email;
    // 当前为 PRO/ULTRA 而唯一候选为 FREE 时，除非当前账号已彻底耗尽（0%），否则不主动触发向免费账号的降级推荐
    const isDowngradeToFree = this.subscriptionTierRank(currentAccount) >= 2 && this.subscriptionTierRank(best) < 2;
    const effectiveShouldSwitch = isLow && (!isDowngradeToFree || (currentRem !== null && currentRem <= 0));

    const switchReason = !effectiveShouldSwitch
      ? isLow && isDowngradeToFree
        ? bt('accounts.recommend.only_free')
        : currentRem === null
        ? bt('accounts.recommend.unknown')
        : bt('accounts.recommend.sufficient', { currentRem })
      : bestItem.evalResult.tier === 'cooldown_elapsed'
      ? bt('accounts.recommend.should_switch_reset', { currentRem, bestDisplay })
      : bestItem.evalResult.tier === 'snapshot'
      ? bt('accounts.recommend.should_switch_snapshot', { currentRem, bestDisplay, bestRem })
      : bt('accounts.recommend.should_switch', { currentRem, bestDisplay, bestRem });

    return {
      currentAccount,
      bestCandidate: best,
      shouldSwitch: effectiveShouldSwitch,
      reason: switchReason,
    };
  }

  /**
   * 探测运行中的 Antigravity language_server 本地 RPC 端口与 CSRF Token (双接口免密联动)
   */
  async probeLiveLanguageServer(fetchImpl: typeof fetch = globalThis.fetch, options: { forceRefresh?: boolean } = {}): Promise<LiveLanguageServerStatus | null> {
    if (process.env.GRAVITYBOX_PROBE_LS === 'false') return null;
    const now = Date.now();
    const forceRefresh = options.forceRefresh === true;
    if (fetchImpl === globalThis.fetch && !forceRefresh && this.liveProbeCache && now < this.liveProbeCache.expiresAt) {
      return this.liveProbeCache.status;
    }
    if (fetchImpl === globalThis.fetch) {
      const activeFlight = forceRefresh ? this.inFlightForceProbe : (this.inFlightForceProbe ?? this.inFlightProbe);
      if (activeFlight) return await activeFlight;
    }

    const doProbe = () => (this.probeLiveOnceOverride ?? probeLiveLanguageServerOnce)(this.target, fetchImpl, options, {
      modelQuotaFromNormalized,
      groupToQuotaGroup,
    });

    if (fetchImpl !== globalThis.fetch) {
      return await doProbe();
    }

    const probePromise = doProbe();
    if (forceRefresh) this.inFlightForceProbe = probePromise;
    else this.inFlightProbe = probePromise;
    try {
      const res = await probePromise;
      this.liveProbeCache = res !== null ? { status: res, expiresAt: Date.now() + 5000 } : null;
      return res;
    } finally {
      if (forceRefresh) {
        if (this.inFlightForceProbe === probePromise) this.inFlightForceProbe = null;
      } else if (this.inFlightProbe === probePromise) {
        this.inFlightProbe = null;
      }
    }
  }

  private static buildExtractedOAuthToken(rawToken: any, fallbackEmail: string | null): { token: TokenData; email: string | null } {
    const nowSec = Math.floor(Date.now() / 1000);
    const explicitTs = AccountsManager.parseExplicitExpiryTimestamp(rawToken.expiry_timestamp, rawToken.expiry);
    const accessToken = typeof rawToken.access_token === 'string' ? rawToken.access_token : '';
    const isEpochZeroIso = typeof rawToken.expiry === 'string' && rawToken.expiry.trim().length > 0 && Date.parse(rawToken.expiry.trim()) === 0;
    const hasZeroExpiry =
      rawToken.expiry_timestamp === 0 ||
      isEpochZeroIso ||
      rawToken.expires_in === 0 ||
      !accessToken ||
      accessToken === 'pending_refresh';
    const expiryTs = explicitTs ?? (hasZeroExpiry ? 0 : nowSec + (Number(rawToken.expires_in) || 3600));
    const email = rawToken.email || fallbackEmail || null;
    return {
      token: {
        access_token: accessToken,
        refresh_token: rawToken.refresh_token,
        expires_in: rawToken.expires_in ?? (expiryTs > nowSec ? expiryTs - nowSec : 0),
        expiry_timestamp: expiryTs,
        token_type: rawToken.token_type || 'Bearer',
        email,
        project_id: rawToken.project_id || null,
        is_gcp_tos: Boolean(rawToken.is_gcp_tos),
        id_token: rawToken.id_token || null,
      },
      email,
    };
  }

  private static shouldPreferTokenCandidate(current: TokenData, candidate: TokenData, nowSec: number): boolean {
    const hasValidAccess = (t: TokenData): boolean =>
      Boolean(t.access_token && t.access_token !== 'pending_refresh');
    const getExpiry = (t: TokenData): number =>
      Number.isFinite(t.expiry_timestamp) ? t.expiry_timestamp : 0;

    const curValid = hasValidAccess(current);
    const candValid = hasValidAccess(candidate);
    if (candValid !== curValid) return candValid;
    if (!candValid) return false;

    const curExp = getExpiry(current);
    const candExp = getExpiry(candidate);
    const curUnexpired = curExp > nowSec;
    const candUnexpired = candExp > nowSec;
    if (candUnexpired !== curUnexpired) return candUnexpired;
    return candExp > curExp;
  }

  private async readLocalSessionCredentials(options?: {
    keychain?: KeychainAdapter;
    homeDir?: string;
    appSupportDir?: string;
    profileDir?: string;
    expectedEmail?: string;
    strictSandboxGuard?: boolean;
  }): Promise<{ token: TokenData | null; email: string | null }> {
    const defaultStateDir = defaultGravityBoxStateDir(homedir());
    const isDefaultStateDir = this.stateDir === defaultStateDir;
    const defaultProfileDir = join(defaultAppSupportDir(homedir()), this.target.name);
    const hasCustomTargetProfile = resolve(this.target.profile) !== resolve(defaultProfileDir);
    if (
      options?.strictSandboxGuard
      && options.homeDir === undefined
      && options.appSupportDir === undefined
      && options.keychain === undefined
      && options.profileDir === undefined
      && !isDefaultStateDir
      && !hasCustomTargetProfile
    ) {
      return { token: null, email: null };
    }

    const homeDir = options?.homeDir ?? homedir();
    const appSupportDir = options?.appSupportDir ?? defaultAppSupportDir(homedir());
    const isSandboxHome = homeDir !== homedir();
    const allowHostSessionFiles = options?.homeDir !== undefined || isDefaultStateDir;
    const allowHostKeychain = Boolean(options?.keychain) || (!isSandboxHome && isDefaultStateDir);
    const expectedLower = options?.expectedEmail?.trim().toLowerCase() ?? null;

    let extractedToken: TokenData | null = null;
    let extractedEmail: string | null = null;

    const readSessionToken = async () => {
      if (!allowHostSessionFiles) return;
      const candidates = [
        join(homeDir, '.gemini', 'jetski-standalone-oauth-token'),
        join(homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
      ];
      for (const p of candidates) {
        try {
          const raw = await readFile(p, 'utf8');
          const json = JSON.parse(raw);
          const t = json.token || json;
          if (t?.refresh_token) {
            const parsed = AccountsManager.buildExtractedOAuthToken(t, json.id_token_email || null);
            extractedToken = parsed.token;
            extractedEmail = parsed.email;
            return;
          }
        } catch {}
      }
    };

    // 1. 若在沙箱目录下，优先读取沙箱 session 文件，避免越界读取宿主真实 Keychain
    if (isSandboxHome) {
      await readSessionToken();
    }

    // 2. Keychain 优先读取 (显式传入 keychain 或非沙箱模式)
    if (!extractedToken && allowHostKeychain) {
      const keychain = options?.keychain ?? new SystemKeychainAdapter();
      try {
        const pass = await keychain.readPassword('gemini', 'antigravity');
        if (pass && pass.startsWith('go-keyring-base64:')) {
          const raw = Buffer.from(pass.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
          const parsed = JSON.parse(raw);
          if (parsed?.token?.refresh_token) {
            const extracted = AccountsManager.buildExtractedOAuthToken(parsed.token, parsed.id_token_email || null);
            extractedToken = extracted.token;
            extractedEmail = extracted.email;
          }
        }
      } catch {}
    }

    // 3. 检查本地 session 文件 (非沙箱模式回退)
    if (!extractedToken) {
      await readSessionToken();
    }

    // 4. 检查 state.vscdb：在非沙箱模式下始终核对以防旧 Keychain 掩盖较新会话，在沙箱模式下仅读取显式指定的目标配置目录
    const primaryProfileVscdb = join(options?.profileDir ?? this.target.profile, 'User', 'globalStorage', 'state.vscdb');
    const fallbackProfileVscdb = options?.appSupportDir
      ? join(appSupportDir, this.target.name, 'User', 'globalStorage', 'state.vscdb')
      : primaryProfileVscdb;
    const candidateVscdbPaths = isSandboxHome
      ? Array.from(new Set([
          ...(options?.appSupportDir ? [fallbackProfileVscdb] : []),
          ...(options?.profileDir || hasCustomTargetProfile ? [primaryProfileVscdb] : []),
        ]))
      : Array.from(new Set(
          options?.appSupportDir ? [fallbackProfileVscdb, primaryProfileVscdb] : [primaryProfileVscdb]
        ));

    for (const vscdbPath of candidateVscdbPaths) {
      const stateRows = await readAntigravityStateDb(vscdbPath, [
        'antigravityUnifiedStateSync.oauthToken',
        'antigravityUnifiedStateSync.userStatus',
        'antigravityUnifiedStateSync.enterprisePreferences',
      ]);
      if (stateRows.size === 0) continue;
      const oauthRawB64 = extractTopicDataString(stateRows.get('antigravityUnifiedStateSync.oauthToken'));
      const userStatusB64 = extractTopicDataString(stateRows.get('antigravityUnifiedStateSync.userStatus'));
      const entPrefB64 = extractTopicDataString(stateRows.get('antigravityUnifiedStateSync.enterprisePreferences'));
      let entProjectId: string | null = null;
      if (entPrefB64) {
        try {
          const entBuf = decodeTopicRow(entPrefB64, 'enterpriseGcpProjectId');
          if (entBuf) {
            entProjectId = ProtobufReader.findString(entBuf, 3) || null;
          }
        } catch {}
      }

      let vscdbEmail: string | null = null;
      if (userStatusB64) {
        try {
          const userBuf = decodeTopicRow(userStatusB64, 'userStatusSentinelKey');
          if (userBuf) {
            const email = ProtobufReader.findString(userBuf, 7);
            if (email) vscdbEmail = email;
          }
        } catch {}
      }

      let vscdbToken: TokenData | null = null;
      if (oauthRawB64) {
        try {
          const payloadBuf = decodeTopicRow(oauthRawB64, 'oauthTokenInfoSentinelKey');
          if (payloadBuf) {
            const accessToken = ProtobufReader.findString(payloadBuf, 1) || '';
            const refreshToken = ProtobufReader.findString(payloadBuf, 3) || '';
            const idToken = ProtobufReader.findString(payloadBuf, 5) || null;
            const gcpTosFlag = ProtobufReader.findVarint(payloadBuf, 6);
            const nowSec = Math.floor(Date.now() / 1000);
            let expirySec = accessToken ? nowSec + 3600 : 0;
            const timeBuf = ProtobufReader.findField(payloadBuf, 4);
            if (timeBuf) {
              const sec = ProtobufReader.findVarint(timeBuf, 1);
              if (sec !== null && sec >= 0) expirySec = sec;
            }
            if (refreshToken) {
              vscdbToken = {
                access_token: accessToken,
                refresh_token: refreshToken,
                expires_in: Math.max(0, expirySec - nowSec),
                expiry_timestamp: expirySec,
                token_type: 'Bearer',
                email: vscdbEmail,
                project_id: entProjectId,
                is_gcp_tos: Boolean(gcpTosFlag && gcpTosFlag > 0),
                id_token: idToken,
              };
            }
          }
        } catch {}
      }

      if (!extractedToken) {
        if (vscdbToken) {
          extractedToken = vscdbToken;
          extractedEmail = extractedEmail || vscdbEmail;
        }
      } else {
        const currentEmail = extractedEmail || extractedToken.email;
        if (vscdbToken) {
          const candidateEmail = vscdbEmail || vscdbToken.email;
          const sameRefresh = Boolean(
            vscdbToken.refresh_token &&
            extractedToken.refresh_token &&
            vscdbToken.refresh_token === extractedToken.refresh_token
          );
          const sameEmail = Boolean(
            currentEmail &&
            candidateEmail &&
            currentEmail.trim().toLowerCase() === candidateEmail.trim().toLowerCase()
          );
          const emailsConflict = Boolean(currentEmail && candidateEmail && !sameEmail);
          if (
            expectedLower
            && candidateEmail?.trim().toLowerCase() === expectedLower
            && currentEmail?.trim().toLowerCase() !== expectedLower
          ) {
            extractedToken = vscdbToken;
            extractedEmail = candidateEmail;
          } else if (!emailsConflict && (sameRefresh || sameEmail)) {
            const nowSec = Math.floor(Date.now() / 1000);
            const preferVscdb = AccountsManager.shouldPreferTokenCandidate(extractedToken, vscdbToken, nowSec);
            const winner = preferVscdb ? vscdbToken : extractedToken;
            const loser = preferVscdb ? extractedToken : vscdbToken;
            extractedToken = {
              ...winner,
              email: winner.email || loser.email || currentEmail || candidateEmail || null,
              project_id: winner.project_id || loser.project_id || entProjectId || null,
              id_token: winner.id_token || loser.id_token || null,
              is_gcp_tos: Boolean(winner.is_gcp_tos || loser.is_gcp_tos),
            };
            extractedEmail = extractedEmail || candidateEmail || null;
          }
        } else {
          const vscdbMatchesUser =
            !vscdbEmail ||
            !currentEmail ||
            vscdbEmail.trim().toLowerCase() === currentEmail.trim().toLowerCase();
          if (vscdbMatchesUser && !extractedToken.project_id && entProjectId) {
            extractedToken.project_id = entProjectId;
          }
        }
      }
      break;
    }

    return { token: extractedToken, email: extractedEmail };
  }

  /**
   * 只读采集本机当前活跃会话凭据（仅当邮箱严格匹配 expectedEmail 且 refresh_token 非空时返回）。
   */
  async harvestActiveSessionTokenIfMatched(
    expectedEmail: string,
    options?: {
      keychain?: KeychainAdapter;
      homeDir?: string;
      appSupportDir?: string;
      profileDir?: string;
    },
  ): Promise<{ token: TokenData; email: string } | null> {
    const expected = expectedEmail?.trim().toLowerCase();
    if (!expected) return null;
    const { token, email } = await this.readLocalSessionCredentials({
      ...options,
      expectedEmail,
      strictSandboxGuard: true,
    });
    if (!token || !token.refresh_token) return null;
    const resolvedEmail = (email || token.email || '').trim();
    if (!resolvedEmail || resolvedEmail.toLowerCase() !== expected) return null;
    return {
      token: token.email ? token : { ...token, email: resolvedEmail },
      email: resolvedEmail,
    };
  }

  /**
   * 仅当采集到的本机活跃会话邮箱严格匹配且 expiry_timestamp 比已存记录更新超过 60 秒时，更新账号凭据。
   */
  async harvestTokenForAccountId(
    id: string,
    options?: {
      keychain?: KeychainAdapter;
      homeDir?: string;
      appSupportDir?: string;
      profileDir?: string;
    },
  ): Promise<Account | null> {
    const account = await this.getAccount(id);
    if (!account || !account.email) return null;
    const harvested = await this.harvestActiveSessionTokenIfMatched(account.email, options);
    if (!harvested || !harvested.token.refresh_token) return null;
    const currentExp = Number.isFinite(account.token?.expiry_timestamp) ? account.token.expiry_timestamp : 0;
    if (!Number.isFinite(harvested.token.expiry_timestamp) || harvested.token.expiry_timestamp <= currentExp + 60) {
      return null;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const hasUsableAccess = Boolean(
      harvested.token.access_token
      && harvested.token.access_token !== 'pending_refresh'
      && harvested.token.expiry_timestamp > nowSec + 300,
    );
    const hadMissingOAuthErr =
      account.quota_refresh_error_code === 'missing_oauth_client'
      || (typeof account.quota_refresh_error === 'string' && MISSING_OAUTH_CLIENT_PATTERN.test(account.quota_refresh_error.trim()));
    const updated: Account = {
      ...account,
      token: {
        ...account.token,
        ...harvested.token,
        email: harvested.token.email || account.token.email || account.email,
        project_id: harvested.token.project_id ?? account.token.project_id ?? null,
        oauth_client_key: harvested.token.oauth_client_key ?? account.token.oauth_client_key ?? null,
        id_token: harvested.token.id_token ?? account.token.id_token ?? null,
      },
      ...(hadMissingOAuthErr && hasUsableAccess
        ? { quota_refresh_error: null, quota_refresh_error_code: null }
        : {}),
    };
    await this.saveAccount(updated);
    return (await this.getAccount(updated.id)) ?? updated;
  }

  /**
   * 提取当前系统/IDE真实登录态并存入账号池
   */
  async saveCurrentAccount(options?: {
    keychain?: KeychainAdapter;
    homeDir?: string;
    appSupportDir?: string;
  }): Promise<Account> {
    const homeDir = options?.homeDir ?? homedir();
    const isSandboxHome = homeDir !== homedir();
    let { token: extractedToken, email: extractedEmail } = await this.readLocalSessionCredentials(options);
    let extractedName: string | null = null;
    let liveQuota: QuotaData | null = null;

    // A live identity may enrich the same account, or provide the email for the active local session when state.vscdb is absent.
    if (!isSandboxHome && (extractedEmail || extractedToken)) {
      const lsStatus = await this.probeLiveLanguageServer(globalThis.fetch, { forceRefresh: true });
      if (lsStatus?.email && (!extractedEmail || lsStatus.email.trim().toLowerCase() === extractedEmail.trim().toLowerCase())) {
        extractedEmail = extractedEmail || lsStatus.email;
        extractedName = lsStatus.name || null;
        liveQuota = { ...lsStatus.quota, source: 'live' };
      }
    }

    if (!extractedToken || !extractedToken.refresh_token) {
      throw new Error(bt('accounts.err.no_active_login'));
    }

    if (extractedEmail && !extractedToken.email) {
      extractedToken.email = extractedEmail;
    }

    const email = extractedEmail || extractedToken.email;
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email) || email.endsWith('@antigravity.user')) throw new Error(bt('accounts.err.cannot_verify_email'));

    const account = await this.upsertAccount({
      email,
      name: extractedName || undefined,
      refreshToken: extractedToken.refresh_token,
      accessToken: extractedToken.access_token,
      expiryTimestamp: extractedToken.expiry_timestamp,
      expiresIn: Math.max(0, extractedToken.expiry_timestamp - Math.floor(Date.now() / 1000)),
      projectId: extractedToken.project_id || undefined,
      isGcpTos: extractedToken.is_gcp_tos,
      idToken: extractedToken.id_token || undefined,
    });

    if (liveQuota) {
      if (account.quota) {
        const old = account.quota;
        const liveGroupsOk = (liveQuota.quota_groups?.length ?? 0) > 0;
        const resolvedTier = mergeSubscriptionTier(liveQuota.subscription_tier, old.subscription_tier, {
          allowFreeDowngrade: liveGroupsOk,
        });
        const { groups, staleGroups } = mergeGroupsWithPrevious(
          normalizeStoredGroups(liveQuota.quota_groups, liveQuota.last_updated, 'live'),
          normalizeStoredGroups(old.quota_groups, old.last_updated ?? liveQuota.last_updated),
          Date.now()
        );
        const { models, carriedCount } = mergeModelsWithPrevious(
          liveQuota.models.map(m => normalizedModelFromStored(m, 'live')),
          (old.models ?? []).map(m => normalizedModelFromStored(m))
        );
        const missingWindows = groups.flatMap(g =>
          g.buckets.filter(b => b.stale).map(b => ({ family: g.family, window: b.window }))
        );
        const staleSeconds = this.getConfiguredQuotaStaleSeconds();
        const baseState = this.getAccountQuotaOverview({ quota: { ...liveQuota, subscription_tier: resolvedTier } }).refreshState;
        account.quota = {
          ...liveQuota,
          subscription_tier: resolvedTier,
          source: 'live',
          models: applyFamilyWindows(models, familyWindowsFromGroups(groups, Date.now(), staleSeconds)).map(modelQuotaFromNormalized),
          quota_groups: groups.map(groupToQuotaGroup),
          ...(staleGroups.length ? { stale_groups: staleGroups } : {}),
          refresh_state: {
            ...baseState,
            complete: baseState.complete && staleGroups.length === 0,
            missingWindows,
            carriedGroups: staleGroups.length,
            carriedModels: carriedCount,
          },
        };
      } else {
        account.quota = liveQuota;
      }
      account.quota_refresh_error = null;
      account.quota_refresh_error_code = null;
      await this.saveAccount(account);
    }

    await this.setCurrentAccount(account.id);
    this.invalidateRuntimeCaches();
    return (await this.getAccount(account.id)) ?? account;
  }

  /**
   * 获取账号额度综合概览（包含 3 分组 5 桶详细百分比、相对倒计时、套餐与 13 模型明细）
   */
  getAccountQuotaOverview(
    account: Account | AccountSummary | { quota?: QuotaData | null },
    options?: { nowMs?: number; staleAfterSeconds?: number },
  ): QuotaOverview {
    return buildAccountQuotaOverview(account, {
      ...options,
      staleAfterSeconds: options?.staleAfterSeconds ?? this.getConfiguredQuotaStaleSeconds(),
    });
  }

  /**
   * 刷新指定账号的 OAuth Token 与配额数据 (支持三级端点容灾与双窗口熔合)
   */
  private async saveRefreshedAccount(account: Account, expectedRefresh = account.token.refresh_token, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const latest = await this.getAccount(account.id);
    if (!latest) throw new CodedAccountError('removed_stop_refresh', bt('accounts.err.removed_stop_refresh'));
    if (latest.token.refresh_token !== expectedRefresh) throw new CodedAccountError('credentials_updated', bt('accounts.err.credentials_updated'));
    // Refresh work runs in the background; keep remarks, order, flags and usage edited meanwhile.
    const toSave: Account = {
      ...latest,
      name: latest.name || account.name,
      token: account.token,
      quota: account.quota,
      quota_refresh_error: account.quota_refresh_error,
      quota_refresh_error_code: account.quota_refresh_error_code ?? null,
    };
    this.refreshSaveMeta.set(toSave, { expectedRefreshToken: expectedRefresh, isRefreshUpdate: true });
    signal?.throwIfAborted();
    await this.saveAccount(toSave, { expectedRefreshToken: expectedRefresh, isRefreshUpdate: true });
  }

  async refreshQuota(
    id?: string,
    fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    options?: { signal?: AbortSignal }
  ): Promise<Account> {
    options?.signal?.throwIfAborted();
    const index = await this.loadIndex();
    const targetId = id || index.current_account_id;
    if (!targetId) {
      throw new Error(bt('accounts.err.no_target_id'));
    }

    const inFlight = this.inFlightRefreshes.get(targetId);
    if (inFlight) {
      const sig = options?.signal;
      if (!sig) return await inFlight;
      return await new Promise<Account>((resolve, reject) => {
        const onAbort = () => reject(sig.reason instanceof Error ? sig.reason : new DOMException('Aborted', 'AbortError'));
        if (sig.aborted) {
          onAbort();
          return;
        }
        sig.addEventListener('abort', onAbort, { once: true });
        inFlight.then(
          val => {
            sig.removeEventListener('abort', onAbort);
            resolve(val);
          },
          err => {
            sig.removeEventListener('abort', onAbort);
            reject(err);
          }
        );
      });
    }

    const job = (async () => {
      try {
        options?.signal?.throwIfAborted();
        const account = await this.refreshQuotaFromProvider(targetId, fetchImpl, options?.signal);
        options?.signal?.throwIfAborted();
        return account;
      } catch (error) {
        // 取消是用户意图，不是网络故障：不得把取消写成 quota_refresh_error，也不得落盘任何中间 token/配额。
        if (options?.signal?.aborted) throw error;
        const account = await this.getAccount(targetId);
        if (account) {
          if(error instanceof CloudQuotaAuthorityError && account.quota?.source!=='live') {
            if(account.quota && ((account.quota.models?.length ?? 0) > 0 || (account.quota.quota_groups?.length ?? 0) > 0)) {
              const rejectedDir = join(this.stateDir, 'quota-rejected');
              await atomicJson(join(rejectedDir, `${account.id}-${Date.now()}.json`), {at:new Date().toISOString(),accountId:account.id,reason:error.message,quota:account.quota});
              try {
                const files = (await readdir(rejectedDir)).filter(f => f.endsWith('.json')).sort();
                if (files.length > 20) {
                  for (const old of files.slice(0, files.length - 20)) {
                    await unlink(join(rejectedDir, old)).catch(() => {});
                  }
                }
              } catch {}
            }
            account.quota={models:[],quota_groups:[],last_updated:0,is_forbidden:false,subscription_tier:account.quota?.subscription_tier,model_forwarding_rules:{},source:'cloud',quota_warnings:['UNVERIFIED_CLOUD_SCOPE: '+error.message]};
          }
          const errCode = accountErrorCode(error);
          if (errCode === 'missing_oauth_client') {
            const isActiveLiveError =
              error instanceof Error && error.message === bt('account_cloud.err.missing_oauth_client_active_live');
            if (isActiveLiveError) {
              const rawMsg = error.message;
              account.quota_refresh_error = sanitizeError(rawMsg, [
                account.token?.access_token,
                account.token?.refresh_token,
                account.token?.id_token,
              ]);
              account.quota_refresh_error_code = errCode;
              await this.saveRefreshedAccount(account);
            } else {
              const hadMissingOAuthErr =
                account.quota_refresh_error_code === 'missing_oauth_client'
                || (typeof account.quota_refresh_error === 'string'
                  && MISSING_OAUTH_CLIENT_PATTERN.test(account.quota_refresh_error.trim()));
              if (hadMissingOAuthErr) {
                account.quota_refresh_error = null;
                account.quota_refresh_error_code = null;
                await this.saveRefreshedAccount(account);
              }
            }
            throw error;
          }
          const rawMsg = error instanceof Error ? error.message : bt('accounts.err.refresh_failed_retry');
          account.quota_refresh_error = sanitizeError(rawMsg, [
            account.token?.access_token,
            account.token?.refresh_token,
            account.token?.id_token,
          ]);
          account.quota_refresh_error_code = errCode;
          await this.saveRefreshedAccount(account);
        }
        throw error;
      }
    })();

    this.inFlightRefreshes.set(targetId, job);
    try {
      return await job;
    } finally {
      this.inFlightRefreshes.delete(targetId);
    }
  }

  private async refreshQuotaFromProvider(id: string | undefined, fetchImpl: typeof globalThis.fetch, signal?: AbortSignal): Promise<Account> {
    signal?.throwIfAborted();
    const index = await this.loadIndex();
    const targetId = id || index.current_account_id;
    if (!targetId) throw new Error(bt('accounts.err.no_target_id'));
    const account = await this.getAccount(targetId);
    if (!account) throw new Error(bt('accounts.err.not_found_by_id', { id: targetId }));

    // 1) 本机 live 优先：仅当邮箱严格匹配且返回模型记录时采用（不跨账号借数据）。
    // 若 RetrieveUserQuotaSummary 超时/失败导致 quota_groups 为空，且账号具备 refresh_token，则回退云端接口补全分组。
    signal?.throwIfAborted();
    const lsStatus = await this.probeLiveLanguageServer(fetchImpl, {forceRefresh:true});
    signal?.throwIfAborted();
    const liveSummaryFailed = lsStatus?.quota?.refresh_state?.endpointsAttempted?.includes('live:RetrieveUserQuotaSummary') === true
      && lsStatus.quota.refresh_state?.endpointsSucceeded?.includes('live:RetrieveUserQuotaSummary') !== true
      && (lsStatus.quota.quota_groups?.length ?? 0) === 0;
    const hasExpiredLiveWindow = hasExpiredQuotaWindow(lsStatus?.quota, Date.now());
    const emailMatchedLive = Boolean(
      lsStatus && account.email && lsStatus.email &&
      lsStatus.email.trim().toLowerCase() === account.email.trim().toLowerCase() &&
      (lsStatus.quota.models?.length ?? 0) > 0
    );
    const canFallbackToCloud = (liveSummaryFailed || hasExpiredLiveWindow) && Boolean(account.token?.refresh_token);

    const persistLiveResult = async (): Promise<Account> => {
      const fresh = lsStatus!.quota;
      const old = account.quota;
      const allowFreeDowngrade = lsStatus!.accountType !== 'enterprise_vertex' && !liveSummaryFailed;
      const resolvedTier = mergeSubscriptionTier(fresh.subscription_tier, old?.subscription_tier, {
        allowFreeDowngrade,
      });
      const freshWithTier: QuotaData = { ...fresh, subscription_tier: resolvedTier };
      const freshState = this.getAccountQuotaOverview({ quota: freshWithTier }).refreshState;
      const { groups, staleGroups } = mergeGroupsWithPrevious(
        normalizeStoredGroups(fresh.quota_groups, fresh.last_updated, 'live'),
        normalizeStoredGroups(old?.quota_groups, old?.last_updated ?? fresh.last_updated), Date.now());
      const { models, carriedCount } = mergeModelsWithPrevious(
        fresh.models.map(model => normalizedModelFromStored(model, 'live')),
        (old?.models ?? []).map(model => normalizedModelFromStored(model)));
      const missingWindows = groups.flatMap(group => group.buckets.filter(bucket => bucket.stale)
        .map(bucket => ({ family: group.family, window: bucket.window })));
      const staleSeconds = this.getConfiguredQuotaStaleSeconds();
      account.quota = { ...freshWithTier, source: 'live',
        models: applyFamilyWindows(models, familyWindowsFromGroups(groups, Date.now(), staleSeconds)).map(modelQuotaFromNormalized),
        quota_groups: groups.map(groupToQuotaGroup),
        ...(staleGroups.length ? { stale_groups: staleGroups } : {}),
        refresh_state: { ...freshState, complete: freshState.complete && staleGroups.length === 0,
          missingWindows, carriedGroups: staleGroups.length, carriedModels: carriedCount },
      };
      account.quota_refresh_error = null;
      account.quota_refresh_error_code = null;
      if (lsStatus!.name && !account.name) account.name = lsStatus!.name;
      const expectedRefresh = account.token.refresh_token;
      try {
        const harvested = await this.harvestActiveSessionTokenIfMatched(account.email);
        const currentExp = Number.isFinite(account.token?.expiry_timestamp) ? account.token.expiry_timestamp : 0;
        if (
          harvested
          && harvested.token.refresh_token
          && Number.isFinite(harvested.token.expiry_timestamp)
          && harvested.token.expiry_timestamp > currentExp + 60
        ) {
          account.token = {
            ...account.token,
            ...harvested.token,
            email: harvested.token.email || account.token.email || account.email,
            project_id: harvested.token.project_id ?? account.token.project_id ?? null,
            oauth_client_key: harvested.token.oauth_client_key ?? account.token.oauth_client_key ?? null,
            id_token: harvested.token.id_token ?? account.token.id_token ?? null,
          };
        }
      } catch {}
      signal?.throwIfAborted();
      await this.saveRefreshedAccount(account, expectedRefresh, signal);
      return account;
    };

    if (emailMatchedLive && !canFallbackToCloud) {
      return await persistLiveResult();
    }

    if (emailMatchedLive && hasExpiredLiveWindow && !liveSummaryFailed) {
      try {
        const providerContext = await this.resolveProviderContext(fetchImpl);
        await fetchCloudQuotaForAccount({
          account,
          providerContext,
          fetchImpl,
          signal,
          onTokenRefreshed: (acc, prevRefresh) => this.saveRefreshedAccount(acc, prevRefresh, signal),
        });
        await this.saveRefreshedAccount(account, account.token.refresh_token, signal);
        return account;
      } catch (cloudErr) {
        if (signal?.aborted) throw cloudErr;
        return await persistLiveResult();
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const needTokenRefresh =
      !account.token?.access_token
      || account.token.access_token === 'pending_refresh'
      || !Number.isFinite(account.token.expiry_timestamp)
      || account.token.expiry_timestamp - nowSec < 300;
    if (needTokenRefresh && fetchImpl === globalThis.fetch && (!getGoogleClientId() || !getGoogleClientSecret())) {
      if (!account.token?.refresh_token) {
        throw new CodedAccountError('missing_refresh_token', bt('account_cloud.err.missing_refresh_token'));
      }
      if (!emailMatchedLive) {
        const desktopEmail = await this.detectCurrentAntigravityEmail({ liveEmailHint: lsStatus?.email ?? null }).catch(() => null);
        if (desktopEmail && account.email && desktopEmail.trim().toLowerCase() === account.email.trim().toLowerCase()) {
          throw new CodedAccountError('missing_oauth_client', bt('account_cloud.err.missing_oauth_client_active_live'));
        }
      }
      throw new CodedAccountError('missing_oauth_client', bt('account_cloud.err.missing_oauth_client'));
    }

    const providerContext=await this.resolveProviderContext(fetchImpl);
    try {
      await fetchCloudQuotaForAccount({
        account,
        providerContext,
        fetchImpl,
        signal,
        onTokenRefreshed: (acc, prevRefresh) => this.saveRefreshedAccount(acc, prevRefresh, signal),
      });
    } catch (err) {
      if (!emailMatchedLive && accountErrorCode(err) === 'missing_oauth_client') {
        const desktopEmail = await this.detectCurrentAntigravityEmail({ liveEmailHint: lsStatus?.email ?? null }).catch(() => null);
        if (desktopEmail && account.email && desktopEmail.trim().toLowerCase() === account.email.trim().toLowerCase()) {
          throw new CodedAccountError('missing_oauth_client', bt('account_cloud.err.missing_oauth_client_active_live'));
        }
      }
      throw err;
    }
    await this.saveRefreshedAccount(account, account.token.refresh_token, signal);
    return account;
  }

  /**
   * 刷新账号池所有可用账号的配额数据
   */
  async refreshAllQuotas(
    fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    options?: { signal?: AbortSignal; onAccountUpdated?: (account: Account, done: number, total: number) => void }
  ): Promise<{ accounts: Account[]; failures: { id: string; message: string }[]; skippedStandby: number }> {
    options?.signal?.throwIfAborted();
    const index = await this.loadIndex();
    const activeId = index.current_account_id;
    const enabledAccounts = index.accounts.filter(acc => !acc.disabled).sort((a, b) => {
      const aActive = a.id === activeId ? 1 : 0;
      const bActive = b.id === activeId ? 1 : 0;
      return bActive - aActive;
    });
    const hasLocalOAuthClient = Boolean(getGoogleClientId() && getGoogleClientSecret());
    let liveEmailLower: string | null = null;
    if (fetchImpl === globalThis.fetch && enabledAccounts.length > 0) {
      if (!hasLocalOAuthClient) {
        const liveStatus = await this.probeLiveLanguageServer(fetchImpl, { forceRefresh: true }).catch(() => null);
        liveEmailLower = liveStatus?.email?.trim().toLowerCase() ?? null;
      } else {
        void this.probeLiveLanguageServer(fetchImpl, { forceRefresh: true }).catch(() => null);
      }
      void this.resolveProviderContext(fetchImpl).catch(() => null);
    }
    const resultsByIndex: Array<Account | undefined> = new Array(enabledAccounts.length);
    const failures: { id: string; message: string }[] = [];
    let skippedStandby = 0;
    const concurrency = fetchImpl === globalThis.fetch ? Math.min(5, Math.max(1, enabledAccounts.length)) : 1;
    let cursor = 0;
    let completed = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (cursor < enabledAccounts.length) {
        options?.signal?.throwIfAborted();
        const slot = cursor++;
        const accMeta = enabledAccounts[slot]!;
        if (fetchImpl === globalThis.fetch && !hasLocalOAuthClient) {
          const saved = await this.getAccount(accMeta.id);
          if (saved) {
            const nowSec = Date.now() / 1000;
            const matchesLive = Boolean(liveEmailLower && saved.email?.trim().toLowerCase() === liveEmailLower);
            const isActiveByFallback = !liveEmailLower && accMeta.id === activeId;
            const isTokenNearOrPastExpiry =
              !saved.token?.access_token
              || saved.token.access_token === 'pending_refresh'
              || !Number.isFinite(saved.token.expiry_timestamp)
              || saved.token.expiry_timestamp - nowSec < 300;
            if (!matchesLive && !isActiveByFallback && isTokenNearOrPastExpiry) {
              const hadMissingOAuthErr =
                saved.quota_refresh_error_code === 'missing_oauth_client'
                || (typeof saved.quota_refresh_error === 'string'
                  && MISSING_OAUTH_CLIENT_PATTERN.test(saved.quota_refresh_error.trim()));
              if (hadMissingOAuthErr) {
                saved.quota_refresh_error = null;
                saved.quota_refresh_error_code = null;
                await this.saveRefreshedAccount(saved, saved.token.refresh_token, options?.signal).catch(() => {});
              }
              skippedStandby += 1;
              completed += 1;
              options?.onAccountUpdated?.(saved, completed, enabledAccounts.length);
              continue;
            }
          }
        }
        try {
          const updated = await this.refreshQuota(accMeta.id, fetchImpl, { signal: options?.signal });
          resultsByIndex[slot] = updated;
          completed += 1;
          options?.onAccountUpdated?.(updated, completed, enabledAccounts.length);
        } catch (error) {
          if (options?.signal?.aborted) throw error;
          completed += 1;
          failures.push({ id: accMeta.id, message: error instanceof Error ? error.message : bt('accounts.err.refresh_failed') });
        }
      }
    }));
    options?.signal?.throwIfAborted();
    return { accounts: resultsByIndex.filter((a): a is Account => Boolean(a)), failures, skippedStandby };
  }

  private desktopEmailCache: { email: string | null; expiresAt: number } | null = null;
  private vscdbEmailCache: { sig: string; email: string | null } | null = null;

  /**
   * 探测本机 Antigravity 当前真实登录邮箱：
   * 1. 优先通过运行中 language_server RPC 探测；
   * 2. 若 language_server 未启动（如未打开工作区窗口），在宿主默认状态目录下回退读取 Antigravity state.vscdb 与 Keychain。
   */
  async detectCurrentAntigravityEmail(options?: { liveEmailHint?: string | null }): Promise<string | null> {
    if (options && options.liveEmailHint !== undefined) {
      if (options.liveEmailHint) return options.liveEmailHint;
    } else {
      const ls = await this.probeLiveLanguageServer().catch(() => null);
      if (ls?.email) return ls.email;
    }
    const isDefaultStateDir = this.stateDir === defaultGravityBoxStateDir(homedir());
    if (!isDefaultStateDir) return null;
    const now = Date.now();
    if (this.desktopEmailCache && now < this.desktopEmailCache.expiresAt) {
      return this.desktopEmailCache.email;
    }
    let detected: string | null = null;
    const vscdbPath = join(this.target.profile, 'User', 'globalStorage', 'state.vscdb');
    const [vscStat, vscWalStat] = await Promise.all([
      lstat(vscdbPath).catch(() => null),
      lstat(`${vscdbPath}-wal`).catch(() => null),
    ]);
    const vscSig = vscStat ? `${vscStat.mtimeMs}:${vscStat.size}:${vscWalStat?.mtimeMs ?? 0}:${vscWalStat?.size ?? 0}` : 'missing';
    if (this.vscdbEmailCache && this.vscdbEmailCache.sig === vscSig) {
      detected = this.vscdbEmailCache.email;
    } else {
      const stateRows = vscStat
        ? await readAntigravityStateDb(vscdbPath, [
            'antigravityUnifiedStateSync.userStatus',
            'antigravityAuthStatus',
          ])
        : new Map<string, string>();
      const userStatusB64 = extractTopicDataString(stateRows.get('antigravityUnifiedStateSync.userStatus'));
      if (userStatusB64) {
        const buf = decodeTopicRow(userStatusB64, 'userStatusSentinelKey');
        const email = buf ? ProtobufReader.findString(buf, 7) : null;
        if (email && /^[^\s@]+@[^\s@]+$/.test(email)) detected = email;
      }
      if (!detected) {
        const authStatusRaw = stateRows.get('antigravityAuthStatus');
        if (authStatusRaw) {
          try {
            const parsed = JSON.parse(authStatusRaw);
            if (typeof parsed?.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(parsed.email)) {
              detected = parsed.email;
            }
          } catch {}
        }
      }
      this.vscdbEmailCache = { sig: vscSig, email: detected };
    }
    if (!detected) {
      try {
        const pass = await new SystemKeychainAdapter().readPassword('gemini', 'antigravity');
        if (pass && pass.startsWith('go-keyring-base64:')) {
          const raw = Buffer.from(pass.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
          const parsed = JSON.parse(raw);
          const email = parsed?.token?.email || parsed?.id_token_email;
          if (typeof email === 'string' && /^[^\s@]+@[^\s@]+$/.test(email)) detected = email;
        }
      } catch {}
    }
    this.desktopEmailCache = { email: detected, expiresAt: now + 5000 };
    return detected;
  }

  /**
   * 列出所有账号及当前激活账号详情
   */
  async listAccounts(options?: { liveEmailHint?: string | null }): Promise<{
    active_account_id: string | null;
    active_account: Account | null;
    accounts: AccountSummary[];
    total: number;
    revision: string;
  }> {
    const index = await this.loadIndex();
    let effectiveActiveId = index.current_account_id;
    const detectedEmail = await this.detectCurrentAntigravityEmail(options).catch(() => null);
    if (detectedEmail) {
      const matched = index.accounts.find(a => a.email.toLowerCase() === detectedEmail.toLowerCase());
      effectiveActiveId = matched?.id ?? null;
    }
    const activeEntry = effectiveActiveId ? await this.peekAccountEntry(effectiveActiveId) : null;
    const activeAccount = activeEntry ? structuredClone(activeEntry.account) : null;
    const hasLocalOAuthClient = Boolean(getGoogleClientId() && getGoogleClientSecret());
    const listNowMs = Date.now();
    const accountsWithRevision = await Promise.all(index.accounts.map(async acc => {
      const entry = await this.peekAccountEntry(acc.id);
      const saved = entry?.account ?? null;
      const readiness = accountCredentialReadiness(saved ?? acc as Account, listNowMs / 1000);
      const standbyStatus = computeStandbyRefreshStatus(saved ?? acc, {
        isActive: acc.id === effectiveActiveId,
        hasLocalOAuthClient,
        nowMs: listNowMs,
      });
      const baseRevision = entry ? entry.revision : computeAccountRevision(acc);
      return {
        ...acc,
        quota: saved?.quota ?? null,
        quota_refresh_error: cleanAndLocalizeRefreshError(saved?.quota_refresh_error),
        quota_refresh_error_code: saved?.quota_refresh_error_code ?? acc.quota_refresh_error_code ?? null,
        revision: `${baseRevision}:${readiness.state}:${standbyStatus.mode}`,
        credentialReadiness: readiness,
        standbyRefreshStatus: standbyStatus,
        quota_last_updated: saved?.quota?.last_updated ?? 0,
      };
    }));
    // 确保当前激活账号始终排在第一位
    accountsWithRevision.sort((a, b) => {
      const aActive = a.id === effectiveActiveId ? 1 : 0;
      const bActive = b.id === effectiveActiveId ? 1 : 0;
      return bActive - aActive;
    });
    const activeRevision = activeEntry ? activeEntry.revision : '';
    const poolRevision = accountsWithRevision.map(a => a.revision).join(':');
    return {
      active_account_id: effectiveActiveId,
      active_account: activeAccount,
      accounts: accountsWithRevision,
      total: index.accounts.length,
      revision: createHash('sha256').update(activeRevision + ':' + poolRevision).digest('hex'),
    };
  }
}
