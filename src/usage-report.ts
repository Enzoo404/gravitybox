import { createHash } from 'node:crypto';
import { formatLocalDate } from './usage-aggregate.js';
import { matchPricingKeys, priceStatus, type ApiPricing, type ApiPricingEntry } from './pricing.js';
import type {
  AvailableAccountUsageOption,
  DailyTokenUsage,
  GenerationEvent,
  HourlyTokenUsage,
  ModelTokenUsage,
  TokenUsagePeriod,
  TokenUsageSummary,
} from './usage-types.js';

export interface BuildUsageReportInput {
  allEvents: GenerationEvent[];
  effectiveEvents: GenerationEvent[];
  knownReceiptKeys: Set<string>;
  unattributedRequests: number;
  unattributedTokens: number;
  accountMap: Map<string, AvailableAccountUsageOption>;
  accountId: string | undefined;
  accKey: string;
  now: number;
  rawPricing: Record<string, ApiPricingEntry>;
  pricing: Record<string, ApiPricing>;
  calKey: string;
  rateLocks: Record<string, { usd: number; price: ApiPricing }>;
  resolvePricing: (table: Record<string, ApiPricingEntry>, modelName: string, ts: number) => ApiPricing | null;
  lockedCost: (ev: GenerationEvent, price: ApiPricing | null) => number | null;
  dbPathsCount: number;
  archivedDbCount: number;
  lastDiscoveredDatabaseCount: number;
  cachedDatabasesCount: number;
  liveEventsCount: number;
  generationsScanned: number;
  skippedLargeRecords: number;
  failedDatabasesCount: number;
  diagnostics: NonNullable<TokenUsageSummary['database_diagnostics']>;
  ledgerCorrupt: boolean;
  archivedUnavailable: boolean;
  storageWarnings: Set<string>;
  pricingWarnings: string[];
}

export function buildUsageSummaryReport(input: BuildUsageReportInput): TokenUsageSummary {
  const {
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
    rateLocks,
    resolvePricing,
    lockedCost,
    dbPathsCount,
    archivedDbCount,
    lastDiscoveredDatabaseCount,
    cachedDatabasesCount,
    liveEventsCount,
    generationsScanned,
    skippedLargeRecords,
    failedDatabasesCount,
    diagnostics,
    ledgerCorrupt,
    archivedUnavailable,
    storageWarnings,
    pricingWarnings,
  } = input;

  const orderedEvents = [...effectiveEvents].sort(
    (a, b) => a.timestamp_seconds - b.timestamp_seconds || (a.event_key ?? '').localeCompare(b.event_key ?? '')
  );
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  const todayStart = Math.floor(todayDate.getTime() / 1000);
  const tomorrowDate = new Date(todayDate); tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStart = Math.floor(tomorrowDate.getTime() / 1000);

  // 7天与30天采用本地自然日零点边界，确保总量与每日趋势 100% 对账
  const sevenDaysDate = new Date(todayDate);
  sevenDaysDate.setDate(sevenDaysDate.getDate() - 6);
  const sevenDaysStart = Math.floor(sevenDaysDate.getTime() / 1000);

  const thirtyDaysDate = new Date(todayDate);
  thirtyDaysDate.setDate(thirtyDaysDate.getDate() - 29);
  const thirtyDaysStart = Math.floor(thirtyDaysDate.getTime() / 1000);

  type ModelStatsBucket = {
    in: number;
    out: number;
    cached: number;
    write: number;
    total: number;
    count: number;
    cost: number;
    unpricedTokens: number;
  };
  type PeriodBucket = {
    modelMap: Map<string, ModelStatsBucket>;
    totalIn: number;
    totalOut: number;
    totalCached: number;
    totalWrite: number;
    totalAll: number;
    totalCount: number;
    periodUsd: number;
  };
  const makePeriodBucket = (): PeriodBucket => ({
    modelMap: new Map(),
    totalIn: 0,
    totalOut: 0,
    totalCached: 0,
    totalWrite: 0,
    totalAll: 0,
    totalCount: 0,
    periodUsd: 0,
  });
  const recordToBucket = (bucket: PeriodBucket, ev: GenerationEvent, evCost: number | null) => {
    bucket.totalIn += ev.input_tokens;
    bucket.totalOut += ev.output_tokens;
    bucket.totalCached += ev.cached_tokens;
    bucket.totalWrite += ev.cache_write_tokens ?? 0;
    bucket.totalAll += ev.total_tokens;
    bucket.totalCount++;
    let entry = bucket.modelMap.get(ev.model);
    if (!entry) {
      entry = { in: 0, out: 0, cached: 0, write: 0, total: 0, count: 0, cost: 0, unpricedTokens: 0 };
      bucket.modelMap.set(ev.model, entry);
    }
    entry.in += ev.input_tokens;
    entry.out += ev.output_tokens;
    entry.cached += ev.cached_tokens;
    entry.write += ev.cache_write_tokens ?? 0;
    entry.total += ev.total_tokens;
    entry.count++;
    if (evCost !== null) {
      entry.cost += evCost;
      bucket.periodUsd += evCost;
    } else {
      entry.unpricedTokens += ev.total_tokens;
    }
  };

  const allTimeBucket = makePeriodBucket();
  const todayBucket = makePeriodBucket();
  const sevenDaysBucket = makePeriodBucket();
  const thirtyDaysBucket = makePeriodBucket();

  const hourlyMap = new Map<string, HourlyTokenUsage>();
  const dailyMap = new Map<string, DailyTokenUsage>();
  let earliestStartDate = new Date(thirtyDaysDate);
  const maxBackfillDate = new Date(todayDate);
  maxBackfillDate.setDate(maxBackfillDate.getDate() - 365);
  let capturedEarliestPositive = false;
  let unknownTimeRecords = 0;
  let unknownTimeTokens = 0;

  // 单遍分桶聚合：同时产出全部周期、每日趋势、今日分时与未知时间统计，且每条事件只查一次价/锁费率
  for (const ev of orderedEvents) {
    const ts = ev.timestamp_seconds;
    const evCost = ts > 0
      ? lockedCost(ev, resolvePricing(rawPricing, ev.model, ts))
      : null;
    recordToBucket(allTimeBucket, ev, evCost);

    if (ts <= 0) {
      unknownTimeRecords++;
      unknownTimeTokens += ev.total_tokens;
      continue;
    }

    const d = new Date(ts * 1000);
    if (!capturedEarliestPositive) {
      capturedEarliestPositive = true;
      const evDay = new Date(d);
      evDay.setHours(0, 0, 0, 0);
      const clamped = evDay < maxBackfillDate ? maxBackfillDate : evDay;
      if (clamped < earliestStartDate) earliestStartDate = clamped;
    }

    const dateStr = formatLocalDate(d);
    let dEntry = dailyMap.get(dateStr);
    if (!dEntry) {
      dEntry = {
        date: dateStr,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 0,
        request_count: 0,
      };
      dailyMap.set(dateStr, dEntry);
    }
    dEntry.input_tokens += ev.input_tokens;
    dEntry.output_tokens += ev.output_tokens;
    dEntry.cached_tokens += ev.cached_tokens;
    if (ev.cache_write_tokens) dEntry.cache_write_tokens = (dEntry.cache_write_tokens ?? 0) + ev.cache_write_tokens;
    dEntry.total_tokens += ev.total_tokens;
    dEntry.request_count++;

    if (ts >= thirtyDaysStart && ts < tomorrowStart) {
      recordToBucket(thirtyDaysBucket, ev, evCost);
      if (ts >= sevenDaysStart) {
        recordToBucket(sevenDaysBucket, ev, evCost);
        if (ts >= todayStart) {
          recordToBucket(todayBucket, ev, evCost);
          const hourStr = `${dateStr} ${String(d.getHours()).padStart(2, '0')}:00`;
          let hEntry = hourlyMap.get(hourStr);
          if (!hEntry) {
            hEntry = {
              hour: hourStr,
              input_tokens: 0,
              output_tokens: 0,
              cached_tokens: 0,
              total_tokens: 0,
              request_count: 0,
            };
            hourlyMap.set(hourStr, hEntry);
          }
          hEntry.input_tokens += ev.input_tokens;
          hEntry.output_tokens += ev.output_tokens;
          hEntry.cached_tokens += ev.cached_tokens;
          if (ev.cache_write_tokens) hEntry.cache_write_tokens = (hEntry.cache_write_tokens ?? 0) + ev.cache_write_tokens;
          hEntry.total_tokens += ev.total_tokens;
          hEntry.request_count++;
        }
      }
    }
  }

  // 连续自然日零值补齐（至少覆盖近 30 天，至多回溯 365 天）
  for (let cur = new Date(earliestStartDate); cur <= todayDate; cur.setDate(cur.getDate() + 1)) {
    const curStr = formatLocalDate(cur);
    if (!dailyMap.has(curStr)) {
      dailyMap.set(curStr, {
        date: curStr,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 0,
        request_count: 0,
      });
    }
  }

  const currentModelMetaCache = new Map<string, { currentPrice: ApiPricing | null; canonicalKey: string | null }>();
  const getCurrentModelMeta = (mName: string) => {
    let cachedMeta = currentModelMetaCache.get(mName);
    if (!cachedMeta) {
      cachedMeta = {
        currentPrice: resolvePricing(rawPricing, mName, now),
        canonicalKey: matchPricingKeys(mName),
      };
      currentModelMetaCache.set(mName, cachedMeta);
    }
    return cachedMeta;
  };

  const finalizePeriod = (bucket: PeriodBucket): TokenUsagePeriod => {
    const byModel: ModelTokenUsage[] = [];
    let pricedCount = 0;
    let unpricedCount = 0;

    for (const [mName, stats] of bucket.modelMap.entries()) {
      const { currentPrice, canonicalKey } = getCurrentModelMeta(mName);
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
        input_tokens: bucket.totalIn,
        output_tokens: bucket.totalOut,
        cached_tokens: bucket.totalCached,
        ...(bucket.totalWrite > 0 ? { cache_write_tokens: bucket.totalWrite } : {}),
        total_tokens: bucket.totalAll,
        request_count: bucket.totalCount,
      },
      estimated_usd: Math.round(bucket.periodUsd * 1e8) / 1e8,
      by_model: byModel,
      priced_models: pricedCount,
      unpriced_models: unpricedCount,
    };
  };

  const totalDiscovered = (lastDiscoveredDatabaseCount || dbPathsCount) + archivedDbCount;
  const totalScanned = dbPathsCount + archivedDbCount;
  const allTimePeriod = finalizePeriod(allTimeBucket);
  const todayPeriod = finalizePeriod(todayBucket);
  const sevenDaysPeriod = finalizePeriod(sevenDaysBucket);
  const thirtyDaysPeriod = finalizePeriod(thirtyDaysBucket);
  const unmatchedReceipts = Object.entries(rateLocks).filter(([key]) => !knownReceiptKeys.has(key));
  if (unmatchedReceipts.length) storageWarnings.add('历史金额凭据缺少原始用量或时间，已单独保留待核对，不计入Token和请求数');
  const hasUnknownTime = unknownTimeRecords > 0;
  const summary: TokenUsageSummary = {
    today: todayPeriod,
    last_7_days: sevenDaysPeriod,
    last_30_days: thirtyDaysPeriod,
    all_time: allTimePeriod,
    unattributed_requests: unattributedRequests,
    unattributed_tokens: unattributedTokens,
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
        : `全部 ${dbPathsCount} 个会话数据库`,
    generations_scanned: generationsScanned,
    skipped_large_records: skippedLargeRecords,
    generated_at: now,
    priced_models: allTimePeriod.priced_models,
    unpriced_models: allTimePeriod.unpriced_models,
    failed_databases_count: failedDatabasesCount,
    has_error: ledgerCorrupt || archivedUnavailable || failedDatabasesCount > 0 || skippedLargeRecords > 0 || hasUnknownTime,
    hasError: ledgerCorrupt || archivedUnavailable || failedDatabasesCount > 0 || skippedLargeRecords > 0 || hasUnknownTime,
    availability: (failedDatabasesCount > 0 && effectiveEvents.length === 0) || (failedDatabasesCount >= dbPathsCount && dbPathsCount > 0 && liveEventsCount === 0) ? 'unavailable'
      : cachedDatabasesCount === dbPathsCount && dbPathsCount > 0 ? 'cached' : storageWarnings.size > 0 || failedDatabasesCount > 0 || skippedLargeRecords > 0 || hasUnknownTime ? 'partial' : 'complete',
    unknown_time_records: unknownTimeRecords,
    unknown_time_tokens: unknownTimeTokens,
    database_diagnostics: diagnostics,
    snapshot_id: (() => {
      const hash = createHash('sha256');
      hash.update(`account:${accKey}\n`);
      for (const ev of allEvents) {
        hash.update(`${ev.model}|${ev.timestamp_seconds}|${ev.input_tokens}|${ev.output_tokens}|${ev.cached_tokens}|${ev.cache_write_tokens ?? 0}|${ev.total_tokens}\n`);
        hash.update(`locked-cost:${ev.event_key ? rateLocks[ev.event_key]?.usd ?? 'unpriced' : 'unpriced'}\n`);
      }
      hash.update(JSON.stringify([pricing, calKey]));
      return hash.digest('hex').slice(0, 20);
    })(),
    last_attempt_at: now,
    pricing_warnings: [...pricingWarnings, ...storageWarnings],
  };

  return summary;
}
