import { readFile } from 'node:fs/promises';
import { atomicJson, readOptionalJson } from './files.js';
import { APP_VERSION } from './version.js';
import {
  DEFAULT_API_PRICES,
  DEFAULT_PRICING_FEED_URLS,
  PRICING_METADATA,
  mergePricingEntries,
  resolvePricingFromTable,
  validateRawPrices,
  type ApiPricing,
  type ApiPricingEntry,
  type ApiPricingInterval,
} from './pricing.js';

export interface PricingSyncMutableState {
  lastRemoteSyncAt: number;
  lastSyncSuccess: boolean;
  lastCheckAt: number;
  lastCheckSuccess: boolean;
  nextAutoSyncAt: number;
  lastSyncError: string | null;
  lastSyncedSourceUrl: string;
  lastSyncedVersion: string;
}

export async function loadRawPricingTable(
  remotePricingCachePath: string,
  pricingCachePath: string
): Promise<{ merged: Record<string, ApiPricingEntry>; warnings: string[] }> {
  const warnings: string[] = [];
  const merged: Record<string, ApiPricingEntry> = Object.assign(Object.create(null), DEFAULT_API_PRICES);

  // 1. 尝试合并本地远程缓存（禁止早于内置目录日期的旧远端缓存降级覆盖较新的官方目录）
  try {
    const rawRemote = await readFile(remotePricingCachePath, 'utf8');
    const parsedRemote = JSON.parse(rawRemote);
    const remotePrices = parsedRemote && typeof parsedRemote === 'object' && parsedRemote.prices ? parsedRemote.prices : parsedRemote;
    const remoteVer = typeof parsedRemote?.feedVersion === 'string' ? parsedRemote.feedVersion.trim() : '';
    const isOlderDatedFeed = /^\d{4}-\d{2}-\d{2}$/.test(remoteVer)
      && /^\d{4}-\d{2}-\d{2}$/.test(PRICING_METADATA.version)
      && remoteVer < PRICING_METADATA.version;
    if (remotePrices && typeof remotePrices === 'object' && !Array.isArray(remotePrices)) {
      const filteredRemote = isOlderDatedFeed
        ? Object.fromEntries(Object.entries(remotePrices).filter(([k]) => !Object.hasOwn(merged, k)))
        : remotePrices;
      mergePricingEntries(merged, filteredRemote, '远程价格条目待修复：', warnings);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push('远程价格缓存无法读取');
    }
  }

  // 2. 尝试合并用户自定义价格缓存（最高优先级）
  try {
    const rawCustom = await readFile(pricingCachePath, 'utf8');
    const cached = JSON.parse(rawCustom);
    if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
      mergePricingEntries(merged, cached, '自定义价格条目待修复：', warnings);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push('自定义价格无法读取');
    }
  }

  return { merged, warnings };
}

export function resolvePricingTableFromRaw(
  raw: Record<string, ApiPricingEntry>,
  timestampSeconds = Math.floor(Date.now() / 1000),
  allowedKeys?: Set<string>
): Record<string, ApiPricing> {
  const resolved: Record<string, ApiPricing> = Object.create(null);
  for (const key of Object.keys(raw)) {
    if (allowedKeys && !allowedKeys.has(key)) continue;
    const p = resolvePricingFromTable(raw, key, timestampSeconds);
    if (p) resolved[key] = p;
  }
  return resolved;
}

export async function loadPricingSyncState(
  remotePricingCachePath: string,
  pricingSyncStatePath: string,
  state: PricingSyncMutableState
): Promise<void> {
  if (!state.lastRemoteSyncAt) {
    const data = await readOptionalJson<{ syncedAt?: string; sourceUrl?: string; feedVersion?: string }>(
      remotePricingCachePath,
      'remote-pricing-cache.json'
    );
    if (data?.syncedAt) {
      state.lastRemoteSyncAt = Date.parse(data.syncedAt) || 0;
      state.lastSyncSuccess = true;
      state.lastSyncedSourceUrl = data.sourceUrl ?? '';
      state.lastSyncedVersion = data.feedVersion ?? '';
    }
  }
  const checkData = await readOptionalJson<{ lastCheckAt?: number; lastCheckSuccess?: boolean; lastSyncError?: string | null }>(
    pricingSyncStatePath,
    'pricing-sync-state.json'
  );
  if (checkData && typeof checkData === 'object') {
    if (typeof checkData.lastCheckAt === 'number' && Number.isFinite(checkData.lastCheckAt)) {
      state.lastCheckAt = checkData.lastCheckAt;
    }
    if (typeof checkData.lastCheckSuccess === 'boolean') {
      state.lastCheckSuccess = checkData.lastCheckSuccess;
    }
    if (typeof checkData.lastSyncError === 'string' || checkData.lastSyncError === null) {
      state.lastSyncError = checkData.lastSyncError;
    }
  }
  if (!state.nextAutoSyncAt) {
    const lastAttemptAt = Math.max(state.lastCheckAt, state.lastRemoteSyncAt);
    if (lastAttemptAt > 0) {
      const cooldown = state.lastCheckAt > state.lastRemoteSyncAt && !state.lastCheckSuccess ? 300_000 : 86_400_000;
      state.nextAutoSyncAt = lastAttemptAt + cooldown;
    }
  }
}

export function selectRemotePricingCandidateUrls(options: {
  feedUrl?: string;
  customRemoteUrlConfigured: boolean;
  remotePricingUrl: string;
  fallbackPricingUrls: string[];
}): string[] {
  const { feedUrl, customRemoteUrlConfigured, remotePricingUrl, fallbackPricingUrls } = options;
  if (feedUrl) return [feedUrl];
  if (customRemoteUrlConfigured && fallbackPricingUrls === DEFAULT_PRICING_FEED_URLS) return [remotePricingUrl];
  if (remotePricingUrl && !fallbackPricingUrls.includes(remotePricingUrl)) return [remotePricingUrl, ...fallbackPricingUrls];
  return fallbackPricingUrls;
}

export async function executeRemotePricingSync(options: {
  candidateUrls: string[];
  remotePricingCachePath: string;
  pricingSyncStatePath: string;
  state: PricingSyncMutableState;
  now: number;
}): Promise<{ synced: boolean; error?: string; count?: number; sourceUrl?: string; version?: string }> {
  const { candidateUrls, remotePricingCachePath, pricingSyncStatePath, state, now } = options;
  let lastError: any = null;
  for (const targetUrl of candidateUrls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(targetUrl, { signal: controller.signal, headers: { 'User-Agent': `GravityBox/${APP_VERSION}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const prices = data && typeof data === 'object' && data.prices ? data.prices : data;
      const validated = validateRawPrices(prices);
      const feedVersion = (data && typeof data === 'object' && typeof data.version === 'string') ? data.version : 'unknown';
      await atomicJson(remotePricingCachePath, {
        version: 1,
        syncedAt: new Date(now).toISOString(),
        sourceUrl: targetUrl,
        feedVersion,
        prices: validated,
      });
      state.lastRemoteSyncAt = now;
      state.lastCheckAt = now;
      state.nextAutoSyncAt = now + 86_400_000;
      state.lastSyncSuccess = true;
      state.lastCheckSuccess = true;
      state.lastSyncError = null;
      state.lastSyncedSourceUrl = targetUrl;
      state.lastSyncedVersion = feedVersion;
      await atomicJson(pricingSyncStatePath, {
        lastCheckAt: now,
        lastCheckSuccess: true,
        lastSyncError: null,
      }).catch(() => {});
      return { synced: true, count: Object.keys(validated).length, sourceUrl: targetUrl, version: feedVersion };
    } catch (err: any) {
      lastError = err;
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  // 所有候选源均尝试失败：保留上次成功同步时间，仅推进检查时间戳与 5 分钟重试冷却
  state.nextAutoSyncAt = now + 300_000;
  state.lastCheckAt = now;
  state.lastSyncSuccess = false;
  state.lastCheckSuccess = false;
  state.lastSyncError = lastError?.message ?? String(lastError);
  await atomicJson(pricingSyncStatePath, {
    lastCheckAt: now,
    lastCheckSuccess: false,
    lastSyncError: state.lastSyncError,
  }).catch(() => {});
  return { synced: false, error: state.lastSyncError ?? undefined };
}

export function buildPricingSyncStatus(options: {
  autoSyncEnabled: boolean;
  state: PricingSyncMutableState;
  remotePricingUrl: string;
  modelCount: number;
}) {
  const { autoSyncEnabled, state, remotePricingUrl, modelCount } = options;
  const rawVersion = state.lastSyncedVersion || PRICING_METADATA.version;
  const effectiveVersion = /^\d{4}-\d{2}-\d{2}$/.test(rawVersion)
    && /^\d{4}-\d{2}-\d{2}$/.test(PRICING_METADATA.version)
    && rawVersion < PRICING_METADATA.version
    ? PRICING_METADATA.version
    : rawVersion;
  const effectiveCheckAt = Math.max(state.lastCheckAt, state.lastRemoteSyncAt);
  return {
    autoSyncEnabled,
    lastSyncAt: state.lastRemoteSyncAt,
    lastCheckAt: effectiveCheckAt,
    lastSyncSuccess: state.lastSyncSuccess,
    lastCheckSuccess: state.lastCheckAt ? state.lastCheckSuccess : state.lastSyncSuccess,
    lastSyncError: state.lastSyncError,
    feedVersion: effectiveVersion,
    sourceUrl: state.lastSyncedSourceUrl || remotePricingUrl,
    modelCount,
  };
}

export async function saveCustomPricingCache(
  pricingCachePath: string,
  table: Record<string, ApiPricing | ApiPricingInterval[]>
): Promise<void> {
  await atomicJson(pricingCachePath, validateRawPrices(table));
}
