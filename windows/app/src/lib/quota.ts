import { translate, type ResolvedLocale } from './i18n';
import {
  formatCompactTokens,
  formatInteger,
  formatShortDateTime,
  inferredBrands,
  localizeCountdown,
  modelDisplayName,
} from './format';
import type { AccountWeeklyAttribution, WeeklyPoolAttribution } from './types';

export interface QuotaWindowView {
  id: string;
  period: string;
  label: string;
  percentage: number | null;
  known: boolean;
  stale: boolean;
  resetCountdown: string;
  resetTime: string | null;
  resetText: string;
  placeholder: string;
  unknownReason: string;
}

export interface QuotaGroupView {
  key: string;
  displayName: string;
  summaryLabel: string;
  brands: Array<'gemini' | 'claude' | 'openai'>;
  isStandalone: boolean;
  availability: string;
  quotaState: string;
  windows: QuotaWindowView[];
  message: string;
  primaryPercentage: number | null;
}

export interface QuotaContractView {
  hasContract: boolean;
  displayGroups: QuotaGroupView[];
  coreGroups: QuotaGroupView[];
  standaloneGroups: QuotaGroupView[];
  quotaWarnings: string[];
  refreshComplete: boolean | null;
  refreshMessage: string;
  standbyMode: string | null;
}

const ORCHESTRATOR_RE = /^orchestrator(?:[-_].+|\s*\([^)]*\)|\s+.+)?$/i;

function isOrchestratorMetaModel(id?: string, displayName?: string): boolean {
  const rawId = (id ?? '').trim().toLowerCase();
  if (rawId) {
    if (
      rawId === 'gemini-pro-coordinator' ||
      rawId === 'gemini-pro-orchestrator' ||
      rawId.startsWith('gemini-pro-orchestrator-') ||
      ORCHESTRATOR_RE.test(rawId)
    ) {
      return true;
    }
  }
  const rawDisplay = (displayName ?? '').trim();
  if (rawDisplay && ORCHESTRATOR_RE.test(rawDisplay)) return true;
  return false;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asFraction(v: unknown): number | null {
  const n = asNum(v);
  if (n === null || n < 0 || n > 1) return null;
  return n;
}

function parseResetDate(raw: string | null): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return new Date(parsed);
  const num = Number(trimmed);
  if (Number.isFinite(num) && num > 0) {
    return new Date(num < 1e11 ? num * 1000 : num);
  }
  return null;
}

function formatLocalCountdown(resetDate: Date, nowMs: number, locale: ResolvedLocale): string {
  const diffSec = (resetDate.getTime() - nowMs) / 1000;
  if (diffSec <= 0) return translate(locale, 'quota.countdown.overdue');
  if (diffSec <= 60) return translate(locale, 'quota.countdown.soon');
  const totalMin = Math.floor(diffSec / 60);
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const mins = totalMin % 60;
  if (days > 0) {
    return translate(locale, 'quota.countdown.days_hours', { days, hours });
  }
  if (hours > 0) {
    return translate(locale, 'quota.countdown.hours_mins', { hours, mins });
  }
  return translate(locale, 'quota.countdown.mins', { mins });
}

export function localizedWindowLabel(period: string, rawLabel: string, locale: ResolvedLocale): string {
  const p = period.trim().toLowerCase();
  if (p === '5h' || p === 'fivehour') return translate(locale, 'common.period.5h');
  if (p === 'weekly') return translate(locale, 'common.period.weekly');
  if (p === 'daily' || p === 'day' || p === '24h') return translate(locale, 'common.period.daily');
  if (p === 'unspecified') return translate(locale, 'quota.model_quota');

  const trimmed = rawLabel.trim();
  if (!trimmed || ['周期未知', 'Unknown Cycle', 'unspecified'].includes(trimmed)) {
    return translate(locale, 'quota.model_quota');
  }
  if (['5小时', '5 小时', '5 Hours', '5h'].includes(trimmed)) return translate(locale, 'common.period.5h');
  if (['每周', 'Weekly'].includes(trimmed)) return translate(locale, 'common.period.weekly');
  if (['每日', 'Daily'].includes(trimmed)) return translate(locale, 'common.period.daily');
  if (['模型配额', 'Model Quota'].includes(trimmed)) return translate(locale, 'quota.model_quota');
  return trimmed;
}

function normalizeBrands(rawBrands: unknown, fallbackTitle: string, key: string): Array<'gemini' | 'claude' | 'openai'> {
  const out: Array<'gemini' | 'claude' | 'openai'> = [];
  if (Array.isArray(rawBrands)) {
    for (const b of rawBrands) {
      const low = String(b ?? '').trim().toLowerCase();
      const mapped: Array<'gemini' | 'claude' | 'openai'> =
        low === 'gemini'
          ? ['gemini']
          : low === 'claude'
          ? ['claude']
          : low === 'gpt' || low === 'openai'
          ? ['openai']
          : inferredBrands(low);
      for (const m of mapped) {
        if (!out.includes(m)) out.push(m);
      }
    }
  }
  if (out.length > 0) return out;
  return inferredBrands(`${key} ${fallbackTitle}`);
}

function buildResetText(
  percentage: number | null,
  stale: boolean,
  resetCountdown: string,
  resetTime: string | null,
  standbyMode: string | null,
  nowMs: number,
  locale: ResolvedLocale,
  compact: boolean,
): string {
  if (percentage === null) return '';
  const resetDate = parseResetDate(resetTime);
  const overdue =
    (resetDate !== null && resetDate.getTime() <= nowMs) ||
    ['重置时间已过', '已过'].includes(resetCountdown.trim()) ||
    /overdue/i.test(resetCountdown);

  if (standbyMode === 'snapshot_cooling' || standbyMode === 'snapshot_cooldown_elapsed') {
    if (overdue) {
      return translate(locale, compact ? 'accounts.standby.likely_reset' : 'accounts.standby.likely_reset_sync');
    }
    if (resetDate) return formatLocalCountdown(resetDate, nowMs, locale);
    return localizeCountdown(resetCountdown, locale);
  }

  const effectiveStale = stale || (resetDate !== null && resetDate.getTime() <= nowMs);
  const countdown = resetDate
    ? formatLocalCountdown(resetDate, nowMs, locale)
    : localizeCountdown(resetCountdown, locale);
  if (effectiveStale) {
    const staleWord = translate(locale, 'quota.stale_data');
    return countdown ? `${countdown} · ${staleWord}` : staleWord;
  }
  return countdown;
}

function parseGroupWindow(
  raw: Record<string, unknown>,
  availability: string,
  standbyMode: string | null,
  nowMs: number,
  locale: ResolvedLocale,
  compact: boolean,
): QuotaWindowView {
  const id = String(raw.id ?? '').trim();
  const period = String(raw.period ?? '').trim() || id || 'unspecified';
  const rawLabel = String(raw.label ?? '').trim();
  const knownFlag = raw.known === true;
  const remaining = asFraction(raw.remaining);
  const stale = raw.stale === true;
  const resetCountdown = String(raw.resetCountdown ?? '').trim();
  const resetTime = String(raw.resetTime ?? '').trim() || null;
  const unknownReason = String(raw.unknownReason ?? '').trim();

  const known = knownFlag && remaining !== null;
  const percentage = known ? Math.round(Math.min(1, Math.max(0, remaining!)) * 100) : null;
  const resetText = buildResetText(percentage, stale, resetCountdown, resetTime, standbyMode, nowMs, locale, compact);

  let placeholder = translate(locale, 'common.unknown');
  if (stale && percentage === null) placeholder = translate(locale, 'quota.stale');
  else if (availability === 'disabled') placeholder = translate(locale, 'common.unavailable');
  else if (unknownReason.includes('失败') || /fail/i.test(unknownReason)) {
    placeholder = translate(locale, 'quota.read_failed');
  }

  return {
    id: id || period,
    period,
    label: localizedWindowLabel(period, rawLabel, locale),
    percentage,
    known,
    stale,
    resetCountdown,
    resetTime,
    resetText,
    placeholder,
    unknownReason,
  };
}

function parseQuotaGroup(
  raw: Record<string, unknown>,
  standbyMode: string | null,
  nowMs: number,
  locale: ResolvedLocale,
  compact: boolean,
): QuotaGroupView | null {
  const key = String(raw.key ?? '').trim();
  const rawDisplay = String(raw.displayName ?? '').trim();
  if (!key && !rawDisplay) return null;
  const resolvedKey = key || rawDisplay.toLowerCase();
  const displayName = rawDisplay
    ? (resolvedKey === 'gemini' || resolvedKey === 'claude' ? rawDisplay : modelDisplayName(rawDisplay))
    : resolvedKey === 'gemini'
    ? 'Gemini'
    : resolvedKey === 'claude'
    ? 'Claude/GPT'
    : resolvedKey === 'argon'
    ? 'Gemini 4 Argon'
    : resolvedKey === 'carbon'
    ? 'Gemini 4 Carbon'
    : modelDisplayName(resolvedKey);

  const isStandalone = typeof raw.isStandalone === 'boolean'
    ? raw.isStandalone
    : resolvedKey !== 'gemini' && resolvedKey !== 'claude';

  if (isStandalone && (isOrchestratorMetaModel(resolvedKey, displayName) || isOrchestratorMetaModel(key, rawDisplay))) {
    return null;
  }

  const availability = String(raw.availability ?? '').trim() || 'available';
  const quotaState = String(raw.quotaState ?? '').trim() || 'not_reported';
  const brands = normalizeBrands(raw.brands, displayName, resolvedKey);
  const rawWindows = Array.isArray(raw.windows) ? raw.windows : [];
  const windows = rawWindows
    .map((w) => asObj(w))
    .filter((w): w is Record<string, unknown> => w !== null)
    .map((w) => parseGroupWindow(w, availability, standbyMode, nowMs, locale, compact));

  const primaryPercentage =
    windows.find((w) => w.percentage !== null && !w.stale)?.percentage ??
    windows.find((w) => w.percentage !== null)?.percentage ??
    null;

  const summaryLabel =
    String(raw.summaryLabel ?? '').trim() ||
    (resolvedKey === 'gemini'
      ? 'Gemini'
      : resolvedKey === 'claude'
      ? 'Claude/GPT'
      : resolvedKey === 'argon'
      ? 'Argon'
      : resolvedKey === 'carbon'
      ? 'Carbon'
      : displayName);

  return {
    key: resolvedKey,
    displayName,
    summaryLabel,
    brands,
    isStandalone,
    availability,
    quotaState,
    windows,
    message: String(raw.message ?? '').trim(),
    primaryPercentage,
  };
}

function synthCoreWindow(
  rawObj: Record<string, unknown> | null,
  id: string,
  period: string,
  label: string,
  standbyMode: string | null,
  nowMs: number,
  locale: ResolvedLocale,
  compact: boolean,
): QuotaWindowView {
  if (!rawObj) {
    return {
      id,
      period,
      label,
      percentage: null,
      known: false,
      stale: false,
      resetCountdown: '',
      resetTime: null,
      resetText: '',
      placeholder: translate(locale, 'common.unknown'),
      unknownReason: '',
    };
  }
  return parseGroupWindow({ id, period, label, ...rawObj }, 'available', standbyMode, nowMs, locale, compact);
}

export function parseQuotaContract(
  raw: Record<string, unknown> | null | undefined,
  locale: ResolvedLocale,
  options: { compact?: boolean; nowMs?: number } = {},
): QuotaContractView {
  const nowMs = options.nowMs ?? Date.now();
  const compact = options.compact === true;
  if (!raw) {
    return {
      hasContract: false,
      displayGroups: [],
      coreGroups: [],
      standaloneGroups: [],
      quotaWarnings: [],
      refreshComplete: null,
      refreshMessage: '',
      standbyMode: null,
    };
  }

  const nested = asObj(raw.quota);
  const standbyObj = asObj(raw.standbyRefreshStatus);
  const standbyMode = String(standbyObj?.mode ?? '').trim() || null;

  const quotaGroupsRaw = (Array.isArray(raw.quotaGroups) ? raw.quotaGroups : null) ??
    (Array.isArray(nested?.quotaGroups) ? nested.quotaGroups : null);

  let displayGroups: QuotaGroupView[] = [];
  if (quotaGroupsRaw) {
    displayGroups = quotaGroupsRaw
      .map((g) => asObj(g))
      .filter((g): g is Record<string, unknown> => g !== null)
      .map((g) => parseQuotaGroup(g, standbyMode, nowMs, locale, compact))
      .filter((g): g is QuotaGroupView => g !== null);
  }

  const familyWindows = asObj(raw.familyWindows) ?? asObj(nested?.familyWindows);
  if (displayGroups.length === 0 && familyWindows) {
    const gem = asObj(familyWindows.gemini);
    const cla = asObj(familyWindows.claude);
    if (gem) {
      const w5 = synthCoreWindow(asObj(gem.fiveHour), '5h', '5h', translate(locale, 'common.period.5h'), standbyMode, nowMs, locale, compact);
      const ww = synthCoreWindow(asObj(gem.weekly), 'weekly', 'weekly', translate(locale, 'common.period.weekly'), standbyMode, nowMs, locale, compact);
      displayGroups.push({
        key: 'gemini',
        displayName: 'Gemini',
        summaryLabel: 'Gemini',
        brands: ['gemini'],
        isStandalone: false,
        availability: w5.known || ww.known ? 'available' : 'unknown',
        quotaState: w5.known || ww.known ? 'known' : 'not_reported',
        windows: [w5, ww],
        message: '',
        primaryPercentage: w5.percentage ?? ww.percentage,
      });
    }
    if (cla) {
      const w5 = synthCoreWindow(asObj(cla.fiveHour), '5h', '5h', translate(locale, 'common.period.5h'), standbyMode, nowMs, locale, compact);
      const ww = synthCoreWindow(asObj(cla.weekly), 'weekly', 'weekly', translate(locale, 'common.period.weekly'), standbyMode, nowMs, locale, compact);
      displayGroups.push({
        key: 'claude',
        displayName: 'Claude/GPT',
        summaryLabel: 'Claude/GPT',
        brands: ['claude', 'openai'],
        isStandalone: false,
        availability: w5.known || ww.known ? 'available' : 'unknown',
        quotaState: w5.known || ww.known ? 'known' : 'not_reported',
        windows: [w5, ww],
        message: '',
        primaryPercentage: w5.percentage ?? ww.percentage,
      });
    }
  }

  const coreGroups = displayGroups.filter((g) => !g.isStandalone);
  const standaloneGroups = displayGroups.filter(
    (g) =>
      g.isStandalone &&
      g.availability !== 'disabled' &&
      !(g.quotaState === 'not_reported' && g.primaryPercentage === null),
  );

  const rawWarnings = (Array.isArray(raw.quotaWarnings) ? raw.quotaWarnings : null) ??
    (Array.isArray(nested?.quotaWarnings) ? nested.quotaWarnings : []);
  const quotaWarnings = rawWarnings.map((w) => String(w ?? '').trim()).filter(Boolean);

  const refreshState = asObj(raw.refreshState) ?? asObj(nested?.refreshState);
  const refreshComplete = typeof refreshState?.complete === 'boolean' ? refreshState.complete : null;
  const refreshMessage = String(refreshState?.error ?? refreshState?.message ?? '').trim();

  return {
    hasContract: displayGroups.length > 0 || familyWindows !== null,
    displayGroups: [...coreGroups, ...standaloneGroups],
    coreGroups,
    standaloneGroups,
    quotaWarnings,
    refreshComplete,
    refreshMessage,
    standbyMode,
  };
}

export function formatBarTitle(group: QuotaGroupView, win: QuotaWindowView, locale: ResolvedLocale): string {
  const name = group.displayName || group.summaryLabel || group.key;
  if (!group.isStandalone) {
    return `${name} · ${win.label}`;
  }
  if (group.windows.length > 1 || win.percentage !== null || group.quotaState === 'known' || group.quotaState === 'stale') {
    const p = win.period.toLowerCase();
    if (['weekly', '5h', 'fivehour', 'daily', '24h', 'day'].includes(p)) {
      return translate(locale, 'quota.model_with_period', { model: name, period: win.label });
    }
  }
  return name;
}

export function formatCollapsedQuotaSummary(contract: QuotaContractView, locale: ResolvedLocale): string {
  const parts: string[] = [];
  for (const grp of contract.displayGroups) {
    if (grp.primaryPercentage !== null) {
      const label = grp.summaryLabel || grp.displayName;
      const hasStale = grp.windows.some((w) => w.stale);
      const staleSuffix = hasStale ? ` (${translate(locale, 'quota.stale')})` : '';
      parts.push(`${label} ${grp.primaryPercentage}%${staleSuffix}`);
    }
  }
  if (parts.length === 0) return translate(locale, 'accounts.collapsed_pending');
  return '· ' + parts.join(' · ');
}

export interface MonitoredScopeChoice {
  key: string;
  title: string;
}

export function monitoredScopeChoices(locale: ResolvedLocale): MonitoredScopeChoice[] {
  return [
    { key: 'all', title: translate(locale, 'accounts.smart_switch.monitored.all_core') },
    { key: 'gemini_all', title: translate(locale, 'accounts.smart_switch.monitored.gemini_all') },
    { key: 'gemini', title: translate(locale, 'accounts.smart_switch.monitored.gemini_base') },
    { key: 'claude', title: 'Claude/GPT' },
    { key: 'argon', title: 'Gemini 4 Argon' },
  ];
}

export function monitoredModelDisplayName(raw: string | undefined | null, locale: ResolvedLocale): string {
  const key = (raw ?? 'all').trim().toLowerCase();
  if (key === 'all' || !key) return translate(locale, 'accounts.smart_switch.monitored.all_core');
  if (key === 'gemini_all') return translate(locale, 'accounts.smart_switch.monitored.gemini_all');
  if (key === 'gemini') return translate(locale, 'accounts.smart_switch.monitored.gemini_base');
  if (key === 'claude') return 'Claude/GPT';
  if (key === 'argon') return 'Gemini 4 Argon';
  return modelDisplayName(raw ?? '');
}

export function monitoredScopeSubtitle(key: string, locale: ResolvedLocale): string {
  const k = key.trim().toLowerCase();
  if (k === 'all' || !k) return translate(locale, 'policy.row.monitored.sub.dyn_all');
  if (k === 'gemini_all') return translate(locale, 'policy.row.monitored.sub.dyn_gemini_all');
  if (k === 'gemini') return translate(locale, 'policy.row.monitored.sub.dyn_gemini_base');
  if (k === 'claude') return translate(locale, 'policy.row.monitored.sub.claude');
  if (k === 'argon') return translate(locale, 'policy.row.monitored.sub.pro_argon');
  return translate(locale, 'policy.row.monitored.sub.standalone', { model: modelDisplayName(key) });
}

export function formatPctNumber(value: number): string {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const rounded = Math.round(clamped * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function indexWeeklyAttributionByPool(
  attr?: AccountWeeklyAttribution | null,
): Map<string, WeeklyPoolAttribution> {
  const map = new Map<string, WeeklyPoolAttribution>();
  if (!attr || !Array.isArray(attr.pools)) return map;
  for (const pool of attr.pools) {
    const key = String(pool?.poolKey ?? '').trim().toLowerCase();
    if (key) {
      map.set(key, pool);
    }
  }
  return map;
}

export function resolveWeeklyAttributionForAccount(
  direct: AccountWeeklyAttribution | null | undefined,
  list: AccountWeeklyAttribution[],
  identity: { accountId?: string | null; email?: string | null },
): AccountWeeklyAttribution | null {
  if (direct && Array.isArray(direct.pools)) return direct;
  const id = (identity.accountId ?? '').trim();
  const email = (identity.email ?? '').trim().toLowerCase();
  if (!id && !email) return null;
  const found = list.find(
    (item) =>
      (id && item.accountId && item.accountId === id) ||
      (email && item.email && item.email.trim().toLowerCase() === email),
  );
  return found ?? null;
}

export interface WeeklyAttributionInlineView {
  left: string;
  right: string;
  tooltip: string;
  state: 'attributed' | 'calibrating' | 'unused';
}

export function formatWeeklyAttributionInline(
  pool: WeeklyPoolAttribution,
  locale: ResolvedLocale,
  t: (key: string, params?: Record<string, string | number>, fallback?: string) => string = (
    key,
    params,
    fallback,
  ) => translate(locale, key, params, fallback),
): WeeklyAttributionInlineView {
  let left: string;
  let right: string;
  let state: WeeklyAttributionInlineView['state'];

  if (pool.localRequests <= 0) {
    state = 'unused';
    left = t('weekly_attribution.inline.local_unused');
    right =
      pool.totalUsedPct > 0
        ? t('weekly_attribution.inline.others_exact', { pct: formatPctNumber(pool.totalUsedPct) })
        : t('weekly_attribution.inline.pool_unused');
  } else if (pool.localEstimatedUsedPct !== null) {
    state = 'attributed';
    const otherPct =
      pool.otherEstimatedUsedPct ?? Math.max(0, pool.totalUsedPct - pool.localEstimatedUsedPct);
    left = t('weekly_attribution.inline.local_used', {
      pct: formatPctNumber(pool.localEstimatedUsedPct),
    });
    right = t('weekly_attribution.inline.others_used', {
      pct: formatPctNumber(otherPct),
    });
  } else {
    state = 'calibrating';
    left = t('weekly_attribution.inline.local_calibrating');
    right = t('weekly_attribution.inline.pool_used', {
      pct: formatPctNumber(pool.totalUsedPct),
    });
  }

  const startStr = formatShortDateTime(pool.cycleStartSec) || '--';
  const endStr = formatShortDateTime(pool.resetTimeSec) || pool.resetTimeIso || '--';
  const sshPart =
    pool.sshRequests > 0
      ? t('weekly_attribution.tooltip.ssh_part', {
          requests: formatInteger(pool.sshRequests, locale),
          tokens: formatCompactTokens(pool.sshTokens, locale, true),
        })
      : '';
  const confidenceLabel = t(`weekly_attribution.confidence.${pool.confidence}`);
  const tooltip = [
    t('weekly_attribution.tooltip.cycle', { start: startStr, end: endStr }),
    t('weekly_attribution.tooltip.local_usage', {
      tokens: formatCompactTokens(pool.localTokens, locale, true),
      requests: formatInteger(pool.localRequests, locale),
      sshPart,
    }),
    t('weekly_attribution.tooltip.confidence', {
      confidence: confidenceLabel,
      samples: pool.calibrationSamples,
      snapshots: pool.snapshotCount,
    }),
    t('weekly_attribution.tooltip.passive_note'),
  ].join('\n');

  return { left, right, tooltip, state };
}
