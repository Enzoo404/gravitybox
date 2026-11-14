import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  applyFamilyWindows,
  buildArgonStatus,
  buildCarbonStatus,
  buildStandaloneModels,
  classifyFamily,
  familyWindowsFromGroups,
  familyModelQuotaFromModels,
  legacyFromFamilyWindows,
  mergeGroupSets,
  mergeModelCatalogues,
  mergeWindowStatuses,
  normalizeCloudGroups,
  normalizeCloudModels,
  normalizeResetTime,
  formatCountdown,
  normalizeStoredGroups,
  normalizeFraction,
  type ArgonStatus,
  type StandaloneModelStatus,
  type Family,
  type FamilyWindows,
  type NormalizedGroup,
  type NormalizedModel,
  type QuotaSource,
  type WindowKind,
  type WindowStatus,
} from './quota.js';

/** cloudcode 端点优先级：production(0) > daily(1) > sandbox(2)。 */
export function endpointPriority(url: string): number {
  if (url.includes('daily-cloudcode-pa.sandbox.googleapis.com')) return 2;
  if (url.includes('daily-cloudcode-pa.googleapis.com')) return 1;
  if (url.includes('cloudcode-pa.googleapis.com')) return 0;
  if (url.includes('oauth2.googleapis.com')) return 0;
  return 3;
}

export function endpointHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export function pickNextReset(
  familyWindows: FamilyWindows,
  window: '5h' | 'weekly',
  nowMs: number,
): { family: Family; resetTime: string; resetCountdown: string } | null {
  let best: { family: Family; resetTime: string; resetCountdown: string } | null = null;
  for (const family of ['gemini', 'claude', 'argon', 'carbon'] as const) {
    const pair = familyWindows[family];
    if (!pair) continue;
    const status = window === '5h' ? pair.fiveHour : pair.weekly;
    if (!status?.known || status.stale || !status.resetTime) continue;
    const parsed = Date.parse(status.resetTime);
    if (Number.isNaN(parsed)) continue;
    if (!best || parsed < Date.parse(best.resetTime)) {
      best = { family, resetTime: status.resetTime, resetCountdown: formatResetCountdown(status.resetTime, nowMs) };
    }
  }
  return best;
}

export function familyLabel(family: Family): string {
  return family === 'gemini' ? 'Gemini' : family === 'claude' ? 'Claude/GPT' : family === 'argon' ? 'Argon' : family === 'carbon' ? 'Carbon' : '其他';
}

/**
 * 格式化相对时间倒计时（如 "6天 16小时后重置"、"1小时 25分后重置"、"即将重置"、"重置时间已过"）
 * nowMs 允许同一份载荷使用同一参考时刻，避免同屏倒计时出现多个值。
 */
export function formatResetCountdown(resetTime: string | number | null | undefined, nowMs: number = Date.now()): string {
  return formatCountdown(resetTime, nowMs, { preserveUnparsed: true });
}

/** 供应商英文描述中的倒计时（如 "it will fully refresh in 4 hours, 29 minutes."）统一按 reset_time 现算。 */
function formatResetDurationEn(resetTime: string | number | null | undefined, nowMs: number): string | null {
  if (!resetTime) return null;
  const tsMs = typeof resetTime === 'number'
    ? (resetTime < 1e11 ? resetTime * 1000 : resetTime)
    : Date.parse(resetTime);
  if (isNaN(tsMs)) return null;
  const diffMs = tsMs - nowMs;
  if (diffMs <= 0) return '0 minutes';
  const totalMin = Math.max(0, Math.floor(diffMs / 60000));
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const mins = totalMin % 60;
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (days > 0) return `${plural(days, 'day')}${hours || mins ? `, ${plural(hours, 'hour')}` : ''}`;
  if (hours > 0) return `${plural(hours, 'hour')}${mins ? `, ${plural(mins, 'minute')}` : ''}`;
  return plural(mins, 'minute');
}

/**
 * 把英文配额描述里冻结的倒计时句子替换为按同一参考时刻重算的值，其余英文原文保持不变。
 * 覆盖 "in 4 hours, 29 minutes" / "in 4 hours" / "in 29 minutes" / "in 2 days" 等形态。
 */
export function refreshResetDescription(
  description: string | null | undefined,
  resetTime: string | number | null | undefined,
  nowMs: number = Date.now()
): string | undefined {
  if (!description) return description ?? undefined;
  const fresh = formatResetDurationEn(resetTime, nowMs);
  if (!fresh) return description;
  const duration = '(?:\\d+\\s*(?:days?|hours?|minutes?|seconds?))(?:\\s*(?:,|and)?\\s*\\d+\\s*(?:days?|hours?|minutes?|seconds?))*';
  const pattern = new RegExp(`(\\bin\\s+)${duration}`, 'i');
  if (!pattern.test(description)) return description;
  return description.replace(pattern, `$1${fresh}`);
}

export interface DeviceProfile {
  machine_id: string;
  mac_machine_id: string;
  dev_device_id: string;
  sqm_id: string;
}

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expiry_timestamp: number;
  token_type: string;
  email?: string | null;
  project_id?: string | null;
  oauth_client_key?: string | null;
  session_id?: string | null;
  is_gcp_tos: boolean;
  id_token?: string | null;
}

export interface QuotaBucket {
  bucket_id: string;
  /** 规范窗口：5h | weekly | unspecified（旧数据可能是任意原始字符串） */
  window: string;
  remaining_fraction: number;
  remaining_fraction_known?: boolean;
  percentage?: number | null;
  reset_time: string;
  reset_countdown?: string;
  display_name?: string;
  description?: string;
  observed_at?: number;
  last_updated?: number;
  observedAt?: number;
  family?: Family;
  stale?: boolean;
  source?: QuotaSource;
}

export interface QuotaGroup {
  display_name: string;
  description?: string;
  buckets: QuotaBucket[];
  observed_at?: number;
  last_updated?: number;
  observedAt?: number;
  family?: Family;
  stale?: boolean;
  source?: QuotaSource;
}

export interface ModelQuota {
  /** 兼容字段：模型 ID（实际 API id） */
  name: string;
  /** 兼容投影 = effective = min(own, 相关 family 已知新鲜窗口)；不覆盖 own 真值 */
  percentage: number;
  percentage_known?: boolean;
  observed_remaining_fraction?: number;
  quota_bucket_id?: string;
  reset_time: string;
  reset_countdown?: string;
  display_name?: string;
  supports_images?: boolean;
  supports_thinking?: boolean;
  thinking_budget?: number;
  recommended?: boolean;
  max_tokens?: number;
  max_output_tokens?: number;
  supported_mime_types?: Record<string, boolean>;
  // 扩展配额与模型状态字段（均可选，旧数据容错）
  model_id?: string;
  model_or_alias?: string | null;
  family?: Family;
  is_argon?: boolean;
  is_carbon?: boolean;
  disabled?: boolean | null;
  quota_source?: QuotaSource;
  stale?: boolean;
  own_percentage?: number | null;
  own_percentage_known?: boolean;
  own_reset_time?: string | null;
  own_observed_at?: number | null;
  own_stale?: boolean;
  family_5h?: WindowStatus | null;
  family_weekly?: WindowStatus | null;
  effective_percentage?: number | null;
  effective_known?: boolean;
}

export interface QuotaRefreshState {
  projectContextRecovered?: boolean;
  complete: boolean;
  endpointsAttempted: string[];
  endpointsSucceeded: string[];
  missingFamilies: Family[];
  missingWindows: { family: Family; window: WindowKind }[];
  carriedGroups: number;
  carriedModels?: number;
  refreshedAt: number;
  /** 本轮是否使用了非生产端点（daily/sandbox）作为数据来源 */
  usedFallbackEndpoint?: boolean;
  error?: string;
  providerOrigin?: string;
  providerUserAgent?: string;
  requestScope?: 'account';
}

export interface QuotaData {
  models: ModelQuota[];
  last_updated: number;
  is_forbidden: boolean;
  forbidden_reason?: string | null;
  subscription_tier?: string | null;
  model_forwarding_rules: Record<string, string>;
  quota_groups?: QuotaGroup[];
  source?: 'live' | 'cloud';
  /**
   * 本轮刷新未返回、沿用上次记录的分组：名称 + 该分组最后一次真实采样时间。
   * 存在该字段时顶层 last_updated 不再被刷新时刻覆盖，而是取最旧分组的观察时间。
   */
  stale_groups?: { name: string; observed_at: number }[];
  /** 本轮刷新完整性 / 端点来源 / 缺失 family 与窗口。 */
  refresh_state?: QuotaRefreshState;
  /** 机器可读告警码（前缀 CODE:）。 */
  quota_warnings?: string[];
}

export interface LiveLanguageServerStatus {
  email: string;
  name?: string | null;
  tier: string;
  accountType?: 'consumer' | 'enterprise_vertex' | 'unknown';
  userTierId?: string | null;
  userTierName?: string | null;
  quota: QuotaData;
}

export interface AccountSummary {
  id: string;
  email: string;
  name?: string | null;
  disabled: boolean;
  disabled_reason?: string | null;
  disabled_at?: number | null;
  protected_models: string[];
  created_at: number;
  last_used: number;
  custom_label?: string | null;
  quota?: QuotaData | null;
  quota_refresh_error?: string | null;
  revision?: string;
  quota_last_updated?: number;
  credentialReadiness?: ReturnType<typeof accountCredentialReadiness>;
}

/** 账号渲染指纹覆盖规范化配额快照（availability/disabled/own/family窗口/refresh_state/warnings）。 */
export function quotaSnapshotForRevision(quota: QuotaData | null | undefined): unknown {
  if (!quota) return null;
  const windowPart = (status: WindowStatus | null | undefined) => status
    ? [status.known ? '1' : '0', status.stale ? '1' : '0', status.remaining ?? '', status.resetTime ?? '', status.observedAt ?? '']
    : null;
  const models = (quota.models ?? []).map(model => {
    let family: Family = model.family ?? 'other';
    let disabled = model.disabled === undefined ? null : model.disabled;
    let isArgon = model.is_argon === true;
    let ownKnown = model.own_percentage_known === true;
    let own = model.own_percentage ?? null;
    try {
      const normalized = normalizedModelFromStored(model);
      family = normalized.family;
      disabled = normalized.disabled;
      isArgon = normalized.is_argon;
      ownKnown = normalized.own_percentage_known;
      own = normalized.own_percentage;
    } catch { /* 坏模型保持旧字段参与指纹 */ }
    return [
      model.model_id ?? model.name,
      model.display_name ?? model.name,
      family,
      isArgon ? '1' : '0',
      disabled === null ? 'n' : disabled ? 'd' : 'e',
      ownKnown ? '1' : '0', own,
      model.percentage_known ? '1' : '0', model.percentage,
      model.effective_known === true ? '1' : '0', model.effective_percentage ?? '',
      model.own_reset_time ?? '', model.reset_time ?? '', model.reset_countdown ?? '',
      model.own_observed_at ?? '', model.own_stale === true ? '1' : '0',
      windowPart(model.family_5h), windowPart(model.family_weekly),
      model.quota_source ?? '', model.stale === true ? '1' : '0',
    ];
  });
  const groups = (quota.quota_groups ?? []).map(group => [
    group.display_name,
    group.family ?? '',
    group.observed_at ?? '', group.source ?? '',
    group.stale === true ? '1' : '0',
    ...(group.buckets ?? []).flatMap(bucket => [
      bucket.bucket_id,
      bucket.window,
      bucket.remaining_fraction_known === false ? '0' : '1',
      bucket.remaining_fraction,
      bucket.reset_time ?? '',
      bucket.observed_at ?? '', bucket.source ?? '',
      bucket.stale === true ? '1' : '0',
    ]),
  ]);
  const refresh = quota.refresh_state ? [
    quota.refresh_state.complete ? '1' : '0',
    (quota.refresh_state.missingFamilies ?? []).join(','),
    (quota.refresh_state.missingWindows ?? []).map(item => `${item.family}:${item.window}`).join(','),
    quota.refresh_state.carriedGroups,
    quota.refresh_state.carriedModels ?? 0,
    quota.refresh_state.usedFallbackEndpoint ? '1' : '0',
  ] : null;
  return {
    last_updated: quota.last_updated,
    tier: quota.subscription_tier ?? '',
    source: quota.source ?? '',
    models,
    groups,
    stale_groups: (quota.stale_groups ?? []).map(item => [item.name, item.observed_at]),
    refresh_state: refresh,
    quota_warnings: quota.quota_warnings ?? [],
  };
}

export function computeAccountRevision(account: Account | AccountSummary): string {
  const parts: string[] = [
    account.id,
    account.email,
    account.name ?? '',
    account.custom_label ?? '',
    account.disabled ? '1' : '0',
    account.quota_refresh_error ?? '',
  ];
  const snapshot = quotaSnapshotForRevision(account.quota);
  parts.push(snapshot ? JSON.stringify(snapshot) : '0');
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

export interface Account {
  id: string;
  email: string;
  name?: string | null;
  token: TokenData;
  device_profile?: DeviceProfile | null;
  quota?: QuotaData | null;
  quota_refresh_error?: string | null;
  insiders_quota?: QuotaData | null;
  insiders_quota_refresh_error?: string | null;
  disabled: boolean;
  disabled_reason?: string | null;
  disabled_at?: number | null;
  protected_models: string[];
  validation_blocked: boolean;
  validation_blocked_until?: number | null;
  validation_blocked_reason?: string | null;
  validation_url?: string | null;
  created_at: number;
  last_used: number;
  custom_label?: string | null;
}

export function accountCredentialReadiness(account: Account, now = Date.now() / 1000): { state: 'ready' | 'needs_refresh' | 'needs_authorization'; message: string } {
  if (/invalid_grant|授权.*(?:失效|过期)|重新(?:登录|授权)|HTTP\s*401/i.test(account.quota_refresh_error ?? ''))
    return { state: 'needs_authorization', message: '请重新授权后再切换' };
  if (!account.token?.access_token || account.token.access_token === 'pending_refresh' || !Number.isFinite(account.token.expiry_timestamp) || account.token.expiry_timestamp <= now + 30)
    return { state: 'needs_refresh', message: '切换前请刷新登录凭据；当前运行账号可重新保存当前账号' };
  return { state: 'ready', message: '登录凭据可用于切换' };
}

export interface AccountIndex {
  version: string;
  accounts: AccountSummary[];
  current_account_id: string | null;
  current_target_ide?: string | null;
  current_ide_account_id?: string | null;
  current_vscode_account_id?: string | null;
}

export type AutoSwitchStrategy = 'priority' | 'round_robin';

export interface AutoSwitchConfig {
  enabled: boolean;
  strategy: AutoSwitchStrategy;
  reserve_percentage: number;       // 触发切号的低额度红线，默认 10%
  reservePercentage?: number;
  candidate_min_percentage: number; // 准入最低额度，默认 30%
  candidateMinPercentage?: number;
  monitored_model: string;          // 默认 "all" 或具体模型
  candidate_account_ids: string[];  // 允许作为轮换目标的账号池
  last_switched_id?: string;        // 游标状态持久化：最近一次轮换选择的账号 ID
}

export function generateDeviceProfile(): DeviceProfile {
  const hex = (len: number) => randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
  return {
    machine_id: hex(64),
    mac_machine_id: hex(64),
    dev_device_id: randomUUID(),
    sqm_id: `{${randomUUID().toUpperCase()}}`,
  };
}

export function sanitizeJsonString(raw: Buffer | string): string {
  let str = typeof raw === 'string' ? raw : raw.toString('utf8');
  // Strip UTF-8 BOM
  if (str.charCodeAt(0) === 0xfeff) {
    str = str.slice(1);
  }
  // Strip leading NUL bytes and control characters
  return str.replace(/^[\u0000\s]+/, '');
}

/** 规范化与持久化配额结构转换（集中在 accounts 边界的适配层）。 */
export function modelQuotaFromNormalized(model: NormalizedModel): ModelQuota {
  return {
    ...model,
    reset_countdown: model.reset_time ? formatResetCountdown(model.reset_time) : '',
  } as ModelQuota;
}

export function groupToQuotaGroup(group: NormalizedGroup): QuotaGroup {
  return {
    display_name: group.display_name,
    description: group.description,
    observed_at: group.observed_at ?? undefined,
    observedAt: group.observed_at ?? undefined,
    last_updated: group.observed_at ?? undefined,
    family: group.family,
    stale: group.stale,
    source: group.source,
    buckets: group.buckets.map(bucket => ({
      bucket_id: bucket.bucket_id,
      window: bucket.window,
      remaining_fraction: bucket.remaining_fraction ?? 0,
      remaining_fraction_known: bucket.remaining_fraction_known,
      percentage: bucket.percentage,
      reset_time: bucket.reset_time ?? '',
      display_name: bucket.display_name,
      description: bucket.description,
      observed_at: bucket.observed_at ?? undefined,
      observedAt: bucket.observed_at ?? undefined,
      last_updated: bucket.observed_at ?? undefined,
      family: group.family,
      stale: bucket.stale,
      source: bucket.source,
    })),
  };
}

/** 已持久化 ModelQuota（旧数据可能没有 own_* 字段）→ NormalizedModel 容错读取。 */
export function normalizedModelFromStored(model: ModelQuota, fallbackSource: QuotaSource = 'cloud'): NormalizedModel {
  const known = model.own_percentage_known ?? model.percentage_known === true;
  const ownPercentage = model.own_percentage_known !== undefined
    ? (model.own_percentage ?? null)
    : (model.percentage_known ? Math.round(model.percentage) : null);
  const displayName = model.display_name ?? null;
  const reclassified = classifyFamily({ modelId: model.name, displayName, modelOrAlias: model.model_or_alias });
  const family: Family = !model.family || model.family === 'other' ? reclassified : model.family;
  const ownKnown = (model.own_percentage_known ?? known) && ownPercentage !== null
    && Number.isFinite(ownPercentage) && ownPercentage >= 0 && ownPercentage <= 100;
  const percentage = model.effective_known !== undefined
    ? (model.effective_percentage ?? null)
    : (model.percentage_known ? model.percentage : null);
  return {
    name: model.name,
    model_id: model.model_id ?? model.name,
    display_name: displayName,
    family,
    is_carbon: model.is_carbon ?? family === 'carbon', is_argon: model.is_argon ?? family === 'argon',
    disabled: typeof model.disabled === 'boolean' ? model.disabled
      : /(?:^|[-_])disabled(?:$|[-_])/i.test(model.model_id ?? model.name) ? true : null,
    model_or_alias: model.model_or_alias ?? null,
    own_percentage: ownKnown ? ownPercentage : null,
    own_percentage_known: ownKnown,
    own_reset_time: normalizeResetTime(model.own_reset_time ?? model.reset_time),
    own_observed_at: model.own_observed_at ?? null,
    own_stale: model.own_stale ?? model.stale === true,
    family_5h: (model.family_5h ?? null) as WindowStatus | null,
    family_weekly: (model.family_weekly ?? null) as WindowStatus | null,
    percentage: percentage ?? 0,
    percentage_known: percentage !== null,
    effective_percentage: percentage,
    effective_known: percentage !== null,
    reset_time: model.reset_time ?? '',
    quota_bucket_id: model.quota_bucket_id,
    quota_source: model.quota_source ?? fallbackSource,
    stale: model.stale === true,
    supports_images: model.supports_images,
    supports_thinking: model.supports_thinking,
    thinking_budget: model.thinking_budget,
    recommended: model.recommended,
    max_tokens: model.max_tokens,
    max_output_tokens: model.max_output_tokens,
    supported_mime_types: model.supported_mime_types,
  };
}

export interface QuotaOverviewWindowStatus extends WindowStatus {
  resetCountdown: string;
}

export interface QuotaOverview {
  // legacy 兼容字段
  fiveHourRemaining: number | null;
  weeklyRemaining: number | null;
  geminiFiveHourRemaining: number | null;
  geminiWeeklyRemaining: number | null;
  geminiFiveHourResetCountdown: string;
  geminiWeeklyResetCountdown: string;
  geminiResetCountdown: string;
  claudeFiveHourRemaining: number | null;
  claudeWeeklyRemaining: number | null;
  claudeFiveHourResetCountdown: string;
  claudeWeeklyResetCountdown: string;
  claudeResetCountdown: string;
  argonWeeklyRemaining: number | null;
  argonWeeklyResetCountdown: string;
  argonResetCountdown: string;
  carbonWeeklyRemaining: number | null;
  carbonWeeklyResetCountdown: string;
  carbonResetCountdown: string;
  /** 5h 优先（任一家族最早）；无 5h 才 weekly；绝不跨周期混取最小。 */
  resetTime: number | null;
  resetCountdown: string;
  subscriptionTier: string;
  quotaGroups: QuotaGroup[];
  staleGroups: { name: string; observed_at: number }[];
  unknownBuckets: { group: string; bucket: string }[];
  models: ModelQuota[];
  lastUpdated: number | null;
  isStale: boolean;
  staleHours: number;
  // 规范化配额详情字段
  argonStatus: ArgonStatus;
  carbonStatus: ArgonStatus;
  standaloneModels: StandaloneModelStatus[];
  familyWindows: {
    gemini: { fiveHour: QuotaOverviewWindowStatus | null; weekly: QuotaOverviewWindowStatus | null };
    claude: { fiveHour: QuotaOverviewWindowStatus | null; weekly: QuotaOverviewWindowStatus | null };
    argon: { fiveHour: QuotaOverviewWindowStatus | null; weekly: QuotaOverviewWindowStatus | null };
    carbon: { fiveHour: QuotaOverviewWindowStatus | null; weekly: QuotaOverviewWindowStatus | null };
  };
  familyModelQuota: Record<'gemini' | 'claude', QuotaOverviewWindowStatus | null>;
  nextResets: {
    fiveHour: { family: Family; resetTime: string; resetCountdown: string } | null;
    weekly: { family: Family; resetTime: string; resetCountdown: string } | null;
  };
  refreshState: QuotaRefreshState;
  quotaWarnings: string[];
  quotaWarningCodes: string[];
}

export function fuseQuotaData(fetchAvailableModelsData: any, quotaSummaryData?: any): QuotaData {
  const observedAt = Math.floor(Date.now() / 1000);
  const models = mergeModelCatalogues([normalizeCloudModels(fetchAvailableModelsData ?? {}, observedAt)]);
  const groups = mergeGroupSets([normalizeCloudGroups(quotaSummaryData ?? {}, observedAt)]);
  const windows = familyWindowsFromGroups(groups, Date.now());
  const applied = applyFamilyWindows(models, windows);
  const forwarding: Record<string, string> = {};
  const deprecated = fetchAvailableModelsData?.deprecatedModelIds;
  if (deprecated && typeof deprecated === 'object') {
    for (const [oldId, info] of Object.entries<any>(deprecated)) {
      if (info?.newModelId) forwarding[oldId] = String(info.newModelId);
    }
  }
  return {
    models: applied.map(modelQuotaFromNormalized),
    last_updated: observedAt,
    is_forbidden: false,
    model_forwarding_rules: forwarding,
    quota_groups: groups.map(groupToQuotaGroup),
    source: 'cloud',
    refresh_state: {
      complete: models.length > 0,
      endpointsAttempted: ['fuseQuota'],
      endpointsSucceeded: ['fuseQuota'],
      missingFamilies: [],
      missingWindows: [],
      carriedGroups: 0,
      refreshedAt: observedAt,
    },
  };
}

export function computeAccountRemaining(account: Account, monitoredModel = 'all'): number | null {
  if (account.disabled || account.validation_blocked || account.quota?.is_forbidden) return null;
  const quota = account.quota;
  if (!quota || !Array.isArray(quota.models)) return null;

  const overview = buildAccountQuotaOverview(account);
  const nowSec = Date.now() / 1000;
  const FRESH_SECONDS = 900;

  const freshFraction = (status: WindowStatus | null | undefined): number | null => {
    if (!status?.known || status.stale || status.remaining === null) return null;
    if (typeof status.observedAt === 'number' && nowSec - status.observedAt > FRESH_SECONDS) return null;
    return status.remaining;
  };
  const familyValues = (family: 'gemini' | 'claude'): number[] => {
    const windows = overview.familyWindows[family];
    const own = overview.models.filter(model => model.family === family && model.disabled !== true
      && model.stale !== true && model.own_stale !== true && model.own_percentage_known === true
      && typeof model.own_percentage === 'number').map(model => model.own_percentage! / 100);
    return [freshFraction(windows.fiveHour), freshFraction(windows.weekly), ...own]
      .filter((value): value is number => value !== null);
  };
  const bounded = (fraction: number): number => Math.max(0, Math.min(100, Math.round(fraction * 100)));
  const modelsOfFamily = (family: 'gemini' | 'claude') => overview.models.filter(model => (model.family ?? classifyFamily({ modelId: model.name, displayName: model.display_name })) === family);
  const familyHasKnownModel = (family: 'gemini' | 'claude') => modelsOfFamily(family).some(model => model.effective_known === true && model.stale !== true);

  const trimmed = monitoredModel.trim().toLowerCase();
  const isArgonTarget = trimmed === 'argon' || trimmed === 'gemini 4 argon';
  const isCarbonTarget = trimmed === 'carbon' || trimmed === 'gemini 4 carbon';
  const isClaudeTarget = trimmed === 'claude' || trimmed === '3p' || trimmed === 'claude/gpt';
  const isGeminiTarget = trimmed === 'gemini';
  const isGeminiAllTarget = trimmed === 'gemini_all' || trimmed === 'gemini 全系模型';
  const isAllTarget = !trimmed || trimmed === 'all';

  // 具体模型或动态新增独立模型：优先匹配 standaloneModels，其次使用规范化后的 effective（= min(own, 相关 family 新鲜窗口)）
  if (!isArgonTarget && !isCarbonTarget && !isClaudeTarget && !isGeminiTarget && !isGeminiAllTarget && !isAllTarget) {
    const standalone = (overview.standaloneModels ?? []).find(item =>
      item.key.toLowerCase() === trimmed || item.displayName.toLowerCase() === trimmed);
    if (standalone) {
      if (standalone.availability !== 'available') return null;
      if (standalone.quotaState !== 'known' || standalone.remaining === null) return null;
      if (typeof standalone.observedAt === 'number' && nowSec - standalone.observedAt > FRESH_SECONDS) return null;
      return bounded(standalone.remaining);
    }
    const model = overview.models.find(item =>
      (item.model_id ?? item.name).toLowerCase() === trimmed
      || (item.display_name ?? '').toLowerCase() === trimmed);
    if (!model || model.disabled === true || model.stale === true) return null;
    if (model.effective_known !== true || model.effective_percentage === null) return null;
    const observed = [model.family_5h, model.family_weekly].filter(status => status?.known && !status.stale).map(status => status!.observedAt).find(value => typeof value === 'number') ?? (!model.own_stale ? model.own_observed_at : null);
    if (typeof observed === 'number' && nowSec - observed > FRESH_SECONDS) return null;
    return bounded((model.effective_percentage ?? 0) / 100);
  }

  if (isArgonTarget) {
    const status = overview.argonStatus;
    // 未知/禁用不是“0%”，但也不能作为可切换依据；必须由明确模型记录 + 已知新鲜额度支撑。
    if (status.availability !== 'available') return null;
    if (status.quotaState !== 'known' || status.remaining === null) return null;
    if (typeof status.observedAt === 'number' && nowSec - status.observedAt > FRESH_SECONDS) return null;
    return bounded(status.remaining);
  }

  if (isCarbonTarget) {
    const status = overview.carbonStatus;
    if (status.availability !== 'available') return null;
    if (status.quotaState !== 'known' || status.remaining === null) return null;
    if (typeof status.observedAt === 'number' && nowSec - status.observedAt > FRESH_SECONDS) return null;
    return bounded(status.remaining);
  }

  if (isGeminiAllTarget) {
    const values: number[] = [];
    if (familyHasKnownModel('gemini')) {
      values.push(...familyValues('gemini'));
    }
    for (const status of [overview.argonStatus, overview.carbonStatus]) {
      if (
        status.availability === 'available' &&
        status.quotaState === 'known' &&
        status.remaining !== null &&
        (typeof status.observedAt !== 'number' || nowSec - status.observedAt <= FRESH_SECONDS)
      ) {
        values.push(status.remaining);
      }
    }
    for (const extra of overview.standaloneModels ?? []) {
      const keyLower = extra.key.toLowerCase();
      if (keyLower === 'argon' || keyLower === 'carbon') continue;
      const nameLower = extra.displayName.toLowerCase();
      if (!keyLower.includes('gemini') && !nameLower.includes('gemini')) continue;
      if (
        extra.availability === 'available' &&
        extra.quotaState === 'known' &&
        extra.remaining !== null &&
        (typeof extra.observedAt !== 'number' || nowSec - extra.observedAt <= FRESH_SECONDS)
      ) {
        values.push(extra.remaining);
      }
    }
    if (values.length === 0) return null;
    if (values.some(value => value <= 0)) return 0;
    return bounded(Math.min(...values));
  }
  if (isGeminiTarget) {
    if (!familyHasKnownModel('gemini')) return null;
    const values = familyValues('gemini');
    return values.length > 0 ? bounded(Math.min(...values)) : null;
  }
  if (isClaudeTarget) {
    if (!familyHasKnownModel('claude')) return null;
    const values = familyValues('claude');
    return values.length > 0 ? bounded(Math.min(...values)) : null;
  }

  // all：优先统计核心主力模型家族（Gemini + Claude/GPT），避免实验性 Argon / Carbon 单项偏低把主力充裕账号误判为耗尽；
  // 仅当账号没有任何已知 Gemini/Claude 模型记录时才回退参考 Argon / Carbon。
  const gemini = familyHasKnownModel('gemini') ? familyValues('gemini') : [];
  const claude = familyHasKnownModel('claude') ? familyValues('claude') : [];
  const argonStatus = overview.argonStatus;
  const argonFresh = argonStatus.availability === 'available'
    && argonStatus.quotaState === 'known'
    && argonStatus.remaining !== null
    && (typeof argonStatus.observedAt !== 'number' || nowSec - argonStatus.observedAt <= FRESH_SECONDS)
    ? [argonStatus.remaining]
    : [];
  const carbonStatus = overview.carbonStatus;
  const carbonFresh = carbonStatus.availability === 'available'
    && carbonStatus.quotaState === 'known'
    && carbonStatus.remaining !== null
    && (typeof carbonStatus.observedAt !== 'number' || nowSec - carbonStatus.observedAt <= FRESH_SECONDS)
    ? [carbonStatus.remaining]
    : [];
  const core = [...gemini, ...claude];
  const all = core.length > 0 ? core : [...argonFresh, ...carbonFresh];
  if (all.length === 0) return null;
  if (all.some(value => value <= 0)) return 0;
  return bounded(Math.min(...all));
}

export function subscriptionTierRank(account: Account | AccountSummary | null | undefined): number {
  if (!account) return 0;
  const raw = String(account.quota?.subscription_tier ?? '').toUpperCase();
  if (raw.includes('ULTRA')) return 4;
  if (raw.includes('PRO')) return 3;
  if (raw.includes('FREE') || raw.includes('STARTER')) return 1;
  return 2;
}

export function buildAccountQuotaOverview(account: Account | AccountSummary | { quota?: QuotaData | null }, options?: { nowMs?: number }): QuotaOverview {
  const nowMs = options?.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const emptyArgon: ArgonStatus = {
    availability: 'unknown',
    quotaState: 'not_reported',
    period: null,
    remaining: null,
    resetCountdown: '',
    message: '尚未取得账号配额数据',
    observedAt: null,
  };
  const emptyRefresh: QuotaRefreshState = {
    complete: false,
    endpointsAttempted: [],
    endpointsSucceeded: [],
    missingFamilies: [],
    missingWindows: [],
    carriedGroups: 0,
    refreshedAt: 0,
  };
  const quota = account.quota;
  if (!quota) {
    return {
      fiveHourRemaining: null, weeklyRemaining: null,
      geminiFiveHourRemaining: null, geminiWeeklyRemaining: null,
      geminiFiveHourResetCountdown: '', geminiWeeklyResetCountdown: '', geminiResetCountdown: '',
      claudeFiveHourRemaining: null, claudeWeeklyRemaining: null,
      claudeFiveHourResetCountdown: '', claudeWeeklyResetCountdown: '', claudeResetCountdown: '',
      argonWeeklyRemaining: null, argonWeeklyResetCountdown: '', argonResetCountdown: '',
      carbonWeeklyRemaining: null, carbonWeeklyResetCountdown: '', carbonResetCountdown: '',
      resetTime: null, resetCountdown: '',
      subscriptionTier: '待确认', quotaGroups: [], staleGroups: [], unknownBuckets: [], models: [],
      lastUpdated: null, isStale: false, staleHours: 0,
      argonStatus: emptyArgon,
      carbonStatus: emptyArgon,
      standaloneModels: [
        { key: 'argon', displayName: 'Gemini 4 Argon', ...emptyArgon },
        { key: 'carbon', displayName: 'Gemini 4 Carbon', ...emptyArgon },
      ],
      familyWindows: {
        gemini: { fiveHour: null, weekly: null }, claude: { fiveHour: null, weekly: null }, argon: { fiveHour: null, weekly: null }, carbon: { fiveHour: null, weekly: null },
      },
      familyModelQuota: { gemini: null, claude: null },
      nextResets: { fiveHour: null, weekly: null },
      refreshState: emptyRefresh,
      quotaWarnings: ['NO_QUOTA: 尚未取得账号配额数据'],
      quotaWarningCodes: ['NO_QUOTA'],
    };
  }

  const warnings: string[] = [];
  const codes: string[] = [];
  const sourceDefault: QuotaSource = quota.source === 'live' ? 'live' : 'cloud';
  const rawGroups = Array.isArray(quota.quota_groups) ? quota.quota_groups : [];
  let groups: NormalizedGroup[] = [];
  try {
    groups = normalizeStoredGroups(rawGroups, quota.last_updated ?? nowSec, sourceDefault);
    if (rawGroups.length > groups.length) {
      warnings.push(`MALFORMED_GROUPS: ${rawGroups.length - groups.length} 个配额分组结构异常已跳过`);
      codes.push('MALFORMED_GROUPS');
    }
  } catch {
    warnings.push('GROUPS_PARSE_FAILED: 配额分组无法解析，已按未知处理');
    codes.push('GROUPS_PARSE_FAILED');
    groups = [];
  }

  const rawModels = Array.isArray(quota.models) ? quota.models : [];
  const models: NormalizedModel[] = [];
  for (let index = 0; index < rawModels.length; index++) {
    try {
      const model = normalizedModelFromStored(rawModels[index]!, sourceDefault);
      const observed = model.own_observed_at ?? quota.last_updated;
      model.own_observed_at = observed ?? null;
      model.own_stale = model.own_stale || (typeof observed === 'number' && nowSec - observed > 900)
        || (!!model.own_reset_time && Date.parse(model.own_reset_time) <= nowMs);
      for (const key of ['family_5h', 'family_weekly'] as const) {
        const status = model[key];
        if (!status) continue;
        const remaining = normalizeFraction(status.remaining);
        model[key] = { ...status, remaining, known: status.known === true && remaining !== null,
          observedAt: status.observedAt ?? observed ?? null,
          stale: status.stale || (typeof (status.observedAt ?? observed) === 'number' && nowSec - (status.observedAt ?? observed)! > 900)
            || (!!status.resetTime && Date.parse(status.resetTime) <= nowMs) };
      }
      models.push(model);
    } catch {
      warnings.push(`MALFORMED_MODEL:${index}: 模型记录结构异常已跳过`);
      codes.push('MALFORMED_MODEL');
    }
  }

  const familyWindows = familyWindowsFromGroups(groups, nowMs);
  for (const family of ['gemini', 'claude', 'argon', 'carbon'] as const) {
    const familyModels = models.filter(model => model.family === family);
    if (!familyWindows[family].fiveHour) {
      const merged = mergeWindowStatuses(...familyModels.map(model => model.family_5h ?? null));
      if (merged) familyWindows[family].fiveHour = merged;
    }
    if (!familyWindows[family].weekly) {
      const merged = mergeWindowStatuses(...familyModels.map(model => model.family_weekly ?? null));
      if (merged) familyWindows[family].weekly = merged;
    }
    // A model's own reset time does not identify a family window. Missing periods stay unknown.
  }

  const applied = applyFamilyWindows(models, familyWindows);
  const legacy = legacyFromFamilyWindows(familyWindows, nowMs);
  const argonStatus = buildArgonStatus(applied, groups, familyWindows, nowMs);
  const carbonStatus = buildCarbonStatus(applied, groups, familyWindows, nowMs, argonStatus, quota.subscription_tier);
  const standaloneModels = buildStandaloneModels(applied, groups, familyWindows, nowMs, argonStatus, carbonStatus, quota.subscription_tier);
  const nextFiveHour = pickNextReset(familyWindows, '5h', nowMs);
  const nextWeekly = pickNextReset(familyWindows, 'weekly', nowMs);
  const resetPick = nextFiveHour ?? nextWeekly;
  const resetTime = resetPick ? Math.floor(Date.parse(resetPick.resetTime) / 1000) : null;
  const resetCountdown = resetPick?.resetCountdown ?? '';

  const staleGroups = (quota.stale_groups ?? []).map(item => ({ name: item.name, observed_at: item.observed_at }));
  const unknownBuckets = groups.flatMap(group => group.buckets
    .filter(bucket => !bucket.remaining_fraction_known)
    .map(bucket => ({ group: group.display_name, bucket: bucket.bucket_id || bucket.window })));

  const knownFreshGroups = groups.filter(group => group.buckets.some(bucket => bucket.remaining_fraction_known && !bucket.stale));
  const derivedMissingFamilies = (['gemini', 'claude'] as Family[]).filter(family =>
    models.some(model => model.family === family) && !knownFreshGroups.some(group => group.family === family));
  const storedRefresh = quota.refresh_state;
  const refreshState: QuotaRefreshState = storedRefresh
    ? {
      complete: storedRefresh.complete === true,
      projectContextRecovered: storedRefresh.projectContextRecovered === true,
      endpointsAttempted: Array.isArray(storedRefresh.endpointsAttempted) ? storedRefresh.endpointsAttempted : [],
      endpointsSucceeded: Array.isArray(storedRefresh.endpointsSucceeded) ? storedRefresh.endpointsSucceeded : [],
      missingFamilies: Array.isArray(storedRefresh.missingFamilies) ? storedRefresh.missingFamilies : [],
      missingWindows: Array.isArray(storedRefresh.missingWindows) ? storedRefresh.missingWindows : [],
      carriedGroups: Number(storedRefresh.carriedGroups) || 0,
      carriedModels: Number(storedRefresh.carriedModels) || 0,
      refreshedAt: Number(storedRefresh.refreshedAt) || 0,
      usedFallbackEndpoint: storedRefresh.usedFallbackEndpoint === true,
      ...(storedRefresh.error ? { error: String(storedRefresh.error) } : {}),
    }
    : {
      complete: knownFreshGroups.length > 0 && models.length > 0,
      endpointsAttempted: [],
      endpointsSucceeded: [],
      missingFamilies: derivedMissingFamilies,
      missingWindows: [],
      carriedGroups: staleGroups.length,
      refreshedAt: typeof quota.last_updated === 'number' ? quota.last_updated : 0,
    };

  if (argonStatus.availability === 'disabled') {
    warnings.push('ARGON_DISABLED: 当前账号无 Gemini 4 Argon 权限');
    codes.push('ARGON_DISABLED');
  }
  if (argonStatus.availability === 'unknown') {
    warnings.push(argonStatus.message);
    codes.push('ARGON_UNKNOWN');
  }
  if (argonStatus.availability === 'available' && argonStatus.quotaState === 'not_reported') {
    warnings.push('ARGON_QUOTA_NOT_REPORTED: 存在 Argon 模型记录但本轮未返回配额数值');
    codes.push('ARGON_QUOTA_NOT_REPORTED');
  }
  if (argonStatus.quotaState === 'stale') {
    warnings.push('ARGON_STALE: Argon 配额本轮未返回，展示上次真实采样');
    codes.push('ARGON_STALE');
  }
  for (const family of refreshState.missingFamilies) {
    warnings.push(`MISSING_FAMILY:${family}: ${familyLabel(family)} 配额未取得`);
    codes.push(`MISSING_FAMILY:${family}`);
  }
  for (const item of refreshState.missingWindows) {
    warnings.push(`MISSING_WINDOW:${item.family}:${item.window}: ${familyLabel(item.family)} ${item.window} 窗口未取得`);
    codes.push(`MISSING_WINDOW:${item.family}:${item.window}`);
  }
  if (staleGroups.length > 0) {
    warnings.push(`CARRIED_GROUPS:${staleGroups.length}: ${staleGroups.map(item => item.name).join('、')} 沿用上次记录`);
    codes.push('CARRIED_GROUPS');
  }
  for (const warning of quota.quota_warnings ?? []) if (!warnings.includes(warning)) warnings.push(warning);

  const legacySnapshot = legacy;
  let oldestGroup = typeof quota.last_updated === 'number' ? quota.last_updated : null;
  let oldestBucket: number | null = null;
  for (const group of groups) {
    if (typeof group.observed_at === 'number' && (oldestGroup === null || group.observed_at < oldestGroup)) oldestGroup = group.observed_at;
    for (const bucket of group.buckets) {
      if (typeof bucket.observed_at === 'number' && (oldestBucket === null || bucket.observed_at < oldestBucket)) oldestBucket = bucket.observed_at;
    }
  }
  const oldest = oldestBucket !== null && (oldestGroup === null || oldestBucket < oldestGroup) ? oldestBucket : oldestGroup;
  const isStale = oldest !== null ? nowSec - oldest > 15 * 60 : false;
  const staleHours = oldestGroup !== null ? Math.max(0, Math.floor((nowSec - oldestGroup) / 3600)) : 0;

  const windowOut = (status: WindowStatus | null): QuotaOverviewWindowStatus | null => status
    ? { ...status, resetCountdown: status.resetTime ? formatResetCountdown(status.resetTime, nowMs) : '' }
    : null;
  const modelQuota = familyModelQuotaFromModels(models);

  const outModels: ModelQuota[] = applied.map(model => ({
    ...modelQuotaFromNormalized(model),
    reset_countdown: model.reset_time ? formatResetCountdown(model.reset_time, nowMs) : '',
  }));
  const outGroups: QuotaGroup[] = groups.map(group => {
    const mapped = groupToQuotaGroup(group);
    return {
      ...mapped,
      buckets: mapped.buckets.map(bucket => ({
        ...bucket,
        reset_countdown: bucket.reset_time ? formatResetCountdown(bucket.reset_time, nowMs) : '',
        description: refreshResetDescription(bucket.description, bucket.reset_time, nowMs),
      })),
    };
  });

  return {
    fiveHourRemaining: legacySnapshot.geminiFiveHourRemaining,
    weeklyRemaining: legacySnapshot.geminiWeeklyRemaining,
    geminiFiveHourRemaining: legacySnapshot.geminiFiveHourRemaining,
    geminiWeeklyRemaining: legacySnapshot.geminiWeeklyRemaining,
    geminiFiveHourResetCountdown: legacySnapshot.geminiFiveHourResetCountdown,
    geminiWeeklyResetCountdown: legacySnapshot.geminiWeeklyResetCountdown,
    geminiResetCountdown: legacySnapshot.geminiFiveHourResetCountdown || legacySnapshot.geminiWeeklyResetCountdown,
    claudeFiveHourRemaining: legacySnapshot.claudeFiveHourRemaining,
    claudeWeeklyRemaining: legacySnapshot.claudeWeeklyRemaining,
    claudeFiveHourResetCountdown: legacySnapshot.claudeFiveHourResetCountdown,
    claudeWeeklyResetCountdown: legacySnapshot.claudeWeeklyResetCountdown,
    claudeResetCountdown: legacySnapshot.claudeWeeklyResetCountdown || legacySnapshot.claudeFiveHourResetCountdown,
    argonWeeklyRemaining: legacySnapshot.argonWeeklyRemaining,
    argonWeeklyResetCountdown: legacySnapshot.argonWeeklyResetCountdown,
    argonResetCountdown: legacySnapshot.argonWeeklyResetCountdown,
    carbonWeeklyRemaining: legacySnapshot.carbonWeeklyRemaining,
    carbonWeeklyResetCountdown: legacySnapshot.carbonWeeklyResetCountdown,
    carbonResetCountdown: legacySnapshot.carbonWeeklyResetCountdown,
    resetTime,
    resetCountdown,
    subscriptionTier: quota.subscription_tier && /starter/i.test(quota.subscription_tier) ? '' : quota.subscription_tier || '待确认',
    quotaGroups: outGroups,
    staleGroups,
    unknownBuckets,
    models: outModels,
    lastUpdated: typeof quota.last_updated === 'number' ? quota.last_updated : null,
    isStale,
    staleHours,
    argonStatus,
    carbonStatus,
    standaloneModels,
    familyWindows: {
      gemini: { fiveHour: windowOut(familyWindows.gemini.fiveHour), weekly: windowOut(familyWindows.gemini.weekly) },
      claude: { fiveHour: windowOut(familyWindows.claude.fiveHour), weekly: windowOut(familyWindows.claude.weekly) },
      argon: { fiveHour: windowOut(familyWindows.argon.fiveHour), weekly: windowOut(familyWindows.argon.weekly) },
      carbon: { fiveHour: windowOut(familyWindows.carbon.fiveHour), weekly: windowOut(familyWindows.carbon.weekly) },
    },
    familyModelQuota: { gemini: windowOut(modelQuota.gemini), claude: windowOut(modelQuota.claude) },
    nextResets: {
      fiveHour: nextFiveHour ? { family: nextFiveHour.family, resetTime: nextFiveHour.resetTime, resetCountdown: nextFiveHour.resetCountdown } : null,
      weekly: nextWeekly ? { family: nextWeekly.family, resetTime: nextWeekly.resetTime, resetCountdown: nextWeekly.resetCountdown } : null,
    },
    refreshState,
    quotaWarnings: warnings,
    quotaWarningCodes: codes,
  };
}

/**
 * IPC 投影：账号对象中只有 token 是敏感字段，原生端不消费 token（仅后端刷新/切号链路使用）。
 * 所有 account_* / quota_refresh / auto_switch_best 的对外返回统一经过此函数，避免 access/refresh/id token
 * 进入原生内存、桥接日志或 `--command` 标准输出。
 */
export function projectAccountForIpc(account: Account | AccountSummary | null | undefined): Record<string, any> | null {
  if (!account) return null;
  const summary = account as AccountSummary;
  const quota = summary.quota ?? null;
  return {
    id: summary.id,
    email: summary.email,
    name: summary.name ?? null,
    custom_label: summary.custom_label ?? null,
    disabled: Boolean(summary.disabled),
    disabled_reason: summary.disabled_reason ?? null,
    disabled_at: summary.disabled_at ?? null,
    protected_models: Array.isArray(summary.protected_models) ? summary.protected_models : [],
    validation_blocked: Boolean((summary as Account).validation_blocked),
    created_at: summary.created_at ?? null,
    last_used: summary.last_used ?? null,
    quota,
    credentialReadiness: summary.credentialReadiness ?? accountCredentialReadiness(account as Account),
    quota_refresh_error: summary.quota_refresh_error ?? null,
    quota_last_updated: summary.quota_last_updated ?? quota?.last_updated ?? 0,
    subscription_tier: quota?.subscription_tier ?? null,
    revision: summary.revision ?? computeAccountRevision(summary),
  };
}
