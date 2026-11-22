import { lstat, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { probeBundleCapabilities } from './application-target.js';
import { isMacAppBundlePath } from './platform.js';
import { readOptionalJson } from './files.js';
import type { AccountsManager, LiveLanguageServerStatus } from './accounts.js';
import type { UsageStatsManager } from './usage.js';
import {
  registerObservedIdeModels,
  type ObservedIdeModelEntry,
} from './model-catalog.js';
import {
  normalizeCatalogTierLabel,
  resolvePricingCatalogSnapshot,
  type PricingCatalogModelInput,
  type PricingCatalogSnapshotResult,
  type PricingCatalogSourceInput,
} from './pricing.js';

const execFileAsync = promisify(execFile);
const MAX_LIVE_IDE_SNAPSHOT_MODELS = 256;

export interface LiveIdeModelSnapshotEntry {
  id: string;
  displayName: string | null;
  modelOrAlias: string | null;
  disabled: boolean;
  maxTokens?: number | null;
  maxOutputTokens?: number | null;
  modelProvider?: string | null;
  isInternal?: boolean;
  deprecated?: boolean;
  nonChatSpecialized?: boolean;
  inModelSelector?: boolean | null;
}

export interface LiveIdeModelsSnapshot {
  schema: 1 | 2;
  appVersion: string;
  tier: string;
  observedAt: number;
  models: LiveIdeModelSnapshotEntry[];
}

function sanitizeOptionalTokenInt(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const rounded = Math.trunc(raw);
  if (!Number.isSafeInteger(rounded) || rounded <= 0 || rounded > 10_000_000) return undefined;
  return rounded;
}

function sanitizeOptionalString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : undefined;
}

export function toObservedIdeModelEntries(
  models: readonly (PricingCatalogModelInput | LiveIdeModelSnapshotEntry)[] | null | undefined
): ObservedIdeModelEntry[] {
  if (!Array.isArray(models) || models.length === 0) return [];
  const entries: ObservedIdeModelEntry[] = [];
  for (const raw of models.slice(0, MAX_LIVE_IDE_SNAPSHOT_MODELS)) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as unknown as Record<string, unknown>;
    if (m.stale === true || m.quota_source === 'carried') continue;
    const modelId = String(m.model_id ?? m.id ?? m.name ?? '').trim();
    const modelOrAlias = sanitizeOptionalString(m.model_or_alias ?? m.modelOrAlias) ?? null;
    if (!modelId && !modelOrAlias) continue;
    const displayName = sanitizeOptionalString(m.display_name ?? m.displayName) ?? null;
    const maxTokens = sanitizeOptionalTokenInt(m.max_tokens ?? m.maxTokens) ?? null;
    const maxOutputTokens = sanitizeOptionalTokenInt(m.max_output_tokens ?? m.maxOutputTokens) ?? null;
    const modelProvider = sanitizeOptionalString(m.model_provider ?? m.modelProvider) ?? null;
    const rawIsInternal = m.is_internal ?? m.isInternal;
    const rawDeprecated = m.deprecated;
    const rawNonChat = m.non_chat_specialized ?? m.nonChatSpecialized;
    const rawInSelector = m.in_model_selector ?? m.inModelSelector;
    entries.push({
      modelId: modelId || modelOrAlias!,
      displayName,
      modelOrAlias,
      maxTokens,
      maxOutputTokens,
      modelProvider,
      ...(typeof rawIsInternal === 'boolean' ? { isInternal: rawIsInternal } : {}),
      ...(typeof rawDeprecated === 'boolean' ? { deprecated: rawDeprecated } : {}),
      ...(typeof rawNonChat === 'boolean' ? { nonChatSpecialized: rawNonChat } : {}),
      ...(typeof rawInSelector === 'boolean' || rawInSelector === null ? { inModelSelector: rawInSelector } : {}),
    });
  }
  return entries;
}

export function registerObservedModelsFromSource(
  models: readonly (PricingCatalogModelInput | LiveIdeModelSnapshotEntry)[] | null | undefined
): number {
  const entries = toObservedIdeModelEntries(models);
  if (entries.length > 0) {
    registerObservedIdeModels(entries);
  }
  return entries.length;
}

export async function readInstalledAppBundleVersion(appPath: string): Promise<string> {
  if (!appPath) return '';
  if (!isMacAppBundlePath(appPath)) {
    const caps = probeBundleCapabilities(appPath);
    if (caps.version) return caps.version;
    try {
      const raw = (await readFile(join(appPath, 'version'), 'utf8')).trim();
      if (raw) return raw;
    } catch {}
    return '';
  }
  const plistPath = join(appPath, 'Contents/Info.plist');
  try {
    const raw = await readFile(plistPath, 'utf8');
    const match = raw.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    if (match?.[1]?.trim()) return match[1].trim();
  } catch {
    return '';
  }
  try {
    const { stdout } = await execFileAsync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', plistPath],
      { timeout: 2000 }
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

export function sanitizeLiveIdeModelsSnapshot(
  live: LiveLanguageServerStatus | null | undefined,
  appVersion: string
): LiveIdeModelsSnapshot | null {
  const rawModels = live?.quota?.models;
  if (!Array.isArray(rawModels) || rawModels.length === 0) return null;
  const models: LiveIdeModelSnapshotEntry[] = [];
  for (const raw of rawModels.slice(0, MAX_LIVE_IDE_SNAPSHOT_MODELS)) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as unknown as Record<string, unknown>;
    if (m.stale === true || m.quota_source === 'carried') continue;
    const id = String(m.model_id ?? m.name ?? '').trim();
    if (!id) continue;
    const displayName = typeof m.display_name === 'string' && m.display_name.trim()
      ? m.display_name.trim()
      : null;
    const modelOrAlias = typeof m.model_or_alias === 'string' && m.model_or_alias.trim()
      ? m.model_or_alias.trim()
      : null;
    const disabled = m.disabled === true || /(?:^|[-_])disabled$/i.test(id);
    const maxTokens = sanitizeOptionalTokenInt(m.max_tokens ?? m.maxTokens);
    const maxOutputTokens = sanitizeOptionalTokenInt(m.max_output_tokens ?? m.maxOutputTokens);
    const modelProvider = sanitizeOptionalString(m.model_provider ?? m.modelProvider);
    const isInternal = m.is_internal === true || m.isInternal === true;
    const deprecated = m.deprecated === true;
    const nonChatSpecialized = m.non_chat_specialized === true || m.nonChatSpecialized === true;
    const rawInSelector = m.in_model_selector ?? m.inModelSelector;
    const inModelSelector = typeof rawInSelector === 'boolean' ? rawInSelector : undefined;
    models.push({
      id,
      displayName,
      modelOrAlias,
      disabled,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(modelProvider !== undefined ? { modelProvider } : {}),
      ...(isInternal ? { isInternal: true } : {}),
      ...(deprecated ? { deprecated: true } : {}),
      ...(nonChatSpecialized ? { nonChatSpecialized: true } : {}),
      ...(inModelSelector !== undefined ? { inModelSelector } : {}),
    });
  }
  if (models.length === 0) return null;
  const tier = normalizeCatalogTierLabel(live?.tier || live?.quota?.subscription_tier || '');
  const rawObserved = live?.quota?.last_updated;
  const observedAt = typeof rawObserved === 'number' && Number.isFinite(rawObserved) && rawObserved > 0
    ? rawObserved
    : Math.floor(Date.now() / 1000);
  return {
    schema: 2,
    appVersion: String(appVersion || '').trim(),
    tier,
    observedAt,
    models,
  };
}

export async function readValidLiveIdeModelsSnapshot(
  snapshotPath: string,
  installedAppVersion: string
): Promise<LiveIdeModelsSnapshot | null> {
  const cleanInstalled = String(installedAppVersion || '').trim();
  if (!cleanInstalled) return null;
  const info = await lstat(snapshotPath).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) {
    return null;
  }
  const data = await readOptionalJson<LiveIdeModelsSnapshot>(snapshotPath, 'live-ide-models.json');
  if (!data || typeof data !== 'object' || (data.schema !== 1 && data.schema !== 2)) return null;
  const snapVer = typeof data.appVersion === 'string' ? data.appVersion.trim() : '';
  if (!snapVer || snapVer !== cleanInstalled) return null;
  if (!Array.isArray(data.models) || data.models.length === 0) return null;
  const models: LiveIdeModelSnapshotEntry[] = [];
  for (const raw of data.models.slice(0, MAX_LIVE_IDE_SNAPSHOT_MODELS)) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as unknown as Record<string, unknown>;
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (!id) continue;
    const maxTokens = sanitizeOptionalTokenInt(m.maxTokens ?? m.max_tokens);
    const maxOutputTokens = sanitizeOptionalTokenInt(m.maxOutputTokens ?? m.max_output_tokens);
    const modelProvider = sanitizeOptionalString(m.modelProvider ?? m.model_provider);
    const isInternal = m.isInternal === true || m.is_internal === true;
    const deprecated = m.deprecated === true;
    const nonChatSpecialized = m.nonChatSpecialized === true || m.non_chat_specialized === true;
    const rawInSelector = m.inModelSelector ?? m.in_model_selector;
    const inModelSelector = typeof rawInSelector === 'boolean' ? rawInSelector : undefined;
    models.push({
      id,
      displayName: typeof m.displayName === 'string' && m.displayName.trim() ? m.displayName.trim() : null,
      modelOrAlias: typeof m.modelOrAlias === 'string' && m.modelOrAlias.trim() ? m.modelOrAlias.trim() : null,
      disabled: m.disabled === true || /(?:^|[-_])disabled$/i.test(id),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(modelProvider !== undefined ? { modelProvider } : {}),
      ...(isInternal ? { isInternal: true } : {}),
      ...(deprecated ? { deprecated: true } : {}),
      ...(nonChatSpecialized ? { nonChatSpecialized: true } : {}),
      ...(inModelSelector !== undefined ? { inModelSelector } : {}),
    });
  }
  if (models.length === 0) return null;
  return {
    schema: data.schema === 1 ? 1 : 2,
    appVersion: snapVer,
    tier: normalizeCatalogTierLabel(data.tier),
    observedAt: typeof data.observedAt === 'number' && Number.isFinite(data.observedAt) ? data.observedAt : 0,
    models,
  };
}

export async function buildPricingCatalogPayloadSnapshot(params: {
  appPath: string;
  liveIdeModelsPath: string;
  probeLiveCached: () => Promise<LiveLanguageServerStatus | null>;
  usageManager: UsageStatsManager;
  accountsManager: AccountsManager;
}): Promise<PricingCatalogSnapshotResult> {
  const { appPath, liveIdeModelsPath, probeLiveCached, usageManager, accountsManager } = params;
  const [live, installedAppVersion, catalogRaw] = await Promise.all([
    probeLiveCached().catch(() => null),
    readInstalledAppBundleVersion(appPath),
    usageManager.getRawPricingCatalog(),
  ]);
  const liveModels = Array.isArray(live?.quota?.models) ? live.quota.models : [];
  const snapshot = liveModels.length === 0
    ? await readValidLiveIdeModelsSnapshot(liveIdeModelsPath, installedAppVersion)
    : null;
  const listRes = await accountsManager.listAccounts({ liveEmailHint: live?.email ?? null }).catch(() => null);
  const activeId = listRes?.active_account_id ?? null;
  const activeEmail = (live?.email || listRes?.active_account?.email || '').toLowerCase();
  const matchedSaved = listRes?.active_account
    ?? (activeEmail ? listRes?.accounts.find((a) => a.email.toLowerCase() === activeEmail) : undefined);

  const liveTierRaw = live?.tier || live?.quota?.subscription_tier || matchedSaved?.quota?.subscription_tier || '';
  const liveInput: PricingCatalogSourceInput | null = liveModels.length > 0
    ? { tier: liveTierRaw, source: 'live', models: liveModels as PricingCatalogModelInput[] }
    : null;
  const snapshotInput: PricingCatalogSourceInput | null = snapshot
    ? { tier: snapshot.tier, source: 'snapshot', models: snapshot.models }
    : null;

  const savedActiveAcc = listRes?.active_account;
  const activeAccountInput: PricingCatalogSourceInput | null =
    savedActiveAcc?.quota && Array.isArray(savedActiveAcc.quota.models) && savedActiveAcc.quota.models.length > 0
      ? {
          tier: savedActiveAcc.quota.subscription_tier ?? '',
          source: savedActiveAcc.quota.source ?? 'cloud',
          models: savedActiveAcc.quota.models as PricingCatalogModelInput[],
        }
      : null;

  const poolAccountsInput: PricingCatalogSourceInput[] = [];
  for (const acc of listRes?.accounts ?? []) {
    if (acc.disabled) continue;
    if (activeId && acc.id === activeId) continue;
    if (activeEmail && acc.email.toLowerCase() === activeEmail) continue;
    if (!acc.quota || acc.quota.is_forbidden) continue;
    if (!Array.isArray(acc.quota.models) || acc.quota.models.length === 0) continue;
    poolAccountsInput.push({
      tier: acc.quota.subscription_tier ?? '',
      source: acc.quota.source ?? 'cloud',
      models: acc.quota.models as PricingCatalogModelInput[],
    });
  }

  // Register observed IDE/Cloud models (pool -> activeAccount -> snapshot -> live so freshest wins)
  for (const pool of poolAccountsInput) {
    registerObservedModelsFromSource(pool.models);
  }
  if (activeAccountInput?.models) {
    registerObservedModelsFromSource(activeAccountInput.models);
  }
  if (snapshot?.models) {
    registerObservedModelsFromSource(snapshot.models);
  }
  if (liveModels.length > 0) {
    registerObservedModelsFromSource(liveModels as PricingCatalogModelInput[]);
  }

  const payload = resolvePricingCatalogSnapshot({
    rawPricingTable: catalogRaw.raw,
    publicPricingKeys: catalogRaw.publicKeys,
    live: liveInput,
    snapshot: snapshotInput,
    activeAccount: activeAccountInput,
    poolAccounts: poolAccountsInput,
  });

  usageManager.setActiveOfficialModels(
    Object.keys(payload.prices),
    payload.unpricedLiveModels.map((m) => m.key)
  );
  return payload;
}
