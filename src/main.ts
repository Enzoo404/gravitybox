import { ALLOWED_DATA_DIRECTORY_NAMES, applicationChannel, savedApplicationChannel, applicationTarget, detectInstalledChannels, type ApplicationChannel, type ApplicationTarget } from './application-target.js';
import { GoogleAccountLogin } from './account-oauth.js';
import { AccountSwitchService } from './account-switch.js';
import { AccountsManager, computeAccountRevision, projectAccountForIpc, type QuotaData } from './accounts.js';
import { UsageStatsManager } from './usage.js';
import { priceStatus } from './pricing.js';
import {
  normalizeSubscriptionTier,
  projectAccountForIpcNormalized as projectAccountNormalizedWithManager,
  projectQuotaContract,
  projectUsagePeriodSummary,
} from './ipc-projections.js';
export { normalizeSubscriptionTier, projectQuotaContract };
import { FEED_MODEL_KEYS } from './model-catalog.js';
import { CacheMaintenance } from './maintenance.js';
import { mkdir, lstat, chmod, unlink, readFile, readdir, writeFile } from 'node:fs/promises';
import { realpathSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, createConnection } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DictionaryStore, loadDictionary, dictionaryFromEntries, validateEntries } from './dictionary.js';
import { Controller, type AssistantStatus } from './controller.js';
import { coverageMetricSnapshot } from './coverage.js';
import { atomicJson, readOptionalJson, sanitizeError } from './files.js';
import { discover } from './discovery.js';
import { Tasks } from './tasks.js';
import { acquireProcessLease, type ProcessLease } from './process-lock.js';
import { createHash } from 'node:crypto';
import { IdempotencyStore, canonicalPayload } from './ipc-idempotency.js';
export { canonicalPayload } from './ipc-idempotency.js';

const execFileAsync = promisify(execFile);

function cliOption(argv: string[], name: string, fallback?: string) {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
}

function sanitizeErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return '操作未完成';
  const msg = err.message || '';
  const redacted = sanitizeError(msg);
  const sanitized = redacted.replace(/\/(?:Users|private|var|tmp|Volumes)\/[^\s'"]+/g, '[路径]');
  return sanitized.slice(0, 200);
}

function formatResetTime(resetTime: number | null | undefined): string {
  if (!resetTime) return '';
  const tsMs = typeof resetTime === 'number' && resetTime < 1e11 ? resetTime * 1000 : Number(resetTime);
  const date = new Date(tsMs);
  return !isNaN(date.getTime()) ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : String(resetTime);
}

/** 合并本机实时语言服务配额与已保存账号配额：当实时探测未返回分组/已知配额（如企业 Vertex AI）或套餐回退 FREE 时，保留已存分组、模型配额与真实高级套餐。 */
function mergeLiveQuotaWithSaved(
  savedQuota: QuotaData | null | undefined,
  liveQuota: QuotaData | null | undefined
): QuotaData | null | undefined {
  if (!liveQuota) return savedQuota;
  if (!savedQuota) return liveQuota;
  const hasLiveGroups = Array.isArray(liveQuota.quota_groups) && liveQuota.quota_groups.length > 0;
  const hasKnownLiveModels = Array.isArray(liveQuota.models) && liveQuota.models.some(m => m?.percentage_known || m?.own_percentage_known);
  const hasSavedModels = Array.isArray(savedQuota.models) && savedQuota.models.length > 0;
  const liveComplete = liveQuota.refresh_state?.complete === true;
  const mergedStaleGroups = liveQuota.stale_groups?.length
    ? liveQuota.stale_groups
    : (hasLiveGroups && liveComplete ? undefined : savedQuota.stale_groups);
  const merged: QuotaData = {
    ...savedQuota,
    ...liveQuota,
    quota_groups: hasLiveGroups ? liveQuota.quota_groups : (savedQuota.quota_groups ?? []),
    models: (hasLiveGroups || hasKnownLiveModels || !hasSavedModels) ? liveQuota.models : savedQuota.models,
    subscription_tier: (liveQuota.subscription_tier && liveQuota.subscription_tier !== 'FREE')
      ? liveQuota.subscription_tier
      : (savedQuota.subscription_tier || liveQuota.subscription_tier),
  };
  if (mergedStaleGroups?.length) merged.stale_groups = mergedStaleGroups;
  else delete merged.stale_groups;
  return merged;
}

export type DashboardAggregateDeps = {
  listAccounts: () => Promise<any>;
  getAutoSwitchConfig: () => Promise<any>;
  probeLiveLanguageServer: () => Promise<any>;
  getAccount: (id: string) => Promise<any>;
  getAccountQuotaOverview: (account: any, options?: any) => any;
  getUsageSummary: () => Promise<any>;
  getPricingTable: () => Promise<any>;
};
export type DashboardAggregate = { accounts: any; usage: any; accountsError: string; usageError: string };

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
        let quotaRefreshError = (activeAcc as any)?.quota_refresh_error ?? '';

        if (liveAccountEmail) {
          const matchedSummary = listRes.accounts.find((a: any) => a.email.toLowerCase() === liveAccountEmail.toLowerCase());
          const matchedSaved = matchedSummary ? await deps.getAccount(matchedSummary.id) : null;
          if (matchedSaved) {
            const mergedQuota = mergeLiveQuotaWithSaved(matchedSaved.quota, liveLs?.quota);
            sourceAcc = { ...matchedSaved, ...(mergedQuota ? { quota: mergedQuota } : {}) };
            currentAccountId = matchedSaved.id;
            activeEmail = matchedSaved.email;
            activeName = matchedSaved.name || liveLs?.name || '';
            isLiveVerified = true;
            quotaRefreshError = matchedSaved.quota_refresh_error ?? '';
          } else {
            // 实机运行账号未保存在本地账号库：严禁混入已存 activeAcc 的姓名、等级或配额
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

        // 同一载荷的顶层/模型/分组/英文描述倒计时统一由 reset_time 按同一参考时刻现算。
        const dashboardNowMs = Date.now();
        const quotaOverview = sourceAcc ? deps.getAccountQuotaOverview(sourceAcc, { nowMs: dashboardNowMs }) : null;
        // 有账号但套餐缺失/空串时回落到“待确认”；完全无账号时才保留 FREE 的既有语义。
        const activeTier = (!isLiveVerified && liveAccountEmail && !currentAccountId)
          ? normalizeSubscriptionTier((liveLs?.tier && !/starter|free/i.test(liveLs.tier)) ? liveLs.tier : (quotaOverview?.subscriptionTier || '待确认'))
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
          quotaGroups: quotaOverview?.quotaGroups ?? [],
          staleGroups: quotaOverview?.staleGroups ?? [],
          stale_groups: quotaOverview?.staleGroups ?? [],
          models: quotaOverview?.models ?? [],
          lastUpdated: quotaOverview?.lastUpdated ?? null,
          isStale: quotaOverview?.isStale ?? false,
          staleHours: quotaOverview?.staleHours ?? 0,
          quotaRefreshError,
          ...projectQuotaContract(quotaOverview ?? { familyWindows: null, argonStatus: null, carbonStatus: null, standaloneModels: [],
            refreshState: { complete: false }, quotaWarnings: [], quotaWarningCodes: [] }),
        };
      } catch (error) { accountsError = sanitizeErrorMessage(error); }
    })(),
    (async () => {
      try {
        const [summary, pricing] = await Promise.all([
          deps.getUsageSummary(),
          deps.getPricingTable(),
        ]);
        const todayProjected =
          Array.isArray(summary?.today?.by_model) && Array.isArray(summary?.today_hourly)
            ? projectUsagePeriodSummary(summary, 'today')
            : undefined;
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
          unpricedModels: (summary as any).unpriced_models ?? 0,
          pricedModels: (summary as any).priced_models ?? 0,
          databasesScanned: (summary as any).databases_scanned ?? 0,
          databasesDiscovered: (summary as any).databases_discovered ?? 0,
          scanScopeDescription: (summary as any).scan_scope_description ?? '',
          hasError: (summary as any).has_error ?? false,
          failedDatabasesCount: (summary as any).failed_databases_count ?? 0,
          skippedLargeRecords: (summary as any).skipped_large_records ?? 0,
          availability: (summary as any).availability ?? 'complete',
          unknownTimeRecords: (summary as any).unknown_time_records ?? 0,
          unknownTimeTokens: (summary as any).unknown_time_tokens ?? 0,
          databaseDiagnostics: (summary as any).database_diagnostics ?? [],
          ...(todayProjected ? {
            todayHourly: todayProjected.todayHourly,
            todayByModel: todayProjected.byModel,
          } : {}),
        };
      } catch (error) { usageError = sanitizeErrorMessage(error); }
    })(),
  ]);
  return { accounts, usage, accountsError, usageError };
}

export async function request(command: string): Promise<any> {
  const argv = process.argv.slice(2);
  const targetStateDir = resolve(cliOption(argv, '--state-dir', join(homedir(), 'Library', 'Application Support', 'GravityBox'))!);
  const targetSocketPath = join(targetStateDir, 'control.sock');
  return new Promise((resolveReply, reject) => {
    const client = createConnection(targetSocketPath); let buffer = ''; let received = 0;
    const decoder = new StringDecoder('utf8');
    client.setTimeout(['status', 'ping', 'task_list'].includes(command) ? 8000 : 120000, () => { client.destroy(); reject(new Error('等待响应超时，后台结果尚未确认；请查询任务状态，勿直接重试写入操作')); });
    client.on('connect', () => client.write(JSON.stringify({ command }) + '\n'));
    client.on('data', bytes => {
      // CLI 必须与 socket 服务端一样按 UTF-8 流解码：多字节中文可能跨 chunk 边界，
      // 逐 chunk toString() 会产生 U+FFFD 并损坏 coverage_report/dictionary_export 的 JSON。
      received += bytes.length;
      if (received > 4_000_000) { client.destroy(); reject(new Error('响应超出限制')); return; }
      buffer += decoder.write(bytes);
      if (buffer.includes('\n')) { client.end(); try { resolveReply(JSON.parse(buffer.split('\n')[0]!)); } catch { reject(new Error('响应格式错误')); } }
    });
    client.on('error', () => reject(new Error('助手未运行')));
  });
}
async function run() {
  try {
    process.loadEnvFile?.();
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      // ignore
    }
  }
  const args = process.argv.slice(2);
  const option = (name: string, fallback?: string) => cliOption(args, name, fallback);
  const command = option('--command');
  if (command) { console.log(JSON.stringify(await request(command))); return; }
  if (args.includes('--heal')) throw new Error('当前版本不提供在线补译；可编辑个人词典或使用开发工具生成本地候选');
  const stateDir = resolve(option('--state-dir', join(homedir(), 'Library', 'Application Support', 'GravityBox'))!);
  try {
    process.loadEnvFile?.(join(stateDir, '.env'));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      // ignore
    }
  }
  const socketPath = join(stateDir, 'control.sock');
  let configuredChannel: unknown;
  let configuredHudEnabled: unknown;
  try {
    const parsedCfg = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'));
    configuredChannel = parsedCfg.applicationChannel;
    configuredHudEnabled = parsedCfg.hudEnabled;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('应用版本配置无法读取，原文件已保留'); }
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
  const cacheMaintenance = new CacheMaintenance(profile, join(homedir(), '.Trash'), undefined, { stateDir: channelStateDir, geminiDir, appPath });
  const accountsManager = new AccountsManager(stateDir, { target });
  function probeLiveCached() {
    return accountsManager.probeLiveLanguageServer();
  }
  const accountLogin = new GoogleAccountLogin((token, signal) => accountsManager.addAccountFromOAuth(token, signal));
  const homeDir = option('--home-dir', process.env.GRAVITYBOX_HOME_DIR || homedir())!;
  const appSupportDir = option('--app-support-dir', process.env.GRAVITYBOX_APP_SUPPORT_DIR || join(homedir(), 'Library', 'Application Support'))!;
  const switchService = new AccountSwitchService(accountsManager, { stateDir, profile, channel });
  const usageManager = new UsageStatsManager({ stateDir, geminiDir });
  cacheMaintenance.setHooks({
    archiveDatabases: dbPaths => usageManager.archiveDatabasesBeforeClear(dbPaths),
    onMutated: () => usageManager.invalidateCache(),
  });
  let accountSyncInFlight: Promise<void> | null = null;
  let accountSyncedAt = 0;
  async function syncActiveAccountToUsageManager(forceSync = false): Promise<void> {
    const now = Date.now();
    if (!forceSync && now - accountSyncedAt < 4500) return;
    if (accountSyncInFlight) return accountSyncInFlight;
    accountSyncInFlight = (async () => {
      try {
        const live = await probeLiveCached().catch(() => null);
        const listRes = await accountsManager.listAccounts({ liveEmailHint: live?.email ?? null }).catch(() => null);
        if (listRes?.accounts) {
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
  async function syncActiveOfficialModelsToUsageManager(): Promise<void> {
    try {
      const extractModelIds = (models: any): string[] => {
        if (!Array.isArray(models)) return [];
        return models
          .filter(m => m && typeof m === 'object')
          .map(m => String(m.model_id ?? m.name ?? '').trim())
          .filter(Boolean);
      };
      const union = new Set<string>(FEED_MODEL_KEYS);
      const live = await probeLiveCached().catch(() => null);
      for (const id of extractModelIds(live?.quota?.models)) {
        union.add(id);
      }
      if (union.size === FEED_MODEL_KEYS.length) {
        const listRes = await accountsManager.listAccounts().catch(() => null);
        if (listRes?.accounts?.length) {
          const preferred = listRes.active_account
            ?? [...listRes.accounts].sort((a, b) => (b.quota_last_updated ?? 0) - (a.quota_last_updated ?? 0))[0];
          const saved = preferred ? await accountsManager.getAccount(preferred.id).catch(() => null) : null;
          const savedQuota = saved?.quota ?? preferred?.quota;
          if (savedQuota?.source === 'live') {
            for (const id of extractModelIds(savedQuota.models)) {
              union.add(id);
            }
          }
        }
      }
      usageManager.setActiveOfficialModels([...union]);
    } catch {}
  }
  const pricePrefs = await readOptionalJson<{ enabled?: boolean }>(join(stateDir, 'pricing-preferences.json'), 'pricing-preferences.json');
  if (pricePrefs) usageManager.setAutoRemotePricingSync(pricePrefs.enabled === true);
  const idempotencyStore = new IdempotencyStore();
  let backendLease: ProcessLease | undefined;

  function projectAccountForIpcNormalized(account: Parameters<typeof projectAccountNormalizedWithManager>[0]): Record<string, unknown> | null {
    return projectAccountNormalizedWithManager(account, accountsManager);
  }

  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const stateInfo = await lstat(stateDir);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink() || stateInfo.uid !== process.getuid?.()) throw new Error('助手数据目录身份不匹配');
  await chmod(stateDir, 0o700);
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
  try {
    const info = await lstat(socketPath);
    if (!info.isSocket() || info.uid !== process.getuid?.()) throw new Error('控制接口身份不匹配');
    // Connection acceptance proves a live server even if a long operation delays its reply.
    const live = await new Promise<boolean>((resolveLive, reject) => {
      const client = createConnection(socketPath);
      client.once('connect', () => { client.destroy(); resolveLive(true); });
      client.once('error', (error: NodeJS.ErrnoException) => {
        if (['ECONNREFUSED', 'ENOENT'].includes(error.code ?? '')) resolveLive(false);
        else reject(new Error('控制接口状态无法确认，已保留现有接口'));
      });
      client.setTimeout(1500, () => { client.destroy(); reject(new Error('后台繁忙，已保留现有接口')); });
    });
    if (live) throw new Error('助手已运行');
    const current = await lstat(socketPath);
    if (current.ino !== info.ino || current.dev !== info.dev) throw new Error('控制接口已变化，请稍后重试');
    await unlink(socketPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(channelStateDir, { recursive: true, mode: 0o700 });
  const userDir = join(stateDir, '词典'); await mkdir(userDir, { recursive: true, mode: 0o700 });
  const userInfo = await lstat(userDir);
  if (userInfo.isSymbolicLink() || !userInfo.isDirectory() || userInfo.uid !== process.getuid?.()) throw new Error('词典目录身份不匹配');
  const personalPath = join(userDir, '个人覆盖.json');
  try { await lstat(personalPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') await atomicJson(personalPath, {}); else throw error; }
  const baseDir = fileURLToPath(new URL('../dict/', import.meta.url));
  const store = new DictionaryStore(baseDir, userDir);
  let fallback;
  try { fallback = dictionaryFromEntries(validateEntries(JSON.parse(await readFile(join(channelStateDir, 'last-valid-dictionary.json'), 'utf8')).entries)); }
  catch { fallback = await loadDictionary(baseDir); }
  await store.start(fallback);
  let writeChain = Promise.resolve();
  let statusTasks:Tasks|undefined;
  let pendingStatus: any, writingStatus=false, lastStatusKey="", lastStatusWrite=0;
  const onStatus = (status: AssistantStatus) => {
    const installState = detectInstalledChannels(channel);
    const snapshot = { ...status, applicationChannel: channel, applicationLabel: target.label, accountSwitchSupported: target.supportsAccountSwitch, bothApplicationsInstalled: installState.bothInstalled, availableChannels: installState.channels, taskRevision:statusTasks?.revision??0,runningTasks:statusTasks?.list().filter(t=>t.state==='running').length??0 };
    const {updatedAt,rssMB,...meaningful}=snapshot;const key=JSON.stringify(meaningful);
    if(key===lastStatusKey&&Date.now()-lastStatusWrite<30000)return;
    lastStatusKey=key;lastStatusWrite=Date.now();pendingStatus=snapshot;
    if(!writingStatus) {writingStatus=true;writeChain=writeChain.catch(()=>{}).then(async()=>{try {while(pendingStatus){const snapshot=pendingStatus;pendingStatus=undefined;await atomicJson(join(stateDir,'status.json'),snapshot,undefined,{durability:'relaxed'});}}finally{writingStatus=false;}});writeChain.catch(()=>{});}
  };
  let fixture: { port: number; origin: string } | undefined;
  if (option('--fixture-port')) {
    const port = Number(option('--fixture-port')), origin = option('--fixture-origin');
    if (!Number.isInteger(port) || !origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('测试参数无效');
    fixture = { port, origin };
  }
  let applyChain = Promise.resolve();
  const shortcutEnabled = !!fixture;
  let initiallyPaused = false;
  let hudEnabled = typeof configuredHudEnabled === 'boolean' ? configuredHudEnabled : true;
  const runtimePrefs = await readOptionalJson<{ translationEnabled?: boolean; hudEnabled?: boolean }>(join(stateDir, 'runtime-preferences.json'), 'runtime-preferences.json');
  if (runtimePrefs) {
    initiallyPaused = runtimePrefs.translationEnabled === false;
    if (typeof configuredHudEnabled !== 'boolean' && typeof runtimePrefs.hudEnabled === 'boolean') {
      hudEnabled = runtimePrefs.hudEnabled;
    }
  }
  const saveRuntimePreferences = async (patch: { translationEnabled?: boolean; hudEnabled?: boolean }) => {
    const currentPrefs = (await readOptionalJson<Record<string, unknown>>(join(stateDir, 'runtime-preferences.json'), 'runtime-preferences.json')) ?? {};
    const nextPrefs = { ...currentPrefs, translationEnabled: controller.snapshot().translationEnabled !== false, hudEnabled, ...patch };
    if (typeof patch.hudEnabled === 'boolean') {
      hudEnabled = patch.hudEnabled;
      const configPath = join(stateDir, 'config.json');
      try {
        const cfg = JSON.parse(await readFile(configPath, 'utf8'));
        if (cfg && typeof cfg === 'object' && !Array.isArray(cfg) && (cfg.schema === undefined || cfg.schema === 2)) {
          await atomicJson(configPath, { ...cfg, hudEnabled });
        }
      } catch {}
    }
    await atomicJson(join(stateDir, 'runtime-preferences.json'), nextPrefs);
  };
  const controller = new Controller({ initiallyPaused, shortcutEnabled, hudEnabled, appPath, profile, fixture, geminiDir, dictionary: store.current!, stateDir: channelStateDir, selectDictionary:async version=>{const dictionary=await store.selectVersion(version);await applyChain;return dictionary;}, reloadDictionary: async () => { await store.reload(); await applyChain; if (store.lastError) throw new Error(store.lastError); }, onStatus });
  const tasks = new Tasks(stateDir, () => onStatus(controller.snapshot()));statusTasks=tasks; await tasks.start();
  let cacheChain = Promise.resolve();
  const cache = () => { const value = store.current; cacheChain = cacheChain.catch(() => {}).then(() => atomicJson(join(channelStateDir, 'last-valid-dictionary.json'), value)); cacheChain.catch(() => {}); };
  cache();
  if (store.lastError) controller.dictionaryError(store.lastError);
  store.on('updated', dictionary => { cache(); applyChain = controller.update(dictionary); applyChain.catch(() => controller.dictionaryError('部分窗口未完成词典更新')); });
  store.on('invalid', message => controller.dictionaryError(String(message)));
  store.on('valid', () => controller.dictionaryError());
  let commandChain = Promise.resolve(); let stopping = false; const ipcMetrics = { statusRequests: 0, taskPayloadReplies: 0 };
  async function recommendationPreview(config: any, cached: boolean) {
    const live = await (cached ? probeLiveCached() : accountsManager.probeLiveLanguageServer()).catch(() => null);
    const detectedEmail = live?.email ?? await accountsManager.detectCurrentAntigravityEmail({ liveEmailHint: null }).catch(() => null);
    const index = await accountsManager.loadIndex();
    const currentId = detectedEmail ? index.accounts.find(a => a.email.toLowerCase() === detectedEmail.toLowerCase())?.id : undefined;
    if (live?.email && !currentId) return null;
    return accountsManager.selectBestAccount(config, { currentId, currentEmail: detectedEmail ?? undefined, currentQuota: live?.quota });
  }
  const server = createServer(client => {
    // Long commands legitimately produce no traffic while they run; the client owns the real deadline.
    client.setTimeout(120_000, () => client.destroy());
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
      if (received > 4_000_000) { handled = true; reply({ ok: false, error: '请求过大，已被拒绝' }); return; }
      input += decoder.write(chunk);
      if (!input.includes('\n')) return; handled = true;
      try { parsed = JSON.parse(input.split('\n')[0]!); } catch { reply({ ok: false, error: '请求格式错误' }); return; }
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)){reply({ok:false,error:'请求格式错误'});return;}
      if (parsed.idempotencyKey) {
        if(typeof parsed.idempotencyKey!=='string'||parsed.idempotencyKey.length>256){reply({ok:false,error:'幂等键无效'});return;}
        const fingerprint=createHash('sha256').update(JSON.stringify(canonicalPayload(parsed))).digest('hex');
        const state=idempotencyStore.reserve(parsed.idempotencyKey,fingerprint,reply);
        if(state==='waiting')return;
        if(state!=='owner'){reply({ok:false,error:state==='conflict'?'幂等键已用于其他请求':'请求过多，请稍后重试'});return;}
        ownsIdempotency=true;
      }
      const command = parsed.command;
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
                  const q = accountsManager.getAccountQuotaOverview({ ...matchedSaved, quota: mergeLiveQuotaWithSaved(matchedSaved.quota, liveQuotaForMatched) });
                  activeFiveHourQuota = q.fiveHourRemaining;
                  activeSubscriptionTier = normalizeSubscriptionTier(q.subscriptionTier);
                } else if (liveLs?.email) {
                  activeAccountEmail = liveLs.email;
                  const q = accountsManager.getAccountQuotaOverview({ quota: liveLs.quota });
                  activeFiveHourQuota = q.fiveHourRemaining;
                  activeSubscriptionTier = normalizeSubscriptionTier((liveLs.tier && !/starter|free/i.test(liveLs.tier)) ? liveLs.tier : (q.subscriptionTier !== 'FREE' ? q.subscriptionTier : '待确认'));
                }
              } else if (listRes.active_account) {
                usageManager.setCurrentAccountContext(undefined);
                activeAccountEmail = listRes.active_account.email;
                const q = accountsManager.getAccountQuotaOverview(listRes.active_account);
                activeFiveHourQuota = q.fiveHourRemaining;
                activeSubscriptionTier = normalizeSubscriptionTier(q.subscriptionTier);
              }
            } catch {}
          }
          const all = tasks.list(), revision = tasks.revision;
          const installState = detectInstalledChannels(channel);
          if (parsed.includeTasks !== false && parsed.tasksSince !== revision) ipcMetrics.taskPayloadReplies++;
          reply({
            ok: true,
            status: {
              ...controller.snapshot(),
              applicationChannel: channel, applicationLabel: target.label, accountSwitchSupported: target.supportsAccountSwitch,
              bothApplicationsInstalled: installState.bothInstalled, availableChannels: installState.channels,
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
      if (command === 'task_cancel') { const cancelled = tasks.cancel(parsed.id); reply(cancelled ? { ok: true } : { ok: false, error: '任务已结束、不存在或已进入保存阶段' }); return; }
      if (['pause', 'restore', 'stop'].includes(command)) { tasks.cancel(); }
      if (command === 'dashboard_summary') {
        (async () => {
        const counts = store.layerCounts;
        const dictTotal = (counts?.builtin ?? 0) + (counts?.incremental ?? 0) + (counts?.personal ?? 0);
        await syncActiveOfficialModelsToUsageManager();
        const liveForDashboard = await probeLiveCached().catch(() => null);
        const [report, aggregate] = await Promise.all([
          controller.coverageReport(),
          buildDashboardAggregate({
            listAccounts: () => accountsManager.listAccounts({ liveEmailHint: liveForDashboard?.email ?? null }),
            getAutoSwitchConfig: () => accountsManager.getAutoSwitchConfig(),
            probeLiveLanguageServer: () => Promise.resolve(liveForDashboard),
            getAccount: (id: string) => accountsManager.getAccount(id),
            getAccountQuotaOverview: (account: any, options?: any) => accountsManager.getAccountQuotaOverview(account, options),
            getUsageSummary: () => usageManager.getUsageSummary(),
            getPricingTable: () => usageManager.getActivePricingTable(),
          }),
        ]);
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
            let effectiveActiveId = index.current_account_id;
            if (detectedEmail) {
              const matched = index.accounts.find(a => a.email.toLowerCase() === detectedEmail.toLowerCase());
              effectiveActiveId = matched?.id ?? null;
            }
            const accountsWithQuota = await Promise.all(index.accounts.map(async summary => {
              let saved;
              try { saved = await accountsManager.getAccount(summary.id); }
              catch { return { id: summary.id, email: summary.email, name: summary.name, disabled: true,
                validation_blocked: true, quota: null, quota_refresh_error: '账号文件无法读取，原文件已保留',
                credentialReadiness: { state: 'needs_authorization', message: '请先核对账号数据文件' } }; }
              if (!saved) return { id: summary.id, email: summary.email, name: summary.name, disabled: true,
                quota: null, quota_refresh_error: '账号文件不存在，请重新读取或保存当前账号' };
              const projectedSaved = projectAccountForIpc(saved ?? summary);
              const isLiveMatched = live?.email?.toLowerCase() === summary.email.toLowerCase() && live.quota;
              const acc = { ...summary, ...projectedSaved, ...(isLiveMatched ? { quota: mergeLiveQuotaWithSaved(projectedSaved?.quota ?? saved.quota, live.quota) } : {}) };
              const q = accountsManager.getAccountQuotaOverview(acc, { nowMs: listNowMs });
              const contract = projectQuotaContract(q);
              const resetTimeStr = formatResetTime(q.resetTime);
              const rev = computeAccountRevision(acc);
              const lastUp = acc.quota_last_updated ?? acc.quota?.last_updated ?? 0;
              const rawErr = acc.quota_refresh_error;
              const cleanErr = (rawErr && /双周期/.test(rawErr)) ? null : (rawErr ?? null);
              return {
                ...acc,
                quota_refresh_error: cleanErr,
                revision: rev,
                quota_last_updated: lastUp,
                quotaLastUpdated: lastUp,
                fiveHourRemaining: q.fiveHourRemaining,
                weeklyRemaining: q.weeklyRemaining,
                geminiFiveHourRemaining: q.geminiFiveHourRemaining,
                geminiWeeklyRemaining: q.geminiWeeklyRemaining,
                geminiFiveHourResetCountdown: q.geminiFiveHourResetCountdown ?? '',
                geminiWeeklyResetCountdown: q.geminiWeeklyResetCountdown ?? '',
                geminiResetCountdown: q.geminiResetCountdown,
                claudeFiveHourRemaining: q.claudeFiveHourRemaining,
                claudeWeeklyRemaining: q.claudeWeeklyRemaining,
                claudeFiveHourResetCountdown: q.claudeFiveHourResetCountdown ?? '',
                claudeWeeklyResetCountdown: q.claudeWeeklyResetCountdown ?? '',
                claudeResetCountdown: q.claudeResetCountdown,
                argonWeeklyRemaining: q.argonWeeklyRemaining,
                argonWeeklyResetCountdown: q.argonWeeklyResetCountdown ?? '',
                argonResetCountdown: q.argonResetCountdown,
                carbonWeeklyRemaining: q.carbonWeeklyRemaining,
                carbonWeeklyResetCountdown: q.carbonWeeklyResetCountdown ?? '',
                carbonResetCountdown: q.carbonResetCountdown,
                staleGroups: q.staleGroups,
                stale_groups: q.staleGroups,
                subscription_tier: normalizeSubscriptionTier(q.subscriptionTier),
                resetTime: resetTimeStr,
                resetCountdown: q.resetCountdown,
                quotaGroups: q.quotaGroups,
                models: q.models,
                ...contract,
                quota: {
                  ...(acc.quota ?? {}),
                  five_hour_remaining: q.fiveHourRemaining,
                  weekly_remaining: q.weeklyRemaining,
                  subscription_tier: normalizeSubscriptionTier(q.subscriptionTier),
                  reset_time: q.resetTime ?? null,
                  reset_countdown: q.resetCountdown,
                  quota_groups: q.quotaGroups,
                  stale_groups: q.staleGroups,
                  models: q.models,
                  ...contract,
                },
              };
            }));
            accountsWithQuota.sort((a, b) => {
              const aActive = a.id === effectiveActiveId ? 1 : 0;
              const bActive = b.id === effectiveActiveId ? 1 : 0;
              return bActive - aActive;
            });
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
            const acc = await accountsManager.getAccount(parsed.id);
            reply({ ok: !!acc, account: projectAccountForIpcNormalized(acc) });
            return;
          }
        })().catch(error => reply({ ok: false, error: sanitizeErrorMessage(error) }));
        return;
      }
      if (command === 'account_switch_preflight') {
        (async () => {
          let appRunning = false;
          let stableRunning = false;
          let insidersRunning = false;
          let hasRunningTask = false;
          let taskReason = '';
          const insidersAppPath = '/Applications/Antigravity - Insiders.app';
          const candidateTargets = [
            target,
            { appPath: insidersAppPath, executable: 'Electron' },
          ];
          try {
            const { stdout: psOut } = await execFileAsync('/bin/ps', ['-ax', '-ww', '-o', 'pid=,pcpu=,args='], { timeout: 3000 });
            for (const line of psOut.split('\n')) {
              const matched = candidateTargets.find(t => line.includes(`${t.appPath}/Contents/`));
              if (matched) {
                if (line.includes(`${matched.appPath}/Contents/MacOS/${matched.executable}`) && !line.includes('Helper')) {
                  appRunning = true;
                  if (matched.appPath === insidersAppPath) {
                    insidersRunning = true;
                  } else {
                    stableRunning = true;
                  }
                }
                const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+/);
                const cpu = m ? parseFloat(m[2] || '0') : 0;
                if (/language_server/i.test(line) && cpu >= 3.0) {
                  hasRunningTask = true;
                  taskReason = '检测到正在执行的 Agent 或模型推理任务';
                } else if (/Helper \((?:Plugin|Renderer)\)/i.test(line) && cpu >= 15.0) {
                  hasRunningTask = true;
                  taskReason = '检测到正在执行的 Agent 或模型推理任务';
                }
              }
            }
          } catch {}
          if (appRunning && !hasRunningTask) {
            const cdpState = await controller.hasRunningAgentTask().catch(() => ({ busy: false, reason: '' }));
            if (cdpState.busy) {
              hasRunningTask = true;
              taskReason = cdpState.reason || '检测到正在执行的 Agent 或模型推理任务';
            }
          }
          if (appRunning && !hasRunningTask) {
            try {
              const nowMs = Date.now();
              const allowedDataDirs = new Set<string>(ALLOWED_DATA_DIRECTORY_NAMES);
              const entries = await readdir(geminiDir, { withFileTypes: true }).catch(() => [] as any[]);
              for (const entry of entries) {
                if (!entry.isDirectory() || !allowedDataDirs.has(entry.name)) continue;
                for (const sub of ['conversations', 'brain']) {
                  const subDir = join(geminiDir, entry.name, sub);
                  const files = await readdir(subDir).catch(() => [] as string[]);
                  for (let i = 0; i < files.length; i += 32) {
                    const stats = await Promise.all(files.slice(i, i + 32).map(f => lstat(join(subDir, f)).catch(() => null)));
                    if (stats.some(st => st && nowMs - st.mtimeMs < 15000)) {
                      hasRunningTask = true;
                      taskReason = '检测到活跃的 Agent 会话任务';
                      break;
                    }
                  }
                  if (hasRunningTask) break;
                }
                if (hasRunningTask) break;
              }
            } catch {}
          }
          reply({
            ok: true,
            appRunning,
            stableRunning,
            insidersRunning,
            safe: !hasRunningTask,
            state: hasRunningTask ? 'busy' : 'safe',
            hasRunningTask,
            taskReason,
          });
        })().catch(error => reply({ ok: false, state: 'unknown', error: sanitizeErrorMessage(error) }));
        return;
      }
      // 只读 IPC 命令直接并发响应，不阻塞在写锁 commandChain 队列后
      const isReadOnlyAutoSwitch = command === 'auto_switch_best' && parsed.execute !== true;
      if (['maintenance_scan', 'maintenance_history', 'account_recovery_info', 'auto_switch_get', 'usage_snapshot_release', 'usage_events', 'usage_summary', 'usage_ledger_review', 'api_pricing_get', 'pricing_sync_status'].includes(command) || isReadOnlyAutoSwitch) {
        (async () => {
          if (command === 'pricing_sync_status') { await syncActiveOfficialModelsToUsageManager(); reply({ ok: true, status: await usageManager.getPricingSyncStatus() }); return; }
          if (command === 'usage_ledger_review') { reply({ ok: true, review: await usageManager.ledgerReview() }); return; }
          if (command === 'maintenance_scan') { reply(await cacheMaintenance.scan({ retentionDays: parsed.retentionDays })); return; }
          if (command === 'maintenance_history') { reply({ ok: true, snapshots: await cacheMaintenance.history() }); return; }
          if (command === 'account_recovery_info') { reply({ ok: true, ...await switchService.recoveryInfo() }); return; }
          if (command === 'auto_switch_get') { reply({ ok: true, config: await accountsManager.getAutoSwitchConfig() }); return; }
          if (isReadOnlyAutoSwitch) {
            const best = await recommendationPreview(parsed.config, true);
            if (!best) { reply({ ok: true, currentAccount: null, bestCandidate: null, account: null, shouldSwitch: false, executed: false, preview: true, reason: '请先保存当前运行账号' }); return; }
            const projected = {
              currentAccount: projectAccountForIpcNormalized(best.currentAccount),
              bestCandidate: projectAccountForIpcNormalized(best.bestCandidate),
              shouldSwitch: best.shouldSwitch,
              reason: best.reason,
            };
            reply({ ok: true, ...projected, account: projected.bestCandidate, executed: false, preview: true, message: best.reason });
            return;
          }
          if (command === 'usage_snapshot_release') { usageManager.releaseSnapshot(String(parsed.snapshotId ?? '')); reply({ ok: true }); return; }
          if (command === 'usage_events') {
            const period = ['today', '7d', '30d', 'all'].includes(String(parsed.period)) ? String(parsed.period) : 'today';
            const targetAccountId = typeof parsed.accountId === 'string' && parsed.accountId ? parsed.accountId : undefined;
            if (targetAccountId) await syncActiveAccountToUsageManager().catch(() => {});
            reply({ ok: true, ...await usageManager.getUsageEvents(period, String(parsed.query ?? ''), Number(parsed.offset), Number(parsed.limit), typeof parsed.snapshotId === 'string' ? parsed.snapshotId : undefined, parsed.pinSnapshot === true, Boolean(parsed.force), targetAccountId) });
            return;
          }
          if (command === 'usage_summary') {
            const force = Boolean(parsed.force);
            const targetAccountId = typeof parsed.accountId === 'string' && parsed.accountId ? parsed.accountId : undefined;
            if (targetAccountId) await syncActiveAccountToUsageManager().catch(() => {});
            const usage = await usageManager.getUsageSummary(force, targetAccountId);
            reply(projectUsagePeriodSummary(usage, parsed.period));
            return;
          }
          if (command === 'api_pricing_get') {
            await syncActiveOfficialModelsToUsageManager();
            const prices = await usageManager.getActivePricingTable();
            reply({ ok: true, prices, pricingStatus: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, priceStatus(v)])) });
            return;
          }
        })().catch(error => reply({ ok: false, error: sanitizeErrorMessage(error) }));
        return;
      }
      commandChain = commandChain.catch(() => {}).then(async () => {
        try {
          if(command==='shortcut_set'){if(!fixture)throw new Error('中英对照已移除');await controller.configureShortcut(parsed.enabled===true);reply({ok:true});return;}
          if(command==='api_pricing_revalue_preview'){reply({ok:true,preview:await usageManager.previewRevalueHistory(parsed.mode === 'unpriced_only' ? 'unpriced_only' : 'force_all')});return;}
          if(command==='api_pricing_revalue'){const mode = parsed.mode === 'unpriced_only' ? 'unpriced_only' : 'force_all';reply({ok:true,...await usageManager.revalueHistory(parsed.confirm===true, { mode, previewId: typeof parsed.previewId === 'string' ? parsed.previewId : undefined })});return;}
          if(command==='api_pricing_revalue_rollback'){reply({ok:true,...await usageManager.restoreRevalueHistory(String(parsed.previewId ?? ''),parsed.confirm===true)});return;}
          if(command==='pricing_sync_set'){await atomicJson(join(stateDir, 'pricing-preferences.json'), {enabled:parsed.enabled===true});usageManager.setAutoRemotePricingSync(parsed.enabled===true);reply({ok:true});return;}
          if(command==='pricing_sync_check'){
            if(parsed.feedUrl!==undefined&&typeof parsed.feedUrl!=='string')throw new Error('价格源地址无效');
            await syncActiveOfficialModelsToUsageManager();
            const res=await usageManager.syncRemotePricing(parsed.feedUrl,true);
            const prices=await usageManager.getActivePricingTable();
            const pricingStatus=Object.fromEntries(Object.entries(prices).map(([k,v])=>[k,priceStatus(v)]));
            reply({ok:true,...res,prices,pricingStatus,status:await usageManager.getPricingSyncStatus()});
            return;
          }
          if(command==='hud_set'){const nextHud=parsed.enabled!==false;await saveRuntimePreferences({hudEnabled:nextHud});await controller.configureHud(nextHud);await writeChain;reply({ok:true,status:controller.snapshot()});return;}
          if(command==='maintenance_clear'){reply(await cacheMaintenance.clear(parsed.token, parsed.selectedNames));return;}
          if(command==='maintenance_restore'){reply(await cacheMaintenance.restore(parsed.snapshotId ?? parsed.id));return;}
          if(command==='maintenance_preflight'){if(tasks.list().some(t=>t.state==='running'))throw new Error('请先等待当前任务完成，再执行维护');if(await cacheMaintenance.hasRunningConversation())throw new Error('检测到正在执行的 Agent 会话任务，请先等待任务结束');reply(await controller.maintenancePreflight());return;}
          if(command==='metadata_scan_start'){const taskId=tasks.begin('deep-scan','读取插件与菜单',async(signal,_progress,commit)=>controller.metadataScan(signal,parsed.nativeMenus,commit));reply({ok:true,taskId});return;}
          if (command === 'account_save_current') {
            const acc = await accountsManager.saveCurrentAccount({ homeDir, appSupportDir });
            reply({ ok: true, account: projectAccountForIpcNormalized(acc) });
            return;
          }
          if (command === 'account_upsert') {
            const acc = await accountsManager.upsertAccount(parsed.data ?? parsed.account ?? parsed);
            reply({ ok: true, account: projectAccountForIpcNormalized(acc) });
            return;
          }
          if (command === 'account_rename') {
            const acc = await accountsManager.renameAccount(String(parsed.id ?? ''), parsed.name);
            reply({ ok: true, account: projectAccountForIpcNormalized(acc) }); return;
          }
          if (command === 'account_delete') {
            await accountsManager.deleteAccount(parsed.id);
            reply({ ok: true });
            return;
          }
          if (command === 'account_reorder') {
            const index = await accountsManager.reorderAccounts(parsed.ids);
            const reordered = index.accounts.map(account => ({
              ...account,
              subscription_tier: normalizeSubscriptionTier((account as any).subscription_tier ?? (account as any).quota?.subscription_tier),
              quota: account.quota ? { ...account.quota, subscription_tier: normalizeSubscriptionTier((account.quota as any).subscription_tier) } : account.quota,
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
          if(command==='account_recovery_clear'){if(parsed.confirm!==true)throw new Error('请先确认清除恢复凭据');reply({ok:true,...await switchService.clearRecovery(String(parsed.digest))});return;}
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
            const taskId = tasks.begin('account-add', '添加 Google 账号', async (_signal, _progress, commit) => {
              commit();
              const acc = await accountsManager.addAccountWithRefreshToken(refreshToken);
              return { ok: true, message: `已添加账号：${acc.email}` };
            });
            reply({ ok: true, taskId }); return;
          }
          if (command === 'quota_refresh_start') {
            const taskId = tasks.begin('quota-refresh', '刷新账号配额', async (signal, _progress, _commit) => {
              // 取消必须能中止后续账号/端点；token 轮换的中间落盘由 accounts.ts 在 signal 检查后阻止。
              const result = await accountsManager.refreshAllQuotas(globalThis.fetch, { signal });
              const incomplete = result.accounts.filter(a => a.quota?.refresh_state?.complete === false).length;
              const warnings = result.accounts.filter(a => a.quota_refresh_error || a.quota?.refresh_state?.complete === false).length;
              const staleAccounts = result.accounts.filter(a => (a.quota?.stale_groups?.length ?? 0) > 0).length;
              const staleGroups = result.accounts.reduce((total, a) => total + (a.quota?.stale_groups?.length ?? 0), 0);
              return { ok: result.failures.length === 0 && incomplete === 0, partial: (result.failures.length > 0 || incomplete > 0) && result.accounts.length > 0,
                incomplete, updated: result.accounts.length, failed: result.failures.length, warnings, staleAccounts, staleGroups,
                message: result.failures.length
                  ? `已读取 ${result.accounts.length} 个账号；${result.failures.length} 个刷新失败。详情见账号卡片。`
                  : `已读取 ${result.accounts.length} 个账号的配额${incomplete ? `；${incomplete} 个账号部分刷新` : ''}${staleAccounts ? `；${staleAccounts} 个账号的 ${staleGroups} 个分组沿用上次记录` : ''}。` };
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
            if (wantsExecute && !confirmed) throw new Error('执行切号需要显式确认（execute:true 且 confirmed:true）；本次未执行任何切换');
            const best = await recommendationPreview(parsed.config, false);
            if (!best) { reply({ ok: true, currentAccount: null, bestCandidate: null, account: null, shouldSwitch: false, executed: false, preview: true, reason: '请先保存当前运行账号' }); return; }
            const projected = {
              currentAccount: projectAccountForIpcNormalized(best.currentAccount),
              bestCandidate: projectAccountForIpcNormalized(best.bestCandidate),
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
              message: best.reason, ...(wantsExecute ? { skipReason: '当前无需切换，未执行任何切换' } : {}) });
            return;
          }
          if (command === 'quota_refresh') {
            const acc = await accountsManager.refreshQuota(parsed.id);
            const projected = projectAccountForIpcNormalized(acc);
            const normalizedQuota = acc.quota ? { ...acc.quota, ...projectQuotaContract(accountsManager.getAccountQuotaOverview(acc)), subscription_tier: normalizeSubscriptionTier((acc.quota as any).subscription_tier) } : acc.quota;
            const partial = acc.quota?.refresh_state?.complete === false || !!acc.quota_refresh_error;
            reply({ ok: true, partial, message: partial ? '已读取本轮可用配额；部分数据未返回，详情见账号卡片。' : '已读取最新配额；各模型未返回的数据会单独标明。',
              quota: normalizedQuota, account: projected, subscription_tier: normalizeSubscriptionTier(projected?.subscription_tier) });
            return;
          }
          if (command === 'quota_refresh_all') {
            const result = await accountsManager.refreshAllQuotas();
            const accounts = result.accounts.map(account => projectAccountForIpcNormalized(account));
            reply({ ok: result.failures.length === 0,
              accounts,
              failures: result.failures,
              partial: (result.failures.length > 0 || accounts.some((account: any) => account?.refreshState?.complete === false)) && accounts.length > 0,
              staleAccounts: accounts.filter((account: any) => (account?.quota?.stale_groups?.length ?? 0) > 0).length });
            return;
          }
          if (command === 'pause' || command === 'restore') { await saveRuntimePreferences({translationEnabled:false});await tasks.stop();await controller.pause(); }
          else if (command === 'resume' || command === 'reapply') {await saveRuntimePreferences({translationEnabled:true});await controller.resume();}
          else if (command === 'toggle') {if(!fixture)throw new Error('中英对照已移除');await controller.toggleLanguage();}
          else if (command === 'reload') await store.reload();
          else if (command === 'stop') { await accountLogin.close(); await tasks.stop();store.close(); await controller.stop(); stopping = true; }
          else throw new Error('未知操作');
          await writeChain; await cacheChain.catch(() => {});
          reply({ ok: true, status: controller.snapshot() });
          if (stopping) { server.close(); await unlink(socketPath).catch(() => {}); await backendLease?.release(); setTimeout(() => process.exit(0), 100); }
        } catch (error) { reply({ ok: false, error: sanitizeErrorMessage(error) }); }
      });
    });
  });
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(socketPath, resolveListen); }); await chmod(socketPath, 0o600);
  const stop = async (code = 0) => {
    if (stopping) return; stopping = true;
    await accountLogin.close(); await tasks.stop();store.close(); await controller.stop(); await writeChain; await cacheChain.catch(() => {}); server.close(); await unlink(socketPath).catch(() => {}); await backendLease?.release(); process.exit(code);
  };
  process.off('SIGTERM', earlySignalExit); process.off('SIGINT', earlySignalExit);
  process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
  // A single bad payload must not take the whole localisation helper down; log it and keep serving.
  process.on('uncaughtException', error => { console.error(`[GravityBox] ${sanitizeError(error?.stack ?? error?.message ?? '未捕获异常')}`); if (stopping) void stop(1); });
  process.on('unhandledRejection', reason => { console.error(`[GravityBox] ${reason instanceof Error ? sanitizeError(reason.message) : '后台任务异常'}`); });
  await controller.start();
  void syncActiveAccountToUsageManager(true).catch(() => {});
  } catch (error) {
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
  if (resolve(entry) === modulePath) return true;
  try { return realpathSync(entry) === realpathSync(modulePath); } catch { return false; }
}
if (process.env.GRAVITYBOX_IMPORT_ONLY !== '1' && isDirectEntry()) {
  run().catch(error => { console.error(`[GravityBox] ${sanitizeError((error as Error)?.message ?? '启动失败')}`); process.exitCode = 1; });
}
