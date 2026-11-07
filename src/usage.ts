import { ALLOWED_DATA_DIRECTORY_NAMES, type DataDirectoryName } from './application-target.js';
import { MODEL_PRICES, MODEL_PRICE_ALIASES } from './model-catalog.js';
import { SqliteReadSnapshot } from './sqlite-read.js';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { atomicJson } from './files.js';
import { createHash } from 'node:crypto';
import { APP_VERSION } from './version.js';

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
}

export interface ApiPricing {
  model: string;
  input: number;  // 每 1M Tokens 美元
  output: number; // 每 1M Tokens 美元
  cached: number; // 每 1M Tokens 美元
  cacheWrite?: number;
  provenance?: {sourceUrl?:string; platform?:string; conditions?:string; checkedAt?:string|null; validFrom?:string|null; validUntil?:string|null; verification?:'confirmed'|'historical'|'user'};
  intervals?: ApiPricingInterval[];
}

export interface ApiPricingInterval {
  model?: string;
  validFrom?: string | null;
  validUntil?: string | null;
  input: number;
  output: number;
  cached: number;
  cacheWrite?: number;
  provenance?: {sourceUrl?:string; platform?:string; conditions?:string; checkedAt?:string|null; validFrom?:string|null; validUntil?:string|null; verification?:'confirmed'|'historical'|'user'};
}

export type ApiPricingEntry = ApiPricing | ApiPricingInterval[];

export function resolvePricingForTimestamp(
  entry: ApiPricingEntry | undefined,
  timestampSeconds: number,
  fallbackModelName = ''
): ApiPricing | null {
  if (!entry) return null;
  const intervals: ApiPricingInterval[] | null = Array.isArray(entry)
    ? entry
    : (entry.intervals && Array.isArray(entry.intervals) && entry.intervals.length > 0)
    ? entry.intervals
    : null;

  if (!intervals) {
    if (Array.isArray(entry)) return null;
    return entry;
  }
  if (intervals.length === 0) return null;

  const eventMs = timestampSeconds > 0 ? timestampSeconds * 1000 : Date.now();

  let match: ApiPricingInterval | null = null;
  for (const interval of intervals) {
    const fromMs = interval.validFrom ? Date.parse(interval.validFrom) : Number.NEGATIVE_INFINITY;
    const untilMs = interval.validUntil ? Date.parse(interval.validUntil) : Number.POSITIVE_INFINITY;
    if (eventMs >= fromMs && eventMs <= untilMs) {
      match = interval;
      break;
    }
  }

  if (!match) {
    let earliest = intervals[0]!;
    let latest = intervals[intervals.length - 1]!;
    let minFrom = earliest.validFrom ? Date.parse(earliest.validFrom) : Number.POSITIVE_INFINITY;
    let maxUntil = latest.validUntil ? Date.parse(latest.validUntil) : Number.NEGATIVE_INFINITY;
    for (const item of intervals) {
      const f = item.validFrom ? Date.parse(item.validFrom) : Number.NEGATIVE_INFINITY;
      const u = item.validUntil ? Date.parse(item.validUntil) : Number.POSITIVE_INFINITY;
      if (f < minFrom) { minFrom = f; earliest = item; }
      if (u > maxUntil) { maxUntil = u; latest = item; }
    }
    match = eventMs < minFrom ? earliest : latest;
  }

  return {
    model: match.model ?? fallbackModelName ?? (!Array.isArray(entry) ? entry.model : ''),
    input: match.input,
    output: match.output,
    cached: match.cached,
    ...(match.cacheWrite !== undefined ? { cacheWrite: match.cacheWrite } : {}),
    provenance: match.provenance ?? (!Array.isArray(entry) ? entry.provenance : undefined),
    ...(entry && !Array.isArray(entry) && entry.intervals ? { intervals: entry.intervals } : {}),
  };
}

export interface GenerationEvent {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  timestamp_seconds: number;
}

/**
 * 官方内置基准单价表 (每 1,000,000 Tokens 美元)
 * 来源：Google Cloud Vertex AI & Anthropic 官方定价文档 (标准上下文 <= 128k Tokens)
 * 审计基准日期：2026-11-02
 */
export const PRICING_METADATA = {
  version: '2026-11-02',
  sourceUrl: 'https://cloud.google.com/vertex-ai/pricing',
  effectiveDate: '2026-11-01',
  currency: 'USD',
  conditions: 'List prices for standard context tier, input caching enabled, per million tokens',
};

export const DEFAULT_API_PRICES: Record<string, ApiPricingEntry> = MODEL_PRICES;
export function priceStatus(price: ApiPricing | ApiPricingInterval[], now=Date.now()) {
  const p = Array.isArray(price) ? resolvePricingForTimestamp(price, Math.floor(now / 1000)) : price;
  if (!p) return 'historical';
  if(p.provenance?.validUntil&&Date.parse(p.provenance.validUntil)<now)return 'expired';
  return p.provenance?.verification==='confirmed'?'confirmed':p.provenance?.verification==='user'?'user':'historical';
}

/**
 * 纯 TypeScript Protobuf 基础解码工具
 */
export class ProtobufReader {
  /** Field 2 of CortexStepGeneratorMetadata is repeated uint32 step_indices. */
  static stepIndices(buf:Buffer):number[]|null {
    let offset=0,present=false;const result:number[]=[];
    const valid=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=0xffffffff;
    while(offset<buf.length){
      const tag=this.readVarint(buf,offset);if(!tag||!valid(tag[0])||!tag[0])return[];
      const field=tag[0]>>>3,wire=tag[0]&7;offset=tag[1];
      if(wire===0){const value=this.readVarint(buf,offset);if(!value)return[];offset=value[1];if(field===2){present=true;if(!valid(value[0]))return[];result.push(value[0]);}}
      else if(wire===2){const length=this.readVarint(buf,offset);if(!length||!Number.isSafeInteger(length[0])||length[0]<0)return[];offset=length[1];const end=offset+length[0];if(end>buf.length)return[];
        if(field===2){present=true;while(offset<end){const v=this.readVarint(buf.subarray(0,end),offset);if(!v||!valid(v[0])||result.length>=10000)return[];result.push(v[0]);offset=v[1];}}
        offset=end;
      } else if(wire===1)offset+=8;else if(wire===5)offset+=4;else return[];
      if(offset>buf.length)return[];
    }
    return present?[...new Set(result)]:null;
  }
  static readVarint(buf: Buffer, offset: number): [number, number] | null {
    let result = 0;
    let shift = 0;
    let pos = offset;

    while (pos < buf.length) {
      const byte = buf[pos++]!;
      result += (byte & 0x7f) * Math.pow(2, shift);
      shift += 7;
      if ((byte & 0x80) === 0) {
        return [Math.round(result), pos];
      }
    }
    return null;
  }

  static findField(buf: Buffer, targetField: number): Buffer | null {
    let offset = 0;
    while (offset < buf.length) {
      const v = this.readVarint(buf, offset);
      if (!v) break;
      const [tag, newOffset] = v;
      const wireType = tag & 0x07;
      const fieldNum = tag >>> 3;

      if (wireType === 2) {
        // Length-delimited
        const lenInfo = this.readVarint(buf, newOffset);
        if (!lenInfo) break;
        const [length, contentOffset] = lenInfo;
        const end = contentOffset + length;
        if (end > buf.length) break;

        if (fieldNum === targetField) {
          return buf.subarray(contentOffset, end);
        }
        offset = end;
      } else if (wireType === 0) {
        // Varint
        const val = this.readVarint(buf, newOffset);
        if (!val) break;
        offset = val[1];
      } else if (wireType === 1) {
        // 64-bit
        offset = newOffset + 8;
      } else if (wireType === 5) {
        // 32-bit
        offset = newOffset + 4;
      } else {
        break;
      }
    }
    return null;
  }

  static findVarint(buf: Buffer, targetField: number): number | null {
    let offset = 0;
    while (offset < buf.length) {
      const v = this.readVarint(buf, offset);
      if (!v) break;
      const [tag, newOffset] = v;
      const wireType = tag & 0x07;
      const fieldNum = tag >>> 3;

      if (wireType === 0) {
        const val = this.readVarint(buf, newOffset);
        if (!val) break;
        if (fieldNum === targetField) {
          return val[0];
        }
        offset = val[1];
      } else if (wireType === 2) {
        const lenInfo = this.readVarint(buf, newOffset);
        if (!lenInfo) break;
        offset = lenInfo[1] + lenInfo[0];
      } else if (wireType === 1) {
        offset = newOffset + 8;
      } else if (wireType === 5) {
        offset = newOffset + 4;
      } else {
        break;
      }
    }
    return null;
  }

  static findString(buf: Buffer, targetField: number): string | null {
    const fieldBuf = this.findField(buf, targetField);
    if (!fieldBuf) return null;
    return fieldBuf.toString('utf8').trim() || null;
  }
}

const SORTED_DEFAULT_PRICE_KEYS = Object.keys(DEFAULT_API_PRICES).sort((a, b) => b.length - a.length);

/**
 * 模型价格归一化匹配算法
 */
export function matchPricingKeys(modelName: string): string {
  if (!modelName || modelName.includes('未知模型') || modelName.toLowerCase().includes('unknown')) {
    return '';
  }
  if (Object.hasOwn(MODEL_PRICE_ALIASES,modelName)) return MODEL_PRICE_ALIASES[modelName]!;
  let lower = modelName.toLowerCase().trim();
  // 先将所有非字母数字和小数点的字符统一替换为 '-'，并去除首尾连字符
  lower = lower.replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');



  // Only audited aliases may inherit a public base price. Custom/experimental suffixes stay unknown.
  lower = lower
    .replace(/^claude-3\.([57])-/, 'claude-3-$1-')
    .replace(/^claude-4\.6-opus/, 'claude-opus-4-6')
    .replace(/^claude-4\.6-sonnet/, 'claude-sonnet-4-6')
    .replace(/^claude-5\.5-opus/, 'claude-opus-5-5')
    .replace(/^claude-5\.5-sonnet/, 'claude-sonnet-5-5');
  for (const key of SORTED_DEFAULT_PRICE_KEYS) {
    if (lower === key) return key;
    if (lower.startsWith(key + '-') && /^(?:extra-low|high|medium|low|thinking|latest|\d{8}|\d{4}-\d{2}-\d{2})(?:-thinking)?$/.test(lower.slice(key.length + 1))) return key;
  }

  return lower;
}

export function calculateEstimatedUsd(
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
  pricing: ApiPricing | ApiPricingInterval[],
  cacheWriteTokens = 0
): number {
  let resolvedPricing: ApiPricing;
  if (Array.isArray(pricing)) {
    const r = resolvePricingForTimestamp(pricing, Math.floor(Date.now() / 1000));
    if (!r) throw Error('用量或费率无效');
    resolvedPricing = r;
  } else {
    resolvedPricing = pricing;
  }
  if (cacheWriteTokens > 0 && (!Number.isFinite(resolvedPricing.cacheWrite) || resolvedPricing.cacheWrite! < 0)) throw new Error('缓存写入费率未配置');
  if (![inputTokens,outputTokens,cachedTokens,cacheWriteTokens,resolvedPricing.input,resolvedPricing.output,resolvedPricing.cached].every(n=>Number.isFinite(n)&&n>=0)) throw Error('用量或费率无效');
  const cost =
    (inputTokens * resolvedPricing.input +
      outputTokens * resolvedPricing.output +
      cachedTokens * resolvedPricing.cached + cacheWriteTokens * (resolvedPricing.cacheWrite ?? 0)) /
    1_000_000;
  // 保留高精度（8位小数），绝不在微量费用（如 1 Token 或微小调用）时过早四舍五入为 0
  return Math.round(cost * 1e8) / 1e8;
}

export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class UsageStatsManager {
  private geminiDir: string;
  private dataDirectoryNames: readonly DataDirectoryName[];
  private pricingCachePath: string;
  private cachedSummary: { data: TokenUsageSummary; expiresAt: number } | null = null;
  public lastDiscoveredDatabaseCount = 0;
  private inFlight?: Promise<TokenUsageSummary>;
  private inFlightForced = false;
  private pendingForced?: Promise<TokenUsageSummary>;
  private discoveryErrors: NonNullable<TokenUsageSummary['database_diagnostics']> = [];
  private periodKey = '';
  private pricingWarnings:string[]=[];
  private snapshots = new Map<string,{events:GenerationEvent[];prices:Record<string,ApiPricing>;rawPricing:Record<string,ApiPricingEntry>;summary:TokenUsageSummary;expires:number; pins:number}>();
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
  private lastAggregationKey = '';
  private remotePricingCachePath: string;
  private remotePricingUrl: string;
  private autoRemotePricingSync: boolean;
  private lastRemoteSyncAt = 0;

  constructor(options?: { geminiDir?: string; stateDir?: string; remotePricingUrl?: string; dataDirectoryName?: DataDirectoryName }) {
    const defaultGeminiDir = join(homedir(), '.gemini');
    const defaultStateDir = join(homedir(), 'Library', 'Application Support', 'GravityBox');
    this.geminiDir = options?.geminiDir ?? defaultGeminiDir;
    if (options?.dataDirectoryName && !ALLOWED_DATA_DIRECTORY_NAMES.includes(options.dataDirectoryName)) throw new Error('仅统计 Antigravity 正式版用量');
    this.dataDirectoryNames = options?.dataDirectoryName ? [options.dataDirectoryName] : ALLOWED_DATA_DIRECTORY_NAMES;
    const stateDir = options?.stateDir ?? defaultStateDir;
    this.pricingCachePath = join(stateDir, 'api_pricing.json');
    this.remotePricingCachePath = join(stateDir, 'remote_pricing.json');
    this.remotePricingUrl = options?.remotePricingUrl ?? process.env.GRAVITYBOX_PRICING_FEED_URL ?? 'https://raw.githubusercontent.com/Enzoo404/gravitybox/main/assets/pricing-feed.json';
    this.autoRemotePricingSync = Boolean(options?.remotePricingUrl || (this.geminiDir === defaultGeminiDir && stateDir === defaultStateDir));
    if (this.geminiDir === defaultGeminiDir && stateDir === defaultStateDir) {
      const cacheTag = options?.dataDirectoryName ?? 'antigravity';
      this.persistCachePath = join(homedir(), 'Library', 'Caches', 'GravityBox', `usage-db-cache-${cacheTag}-v1.json`);
    }
  }

  setDataDirectoryName(name?: DataDirectoryName): void {
    if (name && !ALLOWED_DATA_DIRECTORY_NAMES.includes(name)) throw new Error('仅统计 Antigravity 正式版用量');
    const nextNames = name ? [name] : ALLOWED_DATA_DIRECTORY_NAMES;
    if (this.dataDirectoryNames.join(',') === nextNames.join(',')) return;
    this.cancelRead();
    this.dataDirectoryNames = nextNames;
    this.cachedSummary = null;
    this.lastAggregationKey = '';
    this.discoveredStats.clear();
    const defaultGeminiDir = join(homedir(), '.gemini');
    const defaultStateDir = join(homedir(), 'Library', 'Application Support', 'GravityBox');
    if (this.geminiDir === defaultGeminiDir && this.pricingCachePath === join(defaultStateDir, 'api_pricing.json')) {
      const cacheTag = name ?? 'antigravity';
      this.persistCachePath = join(homedir(), 'Library', 'Caches', 'GravityBox', `usage-db-cache-${cacheTag}-v1.json`);
      this.persistLoaded = false;
    }
  }

  private async loadPersistentFileCache(): Promise<void> {
    if (this.persistLoaded || !this.persistCachePath) return;
    this.persistLoaded = true;
    try {
      const raw = JSON.parse(await readFile(this.persistCachePath, 'utf8'));
      if (raw && raw.version === 1 && typeof raw.entries === 'object' && raw.entries !== null) {
        for (const [k, v] of Object.entries(raw.entries as Record<string, any>)) {
          if (v && typeof v.mtimeMs === 'number' && typeof v.size === 'number' && Array.isArray(v.events) && !v.hasError && !this.fileCache.has(k)) {
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
    await atomicJson(targetPath, { version: 1, entries }, undefined, { durability: 'relaxed' }).catch(() => {
      this.fileCacheDirty = true;
    });
  }

  public resolvePricing(
    pricingTable: Record<string, ApiPricingEntry>,
    modelName: string,
    timestampSeconds: number
  ): ApiPricing | null {
    if (!modelName || modelName.includes('未知模型') || modelName.toLowerCase().includes('unknown')) {
      return null;
    }
    const direct = pricingTable[modelName];
    if (direct) {
      return resolvePricingForTimestamp(direct, timestampSeconds, modelName);
    }
    const canonicalKey = matchPricingKeys(modelName);
    const matched = pricingTable[canonicalKey];
    if (matched) {
      return resolvePricingForTimestamp(matched, timestampSeconds, canonicalKey);
    }
    return null;
  }

  private validatePricingIntervals(value: ApiPricingInterval[], key: string): void {
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('价格区间条目无效：' + key);
      if (!['input', 'output', 'cached'].every(k => typeof (item as any)[k] === 'number' && Number.isFinite((item as any)[k]) && (item as any)[k] >= 0)) {
        throw Error('价格区间费率无效：' + key);
      }
      if (item.cacheWrite !== undefined && (!Number.isFinite(item.cacheWrite) || item.cacheWrite < 0)) {
        throw Error('价格区间缓存写入费率无效：' + key);
      }
      if (item.validFrom !== undefined && item.validFrom !== null && (typeof item.validFrom !== 'string' || isNaN(Date.parse(item.validFrom)))) {
        throw Error('价格生效时间格式无效：' + key);
      }
      if (item.validUntil !== undefined && item.validUntil !== null && (typeof item.validUntil !== 'string' || isNaN(Date.parse(item.validUntil)))) {
        throw Error('价格失效时间格式无效：' + key);
      }
    }
  }

  private validateRawPrices(table: unknown): Record<string, ApiPricingEntry> {
    if (!table || typeof table !== 'object' || Array.isArray(table)) throw Error('价格表格式无效');
    const result: Record<string, ApiPricingEntry> = {};
    for (const [key, value] of Object.entries(table)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('非法价格条目名：' + key);
      if (Array.isArray(value)) {
        if (value.length === 0) throw Error('价格区间数组不得为空：' + key);
        this.validatePricingIntervals(value, key);
        result[key] = value as ApiPricingInterval[];
      } else {
        const price = value as ApiPricing;
        if (!price || typeof price !== 'object' || typeof price.model !== 'string' || !['input', 'output', 'cached'].every(k => typeof (price as any)[k] === 'number' && Number.isFinite((price as any)[k]) && (price as any)[k] >= 0) || (price.cacheWrite !== undefined && (!Number.isFinite(price.cacheWrite) || price.cacheWrite < 0))) {
          throw Error('价格条目无效：' + key);
        }
        if (price.intervals !== undefined) {
          if (!Array.isArray(price.intervals) || price.intervals.length === 0) {
            throw Error('价格区间数组不得为空：' + key);
          }
          this.validatePricingIntervals(price.intervals, key);
        }
        result[key] = price;
      }
    }
    return result;
  }

  private calendarKey() { const d=new Date();return formatLocalDate(d)+':'+d.getTimezoneOffset()+':'+Intl.DateTimeFormat().resolvedOptions().timeZone; }

  private mergePricingEntries(merged: Record<string, ApiPricingEntry>, entries: object, warning: string): void {
    for (const [key, value] of Object.entries(entries)) {
      try {
        Object.assign(merged, this.validateRawPrices({ [key]: value }));
      } catch {
        this.pricingWarnings.push(warning + key);
      }
    }
  }

  async getRawPricingTable(): Promise<Record<string, ApiPricingEntry>> {
    this.pricingWarnings = [];
    const merged: Record<string, ApiPricingEntry> = Object.assign(Object.create(null), DEFAULT_API_PRICES);

    // 1. 尝试合并本地远程缓存
    try {
      const rawRemote = await readFile(this.remotePricingCachePath, 'utf8');
      const parsedRemote = JSON.parse(rawRemote);
      const remotePrices = parsedRemote && typeof parsedRemote === 'object' && parsedRemote.prices ? parsedRemote.prices : parsedRemote;
      if (remotePrices && typeof remotePrices === 'object' && !Array.isArray(remotePrices)) {
        this.mergePricingEntries(merged, remotePrices, '远程价格条目待修复：');
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

  async syncRemotePricing(feedUrl?: string, force = false): Promise<{ synced: boolean; error?: string; count?: number }> {
    const targetUrl = feedUrl ?? this.remotePricingUrl;
    if (!targetUrl) return { synced: false, error: '未配置价格订阅源' };
    const now = Date.now();
    if (!force && now - this.lastRemoteSyncAt < 86_400_000) {
      return { synced: false, error: '检查频率限制（24小时）' };
    }
    this.lastRemoteSyncAt = now;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(targetUrl, { signal: controller.signal, headers: { 'User-Agent': `GravityBox/${APP_VERSION}` } });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const prices = data && typeof data === 'object' && data.prices ? data.prices : data;
      const validated = this.validateRawPrices(prices);
      await atomicJson(this.remotePricingCachePath, { version: 1, syncedAt: new Date().toISOString(), prices: validated });
      this.cachedSummary = null;
      this.lastAggregationKey = '';
      return { synced: true, count: Object.keys(validated).length };
    } catch (err: any) {
      return { synced: false, error: err?.message ?? String(err) };
    }
  }

  async savePricingTable(table: Record<string, ApiPricing | ApiPricingInterval[]>): Promise<void> {
    await atomicJson(this.pricingCachePath, this.validateRawPrices(table));
    this.cachedSummary = null;
    this.lastAggregationKey = '';
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

  /**
   * 解析单数据库中的 Token 生成事件（按文件 mtimeMs、size 与 WAL 变动增量缓存）
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
    let fileStat: any = null;
    let walStat: any = null;
    try {
      const preStat = this.discoveredStats.get(dbPath);
      if (preStat && Date.now() - preStat.at < 2000) {
        this.discoveredStats.delete(dbPath);
        fileStat = { mtimeMs: preStat.mtimeMs, size: preStat.size };
        walStat = preStat.walMtimeMs > 0 || preStat.walSize > 0 ? { mtimeMs: preStat.walMtimeMs, size: preStat.walSize } : null;
      } else {
        fileStat = await lstat(dbPath);
        try { walStat = await lstat(`${dbPath}-wal`); } catch {}
      }
      if (!bypassCache) {
        const cached = this.fileCache.get(dbPath);
        if (
          cached &&
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

      const assignedModel = modelId || label || '未知模型';
      const eventObj: GenerationEvent = {
        model: assignedModel,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_tokens: cachedTokens,
        ...(cacheWriteTokens>0?{cache_write_tokens:cacheWriteTokens}:{}),
        total_tokens: totalTokens,
        timestamp_seconds: timestamp,
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
          }
        }
      }
    }

    const unknownTime = events.some(event => event.timestamp_seconds <= 0);
    const hasError = !stepOk && unknownTime;
    const timeError = hasError ? '时间信息读取失败，部分记录时间未知' : undefined;
    if (fileStat) {
      if (!this.fileCache.has(dbPath) && this.fileCache.size >= 2000) {
        const oldestKey = this.fileCache.keys().next().value;
        if (oldestKey) this.fileCache.delete(oldestKey);
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
  async getUsageEvents(period: string, query = '', offset = 0, limit = 200, snapshotId?: string, pin = false, force = false) {
    if (!snapshotId || force) await this.getUsageSummary(force);
    const snapshot=(!force && snapshotId)?this.snapshots.get(snapshotId):this.snapshots.get(this.cachedSummary?.data.snapshot_id??'');
    if (!snapshot || snapshot.expires<Date.now()) throw Error('统计快照已过期，请重新读取');
    if (pin) snapshot.pins++;
    if (snapshot.pins > 0) snapshot.expires = Date.now()+600000;
    const {summary,prices,rawPricing}=snapshot as any;
    const start = new Date(summary.generated_at*1000); start.setHours(0, 0, 0, 0);
    if (period === '7d') start.setDate(start.getDate() - 6);
    if (period === '30d') start.setDate(start.getDate() - 29);
    const cutoff = period === 'all' ? 0 : start.getTime() / 1000;
    const end = new Date(summary.generated_at*1000); end.setHours(24,0,0,0);
    const upper = end.getTime()/1000;
    const needle = query.toLowerCase().slice(0, 200);
    const events = snapshot.events.filter(e => (period === 'all' || (e.timestamp_seconds >= cutoff && e.timestamp_seconds < upper)) && e.model.toLowerCase().includes(needle));
    const safeOffset = Math.max(0, Math.floor(offset) || 0);
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit) || 200));
    const pricingSource = rawPricing ?? prices;
    return { rows: events.slice().reverse().slice(safeOffset, safeOffset + safeLimit).map(e => {
      const price = this.resolvePricing(pricingSource, e.model, e.timestamp_seconds);
      const priced=!!price&&(!(e.cache_write_tokens??0)||Number.isFinite(price.cacheWrite)&&price.cacheWrite!>=0);
      return { ...e, estimated_usd: priced ? calculateEstimatedUsd(e.input_tokens, e.output_tokens, e.cached_tokens, price!,e.cache_write_tokens??0) : null, priced };
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
  async getUsageSummary(forceRefresh = false): Promise<TokenUsageSummary> {
    if(this.inFlight) {
      if(!forceRefresh||this.inFlightForced)return this.inFlight;
      if(!this.pendingForced)this.pendingForced=this.inFlight.catch(()=>{}).then(()=>this.getUsageSummary(true)).finally(()=>{this.pendingForced=undefined;});
      return this.pendingForced;
    }
    const abort=this.scanAbort=new AbortController(), timer=setTimeout(()=>abort.abort(new Error('读取超出 30 秒整体预算')),30000);timer.unref();
    this.inFlightForced=forceRefresh;
    const work=this.collectUsage(forceRefresh,abort.signal);this.inFlight=work;
    try{return await work;}finally{clearTimeout(timer);if(this.inFlight===work){this.inFlight=undefined;this.scanAbort=undefined;this.inFlightForced=false;}}
  }
  private async collectUsage(forceRefresh: boolean, signal: AbortSignal): Promise<TokenUsageSummary> {
    const nowMs = Date.now();
    if (!forceRefresh && this.cachedSummary && nowMs < this.cachedSummary.expiresAt && this.periodKey === this.calendarKey()) {
      return this.cachedSummary.data;
    }

    await this.loadPersistentFileCache();
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
      const bypassFileCache = forceRefresh && Boolean(this.fileCache.get(p)?.hasError);
      const res = await this.scanDatabaseEvents(p, bypassFileCache, signal);
      if (!res.cacheHit) allCacheHits = false;
      allEvents.push(...res.events);
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
      if(cached){allEvents.push(...cached.events);cachedDatabasesCount++;generationsScanned+=cached.generationsScanned;skippedLargeRecords+=cached.skippedLargeRecords;}
      diagnostics.push({id:createHash('sha256').update(path).digest('hex').slice(0,10),state:cached?'cached_or_partial':'failed',category:'读取已取消或超过预算',lastSuccessAt:cached?.lastSuccessAt});
    }

    if ((allEvents.length === 0 || cachedDatabasesCount === dbPaths.length) && failedDatabasesCount > 0 && this.cachedSummary?.data) {
      return {
        ...this.cachedSummary.data,
        failed_databases_count: failedDatabasesCount,
        has_error: true,
        hasError: true, availability: 'cached', database_diagnostics: diagnostics, last_attempt_at: Math.floor(Date.now()/1000),
      };
    }

    await this.savePersistentFileCache();
    const rawPricing = await this.getRawPricingTable();
    const now = Math.floor(Date.now() / 1000);
    const pricing = await this.getPricingTable(now);
    if (this.autoRemotePricingSync) {
      void this.syncRemotePricing().catch(() => {});
    }
    const calKey = this.calendarKey();
    const aggKey = allCacheHits && failedDatabasesCount === 0
      ? `${calKey}|${this.lastDiscoveredDatabaseCount}|${dbPaths.map(p => { const c = this.fileCache.get(p); return c ? `${p}:${c.mtimeMs}:${c.size}:${c.walMtimeMs}:${c.walSize}:${c.hasError ? 1 : 0}` : p; }).join(';')}|${JSON.stringify(rawPricing)}|${this.pricingWarnings.join(',')}`
      : '';
    if (aggKey && aggKey === this.lastAggregationKey && this.cachedSummary?.data && this.periodKey === calKey) {
      const reused: TokenUsageSummary = {
        ...this.cachedSummary.data,
        database_diagnostics: diagnostics,
        last_attempt_at: now,
        pricing_warnings: [...this.pricingWarnings],
      };
      this.cachedSummary = { data: reused, expiresAt: Date.now() + 30_000 };
      if (reused.snapshot_id && this.snapshots.has(reused.snapshot_id)) {
        this.snapshots.get(reused.snapshot_id)!.expires = Date.now() + 600000;
      }
      this.pruneSnapshots();
      return reused;
    }

    allEvents.sort((a, b) => a.timestamp_seconds - b.timestamp_seconds);
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const todayStart = Math.floor(todayDate.getTime() / 1000);
    const tomorrowDate = new Date(todayDate); tomorrowDate.setDate(tomorrowDate.getDate()+1);
    const tomorrowStart = Math.floor(tomorrowDate.getTime()/1000);

    // 7天与30天采用本地自然日零点边界，确保总量与每日趋势 100% 对账 (N08)
    const sevenDaysDate = new Date(todayDate);
    sevenDaysDate.setDate(sevenDaysDate.getDate() - 6);
    const sevenDaysStart = Math.floor(sevenDaysDate.getTime() / 1000);

    const thirtyDaysDate = new Date(todayDate);
    thirtyDaysDate.setDate(thirtyDaysDate.getDate() - 29);
    const thirtyDaysStart = Math.floor(thirtyDaysDate.getTime() / 1000);

    const buildPeriod = (filterFn: (ev: GenerationEvent) => boolean): TokenUsagePeriod => {
      const filtered = allEvents.filter(filterFn);
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
        if (evPrice && (!ev.cache_write_tokens || (Number.isFinite(evPrice.cacheWrite) && evPrice.cacheWrite! >= 0))) {
          const evCost = calculateEstimatedUsd(ev.input_tokens, ev.output_tokens, ev.cached_tokens, evPrice, ev.cache_write_tokens ?? 0);
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
        const isPriced = stats.cost > 0 || (stats.unpricedTokens === 0 && currentPrice !== null);
        if (isPriced && currentPrice) {
          pricedCount++;
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
            priced: true,
            pricingKey: canonicalKey || mName,
            pricingStatus: priceStatus(currentPrice, now * 1000),
            pricingProvenance: currentPrice.provenance ?? null,
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
    for (const ev of allEvents) {
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

    for (const ev of allEvents) {
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

    const totalDiscovered = this.lastDiscoveredDatabaseCount || dbPaths.length;
    const allTimePeriod = buildPeriod(() => true);
    const summary: TokenUsageSummary = {
      today: buildPeriod(ev => ev.timestamp_seconds >= todayStart && ev.timestamp_seconds < tomorrowStart),
      last_7_days: buildPeriod(ev => ev.timestamp_seconds >= sevenDaysStart && ev.timestamp_seconds < tomorrowStart),
      last_30_days: buildPeriod(ev => ev.timestamp_seconds >= thirtyDaysStart && ev.timestamp_seconds < tomorrowStart),
      all_time: allTimePeriod,
      daily_trends: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
      today_hourly: [...hourlyMap.values()].sort((a, b) => a.hour.localeCompare(b.hour)),
      databases_scanned: dbPaths.length,
      databases_discovered: totalDiscovered,
      scan_scope_description: totalDiscovered > dbPaths.length
        ? `已读取 ${dbPaths.length}/${totalDiscovered} 个会话数据库`
        : `全部 ${dbPaths.length} 个会话数据库`,
      generations_scanned: generationsScanned,
      skipped_large_records: skippedLargeRecords,
      generated_at: now,
      priced_models: allTimePeriod.priced_models,
      unpriced_models: allTimePeriod.unpriced_models,
      failed_databases_count: failedDatabasesCount,
      has_error: failedDatabasesCount > 0 || allEvents.some(e=>e.timestamp_seconds<=0),
      hasError: failedDatabasesCount > 0 || allEvents.some(e=>e.timestamp_seconds<=0),
      availability: failedDatabasesCount > 0 && allEvents.length === 0 ? 'unavailable'
        : cachedDatabasesCount === dbPaths.length && dbPaths.length > 0 ? 'cached' : failedDatabasesCount > 0 || skippedLargeRecords > 0 || allEvents.some(e=>e.timestamp_seconds<=0) ? 'partial' : 'complete',
      unknown_time_records: allEvents.filter(e=>e.timestamp_seconds<=0).length,
      unknown_time_tokens: allEvents.filter(e=>e.timestamp_seconds<=0).reduce((n,e)=>n+e.total_tokens,0),
      database_diagnostics: diagnostics,
      snapshot_id: (() => {
        const hash = createHash('sha256');
        for (const ev of allEvents) {
          hash.update(`${ev.model}|${ev.timestamp_seconds}|${ev.input_tokens}|${ev.output_tokens}|${ev.cached_tokens}|${ev.cache_write_tokens ?? 0}|${ev.total_tokens}\n`);
        }
        hash.update(JSON.stringify([pricing, this.calendarKey()]));
        return hash.digest('hex').slice(0, 20);
      })(),
      last_attempt_at: now,
      pricing_warnings: [...this.pricingWarnings],
    };

    this.periodKey=calKey;
    this.lastAggregationKey=aggKey;
    this.cachedSummary = { data: summary, expiresAt: Date.now() + 30_000 };
    if (!this.snapshots.has(summary.snapshot_id!)) {
      this.snapshots.set(summary.snapshot_id!, { events: allEvents, prices: pricing, rawPricing, summary, expires: Date.now()+600000, pins: 0 });
    } else {
      const existing = this.snapshots.get(summary.snapshot_id!)!;
      summary.generated_at = existing.summary.generated_at;
      existing.prices = pricing;
      existing.rawPricing = rawPricing;
      existing.expires = Date.now()+600000;
    }
    this.pruneSnapshots();
    return summary;
  }
}

/**
 * 纯 TS Protobuf 二进制编码器 (用于测试与结构打包)
 */
export class ProtobufWriter {
  static encodeVarint(value: number | bigint): Buffer {
    let v = typeof value === 'bigint' ? value : BigInt(Math.floor(value));
    const bytes: number[] = [];
    while (v >= 0x80n) {
      bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    bytes.push(Number(v & 0x7fn));
    return Buffer.from(bytes);
  }

  static encodeField(fieldNumber: number, wireType: number, payload: Buffer): Buffer {
    const tag = (fieldNumber << 3) | wireType;
    const tagBuf = this.encodeVarint(tag);
    if (wireType === 0) {
      return Buffer.concat([tagBuf, payload]);
    } else if (wireType === 2) {
      const lenBuf = this.encodeVarint(payload.length);
      return Buffer.concat([tagBuf, lenBuf, payload]);
    }
    return Buffer.concat([tagBuf, payload]);
  }

  static encodeString(fieldNumber: number, text: string): Buffer {
    return this.encodeField(fieldNumber, 2, Buffer.from(text, 'utf8'));
  }

  static encodeLengthDelimited(fieldNumber: number, payload: Buffer): Buffer {
    return this.encodeField(fieldNumber, 2, payload);
  }

  static encodeVarintField(fieldNumber: number, value: number | bigint): Buffer {
    return this.encodeField(fieldNumber, 0, this.encodeVarint(value));
  }

  static encodeUint64(fieldNumber: number, value: number | bigint): Buffer {
    return this.encodeVarintField(fieldNumber, value);
  }

  static createGenerationMetadata(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    cachedTokens = 0
  ): Buffer {
    const fields: Buffer[] = [
      this.encodeString(1, modelId),
      this.encodeUint64(2, inputTokens),
      this.encodeUint64(3, outputTokens),
    ];
    if (cachedTokens > 0) {
      fields.push(this.encodeUint64(4, cachedTokens));
    }
    return Buffer.concat(fields);
  }

  static createOAuthTokenInfo(token: any, _email?: string): Buffer {
    const fields: Buffer[] = [
      this.encodeString(1, token.access_token || ''),
      this.encodeString(3, token.refresh_token || ''),
    ];
    if (token.expiry_timestamp) {
      const timePayload = this.encodeUint64(1, token.expiry_timestamp);
      fields.push(this.encodeField(4, 2, timePayload));
    }
    if (token.is_gcp_tos) {
      fields.push(this.encodeUint64(6, 1));
    }
    return Buffer.concat(fields);
  }
}
