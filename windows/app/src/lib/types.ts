export type PageKey = 'overview' | 'accounts' | 'usage' | 'settings' | 'about';
export type UsagePeriodKey = 'today' | '7d' | '30d' | 'all';
export type ThemeMode = 'system' | 'light' | 'dark';
export type LanguageSetting = 'system' | 'zh-Hans' | 'en';
export type ProxyMode = 'off' | 'system' | 'manual';

export type EffectiveProxySource =
  | 'off'
  | 'manual'
  | 'system'
  | 'system_unconfigured'
  | 'system_pac_unsupported'
  | 'system_socks_unsupported'
  | 'invalid_manual'
  | string;

export interface ProxyInfo {
  mode: ProxyMode;
  manualUrl: string;
  effectiveUrl: string | null;
  source: EffectiveProxySource;
}

export interface SafeRelaunchResult {
  ok: boolean;
  debugPortReady: boolean;
  needsBackgroundExitConfirmation: boolean;
  reason: string;
  message: string;
}

export interface GracefulCloseOutcome {
  closed: boolean;
  reason: string;
}

export interface SwitchPreflightReply {
  ok?: boolean;
  appRunning?: boolean;
  uiRunning?: boolean;
  stableRunning?: boolean;
  insidersRunning?: boolean;
  detachedDaemonCount?: number;
  detachedDaemonKinds?: string[];
  detachedDaemonPids?: number[];
  hasRunningTask?: boolean;
  safe?: boolean;
  taskReason?: string;
}

export interface EnvironmentNode {
  environmentId?: string;
  id?: string;
  kind?: 'local' | 'ssh' | string;
  hostLabel?: string;
  host_label?: string;
  label?: string;
  lifecycleState?: 'online' | 'auth_expired' | 'offline_recent' | 'historical_only' | string;
  state?: string;
  online?: boolean;
  windowCount?: number;
  window_count?: number;
  accountEmail?: string;
  email?: string;
  accountName?: string;
  name?: string;
  tier?: string;
  subscription_tier?: string;
  activeTier?: string;
  matchedLocalAccountId?: string | null;
  primaryRemoteKey?: string;
  remoteKey?: string;
  lastError?: string;
  lastQuotaObservedAt?: number;
  quotaLastUpdated?: number;
  observedAt?: number;
  lastFocusedAt?: number;
  lastUsageSyncedAt?: number;
  focused?: boolean;
  probing?: boolean;
  quotaFreshness?: string;
  sharePct?: number;
  usageSharePct?: number;
  quota?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface UiConfig {
  schema: number;
  lastPage: number;
  quotaRefreshMinutes: number;
  hudEnabled: boolean;
  autoPricingSyncEnabled: boolean;
  launchAntigravityOnStart: boolean;
  syncAntigravityLifecycle: boolean;
  autoUpdateEnabled: boolean;
  accountsCollapsed: boolean;
  menuSelectedTab: number;
  menuUsagePeriod: number;
  menuUsageEnvironmentId: string;
  menuTrendMetric: 'tokens' | 'requests';
  applicationChannel: string;
  appLanguage: string | null;
  themeMode: ThemeMode;
  antigravityProxyMode: ProxyMode;
  antigravityProxyManualUrl: string;
}

export interface AntigravityInfo {
  installDir: string;
  exePath: string;
  installed: boolean;
  version: string;
  running: boolean;
  debugPortReady: boolean;
}

export interface AppInfo {
  version: string;
  stateDir: string;
  pipeName: string;
  osLabel: string;
  antigravity: AntigravityInfo;
}

export interface LiveStatus {
  mode: string;
  message?: string;
  detail?: string;
  appVersion?: string;
  locale?: string;
  configuredLanguage?: string;
  translationEnabled?: boolean;
  hudEnabled?: boolean;
  oauthClientConfigured?: boolean;
  applicationChannel?: string;
  applicationLabel?: string;
  activeAccountEmail?: string;
  activeFiveHourQuota?: number | null;
  activeSubscriptionTier?: string;
  liveAccountEmail?: string | null;
  accountsRevision?: string;
  pricingRevision?: string | number;
  runningTasks?: number;
  dictionaryError?: string;
  partial?: boolean;
  remoteSessions?: EnvironmentNode[];
  environments?: EnvironmentNode[];
  environmentsRevision?: string | number;
  remoteSyncRevision?: string | number;
  focusedEnvironmentId?: string;
  focusedContextKey?: string;
  sshWindowsCount?: number;
  activeSshHosts?: string[];
  remoteObservedVersion?: number;
}

export interface TaskRow {
  id: string;
  kind: string;
  title: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled' | string;
  done?: number;
  total?: number;
  message?: string;
  error?: string;
}

export interface HourlyPointRaw {
  hour?: number | string;
  label?: string;
  total_tokens?: number;
  totalTokens?: number;
  request_count?: number;
  requestCount?: number;
  estimated_usd?: number;
  estimatedUsd?: number;
}

export interface DailyTrendRaw {
  date: string;
  total_tokens?: number;
  totalTokens?: number;
  request_count?: number;
  requestCount?: number;
  estimated_usd?: number;
  estimatedUsd?: number;
}

export interface ModelUsageRaw {
  model: string;
  modelId?: string;
  model_id?: string;
  promptTokens?: number;
  input_tokens?: number;
  candidatesTokens?: number;
  output_tokens?: number;
  cachedTokens?: number;
  cached_tokens?: number;
  cacheWriteTokens?: number;
  cache_write_tokens?: number;
  totalTokens?: number;
  total_tokens?: number;
  requestCount?: number;
  request_count?: number;
  estimatedUsd?: number;
  estimated_usd?: number;
  priced?: boolean;
  partiallyPriced?: boolean;
  unpricedTokens?: number;
  unpriced_tokens?: number;
  pricingKey?: string;
  pricingStatus?: string;
  pricingProvenance?: Record<string, unknown> | null;
}

export interface UsagePeriodSummaryData {
  totalTokens?: number;
  promptTokens?: number;
  candidatesTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  requestCount?: number;
  estimatedUsd?: number;
  cacheHitRate?: number;
  databasesScanned?: number;
  databasesDiscovered?: number;
  scanScopeDescription?: string;
  pricedModels?: number;
  unpricedModels?: number;
  failedDatabasesCount?: number;
  skippedLargeRecords?: number;
  lastScannedAt?: number;
  hasError?: boolean;
  availability?: string;
  unknownTimeRecords?: number;
  unknownTimeTokens?: number;
  pricing_warnings?: string[];
  pricing_warning_codes?: string[];
}

export interface AvailableAccountUsageOption {
  id: string;
  label: string;
  email?: string;
  name?: string | null;
  type?: 'all' | 'account' | string;
  total_tokens?: number;
  request_count?: number;
}

export interface UsageSummaryReply {
  ok?: boolean;
  period: UsagePeriodKey;
  snapshotId?: string;
  selectedEnvironmentId?: string;
  selected_environment_id?: string;
  selectedAccountId?: string;
  selected_account_id?: string;
  availableAccounts?: AvailableAccountUsageOption[];
  available_accounts?: AvailableAccountUsageOption[];
  availableEnvironments?: EnvironmentNode[];
  available_environments?: EnvironmentNode[];
  environments?: EnvironmentNode[];
  unattributedRequests?: number;
  unattributed_requests?: number;
  unattributedTokens?: number;
  unattributed_tokens?: number;
  environmentBreakdown?: {
    localSharePct?: number;
    sshSharePct?: number;
    localTokens?: number;
    sshTokens?: number;
    byEnvironment?: Array<{
      environmentId?: string;
      environment_id?: string;
      sharePct?: number;
      totalTokens?: number;
      total_tokens?: number;
    }>;
    [key: string]: unknown;
  };
  summary: UsagePeriodSummaryData & {
    selectedAccountId?: string;
    selected_account_id?: string;
    availableAccounts?: AvailableAccountUsageOption[];
    available_accounts?: AvailableAccountUsageOption[];
    selectedEnvironmentId?: string;
    selected_environment_id?: string;
    availableEnvironments?: EnvironmentNode[];
    available_environments?: EnvironmentNode[];
    environmentBreakdown?: Record<string, unknown>;
  };
  byModel?: ModelUsageRaw[];
  models?: ModelUsageRaw[];
  dailyTrends?: DailyTrendRaw[];
  todayHourly?: HourlyPointRaw[];
  periods?: Record<UsagePeriodKey, UsageSummaryReply>;
}

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

export interface WeeklyQuotaUsageReply {
  ok?: boolean;
  generatedAtSec?: number;
  accounts: AccountWeeklyAttribution[];
}

export interface AccountRecord {
  id: string;
  email: string;
  name?: string;
  subscription_tier?: string;
  disabled?: boolean;
  validation_blocked?: boolean;
  revision?: string;
  quota_last_updated?: number;
  quotaLastUpdated?: number;
  quota_refresh_error?: string;
  credentialReadiness?: {
    state?: string;
    message?: string;
  };
  standbyRefreshStatus?: {
    mode?: string;
    message?: string;
  };
  quota?: Record<string, unknown> | null;
  quotaGroups?: Array<Record<string, unknown>>;
  familyWindows?: Record<string, unknown>;
  familyModelQuota?: Record<string, unknown>;
  argonStatus?: Record<string, unknown> | null;
  carbonStatus?: Record<string, unknown> | null;
  standaloneModels?: Array<Record<string, unknown>>;
  refreshState?: Record<string, unknown>;
  quotaWarnings?: string[];
  quotaWarningCodes?: string[];
  staleGroups?: Array<Record<string, unknown>>;
  stale_groups?: Array<Record<string, unknown>>;
  weeklyAttribution?: AccountWeeklyAttribution | null;
  [key: string]: unknown;
}

export interface AccountsListReply {
  ok?: boolean;
  activeId?: string | null;
  currentAccountId?: string | null;
  identityState?: string;
  accounts: AccountRecord[];
  pendingSwitch?: boolean | { isPending?: boolean };
  recovery?: Record<string, unknown>;
}

export interface AutoSwitchConfig {
  enabled: boolean;
  strategy: 'priority' | 'round_robin' | string;
  monitored_model: string;
  reserve_percentage: number;
  candidate_min_percentage: number;
}

export interface AutoSwitchPreview {
  ok?: boolean;
  currentAccount?: AccountRecord | null;
  bestCandidate?: AccountRecord | null;
  account?: AccountRecord | null;
  shouldSwitch: boolean;
  reason?: string;
}

export interface DashboardSummaryReply {
  ok?: boolean;
  accounts?: (AccountRecord & {
    total?: number;
    currentAccountId?: string | null;
    activeEmail?: string;
    configuredEmail?: string;
    isLiveVerified?: boolean;
    activeName?: string;
    activeTier?: string;
    liveAccountEmail?: string | null;
    quotaRefreshError?: string;
    readyCount?: number;
    autoSwitchEnabled?: boolean;
    weeklyAttribution?: AccountWeeklyAttribution | null;
  }) | null;
  usage?: {
    todayTokens?: number;
    totalTokens?: number;
    estimatedUsd?: number;
    allTimeEstimatedUsd?: number;
    requestCount?: number;
    totalRequestCount?: number;
    pricingModels?: number;
    todayPricedModels?: number;
    todayUnpricedModels?: number;
    unpricedModels?: number;
    pricedModels?: number;
    databasesScanned?: number;
    databasesDiscovered?: number;
    failedDatabasesCount?: number;
    skippedLargeRecords?: number;
    availability?: string;
    unknownTimeRecords?: number;
    todayHourly?: HourlyPointRaw[];
    todayByModel?: ModelUsageRaw[];
    periods?: Record<UsagePeriodKey, UsageSummaryReply>;
    environments?: EnvironmentNode[];
    availableEnvironments?: EnvironmentNode[];
    environmentsRevision?: string | number;
    remoteSyncRevision?: string | number;
    focusedEnvironmentId?: string;
  } | null;
  remoteSessions?: EnvironmentNode[];
  environments?: EnvironmentNode[];
  environmentsRevision?: string | number;
  remoteSyncRevision?: string | number;
  focusedEnvironmentId?: string;
  focusedContextKey?: string;
  remoteObservedVersion?: number;
  sshWindowsCount?: number;
  activeSshHosts?: string[];
  accountsError?: string;
  usageError?: string;
  revision?: string;
  generatedAt?: string;
}

export interface UsageEventRow {
  id?: string;
  timestamp?: number | string;
  timestamp_seconds?: number;
  model?: string;
  modelId?: string;
  input_tokens?: number;
  inputTokens?: number;
  output_tokens?: number;
  outputTokens?: number;
  cached_tokens?: number;
  cachedTokens?: number;
  cache_write_tokens?: number;
  cacheWriteTokens?: number;
  total_tokens?: number;
  totalTokens?: number;
  estimated_usd?: number;
  estimatedUsd?: number;
  priced?: boolean;
  source?: string;
  environment_id?: string;
  environmentId?: string;
  environment_kind?: string;
  environmentKind?: string;
  environment_label?: string;
  environmentLabel?: string;
  host_label?: string;
  hostLabel?: string;
  account_id?: string;
  accountId?: string;
  account_email?: string;
  accountEmail?: string;
}

export interface UsageEventsReply {
  ok?: boolean;
  snapshot_id?: string;
  generated_at?: number;
  period?: string;
  scope?: string;
  total: number;
  rows: UsageEventRow[];
  availability?: string;
}

export interface MaintenanceEntry {
  id?: string;
  name?: string;
  title?: string;
  subtitle?: string;
  category?: 'safe' | 'stateful' | string;
  bytes: number;
  fileCount?: number;
  clearable?: boolean;
  path?: string;
  description?: string;
  reason?: string;
}

export interface MaintenanceSnapshot {
  id: string;
  timestamp: number;
  totalBytes: number;
  fileCount?: number;
  restorable?: boolean;
  restoredAt?: number;
  snapshotPath?: string;
  items?: Array<{ name: string; bytes: number; fileCount?: number }>;
}

export interface MaintenanceScanReply {
  ok?: boolean;
  token?: string;
  running?: boolean;
  browserBusy?: boolean;
  retentionDays?: number;
  scannedAt?: number;
  trashDir?: string;
  usingFallbackTrash?: boolean;
  safeBytes?: number;
  statefulBytes?: number;
  protectedBytes?: number;
  buckets?: {
    runtimeCache?: { clearableBytes?: number; fileCount?: number };
    historyLogs?: { clearableBytes?: number; fileCount?: number; subagentCount?: number };
  };
  entries?: MaintenanceEntry[];
  protectedEntries?: MaintenanceEntry[];
  snapshots?: MaintenanceSnapshot[];
  latestRestorableSnapshot?: MaintenanceSnapshot | null;
}

export interface PricingPayload {
  ok?: boolean;
  synced?: boolean;
  error?: string;
  healedCount?: number;
  healedRecords?: number;
  prices?: Record<string, {
    input?: number;
    output?: number;
    cached?: number;
    cacheWrite?: number;
    state?: string;
    displayName?: string;
    provenance?: {
      verification?: string;
      checkedAt?: string;
      validUntil?: string;
      sourceUrl?: string;
      state?: string;
    };
  }>;
  retiredPrices?: Record<string, {
    input?: number;
    output?: number;
    cached?: number;
    cacheWrite?: number;
    state?: string;
    displayName?: string;
    provenance?: {
      verification?: string;
      checkedAt?: string;
      validUntil?: string;
      sourceUrl?: string;
      state?: string;
    };
  }>;
  pricingStatus?: Record<string, string>;
  modelCatalogState?: Record<string, {
    displayName?: string;
    availability?: string;
    tiers?: string[];
    hostOrder?: number;
    state?: string;
  }>;
  catalogState?: Record<string, {
    displayName?: string;
    availability?: string;
    tiers?: string[];
    hostOrder?: number;
    state?: string;
  }>;
  unpricedLiveModels?: Array<{
    key: string;
    displayName?: string;
    disabled?: boolean;
    variants?: string[];
    hostOrder?: number;
  }>;
  status?: {
    version?: string;
    feedVersion?: string;
    modelCount?: number;
    lastSyncedAt?: number;
    lastSyncAt?: number;
    lastCheckedAt?: number;
    lastCheckAt?: number;
    source?: string;
    sourceUrl?: string;
    enabled?: boolean;
    autoSyncEnabled?: boolean;
  };
}
