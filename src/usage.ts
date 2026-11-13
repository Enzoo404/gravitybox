import { ALLOWED_DATA_DIRECTORY_NAMES, type DataDirectoryName } from './application-target.js';
import { lstat, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { atomicJson, atomicText } from './files.js';
import { formatLocalDate, type LedgerSnapshot } from './usage-aggregate.js';
import { UsageLedger, type LedgerEvent } from './usage-ledger.js';
import {
  DEFAULT_PRICING_FEED_URLS,
  calculateEstimatedUsd,
  canonicalActivePricingKeys,
  resolvePricingFromTable,
  type ApiPricing,
  type ApiPricingEntry,
  type ApiPricingInterval,
} from './pricing.js';
import {
  ledgerEventsEqual,
  resolveDatabaseModelFullName,
  type AvailableAccountUsageOption,
  type DailyTokenUsage,
  type FileCacheEntry,
  type GenerationEvent,
  type HourlyTokenUsage,
  type ModelTokenUsage,
  type TokenUsagePeriod,
  type TokenUsageSummary,
  type TokenUsageTotals,
} from './usage-types.js';
import {
  buildPricingSyncStatus,
  executeRemotePricingSync,
  loadPricingSyncState,
  loadRawPricingTable,
  resolvePricingTableFromRaw,
  saveCustomPricingCache,
  selectRemotePricingCandidateUrls,
  type PricingSyncMutableState,
} from './usage-pricing.js';
import {
  discoverDatabaseFiles as discoverDatabaseFilesInDir,
  scanDatabaseEvents as scanDatabaseEventsWithContext,
  type DiscoveredDbStat,
  type UsageScanContext,
} from './usage-scanner.js';
import { buildUsageSummaryReport } from './usage-report.js';

export {
  resolveDatabaseModelFullName,
  type AvailableAccountUsageOption,
  type DailyTokenUsage,
  type GenerationEvent,
  type HourlyTokenUsage,
  type ModelTokenUsage,
  type TokenUsagePeriod,
  type TokenUsageSummary,
  type TokenUsageTotals,
};

export class UsageStatsManager {
  private rateLocksPath: string;
  private rateLocks: Record<string, { usd: number; price: ApiPricing }> = Object.create(null);
  private rateLocksLoaded = false;
  private rateLocksLoading?: Promise<void>;
  private rateLocksDirty = false;
  private rateLocksUnavailable = false;
  private priceRefMap = new Map<string, ApiPricing>();
  private geminiDir: string;
  private dataDirectoryNames: readonly DataDirectoryName[];
  private pricingCachePath: string;
  public lastDiscoveredDatabaseCount = 0;
  private inFlight?: Promise<TokenUsageSummary>;
  private inFlightForced = false;
  private inFlightAccountKey = 'all';
  private pendingForced?: Promise<TokenUsageSummary>;
  private pricingMutation?: Promise<unknown>;
  private discoveryErrors: NonNullable<TokenUsageSummary['database_diagnostics']> = [];
  private periodKey = '';
  private pricingWarnings:string[]=[];
  private snapshots = new Map<string,{events:GenerationEvent[];prices:Record<string,ApiPricing>;rawPricing:Record<string,ApiPricingEntry>;summary:TokenUsageSummary;expires:number; pins:number; ledger?:LedgerSnapshot}>();
  private scanAbort?: AbortController;
  private fileCache = new Map<string, FileCacheEntry>();
  private totalCachedEvents = 0;

  private persistCachePath?: string;
  private persistLoaded = false;
  private fileCacheDirty = false;
  private observationsPath: string;
  private observationsLoaded = false;
  private observationTimeline: Array<{ at: number; id?: string; email?: string; account_type: 'consumer' | 'enterprise_vertex' | 'unknown' }> = [];
  private ledger: UsageLedger;
  private usageLedgerLoaded = false;
  private usageLedgerLoading?: Promise<void>;
  private usageLedgerDirty = false;
  private usageLedgerEvents = new Map<string, LedgerEvent>();
  private pendingLedgerEvents = new Map<string, LedgerEvent>();
  private largeLedger = false;
  private largeLedgerBaselinePresent = false;
  private ledgerUnavailable = false;
  private ledgerCorrupt = false;
  private archivedUnavailable = false;
  private storageWarnings = new Set<string>();
  private cachedSummariesByAccount = new Map<string, { data: TokenUsageSummary; expiresAt: number }>();
  private lastAggregationKeysByAccount = new Map<string, string>();
  private knownAccounts: Array<{ id: string; email: string; name?: string | null }> = [];
  private currentAccountContext?: { id?: string; email?: string; account_type?: 'consumer' | 'enterprise_vertex' | 'unknown' };
  private accountContextObservedAtSec = Math.floor(Date.now() / 1000);
  private archivedEventsPath: string;
  private archivedEventsLoaded = false;
  private archivedEventsLoading?: Promise<void>;
  private archivedByDb = new Map<
    string,
    {
      archivedAt: string;
      generationsScanned: number;
      skippedLargeRecords: number;
      events: GenerationEvent[];
    }
  >();
  private remotePricingCachePath: string;
  private pricingSyncStatePath: string;
  private remotePricingUrl: string;
  private fallbackPricingUrls: string[];
  private customRemoteUrlConfigured: boolean;
  private autoRemotePricingSync: boolean;
  private lastRemoteSyncAt = 0;
  private lastSyncSuccess = false;
  private lastCheckAt = 0;
  private lastCheckSuccess = false;
  private nextAutoSyncAt = 0;
  private syncStateLoaded = false;
  private syncStatePromise?: Promise<void>;
  private lastSyncError: string | null = null;
  private lastSyncedSourceUrl = '';
  private lastSyncedVersion = '';
  private activeOfficialModels: string[] | null = null;

  constructor(options?: { geminiDir?: string; stateDir?: string; remotePricingUrl?: string; fallbackPricingUrls?: string[]; dataDirectoryName?: DataDirectoryName }) {
    const defaultGeminiDir = join(homedir(), '.gemini');
    const defaultStateDir = join(homedir(), 'Library', 'Application Support', 'GravityBox');
    this.geminiDir = options?.geminiDir ?? defaultGeminiDir;
    if (options?.dataDirectoryName && !ALLOWED_DATA_DIRECTORY_NAMES.includes(options.dataDirectoryName)) throw new Error('仅统计 Antigravity 正式版用量');
    this.dataDirectoryNames = options?.dataDirectoryName ? [options.dataDirectoryName] : ALLOWED_DATA_DIRECTORY_NAMES;
    const stateDir = options?.stateDir ?? (options?.geminiDir && options.geminiDir !== defaultGeminiDir ? join(options.geminiDir, '.gravitybox_state') : defaultStateDir);
    this.observationsPath = join(stateDir, 'usage-account-observations.json');
    this.ledger = new UsageLedger(stateDir);
    this.rateLocksPath = join(stateDir, 'usage-rate-locks.json');
    this.archivedEventsPath = join(stateDir, 'usage-archived-events.json');
    this.pricingCachePath = join(stateDir, 'api_pricing.json');
    this.remotePricingCachePath = join(stateDir, 'remote_pricing.json');
    this.pricingSyncStatePath = join(stateDir, 'pricing-sync-status.json');
    this.remotePricingUrl = options?.remotePricingUrl ?? process.env.GRAVITYBOX_PRICING_FEED_URL ?? 'https://raw.githubusercontent.com/Enzoo404/gravitybox/main/assets/pricing-feed.json';
    this.customRemoteUrlConfigured = Boolean(options?.remotePricingUrl || process.env.GRAVITYBOX_PRICING_FEED_URL);
    this.fallbackPricingUrls = options?.fallbackPricingUrls ?? DEFAULT_PRICING_FEED_URLS;
    this.autoRemotePricingSync = false;
    if (this.geminiDir === defaultGeminiDir && stateDir === defaultStateDir) {
      const cacheTag = options?.dataDirectoryName ?? 'antigravity';
      this.persistCachePath = join(homedir(), 'Library', 'Caches', 'GravityBox', `usage-db-cache-${cacheTag}-v3.json`);
    }
  }

  async ledgerReview(): Promise<Record<string, unknown>> {
    try { return await this.ledger.review(); }
    catch { return { readOnly: true, unavailable: true, message: '旧账本损坏、版本不支持或超出读取预算；原件已保留，未生成修订候选或覆盖数据。' }; }
  }

  setAutoRemotePricingSync(enabled: boolean) { this.autoRemotePricingSync = enabled; }

  /** 动态更新当前官方 Antigravity 包含的非禁用模型列表，用于价格基准展示过滤。 */
  setActiveOfficialModels(modelIds: Iterable<string> | null): void {
    if (!modelIds) {
      this.activeOfficialModels = null;
      return;
    }
    const list = Array.from(modelIds).map(id => String(id).trim()).filter(Boolean);
    this.activeOfficialModels = list.length > 0 ? list : null;
  }

  private cachedPriceRef(price: ApiPricing): ApiPricing {
    const key = JSON.stringify(price);
    let ref = this.priceRefMap.get(key);
    if (!ref) {
      ref = Object.freeze(structuredClone(price));
      this.priceRefMap.set(key, ref);
    }
    return ref;
  }

  private isUnpricedRateLock(value: { usd: number; price?: ApiPricing } | undefined): boolean {
    if (!value || !value.price) return true;
    return (
      value.usd === 0 &&
      value.price.input === 0 &&
      value.price.output === 0 &&
      value.price.cached === 0 &&
      (value.price.cacheWrite ?? 0) === 0
    );
  }

  async previewRevalueHistory(mode: 'force_all' | 'unpriced_only' = 'force_all') {
    await this.getUsageSummary(true);
    return this.ledger.revalue({ action: 'preview', mode, prices: await this.getRawPricingTable(), accounts: [], now: Math.floor(Date.now() / 1000) });
  }

  private async mutateHistoricalPricing<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pricingMutation) await this.pricingMutation;
    const pendingRead = this.inFlight;
    const work = (async () => { await pendingRead?.catch(() => {}); await this.rateLocksLoading?.catch(() => {}); return operation(); })();
    this.pricingMutation = work;
    try { return await work; }
    finally { if (this.pricingMutation === work) this.pricingMutation = undefined; }
  }

  async revalueHistory(confirmed = false, options?: { mode?: 'force_all' | 'unpriced_only'; previewId?: string }): Promise<{ before: number; after: number; message: string }> {
    if (!confirmed) throw Error('重新估算历史费用需要明确确认');
    if (!options?.previewId) throw Error('请先查看历史重估预览，再确认该预览；历史金额未改变');
    return this.mutateHistoricalPricing(async () => {
      const result = await this.ledger.revalue({ action: 'apply', confirmed, previewId: options.previewId,
        prices: await this.getRawPricingTable(), accounts: [], now: Math.floor(Date.now() / 1000) });
      this.rateLocksLoaded = false;
      this.rateLocks = Object.create(null);
      this.cachedSummariesByAccount.clear(); this.lastAggregationKeysByAccount.clear(); this.snapshots.clear();
      return result;
    });
  }

  async restoreRevalueHistory(previewId: string, confirmed = false) {
    return this.mutateHistoricalPricing(async () => {
      const result = await this.ledger.revalue({ action: 'restore', previewId, confirmed, prices: await this.getRawPricingTable(), accounts: [], now: Math.floor(Date.now() / 1000) });
      this.rateLocksLoaded = false; this.rateLocks = Object.create(null);
      this.cachedSummariesByAccount.clear(); this.lastAggregationKeysByAccount.clear(); this.snapshots.clear();
      return result;
    });
  }

  private loadRateLocks(): Promise<void> {
    if (this.rateLocksLoading) return this.rateLocksLoading;
    if (this.rateLocksLoaded) return Promise.resolve();
    const work = this.loadRateLocksOnce().finally(() => { if (this.rateLocksLoading === work) this.rateLocksLoading = undefined; });
    this.rateLocksLoading = work;
    return work;
  }

  private async loadRateLocksOnce(): Promise<void> {
    if (this.rateLocksLoaded) return;
    this.rateLocksLoaded = true;
    if (this.largeLedger || this.ledgerUnavailable || this.archivedUnavailable) {
      if (this.ledgerUnavailable || this.archivedUnavailable) this.rateLocksUnavailable = true;
      return;
    }
    try {
      const data = JSON.parse(await readFile(this.rateLocksPath, 'utf8'));
      if (data.version !== 1 || !data.entries || typeof data.entries !== 'object') throw Error('费率账本格式无效');
      const profiles: ApiPricing[] = Array.isArray(data.profiles) ? data.profiles : [];
      const cachedProfiles = profiles.map(p => (p ? this.cachedPriceRef(p) : undefined));
      let hasLegacyInlinePrice = false;
      for (const [key, value] of Object.entries<any>(data.entries)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !Number.isFinite(value?.usd) || value.usd < 0) throw Error('费率账本条目无效');
        let price: ApiPricing | undefined = value.price ? this.cachedPriceRef(value.price) : undefined;
        if (!price && typeof value.p === 'number') {
          price = cachedProfiles[value.p];
        }
        if (!price) throw Error('费率账本条目无效');
        if (value.price) hasLegacyInlinePrice = true;
        this.rateLocks[key] = { usd: value.usd, price };
      }
      if (hasLegacyInlinePrice || !data.profiles) {
        this.rateLocksDirty = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.rateLocksUnavailable = true;
        this.pricingWarnings.push('历史费率账本不可读，停止重新计价；请保留原文件供恢复');
      }
    }

    if (!this.rateLocksUnavailable) {
      const indexed = await this.ledger.locks();
      for (const [key, value] of Object.entries(indexed)) this.rateLocks[key] = { usd: value.usd, price: this.cachedPriceRef(value.price) };
    }
  }

  private async saveRateLocks(): Promise<void> {
    const profiles: ApiPricing[] = [];
    const profileMap = new Map<string, number>();
    const getProfileIndex = (price: ApiPricing): number => {
      const key = JSON.stringify(price);
      let idx = profileMap.get(key);
      if (idx === undefined) {
        idx = profiles.length;
        profileMap.set(key, idx);
        profiles.push(price);
      }
      return idx;
    };
    const slimEntries: Record<string, { usd: number; p: number }> = Object.create(null);
    for (const [key, val] of Object.entries(this.rateLocks)) {
      slimEntries[key] = { usd: val.usd, p: getProfileIndex(val.price) };
    }
    const payload = { version: 1, profiles, entries: slimEntries };
    await this.ledger.saveLocks(this.rateLocks);
    await atomicText(this.rateLocksPath, JSON.stringify(payload) + '\n');
  }

  private lockedCost(event: GenerationEvent, price: ApiPricing | null): number | null {
    if (this.rateLocksUnavailable || this.ledgerUnavailable || this.archivedUnavailable || event.timestamp_seconds <= 0) return null;
    const existing = event.event_key ? this.rateLocks[event.event_key] ?? (event.legacy_event_key && this.usageLedgerEvents.get(event.legacy_event_key)?.timestamp_seconds === event.timestamp_seconds ? this.rateLocks[event.legacy_event_key] : undefined) : undefined;
    if (existing) {
      if (!event.source_id) return existing.usd;
      const usd = calculateEstimatedUsd(event.input_tokens, event.output_tokens, event.cached_tokens, existing.price, event.cache_write_tokens ?? 0);
      if (!this.rateLocks[event.event_key!] || this.rateLocks[event.event_key!]!.usd !== usd) {
        this.rateLocks[event.event_key!] = { usd, price: existing.price }; this.rateLocksDirty = true;
      }
      return usd;
    }
    if (!price || ((event.cache_write_tokens ?? 0) > 0 && !Number.isFinite(price.cacheWrite))) return null;
    const usd = calculateEstimatedUsd(event.input_tokens, event.output_tokens, event.cached_tokens, price, event.cache_write_tokens ?? 0);
    if (event.event_key) {
      this.rateLocks[event.event_key] = { usd, price: this.cachedPriceRef(price) };
      this.rateLocksDirty = true;
    }
    return usd;
  }

  setDataDirectoryName(name?: DataDirectoryName): void {
    if (name && !ALLOWED_DATA_DIRECTORY_NAMES.includes(name)) throw new Error('仅统计 Antigravity 正式版用量');
    const nextNames = name ? [name] : ALLOWED_DATA_DIRECTORY_NAMES;
    if (this.dataDirectoryNames.join(',') === nextNames.join(',')) return;
    this.cancelRead();
    this.dataDirectoryNames = nextNames;
    this.cachedSummariesByAccount.clear();
    this.lastAggregationKeysByAccount.clear();
    this.discoveredStats.clear();
    const defaultGeminiDir = join(homedir(), '.gemini');
    const defaultStateDir = join(homedir(), 'Library', 'Application Support', 'GravityBox');
    if (this.geminiDir === defaultGeminiDir && this.pricingCachePath === join(defaultStateDir, 'api_pricing.json')) {
      const cacheTag = name ?? 'antigravity';
      this.persistCachePath = join(homedir(), 'Library', 'Caches', 'GravityBox', `usage-db-cache-${cacheTag}-v3.json`);
      this.persistLoaded = false;
    }
  }

  private setFileCacheEntry(dbPath: string, entry: FileCacheEntry): void {
    const existing = this.fileCache.get(dbPath);
    if (existing) {
      this.totalCachedEvents -= existing.events.length;
    } else if (this.fileCache.size >= 2000) {
      const oldestKey = this.fileCache.keys().next().value;
      if (oldestKey) {
        const evicted = this.fileCache.get(oldestKey);
        if (evicted) this.totalCachedEvents -= evicted.events.length;
        this.fileCache.delete(oldestKey);
      }
    }
    if (this.totalCachedEvents > 50_000) {
      for (const [key, value] of this.fileCache) {
        if (this.totalCachedEvents <= 50_000) break;
        if (key !== dbPath) {
          this.fileCache.delete(key);
          this.totalCachedEvents -= value.events.length;
        }
      }
    }
    this.fileCache.set(dbPath, entry);
    this.totalCachedEvents += entry.events.length;
  }

  private async loadPersistentFileCache(): Promise<void> {
    if (this.persistLoaded || !this.persistCachePath) return;
    this.persistLoaded = true;
    try {
      const raw = JSON.parse(await readFile(this.persistCachePath, 'utf8'));
      if (raw && raw.version === 3 && typeof raw.entries === 'object' && raw.entries !== null) {
        for (const [k, v] of Object.entries(raw.entries as Record<string, any>)) {
          if (v && typeof v.mtimeMs === 'number' && typeof v.size === 'number' && Array.isArray(v.events) && v.events.every((e: GenerationEvent) => typeof e.event_key === 'string') && !v.hasError && !this.fileCache.has(k)) {
            this.setFileCacheEntry(k, v);
          }
        }
      }
    } catch {}
  }

  private async savePersistentFileCache(): Promise<void> {
    if (!this.persistCachePath || !this.fileCacheDirty) return;
    this.fileCacheDirty = false;
    const entries: Record<string, any> = {};
    for (const [k, v] of this.fileCache.entries()) {
      if (!v.hasError) entries[k] = v;
    }
    const targetPath = this.persistCachePath;
    await atomicJson(targetPath, { version: 3, entries }, undefined, { durability: 'relaxed' }).catch(() => {
      this.fileCacheDirty = true;
    });
  }

  private normalizeArchivedDbKey(dbPath: string): { key: string; dirName: string } {
    const normalized = dbPath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    const base = basename(normalized);
    for (const allowed of ALLOWED_DATA_DIRECTORY_NAMES) {
      const idx = parts.lastIndexOf(allowed);
      if (idx >= 0) {
        return { key: `${allowed}/${base}`, dirName: allowed };
      }
    }
    return { key: `antigravity/${base}`, dirName: 'antigravity' };
  }

  private loadArchivedEvents(): Promise<void> {
    if (this.archivedEventsLoading) return this.archivedEventsLoading;
    if (this.archivedEventsLoaded) return Promise.resolve();
    const work = this.loadArchivedEventsOnce().finally(() => { if (this.archivedEventsLoading === work) this.archivedEventsLoading = undefined; });
    this.archivedEventsLoading = work;
    return work;
  }

  private async loadArchivedEventsOnce(): Promise<void> {
    if (this.archivedEventsLoaded) return;
    this.archivedEventsLoaded = true;
    try {
      const raw = JSON.parse(await readFile(this.archivedEventsPath, 'utf8'));
      if (!raw || raw.version !== 1 || typeof raw.databases !== 'object' || raw.databases === null) throw Error('归档账本版本或结构无效');
      for (const [key, entry] of Object.entries<any>(raw.databases)) {
        if (!entry || !Array.isArray(entry.events)) throw Error('归档账本事件列表无效');
        const validEvents = entry.events.filter((e: any): e is GenerationEvent =>
          Boolean(
            e &&
            typeof e.model === 'string' &&
            Number.isFinite(e.input_tokens) &&
            Number.isFinite(e.output_tokens) &&
            Number.isFinite(e.cached_tokens) &&
            Number.isFinite(e.total_tokens) &&
            Number.isFinite(e.timestamp_seconds)
          )
        );
        if (validEvents.length !== entry.events.length) throw Error('归档账本含无效事件');
        this.archivedByDb.set(key, {
          archivedAt: typeof entry.archivedAt === 'string' ? entry.archivedAt : new Date(0).toISOString(),
          generationsScanned: Number.isFinite(entry.generationsScanned) ? Number(entry.generationsScanned) : validEvents.length,
          skippedLargeRecords: Number.isFinite(entry.skippedLargeRecords) ? Number(entry.skippedLargeRecords) : 0,
          events: validEvents,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.archivedUnavailable = true;
        this.storageWarnings.add('归档用量账本读取异常，原件已保留，停止写回');
      }
    }
  }

  setKnownAccounts(accounts: Array<{ id: string; email: string; name?: string | null }>): void {
    this.knownAccounts = Array.isArray(accounts) ? accounts.filter(a => a && (a.id || a.email)) : [];
  }

  private ensureObservationTimelineLoaded(): void {
    if (this.observationsLoaded) return;
    this.observationsLoaded = true;
    try {
      const raw = JSON.parse(readFileSync(this.observationsPath, 'utf8'));
      if (raw && raw.version === 1 && Array.isArray(raw.entries)) {
        const valid = raw.entries.filter((e: any) => e && typeof e.at === 'number' && Number.isFinite(e.at));
        if (valid.length > 0) {
          this.observationTimeline = valid
            .concat(this.observationTimeline)
            .sort((a: any, b: any) => a.at - b.at)
            .slice(-500);
        }
      }
    } catch {}
  }

  private async loadObservationTimeline(): Promise<void> {
    this.ensureObservationTimelineLoaded();
  }

  private saveObservationTimeline(): void {
    if (this.observationTimeline.length === 0) return;
    const payload = { version: 1, entries: this.observationTimeline.slice(-500) };
    void atomicJson(this.observationsPath, payload, undefined, { durability: 'relaxed' }).catch(() => {});
  }

  private lookupObservedContext(timestampSec: number): { id?: string; email?: string; account_type: 'consumer' | 'enterprise_vertex' | 'unknown' } | null {
    if (timestampSec <= 0) return null;
    this.ensureObservationTimelineLoaded();
    if (this.currentAccountContext && timestampSec >= this.accountContextObservedAtSec) {
      return {
        id: this.currentAccountContext.id,
        email: this.currentAccountContext.email,
        account_type: this.currentAccountContext.account_type ?? 'unknown',
      };
    }
    let matched: { at: number; id?: string; email?: string; account_type: 'consumer' | 'enterprise_vertex' | 'unknown' } | null = null;
    for (const entry of this.observationTimeline) {
      if (entry.at <= timestampSec) matched = entry;
      else break;
    }
    if (matched && (matched.id || matched.email)) {
      return { id: matched.id, email: matched.email, account_type: matched.account_type };
    }
    return null;
  }

  setCurrentAccountContext(ctx?: { id?: string; email?: string; account_type?: 'consumer' | 'enterprise_vertex' | 'unknown' }): void {
    this.ensureObservationTimelineLoaded();
    const prevEmail = (this.currentAccountContext?.email || '').trim().toLowerCase();
    const nextEmail = (ctx?.email || '').trim().toLowerCase();
    const prevId = this.currentAccountContext?.id || '';
    const nextId = ctx?.id || '';
    const nextType = ctx?.account_type || 'unknown';
    const sameUser = nextEmail
      ? prevEmail === nextEmail
      : (prevId === nextId && prevEmail === '');
    if (!sameUser) {
      const nowSec = Math.floor(Date.now() / 1000);
      this.accountContextObservedAtSec = nowSec;
      const last = this.observationTimeline[this.observationTimeline.length - 1];
      const nextEntry = ctx
        ? { at: nowSec, id: ctx.id, email: ctx.email, account_type: nextType }
        : { at: nowSec, account_type: 'unknown' as const };
      const isSameAsLast =
        last &&
        (last.email || '').toLowerCase() === (nextEntry.email || '').toLowerCase() &&
        (last.id || '') === (nextEntry.id || '');
      if (!isSameAsLast) {
        this.observationTimeline.push(nextEntry);
        if (this.observationTimeline.length > 500) {
          this.observationTimeline = this.observationTimeline.slice(-500);
        }
        this.saveObservationTimeline();
      }
    }
    this.currentAccountContext = ctx
      ? { id: ctx.id, email: ctx.email, account_type: nextType }
      : undefined;
  }

  private loadUsageLedger(): Promise<void> {
    if (this.usageLedgerLoading) return this.usageLedgerLoading;
    if (this.usageLedgerLoaded) return Promise.resolve();
    const work = this.loadUsageLedgerOnce().finally(() => { if (this.usageLedgerLoading === work) this.usageLedgerLoading = undefined; });
    this.usageLedgerLoading = work;
    return work;
  }

  private async loadUsageLedgerOnce(): Promise<void> {
    if (this.usageLedgerLoaded) return;
    this.usageLedgerLoaded = true;
    await this.loadObservationTimeline();
    try {
      const totalCount = await this.ledger.count();
      this.largeLedger = totalCount > 50_000;
      this.largeLedgerBaselinePresent = totalCount > 0;
      for (const event of this.largeLedger ? [] : await this.ledger.load()) {
        if (event.db_file === 'recovered_session.db' || event.db_file === 'recovered_enterprise_session.db') {
          this.storageWarnings.add('旧账本含费用反推的合成事件，原记录已保留，未计入可核验用量；请核对恢复材料');
          continue;
        }
        if (event.account_confidence === 'legacy') this.storageWarnings.add('旧JSON的账号归属缺少确证，已保留原件，仅计入全部账号；可在账本预览中核对');
        this.usageLedgerEvents.set(event.event_key!, event);
      }
    } catch {
      this.ledgerUnavailable = true;
      this.ledgerCorrupt = true;
      this.storageWarnings.add('持久化用量总账无法读取或版本不支持，原件已保留，停止写回；当前只展示可读取的源数据');
    }
    await this.loadArchivedEvents();
    for (const [key, archive] of this.archivedByDb) {
      for (const event of archive.events) this.upsertLedger({ ...event, db_file: basename(key) });
    }
  }

  private upsertLedger(event: LedgerEvent): void {
    const key = event.event_key;
    if (!key || event.db_file === 'recovered_session.db' || event.db_file === 'recovered_enterprise_session.db') return;
    const previous = this.usageLedgerEvents.get(key);
    if ((previous?.source_observed_at ?? 0) > (event.source_observed_at ?? 0)) return;
    const next = { ...previous, ...event,
      timestamp_seconds: event.timestamp_seconds || previous?.timestamp_seconds || 0,
      ingested_at: previous?.ingested_at ?? event.ingested_at ?? new Date().toISOString() };
    // Absence of new attribution evidence must not erase an existing observed identity.
    if (previous?.account_confidence === 'observed') {
      if (!event.account_id) {
        next.account_id = previous.account_id;
        next.account_email = previous.account_email;
        next.account_confidence = previous.account_confidence;
      }
      if (previous.account_type && previous.account_type !== 'unknown' && (!event.account_type || event.account_type === 'unknown')) {
        next.account_type = previous.account_type;
      }
    }
    if (previous && ledgerEventsEqual(previous, next)) return;
    this.usageLedgerEvents.set(key, next);
    if (this.usageLedgerEvents.size > 50_000) this.largeLedger = true;
    this.pendingLedgerEvents.set(key, next);
    this.usageLedgerDirty = true;
  }

  private async saveUsageLedger(): Promise<void> {
    if (!this.usageLedgerDirty) return;
    if (this.ledgerUnavailable || this.archivedUnavailable) return;
    const pending = [...this.pendingLedgerEvents.values()];
    try {
      await this.ledger.save(pending);
      for (const event of pending) {
        if (this.pendingLedgerEvents.get(event.event_key!) === event) this.pendingLedgerEvents.delete(event.event_key!);
      }
      this.usageLedgerDirty = this.pendingLedgerEvents.size > 0;
    } catch {
      this.storageWarnings.add('用量总账未能保存，原始数据已保留；统计尚未持久化，请检查磁盘与权限');
      this.ledgerUnavailable = true;
    }
  }

  /**
   * 账号切换前置固化：并发扫描近期活跃会话库并在结束后一次性固化到 UsageLedger。
   */
  async captureCurrentActiveSessions(accountContext?: { id?: string; email?: string }): Promise<{ captured: number }> {
    if (accountContext) {
      this.setCurrentAccountContext(accountContext);
    }
    await this.loadPersistentFileCache();
    await this.loadUsageLedger();
    const dbPaths = await this.discoverDatabaseFiles();
    const nowMs = Date.now();
    const activePaths = dbPaths.filter(p => {
      const st = this.discoveredStats.get(p);
      if (!st || !this.fileCache.has(p)) return true;
      return nowMs - Math.max(st.mtimeMs, st.walMtimeMs) <= 30 * 60_000;
    });
    let captured = 0;
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, activePaths.length) }, async () => {
      while (cursor < activePaths.length) {
        const p = activePaths[cursor++]!;
        const res = await this.scanDatabaseEvents(p, true).catch(() => null);
        if (res && res.events.length > 0) {
          captured += res.events.length;
        }
      }
    }));
    if (this.usageLedgerDirty) {
      await this.saveUsageLedger();
    }
    if (this.largeLedger) {
      this.usageLedgerEvents.clear();
    }
    this.invalidateCache();
    return { captured };
  }

  public invalidateCache(): void {
    this.cachedSummariesByAccount.clear();
    this.lastAggregationKeysByAccount.clear();
    this.discoveredStats.clear();
  }

  /**
   * 在存储维护将非活跃 Subagent / 孤儿会话 .db 移入废纸篓前，
   * 先将其中的 Token 生成事件与锁定费率固化至 GravityBox 本地归档账本，确保历史账单零丢失。
   */
  public async archiveDatabasesBeforeClear(dbPaths: string[]): Promise<{ archivedCount: number; eventCount: number }> {
    if (!Array.isArray(dbPaths) || dbPaths.length === 0) {
      return { archivedCount: 0, eventCount: 0 };
    }
    await this.loadArchivedEvents();
    await this.loadPersistentFileCache();
    await this.loadUsageLedger();
    await this.loadRateLocks();
    if (this.archivedUnavailable || this.ledgerUnavailable || this.rateLocksUnavailable) throw Error('账本不可读，已中止清理以保护历史记录');
    const rawPricing = await this.getRawPricingTable();

    let archivedCount = 0;
    let eventCount = 0;
    for (const dbPath of dbPaths) {
      if (typeof dbPath !== 'string' || !dbPath.endsWith('.db')) continue;
      const st = await lstat(dbPath).catch(() => null);
      if (!st || !st.isFile() || st.isSymbolicLink()) continue;
      const res = await this.scanDatabaseEvents(dbPath, true);
      if (res.hasError || res.usedCached || res.skippedLargeRecords > 0) {
        throw new Error(`归档会话数据库用量失败（${basename(dbPath)}）：${res.error || '无法读取'}；已中止清理以保护历史账单`);
      }
      for (const ev of res.events) {
        const price = this.resolvePricing(rawPricing, ev.model, ev.timestamp_seconds);
        if (!this.largeLedger) this.lockedCost(ev, price);
      }
      const { key } = this.normalizeArchivedDbKey(dbPath);
      this.archivedByDb.set(key, {
        archivedAt: new Date().toISOString(),
        generationsScanned: res.generationsScanned,
        skippedLargeRecords: res.skippedLargeRecords,
        events: res.events,
      });
      archivedCount++;
      eventCount += res.events.length;
    }

    if (archivedCount > 0) {
      if (this.rateLocksDirty) {
        await this.saveRateLocks();
        this.rateLocksDirty = false;
      }
      await this.saveUsageLedger();
      if (this.largeLedger) await this.ledger.aggregate({ prices: rawPricing, accounts: this.knownAccounts, now: Math.floor(Date.now() / 1000) });
      if (this.ledgerUnavailable) throw Error('归档总账未能持久化，已中止清理');
      await this.savePersistentFileCache();
      await atomicJson(this.archivedEventsPath, {
        version: 1,
        updatedAt: new Date().toISOString(),
        databases: Object.fromEntries(this.archivedByDb.entries()),
      });
      const persisted = JSON.parse(await readFile(this.archivedEventsPath, 'utf8'));
      if (JSON.stringify(persisted.databases) !== JSON.stringify(Object.fromEntries(this.archivedByDb))) throw Error('归档回读校验失败，已中止清理');
      this.invalidateCache();
    }
    return { archivedCount, eventCount };
  }

  public resolvePricing(
    pricingTable: Record<string, ApiPricingEntry>,
    modelName: string,
    timestampSeconds: number
  ): ApiPricing | null {
    return resolvePricingFromTable(pricingTable, modelName, timestampSeconds);
  }

  private calendarKey() { const d=new Date();return formatLocalDate(d)+':'+d.getTimezoneOffset()+':'+Intl.DateTimeFormat().resolvedOptions().timeZone; }

  async getRawPricingTable(): Promise<Record<string, ApiPricingEntry>> {
    const { merged, warnings } = await loadRawPricingTable(this.remotePricingCachePath, this.pricingCachePath);
    this.pricingWarnings = warnings;
    return merged;
  }

  private resolvePricingTableFromRaw(
    raw: Record<string, ApiPricingEntry>,
    timestampSeconds = Math.floor(Date.now() / 1000),
    allowedKeys?: Set<string>
  ): Record<string, ApiPricing> {
    return resolvePricingTableFromRaw(raw, timestampSeconds, allowedKeys);
  }

  async getPricingTable(timestampSeconds = Math.floor(Date.now() / 1000)): Promise<Record<string, ApiPricing>> {
    const raw = await this.getRawPricingTable();
    return this.resolvePricingTableFromRaw(raw, timestampSeconds);
  }

  private canonicalActivePricingKeys(modelIds?: Iterable<string> | null): Set<string> {
    return canonicalActivePricingKeys(modelIds !== undefined && modelIds !== null ? modelIds : this.activeOfficialModels);
  }

  /**
   * 仅返回当前 Antigravity 官方包含模型对应的生效价格基准，不包含已下线历史模型；
   * 历史事件计价仍通过 getRawPricingTable() / rateLocks 独立保留，互不影响。
   */
  async getActivePricingTable(
    timestampSeconds = Math.floor(Date.now() / 1000),
    activeModelIds?: Iterable<string> | null
  ): Promise<Record<string, ApiPricing>> {
    const raw = await this.getRawPricingTable();
    return this.resolvePricingTableFromRaw(raw, timestampSeconds, this.canonicalActivePricingKeys(activeModelIds));
  }

  private pricingSyncStateSnapshot(): PricingSyncMutableState {
    return {
      lastRemoteSyncAt: this.lastRemoteSyncAt,
      lastSyncSuccess: this.lastSyncSuccess,
      lastCheckAt: this.lastCheckAt,
      lastCheckSuccess: this.lastCheckSuccess,
      nextAutoSyncAt: this.nextAutoSyncAt,
      lastSyncError: this.lastSyncError,
      lastSyncedSourceUrl: this.lastSyncedSourceUrl,
      lastSyncedVersion: this.lastSyncedVersion,
    };
  }

  private applyPricingSyncState(next: PricingSyncMutableState): void {
    this.lastRemoteSyncAt = next.lastRemoteSyncAt;
    this.lastSyncSuccess = next.lastSyncSuccess;
    this.lastCheckAt = next.lastCheckAt;
    this.lastCheckSuccess = next.lastCheckSuccess;
    this.nextAutoSyncAt = next.nextAutoSyncAt;
    this.lastSyncError = next.lastSyncError;
    this.lastSyncedSourceUrl = next.lastSyncedSourceUrl;
    this.lastSyncedVersion = next.lastSyncedVersion;
  }

  private async ensureSyncStateLoaded(): Promise<void> {
    if (this.syncStateLoaded) return;
    if (!this.syncStatePromise) {
      this.syncStatePromise = (async () => {
        const snapshot = this.pricingSyncStateSnapshot();
        await loadPricingSyncState(this.remotePricingCachePath, this.pricingSyncStatePath, snapshot);
        this.applyPricingSyncState(snapshot);
        this.syncStateLoaded = true;
      })().finally(() => {
        this.syncStatePromise = undefined;
      });
    }
    await this.syncStatePromise;
  }

  async syncRemotePricing(feedUrl?: string, force = false): Promise<{ synced: boolean; error?: string; count?: number; sourceUrl?: string; version?: string; healedCount?: number }> {
    await this.ensureSyncStateLoaded();
    const candidateUrls = selectRemotePricingCandidateUrls({
      feedUrl,
      customRemoteUrlConfigured: this.customRemoteUrlConfigured,
      remotePricingUrl: this.remotePricingUrl,
      fallbackPricingUrls: this.fallbackPricingUrls,
    });
    const now = Date.now();
    if (!force && now < this.nextAutoSyncAt) {
      return { synced: false, error: '检查频率限制（24小时）' };
    }
    const snapshot = this.pricingSyncStateSnapshot();
    const result = await executeRemotePricingSync({
      candidateUrls,
      remotePricingCachePath: this.remotePricingCachePath,
      pricingSyncStatePath: this.pricingSyncStatePath,
      state: snapshot,
      now,
    });
    this.applyPricingSyncState(snapshot);
    this.syncStateLoaded = true;
    if (!result.synced) {
      return result;
    }
    this.cachedSummariesByAccount.clear();
    this.lastAggregationKeysByAccount.clear();
    let healedCount = 0;
    try {
      healedCount = await this.autoHealUnpricedHistory();
    } catch {}
    return { ...result, healedCount };
  }

  async getPricingSyncStatus(): Promise<{
    autoSyncEnabled: boolean;
    lastSyncAt: number;
    lastCheckAt: number;
    lastSyncSuccess: boolean;
    lastCheckSuccess: boolean;
    lastSyncError: string | null;
    feedVersion: string;
    sourceUrl: string;
    modelCount: number;
  }> {
    await this.ensureSyncStateLoaded();
    const activeTable = await this.getActivePricingTable();
    return buildPricingSyncStatus({
      autoSyncEnabled: this.autoRemotePricingSync,
      state: this.pricingSyncStateSnapshot(),
      remotePricingUrl: this.remotePricingUrl,
      modelCount: Object.keys(activeTable).length,
    });
  }

  async savePricingTable(table: Record<string, ApiPricing | ApiPricingInterval[]>): Promise<void> {
    await saveCustomPricingCache(this.pricingCachePath, table);
    this.cachedSummariesByAccount.clear();
    this.lastAggregationKeysByAccount.clear();
  }

  /**
   * 自动智能补齐未计价历史记录（零按钮、用户无感）：
   * 仅针对历史账本中由于此前模型未定价而记录为 $0.00 的条目，
   * 在获取到官方最新定价后，按真实发生物理时间戳匹配当时费率，
   * 自动补齐并锁定；已锁定且有正常费率的记录绝对不动。
   */
  async autoHealUnpricedHistory(): Promise<number> {
    await this.loadRateLocks();
    if (this.rateLocksUnavailable) return 0;
    const unpricedKeys: string[] = [];
    for (const [key, value] of Object.entries(this.rateLocks)) {
      if (this.isUnpricedRateLock(value)) {
        unpricedKeys.push(key);
      }
    }
    if (unpricedKeys.length === 0) return 0;

    for (const key of unpricedKeys) {
      delete this.rateLocks[key];
    }
    this.rateLocksDirty = true;
    this.cachedSummariesByAccount.clear();
    this.lastAggregationKeysByAccount.clear();
    this.snapshots.clear();

    await this.getUsageSummary(true);
    return unpricedKeys.length;
  }

  private discoveredStats = new Map<string, DiscoveredDbStat>();

  /**
   * 发现全部会话数据库；修改时间仅决定读取顺序，默认不截断统计范围。
   */
  async discoverDatabaseFiles(maxFiles = Number.POSITIVE_INFINITY): Promise<string[]> {
    const res = await discoverDatabaseFilesInDir(this.geminiDir, this.dataDirectoryNames, this.discoveredStats, maxFiles);
    this.discoveryErrors = res.errors;
    this.lastDiscoveredDatabaseCount = res.discoveredCount;
    return res.paths;
  }

  private scanContext(): UsageScanContext {
    return {
      discoveredStats: this.discoveredStats,
      fileCache: this.fileCache,
      setFileCacheEntry: (dbPath, entry) => this.setFileCacheEntry(dbPath, entry),
      markFileCacheDirty: () => { this.fileCacheDirty = true; },
      lookupObservedContext: (ts) => this.lookupObservedContext(ts),
      loadUsageLedger: () => this.loadUsageLedger(),
      upsertLedger: (event) => this.upsertLedger(event),
      getLedgerEvent: (eventKey) => this.usageLedgerEvents.get(eventKey),
    };
  }

  /**
   * 解析单数据库中的 Token 生成事件（按文件 mtimeMs、size 与 WAL 变动增量缓存；遇并发读写或新建初始化库自动退避重试）
   */
  async scanDatabaseEvents(dbPath: string, bypassCache = false, signal?: AbortSignal): Promise<{
    events: GenerationEvent[];
    generationsScanned: number;
    skippedLargeRecords: number;
    hasError?: boolean;
    error?: string;
    usedCached?: boolean;
    cacheHit?: boolean;
  }> {
    return scanDatabaseEventsWithContext(this.scanContext(), dbPath, bypassCache, signal);
  }

  /** Privacy-preserving request rows: metrics only, no database paths or conversation content. */
  async getUsageEvents(period: string, query = '', offset = 0, limit = 200, snapshotId?: string, pin = false, force = false, accountId?: string) {
    const accKey = accountId || 'all';
    if (!snapshotId || force) await this.getUsageSummary(force, accountId);
    const snapshot=(!force && snapshotId)?this.snapshots.get(snapshotId):this.snapshots.get(this.cachedSummariesByAccount.get(accKey)?.data.snapshot_id??'');
    if (!snapshot || snapshot.expires<Date.now()) throw Error('统计快照已过期，请重新读取');
    if (pin) snapshot.pins++;
    if (snapshot.pins > 0) snapshot.expires = Date.now()+600000;
    if (snapshot.ledger) {
      if (accountId && accountId !== snapshot.ledger.accountId) throw Error('统计快照账号范围不匹配，请重新读取');
      const targetEmail = this.knownAccounts.find(account => account.id === snapshot.ledger!.accountId)?.email;
      const page = await this.ledger.events({ snapshot: snapshot.ledger, period, query: query.slice(0, 200), offset: Math.max(0, Math.floor(offset) || 0), limit: Math.min(500, Math.max(1, Math.floor(limit) || 200)), targetEmail });
      return { ...page, generated_at: snapshot.summary.generated_at, snapshot_id: snapshot.summary.snapshot_id, availability: snapshot.summary.availability, scope: snapshot.summary.scan_scope_description };
    }
    const {summary,prices,rawPricing}=snapshot as any;
    const start = new Date(summary.generated_at*1000); start.setHours(0, 0, 0, 0);
    if (period === '7d') start.setDate(start.getDate() - 6);
    if (period === '30d') start.setDate(start.getDate() - 29);
    const cutoff = period === 'all' ? 0 : start.getTime() / 1000;
    const end = new Date(summary.generated_at*1000); end.setHours(24,0,0,0);
    const upper = end.getTime()/1000;
    const needle = query.toLowerCase().slice(0, 200);
    let events = snapshot.events.filter(e => (period === 'all' || (e.timestamp_seconds >= cutoff && e.timestamp_seconds < upper)) && e.model.toLowerCase().includes(needle));
    if (accountId && accountId !== 'all') {
      const targetOpt = this.knownAccounts.find(a => a.id === accountId || (a.email && a.email.toLowerCase() === accountId.toLowerCase()));
      const targetEmail = targetOpt?.email?.toLowerCase() || (accountId.includes('@') ? accountId.toLowerCase() : null);
      events = events.filter(e => {
        if (e.account_id && e.account_id === accountId) return true;
        if (targetEmail && e.account_email && e.account_email.toLowerCase() === targetEmail) return true;
        return false;
      });
    }
    const safeOffset = Math.max(0, Math.floor(offset) || 0);
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit) || 200));
    const pricingSource = rawPricing ?? prices;
    return { rows: events.slice().reverse().slice(safeOffset, safeOffset + safeLimit).map(e => {
      const price = this.resolvePricing(pricingSource, e.model, e.timestamp_seconds);
      const cost = this.lockedCost(e, price);
      const { event_key: _key, ...publicEvent } = e;
      return { ...publicEvent, estimated_usd: cost, priced: cost !== null };
    }), total: events.length, offset: safeOffset, limit: safeLimit, generated_at: summary.generated_at, snapshot_id: summary.snapshot_id, availability: summary.availability, scope: summary.scan_scope_description };
  }

  releaseSnapshot(id: string) {
    const snapshot = this.snapshots.get(id);
    if (snapshot) { snapshot.pins = Math.max(0, snapshot.pins - 1); snapshot.expires = Date.now()+600000; }
    this.pruneSnapshots();
  }
  private pruneSnapshots() {
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.expires < Date.now() || snapshot.pins === 0 && this.snapshots.size > 4) this.snapshots.delete(id);
    }
  }

  /**
   * 收集并聚合全量 Token 统计与 API 账单报告（带 30 秒内存 TTL 缓存）
   */
  cancelRead() { this.scanAbort?.abort(new Error('读取已取消')); return !!this.scanAbort; }
  async getUsageSummary(forceRefresh = false, accountId?: string): Promise<TokenUsageSummary> {
    if (this.pricingMutation) await this.pricingMutation;
    const accKey = accountId || 'all';
    if(this.inFlight) {
      if(this.inFlightAccountKey===accKey && (!forceRefresh||this.inFlightForced)) return this.inFlight;
      if(this.inFlightAccountKey!==accKey) {
        return this.inFlight.catch(()=>{}).then(()=>this.getUsageSummary(forceRefresh, accountId));
      }
      if(!this.pendingForced)this.pendingForced=this.inFlight.catch(()=>{}).then(()=>this.getUsageSummary(true, accountId)).finally(()=>{this.pendingForced=undefined;});
      return this.pendingForced;
    }
    const abort=this.scanAbort=new AbortController(), timer=setTimeout(()=>abort.abort(new Error('读取超出 30 秒整体预算')),30000);timer.unref();
    this.inFlightForced=forceRefresh;
    this.inFlightAccountKey=accKey;
    const work=this.collectUsage(forceRefresh,abort.signal,accountId);this.inFlight=work;
    try{return await work;}finally{clearTimeout(timer);if(this.inFlight===work){this.inFlight=undefined;this.scanAbort=undefined;this.inFlightForced=false;this.inFlightAccountKey='all';}}
  }
  private async collectUsage(forceRefresh: boolean, signal: AbortSignal, accountId?: string): Promise<TokenUsageSummary> {
    const accKey = accountId || 'all';
    const nowMs = Date.now();
    const cachedByAcc = this.cachedSummariesByAccount.get(accKey);
    if (!forceRefresh && cachedByAcc && nowMs < cachedByAcc.expiresAt && this.periodKey === this.calendarKey() && cachedByAcc.data.failed_databases_count === 0) {
      return cachedByAcc.data;
    }

    await this.loadPersistentFileCache();
    if (forceRefresh && this.ledgerUnavailable && !this.ledgerCorrupt) {
      this.ledgerUnavailable = false;
      this.storageWarnings.delete('用量总账未能保存，原始数据已保留；统计尚未持久化，请检查磁盘与权限');
    }
    const dbPaths = await this.discoverDatabaseFiles();
    const allEvents: GenerationEvent[] = [];
    let generationsScanned = 0;
    let skippedLargeRecords = 0;
    let failedDatabasesCount = this.discoveryErrors.length, cachedDatabasesCount = 0;
    const diagnostics: NonNullable<TokenUsageSummary['database_diagnostics']> = [...this.discoveryErrors];
    const category = (message = '') => /取消|预算|timeout|aborted/i.test(message) ? '读取已取消或超过预算' : /时间/.test(message) ? '时间信息不完整' : /unable to open|permission|denied|not permitted/i.test(message) ? '无法打开数据库或关联文件' : /no such table|no such column/i.test(message) ? '数据库结构暂不支持' : /locked|busy/i.test(message) ? '数据库繁忙' : /maxBuffer|stdout.*length|超出/i.test(message) ? '超过单批读取预算' : /malformed|not a database/i.test(message) ? '格式无法读取' : '读取未完成';

    let nextDatabase=0;
    let allCacheHits = dbPaths.length > 0;
    await Promise.all(Array.from({length:Math.min(8,dbPaths.length)},async()=>{
    while(nextDatabase<dbPaths.length) {
      if(signal.aborted){allCacheHits=false;break;}
      const p=dbPaths[nextDatabase++]!;
      const bypassFileCache = forceRefresh || Boolean(this.fileCache.get(p)?.hasError);
      const res = await this.scanDatabaseEvents(p, bypassFileCache, signal);
      if (!res.cacheHit) allCacheHits = false;
      if (this.largeLedger && !this.ledgerUnavailable) {
        if (!res.cacheHit || !this.largeLedgerBaselinePresent) {
          for (const event of res.events) this.upsertLedger(event);
        }
        if (this.pendingLedgerEvents.size >= 10_000) {
          await this.saveUsageLedger();
          if (this.ledgerUnavailable) {
            for (const ev of res.events) allEvents.push(ev);
          } else {
            this.usageLedgerEvents.clear();
          }
        }
      } else {
        for (const ev of res.events) allEvents.push(ev);
        if (allEvents.length > 50_000 && !this.ledgerUnavailable) {
          this.largeLedger = true;
          const batch = allEvents.splice(0, allEvents.length);
          for (const event of batch) this.upsertLedger(event);
          await this.saveUsageLedger();
          if (this.ledgerUnavailable) {
            for (const ev of batch) allEvents.push(ev);
          } else {
            this.usageLedgerEvents.clear();
          }
        }
      }
      generationsScanned += res.generationsScanned;
      skippedLargeRecords += res.skippedLargeRecords;
      if (res.hasError) failedDatabasesCount++;
      if (res.usedCached) cachedDatabasesCount++;
      const cached = this.fileCache.get(p);
      diagnostics.push({ id: createHash('sha256').update(p).digest('hex').slice(0,10),
        state: res.hasError ? (res.events.length ? 'cached_or_partial' : 'failed') : 'read',
        category: res.hasError ? category(res.error) : '已读取', lastSuccessAt: cached?.lastSuccessAt });
    }
    }));

    for(const path of dbPaths.slice(nextDatabase)) {
      allCacheHits = false;
      const cached=this.fileCache.get(path);failedDatabasesCount++;
      if(cached){for (const ev of cached.events) allEvents.push(ev);cachedDatabasesCount++;generationsScanned+=cached.generationsScanned;skippedLargeRecords+=cached.skippedLargeRecords;}
      diagnostics.push({id:createHash('sha256').update(path).digest('hex').slice(0,10),state:cached?'cached_or_partial':'failed',category:'读取已取消或超过预算',lastSuccessAt:cached?.lastSuccessAt});
    }

    await this.loadArchivedEvents();
    let archivedDbCount = 0;
    const archivedStampParts: string[] = [];
    if (this.archivedByDb.size > 0) {
      const allowedDirs = new Set<string>(this.dataDirectoryNames);
      const liveDbKeys = new Set(dbPaths.map(p => this.normalizeArchivedDbKey(p).key));
      const seenEventKeys = new Set<string>();
      for (const ev of allEvents) {
        if (ev.event_key) seenEventKeys.add(ev.event_key);
      }
      for (const [archKey, archEntry] of this.archivedByDb.entries()) {
        const slashIdx = archKey.indexOf('/');
        const dirName = slashIdx > 0 ? archKey.slice(0, slashIdx) : 'antigravity';
        if (!allowedDirs.has(dirName) || liveDbKeys.has(archKey)) continue;
        archivedDbCount++;
        generationsScanned += archEntry.generationsScanned;
        skippedLargeRecords += archEntry.skippedLargeRecords;
        archivedStampParts.push(`${archKey}:${archEntry.events.length}:${archEntry.archivedAt}`);
        for (const ev of archEntry.events) {
          if (ev.event_key) {
            if (seenEventKeys.has(ev.event_key)) continue;
            seenEventKeys.add(ev.event_key);
          }
          allEvents.push(ev);
        }
      }
      if (dbPaths.length === 0 && archivedDbCount > 0 && failedDatabasesCount === 0) {
        allCacheHits = true;
      }
    }

    await this.loadUsageLedger();
    if (this.largeLedger && !this.ledgerUnavailable) {
      for (const event of allEvents) this.upsertLedger(event);
      await this.saveUsageLedger();
      const rawPricing = await this.getRawPricingTable();
      if (this.rateLocksUnavailable && !this.pricingWarnings.some(w => w.includes('费率账本'))) this.pricingWarnings.push('历史费率账本不可读，未重新计价');
      const revision = await this.ledger.version();
      const aggregateKey = JSON.stringify([revision, this.calendarKey(), rawPricing, accountId ?? 'all', this.knownAccounts]);
      const prior = this.cachedSummariesByAccount.get(accKey)?.data;
      const existingSnapshot = prior?.snapshot_id ? this.snapshots.get(prior.snapshot_id) : undefined;
      if (prior && existingSnapshot?.ledger && this.lastAggregationKeysByAccount.get(accKey) === aggregateKey && await this.ledger.renew(existingSnapshot.ledger)) {
        const availability = failedDatabasesCount > 0 || skippedLargeRecords > 0 || this.storageWarnings.size > 0 || prior.unknown_time_records || prior.historical_amount_receipts?.unmatchedCount ? 'partial' : 'complete';
        const hasReadError = this.ledgerCorrupt || this.archivedUnavailable || failedDatabasesCount > 0 || skippedLargeRecords > 0 || (prior.unknown_time_records ?? 0) > 0;
        const reused: TokenUsageSummary = { ...prior, availability, has_error: hasReadError, hasError: hasReadError,
          failed_databases_count: failedDatabasesCount, database_diagnostics: diagnostics, last_attempt_at: Math.floor(Date.now() / 1000), pricing_warnings: [...this.pricingWarnings, ...this.storageWarnings] };
        existingSnapshot.expires = Date.now() + 600000;
        existingSnapshot.summary = reused;
        this.cachedSummariesByAccount.set(accKey, { data: reused, expiresAt: Date.now() + (failedDatabasesCount > 0 ? 2000 : 30000) });
        return reused;
      }
      const aggregated = await this.ledger.aggregate({ prices: rawPricing, accountId, accounts: this.knownAccounts, liveFiles: dbPaths.map(path => basename(path)), now: Math.floor(Date.now() / 1000) });
      if (aggregated.ledger_review_records) this.storageWarnings.add('旧JSON含缺少来源或归属证据的记录，原件已保留；请查看只读账本预览');
      const availability = failedDatabasesCount > 0 || skippedLargeRecords > 0 || this.storageWarnings.size > 0 || aggregated.unknown_time_records || aggregated.historical_amount_receipts?.unmatchedCount ? 'partial' : 'complete';
      const hasReadError = this.ledgerCorrupt || this.archivedUnavailable || failedDatabasesCount > 0 || skippedLargeRecords > 0 || (aggregated.unknown_time_records ?? 0) > 0;
      const result: TokenUsageSummary = { ...aggregated, availability, has_error: hasReadError, hasError: hasReadError,
        priced_models: aggregated.all_time.priced_models, unpriced_models: aggregated.all_time.unpriced_models,
        databases_scanned: dbPaths.length, databases_discovered: this.lastDiscoveredDatabaseCount || dbPaths.length,
        generations_scanned: generationsScanned, skipped_large_records: skippedLargeRecords, failed_databases_count: failedDatabasesCount,
        database_diagnostics: diagnostics, scan_scope_description: '本机索引用量总账（含已离线记录）', pricing_warnings: [...this.pricingWarnings, ...this.storageWarnings] };
      const id = result.snapshot_id!;
      const previous = this.snapshots.get(id);
      if (previous) result.generated_at = previous.summary.generated_at;
      this.snapshots.set(id, { summary: result, ledger: previous?.ledger ?? aggregated.ledger_snapshot, events: [], prices: {}, rawPricing,
        expires: Date.now() + 600000, pins: previous?.pins ?? 0 });
      this.lastAggregationKeysByAccount.set(accKey, JSON.stringify([await this.ledger.version(), this.calendarKey(), rawPricing, accountId ?? 'all', this.knownAccounts]));
      this.cachedSummariesByAccount.set(accKey, { data: result, expiresAt: Date.now() + (failedDatabasesCount > 0 ? 2000 : 30000) });
      this.periodKey = this.calendarKey();
      this.usageLedgerEvents.clear();
      this.pruneSnapshots();
      return result;
    }

    const liveEventsCount = allEvents.length;

    await this.loadUsageLedger();

    for (const event of allEvents) this.upsertLedger(event);

    // 从追加型永久总账（UsageLedger）合并已离线/已归档或被官方清理的会话事件
    const seenEventKeys = new Set<string>();
    for (const ev of allEvents) {
      if (ev.event_key) seenEventKeys.add(ev.event_key);
    }
    const currentLegacyKeys = new Set(allEvents.map(event => event.legacy_event_key).filter(Boolean));
    for (const ledgerEv of this.usageLedgerEvents.values()) {
      if (ledgerEv.legacy_event_key) currentLegacyKeys.add(ledgerEv.legacy_event_key);
    }
    const liveSourceFiles = new Set(dbPaths.map(path => basename(path)));
    const representedFiles = new Set([...dbPaths.map(path => basename(path)), ...[...this.archivedByDb.keys()].map(path => basename(path))]);
    const mergedLedgerDbs = new Set<string>();
    for (const [evKey, ledgerEv] of this.usageLedgerEvents.entries()) {
      if (currentLegacyKeys.has(evKey)) continue;
      if (!ledgerEv.source_id && ledgerEv.db_file && liveSourceFiles.has(ledgerEv.db_file)) {
        this.storageWarnings.add('旧账本缺少稳定请求身份，相关历史记录待核对；原JSON保留，未与当前源数据重复累计');
        continue;
      }
      if (!seenEventKeys.has(evKey)) {
        seenEventKeys.add(evKey);
        allEvents.push(ledgerEv);
        if (ledgerEv.db_file && !representedFiles.has(ledgerEv.db_file)) mergedLedgerDbs.add(ledgerEv.db_file);
      }
    }
    archivedDbCount += mergedLedgerDbs.size;

    const existingAccCache = this.cachedSummariesByAccount.get(accKey);
    if ((allEvents.length === 0 || (dbPaths.length > 0 && cachedDatabasesCount === dbPaths.length)) && failedDatabasesCount > 0 && existingAccCache?.data) {
      if (existingAccCache.data.snapshot_id && this.snapshots.has(existingAccCache.data.snapshot_id)) {
        this.snapshots.get(existingAccCache.data.snapshot_id)!.expires = Date.now() + 600000;
      }
      return {
        ...existingAccCache.data,
        failed_databases_count: failedDatabasesCount,
        has_error: true,
        hasError: true, availability: 'cached', database_diagnostics: diagnostics, last_attempt_at: Math.floor(Date.now()/1000),
      };
    }

    await this.savePersistentFileCache();
    if (this.usageLedgerDirty) {
      await this.saveUsageLedger();
    }
    const rawPricing = await this.getRawPricingTable();
    await this.loadRateLocks();
    if (this.rateLocksUnavailable && !this.pricingWarnings.some(w => w.includes('费率账本'))) this.pricingWarnings.push('历史费率账本不可读，未重新计价');
    const now = Math.floor(Date.now() / 1000);
    const pricing = this.resolvePricingTableFromRaw(rawPricing, now);
    if (this.autoRemotePricingSync) {
      void this.syncRemotePricing().catch(() => {});
    }
    const calKey = this.calendarKey();
    const aggKey = allCacheHits && failedDatabasesCount === 0
      ? `${accKey}|${calKey}|${this.lastDiscoveredDatabaseCount}|${dbPaths.map(p => { const c = this.fileCache.get(p); return c ? `${p}:${c.mtimeMs}:${c.size}:${c.walMtimeMs}:${c.walSize}:${c.hasError ? 1 : 0}` : p; }).join(';')}|arch:${archivedStampParts.join(';')}|${JSON.stringify(rawPricing)}|${this.pricingWarnings.join(',')}`
      : '';
    const cachedByAccEntry = this.cachedSummariesByAccount.get(accKey);
    if (aggKey && aggKey === this.lastAggregationKeysByAccount.get(accKey) && cachedByAccEntry?.data && this.periodKey === calKey) {
      const reused: TokenUsageSummary = {
        ...cachedByAccEntry.data,
        database_diagnostics: diagnostics,
        last_attempt_at: now,
        pricing_warnings: [...this.pricingWarnings, ...this.storageWarnings],
      };
      this.cachedSummariesByAccount.set(accKey, { data: reused, expiresAt: Date.now() + 30_000 });
      if (reused.snapshot_id && this.snapshots.has(reused.snapshot_id)) {
        this.snapshots.get(reused.snapshot_id)!.expires = Date.now() + 600000;
      }
      this.pruneSnapshots();
      return reused;
    }

    // 汇总可用的账号列表 (available_accounts)
    // 规则：首项恒为“全部账号”，后续依次排列所有真实登录/保存过的具体账号（以邮箱呈现），杜绝“个人账号”或“企业 Vertex AI”等虚构分类
    const accountMap = new Map<string, AvailableAccountUsageOption>();
    accountMap.set('all', { id: 'all', label: '全部账号', type: 'all', total_tokens: 0, request_count: 0 });

    // 1. 先用 knownAccounts 预填充真实账号（保持用户在账号面板中看到的一致顺序）
    for (const acc of this.knownAccounts) {
      const key = acc.id || acc.email;
      if (!key) continue;
      if (!accountMap.has(key)) {
        accountMap.set(key, {
          id: key,
          label: acc.email || acc.name || key,
          email: acc.email,
          name: acc.name,
          type: 'account',
          total_tokens: 0,
          request_count: 0,
        });
      }
    }

    // 2. 若当前上下文账号不在 map 中，也追加
    if (this.currentAccountContext?.id || this.currentAccountContext?.email) {
      const curId = this.currentAccountContext.id || this.currentAccountContext.email!;
      const curEmail = this.currentAccountContext.email;
      let alreadyExists = false;
      for (const [k, opt] of accountMap.entries()) {
        if (k === 'all') continue;
        if (k === curId || (curEmail && opt.email && opt.email.toLowerCase() === curEmail.toLowerCase())) {
          alreadyExists = true;
          break;
        }
      }
      if (!alreadyExists) {
        accountMap.set(curId, {
          id: curId,
          label: curEmail || curId,
          email: curEmail,
          type: 'account',
          total_tokens: 0,
          request_count: 0,
        });
      }
    }

    // 3. 单遍统计各账号与全部账号的 token / request / 未归属量与凭据键集合
    let unattributedRequests = 0;
    let unattributedTokens = 0;
    const knownReceiptKeys = new Set<string>();
    const allOpt = accountMap.get('all')!;
    for (const ev of allEvents) {
      if (ev.event_key) knownReceiptKeys.add(ev.event_key);
      if (ev.legacy_event_key) knownReceiptKeys.add(ev.legacy_event_key);
      allOpt.total_tokens = (allOpt.total_tokens ?? 0) + ev.total_tokens;
      allOpt.request_count = (allOpt.request_count ?? 0) + 1;

      if (!ev.account_id && !ev.account_email) {
        unattributedRequests++;
        unattributedTokens += ev.total_tokens;
        continue;
      }

      let targetKey: string | null = null;
      if (ev.account_id && accountMap.has(ev.account_id)) {
        targetKey = ev.account_id;
      } else if (ev.account_email) {
        for (const [k, opt] of accountMap.entries()) {
          if (k !== 'all' && opt.email && opt.email.toLowerCase() === ev.account_email.toLowerCase()) {
            targetKey = k;
            break;
          }
        }
      }

      if (!targetKey) {
        // 未在保存列表中的历史有效账号，追加在末尾
        const newKey = ev.account_id || ev.account_email!;
        const label = ev.account_email || ev.account_id!;
        accountMap.set(newKey, {
          id: newKey,
          label,
          email: ev.account_email,
          type: 'account',
          total_tokens: 0,
          request_count: 0,
        });
        targetKey = newKey;
      }

      const item = accountMap.get(targetKey)!;
      item.total_tokens = (item.total_tokens ?? 0) + ev.total_tokens;
      item.request_count = (item.request_count ?? 0) + 1;
    }

    // 账号下钻过滤
    let effectiveEvents = allEvents;
    if (accountId && accountId !== 'all') {
      const targetOpt = accountMap.get(accountId) || this.knownAccounts.find(a => a.id === accountId || (a.email && a.email.toLowerCase() === accountId.toLowerCase()));
      const targetEmail = targetOpt?.email?.toLowerCase() || (accountId.includes('@') ? accountId.toLowerCase() : null);
      effectiveEvents = allEvents.filter(ev => {
        if (ev.account_id && ev.account_id === accountId) return true;
        if (targetEmail && ev.account_email && ev.account_email.toLowerCase() === targetEmail) return true;
        return false;
      });
    }

    const summary = buildUsageSummaryReport({
      allEvents,
      effectiveEvents,
      knownReceiptKeys,
      unattributedRequests,
      unattributedTokens,
      accountMap,
      accountId,
      accKey,
      now,
      rawPricing,
      pricing,
      calKey,
      rateLocks: this.rateLocks,
      resolvePricing: (table, modelName, ts) => this.resolvePricing(table, modelName, ts),
      lockedCost: (ev, price) => this.lockedCost(ev, price),
      dbPathsCount: dbPaths.length,
      archivedDbCount,
      lastDiscoveredDatabaseCount: this.lastDiscoveredDatabaseCount,
      cachedDatabasesCount,
      liveEventsCount,
      generationsScanned,
      skippedLargeRecords,
      failedDatabasesCount,
      diagnostics,
      ledgerCorrupt: this.ledgerCorrupt,
      archivedUnavailable: this.archivedUnavailable,
      storageWarnings: this.storageWarnings,
      pricingWarnings: this.pricingWarnings,
    });


    if (this.rateLocksDirty) {
      // Commit before exposing a new summary: never report an unlocked historical amount.
      await this.saveRateLocks();
      this.rateLocksDirty = false;
    }
    this.periodKey=calKey;
    if (aggKey) {
      this.lastAggregationKeysByAccount.set(accKey, aggKey);
    }
    this.cachedSummariesByAccount.set(accKey, { data: summary, expiresAt: Date.now() + (failedDatabasesCount > 0 ? 2000 : 30000) });
    if (!this.snapshots.has(summary.snapshot_id!)) {
      this.snapshots.set(summary.snapshot_id!, { events: allEvents, prices: pricing, rawPricing, summary, expires: Date.now()+600000, pins: 0 });
    } else {
      const existing = this.snapshots.get(summary.snapshot_id!)!;
      summary.generated_at = existing.summary.generated_at;
      existing.summary = summary;
      existing.events = allEvents;
      existing.prices = pricing;
      existing.rawPricing = rawPricing;
      existing.expires = Date.now()+600000;
    }
    this.pruneSnapshots();
    return summary;
  }
}
