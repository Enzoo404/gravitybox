/**
 * 配额规范化 / 窗口融合纯 helper（无 I/O、无网络）。
 *
 * 设计原则（task-38）：
 * - live（language_server RPC）与 cloud（cloudcode REST）共用同一套规范化。
 * - 模型自身 quotaInfo 与 family（Gemini/Claude/GPT/Argon/Carbon）窗口分离保存；legacy 字段
 *   percentage 仅作为 "effective=min(own, 相关 family 已知窗口)" 的兼容投影，own_* 保留真值。
 * - fraction 仅 finite 且 0..1 视为 known；null/缺值/越界一律 unknown，不造 100%。
 * - 窗口明确区分 5h / weekly / unspecified，不再用 "else=weekly"。
 * - 端点合并按优先级（production > daily > sandbox），高优先级有效值不被低优先级覆盖，
 *   低优先级只补缺项。
 * - carryover 按语义 family+window 匹配，fresh 覆盖；旧值单独带 observedAt/stale，不冒充新采样。
 */

export type WindowKind = '5h' | 'weekly' | 'unspecified';
export type Family = 'gemini' | 'claude' | 'argon' | 'carbon' | 'other';
export type QuotaSource = 'cloud' | 'live' | 'carried';
export type Availability = 'available' | 'disabled' | 'unknown';
export type QuotaState = 'known' | 'not_reported' | 'stale';
export type ArgonPeriod = '5h' | 'weekly' | 'unspecified' | null;

export interface WindowStatus {
  remaining: number | null;
  known: boolean;
  stale: boolean;
  resetTime: string | null;
  observedAt: number | null;
  source: QuotaSource;
}

export interface FamilyWindows {
  gemini: { fiveHour: WindowStatus | null; weekly: WindowStatus | null };
  claude: { fiveHour: WindowStatus | null; weekly: WindowStatus | null };
  argon: { fiveHour: WindowStatus | null; weekly: WindowStatus | null };
  carbon: { fiveHour: WindowStatus | null; weekly: WindowStatus | null };
}

export interface ArgonStatus {
  availability: Availability;
  quotaState: QuotaState;
  period: ArgonPeriod;
  remaining: number | null;
  resetCountdown: string;
  message: string;
  observedAt: number | null;
  source?: QuotaSource;
}

export interface StandaloneModelStatus extends ArgonStatus {
  key: string;
  displayName: string;
}

export interface NormalizedBucket {
  bucket_id: string;
  window: WindowKind;
  raw_window: string;
  remaining_fraction: number | null;
  remaining_fraction_known: boolean;
  percentage: number | null;
  reset_time: string | null;
  display_name?: string;
  description?: string;
  observed_at: number | null;
  stale: boolean;
  source: QuotaSource;
}

export interface NormalizedGroup {
  display_name: string;
  description?: string;
  family: Family;
  observed_at: number | null;
  buckets: NormalizedBucket[];
  stale: boolean;
  source: QuotaSource;
}

export interface NormalizedModel {
  name: string;
  model_id: string;
  display_name: string | null;
  family: Family;
  is_argon: boolean;
  is_carbon?: boolean;
  disabled: boolean | null;
  model_or_alias: string | null;
  /** 模型自身 quotaInfo（唯一真值，不被 family 窗口覆写）。 */
  own_percentage: number | null;
  own_percentage_known: boolean;
  own_reset_time: string | null;
  own_observed_at: number | null;
  own_stale: boolean;
  /** family 窗口引用（applyFamilyWindows 后填充）。 */
  family_5h: WindowStatus | null;
  family_weekly: WindowStatus | null;
  /** 兼容投影：min(own, family 已知新鲜窗口)；own 与窗口都 unknown 时为 null。 */
  percentage: number;
  percentage_known: boolean;
  effective_percentage: number | null;
  effective_known: boolean;
  reset_time: string;
  quota_bucket_id?: string;
  reset_countdown?: string;
  quota_source: QuotaSource;
  stale: boolean;
  // 透传元数据（native/详情用）
  supports_images?: boolean;
  supports_thinking?: boolean;
  thinking_budget?: number;
  recommended?: boolean;
  max_tokens?: number;
  max_output_tokens?: number;
  supported_mime_types?: Record<string, boolean>;
}

export interface StaleGroup {
  name: string;
  observed_at: number;
}

const numOrNull = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
};

/** fraction 合法范围 0..1；越界/非数值一律 unknown。 */
export function normalizeFraction(value: unknown): number | null {
  const n = numOrNull(value);
  if (n === null) return null;
  if (n < 0 || n > 1) return null;
  return n;
}

export function normalizeResetTime(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Date.parse(value))) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < 1e11 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return null;
}

export function classifyWindow(rawWindow: unknown, bucketId?: unknown, displayName?: unknown): WindowKind {
  const text = `${String(rawWindow ?? '')} ${String(bucketId ?? '')} ${String(displayName ?? '')}`.toLowerCase();
  if (/5\s*[-_]?\s*h(our)?s?\b|five[ _-]?hour|fivehour/.test(text)) return '5h';
  if (/week|7\s*d|seven[ _-]?day/.test(text)) return 'weekly';
  return 'unspecified';
}

export function classifyFamily(input: {
  groupName?: unknown;
  description?: unknown;
  bucketId?: unknown;
  modelId?: unknown;
  displayName?: unknown;
  modelProvider?: unknown;
  modelOrAlias?: unknown;
}): Family {
  // A reset description can mention other pools. Identity fields take precedence.
  const identity = [input.bucketId, input.modelId, input.displayName, input.modelOrAlias]
    .map(value => String(value ?? '').toLowerCase()).join(' ');
  const text = (identity.includes('argon') || identity.includes('carbon'))
    ? identity
    : [input.groupName, identity, input.modelProvider].map(value => String(value ?? '').toLowerCase()).join(' ');
  if (text.includes('argon')) return 'argon';
  if (text.includes('carbon')) return 'carbon';
  // 自动识别未来新上线的 Gemini 4+ 独立代号模型（如 gemini-4-neon 等），归为独立 'other' 而不污染基础 Gemini 池
  const standaloneGeminiMatch = text.match(/\bgemini[\s_-]*[4-9](?:\.\d+)?[\s_-]+([a-z][a-z0-9]*)\b/i);
  if (standaloneGeminiMatch) {
    const codename = standaloneGeminiMatch[1]!.toLowerCase();
    if (!['pro', 'flash', 'ultra', 'nano', 'lite', 'default', 'exp', 'preview', 'trial'].includes(codename)) {
      return 'other';
    }
  }
  if (/claude|gpt|openai|anthropic|3p\b/.test(text)) return 'claude';
  if (/gemini|google/.test(text)) return 'gemini';
  return 'other';
}

function modelDisabled(record: any, id: string): boolean | null {
  if (typeof record.disabled === 'boolean') return record.disabled;
  if (typeof record.isDisabled === 'boolean') return record.isDisabled;
  // The official client also uses an explicit disabled model identifier.
  return /(?:^|[-_])disabled(?:$|[-_])/i.test(id) ? true : null;
}

export function formatCountdown(resetTime: string | number | null | undefined, nowMs: number = Date.now()): string {
  const normalized = normalizeResetTime(resetTime);
  if (!normalized) return '';
  const tsMs = Date.parse(normalized);
  const diffMs = tsMs - nowMs;
  if (diffMs <= 0) return '重置时间已过';
  if (diffMs <= 60000) return '即将重置';
  const totalMin = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}天 ${hours}小时后重置`;
  if (hours > 0) return `${hours}小时 ${mins}分后重置`;
  return `${mins}分钟后重置`;
}

// ---------------------------------------------------------------------------
// 云端 models（fetchAvailableModels）
// ---------------------------------------------------------------------------

function cloudModelEntries(payload: any): { id: string; info: any }[] {
  const rows: { id: string; info: any }[] = [];
  const raw = payload?.models ?? payload?.response?.models;
  if (!raw) return rows;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id ?? item.name ?? item.modelId ?? '');
      if (id) rows.push({ id, info: item });
    }
    return rows;
  }
  if (typeof raw === 'object') {
    for (const [id, info] of Object.entries<any>(raw)) {
      if (id) rows.push({ id, info: info && typeof info === 'object' ? info : {} });
    }
  }
  return rows;
}

export function normalizeCloudModels(payload: any, observedAt: number): NormalizedModel[] {
  const models: NormalizedModel[] = [];
  for (const { id, info } of cloudModelEntries(payload)) {
    const displayName = typeof (info.displayName ?? info.display_name ?? info.label) === 'string'
      ? String(info.displayName ?? info.display_name ?? info.label)
      : null;
    const metadata = info.metadata && typeof info.metadata === 'object' ? info.metadata : {};
    const alias = info.modelOrAlias?.model ?? info.model_or_alias ?? metadata.model ?? info.model;
    const modelOrAlias = typeof alias === 'string' ? alias : null;
    const modelProvider = info.modelProvider ?? metadata.modelProvider ?? '';
    const quotaInfo = info.quotaInfo ?? info.quota_info ?? {};
    const fraction = normalizeFraction(quotaInfo?.remainingFraction ?? quotaInfo?.remaining_fraction);
    const family = classifyFamily({ modelId: id, displayName, modelProvider, modelOrAlias });
    const disabled = modelDisabled(info, id);
    models.push({
      name: id,
      model_id: id,
      display_name: displayName,
      family,
      is_argon: family === 'argon',
      is_carbon: family === 'carbon',
      disabled,
      model_or_alias: modelOrAlias,
      own_percentage: fraction === null ? null : Math.round(fraction * 100),
      own_percentage_known: fraction !== null,
      own_reset_time: normalizeResetTime(quotaInfo?.resetTime ?? quotaInfo?.reset_time),
      own_observed_at: observedAt,
      own_stale: false,
      family_5h: null,
      family_weekly: null,
      percentage: 0,
      percentage_known: false,
      effective_percentage: null,
      effective_known: false,
      reset_time: '',
      quota_source: 'cloud',
      stale: false,
      supports_images: info.supportsImages ?? info.supports_images,
      supports_thinking: info.supportsThinking ?? info.supports_thinking,
      thinking_budget: numOrNull(info.thinkingBudget ?? info.thinking_budget) ?? undefined,
      recommended: info.recommended === true,
      max_tokens: numOrNull(info.maxTokens ?? info.max_tokens) ?? undefined,
      max_output_tokens: numOrNull(info.maxOutputTokens ?? info.max_output_tokens) ?? undefined,
      supported_mime_types: info.supportedMimeTypes ?? info.supported_mime_types,
    });
  }
  return models;
}

/** live GetUserStatus.cascadeModelConfigData.clientModelConfigs */
export function normalizeLiveModels(clientConfigs: any, observedAt: number): NormalizedModel[] {
  const models: NormalizedModel[] = [];
  for (const cfg of Array.isArray(clientConfigs) ? clientConfigs : []) {
    if (!cfg || typeof cfg !== 'object') continue;
    const id = String(cfg.modelId ?? cfg.id ?? '');
    if (!id) continue;
    const displayName = typeof (cfg.label ?? cfg.displayName) === 'string' ? String(cfg.label ?? cfg.displayName) : null;
    const modelOrAlias = typeof cfg.modelOrAlias?.model === 'string' ? cfg.modelOrAlias.model : null;
    const quotaInfo = cfg.quotaInfo ?? {};
    const fraction = normalizeFraction(quotaInfo?.remainingFraction ?? quotaInfo?.remaining_fraction);
    const family = classifyFamily({ modelId: id, displayName, modelOrAlias });
    const disabled = modelDisabled(cfg, id);
    models.push({
      name: id,
      model_id: id,
      display_name: displayName,
      family,
      is_argon: family === 'argon',
      is_carbon: family === 'carbon',
      disabled,
      model_or_alias: modelOrAlias,
      own_percentage: fraction === null ? null : Math.round(fraction * 100),
      own_percentage_known: fraction !== null,
      own_reset_time: normalizeResetTime(quotaInfo?.resetTime ?? quotaInfo?.reset_time),
      own_observed_at: observedAt,
      own_stale: false,
      family_5h: null,
      family_weekly: null,
      percentage: 0,
      percentage_known: false,
      effective_percentage: null,
      effective_known: false,
      reset_time: '',
      quota_source: 'live',
      stale: false,
      supports_images: cfg.supportsImages ?? cfg.supports_images,
      supports_thinking: cfg.supportsThinking ?? cfg.supports_thinking,
      thinking_budget: numOrNull(cfg.thinkingBudget) ?? undefined,
      recommended: cfg.isRecommended === true || cfg.recommended === true,
      supported_mime_types: cfg.supportedMimeTypes,
    });
  }
  return models;
}

// ---------------------------------------------------------------------------
// 分组 / 桶（retrieveUserQuotaSummary）
// ---------------------------------------------------------------------------

function normalizeBuckets(rawBuckets: any, observedAt: number, source: QuotaSource): NormalizedBucket[] {
  const buckets: NormalizedBucket[] = [];
  for (const raw of Array.isArray(rawBuckets) ? rawBuckets : []) {
    if (!raw || typeof raw !== 'object') continue;
    const bucketId = String(raw.bucketId ?? raw.bucket_id ?? '');
    const window = classifyWindow(raw.window, bucketId, raw.displayName ?? raw.display_name);
    const fraction = normalizeFraction(raw.remainingFraction ?? raw.remaining_fraction);
    const explicitKnown = raw.remaining_fraction_known ?? raw.remainingFractionKnown;
    const known = explicitKnown === false ? false : fraction !== null;
    buckets.push({
      bucket_id: bucketId,
      window,
      raw_window: String(raw.window ?? ''),
      remaining_fraction: known ? fraction : null,
      remaining_fraction_known: known,
      percentage: known && fraction !== null ? Math.round(fraction * 100) : null,
      reset_time: normalizeResetTime(raw.resetTime ?? raw.reset_time),
      display_name: typeof (raw.displayName ?? raw.display_name) === 'string' ? String(raw.displayName ?? raw.display_name) : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      observed_at: numOrNull(raw.observedAt ?? raw.observed_at ?? raw.last_updated) ?? observedAt,
      stale: raw.stale === true,
      source: (raw.source === 'carried' || raw.source === 'live' || raw.source === 'cloud') ? raw.source : source,
    });
  }
  return buckets;
}

function normalizeGroupEntries(rawGroups: any, observedAt: number, source: QuotaSource): NormalizedGroup[] {
  const groups: NormalizedGroup[] = [];
  for (const raw of Array.isArray(rawGroups) ? rawGroups : []) {
    if (!raw || typeof raw !== 'object') continue;
    const displayName = String(raw.displayName ?? raw.display_name ?? '');
    if (!displayName && !Array.isArray(raw.buckets)) continue;
    const description = typeof raw.description === 'string' ? raw.description : undefined;
    const declaredFamily = raw.family === 'gemini' || raw.family === 'claude' || raw.family === 'argon' || raw.family === 'carbon' || raw.family === 'other' ? raw.family as Family : null;
    const family = declaredFamily ?? classifyFamily({ groupName: displayName, description, bucketId: (raw.buckets ?? [])[0]?.bucketId ?? (raw.buckets ?? [])[0]?.bucket_id });
    const groupObserved = numOrNull(raw.observedAt ?? raw.observed_at ?? raw.last_updated) ?? observedAt;
    const buckets = normalizeBuckets(raw.buckets, groupObserved, source);
    groups.push({
      display_name: displayName,
      description,
      family,
      observed_at: groupObserved,
      buckets,
      stale: raw.stale === true || (buckets.length > 0 && buckets.every(bucket => bucket.stale)),
      source: (raw.source === 'carried' || raw.source === 'live' || raw.source === 'cloud') ? raw.source : source,
    });
  }
  return groups;
}

export function normalizeCloudGroups(payload: any, observedAt: number): NormalizedGroup[] {
  return normalizeGroupEntries(payload?.groups ?? payload?.response?.groups ?? [], observedAt, 'cloud');
}

export function normalizeLiveGroups(quotaSummary: any, observedAt: number): NormalizedGroup[] {
  return normalizeGroupEntries(quotaSummary?.groups ?? quotaSummary?.response?.groups ?? [], observedAt, 'live');
}

/** 已持久化/外部同步/legacy snake_case 或 camelCase 分组 → 规范化（可容忍坏组）。 */
export function normalizeStoredGroups(rawGroups: any, observedAt: number, source: QuotaSource = 'cloud'): NormalizedGroup[] {
  return normalizeGroupEntries(rawGroups ?? [], observedAt, source);
}

/**
 * 多端点分组合并（输入按优先级从高到低）。键 = family + window（当 family === 'other' 时按 display_name 区分独立组）；
 * 高优先级有效值不被覆盖，低优先级只补缺项。
 */
export function mergeGroupSets(groupSets: NormalizedGroup[][]): NormalizedGroup[] {
  interface BucketAcc { bucket: NormalizedBucket; priority: number }
  const bucketAcc = new Map<string, BucketAcc>();
  const groupMeta = new Map<string, { family: Family; name: string; description?: string; priority: number; observedAt: number | null }>();
  const groupOrder: string[] = [];
  groupSets.forEach((groups, priority) => {
    for (const group of groups) {
      const groupKey = group.family === 'other'
        ? `other:${(group.display_name || 'other').toLowerCase()}`
        : group.family;
      if (!groupOrder.includes(groupKey)) groupOrder.push(groupKey);
      const current = groupMeta.get(groupKey);
      if (!current || priority < current.priority) {
        groupMeta.set(groupKey, { family: group.family, name: group.display_name, description: group.description, priority, observedAt: group.observed_at });
      } else if (!current.description && group.description) {
        current.description = group.description;
      }
      for (const bucket of group.buckets) {
        const key = `${groupKey}:${bucket.window}`;
        const existing = bucketAcc.get(key);
        const usable = bucket.remaining_fraction_known || bucket.reset_time !== null;
        if (!existing) {
          bucketAcc.set(key, { bucket: { ...bucket }, priority });
          continue;
        }
        // 高优先级优先；同优先级取更早观测（更保守）。低优先级绝不覆盖已 known 的高优先级值。
        if (priority < existing.priority) continue;
        if (existing.bucket.remaining_fraction_known && !usable) continue;
        if (!existing.bucket.remaining_fraction_known && usable) {
          bucketAcc.set(key, { bucket: { ...bucket }, priority: existing.priority });
        }
      }
    }
  });
  const result: NormalizedGroup[] = [];
  for (const groupKey of groupOrder) {
    const meta = groupMeta.get(groupKey);
    const buckets: NormalizedBucket[] = [];
    for (const [key, entry] of bucketAcc) {
      if (!key.startsWith(`${groupKey}:`)) continue;
      buckets.push(entry.bucket);
    }
    if (buckets.length === 0 && !meta) continue;
    buckets.sort((a, b) => windowRank(a.window) - windowRank(b.window) || a.bucket_id.localeCompare(b.bucket_id));
    const observedAt = meta?.observedAt ?? buckets[0]?.observed_at ?? null;
    const source: QuotaSource = buckets[0]?.source ?? 'cloud';
    result.push({ display_name: meta?.name ?? groupKey, description: meta?.description, family: meta?.family ?? 'other', observed_at: observedAt, buckets, stale: false, source });
  }
  return result;
}

function windowRank(window: WindowKind): number {
  return window === '5h' ? 0 : window === 'weekly' ? 1 : 2;
}

/**
 * 语义 carryover：fresh 覆盖 previous 中同 family+window；previous 独有桶以 stale 追加。
 * 不因分组改名产生重复组；旧 reset 只与其自己的 observedAt 一起用于 stale 展示。
 */
export function mergeGroupsWithPrevious(
  freshGroups: NormalizedGroup[],
  previousGroups: NormalizedGroup[],
  nowMs: number,
): { groups: NormalizedGroup[]; staleGroups: StaleGroup[] } {
  const result = freshGroups.map(group => ({
    ...group,
    buckets: group.buckets.map(bucket => ({ ...bucket, stale: false })),
  }));
  const staleGroups: StaleGroup[] = [];
  for (const oldGroup of previousGroups) {
    const target = result.find(group =>
      group.family === oldGroup.family &&
      (group.family !== 'other' || group.display_name.toLowerCase() === oldGroup.display_name.toLowerCase())
    );
    if (!target) {
      staleGroups.push({ name: oldGroup.display_name, observed_at: oldGroup.observed_at ?? nowMs / 1000 });
      result.push({ ...oldGroup, stale: true, source: 'carried',
        buckets: oldGroup.buckets.map(bucket => ({ ...bucket, stale: true, source: 'carried' as const })) });
      continue;
    }
    for (const oldBucket of oldGroup.buckets) {
      const exists = target.buckets.some(bucket => bucket.window === oldBucket.window && bucket.bucket_id === oldBucket.bucket_id)
        || target.buckets.some(bucket => bucket.window === oldBucket.window && bucket.window !== 'unspecified');
      if (exists) continue;
      const observedAt = oldBucket.observed_at ?? oldGroup.observed_at ?? Math.floor(nowMs / 1000);
      target.buckets.push({ ...oldBucket, stale: true, source: 'carried', observed_at: observedAt });
      staleGroups.push({ name: `${oldGroup.display_name} · ${oldBucket.bucket_id || oldBucket.window}`.trim(), observed_at: observedAt });
    }
  }
  for (const group of result) {
    group.buckets.sort((a, b) => windowRank(a.window) - windowRank(b.window) || a.bucket_id.localeCompare(b.bucket_id));
  }
  return { groups: result, staleGroups };
}

// ---------------------------------------------------------------------------
// 模型合并 / carryover
// ---------------------------------------------------------------------------

export function mergeModelCatalogues(catalogues: NormalizedModel[][]): NormalizedModel[] {
  const byId = new Map<string, { model: NormalizedModel; priority: number }>();
  const order: string[] = [];
  catalogues.forEach((models, priority) => {
    for (const model of models) {
      const key = (model.model_id || model.name).toLowerCase();
      if (!key) continue;
      const existing = byId.get(key);
      if (!existing) {
        byId.set(key, { model: { ...model }, priority });
        order.push(key);
        continue;
      }
      // 高优先级元数据优先，缺项用低优先级补；own quota 已知值优先。
      const merged = existing.model;
      if (!merged.display_name && model.display_name) merged.display_name = model.display_name;
      if (merged.disabled === null && model.disabled !== null) merged.disabled = model.disabled;
      if (!merged.model_or_alias && model.model_or_alias) merged.model_or_alias = model.model_or_alias;
      if (!merged.own_percentage_known && model.own_percentage_known) {
        merged.own_percentage = model.own_percentage;
        merged.own_percentage_known = true;
        merged.own_reset_time = model.own_reset_time;
        merged.own_observed_at = model.own_observed_at;
      }
      if (priority < existing.priority) existing.priority = priority;
    }
  });
  return order.map(key => byId.get(key)!.model);
}

export function mergeModelsWithPrevious(
  freshModels: NormalizedModel[],
  previousModels: NormalizedModel[],
): { models: NormalizedModel[]; carriedCount: number } {
  const result = freshModels.map(model => ({ ...model, stale: false }));
  const seen = new Set(result.map(model => (model.model_id || model.name).toLowerCase()));
  let carriedCount = 0;
  for (const old of previousModels) {
    const key = (old.model_id || old.name).toLowerCase();
    if (!key || seen.has(key)) continue;
    result.push({
      ...old,
      quota_source: 'carried',
      stale: true,
      own_stale: true,
      percentage: 0,
      percentage_known: false,
      effective_percentage: null,
      effective_known: false,
      reset_time: '',
      own_observed_at: old.own_observed_at ?? null,
    });
    carriedCount++;
  }
  return { models: result, carriedCount };
}

// ---------------------------------------------------------------------------
// family 窗口 / effective / argonStatus / carbonStatus / standaloneModels
// ---------------------------------------------------------------------------

/** Model quota is independent of family periods; never infer a 5h window from its reset time. */
export function familyModelQuotaFromModels(models: NormalizedModel[]): Record<'gemini' | 'claude', WindowStatus | null> {
  const result: Record<'gemini' | 'claude', WindowStatus | null> = { gemini: null, claude: null };
  for (const family of ['gemini', 'claude'] as const) {
    const eligible = models.filter(model => model.family === family && model.disabled !== true
      && model.own_percentage_known && model.own_percentage !== null
      && Number.isFinite(model.own_percentage) && model.own_percentage >= 0 && model.own_percentage <= 100);
    const fresh = eligible.filter(model => !model.own_stale);
    const pool = fresh.length ? fresh : eligible;
    const chosen = [...pool].sort((left, right) => left.own_percentage! - right.own_percentage!
      || (Date.parse(left.own_reset_time ?? '') || Infinity) - (Date.parse(right.own_reset_time ?? '') || Infinity)
      || left.name.localeCompare(right.name))[0];
    if (chosen) result[family] = {
      remaining: chosen.own_percentage! / 100, known: true, stale: chosen.own_stale,
      resetTime: chosen.own_reset_time, observedAt: chosen.own_observed_at, source: chosen.quota_source,
    };
  }
  return result;
}

export function familyWindowsFromGroups(groups: NormalizedGroup[], nowMs: number): FamilyWindows {
  const windows: FamilyWindows = {
    gemini: { fiveHour: null, weekly: null },
    claude: { fiveHour: null, weekly: null },
    argon: { fiveHour: null, weekly: null },
    carbon: { fiveHour: null, weekly: null },
  };
  for (const family of ['gemini', 'claude', 'argon', 'carbon'] as const) {
    for (const window of ['5h', 'weekly'] as const) {
      const candidates = groups
        .filter(group => group.family === family)
        .flatMap(group => group.buckets.filter(bucket => bucket.window === window))
        .map(bucket => ({ ...bucket, stale: bucket.stale ||
          (bucket.observed_at !== null && nowMs / 1000 - bucket.observed_at > 900) ||
          (bucket.reset_time !== null && Date.parse(bucket.reset_time) <= nowMs) }));
      if (candidates.length === 0) continue;
      // 新鲜优先；同 window 多桶取更保守（remaining 更小）的已知值。
      const fresh = candidates.filter(bucket => !bucket.stale && bucket.remaining_fraction_known);
      const pool = fresh.length > 0 ? fresh : candidates.filter(bucket => bucket.remaining_fraction_known);
      if (pool.length === 0) {
        const any = candidates[0]!;
        windows[family][window === '5h' ? 'fiveHour' : 'weekly'] = {
          remaining: null,
          known: false,
          stale: candidates.every(bucket => bucket.stale),
          resetTime: any.reset_time,
          observedAt: any.observed_at,
          source: any.source,
        };
        continue;
      }
      const chosen = pool.reduce((left, right) => (left.remaining_fraction! <= right.remaining_fraction! ? left : right));
      windows[family][window === '5h' ? 'fiveHour' : 'weekly'] = {
        remaining: chosen.remaining_fraction,
        known: true,
        stale: chosen.stale,
        resetTime: chosen.reset_time,
        observedAt: chosen.observed_at,
        source: chosen.source,
      };
    }
  }
  return windows;
}

function mergeWindowStatus(left: WindowStatus | null, right: WindowStatus | null): WindowStatus | null {
  if (!left) return right;
  if (!right) return left;
  if (left.stale !== right.stale) return left.stale ? right : left;
  if (left.known && !right.known) return left;
  if (!left.known && right.known) return right;
  if (left.known && right.known) {
    return left.remaining !== null && right.remaining !== null && right.remaining < left.remaining ? right : left;
  }
  return left;
}

/** 把 family 窗口写入模型：effective = min(own known fresh, family 已知 fresh 窗口)；legacy 字段=effective。 */
export function applyFamilyWindows(models: NormalizedModel[], windows: FamilyWindows): NormalizedModel[] {
  return models.map(model => {
    const family = model.family === 'other' ? null : model.family;
    const familyWindowSet = family ? windows[family] : null;
    const family5h = familyWindowSet ? familyWindowSet.fiveHour : null;
    const familyWeekly = familyWindowSet ? familyWindowSet.weekly : null;
    const freshWindows = [family5h, familyWeekly].filter((status): status is WindowStatus => !!status && status.known && !status.stale);
    const usable: number[] = [];
    if (!model.disabled && model.own_percentage_known && !model.own_stale && model.own_percentage !== null) usable.push(model.own_percentage / 100);
    if (!model.disabled) for (const status of freshWindows) if (status.remaining !== null) usable.push(status.remaining);
    const effective = usable.length > 0 ? Math.min(...usable) : null;
    let limitingReset: string | null = null;
    let limitingBucket: string | undefined;
    if (effective !== null) {
      if (model.own_percentage_known && !model.own_stale && model.own_percentage !== null && Math.abs(model.own_percentage / 100 - effective) < 1e-9) {
        limitingReset = model.own_reset_time;
        limitingBucket = model.model_id;
      }
      const windowOrder: [WindowStatus | null, string][] = [[family5h, '5h'], [familyWeekly, 'weekly']];
      for (const [status, name] of windowOrder) {
        if (status?.known && !status.stale && status.remaining !== null && Math.abs(status.remaining - effective) < 1e-9) {
          limitingReset = status.resetTime ?? limitingReset;
          const familyGroup = `${model.family}-${name}`;
          limitingBucket = limitingBucket ?? familyGroup;
        }
      }
    }
    return {
      ...model,
      family_5h: family5h,
      family_weekly: familyWeekly,
      effective_percentage: effective === null ? null : Math.round(effective * 100),
      effective_known: effective !== null,
      percentage: effective === null ? 0 : Math.round(effective * 100),
      percentage_known: effective !== null,
      reset_time: effective === null ? '' : (limitingReset ?? ''),
      quota_bucket_id: effective === null ? model.model_id : (limitingBucket ?? model.model_id),
    };
  });
}

function buildStandaloneFamilyStatus(
  familyModels: NormalizedModel[],
  familyWindowPair: { fiveHour: WindowStatus | null; weekly: WindowStatus | null },
  nowMs: number,
  options: {
    shortLabel: string;
    fullLabel: string;
    inferredDisabled?: boolean;
  },
): ArgonStatus {
  const eligibleModels = familyModels.filter(model => model.disabled !== true && !model.stale);
  const ownModels = familyModels.filter(model => model.disabled !== true && model.own_percentage_known && model.own_percentage !== null);
  const freshOwn = ownModels.filter(model => !model.own_stale);
  const enabledModel = (freshOwn.length ? freshOwn : ownModels).reduce<NormalizedModel | undefined>(
    (best, model) => !best || model.own_percentage! < best.own_percentage! ? model : best, undefined);

  const weekly = familyWindowPair.weekly;
  const fiveHour = familyWindowPair.fiveHour;
  const hasKnownBucket = Boolean((weekly?.known && !weekly.stale) || (fiveHour?.known && !fiveHour.stale));

  const availability: Availability = (eligibleModels.some(model => model.disabled === false ||
    (model.own_percentage_known && !model.own_stale)) || hasKnownBucket) ? 'available'
    : (familyModels.length > 0 && familyModels.every(model => model.disabled === true && !model.stale)) || (familyModels.length === 0 && options.inferredDisabled === true)
      ? 'disabled'
      : 'unknown';

  let period: ArgonPeriod = null;
  let remaining: number | null = null;
  let stale = false;
  let observedAt: number | null = null;
  let source: QuotaSource | undefined;
  const knownWindows = ([['weekly', weekly], ['5h', fiveHour]] as const)
    .filter((entry): entry is readonly ['weekly' | '5h', WindowStatus] => !!entry[1]?.known);
  const freshKnown = knownWindows.filter(([, status]) => !status.stale);
  const selected = (freshKnown.length ? freshKnown : knownWindows).reduce<typeof knownWindows[number] | null>(
    (best, entry) => !best || (entry[1].remaining ?? 1) < (best[1].remaining ?? 1) ? entry : best, null);
  let selectedReset: string | null = null;
  if (selected) {
    const [selectedPeriod, status] = selected;
    period = selectedPeriod; remaining = status.remaining; stale = status.stale;
    observedAt = status.observedAt; source = status.source; selectedReset = status.resetTime;
  } else if (weekly || fiveHour) {
    period = weekly ? 'weekly' : '5h';
    observedAt = (weekly ?? fiveHour)!.observedAt;
    source = (weekly ?? fiveHour)!.source;
    stale = (weekly ?? fiveHour)!.stale;
  }
  if (enabledModel?.own_percentage_known && enabledModel.own_percentage !== null &&
    ((!enabledModel.own_stale && (remaining === null || stale || enabledModel.own_percentage < Math.round(remaining * 100))) ||
      (remaining === null && enabledModel.own_stale))) {
    period = 'unspecified';
    remaining = enabledModel.own_percentage / 100;
    observedAt = enabledModel.own_observed_at;
    source = enabledModel.quota_source;
    stale = enabledModel.own_stale;
    selectedReset = enabledModel.own_reset_time;
  }
  const quotaState: QuotaState = remaining !== null ? (stale ? 'stale' : 'known') : (stale ? 'stale' : 'not_reported');
  const resetSource = selectedReset ?? (remaining === null ? (weekly ?? fiveHour)?.resetTime : null);
  const resetCountdown = resetSource ? formatCountdown(resetSource, nowMs) : '';

  const { shortLabel, fullLabel } = options;
  let message: string;
  if (availability === 'disabled') {
    message = `当前账号无 ${fullLabel} 权限（不可用）`;
  } else if (availability === 'unknown') {
    message = familyModels.length ? `${shortLabel} 模型已列出，但接口未明确返回可用状态（不代表无权限）`
      : `本轮接口未返回 ${shortLabel} 模型记录，无法判断 ${shortLabel} 权限或额度（不代表无权限）`;
  } else if (quotaState === 'known') {
    message = period === 'weekly'
      ? `${shortLabel} 每周配额已取得（剩余 ${Math.round((remaining ?? 0) * 100)}%）`
      : period === '5h'
        ? `${shortLabel} 5 小时配额已取得（剩余 ${Math.round((remaining ?? 0) * 100)}%）`
        : `${shortLabel} 模型记录存在，已取得未标明窗口的额度（剩余 ${Math.round((remaining ?? 0) * 100)}%）`;
  } else if (quotaState === 'stale') {
    message = `${shortLabel} 配额本轮未返回，当前展示上次真实采样（已标陈旧）`;
  } else {
    message = `存在 ${shortLabel} 模型记录，但本轮未返回可用配额数值`;
  }
  return { availability, quotaState, period, remaining, resetCountdown, message, observedAt, source };
}

export function buildArgonStatus(
  models: NormalizedModel[],
  _groups: NormalizedGroup[],
  familyWindows: FamilyWindows,
  nowMs: number,
): ArgonStatus {
  const argonModels = models.filter(model => model.is_argon || model.family === 'argon');
  return buildStandaloneFamilyStatus(argonModels, familyWindows.argon, nowMs, {
    shortLabel: 'Argon',
    fullLabel: 'Gemini 4 Argon',
  });
}

export function buildCarbonStatus(
  models: NormalizedModel[],
  _groups: NormalizedGroup[],
  familyWindows: FamilyWindows,
  nowMs: number,
  _argonStatus?: ArgonStatus,
  _subscriptionTier?: string | null,
): ArgonStatus {
  const carbonModels = models.filter(model => model.is_carbon || model.family === 'carbon');
  return buildStandaloneFamilyStatus(carbonModels, familyWindows.carbon ?? { fiveHour: null, weekly: null }, nowMs, {
    shortLabel: 'Carbon',
    fullLabel: 'Gemini 4 Carbon',
  });
}

function autoPrettyModelTitle(rawIdOrName: string): string {
  const trimmed = rawIdOrName.trim();
  const geminiMatch = trimmed.match(/^gemini[\s_-]*([4-9](?:\.\d+)?)[\s_-]+([a-z][a-z0-9]*?)(?:[\s_-]+(trial|preview|exp))?$/i);
  if (geminiMatch) {
    const ver = geminiMatch[1]!;
    const code = geminiMatch[2]!.charAt(0).toUpperCase() + geminiMatch[2]!.slice(1).toLowerCase();
    return `Gemini ${ver} ${code}`;
  }
  return trimmed;
}

/**
 * 构建所有独立配额模型列表：
 * - 固定包含 Gemini 4 Argon 与 Gemini 4 Carbon
 * - 自动检测接口新返回的独立配额分组（family === 'other'）或新上线的 Gemini 4+ 独立模型并同步纳入展示
 */
export function buildStandaloneModels(
  models: NormalizedModel[],
  groups: NormalizedGroup[],
  familyWindows: FamilyWindows,
  nowMs: number,
  argonStatus?: ArgonStatus,
  carbonStatus?: ArgonStatus,
  subscriptionTier?: string | null,
): StandaloneModelStatus[] {
  const resolvedArgon = argonStatus ?? buildArgonStatus(models, groups, familyWindows, nowMs);
  const resolvedCarbon = carbonStatus ?? buildCarbonStatus(models, groups, familyWindows, nowMs, resolvedArgon, subscriptionTier);

  const list: StandaloneModelStatus[] = [
    { key: 'argon', displayName: 'Gemini 4 Argon', ...resolvedArgon },
    { key: 'carbon', displayName: 'Gemini 4 Carbon', ...resolvedCarbon },
  ];
  const seenKeys = new Set<string>(['argon', 'carbon', 'gemini-4-argon', 'gemini-4-carbon']);

  // 1. 自动发现 family === 'other' 的新配额分组
  for (const group of groups) {
    if (group.family !== 'other') continue;
    const rawName = (group.display_name || '').replace(/(?:[\s_-]+(?:weekly|daily|5h|five[\s_-]*hour|limit|quota))+$/i, '').trim();
    if (!rawName) continue;
    const normKey = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!normKey || seenKeys.has(normKey)) continue;
    seenKeys.add(normKey);

    const groupWindows = familyWindowsFromGroups([{ ...group, family: 'argon' }], nowMs).argon;
    const matchingModels = models.filter(m =>
      m.family === 'other' &&
      ((m.display_name || '').toLowerCase().includes(rawName.toLowerCase()) ||
        m.model_id.toLowerCase().includes(normKey))
    );
    const displayName = autoPrettyModelTitle(rawName);
    const status = buildStandaloneFamilyStatus(matchingModels, groupWindows, nowMs, {
      shortLabel: displayName,
      fullLabel: displayName,
    });
    list.push({ key: normKey, displayName, ...status });
  }

  // 2. 自动发现 family === 'other' 的新上线独立模型（如未来的 Gemini 4 新代号模型或其它独立计费模型）
  const extraByBaseKey = new Map<string, { displayName: string; items: NormalizedModel[] }>();
  for (const model of models) {
    if (model.family !== 'other') continue;
    const rawId = (model.model_id || model.name || '').trim();
    if (!rawId) continue;
    const baseKey = rawId
      .toLowerCase()
      .replace(/-(?:trial|preview|exp|disabled|tiered|latest)$/i, '')
      .replace(/[^a-z0-9.]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!baseKey || seenKeys.has(baseKey)) continue;
    const displayName = model.display_name
      ? model.display_name.replace(/\s+(?:Trial|Preview|Exp)$/i, '').trim()
      : autoPrettyModelTitle(baseKey);
    const existing = extraByBaseKey.get(baseKey);
    if (existing) {
      existing.items.push(model);
    } else {
      extraByBaseKey.set(baseKey, { displayName, items: [model] });
    }
  }

  for (const [baseKey, entry] of extraByBaseKey.entries()) {
    if (seenKeys.has(baseKey)) continue;
    seenKeys.add(baseKey);
    const status = buildStandaloneFamilyStatus(
      entry.items,
      { fiveHour: null, weekly: null },
      nowMs,
      {
        shortLabel: entry.displayName,
        fullLabel: entry.displayName,
      },
    );
    list.push({ key: baseKey, displayName: entry.displayName, ...status });
  }

  return list;
}

/** 从规范化分组重新计算 legacy 字段（供 overview 使用）。 */
export function legacyFromFamilyWindows(familyWindows: FamilyWindows, nowMs: number = Date.now()): {
  geminiFiveHourRemaining: number | null;
  geminiWeeklyRemaining: number | null;
  geminiFiveHourResetCountdown: string;
  geminiWeeklyResetCountdown: string;
  claudeFiveHourRemaining: number | null;
  claudeWeeklyRemaining: number | null;
  claudeFiveHourResetCountdown: string;
  claudeWeeklyResetCountdown: string;
  argonWeeklyRemaining: number | null;
  argonWeeklyResetCountdown: string;
  carbonWeeklyRemaining: number | null;
  carbonWeeklyResetCountdown: string;
} {
  const pct = (status: WindowStatus | null | undefined) => status?.known && !status.stale ? Math.round(status.remaining! * 100) : null;
  const countdown = (status: WindowStatus | null | undefined, nowMs: number) => (status?.known && !status.stale ? formatCountdown(status.resetTime, nowMs) : '');
  return {
    geminiFiveHourRemaining: pct(familyWindows.gemini.fiveHour),
    geminiWeeklyRemaining: pct(familyWindows.gemini.weekly),
    geminiFiveHourResetCountdown: countdown(familyWindows.gemini.fiveHour, nowMs),
    geminiWeeklyResetCountdown: countdown(familyWindows.gemini.weekly, nowMs),
    claudeFiveHourRemaining: pct(familyWindows.claude.fiveHour),
    claudeWeeklyRemaining: pct(familyWindows.claude.weekly),
    claudeFiveHourResetCountdown: countdown(familyWindows.claude.fiveHour, nowMs),
    claudeWeeklyResetCountdown: countdown(familyWindows.claude.weekly, nowMs),
    argonWeeklyRemaining: pct(familyWindows.argon.weekly),
    argonWeeklyResetCountdown: countdown(familyWindows.argon.weekly, nowMs),
    carbonWeeklyRemaining: pct(familyWindows.carbon?.weekly),
    carbonWeeklyResetCountdown: countdown(familyWindows.carbon?.weekly, nowMs),
  };
}

export function mergeWindowStatuses(...statuses: (WindowStatus | null)[]): WindowStatus | null {
  return statuses.reduce<WindowStatus | null>((acc, item) => mergeWindowStatus(acc, item), null);
}

/** Independent quota endpoint buckets are metering evidence, not model-list defaults. */
export function normalizeIndependentArgonQuota(payload: any, observedAt: number): NormalizedModel[] {
  const rows = (Array.isArray(payload?.buckets) ? payload.buckets : []).filter(
    (b: any) =>
      typeof b?.modelId === 'string' &&
      /argon|carbon|^gemini-[4-9](?:\.\d+)?-(?!(?:pro|flash|ultra|nano|lite|default)(?:-|$))/i.test(b.modelId) &&
      normalizeFraction(b.remainingFraction) !== null
  );
  return normalizeCloudModels(
    {
      models: Object.fromEntries(
        rows.map((b: any) => [
          b.modelId,
          {
            displayName: b.displayName ?? b.modelId,
            quotaInfo: { remainingFraction: b.remainingFraction, resetTime: b.resetTime },
          },
        ])
      ),
    },
    observedAt
  );
}
