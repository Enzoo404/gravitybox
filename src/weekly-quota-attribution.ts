import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildAccountQuotaOverview,
  type ProjectedQuotaGroup,
  type QuotaData,
  type QuotaOverview,
} from './account-quota.js';
import { atomicJson, readOptionalJson } from './files.js';
import { bt } from './i18n.js';
import { normalizeSubscriptionTier } from './ipc-projections.js';
import {
  classifyFamily,
  extractGroupMemberLabels,
  extractStandaloneGeminiCodename,
  findGroupForModelByDescription,
  normalizeBaseModelKey,
  normalizeGroupMemberKey,
  normalizeResetTime,
  normalizeStoredGroups,
  type NormalizedGroup,
} from './quota.js';
import { isUnknownModelName, resolveDatabaseModelFullName, type GenerationEvent } from './usage-types.js';

export type WeeklyAttributionConfidence = 'high' | 'medium' | 'low' | 'calibrating' | 'none';

export interface WeeklyCycleHistoryEntry {
  cycleStartSec: number;
  resetTimeSec: number;
  totalUsedPct: number | null;
  localEstimatedUsedPct: number | null;
  otherEstimatedUsedPct: number | null;
  localTokens: number;
  localRequests: number;
  localUsd: number;
  sshTokens: number;
  sshRequests: number;
  confidence: WeeklyAttributionConfidence;
  snapshotCount: number;
}

export interface WeeklyPoolAttribution {
  poolKey: string;
  displayName: string;
  cycleStartSec: number;
  resetTimeSec: number;
  resetTimeIso: string;
  remainingPct: number;
  totalUsedPct: number;
  localEstimatedUsedPct: number | null;
  otherEstimatedUsedPct: number | null;
  localTokens: number;
  localRequests: number;
  localUsd: number;
  unpricedRequests: number;
  sshTokens: number;
  sshRequests: number;
  confidence: WeeklyAttributionConfidence;
  calibrationSamples: number;
  usdPer1Pct: number | null;
  snapshotCount: number;
  firstSnapshotAt: number | null;
  hasPreSnapshotEstimate: boolean;
  ambiguousDropPct: number;
  recentCycles: WeeklyCycleHistoryEntry[];
}

export interface AccountWeeklyAttribution {
  accountId: string | null;
  email: string;
  name?: string | null;
  tier?: string;
  generatedAtSec: number;
  pools: WeeklyPoolAttribution[];
}

export interface WeeklySnapshotPoint {
  at: number;
  lastSeenAt: number;
  remaining: number;
  source: string;
}

export interface WeeklySnapshotCycle {
  cycleStartSec: number;
  resetTimeSec: number;
  resetTimeIso: string;
  tier?: string;
  points: WeeklySnapshotPoint[];
}

export interface WeeklyPoolSnapshotRecord {
  poolKey: string;
  displayName: string;
  tier?: string;
  cycles: WeeklySnapshotCycle[];
}

export interface WeeklyAccountSnapshotRecord {
  email: string;
  tier?: string;
  pools: Record<string, WeeklyPoolSnapshotRecord>;
}

interface PersistedWeeklySnapshotFile {
  version: 1;
  accounts: Record<string, WeeklyAccountSnapshotRecord>;
}

export type WeeklyAttributionEvent = GenerationEvent & {
  db_file?: string;
  estimated_usd?: number | null;
  priced?: boolean;
};

const WEEK_SEC = 7 * 86400;
const MAX_CYCLES_PER_POOL = 8;
const MAX_POINTS_PER_CYCLE = 500;
const MAX_RECENT_CYCLES = 4;
const SAME_CYCLE_RESET_TOLERANCE_SEC = 3600;
const SAME_CYCLE_REMAINING_TOLERANCE = 0.02;
const POINT_CHANGE_EPSILON = 0.0001;
const POINT_CHANGE_FLOAT_TOLERANCE = 1e-12;
const SAVE_DEBOUNCE_MS = 5_000;
const IDLE_SAVE_THROTTLE_MS = 300_000;
const MIN_DROP_THRESHOLD = 0.00005;
const LAG_BUFFER_SEC = 90;
const CARRY_LOOKBACK_SEC = 6 * 3600;
const SHORT_GAP_SEC = 15 * 60;
const SILENT_THRESHOLD_SEC = 180;
const MIN_CALIBRATION_USD = 0.01;
const MIN_CALIBRATION_DROP = 0.002;
const MIN_CALIBRATION_TOKENS = 100;
const SPIKE_CLIP_MULTIPLIER = 1.8;
const MAX_QUERY_LOOKBACK_SEC = 60 * 86400;

function hasMeaningfulRemainingChange(nextRemaining: number, prevRemaining: number): boolean {
  return Math.abs(nextRemaining - prevRemaining) + POINT_CHANGE_FLOAT_TOLERANCE >= POINT_CHANGE_EPSILON;
}

function round1(value: number): number {
  const r = Math.round(value * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

function round4(value: number): number {
  const r = Math.round(value * 10_000) / 10_000;
  return Object.is(r, -0) ? 0 : r;
}

function round6(value: number): number {
  const r = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(r, -0) ? 0 : r;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function canonicalTierForMatching(rawTier: unknown): string {
  if (typeof rawTier !== 'string') return '';
  const trimmed = rawTier.trim();
  if (!trimmed) return '';
  const normalized = normalizeSubscriptionTier(trimmed);
  const pendingLabel = bt('quota.tier.pending');
  if (
    !normalized ||
    normalized === pendingLabel ||
    normalized === '待确认' ||
    normalized === 'Pending'
  ) {
    return '';
  }
  return normalized;
}

function tiersCompatible(cycleTier: unknown, currentTier: unknown): boolean {
  const a = canonicalTierForMatching(cycleTier);
  const b = canonicalTierForMatching(currentTier);
  if (!a || !b) return true;
  return a === b;
}

function sanitizePoint(raw: unknown): WeeklySnapshotPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const at = typeof obj.at === 'number' && Number.isFinite(obj.at) && obj.at > 0 ? Math.floor(obj.at) : null;
  const rawLastSeen = typeof obj.lastSeenAt === 'number' && Number.isFinite(obj.lastSeenAt) && obj.lastSeenAt > 0
    ? Math.floor(obj.lastSeenAt)
    : at;
  const remaining = typeof obj.remaining === 'number' && Number.isFinite(obj.remaining)
    && obj.remaining >= 0 && obj.remaining <= 1
    ? obj.remaining
    : null;
  if (at === null || rawLastSeen === null || remaining === null) return null;
  const source = typeof obj.source === 'string' && obj.source.trim() ? obj.source.trim() : 'cloud';
  return {
    at,
    lastSeenAt: Math.max(at, rawLastSeen),
    remaining,
    source,
  };
}

function capCyclePoints(points: WeeklySnapshotPoint[]): WeeklySnapshotPoint[] {
  if (points.length <= MAX_POINTS_PER_CYCLE) return points;
  const first = points[0];
  const tail = points.slice(-(MAX_POINTS_PER_CYCLE - 1));
  return first ? [first, ...tail] : points.slice(-MAX_POINTS_PER_CYCLE);
}

function sanitizeCycle(raw: unknown): WeeklySnapshotCycle | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const resetTimeSec = typeof obj.resetTimeSec === 'number' && Number.isFinite(obj.resetTimeSec) && obj.resetTimeSec > 0
    ? Math.floor(obj.resetTimeSec)
    : null;
  if (resetTimeSec === null) return null;
  const cycleStartSec = typeof obj.cycleStartSec === 'number' && Number.isFinite(obj.cycleStartSec) && obj.cycleStartSec > 0
    ? Math.floor(obj.cycleStartSec)
    : resetTimeSec - WEEK_SEC;
  const resetTimeIso = normalizeResetTime(obj.resetTimeIso) ?? new Date(resetTimeSec * 1000).toISOString();
  const rawPoints = Array.isArray(obj.points) ? obj.points : [];
  const points = rawPoints
    .map(sanitizePoint)
    .filter((p): p is WeeklySnapshotPoint => p !== null)
    .sort((a, b) => a.at - b.at);
  if (points.length === 0) return null;
  const tier = canonicalTierForMatching(obj.tier);
  return {
    cycleStartSec,
    resetTimeSec,
    resetTimeIso,
    ...(tier ? { tier } : {}),
    points: capCyclePoints(points),
  };
}

function sanitizeSnapshotData(raw: unknown): PersistedWeeklySnapshotFile {
  const empty: PersistedWeeklySnapshotFile = { version: 1, accounts: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const root = raw as Record<string, unknown>;
  if (root.version !== 1 || !root.accounts || typeof root.accounts !== 'object' || Array.isArray(root.accounts)) {
    return empty;
  }
  const accounts: Record<string, WeeklyAccountSnapshotRecord> = {};
  for (const [rawEmailKey, rawAcc] of Object.entries(root.accounts as Record<string, unknown>)) {
    if (!rawAcc || typeof rawAcc !== 'object' || Array.isArray(rawAcc)) continue;
    const accObj = rawAcc as Record<string, unknown>;
    const emailStr = typeof accObj.email === 'string' && accObj.email.trim() ? accObj.email.trim() : rawEmailKey.trim();
    const emailLower = emailStr.toLowerCase();
    if (!emailLower) continue;
    const accTier = canonicalTierForMatching(accObj.tier);
    const rawPools = accObj.pools && typeof accObj.pools === 'object' && !Array.isArray(accObj.pools)
      ? (accObj.pools as Record<string, unknown>)
      : {};
    const pools: Record<string, WeeklyPoolSnapshotRecord> = {};
    for (const [rawPoolKey, rawPool] of Object.entries(rawPools)) {
      if (!rawPool || typeof rawPool !== 'object' || Array.isArray(rawPool)) continue;
      const poolObj = rawPool as Record<string, unknown>;
      const poolKey = (typeof poolObj.poolKey === 'string' && poolObj.poolKey.trim()
        ? poolObj.poolKey.trim()
        : rawPoolKey.trim()).toLowerCase();
      if (!poolKey) continue;
      const displayName = typeof poolObj.displayName === 'string' && poolObj.displayName.trim()
        ? poolObj.displayName.trim()
        : poolKey;
      const poolTier = canonicalTierForMatching(poolObj.tier) || accTier;
      const rawCycles = Array.isArray(poolObj.cycles) ? poolObj.cycles : [];
      const cycles = rawCycles
        .map(sanitizeCycle)
        .filter((c): c is WeeklySnapshotCycle => c !== null)
        .sort((a, b) => a.resetTimeSec - b.resetTimeSec)
        .slice(-MAX_CYCLES_PER_POOL);
      if (cycles.length === 0) continue;
      pools[poolKey] = {
        poolKey,
        displayName,
        ...(poolTier ? { tier: poolTier } : {}),
        cycles,
      };
    }
    if (Object.keys(pools).length === 0) continue;
    accounts[emailLower] = {
      email: emailStr,
      ...(accTier ? { tier: accTier } : {}),
      pools,
    };
  }
  return { version: 1, accounts };
}

interface ExtractedWeeklyBucket {
  poolKey: string;
  displayName: string;
  remaining: number;
  resetTimeSec: number;
  resetTimeIso: string;
  observedAtSec: number;
  stale: boolean;
  source: string;
}

function deriveGroupStandaloneKey(group: NormalizedGroup): string {
  if (group.family === 'gemini' || group.family === 'claude' || group.family === 'argon' || group.family === 'carbon') {
    return group.family;
  }
  const rawName = (group.display_name || group.group_id || '')
    .replace(/(?:[\s_-]+(?:weekly|daily|5h|five[\s_-]*hour|limit|quota))+$/i, '')
    .trim();
  return rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function defaultPoolDisplayName(poolKey: string): string {
  if (poolKey === 'gemini') return 'Gemini';
  if (poolKey === 'claude') return 'Claude/GPT';
  if (poolKey === 'argon') return 'Gemini 4 Argon';
  if (poolKey === 'carbon') return 'Gemini 4 Carbon';
  return poolKey;
}

function extractWeeklyBucketsFromQuota(
  quota: QuotaData | null | undefined,
  referenceNowSec: number,
  options?: { allowStale?: boolean; requireFutureReset?: boolean; overview?: QuotaOverview; normalizedGroups?: NormalizedGroup[] },
): ExtractedWeeklyBucket[] {
  if (!quota || typeof quota !== 'object' || quota.is_forbidden) return [];
  const allowStale = options?.allowStale === true;
  const requireFutureReset = options?.requireFutureReset !== false;
  const overview = options?.overview ?? buildAccountQuotaOverview({ quota }, { nowMs: referenceNowSec * 1000 });
  const sourceDefault = quota.source === 'live' ? 'live' : 'cloud';
  let groups = options?.normalizedGroups;
  if (!groups) {
    try {
      groups = Array.isArray(quota.quota_groups)
        ? normalizeStoredGroups(quota.quota_groups, quota.last_updated ?? referenceNowSec, sourceDefault)
        : [];
    } catch {
      groups = [];
    }
  }

  const byPool = new Map<string, ExtractedWeeklyBucket>();

  for (const group of overview.projectedQuotaGroups ?? []) {
    const poolKey = group.key.trim().toLowerCase();
    if (!poolKey) continue;
    const weeklyWin = group.windows.find(w => w.period === 'weekly');
    if (!weeklyWin || !weeklyWin.known || weeklyWin.remaining === null) continue;
    if (!Number.isFinite(weeklyWin.remaining) || weeklyWin.remaining < 0 || weeklyWin.remaining > 1) continue;
    if (!allowStale && (weeklyWin.stale || weeklyWin.source === 'carried')) continue;
    const resetTimeIso = normalizeResetTime(weeklyWin.resetTime);
    if (!resetTimeIso) continue;
    const resetMs = Date.parse(resetTimeIso);
    if (!Number.isFinite(resetMs)) continue;
    const resetTimeSec = Math.floor(resetMs / 1000);
    if (requireFutureReset && resetTimeSec <= referenceNowSec) continue;

    let remaining = weeklyWin.remaining;
    let bucketObs = typeof weeklyWin.observedAt === 'number' && Number.isFinite(weeklyWin.observedAt) && weeklyWin.observedAt > 0
      ? Math.floor(weeklyWin.observedAt)
      : (typeof quota.last_updated === 'number' && quota.last_updated > 0 ? Math.floor(quota.last_updated) : referenceNowSec);

    // Cross-check normalizedStoredGroups to ensure full raw remaining_fraction precision is preserved.
    for (const ng of groups) {
      const ngKey = deriveGroupStandaloneKey(ng);
      if (ngKey !== poolKey) continue;
      const matchingBuckets = ng.buckets.filter(b =>
        b.disabled !== true &&
        b.window === 'weekly' &&
        b.remaining_fraction_known &&
        b.remaining_fraction !== null &&
        (!allowStale ? (!b.stale && b.source !== 'carried') : true)
      );
      if (matchingBuckets.length > 0) {
        const chosen = matchingBuckets.reduce((l, r) => (l.remaining_fraction! <= r.remaining_fraction! ? l : r));
        if (
          chosen.remaining_fraction !== null &&
          Math.abs(chosen.remaining_fraction - remaining) <= 0.005 &&
          chosen.reset_time &&
          Math.abs(Date.parse(chosen.reset_time) - resetMs) <= 60_000
        ) {
          remaining = chosen.remaining_fraction;
          if (chosen.observed_at && chosen.observed_at > 0) {
            bucketObs = Math.floor(chosen.observed_at);
          }
        }
      }
    }

    byPool.set(poolKey, {
      poolKey,
      displayName: group.displayName || defaultPoolDisplayName(poolKey),
      remaining,
      resetTimeSec,
      resetTimeIso,
      observedAtSec: bucketObs,
      stale: weeklyWin.stale === true,
      source: weeklyWin.source ?? sourceDefault,
    });
  }

  return [...byPool.values()];
}

export class WeeklyQuotaSnapshotStore {
  readonly filePath: string;
  private data: PersistedWeeklySnapshotFile = { version: 1, accounts: {} };
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private nextSaveAtMs = 0;
  private lastWriteAtMs = 0;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly stateDir: string) {
    this.filePath = join(stateDir, 'weekly-quota-snapshots.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        const raw = await readOptionalJson<unknown>(this.filePath, 'weekly-quota-snapshots.json');
        if (!this.loaded && raw !== null) {
          this.data = sanitizeSnapshotData(raw);
          this.lastWriteAtMs = Date.now();
        }
      } catch {
        if (!this.loaded) {
          this.data = { version: 1, accounts: {} };
        }
      } finally {
        this.loaded = true;
        this.loadPromise = null;
      }
    })();
    return this.loadPromise;
  }

  private ensureLoadedSync(): void {
    if (this.loaded) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      this.data = sanitizeSnapshotData(raw);
      this.lastWriteAtMs = Date.now();
    } catch {
      // Missing or corrupt file starts with empty in-memory state.
    }
    this.loaded = true;
  }

  private scheduleSave(delayMs: number): void {
    const clampedDelay = Math.max(0, Math.floor(delayMs));
    const targetAtMs = Date.now() + clampedDelay;
    if (this.saveTimer && this.nextSaveAtMs > 0 && this.nextSaveAtMs <= targetAtMs) {
      return;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.nextSaveAtMs = targetAtMs;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.nextSaveAtMs = 0;
      void this.flush().catch(() => {});
    }, clampedDelay);
    this.saveTimer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.nextSaveAtMs = 0;
    }
    if (this.loadPromise) {
      await this.loadPromise.catch(() => {});
    }
    if (!this.dirty) {
      await this.writeChain.catch(() => {});
      return;
    }
    const payload = structuredClone(this.data);
    this.dirty = false;
    const run = this.writeChain
      .catch(() => {})
      .then(async () => {
        try {
          await atomicJson(this.filePath, payload, undefined, { durability: 'relaxed' });
          this.lastWriteAtMs = Date.now();
        } catch {
          this.dirty = true;
        }
      });
    this.writeChain = run;
    await run;
  }

  recordQuotaSnapshot(input: {
    email: string;
    quota: QuotaData | null | undefined;
    source?: string;
    observedAtSec?: number;
    tier?: string | null;
  }): boolean {
    if (!input || !input.quota || input.quota.is_forbidden) return false;
    const emailTrimmed = typeof input.email === 'string' ? input.email.trim() : '';
    const emailLower = emailTrimmed.toLowerCase();
    if (!emailLower) return false;

    this.ensureLoadedSync();

    const obsSec =
      typeof input.observedAtSec === 'number' && Number.isFinite(input.observedAtSec) && input.observedAtSec > 0
        ? Math.floor(input.observedAtSec)
        : (typeof input.quota.last_updated === 'number' && input.quota.last_updated > 0
            ? Math.floor(input.quota.last_updated)
            : Math.floor(Date.now() / 1000));

    const overview = buildAccountQuotaOverview({ quota: input.quota }, { nowMs: obsSec * 1000 });
    const sourceDefault = input.quota.source === 'live' ? 'live' : 'cloud';
    let normalizedGroups: NormalizedGroup[] = [];
    try {
      normalizedGroups = Array.isArray(input.quota.quota_groups)
        ? normalizeStoredGroups(input.quota.quota_groups, input.quota.last_updated ?? obsSec, sourceDefault)
        : [];
    } catch {
      normalizedGroups = [];
    }

    const buckets = extractWeeklyBucketsFromQuota(input.quota, obsSec, {
      allowStale: false,
      requireFutureReset: true,
      overview,
      normalizedGroups,
    });
    if (buckets.length === 0) return false;

    const src = typeof input.source === 'string' && input.source.trim()
      ? input.source.trim()
      : (input.quota.source ?? 'cloud');
    const resolvedTier = canonicalTierForMatching(
      input.tier ?? input.quota.subscription_tier ?? overview.subscriptionTier
    );

    let accRec = this.data.accounts[emailLower];
    if (!accRec) {
      accRec = {
        email: emailTrimmed,
        ...(resolvedTier ? { tier: resolvedTier } : {}),
        pools: {},
      };
      this.data.accounts[emailLower] = accRec;
    } else {
      accRec.email = emailTrimmed;
      if (resolvedTier) accRec.tier = resolvedTier;
    }

    let changed = false;
    let addedPoint = false;
    let updatedIdleOnly = false;

    for (const bucket of buckets) {
      let poolRec = accRec.pools[bucket.poolKey];
      if (!poolRec) {
        poolRec = {
          poolKey: bucket.poolKey,
          displayName: bucket.displayName,
          ...(resolvedTier ? { tier: resolvedTier } : {}),
          cycles: [],
        };
        accRec.pools[bucket.poolKey] = poolRec;
      } else {
        if (bucket.displayName) poolRec.displayName = bucket.displayName;
        if (resolvedTier) poolRec.tier = resolvedTier;
      }

      const latest = poolRec.cycles[poolRec.cycles.length - 1];
      const lastPoint = latest?.points[latest.points.length - 1];
      const sameCycle = Boolean(
        latest &&
        Math.abs(bucket.resetTimeSec - latest.resetTimeSec) <= SAME_CYCLE_RESET_TOLERANCE_SEC &&
        (!lastPoint || bucket.remaining <= lastPoint.remaining + SAME_CYCLE_REMAINING_TOLERANCE)
      );

      if (sameCycle && latest) {
        if (latest.resetTimeSec !== bucket.resetTimeSec || latest.resetTimeIso !== bucket.resetTimeIso) {
          latest.resetTimeSec = bucket.resetTimeSec;
          latest.resetTimeIso = bucket.resetTimeIso;
          latest.cycleStartSec = bucket.resetTimeSec - WEEK_SEC;
          changed = true;
        }
        if (resolvedTier && latest.tier !== resolvedTier) {
          latest.tier = resolvedTier;
          changed = true;
        }
        if (!lastPoint || hasMeaningfulRemainingChange(bucket.remaining, lastPoint.remaining)) {
          latest.points.push({
            at: obsSec,
            lastSeenAt: obsSec,
            remaining: bucket.remaining,
            source: src,
          });
          latest.points = capCyclePoints(latest.points);
          changed = true;
          addedPoint = true;
        } else if (obsSec > lastPoint.lastSeenAt) {
          lastPoint.lastSeenAt = obsSec;
          changed = true;
          updatedIdleOnly = true;
        }
      } else {
        // Ignore out-of-order stale cycles older than latest cycle.
        if (latest && bucket.resetTimeSec < latest.resetTimeSec - SAME_CYCLE_RESET_TOLERANCE_SEC) {
          continue;
        }
        poolRec.cycles.push({
          cycleStartSec: bucket.resetTimeSec - WEEK_SEC,
          resetTimeSec: bucket.resetTimeSec,
          resetTimeIso: bucket.resetTimeIso,
          ...(resolvedTier ? { tier: resolvedTier } : {}),
          points: [{
            at: obsSec,
            lastSeenAt: obsSec,
            remaining: bucket.remaining,
            source: src,
          }],
        });
        if (poolRec.cycles.length > MAX_CYCLES_PER_POOL) {
          poolRec.cycles = poolRec.cycles.slice(-MAX_CYCLES_PER_POOL);
        }
        changed = true;
        addedPoint = true;
      }
    }

    if (changed) {
      this.dirty = true;
      if (addedPoint) {
        this.scheduleSave(SAVE_DEBOUNCE_MS);
      } else if (updatedIdleOnly) {
        const elapsed = Date.now() - this.lastWriteAtMs;
        this.scheduleSave(Math.max(0, IDLE_SAVE_THROTTLE_MS - elapsed));
      }
    }
    return changed;
  }

  getAccountRecord(email: string): WeeklyAccountSnapshotRecord | null {
    const emailLower = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!emailLower) return null;
    this.ensureLoadedSync();
    return this.data.accounts[emailLower] ?? null;
  }

  listEmails(): string[] {
    this.ensureLoadedSync();
    return Object.values(this.data.accounts).map(a => a.email);
  }

  getEarliestCycleStartSec(email?: string, maxCyclesPerPool = MAX_RECENT_CYCLES + 1): number | null {
    this.ensureLoadedSync();
    let earliest: number | null = null;
    const considerAcc = (acc: WeeklyAccountSnapshotRecord | undefined) => {
      if (!acc) return;
      for (const pool of Object.values(acc.pools)) {
        const relevant = pool.cycles.slice(-Math.max(1, maxCyclesPerPool));
        for (const cycle of relevant) {
          if (earliest === null || cycle.cycleStartSec < earliest) {
            earliest = cycle.cycleStartSec;
          }
        }
      }
    };
    if (email) {
      considerAcc(this.data.accounts[email.trim().toLowerCase()]);
    } else {
      for (const acc of Object.values(this.data.accounts)) {
        considerAcc(acc);
      }
    }
    return earliest;
  }
}

export function mapModelToWeeklyPool(input: {
  model: string;
  standaloneWeeklyPoolKeys?: ReadonlySet<string>;
  quotaOverview?: QuotaOverview | null;
  normalizedGroups?: NormalizedGroup[];
  preferredCorePoolKeys?: ReadonlySet<string>;
}): string {
  const rawModel = String(input.model ?? '').trim();
  const resolvedModel = resolveDatabaseModelFullName(rawModel, null) || rawModel;
  const standaloneKeys = input.standaloneWeeklyPoolKeys ?? new Set<string>();
  const groups = input.normalizedGroups ?? [];
  const overview = input.quotaOverview ?? null;

  const modelLower = resolvedModel.toLowerCase();
  const rawLower = rawModel.toLowerCase();
  const baseKey = normalizeBaseModelKey(resolvedModel);

  const matchedOverviewModel = overview?.models.find(m => {
    const mid = (m.model_id ?? m.name ?? '').toLowerCase();
    const mname = (m.name ?? '').toLowerCase();
    const alias = (m.model_or_alias ?? '').toLowerCase();
    if (mid && (mid === modelLower || mid === rawLower)) return true;
    if (mname && (mname === modelLower || mname === rawLower)) return true;
    if (alias && (alias === modelLower || alias === rawLower)) return true;
    return Boolean(baseKey && normalizeBaseModelKey(m.model_id ?? m.name) === baseKey);
  });

  if (matchedOverviewModel?.quota_bucket_name) {
    const bucketNorm = matchedOverviewModel.quota_bucket_name
      .trim()
      .replace(/(?:[\s_-]+(?:weekly|daily|5h|five[\s_-]*hour|limit|quota))+$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (bucketNorm && standaloneKeys.has(bucketNorm)) {
      return bucketNorm;
    }
  }

  if (groups.length > 0) {
    const descGroup = findGroupForModelByDescription(
      {
        model_id: resolvedModel,
        name: rawModel,
        display_name: matchedOverviewModel?.display_name ?? resolvedModel,
      },
      groups,
    );
    if (descGroup) {
      const gKey = deriveGroupStandaloneKey(descGroup);
      if (descGroup.family === 'gemini' || descGroup.family === 'claude') {
        return descGroup.family;
      }
      if (gKey && standaloneKeys.has(gKey)) {
        return gKey;
      }
    }
  }

  if (overview?.projectedQuotaGroups && standaloneKeys.size > 0) {
    const candKeys = new Set<string>();
    for (const raw of [resolvedModel, rawModel, matchedOverviewModel?.display_name]) {
      if (typeof raw === 'string' && raw.trim()) {
        const norm = normalizeGroupMemberKey(raw);
        if (norm) candKeys.add(norm);
      }
    }
    for (const pg of overview.projectedQuotaGroups as ProjectedQuotaGroup[]) {
      const pgKey = pg.key.trim().toLowerCase();
      if (!pg.isStandalone || !standaloneKeys.has(pgKey)) continue;
      if (pg.description) {
        const labels = extractGroupMemberLabels(pg.description);
        if (labels.some(lbl => {
          const nk = normalizeGroupMemberKey(lbl);
          return nk && candKeys.has(nk);
        })) {
          return pgKey;
        }
      }
    }
  }

  const classified = classifyFamily({
    modelId: resolvedModel,
    displayName: matchedOverviewModel?.display_name,
    modelProvider: matchedOverviewModel?.model_provider,
    modelOrAlias: matchedOverviewModel?.model_or_alias,
  });

  if ((classified === 'argon' || classified === 'carbon') && standaloneKeys.has(classified)) {
    return classified;
  }

  const codename = extractStandaloneGeminiCodename(resolvedModel) ?? extractStandaloneGeminiCodename(rawModel);
  if (codename) {
    if (standaloneKeys.has(codename)) return codename;
    for (const sk of standaloneKeys) {
      if (sk === `gemini-4-${codename}` || sk.endsWith(`-${codename}`)) {
        return sk;
      }
    }
  }

  if (baseKey && standaloneKeys.has(baseKey)) {
    return baseKey;
  }
  for (const sk of standaloneKeys) {
    if (sk === 'argon' || sk === 'carbon') continue;
    if (sk.length >= 3 && (baseKey === sk || baseKey.endsWith(`-${sk}`) || baseKey.includes(`-${sk}-`))) {
      return sk;
    }
  }

  if (classified === 'claude') return 'claude';
  if (classified === 'gemini') return 'gemini';
  if (classified === 'argon') {
    return overview?.argonStatus?.pooledInFamily ?? 'gemini';
  }
  if (classified === 'carbon') {
    return overview?.carbonStatus?.pooledInFamily ?? 'gemini';
  }

  if (matchedOverviewModel?.family === 'claude' || matchedOverviewModel?.family === 'gemini') {
    return matchedOverviewModel.family;
  }
  if (/(?:qwen|cohere|command|yi-|glm-|moonshot|kimi|baichuan|minimax|doubao|step-|perplexity|sonar|reka|jamba|nemotron)/i.test(resolvedModel)) {
    return 'claude';
  }
  if (/(?:gemma|imagen|veo|palm|bison|learnlm|codey)/i.test(resolvedModel)) {
    return 'gemini';
  }
  if (isUnknownModelName(resolvedModel) && input.preferredCorePoolKeys) {
    if (!input.preferredCorePoolKeys.has('gemini') && input.preferredCorePoolKeys.has('claude')) {
      return 'claude';
    }
  }
  return 'gemini';
}

interface CalibrationSample {
  value: number;
  weight: number;
}

interface EventStats {
  tokens: number;
  requests: number;
  pricedUsd: number;
  unpricedCount: number;
  unpricedTokens: number;
  sshTokens: number;
  sshRequests: number;
}

interface DropIntervalPartition {
  kind: 'drop';
  drop: number;
  gapSec: number;
  currAt: number;
  recentEvents: WeeklyAttributionEvent[];
  carryEvents: WeeklyAttributionEvent[];
  silentSec: number;
}

interface CycleAttributionComputed {
  cycleStartSec: number;
  resetTimeSec: number;
  resetTimeIso: string;
  remainingPct: number;
  totalUsedPct: number;
  localEstimatedUsedPct: number | null;
  otherEstimatedUsedPct: number | null;
  localTokens: number;
  localRequests: number;
  localUsd: number;
  unpricedRequests: number;
  sshTokens: number;
  sshRequests: number;
  confidence: WeeklyAttributionConfidence;
  calibrationSamples: number;
  usdPer1Pct: number | null;
  snapshotCount: number;
  firstSnapshotAt: number | null;
  hasPreSnapshotEstimate: boolean;
  ambiguousDropPct: number;
}

function summarizeEvents(events: ReadonlyArray<WeeklyAttributionEvent>): EventStats {
  let tokens = 0;
  let requests = 0;
  let pricedUsd = 0;
  let unpricedCount = 0;
  let unpricedTokens = 0;
  let sshTokens = 0;
  let sshRequests = 0;
  for (const ev of events) {
    const tok = Number.isFinite(ev.total_tokens) && ev.total_tokens > 0 ? ev.total_tokens : 0;
    tokens += tok;
    requests += 1;
    if (typeof ev.estimated_usd === 'number' && Number.isFinite(ev.estimated_usd) && ev.estimated_usd >= 0) {
      pricedUsd += ev.estimated_usd;
    } else {
      unpricedCount += 1;
      unpricedTokens += tok;
    }
    if (ev.environment_kind === 'ssh') {
      sshTokens += tok;
      sshRequests += 1;
    }
  }
  return { tokens, requests, pricedUsd, unpricedCount, unpricedTokens, sshTokens, sshRequests };
}

function partitionCycleIntervals(
  points: ReadonlyArray<WeeklySnapshotPoint>,
  cycleEvents: ReadonlyArray<WeeklyAttributionEvent>,
  cycleStartSec: number,
): {
  firstSnap: WeeklySnapshotPoint | null;
  lastSnap: WeeklySnapshotPoint | null;
  preDrop: number;
  preEvents: WeeklyAttributionEvent[];
  drops: DropIntervalPartition[];
  cleanSamples: CalibrationSample[];
  cleanTokenSamples: CalibrationSample[];
} {
  if (points.length === 0) {
    return {
      firstSnap: null,
      lastSnap: null,
      preDrop: 0,
      preEvents: [],
      drops: [],
      cleanSamples: [],
      cleanTokenSamples: [],
    };
  }
  const sortedPoints = [...points].sort((a, b) => a.at - b.at);
  const firstSnap = sortedPoints[0]!;
  const lastSnap = sortedPoints[sortedPoints.length - 1]!;
  const preDrop = Math.max(0, 1 - firstSnap.remaining);
  const consumed = new Set<number>();

  const preEvents: WeeklyAttributionEvent[] = [];
  let lastDropEnd = cycleStartSec;
  if (preDrop > MIN_DROP_THRESHOLD) {
    for (let i = 0; i < cycleEvents.length; i += 1) {
      const ev = cycleEvents[i]!;
      if (ev.timestamp_seconds >= cycleStartSec && ev.timestamp_seconds <= firstSnap.at) {
        preEvents.push(ev);
        consumed.add(i);
      }
    }
    lastDropEnd = firstSnap.at;
  }

  const drops: DropIntervalPartition[] = [];
  const cleanSamples: CalibrationSample[] = [];
  const cleanTokenSamples: CalibrationSample[] = [];

  for (let pIdx = 1; pIdx < sortedPoints.length; pIdx += 1) {
    const prev = sortedPoints[pIdx - 1]!;
    const curr = sortedPoints[pIdx]!;
    const drop = prev.remaining - curr.remaining;
    if (drop <= MIN_DROP_THRESHOLD) {
      continue;
    }

    const gapSec = Math.max(0, curr.at - prev.lastSeenAt);
    const recentStart = prev.lastSeenAt - LAG_BUFFER_SEC;
    const recentEnd = curr.at;
    const carryStart = Math.max(lastDropEnd, recentStart - CARRY_LOOKBACK_SEC);

    const recentEvents: WeeklyAttributionEvent[] = [];
    const carryEvents: WeeklyAttributionEvent[] = [];
    const recentIndices: number[] = [];
    const carryIndices: number[] = [];

    for (let i = 0; i < cycleEvents.length; i += 1) {
      if (consumed.has(i)) continue;
      const ev = cycleEvents[i]!;
      const ts = ev.timestamp_seconds;
      if (ts > recentEnd) break;
      if (ts >= recentStart && ts <= recentEnd) {
        recentEvents.push(ev);
        recentIndices.push(i);
      } else if (ts >= carryStart && ts < recentStart) {
        carryEvents.push(ev);
        carryIndices.push(i);
      }
    }

    const latestCarryTs = carryEvents.length > 0 ? carryEvents[carryEvents.length - 1]!.timestamp_seconds : 0;
    const silentSec = recentEvents.length > 0
      ? Math.max(0, curr.at - recentEvents[recentEvents.length - 1]!.timestamp_seconds)
      : (carryEvents.length > 0 ? Math.max(0, curr.at - latestCarryTs) : Number.POSITIVE_INFINITY);

    for (const idx of recentIndices) consumed.add(idx);
    for (const idx of carryIndices) consumed.add(idx);
    lastDropEnd = Math.max(lastDropEnd, curr.at);

    drops.push({
      kind: 'drop',
      drop,
      gapSec,
      currAt: curr.at,
      recentEvents,
      carryEvents,
      silentSec,
    });

    // Clean calibration sample: short active interval with recent local events, meaningful USD/tokens & drop.
    if (gapSec <= SHORT_GAP_SEC && recentEvents.length > 0) {
      const intervalEvents = carryEvents.length > 0 ? [...carryEvents, ...recentEvents] : recentEvents;
      const stats = summarizeEvents(intervalEvents);
      if (
        stats.requests > 0 &&
        stats.unpricedCount === 0 &&
        stats.pricedUsd >= MIN_CALIBRATION_USD &&
        drop >= MIN_CALIBRATION_DROP
      ) {
        cleanSamples.push({
          value: stats.pricedUsd / (drop * 100),
          weight: drop,
        });
      }
      if (
        stats.requests > 0 &&
        stats.tokens >= MIN_CALIBRATION_TOKENS &&
        drop >= MIN_CALIBRATION_DROP
      ) {
        cleanTokenSamples.push({
          value: stats.tokens / (drop * 100),
          weight: drop,
        });
      }
    }
  }

  return {
    firstSnap,
    lastSnap,
    preDrop,
    preEvents,
    drops,
    cleanSamples,
    cleanTokenSamples,
  };
}

function calibrateRate(samples: ReadonlyArray<CalibrationSample>): {
  rate: number | null;
  samples: number;
} {
  const valid = samples.filter(
    s => Number.isFinite(s.value) && s.value > 0 && Number.isFinite(s.weight) && s.weight > 0
  );
  const count = valid.length;
  if (count === 0) return { rate: null, samples: 0 };
  const sorted = [...valid].sort((a, b) => a.value - b.value);
  if (count === 1) {
    return { rate: sorted[0]!.value, samples: 1 };
  }
  if (count <= 3) {
    const mid = Math.floor(count / 2);
    const median = count % 2 === 1
      ? sorted[mid]!.value
      : (sorted[mid - 1]!.value + sorted[mid]!.value) / 2;
    return { rate: median, samples: count };
  }
  const totalWeight = sorted.reduce((acc, s) => acc + s.weight, 0);
  if (totalWeight <= 0) {
    return { rate: sorted[Math.floor(count * 0.7)]!.value, samples: count };
  }
  const targetWeight = 0.70 * totalWeight;
  let cumWeight = 0;
  for (const sample of sorted) {
    cumWeight += sample.weight;
    if (cumWeight >= targetWeight) {
      return { rate: sample.value, samples: count };
    }
  }
  return { rate: sorted[sorted.length - 1]!.value, samples: count };
}

function estimateExpectedDrop(
  stats: EventStats,
  usdPer1Pct: number | null,
  tokensPer1Pct: number | null,
): number | null {
  if (stats.unpricedCount === 0 && stats.pricedUsd > 0 && usdPer1Pct !== null && usdPer1Pct > 0) {
    return stats.pricedUsd / usdPer1Pct / 100;
  }
  if (stats.pricedUsd > 0 && usdPer1Pct !== null && usdPer1Pct > 0) {
    const pricedDrop = stats.pricedUsd / usdPer1Pct / 100;
    if (tokensPer1Pct !== null && tokensPer1Pct > 0) {
      return pricedDrop + stats.unpricedTokens / tokensPer1Pct / 100;
    }
    if (stats.tokens > 0 && stats.unpricedTokens / stats.tokens <= 0.1) {
      return pricedDrop;
    }
    return null;
  }
  if (stats.tokens > 0 && tokensPer1Pct !== null && tokensPer1Pct > 0) {
    return stats.tokens / tokensPer1Pct / 100;
  }
  return null;
}

function computeCycleAttribution(params: {
  cycle: WeeklySnapshotCycle;
  priorCycles: ReadonlyArray<WeeklySnapshotCycle>;
  currentTier: string;
  poolEventsAll: ReadonlyArray<WeeklyAttributionEvent>;
  nowSec: number;
}): CycleAttributionComputed {
  const { cycle, priorCycles, currentTier, poolEventsAll, nowSec } = params;
  const cycleStartSec = cycle.cycleStartSec;
  const lastPointAt = cycle.points[cycle.points.length - 1]?.lastSeenAt ?? 0;
  const cycleEndSec = Math.min(cycle.resetTimeSec, Math.max(nowSec, lastPointAt));

  const cycleEvents = poolEventsAll.filter(
    ev => ev.timestamp_seconds >= cycleStartSec && ev.timestamp_seconds <= cycleEndSec
  );
  const cycleTotals = summarizeEvents(cycleEvents);

  const partitioned = partitionCycleIntervals(cycle.points, cycleEvents, cycleStartSec);
  const currentSamples = partitioned.cleanSamples;
  const currentTokenSamples = partitioned.cleanTokenSamples;

  const historyUsdSamples: CalibrationSample[] = [];
  const historyTokenSamples: CalibrationSample[] = [];
  if (currentSamples.length < 3 || currentTokenSamples.length < 3) {
    const matchingPrior = priorCycles
      .filter(hc => hc.resetTimeSec < cycle.resetTimeSec - SAME_CYCLE_RESET_TOLERANCE_SEC && tiersCompatible(hc.tier, currentTier))
      .slice(-MAX_RECENT_CYCLES);
    for (const hc of matchingPrior) {
      const hcEvents = poolEventsAll.filter(
        ev => ev.timestamp_seconds >= hc.cycleStartSec && ev.timestamp_seconds <= hc.resetTimeSec
      );
      const hcPart = partitionCycleIntervals(hc.points, hcEvents, hc.cycleStartSec);
      if (currentSamples.length < 3) {
        historyUsdSamples.push(...hcPart.cleanSamples);
      }
      if (currentTokenSamples.length < 3) {
        historyTokenSamples.push(...hcPart.cleanTokenSamples);
      }
    }
  }

  const effectiveUsdSamples = currentSamples.length >= 3
    ? currentSamples
    : [...currentSamples, ...historyUsdSamples];
  const effectiveTokenSamples = currentTokenSamples.length >= 3
    ? currentTokenSamples
    : [...currentTokenSamples, ...historyTokenSamples];
  const { rate: usdPer1Pct, samples: usdCalibrationSamples } = calibrateRate(effectiveUsdSamples);
  const { rate: tokensPer1Pct, samples: tokenCalibrationSamples } = calibrateRate(effectiveTokenSamples);

  const isUsdCalibrated = usdCalibrationSamples >= 1 && usdPer1Pct !== null && usdPer1Pct > 0;
  const isTokenCalibrated = tokenCalibrationSamples >= 1 && tokensPer1Pct !== null && tokensPer1Pct > 0;
  const isCalibrated = isUsdCalibrated || isTokenCalibrated;
  const canSpikeClip = usdCalibrationSamples >= 2 || tokenCalibrationSamples >= 2;
  const calibrationSamples = usdCalibrationSamples > 0 ? usdCalibrationSamples : tokenCalibrationSamples;

  let attributedLocalDrop = 0;
  let attributedOtherDrop = 0;
  let ambiguousDrop = 0;
  let hasPreSnapshotEstimate = false;

  // Cold-start pre-snapshot interval [cycleStartSec, firstSnap.at]
  if (partitioned.preDrop > MIN_DROP_THRESHOLD) {
    if (partitioned.preEvents.length === 0) {
      attributedOtherDrop += partitioned.preDrop;
    } else {
      const preStats = summarizeEvents(partitioned.preEvents);
      const expectedPreDrop = isCalibrated
        ? estimateExpectedDrop(preStats, usdPer1Pct, tokensPer1Pct)
        : null;
      if (expectedPreDrop !== null && Number.isFinite(expectedPreDrop) && expectedPreDrop > 0) {
        const estPreLocal = Math.min(partitioned.preDrop, expectedPreDrop);
        attributedLocalDrop += estPreLocal;
        attributedOtherDrop += Math.max(0, partitioned.preDrop - estPreLocal);
        hasPreSnapshotEstimate = true;
      } else {
        ambiguousDrop += partitioned.preDrop;
      }
    }
  }

  // Adjacent drop intervals
  for (const item of partitioned.drops) {
    const hasAnyIntervalEvents = item.recentEvents.length > 0 || item.carryEvents.length > 0;
    const isSituation1 = !hasAnyIntervalEvents || (item.recentEvents.length === 0 && item.silentSec > SILENT_THRESHOLD_SEC);

    if (isSituation1) {
      if (item.carryEvents.length > 0 && isCalibrated) {
        const carryStats = summarizeEvents(item.carryEvents);
        const expectedCarryDrop = estimateExpectedDrop(carryStats, usdPer1Pct, tokensPer1Pct);
        if (expectedCarryDrop !== null && Number.isFinite(expectedCarryDrop) && expectedCarryDrop > 0) {
          const carryLocal = Math.min(item.drop, expectedCarryDrop);
          attributedLocalDrop += carryLocal;
          attributedOtherDrop += Math.max(0, item.drop - carryLocal);
        } else {
          attributedOtherDrop += item.drop;
        }
      } else {
        attributedOtherDrop += item.drop;
      }
      continue;
    }

    const intervalEvents = item.carryEvents.length > 0
      ? [...item.carryEvents, ...item.recentEvents]
      : item.recentEvents;
    const stats = summarizeEvents(intervalEvents);

    if (item.gapSec <= SHORT_GAP_SEC) {
      // Situation 2: short active interval
      const expectedDrop = isCalibrated && canSpikeClip
        ? estimateExpectedDrop(stats, usdPer1Pct, tokensPer1Pct)
        : null;
      if (expectedDrop !== null && Number.isFinite(expectedDrop) && expectedDrop > 0) {
        if (item.drop > expectedDrop * SPIKE_CLIP_MULTIPLIER) {
          const clippedLocal = Math.min(item.drop, expectedDrop);
          attributedLocalDrop += clippedLocal;
          attributedOtherDrop += Math.max(0, item.drop - clippedLocal);
        } else {
          attributedLocalDrop += item.drop;
        }
      } else {
        attributedLocalDrop += item.drop;
      }
    } else {
      // Situation 3: long mixed gap (> 15 min) with local events
      const expectedDrop = isCalibrated
        ? estimateExpectedDrop(stats, usdPer1Pct, tokensPer1Pct)
        : null;
      if (expectedDrop !== null && Number.isFinite(expectedDrop) && expectedDrop > 0) {
        const estLocal = Math.min(item.drop, expectedDrop);
        attributedLocalDrop += estLocal;
        attributedOtherDrop += Math.max(0, item.drop - estLocal);
      } else {
        ambiguousDrop += item.drop;
      }
    }
  }

  const remainingFraction = partitioned.lastSnap ? clamp(partitioned.lastSnap.remaining, 0, 1) : 1;
  const remainingPct = round1(remainingFraction * 100);
  const totalUsedPct = round1(Math.max(0, 100 - remainingPct));
  const ambiguousDropPct = round1(clamp(ambiguousDrop * 100, 0, 100));

  let localEstimatedUsedPct: number | null;
  let otherEstimatedUsedPct: number | null;
  let confidence: WeeklyAttributionConfidence;

  if (cycle.points.length === 0) {
    localEstimatedUsedPct = null;
    otherEstimatedUsedPct = null;
    confidence = 'none';
  } else if (cycleTotals.requests === 0) {
    localEstimatedUsedPct = 0;
    otherEstimatedUsedPct = totalUsedPct;
    confidence = totalUsedPct > 0 ? 'high' : 'none';
  } else if (totalUsedPct <= 0 || (ambiguousDrop > MIN_DROP_THRESHOLD && (attributedLocalDrop <= 0 || !isCalibrated))) {
    localEstimatedUsedPct = null;
    otherEstimatedUsedPct = null;
    confidence = 'calibrating';
  } else {
    localEstimatedUsedPct = round1(clamp(attributedLocalDrop * 100, 0, totalUsedPct));
    const maxOtherPct = round1(Math.max(0, totalUsedPct - localEstimatedUsedPct));
    otherEstimatedUsedPct = ambiguousDrop > MIN_DROP_THRESHOLD
      ? round1(clamp(attributedOtherDrop * 100, 0, maxOtherPct))
      : maxOtherPct;

    const ambiguousShare = totalUsedPct > 0 ? ambiguousDropPct / totalUsedPct : 0;
    const preDropShare = totalUsedPct > 0 ? (partitioned.preDrop * 100) / totalUsedPct : 0;
    if (
      usdCalibrationSamples >= 4 &&
      ambiguousDropPct <= 0.1 &&
      cycleTotals.unpricedCount === 0 &&
      (!hasPreSnapshotEstimate || preDropShare <= 0.25)
    ) {
      confidence = 'high';
    } else if (
      (calibrationSamples >= 2 && ambiguousShare <= 0.35 && cycleTotals.unpricedCount === 0) ||
      (ambiguousDropPct <= 0.1 && cycleTotals.unpricedCount === 0 && currentSamples.length >= 2)
    ) {
      confidence = 'medium';
    } else {
      confidence = 'low';
    }
  }

  return {
    cycleStartSec,
    resetTimeSec: cycle.resetTimeSec,
    resetTimeIso: cycle.resetTimeIso,
    remainingPct,
    totalUsedPct,
    localEstimatedUsedPct,
    otherEstimatedUsedPct,
    localTokens: cycleTotals.tokens,
    localRequests: cycleTotals.requests,
    localUsd: round6(cycleTotals.pricedUsd),
    unpricedRequests: cycleTotals.unpricedCount,
    sshTokens: cycleTotals.sshTokens,
    sshRequests: cycleTotals.sshRequests,
    confidence,
    calibrationSamples,
    usdPer1Pct: usdPer1Pct !== null ? round4(usdPer1Pct) : null,
    snapshotCount: cycle.points.length,
    firstSnapshotAt: partitioned.firstSnap?.at ?? null,
    hasPreSnapshotEstimate,
    ambiguousDropPct: cycleTotals.requests === 0 ? 0 : ambiguousDropPct,
  };
}

function mergeCycleWithLiveBucket(
  storedCycle: WeeklySnapshotCycle | undefined,
  bucket: ExtractedWeeklyBucket,
): WeeklySnapshotCycle {
  if (!storedCycle) {
    return {
      cycleStartSec: bucket.resetTimeSec - WEEK_SEC,
      resetTimeSec: bucket.resetTimeSec,
      resetTimeIso: bucket.resetTimeIso,
      points: [{
        at: bucket.observedAtSec,
        lastSeenAt: bucket.observedAtSec,
        remaining: bucket.remaining,
        source: bucket.source,
      }],
    };
  }
  const clonedPoints = storedCycle.points.map(p => ({ ...p }));
  const last = clonedPoints[clonedPoints.length - 1];
  if (!last) {
    clonedPoints.push({
      at: bucket.observedAtSec,
      lastSeenAt: bucket.observedAtSec,
      remaining: bucket.remaining,
      source: bucket.source,
    });
  } else if (hasMeaningfulRemainingChange(bucket.remaining, last.remaining) && bucket.observedAtSec >= last.at) {
    clonedPoints.push({
      at: bucket.observedAtSec,
      lastSeenAt: bucket.observedAtSec,
      remaining: bucket.remaining,
      source: bucket.source,
    });
  } else if (bucket.observedAtSec > last.lastSeenAt && !bucket.stale) {
    last.lastSeenAt = bucket.observedAtSec;
  }
  return {
    ...storedCycle,
    resetTimeSec: bucket.resetTimeSec,
    resetTimeIso: bucket.resetTimeIso,
    cycleStartSec: bucket.resetTimeSec - WEEK_SEC,
    points: capCyclePoints(clonedPoints),
  };
}

function poolSortRank(poolKey: string): number {
  if (poolKey === 'gemini') return 0;
  if (poolKey === 'claude') return 1;
  if (poolKey === 'argon') return 2;
  if (poolKey === 'carbon') return 3;
  return 4;
}

export function computeAccountWeeklyAttribution(input: {
  accountId: string | null;
  email: string;
  name?: string | null;
  tier?: string | null;
  quota?: QuotaData | null;
  snapshotStore?: WeeklyQuotaSnapshotStore | null;
  storedAccount?: WeeklyAccountSnapshotRecord | null;
  events: ReadonlyArray<WeeklyAttributionEvent>;
  nowSec?: number;
}): AccountWeeklyAttribution {
  const nowSec =
    typeof input.nowSec === 'number' && Number.isFinite(input.nowSec) && input.nowSec > 0
      ? Math.floor(input.nowSec)
      : Math.floor(Date.now() / 1000);
  const emailTrimmed = String(input.email ?? '').trim();
  const emailLower = emailTrimmed.toLowerCase();
  const storedAccount = input.storedAccount ?? (emailLower ? input.snapshotStore?.getAccountRecord(emailLower) : null) ?? null;

  const overview = input.quota
    ? buildAccountQuotaOverview({ quota: input.quota }, { nowMs: nowSec * 1000 })
    : null;
  let normalizedGroups: NormalizedGroup[] = [];
  if (input.quota && Array.isArray(input.quota.quota_groups)) {
    try {
      const src = input.quota.source === 'live' ? 'live' : 'cloud';
      normalizedGroups = normalizeStoredGroups(input.quota.quota_groups, input.quota.last_updated ?? nowSec, src);
    } catch {
      normalizedGroups = [];
    }
  }

  const resolvedTier = canonicalTierForMatching(
    input.tier ?? input.quota?.subscription_tier ?? overview?.subscriptionTier ?? storedAccount?.tier
  );

  // Extract weekly buckets from quota (allow stale for standby display, prefer future resetTime)
  const futureLiveBuckets = input.quota
    ? extractWeeklyBucketsFromQuota(input.quota, nowSec, {
        allowStale: true,
        requireFutureReset: true,
        overview: overview ?? undefined,
        normalizedGroups,
      })
    : [];
  const allLiveBuckets = input.quota
    ? extractWeeklyBucketsFromQuota(input.quota, nowSec, {
        allowStale: true,
        requireFutureReset: false,
        overview: overview ?? undefined,
        normalizedGroups,
      })
    : [];
  const liveBucketByPool = new Map<string, ExtractedWeeklyBucket>();
  for (const b of allLiveBuckets) liveBucketByPool.set(b.poolKey, b);
  for (const b of futureLiveBuckets) liveBucketByPool.set(b.poolKey, b);

  // Collect all pool keys present in current quota OR snapshotStore
  const poolKeys = new Set<string>();
  for (const b of liveBucketByPool.keys()) poolKeys.add(b);
  if (storedAccount) {
    for (const pk of Object.keys(storedAccount.pools)) {
      poolKeys.add(pk.toLowerCase());
    }
  }

  const standaloneWeeklyPoolKeys = new Set<string>();
  const preferredCorePoolKeys = new Set<string>();
  for (const pk of poolKeys) {
    if (pk === 'gemini' || pk === 'claude') {
      preferredCorePoolKeys.add(pk);
    } else {
      standaloneWeeklyPoolKeys.add(pk);
    }
  }

  // Filter events matching this account and bin by poolKey
  const eventsByPool = new Map<string, WeeklyAttributionEvent[]>();
  for (const ev of input.events) {
    if (!ev || ev.timestamp_seconds <= 0) continue;
    if (ev.db_file === 'recovered_session.db' || ev.db_file === 'recovered_enterprise_session.db') continue;
    const matchesId = Boolean(input.accountId && ev.account_id && ev.account_id === input.accountId);
    const matchesEmail = Boolean(emailLower && ev.account_email && ev.account_email.trim().toLowerCase() === emailLower);
    if (!matchesId && !matchesEmail) continue;

    const targetPool = mapModelToWeeklyPool({
      model: ev.model,
      standaloneWeeklyPoolKeys,
      quotaOverview: overview,
      normalizedGroups,
      preferredCorePoolKeys,
    });
    let bucket = eventsByPool.get(targetPool);
    if (!bucket) {
      bucket = [];
      eventsByPool.set(targetPool, bucket);
    }
    bucket.push(ev);
  }
  for (const list of eventsByPool.values()) {
    list.sort((a, b) => a.timestamp_seconds - b.timestamp_seconds || (a.event_key ?? '').localeCompare(b.event_key ?? ''));
  }

  const sortedPoolKeys = [...poolKeys].sort((a, b) => poolSortRank(a) - poolSortRank(b) || a.localeCompare(b));
  const pools: WeeklyPoolAttribution[] = [];

  for (const poolKey of sortedPoolKeys) {
    const storedPool = storedAccount?.pools[poolKey];
    const storedCycles = storedPool?.cycles ? [...storedPool.cycles].sort((a, b) => a.resetTimeSec - b.resetTimeSec) : [];
    const liveBucket = liveBucketByPool.get(poolKey);
    const poolEvents = eventsByPool.get(poolKey) ?? [];

    let currentCycle: WeeklySnapshotCycle | undefined;
    let priorCycles: WeeklySnapshotCycle[] = [];

    if (liveBucket && liveBucket.resetTimeSec > nowSec) {
      const matchedStored = [...storedCycles]
        .reverse()
        .find(c => Math.abs(c.resetTimeSec - liveBucket.resetTimeSec) <= SAME_CYCLE_RESET_TOLERANCE_SEC);
      currentCycle = mergeCycleWithLiveBucket(matchedStored, liveBucket);
      priorCycles = storedCycles.filter(c => c !== matchedStored && c.resetTimeSec < currentCycle!.resetTimeSec - SAME_CYCLE_RESET_TOLERANCE_SEC);
    } else if (storedCycles.length > 0) {
      const latestStored = storedCycles[storedCycles.length - 1]!;
      if (liveBucket && Math.abs(latestStored.resetTimeSec - liveBucket.resetTimeSec) <= SAME_CYCLE_RESET_TOLERANCE_SEC) {
        currentCycle = mergeCycleWithLiveBucket(latestStored, liveBucket);
        priorCycles = storedCycles.slice(0, -1);
      } else if (latestStored.resetTimeSec > nowSec || !liveBucket) {
        currentCycle = latestStored;
        priorCycles = storedCycles.slice(0, -1);
      } else {
        currentCycle = mergeCycleWithLiveBucket(undefined, liveBucket);
        priorCycles = storedCycles.filter(c => c.resetTimeSec < currentCycle!.resetTimeSec - SAME_CYCLE_RESET_TOLERANCE_SEC);
      }
    } else if (liveBucket) {
      currentCycle = mergeCycleWithLiveBucket(undefined, liveBucket);
      priorCycles = [];
    }

    if (!currentCycle) continue;

    const poolTier = canonicalTierForMatching(currentCycle.tier ?? storedPool?.tier ?? resolvedTier);
    const currentAttr = computeCycleAttribution({
      cycle: currentCycle,
      priorCycles,
      currentTier: poolTier,
      poolEventsAll: poolEvents,
      nowSec,
    });

    const recentCyclesRaw = priorCycles.slice(-MAX_RECENT_CYCLES);
    const recentCycles: WeeklyCycleHistoryEntry[] = [];
    for (let idx = recentCyclesRaw.length - 1; idx >= 0; idx -= 1) {
      const histCycle = recentCyclesRaw[idx]!;
      const earlierForHist = priorCycles.filter(c => c.resetTimeSec < histCycle.resetTimeSec - SAME_CYCLE_RESET_TOLERANCE_SEC);
      const histTier = canonicalTierForMatching(histCycle.tier ?? storedPool?.tier ?? resolvedTier);
      const histAttr = computeCycleAttribution({
        cycle: histCycle,
        priorCycles: earlierForHist,
        currentTier: histTier,
        poolEventsAll: poolEvents,
        nowSec: histCycle.resetTimeSec,
      });
      recentCycles.push({
        cycleStartSec: histAttr.cycleStartSec,
        resetTimeSec: histAttr.resetTimeSec,
        totalUsedPct: histCycle.points.length > 0 ? histAttr.totalUsedPct : null,
        localEstimatedUsedPct: histAttr.localEstimatedUsedPct,
        otherEstimatedUsedPct: histAttr.otherEstimatedUsedPct,
        localTokens: histAttr.localTokens,
        localRequests: histAttr.localRequests,
        localUsd: histAttr.localUsd,
        sshTokens: histAttr.sshTokens,
        sshRequests: histAttr.sshRequests,
        confidence: histAttr.confidence,
        snapshotCount: histAttr.snapshotCount,
      });
    }

    const displayName =
      liveBucket?.displayName ||
      storedPool?.displayName ||
      defaultPoolDisplayName(poolKey);

    pools.push({
      poolKey,
      displayName,
      ...currentAttr,
      recentCycles,
    });
  }

  return {
    accountId: input.accountId ?? null,
    email: emailTrimmed,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(resolvedTier ? { tier: resolvedTier } : {}),
    generatedAtSec: nowSec,
    pools,
  };
}

export function computeWeeklyEventQueryRange(params: {
  accounts: ReadonlyArray<{ email: string; quota?: QuotaData | null }>;
  snapshotStore?: WeeklyQuotaSnapshotStore | null;
  nowSec?: number;
}): { startSec: number; endSec: number } | null {
  const nowSec =
    typeof params.nowSec === 'number' && Number.isFinite(params.nowSec) && params.nowSec > 0
      ? Math.floor(params.nowSec)
      : Math.floor(Date.now() / 1000);
  let minStart: number | null = null;
  let maxEnd = nowSec;

  for (const acc of params.accounts) {
    const emailLower = (acc.email || '').trim().toLowerCase();
    if (emailLower && params.snapshotStore) {
      const storedEarliest = params.snapshotStore.getEarliestCycleStartSec(emailLower, MAX_RECENT_CYCLES + 1);
      if (storedEarliest !== null && (minStart === null || storedEarliest < minStart)) {
        minStart = storedEarliest;
      }
    }
    if (acc.quota) {
      const buckets = extractWeeklyBucketsFromQuota(acc.quota, nowSec, {
        allowStale: true,
        requireFutureReset: false,
      });
      for (const b of buckets) {
        const cycleStart = b.resetTimeSec - WEEK_SEC;
        if (minStart === null || cycleStart < minStart) {
          minStart = cycleStart;
        }
        if (b.observedAtSec > maxEnd) {
          maxEnd = b.observedAtSec;
        }
      }
    }
  }

  if (minStart === null) return null;
  const lowerBound = Math.max(0, nowSec - MAX_QUERY_LOOKBACK_SEC);
  return {
    startSec: Math.max(lowerBound, minStart),
    endSec: maxEnd,
  };
}
