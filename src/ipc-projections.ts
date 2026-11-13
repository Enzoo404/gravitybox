import { type AccountsManager, projectAccountForIpc } from './accounts.js';
import type { ModelTokenUsage, TokenUsagePeriod, TokenUsageSummary } from './usage.js';

/** 套餐枚举统一收口；空值/未知值一律回落到“待确认”，空串不得穿透 IPC。 */
export function normalizeSubscriptionTier(value: unknown): 'FREE' | 'PRO' | 'ULTRA' | '待确认' {
  if (typeof value !== 'string') return '待确认';
  const raw = value.trim();
  if (!raw) return '待确认';
  const upper = raw.toUpperCase();
  if (upper === 'FREE') return 'FREE';
  if (upper === 'PRO') return 'PRO';
  if (upper === 'ULTRA') return 'ULTRA';
  if (/\bULTRA\b/i.test(raw)) return 'ULTRA';
  if (/\bPRO\b/i.test(raw)) return 'PRO';
  if (/\bFREE\b/i.test(raw) || /starter/i.test(raw)) return 'FREE';
  return '待确认';
}

/** Single contract for dashboard, account cards, menu and refresh replies. No credentials. */
export function projectQuotaContract(overview: {
  familyWindows?: unknown;
  familyModelQuota?: unknown;
  argonStatus?: unknown;
  carbonStatus?: unknown;
  standaloneModels?: unknown[];
  refreshState?: unknown;
  quotaWarnings?: unknown;
  quotaWarningCodes?: unknown;
}): Record<string, unknown> {
  return {
    familyWindows: overview.familyWindows,
    familyModelQuota: overview.familyModelQuota,
    argonStatus: overview.argonStatus,
    carbonStatus: overview.carbonStatus ?? null,
    standaloneModels: overview.standaloneModels ?? [],
    refreshState: overview.refreshState,
    quotaWarnings: overview.quotaWarnings,
    quotaWarningCodes: overview.quotaWarningCodes,
  };
}

export function projectAccountForIpcNormalized(
  account: Parameters<typeof projectAccountForIpc>[0],
  accountsManager: Pick<AccountsManager, 'getAccountQuotaOverview'>
): Record<string, unknown> | null {
  if (!account) return null;
  const projected = projectAccountForIpc(account) as Record<string, unknown> | null;
  if (!projected) return projected;
  const normalized: Record<string, unknown> = {
    ...projected,
    subscription_tier: normalizeSubscriptionTier(projected.subscription_tier),
  };
  if (projected.quota && typeof projected.quota === 'object') {
    const quotaObj = projected.quota as Record<string, unknown>;
    normalized.quota = {
      ...quotaObj,
      subscription_tier: normalizeSubscriptionTier(quotaObj.subscription_tier),
    };
  }
  const contract = projectQuotaContract(accountsManager.getAccountQuotaOverview(account));
  Object.assign(normalized, contract);
  if (normalized.quota && typeof normalized.quota === 'object') {
    Object.assign(normalized.quota as Record<string, unknown>, contract);
  }
  return normalized;
}

export function projectUsagePeriodSummary(usage: TokenUsageSummary, periodInput: unknown) {
  const periodKey: 'today' | 'last_7_days' | 'last_30_days' | 'all_time' =
    periodInput === 'today' ? 'today' : periodInput === '7d' ? 'last_7_days' : periodInput === '30d' ? 'last_30_days' : 'all_time';
  const p: TokenUsagePeriod = usage[periodKey] ?? usage.all_time;
  const byModel = p.by_model.map((m: ModelTokenUsage) => ({
    model: m.model,
    promptTokens: m.input_tokens,
    candidatesTokens: m.output_tokens,
    cachedTokens: m.cached_tokens,
    cacheWriteTokens: m.cache_write_tokens ?? 0,
    totalTokens: m.total_tokens,
    requestCount: m.request_count,
    estimatedUsd: m.estimated_usd,
    priced: m.priced === true,
    partiallyPriced: m.partiallyPriced === true,
    unpricedTokens: m.unpriced_tokens ?? 0,
    pricingKey: m.pricingKey,
    pricingStatus: m.pricingStatus,
    pricingProvenance: m.pricingProvenance,
    input_tokens: m.input_tokens,
    output_tokens: m.output_tokens,
    cached_tokens: m.cached_tokens,
    cache_write_tokens: m.cache_write_tokens ?? 0,
    total_tokens: m.total_tokens,
    request_count: m.request_count,
    estimated_usd: m.estimated_usd,
  }));
  const cacheDenom = p.totals.input_tokens + p.totals.cached_tokens + (p.totals.cache_write_tokens ?? 0);
  const cacheHitRate = cacheDenom > 0 ? Math.round((p.totals.cached_tokens / cacheDenom) * 1000) / 10 : 0;
  const periodSummary = {
    ...usage,
    totalTokens: p.totals.total_tokens,
    promptTokens: p.totals.input_tokens,
    candidatesTokens: p.totals.output_tokens,
    cachedTokens: p.totals.cached_tokens,
    cacheWriteTokens: p.totals.cache_write_tokens ?? 0,
    requestCount: p.totals.request_count,
    estimatedUsd: p.estimated_usd,
    cacheHitRate,
    total_tokens: p.totals.total_tokens,
    input_tokens: p.totals.input_tokens,
    output_tokens: p.totals.output_tokens,
    cached_tokens: p.totals.cached_tokens,
    cache_write_tokens: p.totals.cache_write_tokens ?? 0,
    request_count: p.totals.request_count,
    estimated_usd: p.estimated_usd,
    databasesScanned: usage.databases_scanned,
    databasesDiscovered: usage.databases_discovered,
    scanScopeDescription: usage.scan_scope_description,
    pricedModels: p.priced_models ?? usage.priced_models ?? 0,
    unpricedModels: p.unpriced_models ?? usage.unpriced_models ?? 0,
    failedDatabasesCount: usage.failed_databases_count ?? 0,
    skippedLargeRecords: usage.skipped_large_records ?? 0,
    lastScannedAt: usage.generated_at ?? 0,
    hasError: usage.has_error === true,
    availability: usage.availability ?? 'complete',
    unknownTimeRecords: usage.unknown_time_records ?? 0,
    unknownTimeTokens: usage.unknown_time_tokens ?? 0,
    databaseDiagnostics: usage.database_diagnostics ?? [],
    selectedAccountId: usage.selected_account_id ?? 'all',
    selected_account_id: usage.selected_account_id ?? 'all',
    availableAccounts: usage.available_accounts ?? [],
    available_accounts: usage.available_accounts ?? [],
  };
  const { today: _t, last_7_days: _w, last_30_days: _m, all_time: _a, daily_trends, today_hourly, ...selectedSummary } = periodSummary;
  const days = periodInput === 'today' ? 1 : periodInput === '7d' ? 7 : periodInput === '30d' ? 30 : null;
  const selectedTrends = days ? daily_trends.slice(-days) : daily_trends;
  return {
    ok: true,
    period: typeof periodInput === 'string' ? periodInput : 'all',
    snapshotId: usage.snapshot_id,
    selectedAccountId: usage.selected_account_id ?? 'all',
    availableAccounts: usage.available_accounts ?? [],
    summary: selectedSummary,
    byModel,
    models: byModel,
    dailyTrends: selectedTrends,
    todayHourly: periodInput === 'today' ? today_hourly : [],
  };
}
