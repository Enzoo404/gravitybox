import { ALLOWED_DATA_DIRECTORY_NAMES, type DataDirectoryName } from './application-target.js';
import { CATALOG_PRICING_VERSION } from './model-catalog.js';
import { SqliteReadSnapshot } from './sqlite-read.js';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { atomicJson, atomicText, readOptionalJson } from './files.js';
import { createHash } from 'node:crypto';
import { APP_VERSION } from './version.js';
import type { LedgerSnapshot } from './usage-aggregate.js';
import { UsageLedger, type LedgerEvent } from './usage-ledger.js';
import { ProtobufReader, ProtobufWriter } from './protobuf.js';
import {
  DEFAULT_API_PRICES,
  DEFAULT_PRICING_FEED_URLS,
  PRICING_METADATA,
  calculateEstimatedUsd,
  canonicalActivePricingKeys,
  matchPricingKeys,
  mergePricingEntries,
  priceStatus,
  resolvePricingForTimestamp,
  resolvePricingFromTable,
  validateRawPrices,
  type ApiPricing,
  type ApiPricingEntry,
  type ApiPricingInterval,
} from './pricing.js';
export {
  ProtobufReader,
  ProtobufWriter,
  DEFAULT_API_PRICES,
  DEFAULT_PRICING_FEED_URLS,
  PRICING_METADATA,
  calculateEstimatedUsd,
  matchPricingKeys,
  priceStatus,
  resolvePricingForTimestamp,
  type ApiPricing,
  type ApiPricingEntry,
  type ApiPricingInterval,
};

try {
  process.loadEnvFile?.();
} catch (error: any) {
  if (error?.code !== 'ENOENT') {
    // ignore
  }
}

export interface TokenUsageTotals {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
}

export interface ModelTokenUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
  estimated_usd: number;
  priced?: boolean;
  partiallyPriced?: boolean;
  unpriced_tokens?: number;
  pricingKey?: string; pricingStatus?: string; pricingProvenance?: ApiPricing["provenance"] | null;
}

export interface DailyTokenUsage {
  date: string; // YYYY-MM-DD
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
}

export interface HourlyTokenUsage {
  hour: string; // YYYY-MM-DD HH:00
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
}

export interface TokenUsagePeriod {
  totals: TokenUsageTotals;
  estimated_usd: number;
  by_model: ModelTokenUsage[];
  priced_models?: number;
  unpriced_models?: number;
}

export interface TokenUsageSummary {
  today: TokenUsagePeriod;
  last_7_days: TokenUsagePeriod;
  last_30_days: TokenUsagePeriod;
  all_time: TokenUsagePeriod;
  daily_trends: DailyTokenUsage[];
  today_hourly: HourlyTokenUsage[];
  databases_scanned: number;
  databases_discovered?: number;
  scan_scope_description?: string;
  generations_scanned: number;
  skipped_large_records: number;
  generated_at: number;
  priced_models?: number;
  unpriced_models?: number;
  failed_databases_count?: number;
  has_error?: boolean;
  hasError?: boolean;
  availability?: 'complete' | 'partial' | 'cached' | 'unavailable';
  unknown_time_records?: number;
  unknown_time_tokens?: number;
  database_diagnostics?: { id: string; state: string; category: string; lastSuccessAt?: number }[];
  snapshot_id?: string;
  last_attempt_at?: number;
  pricing_warnings?: string[];
  unattributed_requests?: number;
  unattributed_tokens?: number;
  ledger_review_records?: number;
  historical_amount_receipts?: { unmatchedCount: number; unmatchedUsd: number };
  available_accounts?: AvailableAccountUsageOption[];
  selected_account_id?: string;
}

export interface AvailableAccountUsageOption {
  id: string; // 'all' | accountId | email
  label: string; // '全部账号' | 'account-one@example.invalid' | 'account-two@example.invalid'
  email?: string;
  name?: string | null;
  type?: 'all' | 'account';
  total_tokens?: number;
  request_count?: number;
}

export interface GenerationEvent {
  event_key?: string;
  source_id?: string;
  source_observed_at?: number;
  generation_index?: number;
  legacy_event_key?: string;
  account_confidence?: 'observed' | 'unknown' | 'legacy';
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  timestamp_seconds: number;
  account_id?: string;
  account_email?: string;
  account_type?: 'consumer' | 'enterprise_vertex' | 'unknown';
  project_id?: string;
}

/**
 * 基于 Antigravity 数据库 (gen_metadata) 提取真实 Response model 名称（如 "gemini-3.8-flash-n", "gemini-3.8-flash-exp-a"），不包含推理程度 high/medium/low。
 * 针对 Vertex AI / GCP 路径前缀（如 publishers/google/models/gemini-4-carbon）自动解耦并清洗为规范模型名称。
 */
export function resolveDatabaseModelFullName(
  modelId: string | null | undefined,
  label: string | null | undefined
): string {
  const cleanId = typeof modelId === 'string' ? modelId.trim() : '';
  if (cleanId) {
    const stripped = cleanId
      .replace(/^(?:projects\/[^/]+\/locations\/[^/]+\/)?(?:publishers\/[^/]+\/)?models\//i, '')
      .replace(/^publishers\/[^/]+\/models\//i, '')
      .replace(/^(?:vertex_ai|google|anthropic|openai)\//i, '')
      .replace(/^models\//i, '')
      .replace(/:(?:predict|generateContent|streamGenerateContent)$/i, '');
    if (stripped) return stripped;
    return cleanId;
  }
  const cleanLabel = typeof label === 'string' ? label.trim() : '';
  if (cleanLabel) {
    return cleanLabel
      .replace(/\s*[（(]\s*(?:extra[\s-]*low|high|medium|low|thinking|max)\s*[）)]\s*$/i, '')
      .replace(/\s+(?:extra[\s-]*low|high|medium|low|thinking|max)\s*$/i, '')
      .trim() || cleanLabel;
  }
  return '未知模型';
}

export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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
  private fileCache = new Map<
    string,
    {
      mtimeMs: number;
      size: number;
      walMtimeMs: number;
      walSize: number;
      events: GenerationEvent[];
      generationsScanned: number;
      skippedLargeRecords: number;
      hasError?: boolean;
      error?: string;
      lastSuccessAt?: number;
    }
  >();

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

  private async loadPersistentFileCache(): Promise<void> {
    if (this.persistLoaded || !this.persistCachePath) return;
    this.persistLoaded = true;
    try {
      const raw = JSON.parse(await readFile(this.persistCachePath, 'utf8'));
      if (raw && raw.version === 3 && typeof raw.entries === 'object' && raw.entries !== null) {
        for (const [k, v] of Object.entries(raw.entries as Record<string, any>)) {
          if (v && typeof v.mtimeMs === 'number' && typeof v.size === 'number' && Array.isArray(v.events) && v.events.every((e: GenerationEvent) => typeof e.event_key === 'string') && !v.hasError && !this.fileCache.has(k)) {
            this.fileCache.set(k, v);
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
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
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

  private validateRawPrices(table: unknown): Record<string, ApiPricingEntry> {
    return validateRawPrices(table);
  }

  private calendarKey() { const d=new Date();return formatLocalDate(d)+':'+d.getTimezoneOffset()+':'+Intl.DateTimeFormat().resolvedOptions().timeZone; }

  private mergePricingEntries(merged: Record<string, ApiPricingEntry>, entries: object, warning: string): void {
    mergePricingEntries(merged, entries, warning, this.pricingWarnings);
  }

  async getRawPricingTable(): Promise<Record<string, ApiPricingEntry>> {
    this.pricingWarnings = [];
    const merged: Record<string, ApiPricingEntry> = Object.assign(Object.create(null), DEFAULT_API_PRICES);

    // 1. 尝试合并本地远程缓存（禁止早于内置目录日期的旧远端缓存降级覆盖较新的官方目录）
    try {
      const rawRemote = await readFile(this.remotePricingCachePath, 'utf8');
      const parsedRemote = JSON.parse(rawRemote);
      const remotePrices = parsedRemote && typeof parsedRemote === 'object' && parsedRemote.prices ? parsedRemote.prices : parsedRemote;
      const remoteVer = typeof parsedRemote?.feedVersion === 'string' ? parsedRemote.feedVersion.trim() : '';
      const isOlderDatedFeed = /^\d{4}-\d{2}-\d{2}$/.test(remoteVer)
        && /^\d{4}-\d{2}-\d{2}$/.test(CATALOG_PRICING_VERSION)
        && remoteVer < CATALOG_PRICING_VERSION;
      if (remotePrices && typeof remotePrices === 'object' && !Array.isArray(remotePrices)) {
        const filteredRemote = isOlderDatedFeed
          ? Object.fromEntries(Object.entries(remotePrices).filter(([k]) => !Object.hasOwn(merged, k)))
          : remotePrices;
        this.mergePricingEntries(merged, filteredRemote, '远程价格条目待修复：');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.pricingWarnings.push('远程价格缓存无法读取');
      }
    }

    // 2. 尝试合并用户自定义价格缓存（最高优先级）
    try {
      const rawCustom = await readFile(this.pricingCachePath, 'utf8');
      const cached = JSON.parse(rawCustom);
      if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
        this.mergePricingEntries(merged, cached, '自定义价格条目待修复：');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.pricingWarnings.push('自定义价格无法读取');
      }
    }

    return merged;
  }

  async getPricingTable(timestampSeconds = Math.floor(Date.now() / 1000)): Promise<Record<string, ApiPricing>> {
    const raw = await this.getRawPricingTable();
    const resolved: Record<string, ApiPricing> = Object.create(null);
    for (const key of Object.keys(raw)) {
      const p = this.resolvePricing(raw, key, timestampSeconds);
      if (p) resolved[key] = p;
    }
    return resolved;
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
    const allowedKeys = this.canonicalActivePricingKeys(activeModelIds);
    const resolved: Record<string, ApiPricing> = Object.create(null);
    for (const key of Object.keys(raw)) {
      if (!allowedKeys.has(key)) continue;
      const p = this.resolvePricing(raw, key, timestampSeconds);
      if (p) resolved[key] = p;
    }
    return resolved;
  }

  async syncRemotePricing(feedUrl?: string, force = false): Promise<{ synced: boolean; error?: string; count?: number; sourceUrl?: string; version?: string; healedCount?: number }> {
    const candidateUrls = feedUrl
      ? [feedUrl]
      : (this.customRemoteUrlConfigured && this.fallbackPricingUrls === DEFAULT_PRICING_FEED_URLS)
      ? [this.remotePricingUrl]
      : (this.remotePricingUrl && !this.fallbackPricingUrls.includes(this.remotePricingUrl))
      ? [this.remotePricingUrl, ...this.fallbackPricingUrls]
      : this.fallbackPricingUrls;

    const now = Date.now();
    if (!force && now < this.nextAutoSyncAt) {
      return { synced: false, error: '检查频率限制（24小时）' };
    }

    let lastError: any = null;
    for (const targetUrl of candidateUrls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        const res = await fetch(targetUrl, { signal: controller.signal, headers: { 'User-Agent': `GravityBox/${APP_VERSION}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const prices = data && typeof data === 'object' && data.prices ? data.prices : data;
        const validated = this.validateRawPrices(prices);
        const feedVersion = (data && typeof data === 'object' && typeof data.version === 'string') ? data.version : 'unknown';
        await atomicJson(this.remotePricingCachePath, {
          version: 1,
          syncedAt: new Date(now).toISOString(),
          sourceUrl: targetUrl,
          feedVersion,
          prices: validated,
        });
        this.lastRemoteSyncAt = now;
        this.lastCheckAt = now;
        this.nextAutoSyncAt = now + 86_400_000;
        this.syncStateLoaded = true;
        this.lastSyncSuccess = true;
        this.lastCheckSuccess = true;
        this.lastSyncError = null;
        this.lastSyncedSourceUrl = targetUrl;
        this.lastSyncedVersion = feedVersion;
        await atomicJson(this.pricingSyncStatePath, {
          lastCheckAt: now,
          lastCheckSuccess: true,
          lastSyncError: null,
        }).catch(() => {});
        this.cachedSummariesByAccount.clear();
        this.lastAggregationKeysByAccount.clear();
        let healedCount = 0;
        try {
          healedCount = await this.autoHealUnpricedHistory();
        } catch {}
        return { synced: true, count: Object.keys(validated).length, sourceUrl: targetUrl, version: feedVersion, healedCount };
      } catch (err: any) {
        lastError = err;
        continue;
      } finally {
        clearTimeout(timer);
      }
    }

    // 所有候选源均尝试失败：保留上次成功同步时间，仅推进检查时间戳与 5 分钟重试冷却
    this.nextAutoSyncAt = now + 300_000;
    this.lastCheckAt = now;
    this.syncStateLoaded = true;
    this.lastSyncSuccess = false;
    this.lastCheckSuccess = false;
    this.lastSyncError = lastError?.message ?? String(lastError);
    await atomicJson(this.pricingSyncStatePath, {
      lastCheckAt: now,
      lastCheckSuccess: false,
      lastSyncError: this.lastSyncError,
    }).catch(() => {});
    return { synced: false, error: this.lastSyncError ?? undefined };
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
    if (!this.syncStateLoaded) {
      this.syncStateLoaded = true;
      if (!this.lastRemoteSyncAt) {
        const data = await readOptionalJson<{ syncedAt?: string; sourceUrl?: string; feedVersion?: string }>(
          this.remotePricingCachePath,
          'remote-pricing-cache.json'
        );
        if (data?.syncedAt) {
          this.lastRemoteSyncAt = Date.parse(data.syncedAt) || 0;
          this.lastSyncSuccess = true;
          this.lastSyncedSourceUrl = data.sourceUrl ?? '';
          this.lastSyncedVersion = data.feedVersion ?? '';
        }
      }
      const checkData = await readOptionalJson<{ lastCheckAt?: number; lastCheckSuccess?: boolean; lastSyncError?: string | null }>(
        this.pricingSyncStatePath,
        'pricing-sync-state.json'
      );
      if (checkData && typeof checkData === 'object') {
        if (typeof checkData.lastCheckAt === 'number' && Number.isFinite(checkData.lastCheckAt)) {
          this.lastCheckAt = checkData.lastCheckAt;
        }
        if (typeof checkData.lastCheckSuccess === 'boolean') {
          this.lastCheckSuccess = checkData.lastCheckSuccess;
        }
        if (typeof checkData.lastSyncError === 'string' || checkData.lastSyncError === null) {
          this.lastSyncError = checkData.lastSyncError;
        }
      }
    }
    const activeTable = await this.getActivePricingTable();
    const rawVersion = this.lastSyncedVersion || PRICING_METADATA.version;
    const effectiveVersion = /^\d{4}-\d{2}-\d{2}$/.test(rawVersion)
      && /^\d{4}-\d{2}-\d{2}$/.test(PRICING_METADATA.version)
      && rawVersion < PRICING_METADATA.version
      ? PRICING_METADATA.version
      : rawVersion;
    const effectiveCheckAt = Math.max(this.lastCheckAt, this.lastRemoteSyncAt);
    return {
      autoSyncEnabled: this.autoRemotePricingSync,
      lastSyncAt: this.lastRemoteSyncAt,
      lastCheckAt: effectiveCheckAt,
      lastSyncSuccess: this.lastSyncSuccess,
      lastCheckSuccess: this.lastCheckAt ? this.lastCheckSuccess : this.lastSyncSuccess,
      lastSyncError: this.lastSyncError,
      feedVersion: effectiveVersion,
      sourceUrl: this.lastSyncedSourceUrl || this.remotePricingUrl,
      modelCount: Object.keys(activeTable).length,
    };
  }

  async savePricingTable(table: Record<string, ApiPricing | ApiPricingInterval[]>): Promise<void> {
    await atomicJson(this.pricingCachePath, this.validateRawPrices(table));
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

  /** Use the bundled read-only driver; batches share the caller's transaction. */
  private async querySqlite(dbPath: string, sql: string, signal?: AbortSignal, reader?: SqliteReadSnapshot): Promise<{ ok: boolean; rows: any[]; error?: string }> {
    if(reader)return reader.query(sql);
    const owned = new SqliteReadSnapshot(dbPath, signal);
    try { return await owned.query(sql); } finally { await owned.close(); }
  }

  private discoveredStats = new Map<string, { mtimeMs: number; size: number; walMtimeMs: number; walSize: number; at: number }>();

  /**
   * 发现全部会话数据库；修改时间仅决定读取顺序，默认不截断统计范围。
   */
  async discoverDatabaseFiles(maxFiles = Number.POSITIVE_INFINITY): Promise<string[]> {
    this.discoveryErrors=[];
    const issue=(path:string,error:unknown)=>this.discoveryErrors.push({id:createHash('sha256').update(path).digest('hex').slice(0,10),state:'discovery_failed',category:(error as NodeJS.ErrnoException).code==='EACCES'?'目录访问受限':'数据库发现失败'});
    const list: { path: string; mtime: number }[] = [];
    const now = Date.now();
    this.discoveredStats.clear();
    const allowedDirs = new Set<string>(this.dataDirectoryNames);
    try {
      const entries = await readdir(this.geminiDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !allowedDirs.has(entry.name)) continue;
        const convDir = join(this.geminiDir, entry.name, 'conversations');
        try {
          const convFiles = await readdir(convDir);
          const fileSet = new Set(convFiles);
          const dbFiles = convFiles.filter(f => f.endsWith('.db'));
          const batchSize = 32;
          for (let i = 0; i < dbFiles.length; i += batchSize) {
            const slice = dbFiles.slice(i, i + batchSize);
            await Promise.all(slice.map(async file => {
              const fullPath = join(convDir, file);
              try {
                const st = await lstat(fullPath);
                if (!st.isFile() || st.isSymbolicLink()) return;
                const wal = fileSet.has(file + '-wal') ? await lstat(fullPath + '-wal').catch(() => null) : null;
                const walMtimeMs = wal?.mtimeMs ?? 0;
                const walSize = wal?.size ?? 0;
                this.discoveredStats.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, walMtimeMs, walSize, at: now });
                list.push({ path: fullPath, mtime: Math.max(st.mtimeMs, walMtimeMs) });
              } catch (error) { issue(fullPath, error); }
            }));
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') issue(convDir,error); }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') issue(this.geminiDir,error); }

    // 检查归档库
    for (const dirName of this.dataDirectoryNames) {
      const archivePath = join(this.geminiDir, dirName, 'token_usage_archive.db');
      try {
        const st = await lstat(archivePath);
        if (st.isFile() && !st.isSymbolicLink()) {
          this.discoveredStats.set(archivePath, { mtimeMs: st.mtimeMs, size: st.size, walMtimeMs: 0, walSize: 0, at: now });
          list.push({ path: archivePath, mtime: st.mtimeMs });
        }
      } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT'&&(error as NodeJS.ErrnoException).code!=='ENOTDIR')issue(archivePath,error); }
    }

    list.sort((a, b) => b.mtime - a.mtime);
    this.lastDiscoveredDatabaseCount = list.length;
    return list.slice(0, maxFiles).map(x => x.path);
  }

  private async blobRows(dbPath: string, table: 'gen_metadata' | 'steps', column: 'data' | 'metadata', where: string, onRows?: (rows: any[]) => void, knownIndex?: any[], signal?: AbortSignal, reader?: SqliteReadSnapshot): Promise<{ ok: boolean; rows: any[]; error?: string }> {
    const index = knownIndex ? { ok: true, rows: knownIndex } : await this.querySqlite(dbPath, `SELECT idx, length(${column}) as size FROM ${table} WHERE ${where} ORDER BY idx;`, signal, reader);
    if (!index.ok) return index;
    const result: any[] = [];
    let batch: any[] = [], bytes = 0;
    const flush = async () => {
      signal?.throwIfAborted();
      if (!batch.length) return;
      const ids = batch.map(row => Number(row.idx)).filter(Number.isSafeInteger);
      if (ids.length !== batch.length) throw new Error('数据库记录索引格式不支持');
      const reply = await this.querySqlite(dbPath, `SELECT idx, length(${column}) as size, ${column} as data_blob FROM ${table} WHERE idx IN (${ids.join(',')}) ORDER BY idx;`, signal, reader);
      if (!reply.ok) throw new Error(reply.error);
      if (onRows) onRows(reply.rows); else result.push(...reply.rows);
      batch = []; bytes = 0;
    };
    try {
      for (const row of index.rows) {
        if (row.size > 16777216) {
          await flush();
          const projected=reader?await reader.projectBlob(table,column,Number(row.idx)):null;
          const value=projected?.ok?projected.rows[0]:{...row,data_hex:''};
          if(onRows)onRows([value]);else result.push(value);continue;
        }
        if (batch.length >= 200 || (bytes + row.size > 2 * 1024 * 1024 && batch.length)) await flush();
        batch.push(row); bytes += Number(row.size) || 0;
      }
      await flush();
      result.sort((a,b) => Number(a.idx)-Number(b.idx));
      return { ok: true, rows: result };
    } catch (error) { return { ok: false, rows: [], error: (error as Error).message }; }
  }

  private isTransientSqliteReadError(message = ''): boolean {
    return /跨批读取期间变化|busy|locked|no such table|连接已关闭|超出单批预算|unable to open/i.test(message);
  }

  private async isInitializingOrRemovedDb(dbPath: string, errorMessage = ''): Promise<boolean> {
    const stat = await lstat(dbPath).catch((err: NodeJS.ErrnoException) => (err?.code === 'ENOENT' ? null : undefined));
    if (stat === null) return true;
    if (stat && /no such table/i.test(errorMessage) && (stat.size <= 4096 || Date.now() - stat.mtimeMs < 60_000)) {
      return true;
    }
    return false;
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
    let lastResult = await this.scanDatabaseEventsOnce(dbPath, bypassCache, signal);
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (!lastResult.hasError || signal?.aborted || !this.isTransientSqliteReadError(lastResult.error)) break;
      await new Promise(resolve => setTimeout(resolve, attempt * 100));
      if (signal?.aborted) break;
      lastResult = await this.scanDatabaseEventsOnce(dbPath, true, signal);
    }
    if (lastResult.hasError && !signal?.aborted && await this.isInitializingOrRemovedDb(dbPath, lastResult.error)) {
      const cached = this.fileCache.get(dbPath);
      return {
        events: cached?.events ?? [],
        generationsScanned: cached?.generationsScanned ?? 0,
        skippedLargeRecords: cached?.skippedLargeRecords ?? 0,
        hasError: false,
        usedCached: Boolean(cached),
      };
    }
    return lastResult;
  }

  private async scanDatabaseEventsOnce(dbPath: string, bypassCache = false, signal?: AbortSignal): Promise<{
    events: GenerationEvent[];
    generationsScanned: number;
    skippedLargeRecords: number;
    hasError?: boolean;
    error?: string;
    usedCached?: boolean;
    cacheHit?: boolean;
  }> {
    let fileStat: any = null;
    let walStat: any = null;
    let sourceId = '';
    try {
      this.discoveredStats.delete(dbPath);
      fileStat = await lstat(dbPath);
      sourceId = createHash('sha256').update(JSON.stringify([basename(dbPath), fileStat.dev, fileStat.ino, fileStat.birthtimeMs])).digest('hex');
      try { walStat = await lstat(`${dbPath}-wal`); } catch {}
      if (!bypassCache) {
        const cached = this.fileCache.get(dbPath);
        if (
          cached && cached.events.every(event => event.source_id === sourceId) &&
          cached.mtimeMs === fileStat.mtimeMs &&
          cached.size === fileStat.size &&
          cached.walMtimeMs === (walStat?.mtimeMs ?? 0) &&
          cached.walSize === (walStat?.size ?? 0)
        ) {
          return {
            events: cached.events,
            generationsScanned: cached.generationsScanned,
            skippedLargeRecords: cached.skippedLargeRecords,
            hasError: cached.hasError ?? false, error: cached.error,
            cacheHit: true,
          };
        }
      }
    } catch {
      // ignore
    }

    const reader=new SqliteReadSnapshot(dbPath,signal);
    try {
    // 1. Read lengths first, then bounded binary batches without hexadecimal expansion.
    const genRes = await this.querySqlite(dbPath, 'SELECT idx, length(data) as size FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx;', signal, reader);

    if (!genRes.ok) {
      // 数据库损坏或查询失败：保留历史有效缓存并标记错误，绝不伪造成真实零
      const cached = this.fileCache.get(dbPath);
      if (cached) {
        return {
          events: cached.events,
          generationsScanned: cached.generationsScanned,
          skippedLargeRecords: cached.skippedLargeRecords,
          hasError: true,
          error: genRes.error, usedCached: true,
        };
      }
      return {
        events: [],
        generationsScanned: 0,
        skippedLargeRecords: 0,
        hasError: true,
        error: genRes.error,
      };
    }

    const genRows = genRes.rows;
    if (genRows.length > 50_000) {
      const cached = this.fileCache.get(dbPath);
      return { events: cached?.events ?? [], generationsScanned: 0, skippedLargeRecords: genRows.length,
        hasError: true, usedCached: !!cached, error: '单库生成记录超过有界读取预算；已保留已有账本，请分批归档后重试' };
    }
    const events: GenerationEvent[] = [];
    let generationsScanned = 0;
    let skippedLargeRecords = 0;
    if (genRows.length === 0) {
      if (fileStat) {
        this.fileCache.set(dbPath, {
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
          walMtimeMs: walStat?.mtimeMs ?? 0,
          walSize: walStat?.size ?? 0,
          events: [],
          generationsScanned: 0,
          skippedLargeRecords: 0,
          hasError: false,
          lastSuccessAt: Math.floor(Date.now() / 1000),
        });
        this.fileCacheDirty = true;
      }
      return { events: [], generationsScanned: 0, skippedLargeRecords: 0, hasError: false };
    }

    const validTimestamp=(value:number)=>Number.isSafeInteger(value)&&value>=946684800&&value<=Date.now()/1000+86400;
    const pendingStepLinks: { event: GenerationEvent; indices: number[]; execution: Buffer | null; usage: Buffer }[] = [];
    const parseRows = (rows: any[]) => {
      for (const row of rows) {
      generationsScanned++;
      if (row.size > 16 * 1024 * 1024 && !row.projected) {
        // Skip oversized blobs > 16MB
        skippedLargeRecords++;
        continue;
      }
      if (!row.data_blob && !row.data_hex) continue;

      const blob = row.data_blob instanceof Uint8Array ? Buffer.from(row.data_blob.buffer, row.data_blob.byteOffset, row.data_blob.byteLength) : Buffer.from(row.data_hex, 'hex');
      const wrapped = ProtobufReader.findField(blob, 1);
      if (!wrapped) continue;

      const modelId = ProtobufReader.findString(wrapped, 19);
      const label = ProtobufReader.findString(wrapped, 21);
      const usage = ProtobufReader.findField(wrapped, 4);

      if (!usage) continue;
      // ModelUsageStats field 1 is the model enum, not token usage.
      const cacheWriteTokens = ProtobufReader.findVarint(usage, 4) ?? 0;
      const rawInput = ProtobufReader.findVarint(usage, 2) ?? 0;
      const outputTokens = ProtobufReader.findVarint(usage, 3) ?? 0;
      const cachedTokens = ProtobufReader.findVarint(usage, 5) ?? 0;
      const inputTokens = rawInput;
      const totalTokens = inputTokens + cachedTokens + cacheWriteTokens + outputTokens;

      if (totalTokens === 0) continue;

      let timestamp = 0;
      const timingBuf = ProtobufReader.findField(wrapped, 9);
      if (timingBuf) {
        const innerTiming = ProtobufReader.findField(timingBuf, 4);
        if (innerTiming) {
          timestamp = ProtobufReader.findVarint(innerTiming, 1) ?? 0;
        }
      }
      if(!validTimestamp(timestamp))timestamp=0;

      const assignedModel = resolveDatabaseModelFullName(modelId, label);
      const lockModelKey = modelId || label || '未知模型';

      // Only requests first observed after a positively observed identity can be attributed.
      // Unknown timestamps and pre-start history remain unknown, regardless of database mtime.
      const observedCtx = this.lookupObservedContext(timestamp);
      const canAttributeToCurrent = Boolean(observedCtx);
      const accountId = observedCtx?.id;
      const accountEmail = observedCtx?.email;
      const accountType = canAttributeToCurrent ? (observedCtx?.account_type ?? 'unknown') : undefined;
      const execution = ProtobufReader.findField(blob, 4)?.toString('hex') ?? '';
      const legacyKey = createHash('sha256').update(JSON.stringify([
        basename(dbPath), row.idx, execution || undefined, lockModelKey, rawInput, cachedTokens, cacheWriteTokens, outputTokens,
      ])).digest('hex');
      const eventObj: GenerationEvent = {
        event_key: createHash('sha256').update(JSON.stringify([
          sourceId, row.idx, execution,
        ])).digest('hex'),
        source_id: sourceId, generation_index: Number(row.idx), legacy_event_key: legacyKey,
        account_confidence: canAttributeToCurrent ? 'observed' : 'unknown',
        model: assignedModel,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_tokens: cachedTokens,
        ...(cacheWriteTokens>0?{cache_write_tokens:cacheWriteTokens}:{}),
        total_tokens: totalTokens,
        timestamp_seconds: timestamp,
        ...(accountId ? { account_id: accountId, account_email: accountEmail } : (accountEmail ? { account_email: accountEmail } : {})),
        ...(accountType ? { account_type: accountType } : {}),
      };
      if (timestamp === 0) {
        const indices = ProtobufReader.stepIndices(blob);
        if (indices !== null) {
          pendingStepLinks.push({ event: eventObj, indices, execution: ProtobufReader.findField(blob, 4), usage });
        }
      }
      events.push(eventObj);

    }
    };
    const dataRes = await this.blobRows(dbPath, 'gen_metadata', 'data', 'data IS NOT NULL', parseRows, genRows, signal, reader);
    if (!dataRes.ok) {
      const previous = this.fileCache.get(dbPath);
      return { events: previous?.events ?? events, generationsScanned, skippedLargeRecords, hasError: true, error: dataRes.error, usedCached: !!previous };
    }

    // 2. 仅当存在缺失内联时间戳的生成记录时，按需查询 steps 表（消除 99% 常规库的多余 PRAGMA + steps 查询）
    let stepOk = true;
    if (events.some(event => event.timestamp_seconds <= 0)) {
      const stepTimes=new Map<number,{timestamp:number;usage:Buffer|null;execution:Buffer|null}>();
      const stepSchema=await reader.query('PRAGMA table_info(steps);');
      const stepColumns=new Set(stepSchema.rows.map(row=>row.name));
      const stepRes = !stepSchema.ok || !['idx','metadata','step_type'].every(column=>stepColumns.has(column)) ? {ok:false,error:'时间表结构缺失或不支持',rows:[]} : await this.blobRows(dbPath, 'steps', 'metadata', 'step_type = 15', rows => {
        for (const row of rows) {
          const metaBuf = row.data_blob instanceof Uint8Array ? Buffer.from(row.data_blob.buffer, row.data_blob.byteOffset, row.data_blob.byteLength) : Buffer.from(row.data_hex || '', 'hex');
          const tsBuf = ProtobufReader.findField(metaBuf, 1);
          const rawTime=tsBuf?ProtobufReader.findVarint(tsBuf,1)??0:0;
          const timestamp=validTimestamp(rawTime)?rawTime:0;
          stepTimes.set(Number(row.idx),{timestamp,usage:ProtobufReader.findField(metaBuf,9),execution:ProtobufReader.findField(metaBuf,12)});
        }
      }, undefined, signal, reader);
      stepOk = stepRes.ok;
      if (stepRes.ok && pendingStepLinks.length > 0) {
        for (const item of pendingStepLinks) {
          const linked = item.indices.map(idx => stepTimes.get(idx)).filter((step): step is NonNullable<typeof step> => !!step);
          if (linked.length === 1 && item.execution && linked[0]!.execution?.equals(item.execution) && linked[0]!.usage?.equals(item.usage)) {
            item.event.timestamp_seconds = linked[0]!.timestamp;
            const obs = this.lookupObservedContext(item.event.timestamp_seconds);
            if (obs) {
              item.event.account_id = obs.id;
              item.event.account_email = obs.email;
              item.event.account_type = obs.account_type;
              item.event.account_confidence = 'observed';
            }
          }
        }
      }
    }

    const after = await lstat(dbPath).catch(() => null);
    if (!await reader.verifyUnchanged() || !after || after.dev !== fileStat?.dev || after.ino !== fileStat?.ino) {
      const previous = this.fileCache.get(dbPath);
      return { events: previous?.events ?? events, generationsScanned, skippedLargeRecords,
        hasError: true, usedCached: !!previous, error: '数据库在跨批读取期间变化，请重试' };
    }
    const observedAt = performance.timeOrigin + performance.now();
    for (const event of events) event.source_observed_at = observedAt;
    await this.loadUsageLedger();
    for (const event of events) {
      this.upsertLedger({ ...event, db_file: basename(dbPath) });
      Object.assign(event, this.usageLedgerEvents.get(event.event_key!));
    }
    const unknownTime = events.some(event => event.timestamp_seconds <= 0);
    const hasError = !stepOk && unknownTime;
    const timeError = hasError ? '时间信息读取失败，部分记录时间未知' : undefined;
    if (fileStat) {
      if (!this.fileCache.has(dbPath) && this.fileCache.size >= 2000) {
        const oldestKey = this.fileCache.keys().next().value;
        if (oldestKey) this.fileCache.delete(oldestKey);
      }
      let cachedEventCount = [...this.fileCache.values()].reduce((sum, value) => sum + value.events.length, 0);
      for (const [key, value] of this.fileCache) {
        if (cachedEventCount <= 50_000) break;
        if (key !== dbPath) { this.fileCache.delete(key); cachedEventCount -= value.events.length; }
      }
      this.fileCache.set(dbPath, {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        walMtimeMs: walStat?.mtimeMs ?? 0,
        walSize: walStat?.size ?? 0,
        events,
        generationsScanned,
        skippedLargeRecords, hasError, error: timeError, lastSuccessAt: hasError ? this.fileCache.get(dbPath)?.lastSuccessAt : Math.floor(Date.now()/1000),
      });
      if (!hasError) this.fileCacheDirty = true;
    }

    return { events, generationsScanned, skippedLargeRecords, hasError, error: timeError };
    } finally { await reader.close(); }
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
    const pricing = await this.getPricingTable(now);
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

    // 3. 统计事件中的 token 和 request
    for (const ev of allEvents) {
      const allOpt = accountMap.get('all')!;
      allOpt.total_tokens = (allOpt.total_tokens ?? 0) + ev.total_tokens;
      allOpt.request_count = (allOpt.request_count ?? 0) + 1;

      if (!ev.account_id && !ev.account_email) continue;

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

    effectiveEvents.sort((a, b) => a.timestamp_seconds - b.timestamp_seconds);
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const todayStart = Math.floor(todayDate.getTime() / 1000);
    const tomorrowDate = new Date(todayDate); tomorrowDate.setDate(tomorrowDate.getDate()+1);
    const tomorrowStart = Math.floor(tomorrowDate.getTime()/1000);

    // 7天与30天采用本地自然日零点边界，确保总量与每日趋势 100% 对账
    const sevenDaysDate = new Date(todayDate);
    sevenDaysDate.setDate(sevenDaysDate.getDate() - 6);
    const sevenDaysStart = Math.floor(sevenDaysDate.getTime() / 1000);

    const thirtyDaysDate = new Date(todayDate);
    thirtyDaysDate.setDate(thirtyDaysDate.getDate() - 29);
    const thirtyDaysStart = Math.floor(thirtyDaysDate.getTime() / 1000);

    const buildPeriod = (filterFn: (ev: GenerationEvent) => boolean): TokenUsagePeriod => {
      const filtered = effectiveEvents.filter(filterFn);
      const modelMap = new Map<string, { in: number; out: number; cached: number; write: number; total: number; count: number; cost: number; unpricedTokens: number }>();
      let totalIn = 0;
      let totalOut = 0;
      let totalCached = 0;
      let totalWrite = 0;
      let totalAll = 0;
      let totalCount = filtered.length;
      let periodUsd = 0;

      for (const ev of filtered) {
        totalIn += ev.input_tokens;
        totalOut += ev.output_tokens;
        totalCached += ev.cached_tokens;
        totalWrite += ev.cache_write_tokens ?? 0;
        totalAll += ev.total_tokens;

        const mKey = ev.model;
        const entry = modelMap.get(mKey) ?? { in: 0, out: 0, cached: 0, write: 0, total: 0, count: 0, cost: 0, unpricedTokens: 0 };
        entry.in += ev.input_tokens;
        entry.out += ev.output_tokens;
        entry.cached += ev.cached_tokens;
        entry.write += ev.cache_write_tokens ?? 0;
        entry.total += ev.total_tokens;
        entry.count++;

        const evPrice = this.resolvePricing(rawPricing, mKey, ev.timestamp_seconds);
        const evCost = this.lockedCost(ev, evPrice);
        if (evCost !== null) {
          entry.cost += evCost;
          periodUsd += evCost;
        } else {
          entry.unpricedTokens += ev.total_tokens;
        }
        modelMap.set(mKey, entry);
      }

      const byModel: ModelTokenUsage[] = [];
      let pricedCount = 0;
      let unpricedCount = 0;

      for (const [mName, stats] of modelMap.entries()) {
        const currentPrice = this.resolvePricing(rawPricing, mName, now);
        const canonicalKey = matchPricingKeys(mName);
        const isPriced = stats.unpricedTokens === 0;
        if (isPriced || stats.cost > 0) {
          if (isPriced) pricedCount++; else unpricedCount++;
          const mUsd = Math.round(stats.cost * 1e8) / 1e8;
          byModel.push({
            model: mName,
            input_tokens: stats.in,
            output_tokens: stats.out,
            cached_tokens: stats.cached,
            ...(stats.write > 0 ? { cache_write_tokens: stats.write } : {}),
            total_tokens: stats.total,
            request_count: stats.count,
            estimated_usd: mUsd,
            priced: isPriced,
            partiallyPriced: !isPriced,
            unpriced_tokens: stats.unpricedTokens,
            pricingKey: canonicalKey || mName,
            pricingStatus: currentPrice ? priceStatus(currentPrice, now * 1000) : 'historical',
            pricingProvenance: currentPrice?.provenance ?? null,
          });
        } else {
          unpricedCount++;
          byModel.push({
            model: mName,
            input_tokens: stats.in,
            output_tokens: stats.out,
            cached_tokens: stats.cached,
            ...(stats.write > 0 ? { cache_write_tokens: stats.write } : {}),
            total_tokens: stats.total,
            request_count: stats.count,
            estimated_usd: 0,
            priced: false,
            unpriced_tokens: stats.unpricedTokens,
          });
        }
      }

      byModel.sort((a, b) => b.total_tokens - a.total_tokens);

      return {
        totals: {
          input_tokens: totalIn,
          output_tokens: totalOut,
          cached_tokens: totalCached,
          ...(totalWrite > 0 ? { cache_write_tokens: totalWrite } : {}),
          total_tokens: totalAll,
          request_count: totalCount,
        },
        estimated_usd: Math.round(periodUsd * 1e8) / 1e8,
        by_model: byModel,
        priced_models: pricedCount,
        unpriced_models: unpricedCount,
      };
    };

    // 今日按小时统计（仅记录今日产生消耗的小时桶，无消耗时为空）
    const hourlyMap = new Map<string, HourlyTokenUsage>();

    // 连续自然日零值序列（至少覆盖近 30 天，若存在更早事件则从最早日期连续补齐至今日，最长回溯 365 天，杜绝全部周期断档）
    const dailyMap = new Map<string, DailyTokenUsage>();
    let earliestStartDate = new Date(thirtyDaysDate);
    const maxBackfillDate = new Date(todayDate);
    maxBackfillDate.setDate(maxBackfillDate.getDate() - 365);
    for (const ev of effectiveEvents) {
      if (ev.timestamp_seconds > 0) {
        const evDay = new Date(ev.timestamp_seconds * 1000);
        evDay.setHours(0, 0, 0, 0);
        const clamped = evDay < maxBackfillDate ? maxBackfillDate : evDay;
        if (clamped < earliestStartDate) earliestStartDate = clamped;
        break;
      }
    }
    for (let cur = new Date(earliestStartDate); cur <= todayDate; cur.setDate(cur.getDate() + 1)) {
      const curStr = formatLocalDate(cur);
      dailyMap.set(curStr, {
        date: curStr,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 0,
        request_count: 0,
      });
    }

    for (const ev of effectiveEvents) {
      if (ev.timestamp_seconds <= 0) continue; // 排除未知时间戳，不污染每日和每小时统计
      const d = new Date(ev.timestamp_seconds * 1000);
      const dateStr = formatLocalDate(d);

      // Daily: 严格采用本地自然日对齐
      if (ev.timestamp_seconds > 0) {
        const dEntry = dailyMap.get(dateStr) ?? {
          date: dateStr,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          total_tokens: 0,
          request_count: 0,
        };
        dEntry.input_tokens += ev.input_tokens;
        dEntry.output_tokens += ev.output_tokens;
        dEntry.cached_tokens += ev.cached_tokens;
        if(ev.cache_write_tokens)dEntry.cache_write_tokens=(dEntry.cache_write_tokens??0)+ev.cache_write_tokens;
        dEntry.total_tokens += ev.total_tokens;
        dEntry.request_count++;
        dailyMap.set(dateStr, dEntry);
      }

      // Hourly: 严格归入本地今日 0 点起的小时桶
      if (ev.timestamp_seconds >= todayStart && ev.timestamp_seconds < tomorrowStart) {
        const hourStr = `${dateStr} ${String(d.getHours()).padStart(2, '0')}:00`;
        const hEntry = hourlyMap.get(hourStr) ?? {
          hour: hourStr,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          total_tokens: 0,
          request_count: 0,
        };
        hEntry.input_tokens += ev.input_tokens;
        hEntry.output_tokens += ev.output_tokens;
        hEntry.cached_tokens += ev.cached_tokens;
        if(ev.cache_write_tokens)hEntry.cache_write_tokens=(hEntry.cache_write_tokens??0)+ev.cache_write_tokens;
        hEntry.total_tokens += ev.total_tokens;
        hEntry.request_count++;
        hourlyMap.set(hourStr, hEntry);
      }
    }

    const totalDiscovered = (this.lastDiscoveredDatabaseCount || dbPaths.length) + archivedDbCount;
    const totalScanned = dbPaths.length + archivedDbCount;
    const allTimePeriod = buildPeriod(() => true);
    const knownReceiptKeys = new Set(allEvents.flatMap(event => [event.event_key, event.legacy_event_key].filter((key): key is string => !!key)));
    const unmatchedReceipts = Object.entries(this.rateLocks).filter(([key]) => !knownReceiptKeys.has(key));
    if (unmatchedReceipts.length) this.storageWarnings.add('历史金额凭据缺少原始用量或时间，已单独保留待核对，不计入Token和请求数');
    const summary: TokenUsageSummary = {
      today: buildPeriod(ev => ev.timestamp_seconds >= todayStart && ev.timestamp_seconds < tomorrowStart),
      last_7_days: buildPeriod(ev => ev.timestamp_seconds >= sevenDaysStart && ev.timestamp_seconds < tomorrowStart),
      last_30_days: buildPeriod(ev => ev.timestamp_seconds >= thirtyDaysStart && ev.timestamp_seconds < tomorrowStart),
      all_time: allTimePeriod,
      unattributed_requests: allEvents.filter(event => !event.account_id && !event.account_email).length,
      unattributed_tokens: allEvents.filter(event => !event.account_id && !event.account_email).reduce((sum, event) => sum + event.total_tokens, 0),
      historical_amount_receipts: { unmatchedCount: unmatchedReceipts.length, unmatchedUsd: unmatchedReceipts.reduce((sum, [, receipt]) => sum + receipt.usd, 0) },
      daily_trends: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
      today_hourly: [...hourlyMap.values()].sort((a, b) => a.hour.localeCompare(b.hour)),
      available_accounts: [...accountMap.values()],
      selected_account_id: accountId || 'all',
      databases_scanned: totalScanned,
      databases_discovered: totalDiscovered,
      scan_scope_description: totalDiscovered > totalScanned
        ? `已读取 ${totalScanned}/${totalDiscovered} 个会话数据库`
        : archivedDbCount > 0
          ? `全部 ${totalScanned} 个会话数据库（含 ${archivedDbCount} 个已归档）`
          : `全部 ${dbPaths.length} 个会话数据库`,
      generations_scanned: generationsScanned,
      skipped_large_records: skippedLargeRecords,
      generated_at: now,
      priced_models: allTimePeriod.priced_models,
      unpriced_models: allTimePeriod.unpriced_models,
      failed_databases_count: failedDatabasesCount,
      has_error: this.ledgerCorrupt || this.archivedUnavailable || failedDatabasesCount > 0 || skippedLargeRecords > 0 || effectiveEvents.some(e=>e.timestamp_seconds<=0),
      hasError: this.ledgerCorrupt || this.archivedUnavailable || failedDatabasesCount > 0 || skippedLargeRecords > 0 || effectiveEvents.some(e=>e.timestamp_seconds<=0),
      availability: (failedDatabasesCount > 0 && effectiveEvents.length === 0) || (failedDatabasesCount >= dbPaths.length && dbPaths.length > 0 && liveEventsCount === 0) ? 'unavailable'
        : cachedDatabasesCount === dbPaths.length && dbPaths.length > 0 ? 'cached' : this.storageWarnings.size > 0 || failedDatabasesCount > 0 || skippedLargeRecords > 0 || effectiveEvents.some(e=>e.timestamp_seconds<=0) ? 'partial' : 'complete',
      unknown_time_records: effectiveEvents.filter(e=>e.timestamp_seconds<=0).length,
      unknown_time_tokens: effectiveEvents.filter(e=>e.timestamp_seconds<=0).reduce((n,e)=>n+e.total_tokens,0),
      database_diagnostics: diagnostics,
      snapshot_id: (() => {
        const hash = createHash('sha256');
        hash.update(`account:${accKey}\n`);
        for (const ev of allEvents) {
          hash.update(`${ev.model}|${ev.timestamp_seconds}|${ev.input_tokens}|${ev.output_tokens}|${ev.cached_tokens}|${ev.cache_write_tokens ?? 0}|${ev.total_tokens}\n`);
          hash.update(`locked-cost:${ev.event_key ? this.rateLocks[ev.event_key]?.usd ?? 'unpriced' : 'unpriced'}\n`);
        }
        hash.update(JSON.stringify([pricing, this.calendarKey()]));
        return hash.digest('hex').slice(0, 20);
      })(),
      last_attempt_at: now,
      pricing_warnings: [...this.pricingWarnings, ...this.storageWarnings],
    };

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
