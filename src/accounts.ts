import { applicationTarget, type ApplicationTarget } from './application-target.js';
import { inspectBundle } from './discovery.js';
import { lstat, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { atomicJson, commitAccountAndIndex, recoverAccountCommit, commitFileSet, recoverFileSet } from './files.js';
import { ReentrantMutex } from './mutex.js';
import { validateAccountPolicy } from './account-policy.js';
import { withProcessLease } from './process-lock.js';
import { ProtobufReader } from './protobuf.js';
import { decodeTopicRow } from './account-state.js';
import {
  MockKeychainAdapter,
  SystemKeychainAdapter,
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
} from './quota.js';
import {
  accountCredentialReadiness,
  buildAccountQuotaOverview,
  computeAccountRemaining,
  computeAccountRevision,
  endpointHost,
  endpointPriority,
  familyLabel,
  formatResetCountdown,
  fuseQuotaData,
  generateDeviceProfile,
  groupToQuotaGroup,
  modelQuotaFromNormalized,
  normalizedModelFromStored,
  pickNextReset,
  projectAccountForIpc,
  quotaSnapshotForRevision,
  refreshResetDescription,
  sanitizeJsonString,
  subscriptionTierRank,
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
  type TokenData,
} from './account-quota.js';
import {
  CLOUD_CODE_LOAD_PROJECT_ENDPOINTS,
  QUOTA_API_ENDPOINTS,
  QUOTA_SUMMARY_ENDPOINTS,
  fetchCloudQuotaForAccount,
  getGoogleClientId,
  getGoogleClientSecret,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
} from './account-cloud.js';

export {
  MockKeychainAdapter,
  SystemKeychainAdapter,
  syncAccountToKeychain,
  type KeychainAdapter,
  CloudQuotaAuthorityError,
  cloudOriginFromCommand,
  cloudProviderContextFromCommand,
  localRpcFetch,
  validCachedCloudProviderContext,
  type CloudProviderContext,
  accountCredentialReadiness,
  computeAccountRevision,
  endpointHost,
  endpointPriority,
  familyLabel,
  formatResetCountdown,
  generateDeviceProfile,
  groupToQuotaGroup,
  modelQuotaFromNormalized,
  normalizedModelFromStored,
  pickNextReset,
  projectAccountForIpc,
  quotaSnapshotForRevision,
  refreshResetDescription,
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
  type TokenData,
  CLOUD_CODE_LOAD_PROJECT_ENDPOINTS,
  QUOTA_API_ENDPOINTS,
  QUOTA_SUMMARY_ENDPOINTS,
  getGoogleClientId,
  getGoogleClientSecret,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
};

const execFileAsync = promisify(execFile);

export class AccountsManager {
  private target: ApplicationTarget;
  private accountsDir: string;
  private indexPath: string;
  private autoSwitchPath: string;
  private tombstonesPath: string;
  private reconciled = false;
  private inFlightRefreshes = new Map<string, Promise<Account>>();
  private mutex = new ReentrantMutex();
  private liveProbeCache: { status: LiveLanguageServerStatus | null; expiresAt: number } | null = null;
  private inFlightProbe: Promise<LiveLanguageServerStatus | null> | null = null;
  private providerOverride?: CloudProviderContext;
  private providerContextCache: { value: CloudProviderContext; expiresAt: number } | null = null;
  private inFlightProviderContext: Promise<CloudProviderContext | null> | null = null;
  private indexCache: { mtimeMs: number; size: number; index: AccountIndex } | null = null;
  private accountCache = new Map<string, { mtimeMs: number; size: number; account: Account; digest: string }>();
  private accountFileDigests = new WeakMap<Account, string>();
  private refreshSaveMeta = new WeakMap<Account, { expectedRefreshToken: string; isRefreshUpdate: boolean }>();

  private async withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    return this.mutex.run(() => withProcessLease(join(this.stateDir, 'accounts-write.lock'), action), { label: 'AccountsManager.writeLock' });
  }

  public async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    return this.withWriteLock(action);
  }

  constructor(private stateDir: string, options: { providerContext?: CloudProviderContext; target?: ApplicationTarget } = {}) {
    this.target = options.target ?? applicationTarget();
    this.providerOverride=options.providerContext;
    this.accountsDir = join(stateDir, 'accounts');
    this.indexPath = join(stateDir, 'accounts.json');
    this.autoSwitchPath = join(stateDir, 'auto_switch.json');
    this.tombstonesPath = join(stateDir, 'accounts-deleted.json');
  }

  public invalidateRuntimeCaches(): void {
    this.liveProbeCache = null;
    clearLiveEndpointCache();
    this.desktopEmailCache = null;
    this.indexCache = null;
    this.accountCache.clear();
    this.providerContextCache = null;
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
      const text=(await execFileAsync('/bin/ps',['-ax','-ww','-o','args='])).stdout;
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
      throw new CloudQuotaAuthorityError('无法确认 Antigravity 实际配额服务，请先运行官方应用；未采用其他环境的默认配额');
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
    await mkdir(this.accountsDir, { recursive: true, mode: 0o700 });
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
        // A deleted account path can already be absent after an interrupted commit.
        for (const change of changes ?? []) if (typeof change.path === 'string' && change.path.startsWith(this.accountsDir + '/') && /^[a-zA-Z0-9_-]+\.json$/.test(change.path.slice(this.accountsDir.length+1))) accountPaths.push(change.path);
        await recoverFileSet(journal, [this.indexPath, this.tombstonesPath, ...accountPaths]);
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
        const acc = await this.getAccount(summary.id);
        if (!acc) {
          dirty = true;
          break;
        }
        if (summary.revision && computeAccountRevision(acc) !== summary.revision) {
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
            quota_refresh_error: acc.quota_refresh_error && /双周期/.test(acc.quota_refresh_error) ? null : acc.quota_refresh_error,
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
      return index;
    });
  }

  async getAccount(id: string): Promise<Account | null> {
    await this.init();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('账号 ID 无效');
    const filePath = join(this.accountsDir, `${id}.json`);
    try {
      const st = await lstat(filePath);
      const cached = this.accountCache.get(id);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        const clone = structuredClone(cached.account);
        this.accountFileDigests.set(clone, cached.digest);
        return clone;
      }
      const raw = await readFile(filePath);
      const acc = JSON.parse(sanitizeJsonString(raw)) as Account;
      if (acc) {
        if (acc.quota_refresh_error && /双周期/.test(acc.quota_refresh_error)) {
          acc.quota_refresh_error = null;
        }
        const digest = createHash('sha256').update(raw).digest('hex');
        this.accountCache.set(id, { mtimeMs: st.mtimeMs, size: st.size, account: structuredClone(acc), digest });
        this.accountFileDigests.set(acc, digest);
      }
      return acc;
    } catch (error) {
      this.accountCache.delete(id);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('账号文件无法读取或格式损坏，原文件已保留');
    }
  }

  async saveAccount(
    account: Account,
    options?: { expectedRefreshToken?: string; expectedFileDigest?: string; isRefreshUpdate?: boolean }
  ): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(account.id)) throw new Error('账号 ID 无效');
    await this.init();

    return this.withWriteLock(async () => {
      const meta = this.refreshSaveMeta.get(account);
      const expectedRefresh = options?.expectedRefreshToken ?? meta?.expectedRefreshToken;
      const isRefreshUpdate = options?.isRefreshUpdate ?? meta?.isRefreshUpdate ?? false;

      const accountPath = join(this.accountsDir, `${account.id}.json`);
      const diskAccount = await this.getAccount(account.id);
      const expectedFileDigest = options?.expectedFileDigest ?? this.accountFileDigests.get(account);
      const diskDigest = diskAccount ? this.accountFileDigests.get(diskAccount) : undefined;
      if (!isRefreshUpdate && expectedFileDigest && (!diskAccount || expectedFileDigest !== diskDigest)) throw new Error('账号记录已在其他操作中更新，请重新读取后保存');

      if (expectedRefresh !== undefined && diskAccount) {
        if (diskAccount.token.refresh_token !== expectedRefresh) {
          throw new Error('账号凭据已更新，停止覆盖新的登录记录');
        }
      }

      if (isRefreshUpdate && !diskAccount) {
        throw new Error(`账号 ${account.id} 已被删除，停止刷新写入`);
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
      if (!current) throw new Error(`找不到 ID 为 ${id} 的账号`);
      const result = await mutate(current);
      await this.saveAccount(current);
      return { account: current, result };
    });
  }

  async renameAccount(id: string, name: string): Promise<Account> {
    if (typeof name !== "string" || name.trim().length > 80) throw new Error("账号名称最多 80 个字符");
    return (await this.updateAccount(id, current => { current.name = name.trim() || current.email.split('@')[0] || current.email; })).account;
  }

  async upsertAccount(data: any): Promise<Account> {
    await this.init();
    return this.withWriteLock(async () => {
      const index = await this.loadIndex();
      const email = String(data.email || '').trim();
      const existingSummary = index.accounts.find(
        a => (email && a.email.toLowerCase() === email.toLowerCase()) || (data.id && a.id === data.id)
      );

      let account: Account;
      if (data.id && !/^[a-zA-Z0-9_-]+$/.test(String(data.id))) throw new Error('账号 ID 无效');
      const now = Math.floor(Date.now() / 1000);
      const refreshToken = data.refreshToken ?? data.refresh_token ?? data.token?.refresh_token ?? data.token?.refreshToken;
      const accessToken = data.accessToken ?? data.access_token ?? data.token?.access_token ?? data.token?.accessToken;
      const expiresIn = data.expiresIn ?? data.expires_in ?? data.token?.expires_in;
      const customLabel = data.custom_label !== undefined ? data.custom_label : data.customLabel;
      const name = data.name;
      const projectId = data.projectId !== undefined ? data.projectId : data.project_id;
      const oauthClientKey = data.oauthClientKey !== undefined ? data.oauthClientKey : data.oauth_client_key;
      const isGcpTos = data.isGcpTos !== undefined ? data.isGcpTos : data.is_gcp_tos;
      const idToken = data.idToken !== undefined ? data.idToken : data.id_token;

      if (existingSummary) {
        const existing = (await this.getAccount(existingSummary.id))!;
        account = {
          ...existing,
          name: name !== undefined ? name : existing.name,
          custom_label: customLabel !== undefined ? customLabel : existing.custom_label,
          disabled: false,
          disabled_reason: null,
          disabled_at: null,
          token: {
            ...existing.token,
            refresh_token: refreshToken || existing.token.refresh_token,
            access_token: accessToken ?? existing.token.access_token,
            expires_in: expiresIn ?? existing.token.expires_in,
            expiry_timestamp: expiresIn ? now + expiresIn : existing.token.expiry_timestamp,
            project_id: projectId !== undefined ? projectId : existing.token.project_id,
            oauth_client_key: oauthClientKey !== undefined ? oauthClientKey : existing.token.oauth_client_key,
            is_gcp_tos: isGcpTos !== undefined ? isGcpTos : existing.token.is_gcp_tos,
            id_token: idToken !== undefined ? idToken : existing.token.id_token,
          },
        };
      } else {
        if (!refreshToken) throw new Error('新增账号缺少 refreshToken');
        if (!email) throw new Error('新增账号缺少 email');
        const id = data.id || randomUUID();
        const exp = expiresIn ?? 3600;
        account = {
          id,
          email,
          name: name ?? null,
          token: {
            access_token: accessToken ?? 'pending_refresh',
            refresh_token: refreshToken,
            expires_in: exp,
            expiry_timestamp: now + exp,
            token_type: 'Bearer',
            email,
            project_id: projectId ?? null,
            oauth_client_key: oauthClientKey ?? null,
            is_gcp_tos: isGcpTos ?? false,
            id_token: idToken ?? null,
          },
          device_profile: generateDeviceProfile(),
          quota: null,
          disabled: false,
          protected_models: [],
          validation_blocked: false,
          created_at: now,
          last_used: now,
          custom_label: customLabel ?? null,
        };
      }

      await this.saveAccount(account);
      return account;
    });
  }

  async addAccountWithRefreshToken(raw: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<Account> {
    const refreshToken = String(raw).trim();
    if (!refreshToken || refreshToken.length > 8192 || /[\r\n\x00]/.test(refreshToken)) throw new Error('请填写有效的 Refresh Token');
    const tokenReply = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', signal: AbortSignal.timeout(6000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: getGoogleClientId(), client_secret: getGoogleClientSecret(), refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
    }).catch(() => { throw new Error('无法连接登录服务，请检查网络后重试'); });
    if (!tokenReply.ok) throw new Error('登录凭据无效或已失效，请重新获取');
    const token: any = await tokenReply.json();
    if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('登录服务未返回有效凭据');
    const identityReply = await fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(6000),
    }).catch(() => { throw new Error('未能核实账号身份，尚未添加'); });
    if (!identityReply.ok) throw new Error('未能核实账号身份，尚未添加');
    const identity: any = await identityReply.json();
    if (typeof identity.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(identity.email) || identity.verified_email === false) throw new Error('未取得已验证的账号邮箱，尚未添加');
    return this.upsertAccount({ email: identity.email, name: identity.name, accessToken: token.access_token,
      refreshToken: token.refresh_token || refreshToken, expiresIn: Number(token.expires_in) || 3600, idToken: token.id_token });
  }

  async addAccountFromOAuth(token: { access_token: string; refresh_token: string; expires_in?: number; id_token?: string }, signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch): Promise<void> {
    const reply = await fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    if (!reply.ok) throw new Error('未能核实 Google 账号，尚未添加');
    const identity: any = await reply.json();
    if (typeof identity.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(identity.email) || identity.verified_email !== true) throw new Error('未取得已验证的 Google 邮箱，尚未添加');
    signal.throwIfAborted();
    await this.upsertAccount({ email: identity.email, name: identity.name, accessToken: token.access_token,
      refreshToken: token.refresh_token, expiresIn: Number(token.expires_in) || 3600, idToken: token.id_token });
  }

  async deleteAccount(id: string): Promise<boolean> {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('账号 ID 无效');
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
        await atomicJson(join(removedDir, `${id}-${Date.now()}.json`), {
          schema: 1, removedAt: new Date().toISOString(), account: JSON.parse(original),
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
        throw new Error(`找不到账号: ${id}`);
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
      if (reserve >= candidateMin) throw Error('推荐门槛关系无效');
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
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('账号推荐配置损坏或类型无效，原文件已保留');
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
        throw new Error('当前账号配额门槛必须在 1% 到 98% 之间');
      }
    }
    const candidateMinRaw = config.candidate_min_percentage ?? config.candidateMinPercentage;
    if (candidateMinRaw !== undefined) {
      const num = Number(candidateMinRaw);
      if (isNaN(num) || num < 2 || num > 100) {
        throw new Error('候选账号配额门槛必须在 2% 到 100% 之间');
      }
    }
    const reserve = reserveRaw !== undefined ? Number(reserveRaw) : current.reserve_percentage;
    const candidateMin = candidateMinRaw !== undefined ? Number(candidateMinRaw) : current.candidate_min_percentage;
    if (reserve >= candidateMin) {
      throw new Error('候选账号配额门槛必须大于当前账号配额门槛');
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
    return computeAccountRemaining(account, monitoredModel);
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
        reason: '智能备用账号推荐策略未启用',
      };
    }

    if (!currentAccount) {
      return { currentAccount: null, bestCandidate: null, shouldSwitch: false, reason: '没有当前激活账号' };
    }

    const currentRem = this.getAccountRemaining(currentAccount, cfg.monitored_model);
    const isLow = currentRem !== null && currentRem <= cfg.reserve_percentage;

    const candidateIds = cfg.candidate_account_ids.length > 0
      ? cfg.candidate_account_ids.filter(id => id !== currentId)
      : index.accounts.map(a => a.id).filter(id => id !== currentId);

    const candidates: Account[] = [];
    for (const cid of candidateIds) {
      const acc = await this.getAccount(cid);
      if (acc) candidates.push(acc);
    }

    // Filter valid & precompute remaining/tierRank once per candidate (避免排序中重复构建配额视图)
    const allValidScored: Array<{ acc: Account; rem: number; tierRank: number }> = [];
    for (const acc of candidates) {
      const rem = this.getAccountRemaining(acc, cfg.monitored_model);
      if (rem === null || rem < cfg.candidate_min_percentage || rem <= 0) continue;
      if (accountCredentialReadiness(acc).state === 'needs_authorization') continue;
      allValidScored.push({ acc, rem, tierRank: this.subscriptionTierRank(acc) });
    }

    if (allValidScored.length === 0) {
      return {
        currentAccount,
        bestCandidate: null,
        shouldSwitch: false,
        reason: '备选池中没有额度充足且可用的账号',
      };
    }

    // 优先在付费高阶账号（ULTRA / PRO / 企业待确认）中挑选；仅当没有任何达标高阶账号时才回退考虑 FREE 账号
    const paidScored = allValidScored.filter(item => item.tierRank >= 2);
    const validScored = paidScored.length > 0 ? paidScored : allValidScored;

    let bestItem: { acc: Account; rem: number; tierRank: number };
    if (cfg.strategy === 'round_robin') {
      // 环形轮询：基于全局候选全集池 poolOrder 与游标选择下一个可用账号，杜绝双账号反复横跳振荡
      const poolOrder = cfg.candidate_account_ids.length > 0
        ? cfg.candidate_account_ids
        : index.accounts.map(a => a.id);
      const cursorId = (cfg.last_switched_id && poolOrder.includes(cfg.last_switched_id))
        ? cfg.last_switched_id
        : currentId;
      const cursorIndex = cursorId ? poolOrder.indexOf(cursorId) : -1;
      if (cursorIndex !== -1) {
        let chosen: { acc: Account; rem: number; tierRank: number } | undefined;
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
      // Priority: 先按套餐等级（ULTRA > PRO > 待确认 > FREE）降序，同等级按剩余额度从高到低排序
      validScored.sort((a, b) => {
        const tierDiff = b.tierRank - a.tierRank;
        if (tierDiff !== 0) return tierDiff;
        return b.rem - a.rem;
      });
      bestItem = validScored[0]!;
    }

    const best = bestItem.acc;
    const bestRem = bestItem.rem;
    const bestDisplay = best.name ? `${best.name} (${best.email})` : best.email;
    // 当前为 PRO/ULTRA 而唯一候选为 FREE 时，除非当前账号已彻底耗尽（0%），否则不主动触发向免费账号的降级推荐
    const isDowngradeToFree = this.subscriptionTierRank(currentAccount) >= 2 && this.subscriptionTierRank(best) < 2;
    const effectiveShouldSwitch = isLow && (!isDowngradeToFree || (currentRem !== null && currentRem <= 0));

    return {
      currentAccount,
      bestCandidate: best,
      shouldSwitch: effectiveShouldSwitch,
      reason: effectiveShouldSwitch
        ? `当前账号额度偏低（剩余 ${currentRem}%），建议切换至备用账号 ${bestDisplay}（额度充足，剩余 ${bestRem}%）`
        : isLow && isDowngradeToFree
        ? '当前配额偏低，但仅有免费候选；为避免降级暂不建议切换'
        : currentRem === null
        ? '当前账号配额未知或已过期，请先刷新'
        : `当前账号额度充足（剩余 ${currentRem}%）`,
    };
  }

  /**
   * 探测运行中的 Antigravity language_server 本地 RPC 端口与 CSRF Token (双接口免密联动)
   */
  async probeLiveLanguageServer(fetchImpl: typeof fetch = globalThis.fetch, options: { forceRefresh?: boolean } = {}): Promise<LiveLanguageServerStatus | null> {
    if (process.env.GRAVITYBOX_PROBE_LS === 'false') return null;
    const now = Date.now();
    if (fetchImpl === globalThis.fetch && this.liveProbeCache && now < (options.forceRefresh ? this.liveProbeCache.expiresAt - 1300 : this.liveProbeCache.expiresAt)) {
      return this.liveProbeCache.status;
    }
    if (fetchImpl === globalThis.fetch && this.inFlightProbe) {
      return await this.inFlightProbe;
    }

    const doProbe = () => probeLiveLanguageServerOnce(this.target, fetchImpl, options, {
      modelQuotaFromNormalized,
      groupToQuotaGroup,
    });

    if (fetchImpl !== globalThis.fetch) {
      return await doProbe();
    }

    const probePromise = doProbe();
    this.inFlightProbe = probePromise;
    try {
      const res = await probePromise;
      this.liveProbeCache = { status: res, expiresAt: Date.now() + 5000 };
      return res;
    } finally {
      this.inFlightProbe = null;
    }
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
    const appSupportDir = options?.appSupportDir ?? join(homedir(), 'Library', 'Application Support');
    const keychain = options?.keychain ?? new SystemKeychainAdapter();

    const isSandboxHome = homeDir !== homedir();
    let extractedToken: TokenData | null = null;
    let extractedEmail: string | null = null;
    let extractedName: string | null = null;
    let liveQuota: QuotaData | null = null;

    const readSessionToken = async () => {
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
            extractedToken = {
              access_token: t.access_token || '',
              refresh_token: t.refresh_token,
              expires_in: t.expires_in || 3600,
              expiry_timestamp: t.expiry_timestamp || Math.floor(Date.now() / 1000) + 3600,
              token_type: t.token_type || 'Bearer',
              email: t.email || null,
              project_id: t.project_id || null,
              is_gcp_tos: t.is_gcp_tos || false,
              id_token: t.id_token || null,
            };
            extractedEmail = t.email || null;
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
    if (!extractedToken && (options?.keychain || !isSandboxHome)) {
      try {
        const pass = await keychain.readPassword('gemini', 'antigravity');
        if (pass && pass.startsWith('go-keyring-base64:')) {
          const raw = Buffer.from(pass.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
          const parsed = JSON.parse(raw);
          if (parsed?.token?.refresh_token) {
            extractedToken = {
              access_token: parsed.token.access_token || '',
              refresh_token: parsed.token.refresh_token,
              expires_in: parsed.token.expires_in || 3600,
              expiry_timestamp: parsed.token.expiry_timestamp || (Number.isFinite(Date.parse(parsed.token.expiry)) ? Math.floor(Date.parse(parsed.token.expiry) / 1000) : Math.floor(Date.now() / 1000) + 3600),
              token_type: parsed.token.token_type || 'Bearer',
              email: parsed.token.email || parsed.id_token_email || null,
              project_id: parsed.token.project_id || null,
              is_gcp_tos: parsed.token.is_gcp_tos || false,
              id_token: parsed.token.id_token || null,
            };
            extractedEmail = parsed.token.email || parsed.id_token_email || null;
          }
        }
      } catch {}
    }

    // 3. 检查本地 session 文件 (非沙箱模式回退)
    if (!extractedToken) {
      await readSessionToken();
    }

    // 4. 检查 state.vscdb (补充 token 或补充 email)
    if (!extractedToken || !extractedEmail) {
      const primaryProfileVscdb = join(this.target.profile, 'User', 'globalStorage', 'state.vscdb');
      const fallbackProfileVscdb = options?.appSupportDir
        ? join(appSupportDir, this.target.name, 'User', 'globalStorage', 'state.vscdb')
        : primaryProfileVscdb;
      const candidateVscdbPaths = Array.from(new Set(
        options?.appSupportDir ? [fallbackProfileVscdb, primaryProfileVscdb] : [primaryProfileVscdb]
      ));
      for (const vscdbPath of candidateVscdbPaths) {
        if (extractedToken && extractedEmail) break;
        const stateRows = await readAntigravityStateDb(vscdbPath, [
          'antigravityUnifiedStateSync.oauthToken',
          'antigravityUnifiedStateSync.userStatus',
        ]);
        if (stateRows.size === 0) continue;
        const oauthRawB64 = extractTopicDataString(stateRows.get('antigravityUnifiedStateSync.oauthToken'));
        const userStatusB64 = extractTopicDataString(stateRows.get('antigravityUnifiedStateSync.userStatus'));

        if (!extractedToken && oauthRawB64) {
          const payloadBuf = decodeTopicRow(oauthRawB64, 'oauthTokenInfoSentinelKey');
          if (payloadBuf) {
            const accessToken = ProtobufReader.findString(payloadBuf, 1) || '';
            const refreshToken = ProtobufReader.findString(payloadBuf, 3) || '';
            let expirySec = Math.floor(Date.now() / 1000) + 3600;
            const timeBuf = ProtobufReader.findField(payloadBuf, 4);
            if (timeBuf) {
              const sec = ProtobufReader.findVarint(timeBuf, 1);
              if (sec && sec > 0) expirySec = sec;
            }

            if (refreshToken) {
              extractedToken = {
                access_token: accessToken,
                refresh_token: refreshToken,
                expires_in: Math.max(60, expirySec - Math.floor(Date.now() / 1000)),
                expiry_timestamp: expirySec,
                token_type: 'Bearer',
                email: null,
                is_gcp_tos: false,
              };
            }
          }
        }

        if (!extractedEmail && userStatusB64 && oauthRawB64 && extractedToken?.refresh_token === ProtobufReader.findString(decodeTopicRow(oauthRawB64, 'oauthTokenInfoSentinelKey') ?? Buffer.alloc(0), 3)) {
          const payloadBuf = decodeTopicRow(userStatusB64, 'userStatusSentinelKey');
          if (payloadBuf) {
            const email = ProtobufReader.findString(payloadBuf, 7);
            if (email) extractedEmail = email;
          }
        }
      }
    }

    // A live identity may enrich the same account, or provide the email for the active local session when state.vscdb is absent.
    if (!isSandboxHome && (extractedEmail || extractedToken)) {
      const lsStatus = await this.probeLiveLanguageServer();
      if (lsStatus?.email && (!extractedEmail || lsStatus.email.toLowerCase() === extractedEmail.toLowerCase())) {
        extractedEmail = extractedEmail || lsStatus.email;
        extractedName = lsStatus.name || null;
        liveQuota = { ...lsStatus.quota, source: 'live' };
      }
    }

    if (!extractedToken || !extractedToken.refresh_token) {
      throw new Error('未在系统 Keychain、会话凭据或应用数据库中找到有效登录态');
    }

    if (extractedEmail && !extractedToken.email) {
      extractedToken.email = extractedEmail;
    }

    const email = extractedEmail || extractedToken.email;
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email) || email.endsWith('@antigravity.user')) throw new Error('无法核实此凭据的账号邮箱，请通过登录凭据添加并核实身份');

    const account = await this.upsertAccount({
      email,
      name: extractedName || undefined,
      refreshToken: extractedToken.refresh_token,
      accessToken: extractedToken.access_token,
      expiresIn: Math.max(60, extractedToken.expiry_timestamp - Math.floor(Date.now() / 1000)),
      projectId: extractedToken.project_id || undefined,
    });

    if (liveQuota) {
      account.quota = liveQuota;
      await this.saveAccount(account);
    }

    await this.setCurrentAccount(account.id);
    this.invalidateRuntimeCaches();
    return (await this.getAccount(account.id)) ?? account;
  }

  /**
   * 获取账号额度综合概览（包含 3 分组 5 桶详细百分比、相对倒计时、套餐与 13 模型明细）
   */
  getAccountQuotaOverview(account: Account | AccountSummary | { quota?: QuotaData | null }, options?: { nowMs?: number }): QuotaOverview {
    return buildAccountQuotaOverview(account, options);
  }

  /**
   * 刷新指定账号的 OAuth Token 与配额数据 (支持三级端点容灾与双窗口熔合)
   */
  private async saveRefreshedAccount(account: Account, expectedRefresh = account.token.refresh_token, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const latest = await this.getAccount(account.id);
    if (!latest) throw new Error('此账号已移除，停止保存刷新结果');
    if (latest.token.refresh_token !== expectedRefresh) throw new Error('账号凭据已更新，停止覆盖新的登录记录');
    // Refresh work runs in the background; keep remarks, order, flags and usage edited meanwhile.
    const toSave: Account = {
      ...latest,
      name: latest.name || account.name,
      token: account.token,
      quota: account.quota,
      quota_refresh_error: account.quota_refresh_error,
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
      throw new Error('未指定账号 ID 且当前没有激活账号');
    }

    const inFlight = this.inFlightRefreshes.get(targetId);
    if (inFlight) {
      return await inFlight;
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
          account.quota_refresh_error = error instanceof Error ? error.message : '刷新失败，请稍后重试';
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
    if (!targetId) throw new Error('未指定账号 ID 且当前没有激活账号');
    const account = await this.getAccount(targetId);
    if (!account) throw new Error(`找不到 ID 为 ${targetId} 的账号`);

    // 1) 本机 live 优先：仅当邮箱严格匹配且返回模型记录时采用（不跨账号借数据）。
    // 若 RetrieveUserQuotaSummary 超时/失败导致 quota_groups 为空，且账号具备 refresh_token，则回退云端接口补全分组。
    signal?.throwIfAborted();
    const lsStatus = await this.probeLiveLanguageServer(fetchImpl, {forceRefresh:true});
    signal?.throwIfAborted();
    const liveSummaryFailed = lsStatus?.quota?.refresh_state?.endpointsAttempted?.includes('live:RetrieveUserQuotaSummary') === true
      && lsStatus.quota.refresh_state?.endpointsSucceeded?.includes('live:RetrieveUserQuotaSummary') !== true
      && (lsStatus.quota.quota_groups?.length ?? 0) === 0;
    const canFallbackToCloud = liveSummaryFailed && Boolean(account.token?.refresh_token);
    if (lsStatus && account.email && lsStatus.email && lsStatus.email.trim().toLowerCase() === account.email.trim().toLowerCase() && (lsStatus.quota.models?.length ?? 0) > 0 && !canFallbackToCloud) {
      const fresh = lsStatus.quota;
      const freshState = this.getAccountQuotaOverview({ quota: fresh }).refreshState;
      const old = account.quota;
      const { groups, staleGroups } = mergeGroupsWithPrevious(
        normalizeStoredGroups(fresh.quota_groups, fresh.last_updated, 'live'),
        normalizeStoredGroups(old?.quota_groups, old?.last_updated ?? fresh.last_updated), Date.now());
      const { models, carriedCount } = mergeModelsWithPrevious(
        fresh.models.map(model => normalizedModelFromStored(model, 'live')),
        (old?.models ?? []).map(model => normalizedModelFromStored(model)));
      const missingWindows = groups.flatMap(group => group.buckets.filter(bucket => bucket.stale)
        .map(bucket => ({ family: group.family, window: bucket.window })));
      account.quota = { ...fresh, source: 'live',
        models: applyFamilyWindows(models, familyWindowsFromGroups(groups, Date.now())).map(modelQuotaFromNormalized),
        quota_groups: groups.map(groupToQuotaGroup),
        ...(staleGroups.length ? { stale_groups: staleGroups } : {}),
        refresh_state: { ...freshState, complete: freshState.complete && staleGroups.length === 0,
          missingWindows, carriedGroups: staleGroups.length, carriedModels: carriedCount },
      };
      account.quota_refresh_error = null;
      if (lsStatus.name && !account.name) account.name = lsStatus.name;
      signal?.throwIfAborted();
      await this.saveRefreshedAccount(account, account.token.refresh_token, signal);
      return account;
    }

    const providerContext=await this.resolveProviderContext(fetchImpl);
    await fetchCloudQuotaForAccount({
      account,
      providerContext,
      fetchImpl,
      signal,
      onTokenRefreshed: (acc, prevRefresh) => this.saveRefreshedAccount(acc, prevRefresh, signal),
    });
    await this.saveRefreshedAccount(account, account.token.refresh_token, signal);
    return account;
  }

  /**
   * 刷新账号池所有可用账号的配额数据
   */
  async refreshAllQuotas(fetchImpl: typeof globalThis.fetch = globalThis.fetch, options?: { signal?: AbortSignal }): Promise<{ accounts: Account[]; failures: { id: string; message: string }[] }> {
    options?.signal?.throwIfAborted();
    const index = await this.loadIndex();
    const enabledAccounts = index.accounts.filter(acc => !acc.disabled);
    if (fetchImpl === globalThis.fetch && enabledAccounts.length > 0) {
      await Promise.all([
        this.probeLiveLanguageServer(fetchImpl, { forceRefresh: true }).catch(() => null),
        this.resolveProviderContext(fetchImpl).catch(() => null),
      ]);
    }
    const results: Account[] = [];
    const failures: { id: string; message: string }[] = [];
    const concurrency = fetchImpl === globalThis.fetch ? Math.min(3, Math.max(1, enabledAccounts.length)) : 1;
    let cursor = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (cursor < enabledAccounts.length) {
        options?.signal?.throwIfAborted();
        const accMeta = enabledAccounts[cursor++]!;
        try {
          const updated = await this.refreshQuota(accMeta.id, fetchImpl, { signal: options?.signal });
          results.push(updated);
        } catch (error) {
          if (options?.signal?.aborted) throw error;
          failures.push({ id: accMeta.id, message: error instanceof Error ? error.message : '刷新失败' });
        }
      }
    }));
    options?.signal?.throwIfAborted();
    return { accounts: results, failures };
  }

  private desktopEmailCache: { email: string | null; expiresAt: number } | null = null;

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
    const isDefaultStateDir = this.stateDir === join(homedir(), 'Library', 'Application Support', 'GravityBox');
    if (!isDefaultStateDir) return null;
    const now = Date.now();
    if (this.desktopEmailCache && now < this.desktopEmailCache.expiresAt) {
      return this.desktopEmailCache.email;
    }
    let detected: string | null = null;
    const vscdbPath = join(this.target.profile, 'User', 'globalStorage', 'state.vscdb');
    const stateRows = await readAntigravityStateDb(vscdbPath, [
      'antigravityUnifiedStateSync.userStatus',
      'antigravityAuthStatus',
    ]);
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
    const activeAccount = effectiveActiveId ? await this.getAccount(effectiveActiveId) : null;
    const accountsWithRevision = await Promise.all(index.accounts.map(async acc => {
      const saved = await this.getAccount(acc.id);
      const readiness = accountCredentialReadiness(saved ?? acc as Account);
      return { ...acc, quota: saved?.quota ?? null, quota_refresh_error: saved?.quota_refresh_error ?? null, revision: computeAccountRevision(saved ?? acc) + ':' + readiness.state, credentialReadiness: readiness, quota_last_updated: saved?.quota?.last_updated ?? 0 };
    }));
    // 确保当前激活账号始终排在第一位
    accountsWithRevision.sort((a, b) => {
      const aActive = a.id === effectiveActiveId ? 1 : 0;
      const bActive = b.id === effectiveActiveId ? 1 : 0;
      return bActive - aActive;
    });
    const activeRevision = activeAccount ? computeAccountRevision(activeAccount) : '';
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
