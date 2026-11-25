import { ALLOWED_DATA_DIRECTORY_NAMES, type DataDirectoryName } from './application-target.js';
import { lstat, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { atomicJson, atomicText } from './files.js';
import { bt, getActiveLocale } from './i18n.js';
import {
  defaultGravityBoxCacheDir,
  defaultGravityBoxStateDir,
  pathsEqual,
} from './platform/index.js';
import { calculateLockedEventUsd, createModelQueryMatcher, formatLocalDate, isUnpricedZeroSentinel, type LedgerSnapshot } from './usage-aggregate.js';
import { UsageLedger, type LedgerEvent } from './usage-ledger.js';
import {
  DEFAULT_PRICING_FEED_URLS,
  PRICING_METADATA,
  calculateEstimatedUsd,
  canonicalActivePricingKeys,
  resolveContextTierPricing,
  resolvePricingFromTable,
  type ApiPricing,
  type ApiPricingEntry,
  type ApiPricingInterval,
} from './pricing.js';
import {
  isFileCacheEntryReusable,
  ledgerEventsEqual,
  normalizeEventEnvironment,
  resolveDatabaseModelFullName,
  type AvailableAccountUsageOption,
  type AvailableEnvironmentUsageOption,
  type DailyTokenUsage,
  type EnvironmentShareBreakdown,
  type FileCacheEntry,
  type GenerationEvent,
  type HourlyTokenUsage,
  type KnownEnvironmentContext,
  type ModelTokenUsage,
  type SyncReceipt,
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
import { buildPricingWarningCodes, buildUsageSummaryReport } from './usage-report.js';

export {
  normalizeEventEnvironment,
  resolveDatabaseModelFullName,
  type AvailableAccountUsageOption,
  type AvailableEnvironmentUsageOption,
  type DailyTokenUsage,
  type EnvironmentShareBreakdown,
  type GenerationEvent,
  type HourlyTokenUsage,
  type KnownEnvironmentContext,
  type ModelTokenUsage,
  type SyncReceipt,
  type TokenUsagePeriod,
  type TokenUsageSummary,
  type TokenUsageTotals,
};

export type UsageRangeCostEvent = LedgerEvent & {
  estimated_usd: number | null;
  priced: boolean;
};

export class UsageStatsManager {
  private rateLocksPath: string;
  private rateLocks: Record<string, { usd: number; price: ApiPricing }> = Object.create(null);
  private rateLocksLoaded = false;
  private rateLocksLoading?: Promise<void>;
  private rateLocksDirty = false;
  private rateLocksUnavailable = false;
  private rateLocksFileFatal = false;
  private priceRefMap = new Map<string, ApiPricing>();
  private geminiDir: string;
  private dataDirectoryNames: readonly DataDirectoryName[];
  private pricingCachePath: string;
  public lastDiscoveredDatabaseCount = 0;
  private inFlight?: Promise<TokenUsageSummary>;
  private inFlightForced = false;
  private inFlightAccountKey = 'all';
  private inFlightEnvironmentKey = 'all';
  private pendingForced?: Promise<TokenUsageSummary>;
  private pricingMutation?: Promise<unknown>;
  private pricingRevalueApplying?: Promise<void>;
  private ledgerSaveQueue: Promise<unknown> = Promise.resolve();
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
  private persistSaveChain: Promise<void> = Promise.resolve();
  private observationsPath: string;
  private observationsLoaded = false;
  private observationTimeline: Array<{ at: number; id?: string; email?: string; account_type: 'consumer' | 'enterprise_vertex' | 'unknown' }> = [];
  private ledger: UsageLedger;
  private usageLedgerLoaded = false;
  private usageLedgerLoading?: Promise<void>;
  private usageLedgerDirty = false;
  private usageLedgerEvents = new Map<string, LedgerEvent>();
  private legacyKeyIndex = new Map<string, Set<string>>();
  private pendingLedgerEvents = new Map<string, LedgerEvent>();
  private pendingForkedClonePurges = new Map<string, Set<number>>();
  private largeLedger = false;
  private largeLedgerBaselinePresent = false;
  private ledgerUnavailable = false;
  private ledgerCorrupt = false;
  private archivedUnavailable = false;
  private storageWarnings = new Set<string>();
  private cachedSummariesByAccount = new Map<string, { data: TokenUsageSummary; expiresAt: number }>();
  private lastAggregationKeysByAccount = new Map<string, string>();
  private lastLargeLedgerScanAtMs = 0;
  private lastLargeLedgerScanMeta: {
    dbPathsCount: number;
    archivedDbCount: number;
    generationsScanned: number;
    skippedLargeRecords: number;
    failedDatabasesCount: number;
    diagnostics: NonNullable<TokenUsageSummary['database_diagnostics']>;
    liveFiles: string[];
    lastDiscoveredDatabaseCount: number;
  } | null = null;
  private knownAccounts: Array<{ id: string; email: string; name?: string | null }> = [];
  private remoteSyncRevision = 0;
  private onlineRemoteEnvironments: KnownEnvironmentContext[] = [];
  private onlineRemoteEnvSig = '[]';
  private syncReceiptsCache?: Record<string, SyncReceipt>;
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
  private pricingSyncInFlight?: Promise<{ synced: boolean; unchanged?: boolean; error?: string; count?: number; sourceUrl?: string; version?: string; updatedAt?: string; healedCount?: number }>;
  private lastSyncError: string | null = null;
  private lastSyncedSourceUrl = '';
  private lastSyncedVersion = '';
  private lastSyncedUpdatedAt = '';
  private lastSyncedEtag = '';
  private lastSyncedSha256 = '';
  private pricingRevisionSeq = 0;
  private unchangedHealChecked = false;
  private onPricingUpdatedHook?: (info: { version?: string; healedCount?: number }) => void;
  private activeOfficialModels: string[] | null = null;
  private activeUnpricedOfficialModels: string[] | null = null;

  constructor(options?: { geminiDir?: string; stateDir?: string; remotePricingUrl?: string; fallbackPricingUrls?: string[]; dataDirectoryName?: DataDirectoryName }) {
    const defaultGeminiDir = join(homedir(), '.gemini');
    const defaultStateDir = defaultGravityBoxStateDir();
    this.geminiDir = options?.geminiDir ?? defaultGeminiDir;
    if (options?.dataDirectoryName && !ALLOWED_DATA_DIRECTORY_NAMES.includes(options.dataDirectoryName)) throw new Error(bt('usage.err.official_only'));
    this.dataDirectoryNames = options?.dataDirectoryName ? [options.dataDirectoryName] : ALLOWED_DATA_DIRECTORY_NAMES;
    const stateDir = options?.stateDir ?? (options?.geminiDir && !pathsEqual(options.geminiDir, defaultGeminiDir) ? join(options.geminiDir, '.gravitybox_state') : defaultStateDir);
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
    if (pathsEqual(this.geminiDir, defaultGeminiDir) && pathsEqual(stateDir, defaultStateDir)) {
      const cacheTag = options?.dataDirectoryName ?? 'antigravity';
      this.persistCachePath = join(defaultGravityBoxCacheDir(), `usage-db-cache-${cacheTag}-v3.json`);
    }
  }

  async ledgerReview(): Promise<Record<string, unknown>> {
    try { return await this.ledger.review(); }
    catch { return { readOnly: true, unavailable: true, message: bt('usage.review.unavailable') }; }
  }

  setAutoRemotePricingSync(enabled: boolean) { this.autoRemotePricingSync = enabled; }
  isAutoRemotePricingSyncEnabled(): boolean { return this.autoRemotePricingSync; }
  async isAutoPricingSyncDue(now = Date.now()): Promise<boolean> {
    await this.ensureSyncStateLoaded();
    return now >= this.nextAutoSyncAt;
  }
  getLastPricingCheckAt(): number { return Math.max(this.lastCheckAt, this.lastRemoteSyncAt); }
  setOnPricingUpdated(hook: ((info: { version?: string; healedCount?: number }) => void) | undefined) {
    this.onPricingUpdatedHook = hook;
  }
  getPricingRevision(): string {
    return `${this.lastSyncedVersion || PRICING_METADATA.version}|${this.lastSyncedUpdatedAt || PRICING_METADATA.updatedAt}|${this.lastSyncedSha256}|${this.pricingRevisionSeq}`;
  }
  async hydratePricingCatalog(): Promise<void> {
    await this.ensureSyncStateLoaded();
    await this.getRawPricingCatalog();
  }

  /** 动态更新当前官方 Antigravity 包含模型列表（含可选未计价实时模型列表），用于价格基准展示过滤与状态计数。 */
  setActiveOfficialModels(
    modelIds: Iterable<string> | null,
    unpricedModelIds?: Iterable<string> | null
  ): void {
    if (!modelIds) {
      this.activeOfficialModels = null;
      this.activeUnpricedOfficialModels = unpricedModelIds
        ? Array.from(new Set(Array.from(unpricedModelIds).map(id => String(id).trim()).filter(Boolean)))
        : null;
      return;
    }
    const list = Array.from(modelIds).map(id => String(id).trim()).filter(Boolean);
    const unpricedList = unpricedModelIds
      ? Array.from(new Set(Array.from(unpricedModelIds).map(id => String(id).trim()).filter(Boolean)))
      : null;
    if (list.length === 0 && (!unpricedList || unpricedList.length === 0)) {
      this.activeOfficialModels = null;
      this.activeUnpricedOfficialModels = null;
      return;
    }
    this.activeOfficialModels = list;
    this.activeUnpricedOfficialModels = unpricedList;
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
    return value.usd === 0 && isUnpricedZeroSentinel(value.price);
  }

  async previewRevalueHistory(mode: 'force_all' | 'unpriced_only' = 'force_all') {
    await this.getUsageSummary(true);
    const liveFiles = (await this.discoverDatabaseFiles()).map(path => basename(path));
    return this.ledger.revalue({ action: 'preview', mode, prices: await this.getBillingPricingTable(), accounts: [], liveFiles, now: Math.floor(Date.now() / 1000) });
  }

  private getSummaryCacheKey(accountId?: string, environmentId?: string): string {
    return `${accountId || 'all'}|env:${environmentId || 'all'}`;
  }

  private runSerializedLedgerSave<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.ledgerSaveQueue.catch(() => {}).then(async () => {
      while (this.pricingRevalueApplying) {
        await this.pricingRevalueApplying.catch(() => {});
      }
      return fn();
    });
    this.ledgerSaveQueue = run;
    return run;
  }

  private async mutateHistoricalPricing<T>(operation: () => Promise<T>): Promise<T> {
    while (this.pricingMutation) await this.pricingMutation.catch(() => {});
    const pendingRead = this.inFlight;
    const pendingLocks = this.rateLocksLoading;
    const work = (async () => {
      if (pendingRead) await pendingRead.catch(() => {});
      if (pendingLocks) await pendingLocks.catch(() => {});
      const prevSave = this.ledgerSaveQueue;
      let releaseApply!: () => void;
      const applyGate = new Promise<void>(resolve => { releaseApply = resolve; });
      this.ledgerSaveQueue = prevSave.catch(() => {}).then(() => applyGate);
      await prevSave.catch(() => {});
      try {
        this.pricingRevalueApplying = applyGate;
        return await operation();
      } finally {
        this.pricingRevalueApplying = undefined;
        releaseApply();
      }
    })();
    this.pricingMutation = work;
    try { return await work; }
    finally { if (this.pricingMutation === work) this.pricingMutation = undefined; }
  }

  async revalueHistory(confirmed = false, options?: { mode?: 'force_all' | 'unpriced_only'; previewId?: string }): Promise<{ before: number; after: number; message: string }> {
    if (!confirmed) throw Error(bt('usage.err.revalue_confirm'));
    if (!options?.previewId) throw Error(bt('usage.err.revalue_preview_required'));
    return this.mutateHistoricalPricing(async () => {
      const result = await this.ledger.revalue({ action: 'apply', confirmed, previewId: options.previewId,
        prices: await this.getBillingPricingTable(), accounts: [], now: Math.floor(Date.now() / 1000) });
      this.rateLocksLoaded = false;
      this.rateLocksFileFatal = false;
      this.rateLocks = Object.create(null);
      this.cachedSummariesByAccount.clear(); this.lastAggregationKeysByAccount.clear(); this.snapshots.clear();
      return result;
    });
  }

  async restoreRevalueHistory(previewId: string, confirmed = false) {
    return this.mutateHistoricalPricing(async () => {
      const result = await this.ledger.revalue({ action: 'restore', previewId, confirmed, prices: await this.getBillingPricingTable(), accounts: [], now: Math.floor(Date.now() / 1000) });
      this.rateLocksLoaded = false; this.rateLocksFileFatal = false; this.rateLocks = Object.create(null);
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
    if (this.largeLedger || this.ledgerUnavailable || this.archivedUnavailable) {
      this.rateLocksLoaded = true;
      if (this.ledgerUnavailable || this.archivedUnavailable) this.rateLocksUnavailable = true;
      return;
    }
    let localFileFatal = false;
    try {
      const data = JSON.parse(await readFile(this.rateLocksPath, 'utf8'));
      if (data.version !== 1 || !data.entries || typeof data.entries !== 'object') throw Error(bt('usage.err.rate_ledger_invalid_format'));
      const profiles: ApiPricing[] = Array.isArray(data.profiles) ? data.profiles : [];
      const cachedProfiles = profiles.map(p => (p ? this.cachedPriceRef(p) : undefined));
      let hasLegacyInlinePrice = false;
      for (const [key, value] of Object.entries<any>(data.entries)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !Number.isFinite(value?.usd) || value.usd < 0) throw Error(bt('usage.err.rate_ledger_invalid_entry'));
        let price: ApiPricing | undefined = value.price ? this.cachedPriceRef(value.price) : undefined;
        if (!price && typeof value.p === 'number') {
          price = cachedProfiles[value.p];
        }
        if (!price) throw Error(bt('usage.err.rate_ledger_invalid_entry'));
        if (value.price) hasLegacyInlinePrice = true;
        this.rateLocks[key] = { usd: value.usd, price };
      }
      if (hasLegacyInlinePrice || !data.profiles) {
        this.rateLocksDirty = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        localFileFatal = true;
        this.rateLocksLoaded = true;
        this.rateLocksUnavailable = true;
        this.rateLocksFileFatal = true;
        this.pricingWarnings.push(bt('usage.warn.rate_ledger_unreadable_stop'));
      }
    }

    if (!localFileFatal) {
      try {
        const indexed = await this.ledger.locks();
        for (const [key, value] of Object.entries(indexed)) this.rateLocks[key] = { usd: value.usd, price: this.cachedPriceRef(value.price) };
        this.rateLocksUnavailable = false;
        this.rateLocksLoaded = true;
      } catch {
        // 瞬时超时/工作线程退避失败：保持 rateLocksLoaded = false 允许下轮重试，并暂禁覆盖写盘防止删空历史锁
        this.rateLocksUnavailable = true;
      }
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
    const cw = event.cache_write_tokens ?? 0;
    const existing = event.event_key ? this.rateLocks[event.event_key] ?? (event.legacy_event_key && this.usageLedgerEvents.get(event.legacy_event_key)?.timestamp_seconds === event.timestamp_seconds ? this.rateLocks[event.legacy_event_key] : undefined) : undefined;
    if (existing && !this.isUnpricedRateLock(existing)) {
      const effectiveExisting = resolveContextTierPricing(existing.price, event.input_tokens + event.cached_tokens + cw);
      const lockedMissingCw = cw > 0 && (!Number.isFinite(effectiveExisting.cacheWrite) || effectiveExisting.cacheWrite! < 0);
      if (!lockedMissingCw) {
        if (!event.source_id) return existing.usd;
        const usd = calculateEstimatedUsd(event.input_tokens, event.output_tokens, event.cached_tokens, existing.price, cw);
        if (!this.rateLocks[event.event_key!] || this.rateLocks[event.event_key!]!.usd !== usd) {
          this.rateLocks[event.event_key!] = { usd, price: existing.price }; this.rateLocksDirty = true;
        }
        return usd;
      }
    }
    const effectivePrice = price ? resolveContextTierPricing(price, event.input_tokens + event.cached_tokens + cw) : null;
    if (!price || !effectivePrice || (cw > 0 && (!Number.isFinite(effectivePrice.cacheWrite) || effectivePrice.cacheWrite! < 0))) return null;
    const usd = calculateEstimatedUsd(event.input_tokens, event.output_tokens, event.cached_tokens, price, cw);
    if (event.event_key) {
      this.rateLocks[event.event_key] = { usd, price: this.cachedPriceRef(price) };
      this.rateLocksDirty = true;
    }
    return usd;
  }

  setDataDirectoryName(name?: DataDirectoryName): void {
    if (name && !ALLOWED_DATA_DIRECTORY_NAMES.includes(name)) throw new Error(bt('usage.err.official_only'));
    const nextNames = name ? [name] : ALLOWED_DATA_DIRECTORY_NAMES;
    if (this.dataDirectoryNames.join(',') === nextNames.join(',')) return;
    this.cancelRead();
    this.dataDirectoryNames = nextNames;
    this.cachedSummariesByAccount.clear();
    this.lastAggregationKeysByAccount.clear();
    this.discoveredStats.clear();
    const defaultGeminiDir = join(homedir(), '.gemini');
    const defaultStateDir = defaultGravityBoxStateDir();
    if (pathsEqual(this.geminiDir, defaultGeminiDir) && pathsEqual(this.pricingCachePath, join(defaultStateDir, 'api_pricing.json'))) {
      const cacheTag = name ?? 'antigravity';
      this.persistCachePath = join(defaultGravityBoxCacheDir(), `usage-db-cache-${cacheTag}-v3.json`);
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
          if (v && typeof v.mtimeMs === 'number' && typeof v.size === 'number' && Array.isArray(v.events) && v.events.every((e: GenerationEvent) => typeof e.event_key === 'string' && !/\borchestrator\b|^gemini-flash-worker|^MODEL_PLACEHOLDER_M\d+$|^Gemini\s+Flash$/i.test(e.model)) && isFileCacheEntryReusable(v) && !this.fileCache.has(k)) {
            this.setFileCacheEntry(k, {
              ...v,
              skippedLargeRecords: Number.isFinite(v.skippedLargeRecords) ? Number(v.skippedLargeRecords) : 0,
            });
          }
        }
      }
    } catch {}
  }

  private savePersistentFileCache(): Promise<void> {
    if (!this.persistCachePath || !this.fileCacheDirty) return this.persistSaveChain;
    this.fileCacheDirty = false;
    const entries: Record<string, any> = {};
    for (const [k, v] of this.fileCache.entries()) {
      if (isFileCacheEntryReusable(v)) entries[k] = v;
    }
    const targetPath = this.persistCachePath;
    this.persistSaveChain = this.persistSaveChain
      .catch(() => {})
      .then(() => atomicJson(targetPath, { version: 3, entries }, undefined, { durability: 'relaxed' }))
      .catch(() => {
        this.fileCacheDirty = true;
      });
    return this.persistSaveChain;
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
      if (!raw || raw.version !== 1 || typeof raw.databases !== 'object' || raw.databases === null) throw Error(bt('usage.err.archive_invalid_format'));
      for (const [key, entry] of Object.entries<any>(raw.databases)) {
        if (!entry || !Array.isArray(entry.events)) throw Error(bt('usage.err.archive_invalid_events'));
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
        if (validEvents.length !== entry.events.length) throw Error(bt('usage.err.archive_corrupt_event'));
        for (const e of validEvents) {
          e.model = resolveDatabaseModelFullName(e.model, null);
        }
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
        this.storageWarnings.add(bt('usage.warn.archive_unreadable'));
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
    if (!this.ledgerCorrupt) this.ledgerUnavailable = false;
    await this.loadObservationTimeline();
    try {
      const totalCount = await this.ledger.count();
      this.largeLedger = totalCount > 50_000;
      this.largeLedgerBaselinePresent = totalCount > 0;
      for (const event of this.largeLedger ? [] : await this.ledger.load()) {
        if (event.db_file === 'recovered_session.db' || event.db_file === 'recovered_enterprise_session.db') {
          this.storageWarnings.add(bt('usage.warn.legacy_synthetic'));
          continue;
        }
        if (event.account_confidence === 'legacy') this.storageWarnings.add(bt('usage.warn.legacy_account_confidence'));
        event.model = resolveDatabaseModelFullName(event.model, null);
        this.setLedgerEventInMap(event.event_key!, event);
      }
      this.usageLedgerLoaded = true;
    } catch (error) {
      const msg = (error as Error)?.message ?? String(error);
      const isTransient = /SQLITE_BUSY|timeout|timed out|超时|exited|退出/i.test(msg);
      this.ledgerUnavailable = true;
      if (isTransient) {
        // 瞬时超时/退出不标记永久损坏，允许下轮自动自愈重试
        this.usageLedgerLoaded = false;
      } else {
        this.usageLedgerLoaded = true;
        this.ledgerCorrupt = true;
        this.storageWarnings.add(bt('usage.warn.ledger_unreadable'));
      }
    }
    await this.loadArchivedEvents();
    for (const [key, archive] of this.archivedByDb) {
      for (const event of archive.events) this.upsertLedger({ ...event, db_file: basename(key) });
    }
  }

  private setLedgerEventInMap(key: string, event: LedgerEvent): void {
    const prev = this.usageLedgerEvents.get(key);
    if (prev?.legacy_event_key && prev.legacy_event_key !== event.legacy_event_key) {
      const oldSet = this.legacyKeyIndex.get(prev.legacy_event_key);
      if (oldSet) {
        oldSet.delete(key);
        if (oldSet.size === 0) this.legacyKeyIndex.delete(prev.legacy_event_key);
      }
    }
    this.usageLedgerEvents.set(key, event);
    if (event.legacy_event_key) {
      let nextSet = this.legacyKeyIndex.get(event.legacy_event_key);
      if (!nextSet) {
        nextSet = new Set<string>();
        this.legacyKeyIndex.set(event.legacy_event_key, nextSet);
      }
      nextSet.add(key);
    }
  }

  private deleteLedgerEventFromMap(key: string): void {
    const prev = this.usageLedgerEvents.get(key);
    if (prev?.legacy_event_key) {
      const oldSet = this.legacyKeyIndex.get(prev.legacy_event_key);
      if (oldSet) {
        oldSet.delete(key);
        if (oldSet.size === 0) this.legacyKeyIndex.delete(prev.legacy_event_key);
      }
    }
    this.usageLedgerEvents.delete(key);
  }

  private clearLedgerEventsMap(): void {
    this.usageLedgerEvents.clear();
    this.legacyKeyIndex.clear();
  }

  private confidenceRank(confidence?: GenerationEvent['account_confidence']): number {
    switch (confidence) {
      case 'observed':
        return 3;
      case 'inferred':
        return 2;
      case 'unknown':
        return 1;
      case 'legacy':
        return 0;
      default:
        return -1;
    }
  }

  private mergeLedgerEventRecord(previous: LedgerEvent | undefined, incoming: LedgerEvent): LedgerEvent {
    const next: LedgerEvent = {
      ...previous,
      ...incoming,
      source_observed_at: Math.max(incoming.source_observed_at ?? 0, previous?.source_observed_at ?? 0) || incoming.source_observed_at,
      timestamp_seconds: incoming.timestamp_seconds || previous?.timestamp_seconds || 0,
      ingested_at: previous?.ingested_at ?? incoming.ingested_at ?? new Date().toISOString(),
    };
    if (previous) {
      const prevRank = this.confidenceRank(previous.account_confidence);
      const nextRank = this.confidenceRank(incoming.account_confidence);
      const prevHasIdentity = Boolean(previous.account_id || previous.account_email || previous.account_confidence);
      const nextHasIdentity = Boolean(incoming.account_id || incoming.account_email);
      if (
        (prevRank > nextRank && prevHasIdentity) ||
        (prevRank === nextRank && !nextHasIdentity && prevHasIdentity)
      ) {
        next.account_id = previous.account_id;
        next.account_email = previous.account_email;
        next.account_confidence = previous.account_confidence;
      }
      if (previous.account_type && previous.account_type !== 'unknown' && (!incoming.account_type || incoming.account_type === 'unknown')) {
        next.account_type = previous.account_type;
      }
      if (previous.environment_kind) {
        next.environment_kind = previous.environment_kind;
        if (previous.environment_id !== undefined) next.environment_id = previous.environment_id;
        if (previous.environment_label !== undefined) next.environment_label = previous.environment_label;
      }
      if (previous.trajectory_id) {
        next.trajectory_id = previous.trajectory_id;
      }
    }
    return next;
  }

  private async syncInMemoryRateLocks(): Promise<void> {
    if (!this.rateLocksLoaded || this.rateLocksUnavailable || this.largeLedger) return;
    try {
      const indexed = await this.ledger.locks();
      for (const [key, value] of Object.entries(indexed)) {
        if (!this.rateLocksDirty || !this.rateLocks[key]) {
          this.rateLocks[key] = { usd: value.usd, price: this.cachedPriceRef(value.price) };
        }
      }
    } catch {
      // ignore transient sync error; next load will refresh
    }
  }

  getRemoteSyncRevision(): number {
    return this.remoteSyncRevision;
  }

  setOnlineRemoteEnvironments(
    envs: ReadonlyArray<
      KnownEnvironmentContext | {
        environmentId?: string;
        id?: string;
        hostLabel?: string;
        host_label?: string;
        label?: string;
        kind?: 'local' | 'ssh';
        online?: boolean;
        lastSyncedAt?: number;
        last_synced_at?: number;
      }
    >
  ): void {
    const dedup = new Map<string, KnownEnvironmentContext>();
    if (Array.isArray(envs)) {
      for (const item of envs) {
        if (!item) continue;
        const id = String((item as KnownEnvironmentContext).id ?? (item as { environmentId?: string }).environmentId ?? '').trim();
        if (!id) continue;
        const kind: 'local' | 'ssh' = item.kind === 'local' || id === 'local' ? 'local' : 'ssh';
        const hostLabel = String(
          item.host_label ?? (item as { hostLabel?: string }).hostLabel ?? item.label ?? id
        ).trim();
        const label = String(item.label ?? hostLabel ?? id).trim();
        const rawSynced = item.last_synced_at ?? (item as { lastSyncedAt?: number }).lastSyncedAt;
        const lastSyncedAt = typeof rawSynced === 'number' && Number.isFinite(rawSynced) && rawSynced > 0
          ? rawSynced
          : undefined;
        dedup.set(id, {
          id,
          kind,
          ...(hostLabel ? { host_label: hostLabel } : {}),
          ...(label ? { label } : {}),
          online: item.online !== false,
          ...(lastSyncedAt !== undefined ? { last_synced_at: lastSyncedAt } : {}),
        });
      }
    }
    const nextList = [...dedup.values()].sort((a, b) => a.id.localeCompare(b.id));
    const nextSig = JSON.stringify(nextList);
    this.onlineRemoteEnvironments = nextList;
    if (nextSig !== this.onlineRemoteEnvSig) {
      this.onlineRemoteEnvSig = nextSig;
      this.cachedSummariesByAccount.clear();
      this.lastAggregationKeysByAccount.clear();
    }
  }

  async getSyncReceipts(): Promise<Record<string, SyncReceipt>> {
    try {
      const receipts = await this.ledger.receipts();
      this.syncReceiptsCache = receipts;
      return receipts;
    } catch {
      return this.syncReceiptsCache ? { ...this.syncReceiptsCache } : {};
    }
  }

  async ingestRemoteUsageBatch(
    events: LedgerEvent[],
    receipts: SyncReceipt[] = [],
    options?: { billingPrices?: Record<string, ApiPricingEntry> }
  ): Promise<{ saved: number; locksWritten?: number; receiptsWritten?: number; revision: number }> {
    const incomingEvents = Array.isArray(events) ? events : [];
    const incomingReceipts = Array.isArray(receipts) ? receipts : [];
    if (incomingEvents.length === 0 && incomingReceipts.length === 0) {
      return { saved: 0, locksWritten: 0, receiptsWritten: 0, revision: this.remoteSyncRevision };
    }
    return this.runSerializedLedgerSave(async () => {
      await this.loadUsageLedger();
      if (this.ledgerCorrupt) {
        throw new Error(bt('usage.warn.ledger_unreadable'));
      }
      await this.loadRateLocks();
      const billingPrices = options?.billingPrices
        ?? (!this.rateLocksUnavailable ? await this.getBillingPricingTable() : undefined);

      const normalizedEvents: LedgerEvent[] = incomingEvents.map(raw => {
        const env = normalizeEventEnvironment({
          environment_kind: raw.environment_kind ?? 'ssh',
          environment_id: raw.environment_id,
          environment_label: raw.environment_label,
        });
        return {
          ...raw,
          model: resolveDatabaseModelFullName(raw.model, null, undefined, { canonicalUnknown: true }),
          environment_kind: raw.environment_kind ?? env.kind,
          environment_id: raw.environment_id ?? env.id,
          environment_label: raw.environment_label ?? env.label,
        };
      });

      const res = await this.ledger.save(normalizedEvents, {
        ...(billingPrices ? { billingPrices } : {}),
        ...(incomingReceipts.length > 0 ? { receipts: incomingReceipts } : {}),
      });
      if (!this.ledgerCorrupt) {
        this.ledgerUnavailable = false;
      }

      if (!this.largeLedger) {
        for (const ev of normalizedEvents) {
          const key = ev.event_key;
          if (!key) continue;
          const prev = this.usageLedgerEvents.get(key);
          if (prev && (prev.source_observed_at ?? 0) > (ev.source_observed_at ?? 0)) {
            continue;
          }
          const merged = this.mergeLedgerEventRecord(prev, ev);
          this.setLedgerEventInMap(key, merged);
          this.pendingLedgerEvents.delete(key);
        }
        this.usageLedgerDirty = this.pendingLedgerEvents.size > 0;
        if (this.usageLedgerEvents.size > 50_000) {
          this.largeLedger = true;
          this.largeLedgerBaselinePresent = true;
          this.clearLedgerEventsMap();
        }
      }

      if (incomingReceipts.length > 0 && this.syncReceiptsCache) {
        const nextReceipts = { ...this.syncReceiptsCache };
        for (const rec of incomingReceipts) {
          if (rec?.source_id) {
            nextReceipts[rec.source_id] = rec;
          }
        }
        this.syncReceiptsCache = nextReceipts;
      }

      if ((res.locksWritten ?? 0) > 0 && this.rateLocksLoaded && !this.rateLocksUnavailable && !this.largeLedger) {
        await this.syncInMemoryRateLocks();
      }

      if ((res.saved ?? 0) > 0 || incomingEvents.length > 0) {
        this.remoteSyncRevision++;
        this.cachedSummariesByAccount.clear();
        this.lastAggregationKeysByAccount.clear();
      }
      return { ...res, revision: this.remoteSyncRevision };
    });
  }

  private upsertLedger(event: LedgerEvent): void {
    const key = event.event_key;
    if (!key || event.db_file === 'recovered_session.db' || event.db_file === 'recovered_enterprise_session.db') return;
    const sameKeyPrev = this.usageLedgerEvents.get(key);
    let previous = sameKeyPrev;
    const migratedFromKeys: string[] = [];
    if (event.legacy_event_key) {
      const indexedKeys = this.legacyKeyIndex.get(event.legacy_event_key);
      const legacyCandidates: Array<[string, LedgerEvent]> = [];
      if (indexedKeys) {
        for (const oldKey of indexedKeys) {
          if (oldKey === key) continue;
          const candidate = this.usageLedgerEvents.get(oldKey);
          if (
            candidate &&
            candidate.legacy_event_key === event.legacy_event_key &&
            (!event.db_file || !candidate.db_file || candidate.db_file === event.db_file)
          ) {
            legacyCandidates.push([oldKey, candidate]);
          }
        }
      }
      legacyCandidates.sort((a, b) => (a[1].source_observed_at ?? 0) - (b[1].source_observed_at ?? 0));
      for (const [oldKey, candidate] of legacyCandidates) {
        migratedFromKeys.push(oldKey);
        this.deleteLedgerEventFromMap(oldKey);
        this.pendingLedgerEvents.delete(oldKey);
        if (this.rateLocks[oldKey] && !this.rateLocks[key]) {
          this.rateLocks[key] = this.rateLocks[oldKey]!;
          this.rateLocksDirty = true;
        }
        if (!previous) {
          previous = candidate;
        } else {
          if (this.confidenceRank(candidate.account_confidence) > this.confidenceRank(previous.account_confidence)) {
            previous = {
              ...previous,
              account_id: candidate.account_id,
              account_email: candidate.account_email,
              account_confidence: candidate.account_confidence,
              account_type: candidate.account_type ?? previous.account_type,
            };
          }
          if (!previous.timestamp_seconds && candidate.timestamp_seconds) {
            previous = { ...previous, timestamp_seconds: candidate.timestamp_seconds };
          }
          if (candidate.ingested_at && (!previous.ingested_at || candidate.ingested_at < previous.ingested_at)) {
            previous = { ...previous, ingested_at: candidate.ingested_at };
          }
          if ((candidate.source_observed_at ?? 0) > (previous.source_observed_at ?? 0)) {
            previous = { ...previous, source_observed_at: candidate.source_observed_at };
          }
        }
      }
    }
    if (sameKeyPrev && (sameKeyPrev.source_observed_at ?? 0) > (event.source_observed_at ?? 0) && migratedFromKeys.length === 0) return;
    const next = this.mergeLedgerEventRecord(previous, event);
    if (sameKeyPrev && migratedFromKeys.length === 0 && ledgerEventsEqual(sameKeyPrev, next)) return;
    this.setLedgerEventInMap(key, next);
    if (this.usageLedgerEvents.size > 50_000) this.largeLedger = true;
    this.pendingLedgerEvents.set(key, next);
    this.usageLedgerDirty = true;
  }

  private recordExcludedForkedClones(dbPath: string, excludedGenIndices?: number[]): void {
    if (!Array.isArray(excludedGenIndices) || excludedGenIndices.length === 0) return;
    const dbFile = basename(dbPath).trim();
    if (!dbFile) return;
    let set = this.pendingForkedClonePurges.get(dbFile);
    if (!set) {
      set = new Set<number>();
      this.pendingForkedClonePurges.set(dbFile, set);
    }
    for (const idx of excludedGenIndices) {
      if (typeof idx === 'number' && Number.isSafeInteger(idx) && idx >= 0) {
        set.add(idx);
      }
    }
    if (set.size === 0) {
      this.pendingForkedClonePurges.delete(dbFile);
    }
  }

  private removeForkedClonesFromMemory(targets: ReadonlyArray<{ dbFile: string; excludedGenIndices: number[] }>): boolean {
    if (targets.length === 0) return false;
    const byDb = new Map<string, Set<number>>();
    for (const t of targets) {
      if (!t.dbFile || t.excludedGenIndices.length === 0) continue;
      let set = byDb.get(t.dbFile);
      if (!set) {
        set = new Set<number>();
        byDb.set(t.dbFile, set);
      }
      for (const idx of t.excludedGenIndices) {
        set.add(idx);
      }
    }
    if (byDb.size === 0) return false;

    let removedAny = false;
    const matchesTarget = (ev: LedgerEvent): boolean => {
      if (!ev.db_file || typeof ev.generation_index !== 'number' || !Number.isSafeInteger(ev.generation_index)) {
        return false;
      }
      const set = byDb.get(ev.db_file);
      return Boolean(set && set.has(ev.generation_index));
    };

    const keysToRemove: Array<{ key: string; legacyKey?: string }> = [];
    for (const [key, ev] of this.usageLedgerEvents.entries()) {
      if (matchesTarget(ev)) {
        keysToRemove.push({ key, legacyKey: ev.legacy_event_key });
      }
    }
    for (const [key, ev] of this.pendingLedgerEvents.entries()) {
      if (matchesTarget(ev)) {
        this.pendingLedgerEvents.delete(key);
        removedAny = true;
        if (ev.legacy_event_key) {
          const oldSet = this.legacyKeyIndex.get(ev.legacy_event_key);
          if (oldSet) {
            oldSet.delete(key);
            if (oldSet.size === 0) this.legacyKeyIndex.delete(ev.legacy_event_key);
          }
          delete this.rateLocks[ev.legacy_event_key];
        }
        delete this.rateLocks[key];
      }
    }
    for (const { key, legacyKey } of keysToRemove) {
      this.deleteLedgerEventFromMap(key);
      this.pendingLedgerEvents.delete(key);
      delete this.rateLocks[key];
      if (legacyKey) delete this.rateLocks[legacyKey];
      removedAny = true;
    }
    if (removedAny) {
      this.usageLedgerDirty = this.pendingLedgerEvents.size > 0;
    }
    return removedAny;
  }

  private async purgePendingForkedClones(): Promise<void> {
    if (this.pendingForkedClonePurges.size === 0) return;
    if (this.ledgerUnavailable || this.archivedUnavailable || this.ledgerCorrupt) return;
    await this.runSerializedLedgerSave(async () => {
      if (this.pendingForkedClonePurges.size === 0) return;
      if (this.ledgerUnavailable || this.archivedUnavailable || this.ledgerCorrupt) return;
      const targets: Array<{ dbFile: string; excludedGenIndices: number[] }> = [];
      for (const [dbFile, indices] of this.pendingForkedClonePurges.entries()) {
        if (indices.size > 0) {
          targets.push({ dbFile, excludedGenIndices: [...indices] });
        }
      }
      if (targets.length === 0) {
        this.pendingForkedClonePurges.clear();
        return;
      }
      try {
        const removedFromMemory = this.removeForkedClonesFromMemory(targets);
        const res = await this.ledger.purgeForkedClones(targets);
        for (const target of targets) {
          const set = this.pendingForkedClonePurges.get(target.dbFile);
          if (!set) continue;
          for (const idx of target.excludedGenIndices) {
            set.delete(idx);
          }
          if (set.size === 0) {
            this.pendingForkedClonePurges.delete(target.dbFile);
          }
        }
        if (removedFromMemory || res.deleted > 0) {
          this.cachedSummariesByAccount.clear();
          this.lastAggregationKeysByAccount.clear();
          this.snapshots.clear();
        }
      } catch {
        this.storageWarnings.add(bt('usage.warn.ledger_save_failed'));
        this.ledgerUnavailable = true;
      }
    });
  }

  private async saveUsageLedger(billingPricesOverride?: Record<string, ApiPricingEntry>): Promise<void> {
    if (!this.usageLedgerDirty) return;
    if (this.ledgerUnavailable || this.archivedUnavailable) return;
    await this.runSerializedLedgerSave(async () => {
      if (!this.usageLedgerDirty) return;
      if (this.ledgerUnavailable || this.archivedUnavailable) return;
      const pending = [...this.pendingLedgerEvents.values()];
      if (pending.length === 0) {
        this.usageLedgerDirty = false;
        return;
      }
      try {
        await this.loadRateLocks();
        const billingPrices = billingPricesOverride
          ?? (!this.rateLocksUnavailable ? await this.getBillingPricingTable() : undefined);
        const res = await this.ledger.save(
          pending,
          billingPrices ? { billingPrices } : undefined
        );
        for (const event of pending) {
          if (this.pendingLedgerEvents.get(event.event_key!) === event) this.pendingLedgerEvents.delete(event.event_key!);
        }
        this.usageLedgerDirty = this.pendingLedgerEvents.size > 0;
        if ((res.locksWritten ?? 0) > 0 && this.rateLocksLoaded && !this.rateLocksUnavailable && !this.largeLedger) {
          await this.syncInMemoryRateLocks();
        }
      } catch {
        this.storageWarnings.add(bt('usage.warn.ledger_save_failed'));
        this.ledgerUnavailable = true;
      }
    });
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
        if (res) {
          this.recordExcludedForkedClones(p, res.excludedForkedGenIndices);
          if (res.events.length > 0) {
            captured += res.events.length;
          }
        }
      }
    }));
    await this.purgePendingForkedClones();
    if (this.usageLedgerDirty) {
      await this.saveUsageLedger();
    }
    if (this.largeLedger) {
      this.clearLedgerEventsMap();
    }
    this.invalidateCache();
    return { captured };
  }

  public invalidateCache(): void {
    this.cachedSummariesByAccount.clear();
    this.lastAggregationKeysByAccount.clear();
    this.lastLargeLedgerScanAtMs = 0;
    this.lastLargeLedgerScanMeta = null;
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
    if (this.archivedUnavailable || this.ledgerUnavailable || this.rateLocksUnavailable) throw Error(bt('usage.err.clear_aborted_ledger_unreadable'));
    const rawPricing = await this.getBillingPricingTable();

    let archivedCount = 0;
    let eventCount = 0;
    for (const dbPath of dbPaths) {
      if (typeof dbPath !== 'string' || !dbPath.endsWith('.db')) continue;
      const st = await lstat(dbPath).catch(() => null);
      if (!st || !st.isFile() || st.isSymbolicLink()) continue;
      const res = await this.scanDatabaseEvents(dbPath, true);
      this.recordExcludedForkedClones(dbPath, res.excludedForkedGenIndices);
      if (res.hasError || res.usedCached || res.skippedLargeRecords > 0) {
        throw new Error(bt('usage.err.archive_db_failed', { name: basename(dbPath), error: res.error || bt('usage.err.cannot_read') }));
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
      await this.purgePendingForkedClones();
      await this.saveUsageLedger(rawPricing);
      if (this.largeLedger) await this.ledger.aggregate({ prices: rawPricing, environments: this.onlineRemoteEnvironments, remoteSyncRevision: this.remoteSyncRevision, accounts: this.knownAccounts, now: Math.floor(Date.now() / 1000) });
      if (this.ledgerUnavailable) throw Error(bt('usage.err.archive_not_persisted'));
      await this.savePersistentFileCache();
      await atomicJson(this.archivedEventsPath, {
        version: 1,
        updatedAt: new Date().toISOString(),
        databases: Object.fromEntries(this.archivedByDb.entries()),
      });
      const persisted = JSON.parse(await readFile(this.archivedEventsPath, 'utf8'));
      if (JSON.stringify(persisted.databases) !== JSON.stringify(Object.fromEntries(this.archivedByDb))) throw Error(bt('usage.err.archive_verify_failed'));
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

  private calendarKey() { const d=new Date();return formatLocalDate(d)+':'+d.getTimezoneOffset()+':'+Intl.DateTimeFormat().resolvedOptions().timeZone+':'+getActiveLocale(); }

  private withStickyPricingWarnings(warnings: string[]): string[] {
    if (!this.rateLocksFileFatal) return warnings;
    const fatalWarn = bt('usage.warn.rate_ledger_unreadable_stop');
    return warnings.includes(fatalWarn) ? warnings : [...warnings, fatalWarn];
  }

  async getRawPricingCatalog(): Promise<{ raw: Record<string, ApiPricingEntry>; publicKeys: Set<string> }> {
    const { merged, warnings, publicKeys } = await loadRawPricingTable(this.remotePricingCachePath, this.pricingCachePath);
    this.pricingWarnings = this.withStickyPricingWarnings(warnings);
    return { raw: merged, publicKeys };
  }

  async getRawPricingTable(): Promise<Record<string, ApiPricingEntry>> {
    const { raw } = await this.getRawPricingCatalog();
    return raw;
  }

  async getBillingPricingTable(): Promise<Record<string, ApiPricingEntry>> {
    const { billingPrices, warnings } = await loadRawPricingTable(this.remotePricingCachePath, this.pricingCachePath);
    this.pricingWarnings = this.withStickyPricingWarnings(warnings);
    return billingPrices;
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

  private canonicalActivePricingKeys(modelIds?: Iterable<string> | null, extraKeys?: Iterable<string>): Set<string> {
    return canonicalActivePricingKeys(modelIds !== undefined && modelIds !== null ? modelIds : this.activeOfficialModels, extraKeys);
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
    if (
      activeModelIds === undefined &&
      this.activeOfficialModels !== null &&
      this.activeOfficialModels.length === 0 &&
      (this.activeUnpricedOfficialModels?.length ?? 0) > 0
    ) {
      return Object.create(null);
    }
    return this.resolvePricingTableFromRaw(raw, timestampSeconds, this.canonicalActivePricingKeys(activeModelIds, Object.keys(raw)));
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
      lastSyncedUpdatedAt: this.lastSyncedUpdatedAt,
      lastSyncedEtag: this.lastSyncedEtag,
      lastSyncedSha256: this.lastSyncedSha256,
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
    this.lastSyncedUpdatedAt = next.lastSyncedUpdatedAt ?? '';
    this.lastSyncedEtag = next.lastSyncedEtag ?? '';
    this.lastSyncedSha256 = next.lastSyncedSha256 ?? '';
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

  async syncRemotePricing(feedUrl?: string, force = false): Promise<{ synced: boolean; unchanged?: boolean; error?: string; count?: number; sourceUrl?: string; version?: string; updatedAt?: string; healedCount?: number }> {
    if (this.pricingSyncInFlight) {
      if (!force && !feedUrl) {
        return this.pricingSyncInFlight;
      }
      await this.pricingSyncInFlight.catch(() => {});
    }
    const run = (async () => {
      await this.ensureSyncStateLoaded();
      const candidateUrls = selectRemotePricingCandidateUrls({
        feedUrl,
        customRemoteUrlConfigured: this.customRemoteUrlConfigured,
        remotePricingUrl: this.remotePricingUrl,
        fallbackPricingUrls: this.fallbackPricingUrls,
      });
      const now = Date.now();
      if (!force && now < this.nextAutoSyncAt) {
        return { synced: false, error: bt('usage.err.sync_rate_limited') };
      }
      const snapshot = this.pricingSyncStateSnapshot();
      const result = await executeRemotePricingSync({
        candidateUrls,
        remotePricingCachePath: this.remotePricingCachePath,
        pricingSyncStatePath: this.pricingSyncStatePath,
        state: snapshot,
        now,
        force,
      });
      this.applyPricingSyncState(snapshot);
      this.syncStateLoaded = true;
      if (!result.synced) {
        return result;
      }
      if (result.unchanged) {
        let healedCount = 0;
        if (force || !this.unchangedHealChecked) {
          this.unchangedHealChecked = true;
          try {
            healedCount = await this.autoHealUnpricedHistory();
          } catch {}
          if (healedCount > 0) {
            this.cachedSummariesByAccount.clear();
            this.lastAggregationKeysByAccount.clear();
            this.snapshots.clear();
            this.pricingRevisionSeq += 1;
            try {
              this.onPricingUpdatedHook?.({ version: result.version, healedCount });
            } catch {}
          }
        }
        return { ...result, healedCount };
      }
      this.unchangedHealChecked = true;
      this.cachedSummariesByAccount.clear();
      this.lastAggregationKeysByAccount.clear();
      this.snapshots.clear();
      let healedCount = 0;
      try {
        healedCount = await this.autoHealUnpricedHistory();
      } catch {}
      this.pricingRevisionSeq += 1;
      try {
        this.onPricingUpdatedHook?.({ version: result.version, healedCount });
      } catch {}
      return { ...result, healedCount };
    })();
    this.pricingSyncInFlight = run;
    try {
      return await run;
    } finally {
      if (this.pricingSyncInFlight === run) {
        this.pricingSyncInFlight = undefined;
      }
    }
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
    const raw = await this.getRawPricingTable();
    const hasOnlyUnpriced =
      this.activeOfficialModels !== null &&
      this.activeOfficialModels.length === 0 &&
      (this.activeUnpricedOfficialModels?.length ?? 0) > 0;
    const activeKeys = hasOnlyUnpriced
      ? new Set<string>()
      : this.canonicalActivePricingKeys(this.activeOfficialModels, Object.keys(raw));
    const activeTable = hasOnlyUnpriced
      ? Object.create(null)
      : this.resolvePricingTableFromRaw(raw, Math.floor(Date.now() / 1000), activeKeys);
    const unpricedCount = this.activeUnpricedOfficialModels !== null
      ? this.activeUnpricedOfficialModels.filter((k) => !Object.hasOwn(activeTable, k)).length
      : (this.activeOfficialModels !== null
          ? [...activeKeys].filter((k) => !Object.hasOwn(raw, k)).length
          : 0);
    return buildPricingSyncStatus({
      autoSyncEnabled: this.autoRemotePricingSync,
      state: this.pricingSyncStateSnapshot(),
      remotePricingUrl: this.remotePricingUrl,
      modelCount: Object.keys(activeTable).length + unpricedCount,
    });
  }

  async savePricingTable(table: Record<string, ApiPricing | ApiPricingInterval[]>): Promise<void> {
    await saveCustomPricingCache(this.pricingCachePath, table);
    this.cachedSummariesByAccount.clear();
    this.lastAggregationKeysByAccount.clear();
    this.snapshots.clear();
    this.pricingRevisionSeq += 1;
    try {
      this.onPricingUpdatedHook?.({});
    } catch {}
  }

  /**
   * 自动智能补齐未计价历史记录（零按钮、用户无感）：
   * 仅针对历史账本中由于此前模型未定价而记录为 $0.00 或尚未落锁的条目，
   * 在获取到官方最新定价后，按真实发生物理时间戳匹配当时费率，
   * 自动补齐并锁定；已锁定且有正常费率的记录绝对不动。
   */
  async autoHealUnpricedHistory(): Promise<number> {
    await this.loadUsageLedger();
    if (this.largeLedger) {
      if (this.ledgerUnavailable || this.archivedUnavailable || this.rateLocksUnavailable) return 0;
      if (this.usageLedgerDirty) await this.saveUsageLedger();
      const rawPricing = await this.getBillingPricingTable();
      const dbPaths = await this.discoverDatabaseFiles();
      const aggregated = await this.ledger.aggregate({
        prices: rawPricing,
        accountId: 'all',
        environmentId: 'all',
        environments: this.onlineRemoteEnvironments,
        remoteSyncRevision: this.remoteSyncRevision,
        accounts: this.knownAccounts,
        liveFiles: dbPaths.map(path => basename(path)),
        now: Math.floor(Date.now() / 1000),
      });
      const healed = (aggregated as typeof aggregated & { healed_unpriced_count?: number }).healed_unpriced_count ?? 0;
      this.cachedSummariesByAccount.clear();
      this.lastAggregationKeysByAccount.clear();
      this.snapshots.clear();
      if (healed > 0) {
        await this.getUsageSummary(true);
      }
      return healed;
    }

    await this.loadRateLocks();
    if (this.rateLocksUnavailable) return 0;
    const unpricedKeys: string[] = [];
    const beforeValidLockedKeys = new Set<string>();
    for (const [key, value] of Object.entries(this.rateLocks)) {
      const ledgerEv = this.usageLedgerEvents.get(key);
      const cw = ledgerEv?.cache_write_tokens ?? 0;
      const lockedMissingCw = Boolean(
        cw > 0 &&
        value?.price &&
        (() => {
          const eff = resolveContextTierPricing(value.price, (ledgerEv?.input_tokens ?? 0) + (ledgerEv?.cached_tokens ?? 0) + cw);
          return !Number.isFinite(eff.cacheWrite) || eff.cacheWrite! < 0;
        })()
      );
      if (this.isUnpricedRateLock(value) || lockedMissingCw) {
        unpricedKeys.push(key);
      } else {
        beforeValidLockedKeys.add(key);
      }
    }
    for (const key of unpricedKeys) {
      delete this.rateLocks[key];
    }
    if (unpricedKeys.length > 0) {
      this.rateLocksDirty = true;
    }
    this.cachedSummariesByAccount.clear();
    this.lastAggregationKeysByAccount.clear();
    this.snapshots.clear();

    await this.getUsageSummary(true);
    let healedCount = 0;
    for (const [key, value] of Object.entries(this.rateLocks)) {
      if (!beforeValidLockedKeys.has(key) && !this.isUnpricedRateLock(value)) {
        healedCount++;
      }
    }
    return healedCount;
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
    excludedForkedGenIndices?: number[];
    hasError?: boolean;
    error?: string;
    usedCached?: boolean;
    cacheHit?: boolean;
  }> {
    const res = await scanDatabaseEventsWithContext(this.scanContext(), dbPath, bypassCache, signal);
    this.recordExcludedForkedClones(dbPath, res.excludedForkedGenIndices);
    return res;
  }

  /** Privacy-preserving request rows: metrics only, no database paths or conversation content. */
  async getUsageEvents(
    period: string,
    query = '',
    offset = 0,
    limit = 200,
    snapshotId?: string,
    pin = false,
    force = false,
    accountId?: string,
    environmentId?: string
  ) {
    const accKey = accountId || 'all';
    const envKey = environmentId || 'all';
    const cacheKey = this.getSummaryCacheKey(accKey, envKey);
    if (!snapshotId || force) await this.getUsageSummary(force, accountId, environmentId);
    const snapshot = (!force && snapshotId)
      ? this.snapshots.get(snapshotId)
      : this.snapshots.get(this.cachedSummariesByAccount.get(cacheKey)?.data.snapshot_id ?? '');
    if (!snapshot || snapshot.expires<Date.now()) throw Error(bt('usage.err.snapshot_expired'));
    if (pin) snapshot.pins++;
    if (snapshot.pins > 0) snapshot.expires = Date.now()+600000;
    if (snapshot.ledger) {
      const snapshotAccountId = snapshot.ledger.accountId ?? 'all';
      if (accountId && snapshotAccountId !== 'all' && accountId !== snapshotAccountId) {
        throw Error(bt('usage.err.snapshot_account_mismatch'));
      }
      const snapshotEnvId = snapshot.ledger.environmentId ?? 'all';
      if (environmentId && snapshotEnvId !== 'all' && environmentId !== snapshotEnvId) {
        throw Error(bt('usage.err.snapshot_account_mismatch'));
      }
      const effectiveAccountId = accountId || snapshotAccountId;
      const effectiveEnvironmentId = environmentId || snapshotEnvId;
      const targetEmail = this.knownAccounts.find(account => account.id === effectiveAccountId)?.email;
      const effectiveSnapshot = (effectiveAccountId === snapshotAccountId && effectiveEnvironmentId === snapshotEnvId)
        ? snapshot.ledger
        : { ...snapshot.ledger, accountId: effectiveAccountId, environmentId: effectiveEnvironmentId };
      const page = await this.ledger.events({
        snapshot: effectiveSnapshot,
        period,
        query: query.slice(0, 200),
        offset: Math.max(0, Math.floor(offset) || 0),
        limit: Math.min(500, Math.max(1, Math.floor(limit) || 200)),
        targetEmail,
        environmentId: effectiveEnvironmentId,
      });
      return { ...page, generated_at: snapshot.summary.generated_at, snapshot_id: snapshot.summary.snapshot_id, availability: snapshot.summary.availability, scope: snapshot.summary.scan_scope_description };
    }
    const {summary,prices,rawPricing}=snapshot as any;
    const snapshotAccountId: string = summary.selected_account_id ?? 'all';
    if (accountId && snapshotAccountId !== 'all' && accountId !== snapshotAccountId) {
      throw Error(bt('usage.err.snapshot_account_mismatch'));
    }
    const snapshotEnvId: string = summary.selected_environment_id ?? 'all';
    if (environmentId && snapshotEnvId !== 'all' && environmentId !== snapshotEnvId) {
      throw Error(bt('usage.err.snapshot_account_mismatch'));
    }
    const effectiveAccountId = accountId ?? snapshotAccountId;
    const effectiveEnvironmentId = environmentId ?? snapshotEnvId;
    const start = new Date(summary.generated_at*1000); start.setHours(0, 0, 0, 0);
    if (period === '7d') start.setDate(start.getDate() - 6);
    if (period === '30d') start.setDate(start.getDate() - 29);
    const cutoff = period === 'all' ? 0 : start.getTime() / 1000;
    const end = new Date(summary.generated_at*1000); end.setHours(24,0,0,0);
    const upper = end.getTime()/1000;
    const matcher = createModelQueryMatcher(query);
    let events = snapshot.events.filter(e => (period === 'all' || (e.timestamp_seconds >= cutoff && e.timestamp_seconds < upper)) && matcher(e.model));
    if (effectiveAccountId === 'unattributed') {
      events = events.filter(e => !e.account_id && !e.account_email);
    } else if (effectiveAccountId && effectiveAccountId !== 'all') {
      const targetOpt = this.knownAccounts.find(a => a.id === effectiveAccountId || (a.email && a.email.toLowerCase() === effectiveAccountId.toLowerCase()));
      const targetEmail = targetOpt?.email?.toLowerCase() || (effectiveAccountId.includes('@') ? effectiveAccountId.toLowerCase() : null);
      events = events.filter(e => {
        if (e.account_id && e.account_id === effectiveAccountId) return true;
        if (targetEmail && e.account_email && e.account_email.toLowerCase() === targetEmail) return true;
        return false;
      });
    }
    if (effectiveEnvironmentId && effectiveEnvironmentId !== 'all') {
      events = events.filter(e => normalizeEventEnvironment(e).id === effectiveEnvironmentId);
    }
    const safeOffset = Math.max(0, Math.floor(offset) || 0);
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit) || 200));
    const pricingSource = rawPricing ?? prices;
    const rows = events.slice().reverse().slice(safeOffset, safeOffset + safeLimit).map(e => {
      const price = this.resolvePricing(pricingSource, e.model, e.timestamp_seconds);
      const cost = this.lockedCost(e, price);
      const env = normalizeEventEnvironment(e);
      const {
        event_key: _key,
        source_id: _source,
        legacy_event_key: _legacy,
        db_file: _dbFile,
        trajectory_id: _traj,
        execution: _exec,
        ...publicEvent
      } = e as LedgerEvent;
      return {
        ...publicEvent,
        environment_kind: env.kind,
        environment_id: env.id,
        environment_label: env.label,
        account_email: e.account_email ?? null,
        account_confidence: e.account_confidence ?? 'unknown',
        estimated_usd: cost,
        priced: cost !== null,
      };
    });
    if (this.rateLocksDirty) {
      this.rateLocksDirty = false;
      await this.saveRateLocks().catch(() => {});
    }
    return { rows, total: events.length, offset: safeOffset, limit: safeLimit, generated_at: summary.generated_at, snapshot_id: summary.snapshot_id, availability: summary.availability, scope: summary.scan_scope_description };
  }

  async getEventsWithCostsInRange(startSec: number, endSec: number): Promise<UsageRangeCostEvent[]> {
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec < startSec) {
      return [];
    }
    const safeStart = Math.floor(startSec);
    const safeEnd = Math.ceil(endSec);
    await this.loadUsageLedger();
    const rawPricing = await this.getBillingPricingTable();
    if (!this.largeLedger) {
      await this.loadRateLocks();
    }

    const merged = new Map<string, { event: LedgerEvent; lockedUsd: number | null; lockedPrice: ApiPricing | null }>();
    let ledgerRangeFailed = false;
    if (!this.ledgerUnavailable && !this.ledgerCorrupt) {
      try {
        const rangeRows = await this.ledger.range({ startSec: safeStart, endSec: safeEnd });
        for (const row of rangeRows) {
          if (!row?.event?.event_key) continue;
          if (row.event.db_file === 'recovered_session.db' || row.event.db_file === 'recovered_enterprise_session.db') {
            continue;
          }
          if (row.event.timestamp_seconds < safeStart || row.event.timestamp_seconds > safeEnd) continue;
          merged.set(row.event.event_key, {
            event: { ...row.event },
            lockedUsd: row.usd ?? null,
            lockedPrice: row.unitPrice ?? null,
          });
        }
      } catch {
        ledgerRangeFailed = true;
      }
    } else {
      ledgerRangeFailed = true;
    }

    const mergeInMemoryEvent = (ev: LedgerEvent) => {
      if (!ev?.event_key) return;
      if (ev.db_file === 'recovered_session.db' || ev.db_file === 'recovered_enterprise_session.db') return;
      if (ev.timestamp_seconds < safeStart || ev.timestamp_seconds > safeEnd) return;
      const existing = merged.get(ev.event_key);
      if (!existing) {
        merged.set(ev.event_key, { event: { ...ev }, lockedUsd: null, lockedPrice: null });
        return;
      }
      if ((existing.event.source_observed_at ?? 0) > (ev.source_observed_at ?? 0)) {
        return;
      }
      existing.event = this.mergeLedgerEventRecord(existing.event, ev);
    };

    if (!this.largeLedger || ledgerRangeFailed) {
      for (const ev of this.usageLedgerEvents.values()) {
        mergeInMemoryEvent(ev);
      }
    }
    for (const ev of this.pendingLedgerEvents.values()) {
      mergeInMemoryEvent(ev);
    }
    if (ledgerRangeFailed) {
      await this.loadArchivedEvents();
      for (const [archKey, arch] of this.archivedByDb.entries()) {
        const dbFile = basename(archKey);
        for (const ev of arch.events) {
          mergeInMemoryEvent({ ...ev, db_file: dbFile });
        }
      }
      for (const entry of this.fileCache.values()) {
        if (!entry || entry.hasError) continue;
        for (const ev of entry.events) {
          mergeInMemoryEvent(ev);
        }
      }
    }

    const dedupByDbLegacy = new Map<string, string>();
    for (const [key, item] of merged.entries()) {
      const ev = item.event;
      if (!ev.legacy_event_key) continue;
      const sig = `${ev.db_file ?? ''}:${ev.legacy_event_key}`;
      const prevKey = dedupByDbLegacy.get(sig);
      if (!prevKey || prevKey === key) {
        dedupByDbLegacy.set(sig, key);
        continue;
      }
      const prevItem = merged.get(prevKey);
      const replacePrev = prevItem
        ? ((Boolean(ev.source_id) && !prevItem.event.source_id) || ((ev.source_observed_at ?? 0) > (prevItem.event.source_observed_at ?? 0)))
        : true;
      if (replacePrev) {
        merged.delete(prevKey);
        dedupByDbLegacy.set(sig, key);
      } else {
        merged.delete(key);
      }
    }

    const readOnlyCost = (item: { event: LedgerEvent; lockedUsd: number | null; lockedPrice: ApiPricing | null }, resolvedModel: string): number | null => {
      const ev = item.event;
      if (ev.timestamp_seconds <= 0) return null;
      const cw = ev.cache_write_tokens ?? 0;

      let lockedPrice = item.lockedPrice;
      let lockedUsd = item.lockedUsd;
      if (!lockedPrice && !this.largeLedger && !this.rateLocksUnavailable && ev.event_key) {
        const memLock = this.rateLocks[ev.event_key]
          ?? (ev.legacy_event_key && this.usageLedgerEvents.get(ev.legacy_event_key)?.timestamp_seconds === ev.timestamp_seconds
            ? this.rateLocks[ev.legacy_event_key]
            : undefined);
        if (memLock && !this.isUnpricedRateLock(memLock)) {
          lockedPrice = memLock.price;
          if (this.rateLocks[ev.event_key]) {
            lockedUsd = memLock.usd;
          }
        }
      }

      if (lockedPrice && !isUnpricedZeroSentinel(lockedPrice)) {
        const effectiveLocked = resolveContextTierPricing(lockedPrice, ev.input_tokens + ev.cached_tokens + cw);
        const lockedMissingCw = cw > 0 && (!Number.isFinite(effectiveLocked.cacheWrite) || effectiveLocked.cacheWrite! < 0);
        if (!lockedMissingCw) {
          if (!ev.source_id && lockedUsd !== null && Number.isFinite(lockedUsd) && lockedUsd >= 0) {
            return lockedUsd;
          }
          return calculateEstimatedUsd(ev.input_tokens, ev.output_tokens, ev.cached_tokens, lockedPrice, cw);
        }
      }

      return calculateLockedEventUsd(ev, this.resolvePricing(rawPricing, resolvedModel, ev.timestamp_seconds));
    };

    const rows: UsageRangeCostEvent[] = [];
    for (const item of merged.values()) {
      const ev = item.event;
      const resolvedModel = resolveDatabaseModelFullName(ev.model, null);
      const cost = readOnlyCost(item, resolvedModel);
      rows.push({
        ...ev,
        model: resolvedModel,
        estimated_usd: cost,
        priced: cost !== null,
      });
    }
    rows.sort((a, b) => a.timestamp_seconds - b.timestamp_seconds || (a.event_key ?? '').localeCompare(b.event_key ?? ''));
    return rows;
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
  cancelRead() { this.scanAbort?.abort(new Error(bt('usage.err.read_cancelled'))); return !!this.scanAbort; }
  async getUsageSummary(forceRefresh = false, accountId?: string, environmentId?: string): Promise<TokenUsageSummary> {
    while (this.pricingMutation) await this.pricingMutation.catch(() => {});
    const accKey = accountId || 'all';
    const envKey = environmentId || 'all';
    if(this.inFlight) {
      if(this.inFlightAccountKey===accKey && this.inFlightEnvironmentKey===envKey && (!forceRefresh||this.inFlightForced)) return this.inFlight;
      if(this.inFlightAccountKey!==accKey || this.inFlightEnvironmentKey!==envKey) {
        return this.inFlight.catch(()=>{}).then(()=>this.getUsageSummary(forceRefresh, accountId, environmentId));
      }
      if(!this.pendingForced)this.pendingForced=this.inFlight.catch(()=>{}).then(()=>this.getUsageSummary(true, accountId, environmentId)).finally(()=>{this.pendingForced=undefined;});
      return this.pendingForced;
    }
    const abort=this.scanAbort=new AbortController(), timer=setTimeout(()=>abort.abort(new Error(bt('usage.err.read_timeout_budget'))),30000);timer.unref();
    this.inFlightForced=forceRefresh;
    this.inFlightAccountKey=accKey;
    this.inFlightEnvironmentKey=envKey;
    const work=this.collectUsage(forceRefresh,abort.signal,accountId,environmentId);this.inFlight=work;
    try{return await work;}finally{clearTimeout(timer);if(this.inFlight===work){this.inFlight=undefined;this.scanAbort=undefined;this.inFlightForced=false;this.inFlightAccountKey='all';this.inFlightEnvironmentKey='all';}}
  }
  private async collectUsage(forceRefresh: boolean, signal: AbortSignal, accountId?: string, environmentId?: string): Promise<TokenUsageSummary> {
    const accKey = accountId || 'all';
    const envKey = environmentId || 'all';
    const cacheKey = this.getSummaryCacheKey(accKey, envKey);
    const nowMs = Date.now();
    const cachedByAcc = this.cachedSummariesByAccount.get(cacheKey);
    if (
      !forceRefresh &&
      cachedByAcc &&
      nowMs < cachedByAcc.expiresAt &&
      this.periodKey === this.calendarKey() &&
      cachedByAcc.data.failed_databases_count === 0 &&
      (cachedByAcc.data.remote_sync_revision ?? 0) === this.remoteSyncRevision
    ) {
      return cachedByAcc.data;
    }

    await this.loadPersistentFileCache();
    if (forceRefresh && this.ledgerUnavailable && !this.ledgerCorrupt) {
      this.ledgerUnavailable = false;
      for (const warning of this.storageWarnings) {
        if (/用量总账未能保存|Failed to save usage ledger/i.test(warning)) {
          this.storageWarnings.delete(warning);
        }
      }
    }
    const reuseRecentLargeScan = Boolean(
      !forceRefresh &&
      this.largeLedger &&
      this.largeLedgerBaselinePresent &&
      !this.ledgerUnavailable &&
      this.lastLargeLedgerScanMeta &&
      this.lastLargeLedgerScanMeta.failedDatabasesCount === 0 &&
      (nowMs - this.lastLargeLedgerScanAtMs) < 10_000
    );

    const allEvents: GenerationEvent[] = [];
    let dbPaths: string[] = [];
    let liveFileNames: string[] = [];
    let archivedDbCount = 0;
    const archivedStampParts: string[] = [];
    let generationsScanned = 0;
    let skippedLargeRecords = 0;
    let failedDatabasesCount = 0;
    let cachedDatabasesCount = 0;
    let diagnostics: NonNullable<TokenUsageSummary['database_diagnostics']> = [];
    let allCacheHits = false;

    if (reuseRecentLargeScan) {
      const meta = this.lastLargeLedgerScanMeta!;
      liveFileNames = meta.liveFiles;
      archivedDbCount = meta.archivedDbCount;
      generationsScanned = meta.generationsScanned;
      skippedLargeRecords = meta.skippedLargeRecords;
      failedDatabasesCount = meta.failedDatabasesCount;
      diagnostics = meta.diagnostics;
      allCacheHits = true;
    } else {
      dbPaths = await this.discoverDatabaseFiles();
      liveFileNames = dbPaths.map(p => basename(p));
      failedDatabasesCount = this.discoveryErrors.length;
      diagnostics = [...this.discoveryErrors];
      const category = (message = '') => /取消|超过预算|整体预算|总账操作超时|bounded read budget|30-second total budget|cancel|timeout|aborted/i.test(message) ? bt('usage.diag.cancelled_or_budget') : /时间|timestamp/i.test(message) ? bt('usage.diag.incomplete_time') : /unable to open|permission|denied|not permitted/i.test(message) ? bt('usage.diag.cannot_open') : /no such table|no such column/i.test(message) ? bt('usage.diag.unsupported_schema') : /locked|busy/i.test(message) ? bt('usage.diag.db_busy') : /maxBuffer|stdout.*length|单批|batch budget|超出/i.test(message) ? bt('usage.diag.batch_budget') : /malformed|not a database/i.test(message) ? bt('usage.diag.corrupt_format') : bt('usage.diag.incomplete');

      let nextDatabase=0;
      allCacheHits = dbPaths.length > 0;
      await Promise.all(Array.from({length:Math.min(8,dbPaths.length)},async()=>{
      while(nextDatabase<dbPaths.length) {
        if(signal.aborted){allCacheHits=false;break;}
        const p=dbPaths[nextDatabase++]!;
        // forceRefresh 绕过内存摘要 TTL 并重新读取目录与全部 .db/.db-wal 物理 stat；
        // 对物理指纹完全一致且无错误的历史静态库直接命中 fileCache，消除全盘冷重扫引发的 30s 超时。
        const cachedEntry = this.fileCache.get(p);
        const bypassFileCache = Boolean(cachedEntry && !isFileCacheEntryReusable(cachedEntry));
        const res = await this.scanDatabaseEvents(p, bypassFileCache, signal);
        this.recordExcludedForkedClones(p, res.excludedForkedGenIndices);
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
              this.clearLedgerEventsMap();
            }
          }
        } else {
          for (const ev of res.events) allEvents.push(ev);
          if (allEvents.length > 50_000 && !this.ledgerUnavailable) {
            await this.loadUsageLedger();
            if (!this.ledgerUnavailable) {
              this.largeLedger = true;
              const batch = allEvents.splice(0, allEvents.length);
              for (const event of batch) this.upsertLedger(event);
              await this.saveUsageLedger();
              if (this.ledgerUnavailable) {
                for (const ev of batch) allEvents.push(ev);
              } else {
                this.clearLedgerEventsMap();
              }
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
          category: res.hasError ? category(res.error) : bt('usage.diag.read'), lastSuccessAt: cached?.lastSuccessAt });
      }
      }));

      for(const path of dbPaths.slice(nextDatabase)) {
        allCacheHits = false;
        const cached=this.fileCache.get(path);failedDatabasesCount++;
        if(cached){for (const ev of cached.events) allEvents.push(ev);cachedDatabasesCount++;generationsScanned+=cached.generationsScanned;skippedLargeRecords+=cached.skippedLargeRecords;}
        diagnostics.push({id:createHash('sha256').update(path).digest('hex').slice(0,10),state:cached?'cached_or_partial':'failed',category:bt('usage.diag.cancelled_or_budget'),lastSuccessAt:cached?.lastSuccessAt});
      }

      await this.loadArchivedEvents();
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
      await this.purgePendingForkedClones();
    }
    if (this.autoRemotePricingSync && Date.now() >= this.nextAutoSyncAt) {
      void this.syncRemotePricing().catch(() => {});
    }
    if (this.largeLedger && !this.ledgerUnavailable) {
      if (!reuseRecentLargeScan) {
        void this.savePersistentFileCache();
        for (const event of allEvents) this.upsertLedger(event);
        await this.saveUsageLedger();
        this.lastLargeLedgerScanAtMs = Date.now();
        this.lastLargeLedgerScanMeta = {
          dbPathsCount: dbPaths.length,
          archivedDbCount,
          generationsScanned,
          skippedLargeRecords,
          failedDatabasesCount,
          diagnostics,
          liveFiles: liveFileNames,
          lastDiscoveredDatabaseCount: this.lastDiscoveredDatabaseCount || dbPaths.length,
        };
      }
      const rawPricing = await this.getBillingPricingTable();
      if (this.rateLocksUnavailable && !this.pricingWarnings.some(w => /费率账本|rate ledger/i.test(w))) this.pricingWarnings.push(bt('usage.warn.rate_ledger_unreadable_no_reprice'));
      const revision = await this.ledger.version();
      const aggregateKey = JSON.stringify([revision, this.calendarKey(), rawPricing, accKey, envKey, this.knownAccounts, this.remoteSyncRevision, this.onlineRemoteEnvSig, skippedLargeRecords]);
      const prior = this.cachedSummariesByAccount.get(cacheKey)?.data;
      const existingSnapshot = prior?.snapshot_id ? this.snapshots.get(prior.snapshot_id) : undefined;
      const effectiveDbCount = reuseRecentLargeScan ? this.lastLargeLedgerScanMeta!.dbPathsCount : dbPaths.length;
      const effectiveDiscoveredBase = reuseRecentLargeScan ? this.lastLargeLedgerScanMeta!.lastDiscoveredDatabaseCount : (this.lastDiscoveredDatabaseCount || dbPaths.length);
      const totalScanned = effectiveDbCount + archivedDbCount;
      const totalDiscovered = effectiveDiscoveredBase + archivedDbCount;
      if (prior && existingSnapshot?.ledger && this.lastAggregationKeysByAccount.get(cacheKey) === aggregateKey && await this.ledger.renew(existingSnapshot.ledger)) {
        const reusedWarnings = [...this.pricingWarnings, ...this.storageWarnings];
        const availability = failedDatabasesCount > 0 || skippedLargeRecords > 0 || this.storageWarnings.size > 0 || prior.unknown_time_records || prior.historical_amount_receipts?.unmatchedCount ? 'partial' : 'complete';
        const hasReadError = this.ledgerCorrupt || this.archivedUnavailable || failedDatabasesCount > 0 || skippedLargeRecords > 0 || (prior.unknown_time_records ?? 0) > 0;
        const reused: TokenUsageSummary = { ...prior, availability, has_error: hasReadError, hasError: hasReadError,
          databases_scanned: totalScanned, databases_discovered: totalDiscovered,
          generations_scanned: generationsScanned, skipped_large_records: skippedLargeRecords,
          failed_databases_count: failedDatabasesCount, database_diagnostics: diagnostics, last_attempt_at: Math.floor(Date.now() / 1000),
          pricing_warnings: reusedWarnings, pricing_warning_codes: buildPricingWarningCodes(reusedWarnings) };
        existingSnapshot.expires = Date.now() + 600000;
        existingSnapshot.summary = reused;
        this.cachedSummariesByAccount.set(cacheKey, { data: reused, expiresAt: Date.now() + (failedDatabasesCount > 0 ? 2000 : 30000) });
        return reused;
      }
      const aggregated = await this.ledger.aggregate({
        prices: rawPricing,
        accountId,
        environmentId: envKey,
        environments: this.onlineRemoteEnvironments,
        remoteSyncRevision: this.remoteSyncRevision,
        accounts: this.knownAccounts,
        liveFiles: liveFileNames,
        now: Math.floor(Date.now() / 1000),
      });
      const largeStorageWarnings = new Set(this.storageWarnings);
      if (aggregated.ledger_review_records) largeStorageWarnings.add(bt('usage.warn.ledger_review_needed'));
      const largeWarnings = [...this.pricingWarnings, ...largeStorageWarnings];
      const availability = failedDatabasesCount > 0 || skippedLargeRecords > 0 || largeStorageWarnings.size > 0 || aggregated.unknown_time_records || aggregated.historical_amount_receipts?.unmatchedCount ? 'partial' : 'complete';
      const hasReadError = this.ledgerCorrupt || this.archivedUnavailable || failedDatabasesCount > 0 || skippedLargeRecords > 0 || (aggregated.unknown_time_records ?? 0) > 0;
      const aggPublic: typeof aggregated & { healed_unpriced_count?: number } = { ...aggregated };
      delete aggPublic.healed_unpriced_count;
      const result: TokenUsageSummary = { ...aggPublic, availability, has_error: hasReadError, hasError: hasReadError,
        priced_models: aggregated.all_time.priced_models, unpriced_models: aggregated.all_time.unpriced_models,
        databases_scanned: totalScanned, databases_discovered: totalDiscovered,
        generations_scanned: generationsScanned, skipped_large_records: skippedLargeRecords, failed_databases_count: failedDatabasesCount,
        database_diagnostics: diagnostics, scan_scope_description: bt('usage.scope.indexed_ledger'),
        pricing_warnings: largeWarnings, pricing_warning_codes: buildPricingWarningCodes(largeWarnings) };
      const id = result.snapshot_id!;
      const previous = this.snapshots.get(id);
      if (previous) result.generated_at = previous.summary.generated_at;
      this.snapshots.set(id, { summary: result, ledger: aggregated.ledger_snapshot, events: [], prices: {}, rawPricing,
        expires: Date.now() + 600000, pins: previous?.pins ?? 0 });
      const ledgerVersion = JSON.stringify([aggregated.ledger_snapshot.revision, aggregated.ledger_snapshot.rateRevision]);
      this.lastAggregationKeysByAccount.set(cacheKey, JSON.stringify([ledgerVersion, this.calendarKey(), rawPricing, accKey, envKey, this.knownAccounts, this.remoteSyncRevision, this.onlineRemoteEnvSig, skippedLargeRecords]));
      this.cachedSummariesByAccount.set(cacheKey, { data: result, expiresAt: Date.now() + (failedDatabasesCount > 0 ? 2000 : 30000) });
      this.periodKey = this.calendarKey();
      this.clearLedgerEventsMap();
      this.pruneSnapshots();
      return result;
    }

    const liveEventsCount = allEvents.length;

    for (const event of allEvents) this.upsertLedger(event);

    // 从追加型永久总账（UsageLedger）合并已离线/已归档或被官方清理的会话事件
    const seenEventKeys = new Set<string>();
    const seenDbLegacyKeys = new Set<string>();
    const uniqueLiveEvents: GenerationEvent[] = [];
    for (const ev of allEvents) {
      if (ev.event_key) {
        if (seenEventKeys.has(ev.event_key)) continue;
        seenEventKeys.add(ev.event_key);
      }
      if (ev.legacy_event_key) {
        const dbFile = 'db_file' in ev && typeof ev.db_file === 'string' ? ev.db_file : '';
        const legacySig = `${dbFile}:${ev.legacy_event_key}`;
        if (seenDbLegacyKeys.has(legacySig)) continue;
        seenDbLegacyKeys.add(legacySig);
      }
      uniqueLiveEvents.push(ev);
    }
    if (uniqueLiveEvents.length !== allEvents.length) {
      allEvents.splice(0, allEvents.length, ...uniqueLiveEvents);
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
      if (ledgerEv.legacy_event_key && seenDbLegacyKeys.has(`${ledgerEv.db_file ?? ''}:${ledgerEv.legacy_event_key}`)) continue;
      if (!ledgerEv.source_id && ledgerEv.db_file && liveSourceFiles.has(ledgerEv.db_file)) {
        this.storageWarnings.add(bt('usage.warn.ledger_missing_source_id'));
        continue;
      }
      if (!seenEventKeys.has(evKey)) {
        seenEventKeys.add(evKey);
        if (ledgerEv.legacy_event_key) seenDbLegacyKeys.add(`${ledgerEv.db_file ?? ''}:${ledgerEv.legacy_event_key}`);
        allEvents.push(ledgerEv);
        if (ledgerEv.db_file && !representedFiles.has(ledgerEv.db_file)) mergedLedgerDbs.add(ledgerEv.db_file);
      }
    }
    archivedDbCount += mergedLedgerDbs.size;

    const existingAccCache = this.cachedSummariesByAccount.get(cacheKey);
    const calNowKey = this.calendarKey();
    if ((allEvents.length === 0 || (dbPaths.length > 0 && cachedDatabasesCount === dbPaths.length)) && failedDatabasesCount > 0 && existingAccCache?.data && this.periodKey === calNowKey) {
      if (existingAccCache.data.snapshot_id && this.snapshots.has(existingAccCache.data.snapshot_id)) {
        this.snapshots.get(existingAccCache.data.snapshot_id)!.expires = Date.now() + 600000;
      }
      const fallbackWarnings = existingAccCache.data.pricing_warnings ?? [...this.pricingWarnings, ...this.storageWarnings];
      return {
        ...existingAccCache.data,
        failed_databases_count: failedDatabasesCount,
        has_error: true,
        hasError: true, availability: 'cached', database_diagnostics: diagnostics, last_attempt_at: Math.floor(Date.now()/1000),
        pricing_warnings: fallbackWarnings,
        pricing_warning_codes: existingAccCache.data.pricing_warning_codes ?? buildPricingWarningCodes(fallbackWarnings),
      };
    }

    void this.savePersistentFileCache();
    if (this.usageLedgerDirty) {
      await this.saveUsageLedger();
    }
    const rawPricing = await this.getBillingPricingTable();
    await this.loadRateLocks();
    if (this.rateLocksUnavailable && !this.pricingWarnings.some(w => /费率账本|rate ledger/i.test(w))) this.pricingWarnings.push(bt('usage.warn.rate_ledger_unreadable_no_reprice'));
    if (!this.syncReceiptsCache && !this.ledgerUnavailable) {
      await this.getSyncReceipts();
    }
    const receiptSyncTimes = new Map<string, number>();
    if (this.syncReceiptsCache) {
      for (const rec of Object.values(this.syncReceiptsCache)) {
        if (rec?.environment_id && Number(rec.committed_at) > 0) {
          const prevTs = receiptSyncTimes.get(rec.environment_id) ?? 0;
          if (rec.committed_at > prevTs) receiptSyncTimes.set(rec.environment_id, rec.committed_at);
        }
      }
    }
    const now = Math.floor(Date.now() / 1000);
    const pricing = this.resolvePricingTableFromRaw(rawPricing, now);
    const calKey = this.calendarKey();
    const knownAccountsSig = this.knownAccounts.map(a => `${a.id}:${a.email || ''}:${a.name || ''}`).join(',');
    const aggKey = allCacheHits && failedDatabasesCount === 0
      ? `${cacheKey}|rev:${this.remoteSyncRevision}|envs:${this.onlineRemoteEnvSig}|accs:${knownAccountsSig}|${calKey}|${this.lastDiscoveredDatabaseCount}|${dbPaths.map(p => { const c = this.fileCache.get(p); return c ? `${p}:${c.mtimeMs}:${c.size}:${c.walMtimeMs}:${c.walSize}:${c.hasError ? 1 : 0}:${c.skippedLargeRecords}:${c.projectionVersion ?? 0}` : p; }).join(';')}|arch:${archivedStampParts.join(';')}|${JSON.stringify(rawPricing)}|${this.pricingWarnings.join(',')}`
      : '';
    const cachedByAccEntry = this.cachedSummariesByAccount.get(cacheKey);
    if (aggKey && aggKey === this.lastAggregationKeysByAccount.get(cacheKey) && cachedByAccEntry?.data && this.periodKey === calKey) {
      const reusedWarnings = [...this.pricingWarnings, ...this.storageWarnings];
      const reused: TokenUsageSummary = {
        ...cachedByAccEntry.data,
        database_diagnostics: diagnostics,
        last_attempt_at: now,
        pricing_warnings: reusedWarnings,
        pricing_warning_codes: buildPricingWarningCodes(reusedWarnings),
      };
      this.cachedSummariesByAccount.set(cacheKey, { data: reused, expiresAt: Date.now() + 30_000 });
      if (reused.snapshot_id && this.snapshots.has(reused.snapshot_id)) {
        this.snapshots.get(reused.snapshot_id)!.expires = Date.now() + 600000;
      }
      this.pruneSnapshots();
      return reused;
    }

    // 汇总可用的账号列表 (available_accounts)
    // 规则：首项恒为“全部账号”，后续依次排列所有真实登录/保存过的具体账号（以邮箱呈现），杜绝“个人账号”或“企业 Vertex AI”等虚构分类
    const accountMap = new Map<string, AvailableAccountUsageOption>();
    accountMap.set('all', { id: 'all', label: bt('usage.all_accounts'), type: 'all', total_tokens: 0, request_count: 0 });

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
    const emailToAccountKey = new Map<string, string>();
    for (const [k, opt] of accountMap.entries()) {
      if (k !== 'all' && opt.email) {
        emailToAccountKey.set(opt.email.toLowerCase(), k);
      }
    }
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
        targetKey = emailToAccountKey.get(ev.account_email.toLowerCase()) ?? null;
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
        if (ev.account_email) {
          emailToAccountKey.set(ev.account_email.toLowerCase(), newKey);
        }
        targetKey = newKey;
      }

      const item = accountMap.get(targetKey)!;
      item.total_tokens = (item.total_tokens ?? 0) + ev.total_tokens;
      item.request_count = (item.request_count ?? 0) + 1;
    }

    allEvents.sort((a, b) => a.timestamp_seconds - b.timestamp_seconds || (a.event_key ?? '').localeCompare(b.event_key ?? ''));

    // 账号下钻过滤
    let effectiveEvents = allEvents;
    if (accountId === 'unattributed') {
      effectiveEvents = allEvents.filter(ev => !ev.account_id && !ev.account_email);
    } else if (accountId && accountId !== 'all') {
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
      environmentId: envKey,
      environments: this.onlineRemoteEnvironments,
      remoteSyncRevision: this.remoteSyncRevision,
      receiptSyncTimes,
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
      this.lastAggregationKeysByAccount.set(cacheKey, aggKey);
    }
    this.cachedSummariesByAccount.set(cacheKey, { data: summary, expiresAt: Date.now() + (failedDatabasesCount > 0 ? 2000 : 30000) });
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
