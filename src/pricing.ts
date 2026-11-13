import { normalizeModelId } from './model-identity.js';
import { MODEL_PRICES, MODEL_PRICE_ALIASES, FEED_MODEL_KEYS, CATALOG_PRICING_VERSION } from './model-catalog.js';

export interface ApiPricing {
  model: string;
  input: number;  // 每 1M Tokens 美元
  output: number; // 每 1M Tokens 美元
  cached: number; // 每 1M Tokens 美元
  cacheWrite?: number;
  provenance?: {
    sourceUrl?: string;
    platform?: string;
    conditions?: string;
    checkedAt?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
    verification?: 'confirmed' | 'historical' | 'user';
  };
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
  provenance?: {
    sourceUrl?: string;
    platform?: string;
    conditions?: string;
    checkedAt?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
    verification?: 'confirmed' | 'historical' | 'user';
  };
}

export type ApiPricingEntry = ApiPricing | ApiPricingInterval[];

export const DEFAULT_PRICING_FEED_URLS = [
  'https://raw.githubusercontent.com/Enzoo404/gravitybox/main/assets/pricing-feed.json',
  'https://cdn.jsdelivr.net/gh/Enzoo404/gravitybox@main/assets/pricing-feed.json',
];

export const PRICING_METADATA = {
  version: CATALOG_PRICING_VERSION || '2026-11-13',
  sourceUrl: 'https://cloud.google.com/vertex-ai/pricing',
  effectiveDate: '2026-11-01',
  currency: 'USD',
  conditions: 'List prices for standard context tier, input caching enabled, per million tokens',
};

export const DEFAULT_API_PRICES: Record<string, ApiPricingEntry> = MODEL_PRICES;

export function resolvePricingForTimestamp(
  entry: ApiPricingEntry | undefined,
  timestampSeconds: number,
  fallbackModelName = ''
): ApiPricing | null {
  if (!entry || !Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return null;
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

  const eventMs = timestampSeconds * 1000;

  let match: ApiPricingInterval | null = null;
  for (const interval of intervals) {
    const fromMs = interval.validFrom ? Date.parse(interval.validFrom) : Number.NEGATIVE_INFINITY;
    const untilMs = interval.validUntil ? Date.parse(interval.validUntil) : Number.POSITIVE_INFINITY;
    if (eventMs >= fromMs && eventMs < untilMs) {
      match = interval;
      break;
    }
  }

  // 缝隙容错保护：若刚好落在相邻两区间之间不超过 1000ms（1秒）的跨度（例如 23:59:59 到次日 00:00:00）
  if (!match) {
    for (const interval of intervals) {
      if (interval.validUntil) {
        const untilMs = Date.parse(interval.validUntil);
        const fromMs = interval.validFrom ? Date.parse(interval.validFrom) : Number.NEGATIVE_INFINITY;
        if (eventMs >= fromMs && eventMs >= untilMs && eventMs <= untilMs + 1000) {
          match = interval;
          break;
        }
      }
    }
  }

  if (!match) return null;

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

export function priceStatus(price: ApiPricing | ApiPricingInterval[], now = Date.now()) {
  const p = Array.isArray(price) ? resolvePricingForTimestamp(price, Math.floor(now / 1000)) : price;
  if (!p) return 'historical';
  if (p.provenance?.validUntil && Date.parse(p.provenance.validUntil) < now) return 'expired';
  return p.provenance?.verification === 'confirmed' ? 'confirmed' : p.provenance?.verification === 'user' ? 'user' : 'historical';
}

const SORTED_DEFAULT_PRICE_KEYS = Object.keys(DEFAULT_API_PRICES).sort((a, b) => b.length - a.length);

/**
 * 模型价格归一化匹配算法
 */
export function matchPricingKeys(modelName: string): string {
  if (!modelName || modelName.includes('未知模型') || modelName.toLowerCase().includes('unknown')) {
    return '';
  }
  if (Object.hasOwn(MODEL_PRICE_ALIASES, modelName)) return MODEL_PRICE_ALIASES[modelName]!;
  let lower = normalizeModelId(modelName);
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
    if (lower.startsWith(key + '-') && /^(?:xhigh|extra-high|extra-low|high|medium|low|thinking|latest|preview|trial|\d{8}|\d{4}-\d{2}-\d{2}|\d{3})(?:-thinking)?(?:-\d{2}-\d{2})?$/.test(lower.slice(key.length + 1))) return key;
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
  if (![inputTokens, outputTokens, cachedTokens, cacheWriteTokens, resolvedPricing.input, resolvedPricing.output, resolvedPricing.cached].every(n => Number.isFinite(n) && n >= 0)) throw Error('用量或费率无效');
  const cost =
    (inputTokens * resolvedPricing.input +
      outputTokens * resolvedPricing.output +
      cachedTokens * resolvedPricing.cached + cacheWriteTokens * (resolvedPricing.cacheWrite ?? 0)) /
    1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}

export function validatePricingIntervals(value: ApiPricingInterval[], key: string): void {
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('价格区间条目无效：' + key);
    if (!['input', 'output', 'cached'].every(k => typeof (item as unknown as Record<string, unknown>)[k] === 'number' && Number.isFinite((item as unknown as Record<string, unknown>)[k]) && ((item as unknown as Record<string, number>)[k] ?? -1) >= 0 && ((item as unknown as Record<string, number>)[k] ?? 999) <= 500.0)) {
      throw Error('价格区间费率无效或超出合理范围：' + key);
    }
    if (item.cacheWrite !== undefined && (!Number.isFinite(item.cacheWrite) || item.cacheWrite < 0 || item.cacheWrite > 500.0)) {
      throw Error('价格区间缓存写入费率无效或超出合理范围：' + key);
    }
    if (item.validFrom !== undefined && item.validFrom !== null && (typeof item.validFrom !== 'string' || isNaN(Date.parse(item.validFrom)))) {
      throw Error('价格生效时间格式无效：' + key);
    }
    if (item.validUntil !== undefined && item.validUntil !== null && (typeof item.validUntil !== 'string' || isNaN(Date.parse(item.validUntil)))) {
      throw Error('价格失效时间格式无效：' + key);
    }
  }
}

export function validateRawPrices(table: unknown): Record<string, ApiPricingEntry> {
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw Error('价格表格式无效');
  const result: Record<string, ApiPricingEntry> = {};
  for (const [key, value] of Object.entries(table)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('非法价格条目名：' + key);
    if (Array.isArray(value)) {
      if (value.length === 0) throw Error('价格区间数组不得为空：' + key);
      validatePricingIntervals(value, key);
      result[key] = value as ApiPricingInterval[];
    } else {
      const price = value as ApiPricing;
      const priceRec = price as unknown as Record<string, unknown>;
      if (!price || typeof price !== 'object' || typeof price.model !== 'string' || !['input', 'output', 'cached'].every(k => typeof priceRec[k] === 'number' && Number.isFinite(priceRec[k]) && (priceRec[k] as number) >= 0 && (priceRec[k] as number) <= 500.0) || (price.cacheWrite !== undefined && (!Number.isFinite(price.cacheWrite) || price.cacheWrite < 0 || price.cacheWrite > 500.0))) {
        throw Error('价格条目无效或超出合理范围：' + key);
      }
      if (price.intervals !== undefined) {
        if (!Array.isArray(price.intervals) || price.intervals.length === 0) {
          throw Error('价格区间数组不得为空：' + key);
        }
        validatePricingIntervals(price.intervals, key);
      }
      result[key] = price;
    }
  }
  return result;
}

export function mergePricingEntries(
  merged: Record<string, ApiPricingEntry>,
  entries: object,
  warningPrefix: string,
  warnings: string[]
): void {
  for (const [key, value] of Object.entries(entries)) {
    try {
      const validated = validateRawPrices({ [key]: value });
      const incoming = validated[key];
      const base = merged[key];
      const baseProv = base && !Array.isArray(base) ? base.provenance : undefined;
      if (incoming && baseProv) {
        if (Array.isArray(incoming)) {
          for (const iv of incoming) {
            iv.provenance = {
              ...baseProv,
              ...(iv.provenance ?? {}),
              ...(iv.validUntil && !iv.provenance?.validUntil ? { validUntil: iv.validUntil } : {}),
            };
          }
        } else {
          if (incoming.provenance) {
            incoming.provenance = { ...baseProv, ...incoming.provenance };
          } else {
            incoming.provenance = { ...baseProv };
          }
          if (Array.isArray(incoming.intervals)) {
            for (const iv of incoming.intervals) {
              iv.provenance = {
                ...baseProv,
                ...(iv.provenance ?? {}),
                ...(iv.validUntil && !iv.provenance?.validUntil ? { validUntil: iv.validUntil } : {}),
              };
            }
          }
        }
      }
      Object.assign(merged, validated);
    } catch {
      warnings.push(warningPrefix + key);
    }
  }
}

export function canonicalActivePricingKeys(modelIds: Iterable<string> | null | undefined): Set<string> {
  const source = modelIds ? Array.from(modelIds) : [];
  const keys = new Set<string>();
  for (const rawId of source) {
    const trimmed = String(rawId).trim();
    if (!trimmed) continue;
    const baseId = trimmed.replace(/(?:^|[-_])disabled$/i, '').trim() || trimmed;
    const matched = matchPricingKeys(baseId);
    if (matched) keys.add(matched);
    keys.add(normalizeModelId(baseId));
  }
  if (keys.size === 0) {
    for (const key of FEED_MODEL_KEYS) keys.add(key);
  }
  return keys;
}

export function resolvePricingFromTable(
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
