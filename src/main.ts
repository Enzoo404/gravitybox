import { ALLOWED_DATA_DIRECTORY_NAMES, applicationChannel, savedApplicationChannel, applicationTarget, detectInstalledChannels, type ApplicationChannel, type ApplicationTarget } from './application-target.js';
import { sampleAntigravityProcesses, type DetachedDaemonKind } from './antigravity-processes.js';
import { GoogleAccountLogin } from './account-oauth.js';
import { AccountSwitchService } from './account-switch.js';
import { AccountsManager, accountCredentialReadiness, accountErrorCode, cleanAndLocalizeRefreshError, computeStandbyRefreshStatus, getGoogleClientId, getGoogleClientSecret, hasExpiredQuotaWindow, type Account, type QuotaData } from './accounts.js';
import { UsageStatsManager } from './usage.js';
import {
  WeeklyQuotaSnapshotStore,
  computeAccountWeeklyAttribution,
  computeWeeklyEventQueryRange,
  type AccountWeeklyAttribution,
} from './weekly-quota-attribution.js';
import {
  buildPricingCatalogPayloadSnapshot,
  readInstalledAppBundleVersion,
  readValidLiveIdeModelsSnapshot,
  registerObservedModelsFromSource,
  sanitizeLiveIdeModelsSnapshot,
  type LiveIdeModelSnapshotEntry,
  type LiveIdeModelsSnapshot,
} from './pricing-catalog-runtime.js';
export {
  readInstalledAppBundleVersion,
  readValidLiveIdeModelsSnapshot,
  sanitizeLiveIdeModelsSnapshot,
  type LiveIdeModelSnapshotEntry,
  type LiveIdeModelsSnapshot,
};
import {
  EnvironmentRegistry,
  fuseAccountQuotaAcrossEnvironments,
  mergeLiveQuotaWithSaved,
  normalizeSubscriptionTier,
  projectAccountForIpcNormalized as projectAccountNormalizedWithManager,
  projectAllUsagePeriodSummaries,
  projectQuotaContract,
  projectSingleUsagePeriod,
  projectUsagePeriodSummary,
  type EnvironmentRegistryLocalAccountInput,
  type RemoteQuotaCandidate,
} from './ipc-projections.js';
export { mergeLiveQuotaWithSaved, normalizeSubscriptionTier, projectQuotaContract };
import { CacheMaintenance } from './maintenance.js';
import { mkdir, lstat, chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { realpathSync, readFileSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DictionaryStore, loadDictionary, dictionaryFromEntries, validateEntries, validateTemplateRules, resolveDictionaryForLocale } from './dictionary.js';
import { bt, getActiveLocale, setActiveLocale, resolveInitialRuntimeLanguage, resolveLocale } from './i18n.js';
import { Controller, type AssistantStatus, type RemoteSessionState } from './controller.js';
import {
  RemoteUsageSyncCoordinator,
  buildRemoteEnvironmentId,
  type RemoteGenerationEvent,
  type RemoteUsageSyncReceipt,
} from './remote-usage-sync.js';
import { cleanHostLabel } from './ssh-context.js';
import type { LedgerEvent } from './usage-ledger.js';
import type { AvailableEnvironmentUsageOption, EnvironmentLifecycleState, KnownEnvironmentContext, SyncReceipt, TokenUsageSummary } from './usage-types.js';
import { coverageMetricSnapshot } from './coverage.js';
import { atomicJson, readOptionalJson, sanitizeError } from './files.js';
import { discover } from './discovery.js';
import { Tasks } from './tasks.js';
import { acquireProcessLease, type ProcessLease } from './process-lock.js';
import { createHash } from 'node:crypto';
import { IdempotencyStore, canonicalPayload } from './ipc-idempotency.js';
export { canonicalPayload } from './ipc-idempotency.js';
import { loadProxyConfigFromStateDir, redactProxyUrl, resolveEffectiveProxy, setRuntimeProxyConfig } from './proxy.js';
import {
  appProcesses,
  classifyWindowsProcesses,
  cleanupIpcEndpoint,
  cleanupIpcSession,
  defaultAntigravityInstallDirs,
  defaultAppSupportDir,
  defaultGravityBoxStateDir,
  finalizeIpcEndpointAfterListen,
  isOwnedByCurrentUser,
  isWindows,
  pathsEqual,
  prepareIpcEndpointForListen,
  prepareWindowsIpcForListen,
  resolveClientIpcTarget,
  resolveIpcEndpoint,
  validateIpcEndpointForClient,
  verifyIpcAuthToken,
  writeIpcSession,
  type WindowsIpcSession,
} from './platform/index.js';

function cliOption(argv: string[], name: string, fallback?: string) {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
}

function sanitizeErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return bt('common.action_incomplete');
  const msg = err.message || '';
  const redacted = sanitizeError(msg);
  const sanitized = redacted
    .replace(/\/(?:Users|private|var|tmp|Volumes)\/[^\s'"]+/g, bt('common.path_token'))
    .replace(/[A-Za-z]:\\(?:Users|ProgramData|Windows\\Temp)\\[^\s'"]+/gi, bt('common.path_token'));
  return sanitized.slice(0, 200);
}

function formatResetTime(resetTime: number | null | undefined): string {
  if (!resetTime) return '';
  const tsMs = typeof resetTime === 'number' && resetTime < 1e11 ? resetTime * 1000 : Number(resetTime);
  const date = new Date(tsMs);
  return !isNaN(date.getTime()) ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : String(resetTime);
}

export function resolveUnsavedLiveSubscriptionTier(
  liveLs: { tier?: string | null; accountType?: 'consumer' | 'enterprise_vertex' | 'unknown' | null } | null | undefined,
  quotaOverview: { subscriptionTier?: string | null; models?: unknown[] | null } | null | undefined
): string {
  if (liveLs?.tier && !/starter|free/i.test(liveLs.tier)) {
    return normalizeSubscriptionTier(liveLs.tier);
  }
  if (quotaOverview?.subscriptionTier && quotaOverview.subscriptionTier !== 'FREE') {
    return normalizeSubscriptionTier(quotaOverview.subscriptionTier);
  }
  if (
    liveLs?.accountType !== 'enterprise_vertex' &&
    quotaOverview?.subscriptionTier === 'FREE' &&
    (quotaOverview.models?.length ?? 0) > 0
  ) {
    return 'FREE';
  }
  return normalizeSubscriptionTier(bt('quota.tier.pending'));
}

export type DashboardAggregateDeps = {
  listAccounts: () => Promise<any>;
  getAutoSwitchConfig: () => Promise<any>;
  probeLiveLanguageServer: () => Promise<any>;
  getAccount: (id: string) => Promise<any>;
  getAccountQuotaOverview: (account: any, options?: any) => any;
  getUsageSummary: () => Promise<any>;
  getPricingTable: () => Promise<any>;
  getRemoteSessions?: () => RemoteQuotaCandidate[];
};
export type DashboardAggregate = { accounts: any; usage: any; accountsError: string; usageError: string };

/**
 * 若本机非活跃账号正在任意在线 SSH 会话中登录，优先强制通过该 SSH 只读通道实时探测并回写配额展示快照；
 * 成功时返回完整 IPC 响应对象，失败或无匹配在线会话时返回 null 以回退本地刷新路径。
 */
export async function refreshStandbyAccountViaRemoteSsh(deps: {
  targetAcc: Account | null;
  targetIsLocalActive: boolean;
  hasLocalOAuthClient: boolean;
  nowMs?: number;
  getRemoteSessionsSnapshot: (nowMs?: number) => RemoteSessionState[];
  probeRemoteByEnvironmentId: (environmentId: string) => Promise<unknown>;
  syncRemoteObservedQuota: (accountId: string, quota: QuotaData, tier?: string | null) => Promise<Account | null>;
  getAccount: (accountId: string) => Promise<Account | null>;
  toRemoteCandidates: (sessions: RemoteSessionState[]) => RemoteQuotaCandidate[];
  getAccountQuotaOverview: (account: Account, options: { nowMs: number }) => any;
  projectAccount: (account: Account, opts: any) => any;
  buildEnvironmentSnapshot: (opts: { nowMs: number }) => {
    remoteSessions: Record<string, unknown>[];
    environments: unknown[];
    environmentsRevision: number;
    remoteSyncRevision: number;
    focusedEnvironmentId: string;
  };
  publishSnapshot: () => void;
  readOkMessage?: string;
}): Promise<Record<string, unknown> | null> {
  const { targetAcc, targetIsLocalActive, hasLocalOAuthClient } = deps;
  if (!targetAcc || targetIsLocalActive) return null;
  const nowMs = deps.nowMs ?? Date.now();
  const targetEmailLower = targetAcc.email.trim().toLowerCase();
  const currentRemotes = deps.getRemoteSessionsSnapshot(nowMs);
  const matchingRemote = currentRemotes.find(s =>
    s.state !== 'disconnected'
    && (
      s.matchedLocalAccountId === targetAcc.id
      || (Boolean(s.email) && s.email.trim().toLowerCase() === targetEmailLower)
    )
  );
  if (!matchingRemote) return null;

  await deps.probeRemoteByEnvironmentId(matchingRemote.environmentId).catch(() => null);
  const afterNowMs = Date.now();
  const afterRemotes = deps.getRemoteSessionsSnapshot(afterNowMs);
  const freshRemote = afterRemotes.find(s =>
    s.environmentId === matchingRemote.environmentId
    && s.state === 'connected'
    && Boolean(s.quota?.models?.length)
    && (!s.email || s.email.trim().toLowerCase() === targetEmailLower)
  );
  if (!freshRemote?.quota) {
    deps.publishSnapshot();
    return null;
  }

  const syncedAcc = (await deps.syncRemoteObservedQuota(targetAcc.id, freshRemote.quota, freshRemote.tier).catch(() => null))
    ?? (await deps.getAccount(targetAcc.id).catch(() => null))
    ?? targetAcc;
  const fused = fuseAccountQuotaAcrossEnvironments({
    email: syncedAcc.email,
    savedQuota: syncedAcc.quota,
    liveLocalQuota: null,
    remoteSessions: deps.toRemoteCandidates(afterRemotes),
    nowMs: afterNowMs,
  });
  const fusedAcc: Account = { ...syncedAcc, quota: fused.quota };
  const overview = deps.getAccountQuotaOverview(fusedAcc, { nowMs: afterNowMs });
  const projected = deps.projectAccount(fusedAcc, {
    overview,
    nowMs: afterNowMs,
    isActive: false,
    hasLocalOAuthClient,
    includeOverviewFields: true,
    revisionWithReadiness: true,
    quotaSourceEnvironmentId: fused.quotaSourceEnvironmentId ?? freshRemote.environmentId,
    activeRemoteEnvIds: fused.activeRemoteEnvIds.length > 0 ? fused.activeRemoteEnvIds : [freshRemote.environmentId],
  });
  const envSnapshot = deps.buildEnvironmentSnapshot({ nowMs: afterNowMs });
  deps.publishSnapshot();
  return {
    ok: true,
    partial: false,
    message: deps.readOkMessage ?? bt('main.quota.read_ok'),
    quota: projected?.quota ?? null,
    account: projected,
    subscription_tier: normalizeSubscriptionTier(projected?.subscription_tier),
    remoteSessions: envSnapshot.remoteSessions,
    environments: envSnapshot.environments,
    environmentsRevision: envSnapshot.environmentsRevision,
    remoteSyncRevision: envSnapshot.remoteSyncRevision,
    focusedEnvironmentId: envSnapshot.focusedEnvironmentId,
  };
}

/**
 * 总览聚合降级处理：accounts / usage 两段各自独立降级，
 * 失败段返回 null + 脱敏短错误，成功段照常返回可用数据；整体仍由调用方回 ok:true。
 */
export async function buildDashboardAggregate(deps: DashboardAggregateDeps): Promise<DashboardAggregate> {
  let accounts: any = null;
  let usage: any = null;
  let accountsError = '';
  let usageError = '';
  await Promise.all([
    (async () => {
      try {
        const [listRes, autoCfg, liveLs] = await Promise.all([
          deps.listAccounts(),
          deps.getAutoSwitchConfig(),
          Promise.resolve().then(() => deps.probeLiveLanguageServer()).catch(() => null),
        ]);
        const activeAcc = listRes.active_account;
        const liveAccountEmail = liveLs?.email ?? null;
        let sourceAcc: any = activeAcc;
        let currentAccountId: string | null = listRes.active_account_id;
        let activeEmail = activeAcc?.email ?? '';
        let activeName = activeAcc?.name ?? '';
        let isLiveVerified = false;
        let quotaRefreshError = cleanAndLocalizeRefreshError((activeAcc as any)?.quota_refresh_error) ?? '';

        // 同一载荷的顶层/模型/分组/英文描述倒计时统一由 reset_time 按同一参考时刻现算。
        const dashboardNowMs = Date.now();
        const remoteCandidates = deps.getRemoteSessions ? deps.getRemoteSessions() : [];
        let savedQuotaForFusion: QuotaData | null | undefined = activeAcc?.quota ?? null;
        let liveQuotaForFusion: QuotaData | null | undefined = null;
        if (liveAccountEmail) {
          const matchedSummary = listRes.accounts.find((a: any) => a.email.toLowerCase() === liveAccountEmail.toLowerCase());
          const matchedSaved = matchedSummary ? await deps.getAccount(matchedSummary.id) : null;
          if (matchedSaved) {
            savedQuotaForFusion = matchedSaved.quota ?? null;
            liveQuotaForFusion = liveLs?.quota ?? null;
            const mergedQuota = mergeLiveQuotaWithSaved(matchedSaved.quota, liveLs?.quota, dashboardNowMs);
            sourceAcc = { ...matchedSaved, ...(mergedQuota ? { quota: mergedQuota } : {}) };
            currentAccountId = matchedSaved.id;
            activeEmail = matchedSaved.email;
            activeName = matchedSaved.name || liveLs?.name || '';
            isLiveVerified = true;
            quotaRefreshError = cleanAndLocalizeRefreshError(matchedSaved.quota_refresh_error) ?? '';
          } else {
            // 实机运行账号未保存在本地账号库：严禁混入已存 activeAcc 的姓名、等级或配额
            savedQuotaForFusion = null;
            liveQuotaForFusion = liveLs?.quota ?? null;
            sourceAcc = {
              email: liveAccountEmail,
              name: liveLs?.name ?? '',
              quota: liveLs?.quota ?? null,
            };
            currentAccountId = null;
            activeEmail = liveAccountEmail;
            activeName = liveLs?.name ?? '';
            isLiveVerified = false;
            quotaRefreshError = '';
          }
        }

        const fusedDashboardQuota = activeEmail
          ? fuseAccountQuotaAcrossEnvironments({
              email: activeEmail,
              savedQuota: savedQuotaForFusion,
              liveLocalQuota: liveQuotaForFusion,
              remoteSessions: remoteCandidates,
              nowMs: dashboardNowMs,
            })
          : { quota: sourceAcc?.quota ?? null, quotaSourceEnvironmentId: sourceAcc?.quota ? 'local' : null, activeRemoteEnvIds: [], freshestObservedAtSec: null };
        if (sourceAcc && fusedDashboardQuota.quota) {
          sourceAcc = { ...sourceAcc, quota: fusedDashboardQuota.quota };
        }

        const quotaOverview = sourceAcc ? deps.getAccountQuotaOverview(sourceAcc, { nowMs: dashboardNowMs }) : null;
        // 有账号但套餐缺失/空串时回落到“待确认”；完全无账号时才保留 FREE 的既有语义。
        const activeTier = (!isLiveVerified && liveAccountEmail && !currentAccountId)
          ? resolveUnsavedLiveSubscriptionTier(liveLs, quotaOverview)
          : (quotaOverview ? normalizeSubscriptionTier(quotaOverview.subscriptionTier) : 'FREE');

        const resetTimeStr = formatResetTime(quotaOverview?.resetTime);

        accounts = {
          revision: listRes.revision,
          total: listRes.accounts.length,
          currentAccountId,
          activeEmail,
          configuredEmail: activeAcc?.email ?? '',
          isLiveVerified,
          activeName,
          activeTier,
          currentEmail: activeEmail,
          liveAccountEmail,
          quotaLastUpdated: sourceAcc?.quota?.last_updated ?? null,
          quotaSourceEnvironmentId: fusedDashboardQuota.quotaSourceEnvironmentId,
          activeRemoteEnvIds: fusedDashboardQuota.activeRemoteEnvIds,
          readyCount: listRes.accounts.filter((a: any) => !a.disabled).length,
          autoSwitchEnabled: autoCfg.enabled,
          fiveHourRemaining: quotaOverview?.fiveHourRemaining ?? null,
          weeklyRemaining: quotaOverview?.weeklyRemaining ?? null,
          geminiFiveHourRemaining: quotaOverview?.geminiFiveHourRemaining ?? null,
          geminiWeeklyRemaining: quotaOverview?.geminiWeeklyRemaining ?? null,
          geminiFiveHourResetCountdown: quotaOverview?.geminiFiveHourResetCountdown ?? '',
          geminiWeeklyResetCountdown: quotaOverview?.geminiWeeklyResetCountdown ?? '',
          geminiResetCountdown: quotaOverview?.geminiResetCountdown ?? '',
          claudeFiveHourRemaining: quotaOverview?.claudeFiveHourRemaining ?? null,
          claudeWeeklyRemaining: quotaOverview?.claudeWeeklyRemaining ?? null,
          claudeFiveHourResetCountdown: quotaOverview?.claudeFiveHourResetCountdown ?? '',
          claudeWeeklyResetCountdown: quotaOverview?.claudeWeeklyResetCountdown ?? '',
          claudeResetCountdown: quotaOverview?.claudeResetCountdown ?? '',
          argonWeeklyRemaining: quotaOverview?.argonWeeklyRemaining ?? null,
          argonWeeklyResetCountdown: quotaOverview?.argonWeeklyResetCountdown ?? '',
          argonResetCountdown: quotaOverview?.argonResetCountdown ?? '',
          carbonWeeklyRemaining: quotaOverview?.carbonWeeklyRemaining ?? null,
          carbonWeeklyResetCountdown: quotaOverview?.carbonWeeklyResetCountdown ?? '',
          carbonResetCountdown: quotaOverview?.carbonResetCountdown ?? '',
          resetTime: resetTimeStr,
          resetCountdown: quotaOverview?.resetCountdown ?? '',
          staleGroups: quotaOverview?.staleGroups ?? [],
          stale_groups: quotaOverview?.staleGroups ?? [],
          models: quotaOverview?.models ?? [],
          lastUpdated: quotaOverview?.lastUpdated ?? null,
          isStale: quotaOverview?.isStale ?? false,
          staleHours: quotaOverview?.staleHours ?? 0,
          quotaRefreshError,
          ...projectQuotaContract(quotaOverview ?? { familyWindows: null, argonStatus: null, carbonStatus: null, standaloneModels: [], projectedQuotaGroups: [],
            refreshState: { complete: false }, quotaWarnings: [], quotaWarningCodes: [] }),
        };
      } catch (error) { accountsError = sanitizeErrorMessage(error); }
    })(),
    (async () => {
      try {
        const [rawSummary, pricing] = await Promise.all([
          deps.getUsageSummary(),
          deps.getPricingTable(),
        ]);
        const summary = rawSummary as TokenUsageSummary;
        const isUnfilteredEnv = (summary?.selected_environment_id ?? 'all') === 'all';
        const hasTodaySeries =
          Array.isArray(summary?.today?.by_model) && Array.isArray(summary?.today_hourly);
        const allPeriodsProjected =
          isUnfilteredEnv && hasTodaySeries
            ? projectAllUsagePeriodSummaries(summary)
            : undefined;
        const todayProjected = allPeriodsProjected?.today ?? (hasTodaySeries ? projectSingleUsagePeriod(summary, 'today') : undefined);
        const envBreakdown = summary.today?.environment_breakdown ?? summary.environment_breakdown ?? null;
        const selectedEnvId = summary?.selected_environment_id ?? 'all';
        usage = {
          todayTokens: summary.today.totals.total_tokens,
          totalTokens: summary.all_time.totals.total_tokens,
          estimatedUsd: summary.today.estimated_usd,
          allTimeEstimatedUsd: summary.all_time.estimated_usd,
          requestCount: summary.today.totals.request_count,
          totalRequestCount: summary.all_time.totals.request_count,
          pricingModels: Object.keys(pricing).length,
          todayPricedModels: summary.today.priced_models ?? 0,
          todayUnpricedModels: summary.today.unpriced_models ?? 0,
          unpricedModels: summary.unpriced_models ?? 0,
          pricedModels: summary.priced_models ?? 0,
          databasesScanned: summary.databases_scanned ?? 0,
          databasesDiscovered: summary.databases_discovered ?? 0,
          scanScopeDescription: summary.scan_scope_description ?? '',
          hasError: summary.has_error ?? false,
          failedDatabasesCount: summary.failed_databases_count ?? 0,
          skippedLargeRecords: summary.skipped_large_records ?? 0,
          availability: summary.availability ?? 'complete',
          unknownTimeRecords: summary.unknown_time_records ?? 0,
          unknownTimeTokens: summary.unknown_time_tokens ?? 0,
          databaseDiagnostics: summary.database_diagnostics ?? [],
          selectedEnvironmentId: selectedEnvId,
          selected_environment_id: selectedEnvId,
          availableEnvironments: summary.available_environments ?? [],
          ...(envBreakdown ? { environmentBreakdown: envBreakdown, environment_breakdown: envBreakdown } : {}),
          ...(todayProjected ? {
            todayHourly: todayProjected.todayHourly,
            todayByModel: todayProjected.byModel,
          } : {}),
          ...(allPeriodsProjected ? { periods: allPeriodsProjected } : {}),
        };
      } catch (error) { usageError = sanitizeErrorMessage(error); }
    })(),
  ]);
  return { accounts, usage, accountsError, usageError };
}

export async function request(command: string): Promise<any> {
  const argv = process.argv.slice(2);
  const targetStateDir = resolve(cliOption(argv, '--state-dir', defaultGravityBoxStateDir())!);
  const target = await resolveClientIpcTarget(targetStateDir);
  if (!target) {
    throw new Error(bt('main.assistant_not_running'));
  }
  await validateIpcEndpointForClient(target.endpoint);
  const requestPayload = target.authToken ? { command, authToken: target.authToken } : { command };
  return new Promise((resolveReply, reject) => {
    const client = createConnection(target.endpoint); let buffer = ''; let received = 0;
    const decoder = new StringDecoder('utf8');
    client.setTimeout(['status', 'ping', 'task_list', 'proxy_get'].includes(command) ? 8000 : 120000, () => { client.destroy(); reject(new Error(bt('main.request_timeout'))); });
    client.on('connect', () => client.write(JSON.stringify(requestPayload) + '\n'));
    client.on('data', bytes => {
      // CLI 必须与 socket 服务端一样按 UTF-8 流解码：多字节中文可能跨 chunk 边界，
      // 逐 chunk toString() 会产生 U+FFFD 并损坏 coverage_report/dictionary_export 的 JSON。
      received += bytes.length;
      if (received > 4_000_000) { client.destroy(); reject(new Error(bt('main.response_too_large'))); return; }
      buffer += decoder.write(bytes);
      if (buffer.includes('\n')) { client.end(); try { resolveReply(JSON.parse(buffer.split('\n')[0]!)); } catch { reject(new Error(bt('main.response_invalid_format'))); } }
    });
    client.on('error', () => reject(new Error(bt('main.assistant_not_running'))));
  });
}
async function run() {
  const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (process.cwd() !== '/' && pathsEqual(resolve(process.cwd()), projectRoot)) {
    const cwdEnvPath = join(projectRoot, '.env');
    const cwdEnvInfo = await lstat(cwdEnvPath).catch(() => null);
    if (cwdEnvInfo && cwdEnvInfo.isFile() && !cwdEnvInfo.isSymbolicLink() && isOwnedByCurrentUser(cwdEnvInfo)) {
      try {
        process.loadEnvFile?.(cwdEnvPath);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          // ignore
        }
      }
    }
  }
  const args = process.argv.slice(2);
  const option = (name: string, fallback?: string) => cliOption(args, name, fallback);
  const command = option('--command');
  if (command) { console.log(JSON.stringify(await request(command))); return; }
  if (args.includes('--heal')) throw new Error(bt('main.heal_unsupported'));
  const stateDir = resolve(option('--state-dir', defaultGravityBoxStateDir())!);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const stateInfo = await lstat(stateDir);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink() || !isOwnedByCurrentUser(stateInfo)) throw new Error(bt('main.state_dir_mismatch'));
  if (!isWindows()) await chmod(stateDir, 0o700);
  const envPath = join(stateDir, '.env');
  const envInfo = await lstat(envPath).catch(() => null);
  if (envInfo && envInfo.isFile() && !envInfo.isSymbolicLink() && isOwnedByCurrentUser(envInfo)) {
    try {
      process.loadEnvFile?.(envPath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        // ignore
      }
    }
  }
  let windowsIpcSession: WindowsIpcSession | null = null;
  let socketPath = resolveIpcEndpoint(stateDir);
  let configuredChannel: unknown;
  let configuredHudEnabled: unknown;
  let configuredAppLanguage: unknown;
  let configuredAutoPricingSync: unknown;
  try {
    const parsedCfg = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'));
    configuredChannel = parsedCfg.applicationChannel;
    configuredHudEnabled = parsedCfg.hudEnabled;
    configuredAppLanguage = parsedCfg.appLanguage;
    configuredAutoPricingSync = parsedCfg.autoPricingSyncEnabled;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(bt('main.channel_config_unreadable')); }
  loadProxyConfigFromStateDir(stateDir);
  const explicitLocaleArg = option('--locale');
  const explicitSystemLocalesArg = option('--system-locales');
  const initialSystemLocales = explicitSystemLocalesArg
    ? explicitSystemLocalesArg.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  const effectiveInitialSystemLocales = initialSystemLocales?.length ? initialSystemLocales : undefined;
  const explicitChannelArg = option('--channel');
  const explicitAppArg = option('--app');
  const explicitProfileArg = option('--profile');
  const requestedChannel = explicitChannelArg !== undefined ? applicationChannel(explicitChannelArg) : savedApplicationChannel(configuredChannel);
  const initialInstallInfo = detectInstalledChannels(requestedChannel);
  let channel: ApplicationChannel = (explicitChannelArg || explicitAppArg || explicitProfileArg)
    ? requestedChannel
    : initialInstallInfo.effectiveChannel;
  let selectedTarget = applicationTarget(channel);
  let appPath = explicitAppArg ?? selectedTarget.appPath;
  let profile = explicitProfileArg ?? selectedTarget.profile;
  let target: ApplicationTarget = applicationTarget(channel, undefined, { appPath, profile });
  let channelStateDir = stateDir;
  if (args.includes('--diagnose')) {
    const endpoint = await discover(appPath, profile);
    console.log(JSON.stringify(endpoint ? { found: true, pid: endpoint.pid, appVersion: endpoint.appVersion, legacyPatch: endpoint.legacyPatch, loopback: true } : { found: false })); return;
  }
  const geminiDir = option('--gemini-dir', process.env.GRAVITYBOX_GEMINI_DIR || process.env.GEMINI_DIR || join(homedir(), '.gemini'))!;
  const cacheMaintenance = new CacheMaintenance(profile, isWindows() ? undefined : join(homedir(), '.Trash'), undefined, { stateDir: channelStateDir, geminiDir, appPath });
  const accountsManager = new AccountsManager(stateDir, { target });
  const weeklySnapshotStore = new WeeklyQuotaSnapshotStore(stateDir);
  const recordWeeklySnapshotSafe = (params: {
    email?: string | null;
    quota?: QuotaData | null;
    source?: string;
    observedAtSec?: number | null;
    tier?: string | null;
  }): void => {
    try {
      if (!params.email || !params.quota || params.quota.is_forbidden) return;
      const observedAtSec =
        typeof params.observedAtSec === 'number' && Number.isFinite(params.observedAtSec) && params.observedAtSec > 0
          ? Math.floor(params.observedAtSec)
          : (typeof params.quota.last_updated === 'number' && params.quota.last_updated > 0
              ? Math.floor(params.quota.last_updated)
              : Math.floor(Date.now() / 1000));
      weeklySnapshotStore.recordQuotaSnapshot({
        email: params.email,
        quota: params.quota,
        source: params.source ?? params.quota.source ?? 'cloud',
        observedAtSec,
        tier: params.tier ?? params.quota.subscription_tier ?? undefined,
      });
    } catch {}
  };
  const liveIdeModelsPath = join(stateDir, 'live-ide-models.json');
  let liveSnapshotWriteChain = Promise.resolve();
  let lastLiveSnapshotDedupKey = '';
  async function persistLiveIdeModelsIfPresent(live: Parameters<typeof sanitizeLiveIdeModelsSnapshot>[0]): Promise<void> {
    if (!live?.quota?.models?.length) return;
    registerObservedModelsFromSource(live.quota.models);
    const appVersion = await readInstalledAppBundleVersion(target.appPath);
    const snapshot = sanitizeLiveIdeModelsSnapshot(live, appVersion);
    if (!snapshot) return;
    const dedupKey = JSON.stringify({
      appVersion: snapshot.appVersion,
      tier: snapshot.tier,
      models: snapshot.models,
    });
    if (dedupKey === lastLiveSnapshotDedupKey) return;
    lastLiveSnapshotDedupKey = dedupKey;
    liveSnapshotWriteChain = liveSnapshotWriteChain
      .catch(() => {})
      .then(() => atomicJson(liveIdeModelsPath, snapshot))
      .catch(() => {});
    await liveSnapshotWriteChain;
  }
  async function probeLiveCached() {
    const live = await accountsManager.probeLiveLanguageServer();
    await persistLiveIdeModelsIfPresent(live);
    if (live?.email && live.quota) {
      recordWeeklySnapshotSafe({
        email: live.email,
        quota: live.quota,
        source: 'live',
        observedAtSec: live.quota.last_updated,
        tier: live.tier || live.quota.subscription_tier,
      });
    }
    return live;
  }
  const accountLogin = new GoogleAccountLogin((token, signal) => accountsManager.addAccountFromOAuth(token, signal));
  const homeDir = option('--home-dir', process.env.GRAVITYBOX_HOME_DIR || homedir())!;
  const appSupportDir = option('--app-support-dir', process.env.GRAVITYBOX_APP_SUPPORT_DIR || defaultAppSupportDir())!;
  const switchService = new AccountSwitchService(accountsManager, { stateDir, profile, channel, homeDir, geminiDir });
  const usageManager = new UsageStatsManager({ stateDir, geminiDir });
  cacheMaintenance.setHooks({
    archiveDatabases: dbPaths => usageManager.archiveDatabasesBeforeClear(dbPaths),
    onMutated: () => usageManager.invalidateCache(),
  });
  let accountSyncInFlight: Promise<void> | null = null;
  let accountSyncedAt = 0;
  const cachedAccountIdsByEmail = new Map<string, string>();
  const refreshCachedAccountIds = (accounts: ReadonlyArray<{ id?: string; email?: string }>): void => {
    cachedAccountIdsByEmail.clear();
    for (const a of accounts) {
      if (a.email && a.id) cachedAccountIdsByEmail.set(a.email.trim().toLowerCase(), a.id);
    }
  };
  const matchCachedAccountId = (email: string): string | null =>
    cachedAccountIdsByEmail.get(email.trim().toLowerCase()) ?? null;
  async function syncActiveAccountToUsageManager(forceSync = false): Promise<void> {
    const now = Date.now();
    if (!forceSync && now - accountSyncedAt < 4500) return;
    if (accountSyncInFlight) return accountSyncInFlight;
    accountSyncInFlight = (async () => {
      try {
        const live = await probeLiveCached().catch(() => null);
        const listRes = await accountsManager.listAccounts({ liveEmailHint: live?.email ?? null }).catch(() => null);
        if (listRes?.accounts) {
          refreshCachedAccountIds(listRes.accounts);
          usageManager.setKnownAccounts(listRes.accounts.map(a => ({
            id: a.id,
            email: a.email,
            name: a.name ?? null,
          })));
        }
        const observedEmail = typeof live?.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(live.email) ? live.email : null;
        if (observedEmail) {
          const matched = listRes?.accounts.find(account => account.email.toLowerCase() === observedEmail.toLowerCase());
          usageManager.setCurrentAccountContext({
            id: matched?.id ?? observedEmail,
            email: observedEmail,
          });
        } else {
          usageManager.setCurrentAccountContext(undefined);
        }
        accountSyncedAt = Date.now();
      } catch {}
    })().finally(() => { accountSyncInFlight = null; });
    return accountSyncInFlight;
  }
  const buildPricingCatalogPayload = () =>
    buildPricingCatalogPayloadSnapshot({
      appPath: target.appPath,
      liveIdeModelsPath,
      probeLiveCached,
      usageManager,
      accountsManager,
    });

  let lastAutoSyncUnpricedSignature = '';
  let maybeScheduleAutoPricingSync: (reason: 'startup' | 'timer' | 'unpriced' | 'enabled', unpricedKeys?: string[]) => void = () => {};

  async function syncActiveOfficialModelsToUsageManager(): Promise<void> {
    try {
      const payload = await buildPricingCatalogPayload();
      if (payload.unpricedLiveModels.length > 0) {
        maybeScheduleAutoPricingSync('unpriced', payload.unpricedLiveModels.map((m) => m.key));
      }
    } catch {}
  }
  const pricePrefs = await readOptionalJson<{ enabled?: boolean }>(join(stateDir, 'pricing-preferences.json'), 'pricing-preferences.json');
  if (pricePrefs) usageManager.setAutoRemotePricingSync(pricePrefs.enabled === true);
  else if (typeof configuredAutoPricingSync === 'boolean') usageManager.setAutoRemotePricingSync(configuredAutoPricingSync);
  await usageManager.hydratePricingCatalog().catch(() => {});
  await (async () => {
    const listRes = await accountsManager.listAccounts().catch(() => null);
    for (const acc of listRes?.accounts ?? []) {
      if (acc.quota?.models?.length) {
        registerObservedModelsFromSource(acc.quota.models);
      }
    }
    const installedVer = await readInstalledAppBundleVersion(target.appPath).catch(() => '');
    const snap = installedVer ? await readValidLiveIdeModelsSnapshot(liveIdeModelsPath, installedVer).catch(() => null) : null;
    if (snap?.models?.length) {
      registerObservedModelsFromSource(snap.models);
    }
  })().catch(() => {});
  const idempotencyStore = new IdempotencyStore();
  let backendLease: ProcessLease | undefined;

  function projectAccountForIpcNormalized(
    account: Parameters<typeof projectAccountNormalizedWithManager>[0],
    options?: Parameters<typeof projectAccountNormalizedWithManager>[2],
  ): Record<string, unknown> | null {
    return projectAccountNormalizedWithManager(account, accountsManager, options);
  }
  const hasLocalOAuthClientConfigured = () => Boolean(getGoogleClientId() && getGoogleClientSecret());
  type ActiveIpcIdentity = { activeId: string | null; activeEmailLower: string | null };
  const resolveActiveIdentityForIpc = async (): Promise<ActiveIpcIdentity> => {
    const live = await probeLiveCached().catch(() => null);
    const detectedEmail = live?.email ?? await accountsManager.detectCurrentAntigravityEmail({ liveEmailHint: null }).catch(() => null);
    const index = await accountsManager.loadIndex().catch(() => null);
    const activeEmailLower = detectedEmail?.trim().toLowerCase() ?? null;
    let activeId = index?.current_account_id ?? null;
    if (activeEmailLower && index) {
      activeId = index.accounts.find(a => a.email.trim().toLowerCase() === activeEmailLower)?.id ?? null;
    }
    return { activeId, activeEmailLower };
  };
  const isIdentityActiveAccount = (
    identity: ActiveIpcIdentity,
    account: { id?: string | null; email?: string | null } | null | undefined,
  ): boolean => {
    if (!account) return false;
    if (identity.activeEmailLower && account.email) {
      return account.email.trim().toLowerCase() === identity.activeEmailLower;
    }
    return Boolean(!identity.activeEmailLower && account.id && identity.activeId === account.id);
  };
  backendLease = await acquireProcessLease(join(stateDir, 'backend.lock'), 0);
  const earlySignalExit = () => { backendLease?.releaseSync(); process.exit(0); };
  process.once('exit', () => backendLease?.releaseSync());
  process.once('SIGTERM', earlySignalExit);
  process.once('SIGINT', earlySignalExit);
  try {
  // Preserve the original config once before migrating the retired channel.
  if (configuredChannel === 'insiders') {
    const configPath = join(stateDir, 'config.json');
    const original = await readFile(configPath, 'utf8');
    const document = JSON.parse(original);
    if (document.applicationChannel === 'insiders') {
      await writeFile(join(stateDir, 'config-before-stable-only.json'), original, { mode: 0o600, flag: 'wx' })
        .catch(error => { if (error.code !== 'EEXIST') throw error; });
      await atomicJson(configPath, { ...document, applicationChannel: 'stable' });
    }
  }
  if (isWindows()) {
    windowsIpcSession = await prepareWindowsIpcForListen(stateDir);
    socketPath = windowsIpcSession.pipeName;
  } else {
    await prepareIpcEndpointForListen(socketPath);
  }
  const cleanupIpc = async () => {
    if (windowsIpcSession) {
      await cleanupIpcSession(stateDir, process.pid).catch(() => {});
    } else {
      await cleanupIpcEndpoint(socketPath).catch(() => {});
    }
  };
  await mkdir(channelStateDir, { recursive: true, mode: 0o700 });
  const userDir = join(stateDir, '词典'); await mkdir(userDir, { recursive: true, mode: 0o700 });
  const userInfo = await lstat(userDir);
  if (userInfo.isSymbolicLink() || !userInfo.isDirectory() || !isOwnedByCurrentUser(userInfo)) throw new Error(bt('main.dict_dir_mismatch'));
  const personalPath = join(userDir, '个人覆盖.json');
  try { await lstat(personalPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') await atomicJson(personalPath, {}); else throw error; }
  const baseDir = fileURLToPath(new URL('../dict/', import.meta.url));
  const runtimePrefs = await readOptionalJson<{ language?: string; translationEnabled?: boolean; hudEnabled?: boolean }>(join(stateDir, 'runtime-preferences.json'), 'runtime-preferences.json');
  const preferredConfiguredLanguage =
    explicitLocaleArg ??
    (typeof configuredAppLanguage === 'string' && configuredAppLanguage.trim()
      ? configuredAppLanguage
      : typeof runtimePrefs?.language === 'string' && runtimePrefs.language.trim()
      ? runtimePrefs.language
      : effectiveInitialSystemLocales || process.env.GRAVITYBOX_SYSTEM_LOCALES
      ? 'system'
      : undefined);
  const initialLang =
    preferredConfiguredLanguage !== undefined || runtimePrefs?.translationEnabled !== undefined
      ? resolveInitialRuntimeLanguage({
          configuredLanguage: preferredConfiguredLanguage,
          legacyTranslationEnabled: runtimePrefs?.translationEnabled,
          systemLocales: effectiveInitialSystemLocales,
        })
      : { configuredLanguage: 'zh-Hans', resolvedLocale: 'zh-Hans' };
  setActiveLocale(initialLang.resolvedLocale);
  const initialDictInfo = await resolveDictionaryForLocale(baseDir, initialLang.resolvedLocale);
  const store = new DictionaryStore(initialDictInfo.baseDir, userDir);
  let fallback;
  try {
    const cachedRaw = JSON.parse(await readFile(join(channelStateDir, 'last-valid-dictionary.json'), 'utf8'));
    fallback = dictionaryFromEntries(
      validateEntries(cachedRaw.entries),
      cachedRaw.templateRules ? validateTemplateRules(cachedRaw.templateRules) : undefined
    );
  }
  catch { fallback = await loadDictionary(initialDictInfo.baseDir); }
  await store.start(fallback);
  let stopping = false;
  let writeChain = Promise.resolve();
  let statusTasks:Tasks|undefined;
  let syncRemoteTargetStateAndMaybeTriggerSync: () => void = () => {};
  const environmentRegistry = new EnvironmentRegistry();
  let cachedLocalAccountSnapshot: EnvironmentRegistryLocalAccountInput | null = null;
  let cachedAvailableEnvironments: AvailableEnvironmentUsageOption[] = [];
  let cachedLocalUsageSyncedAtSec: number | null = null;
  let buildUnifiedEnvironmentSnapshot: (options?: {
    availableEnvironments?: AvailableEnvironmentUsageOption[];
    nowMs?: number;
    remoteSessionsOverride?: RemoteSessionState[];
  }) => ReturnType<EnvironmentRegistry['buildSnapshot']> = () => ({
    environments: [],
    environmentsRevision: 0,
    remoteSyncRevision: 0,
    focusedEnvironmentId: 'local',
    remoteSessions: [],
  });
  let pendingStatus: any, writingStatus=false, lastStatusKey="", lastStatusWrite=0;
  const onStatus = (status: AssistantStatus) => {
    syncRemoteTargetStateAndMaybeTriggerSync();
    const envSnapshot = buildUnifiedEnvironmentSnapshot();
    const installState = detectInstalledChannels(channel);
    const oauthClientConfigured = Boolean(getGoogleClientId() && getGoogleClientSecret());
    const snapshot = {
      ...status,
      remoteSessions: envSnapshot.remoteSessions,
      environments: envSnapshot.environments,
      environmentsRevision: envSnapshot.environmentsRevision,
      remoteSyncRevision: envSnapshot.remoteSyncRevision,
      focusedEnvironmentId: envSnapshot.focusedEnvironmentId,
      oauthClientConfigured,
      applicationChannel: channel,
      applicationLabel: target.label,
      accountSwitchSupported: target.supportsAccountSwitch,
      bothApplicationsInstalled: installState.bothInstalled,
      availableChannels: installState.channels,
      pricingRevision: usageManager.getPricingRevision(),
      taskRevision: statusTasks?.revision ?? 0,
      runningTasks: statusTasks?.list().filter(t => t.state === 'running').length ?? 0,
    };
    const {updatedAt,rssMB,...meaningful}=snapshot;const key=JSON.stringify(meaningful);
    if(key===lastStatusKey&&Date.now()-lastStatusWrite<30000)return;
    lastStatusKey=key;lastStatusWrite=Date.now();pendingStatus=snapshot;
    if(!writingStatus) {writingStatus=true;writeChain=writeChain.catch(()=>{}).then(async()=>{try {while(pendingStatus){const snapshot=pendingStatus;pendingStatus=undefined;await atomicJson(join(stateDir,'status.json'),snapshot,undefined,{durability:'relaxed'});}}finally{writingStatus=false;}}).catch(()=>{});}
  };
  let fixture: { port: number; origin: string } | undefined;
  if (option('--fixture-port')) {
    const port = Number(option('--fixture-port')), origin = option('--fixture-origin');
    if (!Number.isInteger(port) || !origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error(bt('main.fixture_invalid'));
    fixture = { port, origin };
  }
  const expiredWindowRefreshAt = new Map<string, number>();
  function scheduleExpiredQuotaCorrection(targetId: string | null, quota: QuotaData | null | undefined, nowMs: number = Date.now()): void {
    if (stopping || fixture) return;
    if (!hasExpiredQuotaWindow(quota, nowMs)) return;
    const key = targetId || '__live_unsaved__';
    const lastAttempt = expiredWindowRefreshAt.get(key) ?? 0;
    if (nowMs - lastAttempt < 60_000) return;
    expiredWindowRefreshAt.set(key, nowMs);
    if (targetId) {
      void accountsManager.refreshQuota(targetId).catch(() => {});
    } else {
      void accountsManager.probeLiveLanguageServer(globalThis.fetch, { forceRefresh: true })
        .then(res => persistLiveIdeModelsIfPresent(res))
        .catch(() => {});
    }
  }
  let applyChain = Promise.resolve();
  const shortcutEnabled = !!fixture;
  let initiallyPaused = initialLang.resolvedLocale === 'en' || !initialDictInfo.hasTargetDictionary;
  let hudEnabled = typeof configuredHudEnabled === 'boolean' ? configuredHudEnabled : true;
  if (runtimePrefs && typeof configuredHudEnabled !== 'boolean' && typeof runtimePrefs.hudEnabled === 'boolean') {
    hudEnabled = runtimePrefs.hudEnabled;
  }
  const saveRuntimePreferences = async (patch: { language?: string; translationEnabled?: boolean; hudEnabled?: boolean }) => {
    const currentPrefs = (await readOptionalJson<Record<string, unknown>>(join(stateDir, 'runtime-preferences.json'), 'runtime-preferences.json')) ?? {};
    const nextPrefs = { ...currentPrefs, translationEnabled: controller.snapshot().translationEnabled !== false, hudEnabled, ...patch };
    if (typeof patch.hudEnabled === 'boolean' || typeof patch.language === 'string') {
      if (typeof patch.hudEnabled === 'boolean') hudEnabled = patch.hudEnabled;
      const configPath = join(stateDir, 'config.json');
      try {
        const cfg = JSON.parse(await readFile(configPath, 'utf8'));
        if (cfg && typeof cfg === 'object' && !Array.isArray(cfg) && (cfg.schema === undefined || cfg.schema === 2)) {
          await atomicJson(configPath, {
            ...cfg,
            ...(typeof patch.hudEnabled === 'boolean' ? { hudEnabled } : {}),
            ...(typeof patch.language === 'string' ? { appLanguage: patch.language } : {}),
          });
        }
      } catch {}
    }
    await atomicJson(join(stateDir, 'runtime-preferences.json'), nextPrefs);
  };
  const controller = new Controller({
    initiallyPaused,
    locale: initialLang.resolvedLocale,
    configuredLanguage: initialLang.configuredLanguage,
    hasTargetDictionary: initialDictInfo.hasTargetDictionary,
    shortcutEnabled,
    hudEnabled,
    appPath,
    profile,
    fixture,
    geminiDir,
    dictionary: store.current!,
    stateDir: channelStateDir,
    selectDictionary:async version=>{const dictionary=await store.selectVersion(version);await applyChain;return dictionary;},
    reloadDictionary: async () => { await store.reload(); await applyChain; if (store.lastError) throw new Error(store.lastError); },
    onStatus,
  });
  let lastConnectedRemoteEnvs = new Map<string, { hostLabel: string; state: string; email: string }>();
  const lastRemoteHeartbeatAtMs = new Map<string, number>();
  const remoteLastSyncedAtSec = new Map<string, number>();
  const remoteSyncCoordinator = new RemoteUsageSyncCoordinator({
    stateDir,
    getTargets: () => controller.getConnectedRemoteRpcTargets(),
    ledger: {
      receipts: () => usageManager.getSyncReceipts(),
      save: async (
        events: RemoteGenerationEvent[],
        options?: { billingPrices?: Record<string, unknown>; receipts?: RemoteUsageSyncReceipt[] }
      ) => {
        const res = await usageManager.ingestRemoteUsageBatch(
          events as LedgerEvent[],
          (options?.receipts ?? []) as SyncReceipt[],
          options?.billingPrices ? { billingPrices: options.billingPrices as Record<string, any> } : undefined
        );
        if (options?.receipts) {
          for (const rec of options.receipts) {
            if (rec?.environment_id && rec.committed_at > 0) {
              const prev = remoteLastSyncedAtSec.get(rec.environment_id) ?? 0;
              if (rec.committed_at > prev) remoteLastSyncedAtSec.set(rec.environment_id, rec.committed_at);
            }
          }
        }
        return res;
      },
    },
    resolveMatchedLocalAccountId: matchCachedAccountId,
    getBillingPrices: () => usageManager.getBillingPricingTable(),
    onIdentityObserved: info => {
      if (info.live.quota?.models?.length) {
        registerObservedModelsFromSource(info.live.quota.models);
      }
      if (info.live.email && info.live.quota) {
        recordWeeklySnapshotSafe({
          email: info.live.email,
          quota: info.live.quota,
          source: 'ssh',
          observedAtSec: info.live.quota.last_updated ?? Math.floor(info.observedAtMs / 1000),
          tier: info.live.tier || info.live.quota.subscription_tier,
        });
      }
      controller.applyObservedRemoteIdentity({
        environmentId: info.environmentId,
        remoteKey: info.remoteKey,
        live: info.live,
        observedAtMs: info.observedAtMs,
        matchAccountId: matchCachedAccountId,
        getQuotaOverview: (quota, nowMs) => accountsManager.getAccountQuotaOverview({ quota }, { nowMs }),
      });
      syncRemoteTargetStateAndMaybeTriggerSync();
      if (!stopping) {
        onStatus(controller.snapshot());
      }
    },
    onCommitted: () => {
      syncRemoteTargetStateAndMaybeTriggerSync();
      if (!stopping) {
        onStatus(controller.snapshot());
      }
    },
  });
  const toRemoteQuotaCandidates = (sessions: RemoteSessionState[]): RemoteQuotaCandidate[] =>
    sessions.map(s => {
      const host = cleanHostLabel(s.hostLabel) || s.hostLabel || 'ssh-host';
      const envId = s.environmentId || buildRemoteEnvironmentId(host);
      const lifecycleState: EnvironmentLifecycleState =
        s.state === 'disconnected'
          ? 'offline_recent'
          : s.state === 'auth_expired'
            ? 'auth_expired'
            : 'online';
      return {
        environmentId: envId,
        email: s.email,
        lifecycleState,
        quota: s.quota,
        observedAtMs: s.observedAt,
      };
    });
  buildUnifiedEnvironmentSnapshot = (options) => {
    const nowMs = options?.nowMs ?? Date.now();
    const sessions = options?.remoteSessionsOverride ?? controller.getRemoteSessionsSnapshot(nowMs);
    const windowCounts = controller.getEnvironmentWindowCounts();
    const availEnvs = options?.availableEnvironments ?? cachedAvailableEnvironments;
    if (options?.availableEnvironments) {
      cachedAvailableEnvironments = options.availableEnvironments;
    }
    const histMap = new Map<string, { environmentId: string; hostLabel?: string; lastSyncedAtSec?: number | null }>();
    for (const envOpt of availEnvs) {
      if (envOpt?.kind !== 'ssh' || !envOpt.id || envOpt.id === 'local') continue;
      if (envOpt.last_synced_at && envOpt.last_synced_at > 0) {
        const prev = remoteLastSyncedAtSec.get(envOpt.id) ?? 0;
        if (envOpt.last_synced_at > prev) remoteLastSyncedAtSec.set(envOpt.id, envOpt.last_synced_at);
      }
      histMap.set(envOpt.id, {
        environmentId: envOpt.id,
        hostLabel: envOpt.host_label || envOpt.label || envOpt.id,
        lastSyncedAtSec: envOpt.last_synced_at ?? remoteLastSyncedAtSec.get(envOpt.id) ?? null,
      });
    }
    for (const obsEnv of remoteSyncCoordinator.observationStore.listEnvironments()) {
      if (!obsEnv.environmentId || obsEnv.environmentId === 'local') continue;
      if (obsEnv.lastSyncedAt && obsEnv.lastSyncedAt > 0) {
        const prev = remoteLastSyncedAtSec.get(obsEnv.environmentId) ?? 0;
        if (obsEnv.lastSyncedAt > prev) remoteLastSyncedAtSec.set(obsEnv.environmentId, obsEnv.lastSyncedAt);
      }
      if (!histMap.has(obsEnv.environmentId)) {
        histMap.set(obsEnv.environmentId, {
          environmentId: obsEnv.environmentId,
          hostLabel: obsEnv.hostLabel,
          lastSyncedAtSec: obsEnv.lastSyncedAt ?? remoteLastSyncedAtSec.get(obsEnv.environmentId) ?? null,
        });
      }
    }
    for (const [envId, syncedSec] of remoteLastSyncedAtSec.entries()) {
      if (envId === 'local' || histMap.has(envId)) continue;
      histMap.set(envId, {
        environmentId: envId,
        hostLabel: envId,
        lastSyncedAtSec: syncedSec,
      });
    }

    const localSnapshot: EnvironmentRegistryLocalAccountInput | null = cachedLocalAccountSnapshot
      ? {
          ...cachedLocalAccountSnapshot,
          ...(cachedLocalUsageSyncedAtSec ? { lastSyncedAtSec: cachedLocalUsageSyncedAtSec } : {}),
        }
      : (cachedLocalUsageSyncedAtSec ? { lastSyncedAtSec: cachedLocalUsageSyncedAtSec } : null);

    return environmentRegistry.buildSnapshot({
      nowMs,
      localWindowCount: controller.getLocalWindowsCount(),
      localFocusedAt: controller.getLocalFocusedAt(),
      focusedEnvironmentId: controller.getFocusedEnvironmentId(),
      localAccount: localSnapshot,
      remoteSessions: sessions,
      windowCountsByEnvId: windowCounts,
      historicalEnvironments: [...histMap.values()],
      receiptSyncTimes: remoteLastSyncedAtSec,
      remoteSyncRevision: usageManager.getRemoteSyncRevision(),
      staleAfterSeconds: accountsManager.getConfiguredQuotaStaleSeconds(),
      matchAccountId: matchCachedAccountId,
      getQuotaOverview: (quota, tsMs) => accountsManager.getAccountQuotaOverview({ quota }, { nowMs: tsMs }),
      formatResetTime,
      resolveUnsavedTier: (live, overview) => resolveUnsavedLiveSubscriptionTier(live, overview),
    });
  };
  syncRemoteTargetStateAndMaybeTriggerSync = () => {
    if (stopping) return;
    const targets = controller.getConnectedRemoteRpcTargets();
    const sessions = controller.getRemoteSessionsSnapshot();
    const windowCounts = controller.getEnvironmentWindowCounts();
    const envMap = new Map<string, KnownEnvironmentContext>();
    const currentConnected = new Map<string, { hostLabel: string; state: string; email: string }>();
    let shouldTriggerSync = false;

    for (const t of targets) {
      const lastSynced = remoteLastSyncedAtSec.get(t.environmentId);
      const online = t.state !== 'disconnected';
      const lifecycleState: EnvironmentLifecycleState = t.state === 'auth_expired' ? 'auth_expired' : 'online';
      envMap.set(t.environmentId, {
        id: t.environmentId,
        kind: 'ssh',
        host_label: t.hostLabel,
        label: t.hostLabel,
        online,
        lifecycle_state: lifecycleState,
        window_count: windowCounts.get(t.environmentId) ?? t.windowCount ?? 1,
        ...(lastSynced !== undefined ? { last_synced_at: lastSynced } : {}),
      });
      if (online) {
        currentConnected.set(t.environmentId, { hostLabel: t.hostLabel, state: t.state, email: t.email });
        const prev = lastConnectedRemoteEnvs.get(t.environmentId);
        const nowMs = Date.now();
        const heartbeatDue = nowMs - (lastRemoteHeartbeatAtMs.get(t.environmentId) ?? 0) >= 30_000;
        if (!prev || prev.state !== t.state || prev.email !== t.email) {
          shouldTriggerSync = true;
        }
        if (t.email && (!prev || prev.state !== t.state || prev.email !== t.email || heartbeatDue)) {
          lastRemoteHeartbeatAtMs.set(t.environmentId, nowMs);
          remoteSyncCoordinator.recordObservation({
            hostLabel: t.hostLabel,
            environmentId: t.environmentId,
            email: t.email,
            matchedLocalAccountId: t.matchedLocalAccountId ?? cachedAccountIdsByEmail.get(t.email.toLowerCase()) ?? null,
            accountType: t.accountType,
          });
        }
      }
    }

    for (const s of sessions) {
      const envId = s.environmentId || buildRemoteEnvironmentId(s.hostLabel);
      if (envMap.has(envId)) continue;
      const lastSynced = remoteLastSyncedAtSec.get(envId);
      const online = s.state !== 'disconnected';
      const lifecycleState: EnvironmentLifecycleState =
        s.state === 'disconnected'
          ? 'offline_recent'
          : s.state === 'auth_expired'
            ? 'auth_expired'
            : 'online';
      envMap.set(envId, {
        id: envId,
        kind: 'ssh',
        host_label: cleanHostLabel(s.hostLabel) || s.hostLabel,
        label: cleanHostLabel(s.hostLabel) || s.hostLabel,
        online,
        lifecycle_state: lifecycleState,
        window_count: online ? (windowCounts.get(envId) ?? 1) : 0,
        ...(lastSynced !== undefined ? { last_synced_at: lastSynced } : {}),
      });
    }

    for (const prevEnvId of lastConnectedRemoteEnvs.keys()) {
      if (!currentConnected.has(prevEnvId)) {
        lastRemoteHeartbeatAtMs.delete(prevEnvId);
        remoteSyncCoordinator.markEnvironmentDisconnected(prevEnvId);
      }
    }
    lastConnectedRemoteEnvs = currentConnected;
    usageManager.setOnlineRemoteEnvironments([...envMap.values()]);

    if (shouldTriggerSync && !fixture) {
      remoteSyncCoordinator.triggerSync();
    }
  };
  const runBoundedRemoteSyncForDemand = async (maxWaitMs = 6_000): Promise<void> => {
    syncRemoteTargetStateAndMaybeTriggerSync();
    if (stopping || fixture) return;
    if (controller.getConnectedRemoteRpcTargets().length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const syncAc = new AbortController();
    try {
      await Promise.race([
        remoteSyncCoordinator.syncNow({ force: true, signal: syncAc.signal }).catch(() => {}),
        new Promise<void>(resolve => {
          timer = setTimeout(() => {
            syncAc.abort();
            resolve();
          }, maxWaitMs);
          timer.unref();
        }),
      ]);
    } catch {
      // 远端同步超时或失败绝不阻塞本机用量查询返回
    } finally {
      if (timer) clearTimeout(timer);
      syncRemoteTargetStateAndMaybeTriggerSync();
    }
  };
  async function buildRemoteSessionsPayload(options?: {
    force?: boolean;
    remoteKey?: string;
    environmentId?: string;
    nonBlocking?: boolean;
  }): Promise<Record<string, unknown>[]> {
    const index = await accountsManager.loadIndex().catch(() => null);
    if (index?.accounts) {
      refreshCachedAccountIds(index.accounts);
    }
    const matchAccountId = (email: string): string | null => {
      if (!index || !email) return null;
      const targetEmail = email.toLowerCase();
      const found = index.accounts.find(a => a.email.toLowerCase() === targetEmail);
      return found?.id ?? null;
    };
    const getQuotaOverview = (quota: QuotaData, nowMs: number) =>
      accountsManager.getAccountQuotaOverview({ quota }, { nowMs });

    const nowMs = Date.now();
    let sessions: RemoteSessionState[];
    if (options?.nonBlocking) {
      sessions = controller.getRemoteSessionsSnapshot(nowMs);
      const needsBgProbe = sessions.some(
        s => s.state === 'connected' && (!s.observedAt || nowMs - s.observedAt >= 30_000)
      );
      if (needsBgProbe) {
        void controller.probeRemoteSessions({
          matchAccountId,
          getQuotaOverview,
        }).then(probed => {
          for (const s of probed) {
            if (s.state === 'connected' && s.quota && s.email) {
              recordWeeklySnapshotSafe({
                email: s.email,
                quota: s.quota,
                source: 'ssh',
                observedAtSec: s.quota.last_updated ?? (s.observedAt ? Math.floor(s.observedAt / 1000) : null),
                tier: s.tier || s.quota.subscription_tier,
              });
            }
            if (s.state === 'connected' && s.quota?.models?.length && s.matchedLocalAccountId) {
              void accountsManager.syncRemoteObservedQuota(s.matchedLocalAccountId, s.quota, s.tier).catch(() => null);
            }
          }
        }).catch(() => {});
      }
    } else {
      sessions = await controller.probeRemoteSessions({
        force: options?.force,
        remoteKey: options?.remoteKey,
        environmentId: options?.environmentId,
        matchAccountId,
        getQuotaOverview,
      });
      for (const s of sessions) {
        if (s.state === 'connected' && s.quota && s.email) {
          recordWeeklySnapshotSafe({
            email: s.email,
            quota: s.quota,
            source: 'ssh',
            observedAtSec: s.quota.last_updated ?? (s.observedAt ? Math.floor(s.observedAt / 1000) : null),
            tier: s.tier || s.quota.subscription_tier,
          });
        }
        if (s.state === 'connected' && s.quota?.models?.length && s.matchedLocalAccountId) {
          await accountsManager.syncRemoteObservedQuota(s.matchedLocalAccountId, s.quota, s.tier).catch(() => null);
        }
      }
    }
    syncRemoteTargetStateAndMaybeTriggerSync();
    for (const s of sessions) {
      if (s.quota?.models?.length) {
        registerObservedModelsFromSource(s.quota.models);
      }
    }

    return buildUnifiedEnvironmentSnapshot({ nowMs, remoteSessionsOverride: sessions }).remoteSessions;
  }
  const tasks = new Tasks(stateDir, () => onStatus(controller.snapshot()));statusTasks=tasks; await tasks.start();
  usageManager.setOnPricingUpdated(() => {
    onStatus(controller.snapshot());
    void controller.refreshHudForPricingChange().catch(() => {});
  });
  const cancelRunningDeepScan = () => {
    const deepScan = tasks.list().find(t => t.kind === 'deep-scan' && t.state === 'running');
    if (deepScan) tasks.cancel(deepScan.id);
  };
  const applyLocalePreference = async (requested: string, resolved: ReturnType<typeof resolveLocale>) => {
    setActiveLocale(resolved);
    usageManager.invalidateCache();
    const nextDictInfo = await resolveDictionaryForLocale(baseDir, resolved);
    await store.setBaseDir(nextDictInfo.baseDir);
    const shouldTranslate = resolved !== 'en' && nextDictInfo.hasTargetDictionary;
    await saveRuntimePreferences({ language: requested, translationEnabled: shouldTranslate });
    if (!shouldTranslate) cancelRunningDeepScan();
    await controller.setLocale(resolved, requested, {
      dictionary: store.current,
      hasTargetDictionary: nextDictInfo.hasTargetDictionary,
    });
    return shouldTranslate;
  };
  let cacheChain = Promise.resolve();
  const cache = () => { const value = store.current; cacheChain = cacheChain.catch(() => {}).then(() => atomicJson(join(channelStateDir, 'last-valid-dictionary.json'), value)); cacheChain.catch(() => {}); };
  cache();
  if (store.lastError) controller.dictionaryError(store.lastError);
  store.on('updated', dictionary => { cache(); applyChain = controller.update(dictionary); applyChain.catch(() => controller.dictionaryError(bt('main.dict_partial_update'))); });
  store.on('invalid', message => controller.dictionaryError(String(message)));
  store.on('valid', () => controller.dictionaryError());
  let commandChain = Promise.resolve(); const ipcMetrics = { statusRequests: 0, taskPayloadReplies: 0 };
  const startQuotaRefreshTask = () => tasks.begin('quota-refresh', bt('main.task.quota_refresh_title'), async (signal, progress, _commit) => {
    const remoteProbePromise = controller.getRemoteSessionsSnapshot().some(s => s.state !== 'disconnected')
      ? buildRemoteSessionsPayload({ force: true }).catch(() => [] as Record<string, unknown>[])
      : Promise.resolve([] as Record<string, unknown>[]);
    const [result] = await Promise.all([
      accountsManager.refreshAllQuotas(globalThis.fetch, {
        signal,
        onAccountUpdated: (account, done, total) => {
          if (account?.quota?.models?.length) {
            registerObservedModelsFromSource(account.quota.models);
          }
          if (account?.email && account.quota) {
            recordWeeklySnapshotSafe({
              email: account.email,
              quota: account.quota,
              source: account.quota.source ?? 'cloud',
              observedAtSec: account.quota.last_updated,
              tier: account.quota.subscription_tier,
            });
          }
          progress(done, total);
        },
      }),
      remoteProbePromise,
    ]);
    if (controller.getRemoteSessionsSnapshot().length > 0) {
      onStatus(controller.snapshot());
    }
    const localUpdatedIds = new Set(result.accounts.map(a => a.id));
    const remoteRefreshedIds = new Set<string>();
    for (const s of controller.getRemoteSessionsSnapshot()) {
      if (s.state === 'connected' && s.quota?.models?.length && s.matchedLocalAccountId && !localUpdatedIds.has(s.matchedLocalAccountId)) {
        remoteRefreshedIds.add(s.matchedLocalAccountId);
      }
    }
    const extraRemoteUpdated = remoteRefreshedIds.size;
    const rawSkippedStandby = (result as { skippedStandby?: number }).skippedStandby ?? 0;
    const skippedStandby = Math.max(0, rawSkippedStandby - extraRemoteUpdated);
    const updatedCount = result.accounts.length + extraRemoteUpdated;
    const incomplete = result.accounts.filter(a => a.quota?.refresh_state?.complete === false).length;
    const warnings = result.accounts.filter(a => a.quota_refresh_error || a.quota?.refresh_state?.complete === false).length;
    const staleAccounts = result.accounts.filter(a => (a.quota?.stale_groups?.length ?? 0) > 0).length;
    const staleGroups = result.accounts.reduce((total, a) => total + (a.quota?.stale_groups?.length ?? 0), 0);
    const incompletePart = incomplete ? bt('main.task.quota_refresh_incomplete_part', { count: incomplete }) : '';
    const stalePart = staleAccounts ? bt('main.task.quota_refresh_stale_part', { accounts: staleAccounts, groups: staleGroups }) : '';
    const hasFailures = result.failures.length > 0;
    const message = hasFailures
      ? bt('main.task.quota_refresh_failures', { total: updatedCount, failed: result.failures.length })
      : updatedCount === 0 && skippedStandby > 0
      ? bt('main.task.quota_refresh_standby_only', { skipped: skippedStandby })
      : skippedStandby > 0
      ? bt('main.task.quota_refresh_ok_with_standby', { updated: updatedCount, skipped: skippedStandby })
      : bt('main.task.quota_refresh_ok', { total: updatedCount, incompletePart, stalePart });
    const ok = !hasFailures && incomplete === 0;
    const partial = (hasFailures || incomplete > 0) && updatedCount > 0;
    return { ok, partial,
      incomplete, updated: updatedCount, failed: result.failures.length, skippedStandby, warnings, staleAccounts, staleGroups,
      remoteRefreshedCount: extraRemoteUpdated,
      message };
  });
  async function recommendationPreview(config: any, cached: boolean) {
    const live = await (cached ? probeLiveCached() : accountsManager.probeLiveLanguageServer()).catch(() => null);
    const detectedEmail = live?.email ?? await accountsManager.detectCurrentAntigravityEmail({ liveEmailHint: null }).catch(() => null);
    const index = await accountsManager.loadIndex();
    const currentId = detectedEmail ? index.accounts.find(a => a.email.toLowerCase() === detectedEmail.toLowerCase())?.id : undefined;
    if (live?.email && !currentId) return null;
    return accountsManager.selectBestAccount(config, { currentId, currentEmail: detectedEmail ?? undefined, currentQuota: live?.quota });
  }
  const server = createServer(client => {
    // 首行请求接收前采用 10s 短超时；解析出合法指令后再切换至 120s 长操作超时
    client.setTimeout(10_000, () => client.destroy());
    let input = ''; let received = 0; let handled = false; let parsed: any; let ownsIdempotency=false;
    const reply = (value: unknown) => {
      if(ownsIdempotency){ownsIdempotency=false;idempotencyStore.complete(String(parsed.idempotencyKey),value);}
      if (client.destroyed) return;
      const withId = (parsed?.id !== undefined && typeof value === 'object' && value !== null)
        ? { id: parsed.id, ...(value as any), ...(parsed.requestId !== undefined ? { requestId: parsed.requestId } : {}) }
        : { ...(value as any), ...(parsed?.requestId !== undefined ? { requestId: parsed.requestId } : {}) };
      client.end(JSON.stringify(withId) + '\n');
    };
    client.on('error', () => {});
    const decoder = new StringDecoder('utf8');
    client.on('data', chunk => {
      if (handled) return;
      received += chunk.length;
      if (received > 4_000_000) { handled = true; reply({ ok: false, error: bt('main.request_too_large') }); return; }
      input += decoder.write(chunk);
      if (!input.includes('\n')) return; handled = true;
      client.setTimeout(120_000, () => client.destroy());
      try { parsed = JSON.parse(input.split('\n')[0]!); } catch { reply({ ok: false, error: bt('main.request_invalid_format') }); return; }
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)){reply({ok:false,error:bt('main.request_invalid_format')});return;}
      if (windowsIpcSession && !verifyIpcAuthToken(parsed.authToken, windowsIpcSession.authToken)) {
        reply({ ok: false, error: bt('main.socket_mismatch') });
        return;
      }
      const command = parsed.command;
      if (stopping && command !== 'stop') {
        reply({ ok: false, error: bt('main.assistant_not_running') });
        return;
      }
      if (parsed.idempotencyKey) {
        if(typeof parsed.idempotencyKey!=='string'||parsed.idempotencyKey.length>256){reply({ok:false,error:bt('main.idempotency_invalid')});return;}
        const fingerprint=createHash('sha256').update(JSON.stringify(canonicalPayload(parsed))).digest('hex');
        const state=idempotencyStore.reserve(parsed.idempotencyKey,fingerprint,reply,{ok:false,error:bt('main.request_timeout')});
        if(state==='waiting')return;
        if(state!=='owner'){reply({ok:false,error:state==='conflict'?bt('main.idempotency_conflict'):bt('main.too_many_requests')});return;}
        ownsIdempotency=true;
      }
      if (command === 'set_application_channel') {
        try {
          applicationChannel(parsed.channel);
          reply({ ok: true, applicationChannel: 'stable', applicationLabel: target.label,
            accountSwitchSupported: target.supportsAccountSwitch,
            bothApplicationsInstalled: false, availableChannels: detectInstalledChannels().channels });
        } catch (error) { reply({ ok: false, error: sanitizeErrorMessage(error) }); }
        return;
      }
      if(command==='usage_cancel'){reply({ok:true,cancelled:usageManager.cancelRead()});return;}
      if (command === 'ping') { reply({ ok: true, pid: process.pid }); return; }
      if (command === 'status') {
        ipcMetrics.statusRequests++;
        (async () => {
          let activeAccountEmail = '';
          let activeFiveHourQuota: number | null = null;
          let activeSubscriptionTier = 'FREE';
          let liveAccountEmail: string | null = null;
          let accountsRevision = '';
          const statusNowMs = Date.now();
          const remoteCandidatesForStatus = toRemoteQuotaCandidates(controller.getRemoteSessionsSnapshot(statusNowMs));
          if (parsed.includeAccounts !== false) {
            try {
              const liveLs = await probeLiveCached().catch(() => null);
              const listRes = await accountsManager.listAccounts({ liveEmailHint: liveLs?.email ?? null });
              accountsRevision = listRes.revision;
              usageManager.setKnownAccounts(listRes.accounts.map(a => ({ id: a.id, email: a.email, name: a.name ?? null })));
              const detectedEmail = liveLs?.email ?? await accountsManager.detectCurrentAntigravityEmail({ liveEmailHint: null }).catch(() => null);
              if (detectedEmail) {
                liveAccountEmail = liveLs?.email ?? null;
                const matchedSummary = listRes.accounts.find(a => a.email.toLowerCase() === detectedEmail.toLowerCase());
                if (liveLs?.email) {
                  usageManager.setCurrentAccountContext({
                    id: matchedSummary?.id ?? liveLs.email,
                    email: liveLs.email,
                  });
                }
                const matchedSaved = matchedSummary ? await accountsManager.getAccount(matchedSummary.id) : null;
                if (matchedSaved) {
                  activeAccountEmail = matchedSaved.email;
                  const liveQuotaForMatched = liveLs?.email?.toLowerCase() === detectedEmail.toLowerCase() ? liveLs.quota : null;
                  scheduleExpiredQuotaCorrection(matchedSaved.id, liveQuotaForMatched, statusNowMs);
                  const localMerged = mergeLiveQuotaWithSaved(matchedSaved.quota, liveQuotaForMatched, statusNowMs) ?? null;
                  const fused = fuseAccountQuotaAcrossEnvironments({
                    email: matchedSaved.email,
                    savedQuota: matchedSaved.quota,
                    liveLocalQuota: liveQuotaForMatched,
                    remoteSessions: remoteCandidatesForStatus,
                    nowMs: statusNowMs,
                  });
                  const q = accountsManager.getAccountQuotaOverview({ ...matchedSaved, quota: fused.quota }, { nowMs: statusNowMs });
                  activeFiveHourQuota = q.fiveHourRemaining;
                  activeSubscriptionTier = normalizeSubscriptionTier(q.subscriptionTier);
                  cachedLocalAccountSnapshot = {
                    email: matchedSaved.email,
                    name: matchedSaved.name || liveLs?.name || '',
                    tier: activeSubscriptionTier,
                    quota: localMerged,
                    observedAtSec: localMerged?.last_updated ?? null,
                    lastError: cleanAndLocalizeRefreshError(matchedSaved.quota_refresh_error) ?? '',
                  };
                } else if (liveLs?.email) {
                  activeAccountEmail = liveLs.email;
                  scheduleExpiredQuotaCorrection(null, liveLs.quota);
                  const fused = fuseAccountQuotaAcrossEnvironments({
                    email: liveLs.email,
                    savedQuota: null,
                    liveLocalQuota: liveLs.quota,
                    remoteSessions: remoteCandidatesForStatus,
                    nowMs: statusNowMs,
                  });
                  const q = accountsManager.getAccountQuotaOverview({ quota: fused.quota ?? liveLs.quota }, { nowMs: statusNowMs });
                  activeFiveHourQuota = q.fiveHourRemaining;
                  activeSubscriptionTier = resolveUnsavedLiveSubscriptionTier(liveLs, q);
                  cachedLocalAccountSnapshot = {
                    email: liveLs.email,
                    name: liveLs.name ?? '',
                    tier: activeSubscriptionTier,
                    quota: liveLs.quota ?? null,
                    observedAtSec: liveLs.quota?.last_updated ?? null,
                    lastError: '',
                  };
                }
              } else if (listRes.active_account) {
                usageManager.setCurrentAccountContext(undefined);
                activeAccountEmail = listRes.active_account.email;
                const fused = fuseAccountQuotaAcrossEnvironments({
                  email: listRes.active_account.email,
                  savedQuota: listRes.active_account.quota,
                  liveLocalQuota: null,
                  remoteSessions: remoteCandidatesForStatus,
                  nowMs: statusNowMs,
                });
                const q = accountsManager.getAccountQuotaOverview({ ...listRes.active_account, quota: fused.quota }, { nowMs: statusNowMs });
                activeFiveHourQuota = q.fiveHourRemaining;
                activeSubscriptionTier = normalizeSubscriptionTier(q.subscriptionTier);
                cachedLocalAccountSnapshot = {
                  email: listRes.active_account.email,
                  name: listRes.active_account.name ?? '',
                  tier: activeSubscriptionTier,
                  quota: listRes.active_account.quota ?? null,
                  observedAtSec: listRes.active_account.quota?.last_updated ?? null,
                  lastError: cleanAndLocalizeRefreshError(listRes.active_account.quota_refresh_error) ?? '',
                };
              } else {
                cachedLocalAccountSnapshot = null;
              }
            } catch {}
          }
          const all = tasks.list(), revision = tasks.revision;
          const installState = detectInstalledChannels(channel);
          await buildRemoteSessionsPayload({ nonBlocking: true }).catch(() => []);
          const envSnapshot = buildUnifiedEnvironmentSnapshot({ nowMs: statusNowMs });
          const snap = controller.snapshot();
          if (parsed.includeTasks !== false && parsed.tasksSince !== revision) ipcMetrics.taskPayloadReplies++;
          reply({
            ok: true,
            status: {
              ...snap,
              remoteSessions: envSnapshot.remoteSessions,
              environments: envSnapshot.environments,
              environmentsRevision: envSnapshot.environmentsRevision,
              remoteSyncRevision: envSnapshot.remoteSyncRevision,
              focusedEnvironmentId: envSnapshot.focusedEnvironmentId,
              oauthClientConfigured: Boolean(getGoogleClientId() && getGoogleClientSecret()),
              applicationChannel: channel, applicationLabel: target.label, accountSwitchSupported: target.supportsAccountSwitch,
              bothApplicationsInstalled: installState.bothInstalled, availableChannels: installState.channels,
              pricingRevision: usageManager.getPricingRevision(),
              ...(parsed.includeAccounts === false ? {} : { activeAccountEmail, activeFiveHourQuota, activeSubscriptionTier, liveAccountEmail, accountsRevision }),
            },
            ipc: { ...ipcMetrics },
            taskRevision: revision,
            runningTasks: all.filter(t => t.state === 'running').length,
            ...(parsed.includeTasks === false || parsed.tasksSince === revision ? {} : { tasks: all })
          });
        })().catch(error => reply({ ok: false, error: sanitizeErrorMessage(error) }));
        return;
      }
      if (command === 'task_list') {ipcMetrics.taskPayloadReplies++; reply({ ok: true, tasks: tasks.list() }); return; }
      if (command === 'task_cancel') { const cancelled = tasks.cancel(parsed.id); reply(cancelled ? { ok: true } : { ok: false, error: bt('main.task_not_cancellable') }); return; }
      if (command === 'stop') { tasks.cancel(); }
      else if (['pause', 'restore'].includes(command)) { cancelRunningDeepScan(); }
      if (command === 'dashboard_summary') {
        (async () => {
        const targetEnvironmentId = typeof parsed.environmentId === 'string' && parsed.environmentId.trim() ? parsed.environmentId.trim() : undefined;
        const counts = store.layerCounts;
        const dictTotal = (counts?.builtin ?? 0) + (counts?.incremental ?? 0) + (counts?.personal ?? 0);
        const livePromise = probeLiveCached().catch(() => null);
        const pricingSyncPromise = Promise.all([
          syncActiveOfficialModelsToUsageManager(),
          syncActiveAccountToUsageManager().catch(() => {}),
        ]);
        const [report, aggregate] = await Promise.all([
          controller.coverageReport(),
          buildDashboardAggregate({
            listAccounts: async () => {
              const liveForDashboard = await livePromise;
              return accountsManager.listAccounts({ liveEmailHint: liveForDashboard?.email ?? null });
            },
            getAutoSwitchConfig: () => accountsManager.getAutoSwitchConfig(),
            probeLiveLanguageServer: () => livePromise,
            getAccount: (id: string) => accountsManager.getAccount(id),
            getAccountQuotaOverview: (account: any, options?: any) => accountsManager.getAccountQuotaOverview(account, options),
            getUsageSummary: () => {
              syncRemoteTargetStateAndMaybeTriggerSync();
              return usageManager.getUsageSummary(false, undefined, targetEnvironmentId);
            },
            getPricingTable: async () => {
              await pricingSyncPromise;
              return usageManager.getActivePricingTable();
            },
            getRemoteSessions: () => toRemoteQuotaCandidates(controller.getRemoteSessionsSnapshot()),
          }),
          buildRemoteSessionsPayload().catch(() => []),
        ]);
        const dashAvailEnvs = Array.isArray(aggregate.usage?.availableEnvironments)
          ? aggregate.usage.availableEnvironments as AvailableEnvironmentUsageOption[]
          : undefined;
        if (aggregate.accounts && typeof aggregate.accounts === 'object' && aggregate.accounts.activeEmail) {
          try {
            const dashNowMs = Date.now();
            const dashNowSec = Math.floor(dashNowMs / 1000);
            const activeEmail = String(aggregate.accounts.activeEmail);
            const activeId = typeof aggregate.accounts.currentAccountId === 'string' && aggregate.accounts.currentAccountId
              ? aggregate.accounts.currentAccountId
              : null;
            const [savedAcc, liveForWeekly] = await Promise.all([
              activeId ? accountsManager.getAccount(activeId).catch(() => null) : Promise.resolve(null),
              livePromise,
            ]);
            const liveMatched = liveForWeekly?.email && liveForWeekly.email.trim().toLowerCase() === activeEmail.trim().toLowerCase()
              ? liveForWeekly
              : null;
            const fusedForWeekly = fuseAccountQuotaAcrossEnvironments({
              email: activeEmail,
              savedQuota: savedAcc?.quota ?? null,
              liveLocalQuota: liveMatched?.quota ?? null,
              remoteSessions: toRemoteQuotaCandidates(controller.getRemoteSessionsSnapshot(dashNowMs)),
              nowMs: dashNowMs,
            });
            const queryRange = computeWeeklyEventQueryRange({
              accounts: [{ email: activeEmail, quota: fusedForWeekly.quota }],
              snapshotStore: weeklySnapshotStore,
              nowSec: dashNowSec,
            });
            const rangeEvents = queryRange
              ? await usageManager.getEventsWithCostsInRange(queryRange.startSec, queryRange.endSec).catch(() => [])
              : [];
            const attr = computeAccountWeeklyAttribution({
              accountId: activeId,
              email: activeEmail,
              name: aggregate.accounts.activeName ?? savedAcc?.name ?? null,
              tier: aggregate.accounts.activeTier ?? undefined,
              quota: fusedForWeekly.quota,
              snapshotStore: weeklySnapshotStore,
              events: rangeEvents,
              nowSec: dashNowSec,
            });
            aggregate.accounts.weeklyAttribution = attr.pools.length > 0 ? attr : null;
          } catch {
            aggregate.accounts.weeklyAttribution = null;
          }
        }
        const envSnapshot = buildUnifiedEnvironmentSnapshot({ availableEnvironments: dashAvailEnvs });
        const snap = controller.snapshot();
        if (aggregate.usage && typeof aggregate.usage === 'object') {
          aggregate.usage.environments = envSnapshot.environments;
          aggregate.usage.environmentsRevision = envSnapshot.environmentsRevision;
          aggregate.usage.remoteSyncRevision = envSnapshot.remoteSyncRevision;
          aggregate.usage.focusedEnvironmentId = envSnapshot.focusedEnvironmentId;
        }
        /* 总览“已覆盖”与覆盖页同源（translated / 已抽取），并带上应用版本与生成时间。 */
        const coverageMetrics = coverageMetricSnapshot(report);

        reply({
          ok: true,
          dictionary: {
            ...counts,
            /* total 保持为“已覆盖词条数”（覆盖页同源 translated），词典条数改用 dictionaryTotal。 */
            total: coverageMetrics.translated,
            dictionaryTotal: dictTotal,
            covered: coverageMetrics.covered,
            translated: coverageMetrics.translated,
            verified: coverageMetrics.verified,
            extracted: coverageMetrics.extracted,
            missing: coverageMetrics.missing,
            review: coverageMetrics.review,
            dynamic: coverageMetrics.dynamic,
            nativeCount: coverageMetrics.native,
            coverageAvailable: coverageMetrics.available,
          },
          /* 无扫描结果时保持 null（不伪造 0 覆盖），有结果才给同源快照。 */
          coverage: report ? coverageMetrics : null,
          accounts: aggregate.accounts,
          usage: aggregate.usage,
          remoteSessions: envSnapshot.remoteSessions,
          environments: envSnapshot.environments,
          environmentsRevision: envSnapshot.environmentsRevision,
          remoteSyncRevision: envSnapshot.remoteSyncRevision,
          focusedEnvironmentId: envSnapshot.focusedEnvironmentId,
          focusedContextKey: snap.focusedContextKey ?? 'local',
          remoteObservedVersion: snap.remoteObservedVersion ?? 0,
          sshWindowsCount: snap.sshWindowsCount ?? 0,
          activeSshHosts: snap.activeSshHosts ?? [],
          /* 局部失败时错误已脱敏，成功段仍返回可用数据，整体保持 ok:true。 */
          accountsError: aggregate.accountsError,
          usageError: aggregate.usageError,
          revision: aggregate.accounts?.revision ?? '',
          generatedAt: new Date().toISOString(),
        });
        })().catch(error => reply({ ok: false, error: sanitizeErrorMessage(error) }));
        return;
      }
      if (command === 'account_list' || command === 'account_get') {
        (async () => {
          if (command === 'account_list') {
            const index = await accountsManager.loadIndex();
            const listNowMs = Date.now();
            const live = await probeLiveCached().catch(() => null);
            const detectedEmail = live?.email ?? await accountsManager.detectCurrentAntigravityEmail({ liveEmailHint: null }).catch(() => null);
            const remoteCandidates = toRemoteQuotaCandidates(controller.getRemoteSessionsSnapshot(listNowMs));
            let effectiveActiveId = index.current_account_id;
            if (detectedEmail) {
              const matched = index.accounts.find(a => a.email.toLowerCase() === detectedEmail.toLowerCase());
              effectiveActiveId = matched?.id ?? null;
            }
            const weeklyMetaById = new Map<string, { accountId: string; email: string; name?: string | null; quota: QuotaData | null }>();
            const accountsWithQuota = await Promise.all(index.accounts.map(async (summary): Promise<Record<string, unknown> & { id: string }> => {
              let saved;
              try { saved = await accountsManager.getAccount(summary.id); }
              catch { return { id: summary.id, email: summary.email, name: summary.name, disabled: true,
                validation_blocked: true, quota: null, quota_refresh_error: bt('main.account_unreadable'),
                credentialReadiness: { state: 'needs_authorization', message: bt('main.account_check_files') } }; }
              if (!saved) return { id: summary.id, email: summary.email, name: summary.name, disabled: true,
                quota: null, quota_refresh_error: bt('main.account_missing'),
                credentialReadiness: { state: 'needs_authorization', message: bt('main.account_check_files') } };
              const isLiveMatched = live?.email?.toLowerCase() === summary.email.toLowerCase() && live.quota;
              if (isLiveMatched) {
                scheduleExpiredQuotaCorrection(summary.id, live.quota, listNowMs);
              }
              const fused = fuseAccountQuotaAcrossEnvironments({
                email: saved.email,
                savedQuota: saved.quota,
                liveLocalQuota: isLiveMatched ? live.quota : null,
                remoteSessions: remoteCandidates,
                nowMs: listNowMs,
              });
              weeklyMetaById.set(saved.id, {
                accountId: saved.id,
                email: saved.email,
                name: saved.name ?? null,
                quota: fused.quota,
              });
              const acc: Account = {
                ...saved,
                quota: fused.quota,
              };
              const projected = projectAccountForIpcNormalized(acc, {
                nowMs: listNowMs,
                isActive: acc.id === effectiveActiveId,
                hasLocalOAuthClient: hasLocalOAuthClientConfigured(),
                includeOverviewFields: true,
                formatResetTime,
                revisionWithReadiness: true,
                persistedQuotaLastUpdated: saved.quota?.last_updated ?? 0,
                quotaSourceEnvironmentId: fused.quotaSourceEnvironmentId,
                activeRemoteEnvIds: fused.activeRemoteEnvIds,
              });
              return { id: acc.id, ...(projected ?? {}) };
            }));
            accountsWithQuota.sort((a, b) => {
              const aActive = a.id === effectiveActiveId ? 1 : 0;
              const bActive = b.id === effectiveActiveId ? 1 : 0;
              return bActive - aActive;
            });
            try {
              const listNowSec = Math.floor(listNowMs / 1000);
              const queryRange = computeWeeklyEventQueryRange({
                accounts: [...weeklyMetaById.values()],
                snapshotStore: weeklySnapshotStore,
                nowSec: listNowSec,
              });
              const sharedEvents = queryRange
                ? await usageManager.getEventsWithCostsInRange(queryRange.startSec, queryRange.endSec).catch(() => [])
                : [];
              for (const item of accountsWithQuota) {
                const meta = weeklyMetaById.get(item.id);
                if (!meta) {
                  item.weeklyAttribution = null;
                  continue;
                }
                try {
                  const attr = computeAccountWeeklyAttribution({
                    accountId: meta.accountId,
                    email: meta.email,
                    name: meta.name ?? null,
                    quota: meta.quota,
                    snapshotStore: weeklySnapshotStore,
                    events: sharedEvents,
                    nowSec: listNowSec,
                  });
                  item.weeklyAttribution = attr.pools.length > 0 ? attr : null;
                } catch {
                  item.weeklyAttribution = null;
                }
              }
            } catch {
              for (const item of accountsWithQuota) {
                item.weeklyAttribution = null;
              }
            }
            const recovery = await switchService.recoveryInfo().catch(() => ({ available: true, pending: true, status: 'unreadable' }));
            const pendingSwitch = 'pending' in recovery && recovery.pending === true;
            reply({
              ok: true,
              activeId: effectiveActiveId,
              currentAccountId: effectiveActiveId,
              identityState: live?.email ? 'verified' : 'configured',
              accounts: accountsWithQuota,
              targetIde: index.current_target_ide,
              pendingSwitch,
              recovery,
            });
            return;
          }
          if (command === 'account_get') {
            const getNowMs = Date.now();
            const acc = await accountsManager.getAccount(parsed.id);
            const identity = await resolveActiveIdentityForIpc();
            const remoteCandidates = toRemoteQuotaCandidates(controller.getRemoteSessionsSnapshot(getNowMs));
            const isActive = isIdentityActiveAccount(identity, acc);
            const fused = acc
              ? fuseAccountQuotaAcrossEnvironments({
                  email: acc.email,
                  savedQuota: acc.quota,
                  liveLocalQuota: null,
                  remoteSessions: remoteCandidates,
                  nowMs: getNowMs,
                })
              : null;
            const fusedAcc = acc && fused ? { ...acc, quota: fused.quota } : acc;
            reply({
              ok: !!acc,
              account: projectAccountForIpcNormalized(fusedAcc, {
                nowMs: getNowMs,
                isActive,
                hasLocalOAuthClient: hasLocalOAuthClientConfigured(),
                ...(fused ? { quotaSourceEnvironmentId: fused.quotaSourceEnvironmentId, activeRemoteEnvIds: fused.activeRemoteEnvIds } : {}),
              }),
            });
            return;
          }
        })().catch(error => reply({ ok: false, error: sanitizeErrorMessage(error) }));
        return;
      }
      if (command === 'account_switch_preflight') {
        (async () => {
          let uiRunning = false;
          let insidersRunning = false;
          let detachedDaemons: Array<{ pid: number; kind: DetachedDaemonKind }> = [];
          let detachedDaemonKinds: DetachedDaemonKind[] = [];
          let hasRunningTask = false;
          let taskReason = '';
          let maxLsCpu = 0;
          try {
            if (isWindows()) {
              const stableRoots = new Set<string>([target.appPath]);
              const insidersRoots = new Set<string>();
              for (const dir of defaultAntigravityInstallDirs()) {
                stableRoots.add(join(dir, 'Antigravity'));
                insidersRoots.add(join(dir, 'Antigravity - Insiders'));
                insidersRoots.add(join(dir, 'Antigravity Insiders'));
                insidersRoots.add(join(dir, 'Antigravity-Insiders'));
              }
              const procs = await appProcesses([...stableRoots, ...insidersRoots]);
              const classified = classifyWindowsProcesses(procs, target.appPath);
              uiRunning = classified.uiRunning;
              insidersRunning = classified.insidersRunning;
              detachedDaemons = classified.detachedDaemons.map(d => ({ pid: d.pid, kind: d.kind }));
              detachedDaemonKinds = classified.detachedDaemonKinds;
            } else {
              const classified = await sampleAntigravityProcesses({
                appPath: target.appPath,
                checkInsiders: true,
                insidersPrefix: '/Applications/Antigravity - Insiders.app/Contents/',
              });
              uiRunning = classified.uiRunning;
              insidersRunning = classified.insidersRunning;
              detachedDaemons = classified.detachedDaemons.map(d => ({ pid: d.pid, kind: d.kind }));
              detachedDaemonKinds = classified.detachedDaemonKinds;
              maxLsCpu = classified.maxLsCpu;
            }
          } catch {}
          const stableRunning = uiRunning;
          const appRunning = uiRunning || insidersRunning;
          const detachedDaemonCount = detachedDaemons.length;
          const detachedDaemonPids = detachedDaemons.map(d => d.pid);
          let cdpChecked = false;
          if (uiRunning) {
            const cdpState = await controller.hasRunningAgentTask().catch(() => ({ busy: false, checked: false, reason: '' }));
            cdpChecked = cdpState.checked === true;
            if (cdpState.busy) {
              hasRunningTask = true;
              taskReason = cdpState.reason || bt('main.task.active_inference');
            }
          }
          // Only fall back to active trajectory write + high LS CPU when CDP is not connected to any page.
          if ((uiRunning || detachedDaemonKinds.includes('language_server')) && !cdpChecked && !hasRunningTask && maxLsCpu >= 20.0) {
            try {
              const nowMs = Date.now();
              const allowedDataDirs = new Set<string>(ALLOWED_DATA_DIRECTORY_NAMES);
              const entries = await readdir(geminiDir, { withFileTypes: true }).catch(() => [] as any[]);
              for (const entry of entries) {
                if (!entry.isDirectory() || !allowedDataDirs.has(entry.name)) continue;
                const convDir = join(geminiDir, entry.name, 'conversations');
                const dirSt = await lstat(convDir).catch(() => null);
                if (!dirSt) continue;
                const files = (await readdir(convDir).catch(() => [] as string[])).filter(f => f.endsWith('.pb'));
                for (let i = 0; i < files.length; i += 32) {
                  const stats = await Promise.all(files.slice(i, i + 32).map(f => lstat(join(convDir, f)).catch(() => null)));
                  if (stats.some(st => st && nowMs - st.mtimeMs < 3000)) {
                    hasRunningTask = true;
                    taskReason = bt('main.task.active_session');
                    break;
                  }
                }
                if (hasRunningTask) break;
              }
            } catch {}
          }
          const sshSummary = controller.getActiveSshWindowsSummary();
          reply({
            ok: true,
            appRunning,
            stableRunning,
            uiRunning,
            insidersRunning,
            detachedDaemonCount,
            detachedDaemonKinds,
            detachedDaemonPids,
            safe: !hasRunningTask,
            state: hasRunningTask ? 'busy' : 'safe',
            hasRunningTask,
            taskReason,
            activeSshWindowsCount: sshSummary.count,
            activeSshHosts: sshSummary.hosts,
          });
        })().catch(error => reply({ ok: false, state: 'unknown', error: sanitizeErrorMessage(error) }));
        return;
      }
      // 只读及自管理锁的配额刷新命令直接并发响应，不阻塞在全局写锁 commandChain 队列后
      const isReadOnlyAutoSwitch = command === 'auto_switch_best' && parsed.execute !== true;
      if (['proxy_get', 'maintenance_scan', 'maintenance_history', 'account_recovery_info', 'auto_switch_get', 'usage_snapshot_release', 'usage_events', 'usage_summary', 'usage_ledger_review', 'api_pricing_get', 'pricing_sync_status', 'quota_refresh', 'quota_refresh_start', 'remote_quota_refresh', 'weekly_quota_usage'].includes(command) || isReadOnlyAutoSwitch) {
        (async () => {
          if (command === 'proxy_get') {
            const resolved = await resolveEffectiveProxy({ forceRefreshSystem: parsed.force === true });
            reply({
              ok: true,
              proxy: {
                mode: resolved.mode,
                manualUrl: redactProxyUrl(resolved.manualUrl) ?? '',
                effectiveUrl: redactProxyUrl(resolved.effectiveUrl),
                source: resolved.source,
              },
            });
            return;
          }
          if (command === 'remote_quota_refresh') {
            const remoteKey = typeof parsed.remoteKey === 'string' && parsed.remoteKey.trim()
              ? parsed.remoteKey.trim()
              : undefined;
            const environmentId = typeof parsed.environmentId === 'string' && parsed.environmentId.trim()
              ? parsed.environmentId.trim()
              : undefined;
            await buildRemoteSessionsPayload({ force: true, remoteKey, environmentId });
            if (!fixture && controller.getConnectedRemoteRpcTargets().length > 0) {
              remoteSyncCoordinator.triggerSync();
            }
            const envSnapshot = buildUnifiedEnvironmentSnapshot();
            const snap = controller.snapshot();
            onStatus(snap);
            reply({
              ok: true,
              remoteSessions: envSnapshot.remoteSessions,
              environments: envSnapshot.environments,
              environmentsRevision: envSnapshot.environmentsRevision,
              remoteSyncRevision: envSnapshot.remoteSyncRevision,
              focusedEnvironmentId: envSnapshot.focusedEnvironmentId,
              remoteObservedVersion: snap.remoteObservedVersion ?? 0,
              focusedContextKey: snap.focusedContextKey ?? 'local',
            });
            return;
          }
          if (command === 'quota_refresh_start') {
            const taskId = startQuotaRefreshTask();
            reply({ ok: true, taskId });
            return;
          }
          if (command === 'quota_refresh') {
            const refreshNowMs = Date.now();
            const hasLocalOAuthClient = hasLocalOAuthClientConfigured();
            const identity = await resolveActiveIdentityForIpc();
            const index = await accountsManager.loadIndex().catch(() => null);
            const targetId = typeof parsed.id === 'string' && parsed.id ? parsed.id : (index?.current_account_id ?? null);
            const targetAcc = targetId ? await accountsManager.getAccount(targetId).catch(() => null) : null;
            const targetIsLocalActive = isIdentityActiveAccount(identity, targetAcc);
            const remoteRefreshReply = await refreshStandbyAccountViaRemoteSsh({
              targetAcc,
              targetIsLocalActive,
              hasLocalOAuthClient,
              nowMs: refreshNowMs,
              getRemoteSessionsSnapshot: ms => controller.getRemoteSessionsSnapshot(ms),
              probeRemoteByEnvironmentId: environmentId => buildRemoteSessionsPayload({ force: true, environmentId }),
              syncRemoteObservedQuota: (accountId, quota, tier) => accountsManager.syncRemoteObservedQuota(accountId, quota, tier),
              getAccount: accountId => accountsManager.getAccount(accountId),
              toRemoteCandidates: toRemoteQuotaCandidates,
              getAccountQuotaOverview: (acc, opts) => accountsManager.getAccountQuotaOverview(acc, opts),
              projectAccount: (acc, opts) => projectAccountForIpcNormalized(acc, { ...opts, formatResetTime }),
              buildEnvironmentSnapshot: opts => buildUnifiedEnvironmentSnapshot(opts),
              publishSnapshot: () => onStatus(controller.snapshot()),
              readOkMessage: bt('main.quota.read_ok'),
            });
            if (remoteRefreshReply) {
              reply(remoteRefreshReply);
              return;
            }
            try {
              const acc = await accountsManager.refreshQuota(parsed.id);
              if (acc.quota?.models?.length) {
                registerObservedModelsFromSource(acc.quota.models);
              }
              if (acc.email && acc.quota) {
                recordWeeklySnapshotSafe({
                  email: acc.email,
                  quota: acc.quota,
                  source: acc.quota.source ?? 'cloud',
                  observedAtSec: acc.quota.last_updated,
                  tier: acc.quota.subscription_tier,
                });
              }
              const overview = accountsManager.getAccountQuotaOverview(acc, { nowMs: refreshNowMs });
              const projected = projectAccountForIpcNormalized(acc, {
                overview,
                nowMs: refreshNowMs,
                isActive: isIdentityActiveAccount(identity, acc),
                hasLocalOAuthClient,
                includeOverviewFields: true,
                formatResetTime,
                revisionWithReadiness: true,
              });
              const partial = acc.quota?.refresh_state?.complete === false || !!projected?.quota_refresh_error;
              reply({ ok: true, partial, message: partial ? bt('main.quota.read_partial') : bt('main.quota.read_ok'),
                quota: acc.quota ? (projected?.quota ?? null) : acc.quota, account: projected, subscription_tier: normalizeSubscriptionTier(projected?.subscription_tier) });
              return;
            } catch (err) {
              if (
                accountErrorCode(err) === 'missing_oauth_client'
                && err instanceof Error
                && err.message !== bt('account_cloud.err.missing_oauth_client_active_live')
              ) {
                const acc = targetId ? await accountsManager.getAccount(targetId).catch(() => null) : null;
                const overview = acc ? accountsManager.getAccountQuotaOverview(acc, { nowMs: refreshNowMs }) : undefined;
                const projected = acc ? projectAccountForIpcNormalized(acc, {
                  overview,
                  nowMs: refreshNowMs,
                  isActive: false,
                  hasLocalOAuthClient,
                  includeOverviewFields: true,
                  formatResetTime,
                  revisionWithReadiness: true,
                }) : null;
                reply({
                  ok: true,
                  partial: false,
                  standbyDeferred: true,
                  notice: err.message,
                  message: err.message,
                  quota: acc?.quota ? (projected?.quota ?? null) : (acc?.quota ?? null),
                  account: projected,
                  subscription_tier: normalizeSubscriptionTier(projected?.subscription_tier),
                });
                return;
              }
              throw err;
            }
          }
          if (command === 'pricing_sync_status') { await syncActiveOfficialModelsToUsageManager(); reply({ ok: true, status: await usageManager.getPricingSyncStatus() }); return; }
          if (command === 'usage_ledger_review') { reply({ ok: true, review: await usageManager.ledgerReview() }); return; }
          if (command === 'maintenance_scan') { reply(await cacheMaintenance.scan({ retentionDays: parsed.retentionDays })); return; }
          if (command === 'maintenance_history') { reply({ ok: true, snapshots: await cacheMaintenance.history() }); return; }
          if (command === 'account_recovery_info') { reply({ ok: true, ...await switchService.recoveryInfo() }); return; }
          if (command === 'auto_switch_get') { reply({ ok: true, config: await accountsManager.getAutoSwitchConfig() }); return; }
          if (isReadOnlyAutoSwitch) {
            const best = await recommendationPreview(parsed.config, true);
            if (!best) { reply({ ok: true, currentAccount: null, bestCandidate: null, account: null, shouldSwitch: false, executed: false, preview: true, reason: bt('main.auto_switch.save_current_first') }); return; }
            const hasLocalOAuthClient = hasLocalOAuthClientConfigured();
            const previewNowMs = Date.now();
            const projected = {
              currentAccount: projectAccountForIpcNormalized(best.currentAccount, { isActive: true, hasLocalOAuthClient, nowMs: previewNowMs }),
              bestCandidate: projectAccountForIpcNormalized(best.bestCandidate, { isActive: false, hasLocalOAuthClient, nowMs: previewNowMs }),
              shouldSwitch: best.shouldSwitch,
              reason: best.reason,
            };
            reply({ ok: true, ...projected, account: projected.bestCandidate, executed: false, preview: true, message: best.reason });
            return;
          }
          if (command === 'usage_snapshot_release') { usageManager.releaseSnapshot(String(parsed.snapshotId ?? '')); reply({ ok: true }); return; }
          if (command === 'usage_events') {
            const period = ['today', '7d', '30d', 'all'].includes(String(parsed.period)) ? String(parsed.period) : 'today';
            const force = Boolean(parsed.force);
            const targetAccountId = typeof parsed.accountId === 'string' && parsed.accountId ? parsed.accountId : undefined;
            const targetEnvironmentId = typeof parsed.environmentId === 'string' && parsed.environmentId ? parsed.environmentId : undefined;
            await syncActiveAccountToUsageManager().catch(() => {});
            if (force) {
              await runBoundedRemoteSyncForDemand(6_000);
            } else {
              syncRemoteTargetStateAndMaybeTriggerSync();
            }
            reply({
              ok: true,
              ...await usageManager.getUsageEvents(
                period,
                String(parsed.query ?? ''),
                Number(parsed.offset),
                Number(parsed.limit),
                typeof parsed.snapshotId === 'string' ? parsed.snapshotId : undefined,
                parsed.pinSnapshot === true,
                force,
                targetAccountId,
                targetEnvironmentId
              ),
            });
            return;
          }
          if (command === 'usage_summary') {
            const force = Boolean(parsed.force);
            const targetAccountId = typeof parsed.accountId === 'string' && parsed.accountId ? parsed.accountId : undefined;
            const targetEnvironmentId = typeof parsed.environmentId === 'string' && parsed.environmentId ? parsed.environmentId : undefined;
            await syncActiveAccountToUsageManager().catch(() => {});
            if (force) {
              await runBoundedRemoteSyncForDemand(6_000);
            } else {
              syncRemoteTargetStateAndMaybeTriggerSync();
            }
            const usage = await usageManager.getUsageSummary(force, targetAccountId, targetEnvironmentId);
            if (usage.generated_at && usage.generated_at > 0) {
              cachedLocalUsageSyncedAtSec = usage.generated_at;
            }
            const envSnapshot = buildUnifiedEnvironmentSnapshot({
              availableEnvironments: usage.available_environments,
            });
            reply(
              projectUsagePeriodSummary(usage, parsed.period, {
                includeAllPeriods:
                  (!targetAccountId || targetAccountId === 'all') &&
                  (!targetEnvironmentId || targetEnvironmentId === 'all'),
                environmentsSnapshot: envSnapshot,
              })
            );
            return;
          }
          if (command === 'api_pricing_get') {
            const catalogPayload = await buildPricingCatalogPayload();
            reply({
              ok: true,
              ...catalogPayload,
              status: await usageManager.getPricingSyncStatus(),
            });
            return;
          }
          if (command === 'weekly_quota_usage') {
            const targetAccountId = typeof parsed.accountId === 'string' && parsed.accountId.trim()
              ? parsed.accountId.trim()
              : undefined;
            await syncActiveAccountToUsageManager().catch(() => {});
            await usageManager.getUsageSummary(false).catch(() => {});
            const nowMs = Date.now();
            const nowSec = Math.floor(nowMs / 1000);
            const [index, live] = await Promise.all([
              accountsManager.loadIndex().catch(() => null),
              probeLiveCached().catch(() => null),
            ]);
            const detectedEmail = live?.email ?? await accountsManager.detectCurrentAntigravityEmail({ liveEmailHint: null }).catch(() => null);
            const detectedEmailLower = detectedEmail ? detectedEmail.trim().toLowerCase() : null;
            const remoteCandidates = toRemoteQuotaCandidates(controller.getRemoteSessionsSnapshot(nowMs));
            const isAll = !targetAccountId || targetAccountId === 'all';
            const targetLower = targetAccountId ? targetAccountId.toLowerCase() : '';

            interface WeeklyCandidateAccount {
              accountId: string | null;
              email: string;
              name?: string | null;
              quota: QuotaData | null;
              isActive: boolean;
            }
            const candidates: WeeklyCandidateAccount[] = [];
            const coveredEmails = new Set<string>();

            for (const summary of index?.accounts ?? []) {
              const saved = await accountsManager.getAccount(summary.id).catch(() => null);
              if (!saved) continue;
              const emailLower = saved.email.trim().toLowerCase();
              const isActive = detectedEmailLower
                ? emailLower === detectedEmailLower
                : saved.id === index?.current_account_id;
              if (!isAll && saved.id !== targetAccountId && emailLower !== targetLower) {
                continue;
              }
              const isLiveMatched = Boolean(live?.email && live.email.trim().toLowerCase() === emailLower && live.quota);
              const fused = fuseAccountQuotaAcrossEnvironments({
                email: saved.email,
                savedQuota: saved.quota,
                liveLocalQuota: isLiveMatched ? live!.quota : null,
                remoteSessions: remoteCandidates,
                nowMs,
              });
              coveredEmails.add(emailLower);
              candidates.push({
                accountId: saved.id,
                email: saved.email,
                name: saved.name ?? null,
                quota: fused.quota,
                isActive,
              });
            }

            if (live?.email) {
              const liveLower = live.email.trim().toLowerCase();
              if (!coveredEmails.has(liveLower) && (isAll || liveLower === targetLower)) {
                const fused = fuseAccountQuotaAcrossEnvironments({
                  email: live.email,
                  savedQuota: null,
                  liveLocalQuota: live.quota,
                  remoteSessions: remoteCandidates,
                  nowMs,
                });
                coveredEmails.add(liveLower);
                candidates.push({
                  accountId: null,
                  email: live.email,
                  name: live.name ?? null,
                  quota: fused.quota,
                  isActive: true,
                });
              }
            }

            for (const snapEmail of weeklySnapshotStore.listEmails()) {
              const snapLower = snapEmail.trim().toLowerCase();
              if (!snapLower || coveredEmails.has(snapLower)) continue;
              if (!isAll && snapLower !== targetLower) continue;
              const fused = fuseAccountQuotaAcrossEnvironments({
                email: snapEmail,
                savedQuota: null,
                liveLocalQuota: null,
                remoteSessions: remoteCandidates,
                nowMs,
              });
              coveredEmails.add(snapLower);
              candidates.push({
                accountId: null,
                email: snapEmail,
                name: null,
                quota: fused.quota,
                isActive: Boolean(detectedEmailLower && snapLower === detectedEmailLower),
              });
            }

            candidates.sort((a, b) => (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0));

            const queryRange = computeWeeklyEventQueryRange({
              accounts: candidates,
              snapshotStore: weeklySnapshotStore,
              nowSec,
            });
            const rangeEvents = queryRange
              ? await usageManager.getEventsWithCostsInRange(queryRange.startSec, queryRange.endSec).catch(() => [])
              : [];

            const accounts: AccountWeeklyAttribution[] = [];
            for (const cand of candidates) {
              const attr = computeAccountWeeklyAttribution({
                accountId: cand.accountId,
                email: cand.email,
                name: cand.name ?? null,
                quota: cand.quota,
                snapshotStore: weeklySnapshotStore,
                events: rangeEvents,
                nowSec,
              });
              if (attr.pools.length > 0) {
                accounts.push(attr);
              }
            }

            reply({
              ok: true,
              generatedAtSec: nowSec,
              accounts,
            });
            return;
          }
        })().catch(error => reply({ ok: false, error: sanitizeErrorMessage(error) }));
        return;
      }
      commandChain = commandChain.catch(() => {}).then(async () => {
        try {
          if (stopping && command !== 'stop') {
            reply({ ok: false, error: bt('main.assistant_not_running') });
            return;
          }
          if(command==='shortcut_set'){if(!fixture)throw new Error(bt('main.shortcut_removed'));await controller.configureShortcut(parsed.enabled===true);reply({ok:true});return;}
          if(command==='api_pricing_revalue_preview'){reply({ok:true,preview:await usageManager.previewRevalueHistory(parsed.mode === 'unpriced_only' ? 'unpriced_only' : 'force_all')});return;}
          if(command==='api_pricing_revalue'){const mode = parsed.mode === 'unpriced_only' ? 'unpriced_only' : 'force_all';reply({ok:true,...await usageManager.revalueHistory(parsed.confirm===true, { mode, previewId: typeof parsed.previewId === 'string' ? parsed.previewId : undefined })});return;}
          if(command==='api_pricing_revalue_rollback'){reply({ok:true,...await usageManager.restoreRevalueHistory(String(parsed.previewId ?? ''),parsed.confirm===true)});return;}
          if(command==='pricing_sync_set'){await atomicJson(join(stateDir, 'pricing-preferences.json'), {enabled:parsed.enabled===true});usageManager.setAutoRemotePricingSync(parsed.enabled===true);if(parsed.enabled===true)maybeScheduleAutoPricingSync('enabled');reply({ok:true});return;}
          if(command==='pricing_sync_check'){
            if(parsed.feedUrl!==undefined&&typeof parsed.feedUrl!=='string')throw new Error(bt('main.pricing_feed_invalid'));
            const res=await usageManager.syncRemotePricing(parsed.feedUrl,true);
            const catalogPayload=await buildPricingCatalogPayload();
            reply({ok:true,...res,...catalogPayload,status:await usageManager.getPricingSyncStatus()});
            return;
          }
          if (command === 'proxy_set') {
            setRuntimeProxyConfig({
              mode: parsed.mode,
              ...(parsed.manualUrl !== undefined ? { manualUrl: parsed.manualUrl } : {}),
            });
            const resolved = await resolveEffectiveProxy({ forceRefreshSystem: true });
            reply({
              ok: true,
              proxy: {
                mode: resolved.mode,
                manualUrl: redactProxyUrl(resolved.manualUrl) ?? '',
                effectiveUrl: redactProxyUrl(resolved.effectiveUrl),
                source: resolved.source,
              },
            });
            return;
          }
          if(command==='hud_set'){const nextHud=parsed.enabled!==false;await saveRuntimePreferences({hudEnabled:nextHud});await controller.configureHud(nextHud);await writeChain.catch(()=>{});reply({ok:true,status:controller.snapshot()});return;}
          if(command==='maintenance_smart_clear'){reply(await cacheMaintenance.smartClear({scopes:parsed.scopes,retentionDays:parsed.retentionDays,keepLocalSnapshots:parsed.keepLocalSnapshots}));return;}
          if(command==='maintenance_clear'){reply(await cacheMaintenance.clear(parsed.token, parsed.selectedNames));return;}
          if(command==='maintenance_restore'){reply(await cacheMaintenance.restore(parsed.snapshotId ?? parsed.id));return;}
          if(command==='maintenance_preflight'){if(tasks.list().some(t=>t.state==='running'))throw new Error(bt('main.preflight_task_running'));if(await cacheMaintenance.hasRunningConversation())throw new Error(bt('main.preflight_agent_running'));reply(await controller.maintenancePreflight());return;}
          if(command==='metadata_scan_start'){const taskId=tasks.begin('deep-scan',bt('main.task.deep_scan_title'),async(signal,_progress,commit)=>controller.metadataScan(signal,parsed.nativeMenus,commit));reply({ok:true,taskId});return;}
          if (command === 'account_save_current') {
            const acc = await accountsManager.saveCurrentAccount({ homeDir, appSupportDir });
            reply({
              ok: true,
              account: projectAccountForIpcNormalized(acc, {
                isActive: true,
                hasLocalOAuthClient: hasLocalOAuthClientConfigured(),
              }),
            });
            return;
          }
          if (command === 'account_import_json') {
            const res = await accountsManager.importAccountsFromJson(parsed.paths ?? parsed.files);
            await syncActiveAccountToUsageManager(true).catch(() => {});
            reply({
              ok: true,
              imported: res.imported,
              updated: res.updated,
              skipped: res.skipped,
              expiredWithoutRefreshConfig: res.expiredWithoutRefreshConfig,
            });
            return;
          }
          if (command === 'account_export_backup') {
            const res = await accountsManager.exportAccountsBackup(String(parsed.path ?? ''), parsed.confirmed === true);
            reply({ ok: true, path: res.path, count: res.count });
            return;
          }
          if (command === 'account_upsert') {
            const acc = await accountsManager.upsertAccount(parsed.data ?? parsed.account ?? parsed);
            const identity = await resolveActiveIdentityForIpc();
            const isActive = isIdentityActiveAccount(identity, acc);
            reply({
              ok: true,
              account: projectAccountForIpcNormalized(acc, {
                isActive,
                hasLocalOAuthClient: hasLocalOAuthClientConfigured(),
              }),
            });
            return;
          }
          if (command === 'account_rename') {
            const acc = await accountsManager.renameAccount(String(parsed.id ?? ''), parsed.name);
            const identity = await resolveActiveIdentityForIpc();
            const isActive = isIdentityActiveAccount(identity, acc);
            reply({
              ok: true,
              account: projectAccountForIpcNormalized(acc, {
                isActive,
                hasLocalOAuthClient: hasLocalOAuthClientConfigured(),
              }),
            }); return;
          }
          if (command === 'account_delete') {
            await accountsManager.deleteAccount(parsed.id);
            reply({ ok: true });
            return;
          }
          if (command === 'account_reorder') {
            if (!Array.isArray(parsed.ids) || parsed.ids.some((item: unknown) => typeof item !== 'string')) {
              throw new Error(bt('main.request_invalid_format'));
            }
            const index = await accountsManager.reorderAccounts(parsed.ids);
            const identity = await resolveActiveIdentityForIpc();
            const hasLocalOAuthClient = hasLocalOAuthClientConfigured();
            const reordered = await Promise.all(index.accounts.map(async summary => {
              const saved = await accountsManager.getAccount(summary.id).catch(() => null);
              const targetAcc = saved ?? summary;
              const isActive = isIdentityActiveAccount(identity, targetAcc);
              return projectAccountForIpcNormalized(targetAcc, { isActive, hasLocalOAuthClient });
            }));
            reply({ ok: true, accounts: reordered });
            return;
          }
          if (command === 'account_switch') {
            const targetId = String(parsed.id || '');
            if (parsed.autoRefreshToken === true && targetId) {
              const existing = await accountsManager.getAccount(targetId);
              if (existing && !existing.disabled && !existing.validation_blocked && existing.token?.refresh_token) {
                const nowSec = Date.now() / 1000;
                if (!existing.token.access_token || existing.token.access_token === 'pending_refresh' || existing.token.expiry_timestamp <= nowSec + 60) {
                  await accountsManager.refreshQuota(targetId).catch(() => {});
                }
              }
            }
            await usageManager.captureCurrentActiveSessions().catch(() => {});
            const result = await switchService.switchAccount(targetId, parsed.target || 'all');
            await syncActiveAccountToUsageManager(true).catch(() => {});
            usageManager.invalidateCache();
            reply({ ok: true, ...result }); return;
          }
          if(command==='account_recovery_clear'){if(parsed.confirm!==true)throw new Error(bt('main.recovery_clear_confirm'));reply({ok:true,...await switchService.clearRecovery(String(parsed.digest))});return;}
          if (command === 'account_switch_rollback') {
            const result = await switchService.rollback();
            await syncActiveAccountToUsageManager(true).catch(() => {});
            usageManager.invalidateCache();
            reply({ ok: true, ...result }); return;
          }
          if (command === 'account_oauth_begin') { reply({ ok: true, ...await accountLogin.begin() }); return; }
          if (command === 'account_oauth_status') { reply({ ok: true, ...accountLogin.status(String(parsed.id || '')) }); return; }
          if (command === 'account_oauth_cancel') { reply({ ok: true, ...accountLogin.cancel(String(parsed.id || '')) }); return; }
          if (command === 'account_add_token_start') {
            const refreshToken = String(parsed.refreshToken || '');
            const taskId = tasks.begin('account-add', bt('main.task.account_add_title'), async (_signal, _progress, commit) => {
              commit();
              const acc = await accountsManager.addAccountWithRefreshToken(refreshToken);
              return { ok: true, message: bt('main.task.account_add_done', { email: acc.email }) };
            });
            reply({ ok: true, taskId }); return;
          }

          // ---- 备用账号推荐与配额 IPC ----
          if (command === 'auto_switch_set') {
            reply({ ok: true, config: await accountsManager.setAutoSwitchConfig(parsed.config ?? {}) });
            return;
          }
          if (command === 'auto_switch_best' || command === 'auto_switch_execute') {
            // 只读推荐是默认语义：preview 或不带 execute 时绝不执行切号。
            const wantsExecute = command === 'auto_switch_execute' || parsed.execute === true;
            const confirmed = parsed.confirmed === true;
            if (wantsExecute && !confirmed) throw new Error(bt('main.auto_switch.confirm_required'));
            const best = await recommendationPreview(parsed.config, false);
            if (!best) { reply({ ok: true, currentAccount: null, bestCandidate: null, account: null, shouldSwitch: false, executed: false, preview: true, reason: bt('main.auto_switch.save_current_first') }); return; }
            const hasLocalOAuthClient = hasLocalOAuthClientConfigured();
            const autoNowMs = Date.now();
            const projected = {
              currentAccount: projectAccountForIpcNormalized(best.currentAccount, { isActive: true, hasLocalOAuthClient, nowMs: autoNowMs }),
              bestCandidate: projectAccountForIpcNormalized(best.bestCandidate, { isActive: false, hasLocalOAuthClient, nowMs: autoNowMs }),
              shouldSwitch: best.shouldSwitch,
              reason: best.reason,
            };
            if (wantsExecute && best.shouldSwitch && best.bestCandidate) {
              await usageManager.captureCurrentActiveSessions().catch(() => {});
              const result = await switchService.switchAccount(best.bestCandidate.id, 'all');
              await syncActiveAccountToUsageManager(true).catch(() => {});
              usageManager.invalidateCache();
              reply({ ok: true, ...projected, account: projected.bestCandidate, executed: true, preview: false,
                switchResult: { switchedTo: result.switchedTo, message: result.message }, message: best.reason });
              return;
            }
            reply({ ok: true, ...projected, account: projected.bestCandidate, executed: false, preview: true,
              message: best.reason, ...(wantsExecute ? { skipReason: bt('main.auto_switch.no_need') } : {}) });
            return;
          }

          if (command === 'quota_refresh_all') {
            const result = await accountsManager.refreshAllQuotas();
            for (const refreshed of result.accounts) {
              if (refreshed.quota?.models?.length) {
                registerObservedModelsFromSource(refreshed.quota.models);
              }
              if (refreshed.email && refreshed.quota) {
                recordWeeklySnapshotSafe({
                  email: refreshed.email,
                  quota: refreshed.quota,
                  source: refreshed.quota.source ?? 'cloud',
                  observedAtSec: refreshed.quota.last_updated,
                  tier: refreshed.quota.subscription_tier,
                });
              }
            }
            const identity = await resolveActiveIdentityForIpc();
            const hasLocalOAuthClient = hasLocalOAuthClientConfigured();
            const allNowMs = Date.now();
            const remoteCandidates = toRemoteQuotaCandidates(controller.getRemoteSessionsSnapshot(allNowMs));
            const accounts = result.accounts.map(account => {
              const isActive = isIdentityActiveAccount(identity, account);
              const fused = fuseAccountQuotaAcrossEnvironments({
                email: account.email,
                savedQuota: account.quota,
                liveLocalQuota: isActive ? account.quota : null,
                remoteSessions: remoteCandidates,
                nowMs: allNowMs,
              });
              const fusedAccount: Account = { ...account, quota: fused.quota };
              return projectAccountForIpcNormalized(fusedAccount, {
                isActive,
                hasLocalOAuthClient,
                nowMs: allNowMs,
                quotaSourceEnvironmentId: fused.quotaSourceEnvironmentId,
                activeRemoteEnvIds: fused.activeRemoteEnvIds,
              });
            });
            reply({ ok: result.failures.length === 0,
              accounts,
              failures: result.failures,
              skippedStandby: (result as { skippedStandby?: number }).skippedStandby ?? 0,
              partial: (result.failures.length > 0 || accounts.some((account: any) => account?.refreshState?.complete === false)) && accounts.length > 0,
              staleAccounts: accounts.filter((account: any) => (account?.quota?.stale_groups?.length ?? 0) > 0).length });
            return;
          }
          if (command === 'language_set') {
            const requested = typeof parsed.language === 'string' && parsed.language.trim() ? parsed.language.trim() : 'system';
            const systemLocales = Array.isArray(parsed.systemLocales)
              ? parsed.systemLocales.filter((v: unknown): v is string => typeof v === 'string' && v.trim().length > 0)
              : undefined;
            const resolved = resolveLocale(requested, systemLocales?.length ? systemLocales : undefined);
            await applyLocalePreference(requested, resolved);
          }
          else if (command === 'pause' || command === 'restore') { await saveRuntimePreferences({ translationEnabled: false }); cancelRunningDeepScan(); await controller.pause(); }
          else if (command === 'resume' || command === 'reapply') {
            if (getActiveLocale() === 'en') {
              await applyLocalePreference('zh-Hans', 'zh-Hans');
            } else {
              await saveRuntimePreferences({ translationEnabled: true });
              await controller.resume();
            }
          }
          else if (command === 'toggle') {if(!fixture)throw new Error(bt('main.shortcut_removed'));await controller.toggleLanguage();}
          else if (command === 'reload') await store.reload();
          else if (command === 'stop') {
            stopping = true;
            clearTimeout(startupPricingSyncTimer);
            clearInterval(periodicPricingSyncTimer);
            clearTimeout(startupQuotaRefreshTimer);
            clearInterval(periodicQuotaRefreshTimer);
            clearInterval(periodicRemoteSyncTimer);
            server.close();
            try {
              await accountLogin.close().catch(() => {});
              await tasks.stop().catch(() => {});
              try { store.close(); } catch {}
              await controller.stop().catch(() => {});
              await weeklySnapshotStore.flush().catch(() => {});
              await writeChain.catch(() => {});
              await cacheChain.catch(() => {});
              reply({ ok: true, status: controller.snapshot() });
            } finally {
              await cleanupIpc();
              await backendLease?.release().catch(() => {});
              setTimeout(() => process.exit(0), 100);
            }
            return;
          }
          else throw new Error(bt('main.unknown_command'));
          await writeChain.catch(() => {}); await cacheChain.catch(() => {});
          reply({ ok: true, status: controller.snapshot() });
        } catch (error) { reply({ ok: false, error: sanitizeErrorMessage(error) }); }
      });
    });
  });
  let autoPricingSyncInFlight: Promise<void> | null = null;
  maybeScheduleAutoPricingSync = (reason, unpricedKeys) => {
    if (stopping || !usageManager.isAutoRemotePricingSyncEnabled()) return;
    if (process.env.GRAVITYBOX_DISABLE_AUTO_PRICING_NETWORK === '1') return;
    if (autoPricingSyncInFlight) return;
    autoPricingSyncInFlight = (async () => {
      try {
        let forceForNewUnpriced = false;
        if (reason === 'unpriced' && Array.isArray(unpricedKeys) && unpricedKeys.length > 0) {
          const sig = [...new Set(unpricedKeys)].sort().join(',');
          const elapsedSinceCheck = Date.now() - usageManager.getLastPricingCheckAt();
          if (sig !== lastAutoSyncUnpricedSignature && elapsedSinceCheck >= 300_000) {
            lastAutoSyncUnpricedSignature = sig;
            forceForNewUnpriced = true;
          }
        }
        if (!forceForNewUnpriced && !(await usageManager.isAutoPricingSyncDue())) {
          return;
        }
        await usageManager.syncRemotePricing(undefined, forceForNewUnpriced);
      } catch {}
    })().finally(() => {
      autoPricingSyncInFlight = null;
    });
  };
  const startupPricingSyncTimer = setTimeout(() => maybeScheduleAutoPricingSync('startup'), 3_000);
  startupPricingSyncTimer.unref();
  const periodicPricingSyncTimer = setInterval(() => maybeScheduleAutoPricingSync('timer'), 3_600_000);
  periodicPricingSyncTimer.unref();
  let autoQuotaRefreshCheckInFlight = false;
  let lastAutoQuotaRefreshStartAt = 0;
  let lastAutoQuotaRefreshIntervalMinutes = 0;
  const preExpirySnapFired = new Set<string>();
  const maybeScheduleAutoQuotaRefresh = () => {
    if (stopping || fixture || process.env.GRAVITYBOX_DISABLE_AUTO_QUOTA_REFRESH === '1') return;
    if (autoQuotaRefreshCheckInFlight) return;
    const hasLocalOAuthClient = hasLocalOAuthClientConfigured();
    const minutes = accountsManager.getConfiguredQuotaRefreshMinutes();
    const validInterval = [5, 10, 15, 30, 60].includes(minutes);
    const cooldownMs = minutes * 60_000;
    const autoIntervalDue = validInterval && !(lastAutoQuotaRefreshIntervalMinutes === minutes && Date.now() - lastAutoQuotaRefreshStartAt < cooldownMs);
    const onlineSshSessions = controller.getRemoteSessionsSnapshot().filter(s => s.state === 'connected');
    if (!autoIntervalDue && hasLocalOAuthClient && onlineSshSessions.length === 0) return;
    autoQuotaRefreshCheckInFlight = true;
    void (async () => {
      try {
        const nowMs = Date.now();
        const nowSec = nowMs / 1000;
        const staleMs = accountsManager.getConfiguredQuotaStaleSeconds() * 1000;
        const sshRefreshIntervalMs = validInterval ? Math.min(cooldownMs, staleMs) : staleMs;

        // 1. 在线 SSH 主机纳入定时静默配额刷新（即使本机无 OAuth 或未配置本地备用号也独立生效）
        const overdueRemoteKeys = onlineSshSessions
          .filter(s => !s.observedAt || nowMs - s.observedAt >= sshRefreshIntervalMs)
          .map(s => s.remoteKey);
        if (overdueRemoteKeys.length > 0 && !stopping) {
          const idx = await accountsManager.loadIndex().catch(() => null);
          const matchAccountId = (email: string): string | null => {
            if (!idx || !email) return null;
            const targetEmail = email.toLowerCase();
            return idx.accounts.find(a => a.email.toLowerCase() === targetEmail)?.id ?? null;
          };
          const getQuotaOverview = (quota: QuotaData, tsMs: number) =>
            accountsManager.getAccountQuotaOverview({ quota }, { nowMs: tsMs });
          const refreshed = await Promise.all(
            overdueRemoteKeys.map(rk =>
              controller.probeRemoteSessions({
                force: true,
                remoteKey: rk,
                matchAccountId,
                getQuotaOverview,
              }).catch(() => [])
            )
          );
          for (const list of refreshed) {
            for (const s of list) {
              if (s.quota?.models?.length) registerObservedModelsFromSource(s.quota.models);
              if (s.state === 'connected' && s.quota && s.email) {
                recordWeeklySnapshotSafe({
                  email: s.email,
                  quota: s.quota,
                  source: 'ssh',
                  observedAtSec: s.quota.last_updated ?? (s.observedAt ? Math.floor(s.observedAt / 1000) : null),
                  tier: s.tier || s.quota.subscription_tier,
                });
              }
            }
          }
          syncRemoteTargetStateAndMaybeTriggerSync();
          if (!stopping) onStatus(controller.snapshot());
        }

        if (autoIntervalDue && tasks.list().some(t => t.state === 'running')) return;
        const index = await accountsManager.loadIndex();
        const enabledSummaries = index.accounts.filter(acc => !acc.disabled);
        if (enabledSummaries.length === 0) return;
        const intervalSec = minutes * 60;
        const identity = await resolveActiveIdentityForIpc();
        const activeRemoteEmails = new Set(
          controller
            .getRemoteSessionsSnapshot(nowMs)
            .filter(s => s.state === 'connected' && typeof s.email === 'string' && s.email.trim().length > 0)
            .map(s => s.email!.trim().toLowerCase()),
        );
        let hasOverdueAccount = false;
        for (const summary of enabledSummaries) {
          const saved = await accountsManager.getAccount(summary.id).catch(() => null);
          if (!saved || saved.disabled || saved.validation_blocked) continue;
          if (accountCredentialReadiness(saved, nowSec).state === 'needs_authorization') continue;
          const isActive = identity.activeEmailLower
            ? saved.email.trim().toLowerCase() === identity.activeEmailLower
            : saved.id === index.current_account_id;
          const isRemoteActive = activeRemoteEmails.has(saved.email.trim().toLowerCase());
          const standbyStatus = computeStandbyRefreshStatus(saved, {
            isActive,
            isRemoteActive,
            hasLocalOAuthClient,
            nowMs,
          });
          const lastUpdated = saved.quota?.last_updated ?? 0;

          // Pre-expiry Last-Mile Snap: refresh standby account silently shortly before its harvested access token expires.
          if (!hasLocalOAuthClient && !isActive && !isRemoteActive) {
            const exp = saved.token?.expiry_timestamp;
            const hasValidAccess = Boolean(saved.token?.access_token && saved.token.access_token !== 'pending_refresh');
            const ttl = typeof exp === 'number' && Number.isFinite(exp) ? exp - nowSec : -1;
            const snapKey = `${saved.id}:${exp}`;
            if (hasValidAccess && ttl >= 315 && ttl <= 420 && nowSec - lastUpdated >= 300 && !preExpirySnapFired.has(snapKey)) {
              if (preExpirySnapFired.size > 500) preExpirySnapFired.clear();
              preExpirySnapFired.add(snapKey);
              void accountsManager.refreshQuota(saved.id).catch(() => {});
            }
          }

          if (autoIntervalDue && standbyStatus.canBackgroundRefresh) {
            if (!lastUpdated || nowSec - lastUpdated >= intervalSec) {
              hasOverdueAccount = true;
            }
          }
        }
        if (!autoIntervalDue || !hasOverdueAccount || stopping) return;
        if (tasks.list().some(t => t.state === 'running')) return;
        lastAutoQuotaRefreshStartAt = Date.now();
        lastAutoQuotaRefreshIntervalMinutes = minutes;
        startQuotaRefreshTask();
      } catch {}
    })().finally(() => {
      autoQuotaRefreshCheckInFlight = false;
    });
  };
  const startupQuotaRefreshTimer = setTimeout(() => maybeScheduleAutoQuotaRefresh(), 5_000);
  startupQuotaRefreshTimer.unref();
  const periodicQuotaRefreshTimer = setInterval(() => maybeScheduleAutoQuotaRefresh(), 30_000);
  periodicQuotaRefreshTimer.unref();
  const periodicRemoteSyncTimer = setInterval(() => {
    if (stopping || fixture) return;
    syncRemoteTargetStateAndMaybeTriggerSync();
    remoteSyncCoordinator.triggerSync();
  }, 45_000);
  periodicRemoteSyncTimer.unref();
  server.maxConnections = 64;
  if (isWindows()) {
    await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(socketPath, resolveListen); });
  } else {
    const previousUmask = process.umask(0o177);
    try {
      await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(socketPath, resolveListen); });
    } finally {
      process.umask(previousUmask);
    }
  }
  server.on('error', error => {
    console.error(`[GravityBox] ${sanitizeError(error?.message ?? bt('main.uncaught_exception'))}`);
  });
  if (windowsIpcSession) {
    await writeIpcSession(stateDir, windowsIpcSession);
  } else {
    await finalizeIpcEndpointAfterListen(socketPath);
  }
  const stop = async (code = 0) => {
    if (stopping) return; stopping = true;
    clearTimeout(startupPricingSyncTimer);
    clearInterval(periodicPricingSyncTimer);
    clearTimeout(startupQuotaRefreshTimer);
    clearInterval(periodicQuotaRefreshTimer);
    clearInterval(periodicRemoteSyncTimer);
    server.close();
    try {
      await commandChain.catch(() => {});
      await accountLogin.close().catch(() => {});
      await tasks.stop().catch(() => {});
      try { store.close(); } catch {}
      await controller.stop().catch(() => {});
      await weeklySnapshotStore.flush().catch(() => {});
      await writeChain.catch(() => {});
      await cacheChain.catch(() => {});
    } finally {
      await cleanupIpc();
      await backendLease?.release().catch(() => {});
      process.exit(code);
    }
  };
  process.off('SIGTERM', earlySignalExit); process.off('SIGINT', earlySignalExit);
  process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
  // A single bad payload must not take the whole localisation helper down; log it and keep serving.
  process.on('uncaughtException', error => { console.error(`[GravityBox] ${sanitizeError(error?.stack ?? error?.message ?? bt('main.uncaught_exception'))}`); if (stopping) { backendLease?.releaseSync(); process.exit(1); } });
  process.on('unhandledRejection', reason => { console.error(`[GravityBox] ${reason instanceof Error ? sanitizeError(reason.message) : bt('main.unhandled_rejection')}`); });
  await Promise.all([
    weeklySnapshotStore.load().catch(() => {}),
    remoteSyncCoordinator.observationStore.load().catch(() => {}),
    usageManager.getSyncReceipts().then(receipts => {
      for (const rec of Object.values(receipts ?? {})) {
        if (rec?.environment_id && rec.committed_at > 0) {
          const prev = remoteLastSyncedAtSec.get(rec.environment_id) ?? 0;
          if (rec.committed_at > prev) remoteLastSyncedAtSec.set(rec.environment_id, rec.committed_at);
        }
      }
    }).catch(() => {}),
    accountsManager.listAccounts().then(listRes => {
      refreshCachedAccountIds(listRes.accounts);
      if (listRes.active_account) {
        const q = accountsManager.getAccountQuotaOverview(listRes.active_account);
        cachedLocalAccountSnapshot = {
          email: listRes.active_account.email,
          name: listRes.active_account.name ?? '',
          tier: normalizeSubscriptionTier(q.subscriptionTier),
          quota: listRes.active_account.quota ?? null,
          observedAtSec: listRes.active_account.quota?.last_updated ?? null,
          lastError: cleanAndLocalizeRefreshError(listRes.active_account.quota_refresh_error) ?? '',
        };
      }
    }).catch(() => {}),
  ]);
  onStatus(controller.snapshot());
  void usageManager.getUsageSummary(false).then(summary => {
    if (summary?.available_environments) {
      cachedAvailableEnvironments = summary.available_environments;
    }
    if (summary?.generated_at && summary.generated_at > 0) {
      cachedLocalUsageSyncedAtSec = summary.generated_at;
    }
    if (!stopping) onStatus(controller.snapshot());
  }).catch(() => {});
  await controller.start();
  void syncActiveAccountToUsageManager(true).catch(() => {});
  } catch (error) {
    if (windowsIpcSession) {
      await cleanupIpcSession(stateDir, process.pid).catch(() => {});
    }
    await backendLease?.release().catch(() => {});
    throw error;
  }
}
// 仅作为入口脚本直接运行时启动助手；被测试/工具 import 时只暴露纯函数，避免误启动真实 socket。
// 同路径与 realpath 双判定：经由符号链接路径启动（npm start/打包安装目录）也必须正常运行。
function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const modulePath = fileURLToPath(import.meta.url);
  if (pathsEqual(resolve(entry), modulePath)) return true;
  try { return pathsEqual(realpathSync(entry), realpathSync(modulePath)); } catch { return false; }
}
if (process.env.GRAVITYBOX_IMPORT_ONLY !== '1' && isDirectEntry()) {
  run().catch(error => { console.error(`[GravityBox] ${sanitizeError((error as Error)?.message ?? bt('main.startup_failed'))}`); process.exitCode = 1; });
}
