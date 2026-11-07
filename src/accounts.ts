import { allApplicationTargets, applicationTarget, channelStateDirectory, matchingTargetForLanguageServerCommand, type ApplicationTarget } from './application-target.js';
import { inspectBundle, verifyLanguageServerIdentity } from './discovery.js';
import { lstat, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import * as https from 'node:https';
import * as http from 'node:http';
import { atomicJson, commitAccountAndIndex, recoverAccountCommit, commitFileSet, recoverFileSet } from './files.js';
import { ReentrantMutex } from './mutex.js';
import { withProcessLease } from './process-lock.js';
import { ProtobufReader } from './usage.js';
import { decodeTopicRow } from './account-state.js';
import {
  applyFamilyWindows,
  buildArgonStatus,
  classifyFamily,
  familyWindowsFromGroups,
  familyModelQuotaFromModels,
  legacyFromFamilyWindows,
  mergeGroupSets,
  mergeGroupsWithPrevious,
  mergeModelCatalogues,
  mergeModelsWithPrevious,
  mergeWindowStatuses,
  normalizeCloudGroups,
  normalizeCloudModels,
  normalizeIndependentArgonQuota,
  normalizeLiveGroups,
  normalizeLiveModels,
  normalizeResetTime,
  normalizeStoredGroups,
  normalizeFraction,
  type ArgonStatus,
  type Family,
  type FamilyWindows,
  type NormalizedGroup,
  type NormalizedModel,
  type QuotaSource,
  type WindowStatus,
  type WindowKind,
} from './quota.js';

const execFileAsync = promisify(execFile);

export interface KeychainAdapter {
  readPassword(service: string, account: string): Promise<string | null>;
  writePassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<void>;
}

export class SystemKeychainAdapter implements KeychainAdapter {
  async readPassword(service: string, account: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('/usr/bin/security', [
        'find-generic-password',
        '-s',
        service,
        '-a',
        account,
        '-w',
      ], { timeout: 5000 });
      return stdout.trim() || null;
    } catch (error) {
      if ((error as { code?: number }).code === 44) return null;
      throw new Error('无法读取账号钥匙串，请检查本机访问权限');
    }
  }

  async writePassword(service: string, account: string, password: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const q = (val: string) => `"${String(val).replace(/[\\"\r\n]/g, m => (m === '\r' || m === '\n' ? '' : `\\${m}`))}"`;
      // 通过 security -i 批处理从 stdin 传入完整命令与密码，既不在 argv 暴露凭据，也不触发 /dev/tty getpass() 阻塞
      const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish(new Error('无法保存账号钥匙串，访问超时'));
      }, 5000);

      child.stdin.on('error', () => {});
      child.stdin.end(`add-generic-password -U -s ${q(service)} -a ${q(account)} -w ${q(password)}\n`);

      child.stderr.on('data', () => {});
      child.on('close', code => {
        if (code === 0) finish();
        else finish(new Error('无法保存账号钥匙串，原凭据访问权限可能受限'));
      });
      child.on('error', () => {
        finish(new Error('无法保存账号钥匙串，原凭据访问权限可能受限'));
      });
    });
  }

  async deletePassword(service: string, account: string): Promise<void> {
    try {
      await execFileAsync('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account], { timeout: 5000 });
    } catch (error) { if ((error as { code?: number }).code !== 44) throw new Error('无法恢复账号钥匙串'); }
  }
}

export class MockKeychainAdapter implements KeychainAdapter {
  private store = new Map<string, string>();

  async readPassword(service: string, account: string): Promise<string | null> {
    return this.store.get(`${service}:${account}`) ?? null;
  }

  async writePassword(service: string, account: string, password: string): Promise<void> {
    this.store.set(`${service}:${account}`, password);
  }

  async deletePassword(service: string, account: string): Promise<void> {
    this.store.delete(`${service}:${account}`);
  }
}


export type CloudProviderContext = { origin: string; userAgent: string; appVersion: string; clientSubType?: string; identityVersion?: 2 };
const CLOUD_ORIGINS = new Set(['https://cloudcode-pa.googleapis.com','https://daily-cloudcode-pa.googleapis.com','https://daily-cloudcode-pa.sandbox.googleapis.com']);
export function cloudOriginFromCommand(command: string, target = applicationTarget()): string | null {
  if (!command.startsWith(target.appPath + '/Contents/Resources/bin/language_server ')) return null;
  const dataDirectory = command.match(/(?:^|\s)--app_data_dir(?:=|\s+)([^\s"]+)/)?.[1];
  if (dataDirectory && dataDirectory !== target.dataDirectoryName) return null;
  const value=command.match(/(?:^|\s)--cloud_code_endpoint(?:=|\s+)([^\s"]+)/)?.[1];
  return value && CLOUD_ORIGINS.has(value.replace(/\/$/,'')) ? value.replace(/\/$/,'') : null;
}
/** The hub component is significant: omitting it makes CCPA return a different model/quota catalogue. */
export function cloudProviderContextFromCommand(command: string, appVersion: string, target = applicationTarget()): CloudProviderContext | null {
  const origin = cloudOriginFromCommand(command, target);
  const option = (name: string) => command.match(new RegExp('(?:^|\\s)--' + name + '(?:=|\\s+)([^\\s"]+)'))?.[1];
  const clientSubType = option('subclient_type') ?? '';
  if (!origin || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(appVersion)
    || (clientSubType !== '' && !/^[a-z][a-z0-9_-]{0,31}$/.test(clientSubType))
    || (option('override_user_agent_name') ?? 'antigravity') !== 'antigravity'
    || (option('override_ide_version') ?? appVersion) !== appVersion) return null;
  return { origin, appVersion, clientSubType, identityVersion: 2,
    userAgent: ['antigravity', clientSubType, appVersion].filter(Boolean).join('/') };
}
export function validCachedCloudProviderContext(value: any, appVersion: string, target = applicationTarget()): value is CloudProviderContext {
  if (!value || value.identityVersion !== 2 || !CLOUD_ORIGINS.has(value.origin)
    || typeof value.clientSubType !== 'string'
    || (value.clientSubType !== '' && !/^[a-z][a-z0-9_-]{0,31}$/.test(value.clientSubType))) return false;
  const expected = cloudProviderContextFromCommand(target.appPath + '/Contents/Resources/bin/language_server --cloud_code_endpoint '
    + value.origin + (value.clientSubType ? ' --subclient_type ' + value.clientSubType : ''), appVersion, target);
  return !!expected && value.appVersion === expected.appVersion && value.userAgent === expected.userAgent;
}
class CloudQuotaAuthorityError extends Error {}
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
  for (const family of ['gemini', 'claude', 'argon'] as const) {
    const status = window === '5h' ? familyWindows[family].fiveHour : familyWindows[family].weekly;
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
  return family === 'gemini' ? 'Gemini' : family === 'claude' ? 'Claude/GPT' : family === 'argon' ? 'Argon' : '其他';
}

/**
 * 格式化相对时间倒计时（如 "6天 16小时后重置"、"1小时 25分后重置"、"即将重置"、"重置时间已过"）
 * nowMs 允许同一份载荷使用同一参考时刻，避免同屏倒计时出现多个值。
 */
export function formatResetCountdown(resetTime: string | number | null | undefined, nowMs: number = Date.now()): string {
  if (!resetTime) return '';
  const tsMs = typeof resetTime === 'number'
    ? (resetTime < 1e11 ? resetTime * 1000 : resetTime)
    : Date.parse(resetTime);
  if (isNaN(tsMs)) return String(resetTime);

  const diffMs = tsMs - nowMs;
  if (diffMs <= 0) {
    return '重置时间已过';
  }
  if (diffMs <= 60000) {
    return '即将重置';
  }

  const totalMin = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const mins = totalMin % 60;

  if (days > 0) {
    return `${days}天 ${hours}小时后重置`;
  }
  if (hours > 0) {
    return `${hours}小时 ${mins}分后重置`;
  }
  return `${mins}分钟后重置`;
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

/**
 * 本地免密 RPC 请求 helper，自动处理 HTTP/HTTPS 与自签名证书
 */
export async function localRpcFetch(
  protocol: 'http' | 'https',
  port: number,
  path: string,
  csrfToken: string,
  body = '{}'
): Promise<any> {
  return new Promise((resolveReply, rejectReply) => {
    const isHttps = protocol === 'https';
    const client = isHttps ? https : http;
    const req = client.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': csrfToken,
          'Content-Length': Buffer.byteLength(body),
        },
        rejectUnauthorized: false,
        timeout: 2500,
      },
      res => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolveReply(JSON.parse(data));
            } catch (err) {
              rejectReply(err);
            }
          } else {
            rejectReply(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', rejectReply);
    req.on('timeout', () => {
      req.destroy();
      rejectReply(new Error('本地 RPC 超时'));
    });
    req.write(body);
    req.end();
  });
}

try {
  process.loadEnvFile?.();
} catch (error: any) {
  if (error?.code !== 'ENOENT') {
    // ignore
  }
}
try {
  process.loadEnvFile?.(join(homedir(), 'Library', 'Application Support', 'GravityBox', '.env'));
} catch (error: any) {
  if (error?.code !== 'ENOENT') {
    // ignore
  }
}

export function getGoogleClientId(): string {
  return process.env.GRAVITYBOX_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';
}
export function getGoogleClientSecret(): string {
  return process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '';
}
export const GOOGLE_CLIENT_ID = getGoogleClientId();
export const GOOGLE_CLIENT_SECRET = getGoogleClientSecret();

export const CLOUD_CODE_LOAD_PROJECT_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
];

export const QUOTA_API_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
];

export const QUOTA_SUMMARY_ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
];

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
  // ---- task-38 新字段（均可选，旧数据容错） ----
  model_id?: string;
  model_or_alias?: string | null;
  family?: Family;
  is_argon?: boolean;
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
  source?: 'live' | 'cloud' | 'external';
  /**
   * 本轮刷新未返回、沿用上次记录的分组：名称 + 该分组最后一次真实采样时间。
   * 存在该字段时顶层 last_updated 不再被刷新时刻覆盖，而是取最旧分组的观察时间。
   */
  stale_groups?: { name: string; observed_at: number }[];
  /** task-38：本轮刷新完整性 / 端点来源 / 缺失 family 与窗口。 */
  refresh_state?: QuotaRefreshState;
  /** task-38：机器可读告警码（前缀 CODE:）。 */
  quota_warnings?: string[];
}

export interface LiveLanguageServerStatus {
  email: string;
  name?: string | null;
  tier: string;
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

/** task-38：账号渲染指纹覆盖规范化配额快照（availability/disabled/own/family窗口/refresh_state/warnings）。 */
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

export interface AccountExportItem {
  email: string;
  refresh_token: string;
  name?: string | null;
  oauth_client_key?: string | null;
  is_gcp_tos: boolean;
  project_id?: string | null;
  custom_label?: string | null;
}

export interface AccountExportResponse {
  schema_version: number;
  accounts: AccountExportItem[];
  /** false 表示 refresh_token 已脱敏，只能用于核对账号清单，不能用于迁移/恢复。 */
  tokens_included?: boolean;
  confirm_required?: boolean;
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
  const hex = (len: number) => {
    let s = '';
    while (s.length < len) s += Math.random().toString(16).slice(2);
    return s.slice(0, len);
  };
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

/** task-38 规范化 <-> 持久化 legacy 形状转换（集中在 accounts 边界的适配层）。 */
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
  const family: Family = model.family ?? classifyFamily({ modelId: model.name, displayName, modelOrAlias: model.model_or_alias });
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
    is_argon: model.is_argon ?? family === 'argon',
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
  // task-38 新增（稳定合同）
  argonStatus: ArgonStatus;
  familyWindows: {
    gemini: { fiveHour: QuotaOverviewWindowStatus | null; weekly: QuotaOverviewWindowStatus | null };
    claude: { fiveHour: QuotaOverviewWindowStatus | null; weekly: QuotaOverviewWindowStatus | null };
    argon: { fiveHour: QuotaOverviewWindowStatus | null; weekly: QuotaOverviewWindowStatus | null };
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

export class AccountsManager {
  private target: ApplicationTarget;
  private accountsDir: string;
  private indexPath: string;
  private autoSwitchPath: string;
  private tombstonesPath: string;
  private syncedExternal = false;
  private reconciled = false;
  private externalDir?: string;
  private inFlightRefreshes = new Map<string, Promise<Account>>();
  private mutex = new ReentrantMutex();
  private liveProbeCache: { status: LiveLanguageServerStatus | null; expiresAt: number } | null = null;
  private inFlightProbe: Promise<LiveLanguageServerStatus | null> | null = null;
  private providerOverride?: CloudProviderContext;
  private providerContextCache: { value: CloudProviderContext; expiresAt: number } | null = null;
  private inFlightProviderContext: Promise<CloudProviderContext | null> | null = null;
  private inFlightExternalSync: Promise<{ imported: number; updated: number; skipped: number; found: number }> | null = null;
  private indexCache: { mtimeMs: number; size: number; index: AccountIndex } | null = null;
  private accountCache = new Map<string, { mtimeMs: number; size: number; account: Account; digest: string }>();

  private async withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    return this.mutex.run(() => withProcessLease(join(this.stateDir, 'accounts-write.lock'), action), { label: 'AccountsManager.writeLock' });
  }

  public async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    return this.withWriteLock(action);
  }

  constructor(private stateDir: string, options: { externalDir?: string; providerContext?: CloudProviderContext; target?: ApplicationTarget } = {}) {
    this.target = options.target ?? applicationTarget();
    this.providerOverride=options.providerContext;
    this.externalDir = options.externalDir ?? (stateDir === join(homedir(), 'Library', 'Application Support', 'GravityBox') ? join(homedir(), '.antigravity_tools') : undefined);
    this.accountsDir = join(stateDir, 'accounts');
    this.indexPath = join(stateDir, 'accounts.json');
    this.autoSwitchPath = join(stateDir, 'auto_switch.json');
    this.tombstonesPath = join(stateDir, 'accounts-deleted.json');
  }

  public setTarget(target: ApplicationTarget): void {
    if (this.target.channel !== target.channel || this.target.appPath !== target.appPath) {
      this.liveProbeCache = null;
      this.inFlightProbe = null;
      this.providerContextCache = null;
      this.inFlightProviderContext = null;
      this.desktopEmailCache = null;
    }
    this.target = target;
  }

  public getTarget(): ApplicationTarget {
    return this.target;
  }

  private async resolveProviderContext(fetchImpl: typeof fetch): Promise<CloudProviderContext | null> {
    if(this.providerOverride)return this.providerOverride;
    // Injected transports use explicit fixtures; production follows the signed desktop instance.
    if(fetchImpl!==globalThis.fetch)return null;
    const now=Date.now();
    if(this.providerContextCache&&now<this.providerContextCache.expiresAt)return this.providerContextCache.value;
    if(this.inFlightProviderContext)return await this.inFlightProviderContext;
    const task=(async():Promise<CloudProviderContext>=>{
      const candidates = [this.target, ...allApplicationTargets().filter(t => t.appPath !== this.target.appPath)];
      const text=(await execFileAsync('/bin/ps',['-ax','-ww','-o','args='])).stdout;
      const installedTargets: Array<{ target: ApplicationTarget; version: string }> = [];
      for (const candidate of candidates) {
        try {
          const installed = await inspectBundle(candidate.appPath);
          installedTargets.push({ target: candidate, version: installed.version });
        } catch {}
      }
      for (const { target: candidate, version } of installedTargets) {
        const context = text.split('\n').map(line => cloudProviderContextFromCommand(line.trim(), version, candidate)).find(Boolean);
        if (context) {
          await atomicJson(join(channelStateDirectory(this.stateDir, candidate.channel), 'quota-provider.json'), context);
          this.providerContextCache = { value: context, expiresAt: Date.now() + 15000 };
          return context;
        }
      }
      for (const { target: candidate, version } of installedTargets) {
        try {
          const cached = JSON.parse(await readFile(join(channelStateDirectory(this.stateDir, candidate.channel), 'quota-provider.json'), 'utf8')) as CloudProviderContext;
          if (validCachedCloudProviderContext(cached, version, candidate)) {
            this.providerContextCache = { value: cached, expiresAt: Date.now() + 15000 };
            return cached;
          }
        } catch {}
      }
      throw new CloudQuotaAuthorityError('无法确认 Antigravity 实际配额服务，请先运行官方应用；未采用其他环境的默认配额');
    })();
    this.inFlightProviderContext=task;
    try{return await task;}finally{this.inFlightProviderContext=null;}
  }

  /**
   * 删除标记（tombstone）：账号删除成功后记录 id+email。
   * 作用：崩溃/外部同步/异常残留把账号文件写回目录时，reconcile 不得把它当成“孤儿文件自愈”复活。
   * 用户显式重新添加/保存同一账号时清除标记。
   */
  private async loadTombstones(): Promise<{ id: string; email: string; at: number }[]> {
    try {
      const parsed = JSON.parse(await readFile(this.tombstonesPath, 'utf8'));
      return Array.isArray(parsed)
        ? parsed.filter((item: any) => item && typeof item.id === 'string' && typeof item.email === 'string')
        : [];
    } catch {
      return [];
    }
  }

  private async clearTombstones(id?: string | null, email?: string | null): Promise<void> {
    if (!id && !email) return;
    const list = await this.loadTombstones();
    if (list.length === 0) return;
    const key = (email || '').toLowerCase();
    const next = list.filter(item => item.id !== id && (!key || item.email.toLowerCase() !== key));
    if (next.length !== list.length) await atomicJson(this.tombstonesPath, next);
  }

  async init(): Promise<void> {
    await mkdir(this.accountsDir, { recursive: true, mode: 0o700 });
    const journal = join(this.stateDir, 'account-delete-commit.json');
    let hasJournal = false;
    try {
      await lstat(journal);
      hasJournal = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (hasJournal) {
      await this.withWriteLock(async () => {
        let changes: { path: string }[];
        try { changes = JSON.parse(await readFile(journal, 'utf8')).changes; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        const accountPaths = (await readdir(this.accountsDir)).filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name)).map(name => join(this.accountsDir, name));
        // A deleted account path can already be absent after an interrupted commit.
        for (const change of changes ?? []) if (typeof change.path === 'string' && change.path.startsWith(this.accountsDir + '/') && /^[a-zA-Z0-9_-]+\.json$/.test(change.path.slice(this.accountsDir.length+1))) accountPaths.push(change.path);
        await recoverFileSet(journal, [this.indexPath, this.tombstonesPath, ...accountPaths]);
      });
    }
    if (!this.syncedExternal && this.externalDir) {
      this.syncedExternal = true;
      await this.syncFromExternalAgySwitch().catch(() => {});
    }
    if (!this.reconciled) {
      this.reconciled = true;
      await this.reconcileIndex().catch(() => {});
    }
  }

  /**
   * accounts/ 是事实来源，accounts.json 只是可重建的索引：进程可能在"账号文件已写、
   * 索引未写"之间崩溃，而 loadIndex() 对语法合法的旧索引不会自动 rebuild，
   * 该账号就会永久不出现在列表里。启动时对齐一次目录与索引即可自愈。
   */
  private async reconcileIndex(): Promise<void> {
    const index = await this.loadIndex();
    const names = (await readdir(this.accountsDir).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
    const files = new Set(names.map(name => name.slice(0, -5)));
    const ids = new Set(index.accounts.map(account => account.id));
    const tombstones = await this.loadTombstones();
    const tombIds = new Set(tombstones.map(item => item.id));
    const tombEmails = new Set(tombstones.map(item => item.email.toLowerCase()));
    let dirty = files.size !== ids.size;
    if (!dirty) for (const id of files) if (!ids.has(id)) { dirty = true; break; }
    if (!dirty) for (const id of ids) if (!files.has(id)) { dirty = true; break; }
    // 已删除账号的文件重新出现（外部同步/异常残留）时，必须重建索引以清除，不得复活。
    if (!dirty) for (const id of files) if (tombIds.has(id)) { dirty = true; break; }
    if (!dirty) for (const summary of index.accounts) {
      if (tombIds.has(summary.id) || tombEmails.has(String(summary.email || '').toLowerCase())) { dirty = true; break; }
    }
    if (!dirty) {
      for (const summary of index.accounts) {
        const acc = await this.getAccount(summary.id);
        if (!acc) {
          dirty = true;
          break;
        }
        if (summary.revision && computeAccountRevision(acc) !== summary.revision) {
          dirty = true;
          break;
        }
        if (!summary.revision && (acc.email !== summary.email || acc.name !== summary.name || Boolean(acc.disabled) !== Boolean(summary.disabled))) {
          dirty = true;
          break;
        }
      }
    }
    if (dirty) await this.rebuildIndex();
  }

  async syncFromExternalAgySwitch(): Promise<{ imported: number; updated: number; skipped: number; found: number }> {
    if (!this.externalDir) return { imported: 0, updated: 0, skipped: 0, found: 0 };
    if (this.inFlightExternalSync) {
      return await this.inFlightExternalSync;
    }
    const job = this.doSyncFromExternalAgySwitch();
    this.inFlightExternalSync = job;
    try {
      return await job;
    } finally {
      this.inFlightExternalSync = null;
    }
  }

  private async doSyncFromExternalAgySwitch(): Promise<{ imported: number; updated: number; skipped: number; found: number }> {
    if (!this.externalDir) return { imported: 0, updated: 0, skipped: 0, found: 0 };
    // Set before init to avoid recursively triggering the startup synchronization.
    this.syncedExternal = true;
    await mkdir(this.accountsDir, { recursive: true, mode: 0o700 });
    const extAccountsDir = join(this.externalDir, 'accounts');
    let imported = 0, updatedCount = 0, skipped = 0, found = 0;
    const files = await readdir(extAccountsDir).catch(error => { if (error.code === 'ENOENT') return []; throw new Error('无法读取 AntiGravity Switch 账号目录，请检查访问权限'); });
    if (files.length === 0) return { imported: 0, updated: 0, skipped: 0, found: 0 };
    const parsedExternals: Account[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const ext = JSON.parse(sanitizeJsonString(await readFile(join(extAccountsDir, f)))) as Account;
        if (!ext?.email || !ext?.token?.refresh_token) { skipped++; continue; }
        found++;
        parsedExternals.push(ext);
      } catch { skipped++; }
    }
    if (parsedExternals.length === 0) return { imported: 0, updated: 0, skipped, found };
    await this.withWriteLock(async () => {
      let changed = false;
      const tombstones = await this.loadTombstones();
      const tombIds = new Set(tombstones.map(item => item.id));
      const tombEmails = new Set(tombstones.map(item => item.email.toLowerCase()));
      const localFiles = await readdir(this.accountsDir).catch(() => []);
      const localByEmail = new Map<string, Account>();
      for (const lf of localFiles) {
        if (!lf.endsWith('.json')) continue;
        try {
          const acc = JSON.parse(sanitizeJsonString(await readFile(join(this.accountsDir, lf)))) as Account;
          if (acc?.email) localByEmail.set(acc.email.toLowerCase(), acc);
        } catch {}
      }
      for (const ext of parsedExternals) {
        if (tombIds.has(String(ext.id || '')) || tombEmails.has(ext.email.toLowerCase())) { skipped++; continue; }
        const existing = localByEmail.get(ext.email.toLowerCase());
        if (!existing) {
          const id = /^[a-zA-Z0-9_-]+$/.test(ext.id || '') && ![...localByEmail.values()].some(a => a.id === ext.id) ? ext.id : randomUUID();
          const merged: Account = { ...ext, id, quota: ext.quota ? { ...ext.quota, source: 'external' } : ext.quota };
          await atomicJson(join(this.accountsDir, `${id}.json`), merged);
          localByEmail.set(ext.email.toLowerCase(), merged);
          changed = true; imported++;
        } else {
          let updated = false;
          if (!existing.name && ext.name) { existing.name = ext.name; updated = true; }
          if (!existing.custom_label && ext.custom_label) { existing.custom_label = ext.custom_label; updated = true; }
          // A rejected account scope must not briefly revive an older, unverified external 100%.
          // Credential sync is independent and continues below.
          const rejectedScope=existing.quota?.quota_warnings?.some(value=>value.startsWith('UNVERIFIED_CLOUD_SCOPE:'));
          if (ext.quota && !rejectedScope && (!existing.quota || (ext.quota.last_updated ?? 0) > (existing.quota.last_updated ?? 0))) {
            existing.quota = { ...ext.quota, source: 'external' };
            updated = true;
          }
          if ((ext.token.expiry_timestamp ?? 0) > (existing.token.expiry_timestamp ?? 0) || existing.token.access_token === 'pending_refresh') {
            existing.token = { ...existing.token, ...ext.token };
            updated = true;
          }
          if (updated) {
            await atomicJson(join(this.accountsDir, `${existing.id}.json`), existing);
            changed = true; updatedCount++;
          }
        }
      }
      if (changed) {
        await this.rebuildIndex();
      }
    });
    return { imported, updated: updatedCount, skipped, found };
  }

  async loadIndex(): Promise<AccountIndex> {
    await this.init();
    let hasCommitJournal = false;
    try {
      await lstat(`${this.indexPath}.commit.json`);
      hasCommitJournal = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (hasCommitJournal) {
      await this.withWriteLock(() => recoverAccountCommit(this.indexPath));
    }
    try {
      const st = await lstat(this.indexPath);
      if (this.indexCache && this.indexCache.mtimeMs === st.mtimeMs && this.indexCache.size === st.size) {
        return structuredClone(this.indexCache.index);
      }
      const raw = await readFile(this.indexPath);
      const sanitized = sanitizeJsonString(raw);
      if (sanitized.trim()) {
        const parsed = JSON.parse(sanitized);
        if (parsed && Array.isArray(parsed.accounts)) {
          const cleanAccounts = parsed.accounts.map((acc: AccountSummary) => ({
            ...acc,
            quota_refresh_error: acc.quota_refresh_error && /双周期/.test(acc.quota_refresh_error) ? null : acc.quota_refresh_error,
            quota: acc.quota ? {
              ...acc.quota,
              subscription_tier: acc.quota.subscription_tier,
            } : acc.quota,
          }));
          const result: AccountIndex = {
            version: '2.0',
            accounts: cleanAccounts,
            current_account_id: parsed.current_account_id ?? null,
            current_target_ide: parsed.current_target_ide ?? null,
            current_ide_account_id: parsed.current_ide_account_id ?? null,
            current_vscode_account_id: parsed.current_vscode_account_id ?? null,
          };
          this.indexCache = { mtimeMs: st.mtimeMs, size: st.size, index: structuredClone(result) };
          return result;
        }
      }
    } catch {
      // Index missing or corrupted, attempt recovery
    }

    return await this.rebuildIndex();
  }

  async saveIndex(index: AccountIndex): Promise<void> {
    await this.init();
    return this.withWriteLock(async () => {
      await atomicJson(this.indexPath, index);
    });
  }

  async rebuildIndex(): Promise<AccountIndex> {
    await this.init();
    return this.withWriteLock(async () => {
      let previous: Partial<AccountIndex> = {};
      try { previous = JSON.parse(await readFile(this.indexPath, 'utf8')); } catch {}
      const files = await readdir(this.accountsDir).catch(() => []);
      const summaries: AccountSummary[] = [];
      const tombstones = await this.loadTombstones();
      const tombIds = new Set(tombstones.map(item => item.id));
      const tombEmails = new Set(tombstones.map(item => item.email.toLowerCase()));

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(this.accountsDir, file));
          const acc = JSON.parse(sanitizeJsonString(raw)) as Account;
          if (acc && acc.id && (tombIds.has(acc.id) || tombEmails.has(String(acc.email || '').toLowerCase()))) {
            // 已删除账号的残留文件：清理而不是复活。
            await unlink(join(this.accountsDir, file)).catch(() => {});
            continue;
          }
          if (acc && acc.id && acc.email) {
            summaries.push({
              id: acc.id,
              email: acc.email,
              name: acc.name,
              disabled: acc.disabled ?? false,
              disabled_reason: acc.disabled_reason,
              disabled_at: acc.disabled_at,
              protected_models: acc.protected_models ?? [],
              created_at: acc.created_at ?? Date.now() / 1000,
              last_used: acc.last_used ?? Date.now() / 1000,
              custom_label: acc.custom_label,
              quota: acc.quota,
              quota_refresh_error: acc.quota_refresh_error,
              revision: computeAccountRevision(acc),
              quota_last_updated: acc.quota?.last_updated ?? 0,
            });
          }
        } catch {
          // ignore corrupted single account file
        }
      }

      // Sort by last_used desc
      const order = new Map((Array.isArray(previous.accounts) ? previous.accounts : []).map((a, i) => [a.id, i]));
      summaries.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || (b.last_used ?? 0) - (a.last_used ?? 0));
      const index: AccountIndex = {
        ...previous,
        version: '2.0',
        accounts: summaries,
        current_account_id: summaries.some(a => a.id === previous.current_account_id) ? previous.current_account_id! : summaries[0]?.id ?? null,
      };
      await atomicJson(this.indexPath, index);
      return index;
    });
  }

  private channelAccount(account: Account): Account {
    // Retain retired fields on disk, but never present Insiders quota as stable quota.
    return account;
  }

  async getAccount(id: string): Promise<Account | null> {
    await this.init();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('账号 ID 无效');
    const filePath = join(this.accountsDir, `${id}.json`);
    try {
      const st = await lstat(filePath);
      const cached = this.accountCache.get(id);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        const clone = structuredClone(cached.account);
        Object.defineProperty(clone, '_expectedFileDigest', { value: cached.digest, writable: true, configurable: true, enumerable: false });
        return this.channelAccount(clone);
      }
      const raw = await readFile(filePath);
      const acc = JSON.parse(sanitizeJsonString(raw)) as Account;
      if (acc) {
        if (acc.quota_refresh_error && /双周期/.test(acc.quota_refresh_error)) {
          acc.quota_refresh_error = null;
        }
        const digest = createHash('sha256').update(raw).digest('hex');
        this.accountCache.set(id, { mtimeMs: st.mtimeMs, size: st.size, account: structuredClone(acc), digest });
        Object.defineProperty(acc, '_expectedFileDigest', {value:digest,writable:true,configurable:true,enumerable:false});
      }
      return acc ? this.channelAccount(acc) : acc;
    } catch (error) {
      this.accountCache.delete(id);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('账号文件无法读取或格式损坏，原文件已保留');
    }
  }

  async saveAccount(
    account: Account,
    options?: { expectedRefreshToken?: string; isRefreshUpdate?: boolean }
  ): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(account.id)) throw new Error('账号 ID 无效');
    await this.init();

    return this.withWriteLock(async () => {
      const expectedRefresh = options?.expectedRefreshToken ?? (account as any)._expectedRefreshToken;
      const isRefreshUpdate = options?.isRefreshUpdate ?? (account as any)._isRefreshUpdate ?? false;

      const accountPath = join(this.accountsDir, `${account.id}.json`);
      const diskAccount = await this.getAccount(account.id);
      const expectedFileDigest=(account as any)._expectedFileDigest;
      if (!isRefreshUpdate && expectedFileDigest && (!diskAccount || expectedFileDigest !== (diskAccount as any)._expectedFileDigest)) throw new Error('账号记录已在其他操作中更新，请重新读取后保存');

      if (expectedRefresh !== undefined && diskAccount) {
        if (diskAccount.token.refresh_token !== expectedRefresh) {
          throw new Error('账号凭据已更新，停止覆盖新的登录记录');
        }
      }

      if (isRefreshUpdate && !diskAccount) {
        throw new Error(`账号 ${account.id} 已被删除，停止刷新写入`);
      }

      let toSave: Account = account;
      if (isRefreshUpdate && diskAccount) {
        toSave = {
          ...diskAccount,
          name: diskAccount.name || account.name,
          token: {
            ...diskAccount.token,
            ...account.token,
          },
          custom_label: diskAccount.custom_label,
          disabled: diskAccount.disabled,
          disabled_reason: diskAccount.disabled_reason,
          disabled_at: diskAccount.disabled_at,
          protected_models: diskAccount.protected_models,
          created_at: diskAccount.created_at,
          quota: account.quota,
          quota_refresh_error: account.quota_refresh_error,
        };
      }

      if (diskAccount?.insiders_quota && !toSave.insiders_quota) {
        toSave = { ...toSave, insiders_quota: diskAccount.insiders_quota,
          insiders_quota_refresh_error: diskAccount.insiders_quota_refresh_error };
      }

      // 显式保存/重新添加同一账号时撤销删除标记；刷新写入不得复活已删除账号。
      if (!isRefreshUpdate) await this.clearTombstones(toSave.id, toSave.email);

      // Update index summary
      const index = await this.loadIndex();
      const summary: AccountSummary = {
        id: toSave.id,
        email: toSave.email,
        name: toSave.name,
        disabled: toSave.disabled,
        disabled_reason: toSave.disabled_reason,
        disabled_at: toSave.disabled_at,
        protected_models: toSave.protected_models ?? [],
        created_at: toSave.created_at,
        last_used: toSave.last_used,
        custom_label: toSave.custom_label,
        quota: toSave.quota,
        quota_refresh_error: toSave.quota_refresh_error,
        revision: computeAccountRevision(toSave),
        quota_last_updated: toSave.quota?.last_updated ?? 0,
      };

      const existingIdx = index.accounts.findIndex(a => a.id === toSave.id);
      if (existingIdx >= 0) {
        index.accounts[existingIdx] = summary;
      } else {
        index.accounts.unshift(summary);
      }

      if (!index.current_account_id) {
        index.current_account_id = toSave.id;
      }
      // 成对原子写入账号文件与索引文件，杜绝两次独立落盘中间崩溃引起的索引不一致
      await commitAccountAndIndex(accountPath, toSave, this.indexPath, index);
      Object.defineProperty(account, '_expectedFileDigest', {value:createHash('sha256').update(await readFile(accountPath)).digest('hex'),writable:true,configurable:true,enumerable:false});
    });
  }

  /**
   * 原子读-改-写：在锁内读取最新账号数据，执行 mutator，然后落盘更新，
   * 彻底杜绝先读出旧快照、再覆盖期间并发更新（如配额刷新）的 Lost Update 问题。
   */
  async updateAccount<T>(id: string, mutate: (current: Account) => T | Promise<T>): Promise<{ account: Account; result: T }> {
    await this.init();
    return this.withWriteLock(async () => {
      const current = await this.getAccount(id);
      if (!current) throw new Error(`找不到 ID 为 ${id} 的账号`);
      const result = await mutate(current);
      await this.saveAccount(current);
      return { account: current, result };
    });
  }

  async renameAccount(id: string, name: string): Promise<Account> {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80) throw new Error("账号名称须为 1–80 个字符");
    return (await this.updateAccount(id, current => { current.name = name.trim(); })).account;
  }

  async upsertAccount(data: any): Promise<Account> {
    await this.init();
    return this.withWriteLock(async () => {
      const index = await this.loadIndex();
      const email = String(data.email || '').trim();
      const existingSummary = index.accounts.find(
        a => (email && a.email.toLowerCase() === email.toLowerCase()) || (data.id && a.id === data.id)
      );

      let account: Account;
      if (data.id && !/^[a-zA-Z0-9_-]+$/.test(String(data.id))) throw new Error('账号 ID 无效');
      const now = Math.floor(Date.now() / 1000);
      const refreshToken = data.refreshToken ?? data.refresh_token ?? data.token?.refresh_token ?? data.token?.refreshToken;
      const accessToken = data.accessToken ?? data.access_token ?? data.token?.access_token ?? data.token?.accessToken;
      const expiresIn = data.expiresIn ?? data.expires_in ?? data.token?.expires_in;
      const customLabel = data.custom_label !== undefined ? data.custom_label : data.customLabel;
      const name = data.name;
      const projectId = data.projectId !== undefined ? data.projectId : data.project_id;
      const oauthClientKey = data.oauthClientKey !== undefined ? data.oauthClientKey : data.oauth_client_key;
      const isGcpTos = data.isGcpTos !== undefined ? data.isGcpTos : data.is_gcp_tos;
      const idToken = data.idToken !== undefined ? data.idToken : data.id_token;

      if (existingSummary) {
        const existing = (await this.getAccount(existingSummary.id))!;
        account = {
          ...existing,
          name: name !== undefined ? name : existing.name,
          custom_label: customLabel !== undefined ? customLabel : existing.custom_label,
          disabled: false,
          disabled_reason: null,
          disabled_at: null,
          token: {
            ...existing.token,
            refresh_token: refreshToken || existing.token.refresh_token,
            access_token: accessToken ?? existing.token.access_token,
            expires_in: expiresIn ?? existing.token.expires_in,
            expiry_timestamp: expiresIn ? now + expiresIn : existing.token.expiry_timestamp,
            project_id: projectId !== undefined ? projectId : existing.token.project_id,
            oauth_client_key: oauthClientKey !== undefined ? oauthClientKey : existing.token.oauth_client_key,
            is_gcp_tos: isGcpTos !== undefined ? isGcpTos : existing.token.is_gcp_tos,
            id_token: idToken !== undefined ? idToken : existing.token.id_token,
          },
        };
      } else {
        if (!refreshToken) throw new Error('新增账号缺少 refreshToken');
        if (!email) throw new Error('新增账号缺少 email');
        const id = data.id || randomUUID();
        const exp = expiresIn ?? 3600;
        account = {
          id,
          email,
          name: name ?? null,
          token: {
            access_token: accessToken ?? 'pending_refresh',
            refresh_token: refreshToken,
            expires_in: exp,
            expiry_timestamp: now + exp,
            token_type: 'Bearer',
            email,
            project_id: projectId ?? null,
            oauth_client_key: oauthClientKey ?? null,
            is_gcp_tos: isGcpTos ?? false,
            id_token: idToken ?? null,
          },
          device_profile: generateDeviceProfile(),
          quota: null,
          disabled: false,
          protected_models: [],
          validation_blocked: false,
          created_at: now,
          last_used: now,
          custom_label: customLabel ?? null,
        };
      }

      await this.saveAccount(account);
      return account;
    });
  }

  async addAccountWithRefreshToken(raw: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<Account> {
    const refreshToken = String(raw).trim();
    if (!refreshToken || refreshToken.length > 8192 || /[\r\n\x00]/.test(refreshToken)) throw new Error('请填写有效的 Refresh Token');
    const tokenReply = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', signal: AbortSignal.timeout(6000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: getGoogleClientId(), client_secret: getGoogleClientSecret(), refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
    }).catch(() => { throw new Error('无法连接登录服务，请检查网络后重试'); });
    if (!tokenReply.ok) throw new Error('登录凭据无效或已失效，请重新获取');
    const token: any = await tokenReply.json();
    if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('登录服务未返回有效凭据');
    const identityReply = await fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(6000),
    }).catch(() => { throw new Error('未能核实账号身份，尚未添加'); });
    if (!identityReply.ok) throw new Error('未能核实账号身份，尚未添加');
    const identity: any = await identityReply.json();
    if (typeof identity.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(identity.email) || identity.verified_email === false) throw new Error('未取得已验证的账号邮箱，尚未添加');
    return this.upsertAccount({ email: identity.email, name: identity.name, accessToken: token.access_token,
      refreshToken: token.refresh_token || refreshToken, expiresIn: Number(token.expires_in) || 3600, idToken: token.id_token });
  }

  async addAccountFromOAuth(token: { access_token: string; refresh_token: string; expires_in?: number; id_token?: string }, signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch): Promise<void> {
    const reply = await fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    if (!reply.ok) throw new Error('未能核实 Google 账号，尚未添加');
    const identity: any = await reply.json();
    if (typeof identity.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(identity.email) || identity.verified_email !== true) throw new Error('未取得已验证的 Google 邮箱，尚未添加');
    signal.throwIfAborted();
    await this.upsertAccount({ email: identity.email, name: identity.name, accessToken: token.access_token,
      refreshToken: token.refresh_token, expiresIn: Number(token.expires_in) || 3600, idToken: token.id_token });
  }

  async deleteAccount(id: string): Promise<boolean> {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('账号 ID 无效');
    await this.init();
    return this.withWriteLock(async () => {
      const index = await this.loadIndex();
      const summary = index.accounts.find(item => item.id === id);
      const existing = await this.getAccount(id);
      const email = existing?.email ?? summary?.email ?? '';
      const accountPath = join(this.accountsDir, `${id}.json`);
      const tombstones = (await this.loadTombstones()).filter(item => item.id !== id && item.email.toLowerCase() !== email.toLowerCase());
      if (summary || existing) tombstones.push({ id, email, at: Math.floor(Date.now()/1000) });
      index.accounts = index.accounts.filter(a => a.id !== id);
      if (index.current_account_id === id) index.current_account_id = null;
      const original = await readFile(accountPath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (original !== null) await atomicJson(join(this.stateDir, 'accounts-removed', `${id}-${Date.now()}.json`), {
        schema: 1, removedAt: new Date().toISOString(), account: JSON.parse(original),
      });
      await commitFileSet(join(this.stateDir, 'account-delete-commit.json'), [
        { path: this.tombstonesPath, after: JSON.stringify(tombstones.slice(-500), null, 2)+'\n' },
        { path: accountPath, after: null },
        { path: this.indexPath, after: JSON.stringify(index, null, 2)+'\n' },
      ]);
      return true;
    });
  }

  async reorderAccounts(ids: string[]): Promise<AccountIndex> {
    return this.withWriteLock(async () => {
      const index = await this.loadIndex();
      const idMap = new Map(index.accounts.map(a => [a.id, a]));
      const reordered: AccountSummary[] = [];

      for (const id of ids) {
        const item = idMap.get(id);
        if (item) {
          reordered.push(item);
          idMap.delete(id);
        }
      }
      // Append remaining
      for (const remaining of idMap.values()) {
        reordered.push(remaining);
      }

      index.accounts = reordered;
      await this.saveIndex(index);
      return index;
    });
  }

  async setCurrentAccount(id: string, target?: 'app' | 'ide' | 'vscode' | 'all'): Promise<void> {
    await this.init();
    return this.withWriteLock(async () => {
      const index = await this.loadIndex();
      if (!index.accounts.some(a => a.id === id)) {
        throw new Error(`找不到账号: ${id}`);
      }

      const now = Math.floor(Date.now() / 1000);
      const acc = await this.getAccount(id);
      if (acc) {
        acc.last_used = now;
        await this.saveAccount(acc);
      }

      const latest = await this.loadIndex();
      switch (target) {
        case 'ide':
          latest.current_ide_account_id = id;
          break;
        case 'vscode':
          latest.current_vscode_account_id = id;
          break;
        case 'all':
          latest.current_account_id = id;
          latest.current_ide_account_id = id;
          latest.current_vscode_account_id = id;
          break;
        default:
          latest.current_account_id = id;
          break;
      }

      latest.current_target_ide = target ?? 'app';
      await this.saveIndex(latest);
    });
  }

  /**
   * 导出账号。refresh_token 是长期凭据，默认只返回脱敏摘要；
   * 只有调用方显式传入 { confirm: true }（IPC 层由用户二次确认后传入）才包含真实 refresh_token。
   */
  async exportAccounts(ids?: string[], options?: { confirm?: boolean }): Promise<AccountExportResponse> {
    const confirmed = options?.confirm === true;
    const index = await this.loadIndex();
    const targetIds = ids && ids.length > 0 ? ids : index.accounts.map(a => a.id);
    const items: AccountExportItem[] = [];

    for (const id of targetIds) {
      const acc = await this.getAccount(id);
      if (!acc) continue;
      items.push({
        email: acc.email,
        refresh_token: confirmed ? acc.token.refresh_token : '[REDACTED]',
        name: acc.name,
        oauth_client_key: acc.token.oauth_client_key,
        is_gcp_tos: acc.token.is_gcp_tos,
        project_id: acc.token.project_id,
        custom_label: acc.custom_label,
      });
    }

    return {
      schema_version: 2,
      accounts: items,
      tokens_included: confirmed,
      confirm_required: !confirmed,
    };
  }

  async importAccounts(data: AccountExportResponse): Promise<{ imported: number; updated: number }> {
    if (!data || !Array.isArray(data.accounts)) {
      throw new Error('导入格式错误：缺少 accounts 列表');
    }
    if (data.tokens_included === false) {
      throw new Error('该备份为脱敏摘要，不含登录凭据，无法恢复账号；请在导出时选择“包含凭据导出”');
    }
    if (data.accounts.some(item => String(item.refresh_token ?? '') === '[REDACTED]')) {
      throw new Error('该备份包含脱敏占位符，无法恢复登录凭据；请重新导出并选择“包含凭据导出”');
    }

    let imported = 0;
    let updated = 0;
    const index = await this.loadIndex();
    const existingEmails = new Set(index.accounts.map(a => a.email.toLowerCase()));

    for (const item of data.accounts) {
      if (!item.email || !item.refresh_token) continue;
      const isExisting = existingEmails.has(item.email.toLowerCase());
      await this.upsertAccount({
        email: item.email,
        refreshToken: item.refresh_token,
        name: item.name,
        oauthClientKey: item.oauth_client_key,
        isGcpTos: item.is_gcp_tos,
        projectId: item.project_id,
        customLabel: item.custom_label,
      });
      if (isExisting) {
        updated++;
      } else {
        imported++;
        existingEmails.add(item.email.toLowerCase());
      }
    }

    return { imported, updated };
  }

  // ---- 额度与监控双窗口熔合体系 ----

  fuseQuota(fetchAvailableModelsData: any, quotaSummaryData?: any): QuotaData {
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

  // ---- 智能轮换调度策略配置与推荐算法 ----

  async getAutoSwitchConfig(): Promise<AutoSwitchConfig> {
    try {
      const raw = await readFile(this.autoSwitchPath, 'utf8');
      const parsed = JSON.parse(raw);
      const reserve = Math.min(98, Math.max(1, Number(parsed.reserve_percentage ?? parsed.reservePercentage) || 10));
      const candidateMin = Math.min(100, Math.max(2, Number(parsed.candidate_min_percentage ?? parsed.candidateMinPercentage) || 30));
      return {
        enabled: parsed.enabled ?? false,
        strategy: parsed.strategy === 'round_robin' ? 'round_robin' : 'priority',
        reserve_percentage: reserve,
        reservePercentage: reserve,
        candidate_min_percentage: candidateMin,
        candidateMinPercentage: candidateMin,
        monitored_model: parsed.monitored_model ?? 'all',
        candidate_account_ids: Array.isArray(parsed.candidate_account_ids) ? parsed.candidate_account_ids : [],
        last_switched_id: parsed.last_switched_id ?? undefined,
      };
    } catch {
      return {
        enabled: false,
        strategy: 'priority',
        reserve_percentage: 10,
        reservePercentage: 10,
        candidate_min_percentage: 30,
        candidateMinPercentage: 30,
        monitored_model: 'all',
        candidate_account_ids: [],
      };
    }
  }

  async setAutoSwitchConfig(config: Partial<AutoSwitchConfig> & Record<string, any>): Promise<AutoSwitchConfig> {
    await this.init();
    return this.withWriteLock(async () => {
    const current = await this.getAutoSwitchConfig();
    const reserveRaw = config.reserve_percentage ?? config.reservePercentage;
    if (reserveRaw !== undefined) {
      const num = Number(reserveRaw);
      if (isNaN(num) || num < 1 || num > 98) {
        throw new Error('当前账号配额门槛必须在 1% 到 98% 之间');
      }
    }
    const candidateMinRaw = config.candidate_min_percentage ?? config.candidateMinPercentage;
    if (candidateMinRaw !== undefined) {
      const num = Number(candidateMinRaw);
      if (isNaN(num) || num < 2 || num > 100) {
        throw new Error('候选账号配额门槛必须在 2% 到 100% 之间');
      }
    }
    const reserve = reserveRaw !== undefined ? Number(reserveRaw) : current.reserve_percentage;
    const candidateMin = candidateMinRaw !== undefined ? Number(candidateMinRaw) : current.candidate_min_percentage;
    if (reserve >= candidateMin) {
      throw new Error('候选账号配额门槛必须大于当前账号配额门槛');
    }
    const updated: AutoSwitchConfig = {
      enabled: config.enabled !== undefined ? Boolean(config.enabled) : current.enabled,
      strategy: config.strategy !== undefined ? (config.strategy === 'round_robin' ? 'round_robin' : 'priority') : current.strategy,
      reserve_percentage: reserve,
      reservePercentage: reserve,
      candidate_min_percentage: candidateMin,
      candidateMinPercentage: candidateMin,
      monitored_model: config.monitored_model !== undefined ? config.monitored_model : current.monitored_model,
      candidate_account_ids: config.candidate_account_ids !== undefined ? config.candidate_account_ids : current.candidate_account_ids,
      last_switched_id: config.last_switched_id !== undefined ? config.last_switched_id : current.last_switched_id,
    };
    await atomicJson(this.autoSwitchPath, updated);
    return updated;
    });
  }

  async recordAutoSwitchChoice(accountId: string): Promise<void> {
    await this.setAutoSwitchConfig({ last_switched_id: accountId });
  }

  /**
   * 提取账号指定模型的可用额度百分比（结合 5 小时与周额度进行双窗口熔合与硬拦截）
   */
  getAccountRemaining(account: Account, monitoredModel = 'all'): number | null {
    if (account.disabled || account.validation_blocked || account.quota?.is_forbidden) return null;
    const quota = account.quota;
    if (!quota || !Array.isArray(quota.models)) return null;

    const overview = this.getAccountQuotaOverview(account);
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
    const isArgonTarget = trimmed === 'argon';
    const isClaudeTarget = trimmed === 'claude' || trimmed === '3p';
    const isGeminiTarget = trimmed === 'gemini';
    const isAllTarget = !trimmed || trimmed === 'all';

    // 具体模型：使用规范化后的 effective（= min(own, 相关 family 新鲜窗口)），不跨周期混取 reset。
    if (!isArgonTarget && !isClaudeTarget && !isGeminiTarget && !isAllTarget) {
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

    // all：优先统计核心主力模型家族（Gemini + Claude/GPT），避免实验性 Argon 单项偏低把主力充裕账号误判为耗尽；
    // 仅当账号没有任何已知 Gemini/Claude 模型记录时才回退参考 Argon。
    const gemini = familyHasKnownModel('gemini') ? familyValues('gemini') : [];
    const claude = familyHasKnownModel('claude') ? familyValues('claude') : [];
    const argonStatus = overview.argonStatus;
    const argonFresh = argonStatus.availability === 'available'
      && argonStatus.quotaState === 'known'
      && argonStatus.remaining !== null
      && (typeof argonStatus.observedAt !== 'number' || nowSec - argonStatus.observedAt <= FRESH_SECONDS)
      ? [argonStatus.remaining]
      : [];
    const core = [...gemini, ...claude];
    const all = core.length > 0 ? core : argonFresh;
    if (all.length === 0) return null;
    if (all.some(value => value <= 0)) return 0;
    return bounded(Math.min(...all));
  }

  private subscriptionTierRank(account: Account | AccountSummary | null | undefined): number {
    if (!account) return 0;
    const raw = String(account.quota?.subscription_tier ?? '').toUpperCase();
    if (raw.includes('ULTRA')) return 3;
    if (raw.includes('PRO')) return 2;
    if (raw.includes('FREE') || raw.includes('STARTER')) return 1;
    return 2;
  }

  /**
   * 智能挑选最佳切号候选账号（高阶订阅 ULTRA > PRO > FREE 优先，杜绝把免费账号优先推荐于 PRO 账号之上）
   */
  async selectBestAccount(config?: AutoSwitchConfig, options?: { currentId?:string; currentEmail?:string; currentQuota?:QuotaData }): Promise<{
    currentAccount: Account | null;
    bestCandidate: Account | null;
    shouldSwitch: boolean;
    reason: string;
  }> {
    const cfg = config ?? await this.getAutoSwitchConfig();
    const index = await this.loadIndex();
    const currentId = options?.currentId ?? index.current_account_id;
    const storedCurrent = currentId ? await this.getAccount(currentId) : null;
    const currentAccount = storedCurrent && options?.currentQuota && options.currentEmail?.toLowerCase()===storedCurrent.email.toLowerCase()
      ? {...storedCurrent,quota:options.currentQuota} : storedCurrent;

    if (!cfg.enabled) {
      return {
        currentAccount,
        bestCandidate: null,
        shouldSwitch: false,
        reason: '智能备用账号推荐策略未启用',
      };
    }

    if (!currentAccount) {
      return { currentAccount: null, bestCandidate: null, shouldSwitch: false, reason: '没有当前激活账号' };
    }

    const currentRem = this.getAccountRemaining(currentAccount, cfg.monitored_model);
    const isLow = currentRem !== null && currentRem <= cfg.reserve_percentage;

    const candidateIds = cfg.candidate_account_ids.length > 0
      ? cfg.candidate_account_ids.filter(id => id !== currentId)
      : index.accounts.map(a => a.id).filter(id => id !== currentId);

    const candidates: Account[] = [];
    for (const cid of candidateIds) {
      const acc = await this.getAccount(cid);
      if (acc) candidates.push(acc);
    }

    // Filter valid: 剩余有效额度达标，且持有有效 refresh_token（不因 1h access_token 过期误杀备用账号）
    const allValidCandidates = candidates.filter(acc => {
      const rem = this.getAccountRemaining(acc, cfg.monitored_model);
      if (rem === null || rem < cfg.candidate_min_percentage || rem <= 0) {
        return false;
      }
      if (accountCredentialReadiness(acc).state === 'needs_authorization') return false;
      return true;
    });

    if (allValidCandidates.length === 0) {
      return {
        currentAccount,
        bestCandidate: null,
        shouldSwitch: false,
        reason: '备选池中没有额度充足且可用的账号',
      };
    }

    // 优先在付费高阶账号（ULTRA / PRO）中挑选；仅当没有任何达标付费账号时才回退考虑 FREE 账号
    const paidCandidates = allValidCandidates.filter(acc => this.subscriptionTierRank(acc) >= 2);
    const validCandidates = paidCandidates.length > 0 ? paidCandidates : allValidCandidates;

    let best: Account;
    if (cfg.strategy === 'round_robin') {
      // 环形轮询：基于全局候选全集池 poolOrder 与游标选择下一个可用账号，杜绝双账号反复横跳振荡
      const poolOrder = cfg.candidate_account_ids.length > 0
        ? cfg.candidate_account_ids
        : index.accounts.map(a => a.id);
      const cursorId = (cfg.last_switched_id && poolOrder.includes(cfg.last_switched_id))
        ? cfg.last_switched_id
        : currentId;
      const cursorIndex = cursorId ? poolOrder.indexOf(cursorId) : -1;
      if (cursorIndex !== -1) {
        let chosen: Account | undefined;
        for (let i = 1; i < poolOrder.length; i++) {
          const nextId = poolOrder[(cursorIndex + i) % poolOrder.length]!;
          if (nextId === currentId) continue;
          const candidate = validCandidates.find(a => a.id === nextId);
          if (candidate) {
            chosen = candidate;
            break;
          }
        }
        best = chosen ?? validCandidates[0]!;
      } else {
        best = validCandidates[0]!;
      }
    } else {
      // Priority: 先按套餐等级（ULTRA > PRO > FREE）降序，同等级按剩余额度从高到低排序
      validCandidates.sort((a, b) => {
        const tierDiff = this.subscriptionTierRank(b) - this.subscriptionTierRank(a);
        if (tierDiff !== 0) return tierDiff;
        const remA = this.getAccountRemaining(a, cfg.monitored_model) ?? 0;
        const remB = this.getAccountRemaining(b, cfg.monitored_model) ?? 0;
        return remB - remA;
      });
      best = validCandidates[0]!;
    }

    const bestRem = this.getAccountRemaining(best, cfg.monitored_model) ?? 0;
    const bestDisplay = best.name ? `${best.name} (${best.email})` : best.email;
    // 当前为 PRO/ULTRA 而唯一候选为 FREE 时，除非当前账号已彻底耗尽（0%），否则不主动触发向免费账号的降级推荐
    const isDowngradeToFree = this.subscriptionTierRank(currentAccount) >= 2 && this.subscriptionTierRank(best) < 2;
    const effectiveShouldSwitch = isLow && (!isDowngradeToFree || (currentRem !== null && currentRem <= 0));

    return {
      currentAccount,
      bestCandidate: best,
      shouldSwitch: effectiveShouldSwitch,
      reason: effectiveShouldSwitch
        ? `当前账号额度偏低（剩余 ${currentRem}%），建议切换至备用账号 ${bestDisplay}（额度充足，剩余 ${bestRem}%）`
        : isLow && isDowngradeToFree
        ? '当前配额偏低，但仅有免费候选；为避免降级暂不建议切换'
        : currentRem === null
        ? '当前账号配额未知或已过期，请先刷新'
        : `当前账号额度充足（剩余 ${currentRem}%）`,
    };
  }

  /**
   * 探测运行中的 Antigravity language_server 本地 RPC 端口与 CSRF Token (双接口免密联动)
   */
  async probeLiveLanguageServer(fetchImpl: typeof fetch = globalThis.fetch, options: { forceRefresh?: boolean } = {}): Promise<LiveLanguageServerStatus | null> {
    if (process.env.GRAVITYBOX_PROBE_LS === 'false') return null;
    const now = Date.now();
    if (fetchImpl === globalThis.fetch && this.liveProbeCache && now < (options.forceRefresh ? this.liveProbeCache.expiresAt - 1300 : this.liveProbeCache.expiresAt)) {
      return this.liveProbeCache.status;
    }
    if (fetchImpl === globalThis.fetch && this.inFlightProbe) {
      return await this.inFlightProbe;
    }

    const doProbe = async () => {
      try {
      const { stdout: psOut } = await execFileAsync('/bin/ps', ['-ax', '-ww', '-o', 'pid=,args=']);
      const lines = psOut.split('\n');
      let targetPid = 0;
      let csrfToken = '';
      let matchedAppPath = this.target.appPath;

      for (const line of lines) {
        if (line.includes('--csrf_token')) {
          const trimmed = line.trim();
          const mPid = trimmed.match(/^(\d+)\s+(.+)$/);
          if (mPid) {
            const pid = parseInt(mPid[1]!, 10);
            const cmd = mPid[2]!;
            const matchedTarget = matchingTargetForLanguageServerCommand(cmd, this.target);
            if (matchedTarget) {
              const mCsrf = cmd.match(/--csrf_token[=\s]+([^\s]+)/);
              if (mCsrf) {
                targetPid = pid;
                csrfToken = mCsrf[1]!;
                matchedAppPath = matchedTarget.appPath;
                break;
              }
            }
          }
        }
      }

      if (!targetPid || !csrfToken) return null;
      if (fetchImpl === globalThis.fetch && !await verifyLanguageServerIdentity(targetPid, matchedAppPath)) return null;

      const { stdout: lsofOut } = await execFileAsync('/usr/sbin/lsof', [
        '-nP', '-a', '-p', String(targetPid), '-iTCP', '-sTCP:LISTEN', '-Fn'
      ]);
      const portMatches = Array.from(lsofOut.matchAll(/n127\.0\.0\.1:(\d+)/g)).map(m => parseInt(m[1]!, 10));
      const ports = Array.from(new Set(portMatches));
      if (ports.length === 0) return null;

      for (const port of ports) {
        try {
          let userStatusData: any = null;
          let quotaSummaryData: any = null;
          let activeProtocol: 'https' | 'http' = 'https';

          // 1. 获取 UserStatus
          if (fetchImpl !== globalThis.fetch) {
            // 测试 mock 注入环境
            const resp = await fetchImpl(`http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrfToken },
              body: '{}',
            });
            if (resp.ok) userStatusData = await resp.json();
          } else {
            // 实机环境优先尝试 HTTPS，回退 HTTP，并记录成功协议供后续请求直接复用
            try {
              userStatusData = await localRpcFetch('https', port, '/exa.language_server_pb.LanguageServerService/GetUserStatus', csrfToken);
              activeProtocol = 'https';
            } catch {
              try {
                userStatusData = await localRpcFetch('http', port, '/exa.language_server_pb.LanguageServerService/GetUserStatus', csrfToken);
                activeProtocol = 'http';
              } catch {}
            }
          }

          const userStatus = userStatusData?.userStatus;
          if (!userStatus?.email) continue;

          // 2. 获取 RetrieveUserQuotaSummary (官方配额桶)
          if (fetchImpl !== globalThis.fetch) {
            try {
              const respQ = await fetchImpl(`http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrfToken },
                body: '{}',
              });
              if (respQ.ok) {
                const qRes = await respQ.json() as any;
                quotaSummaryData = qRes.response || qRes;
              }
            } catch {}
          } else {
            const fallbackProtocol: 'https' | 'http' = activeProtocol === 'https' ? 'http' : 'https';
            const reqBody = JSON.stringify({forceRefresh:options.forceRefresh===true});
            try {
              const qRes = await localRpcFetch(activeProtocol, port, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', csrfToken, reqBody);
              quotaSummaryData = qRes?.response || qRes;
            } catch {
              try {
                const qRes = await localRpcFetch(fallbackProtocol, port, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', csrfToken, reqBody);
                quotaSummaryData = qRes?.response || qRes;
              } catch {}
            }
          }

          const email = String(userStatus.email);
          const name = userStatus.name ? String(userStatus.name) : null;
          const tierRaw = userStatus.userTier?.name || userStatus.userTier?.id ||
            userStatus.planStatus?.planInfo?.planName || userStatus.paidTier?.name || '';
          let tier = 'FREE';
          if (/ultra/i.test(tierRaw)) tier = 'ULTRA';
          else if (/pro/i.test(tierRaw)) tier = 'PRO';
          else if (tierRaw) tier = 'FREE';

          // task-38：live 与 cloud 共用规范化；保留 disabled/display_name/modelOrAlias 与模型自身 quotaInfo，
          // 并同样把 family 窗口挂到模型上（只作为参考/effective，不覆写 own_*）。
          const observedAt = Math.floor(Date.now() / 1000);
          const clientConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs || [];
          const models = mergeModelCatalogues([normalizeLiveModels(clientConfigs, observedAt)]);
          const groups = mergeGroupSets([normalizeLiveGroups(quotaSummaryData, observedAt)]);
          const windows = familyWindowsFromGroups(groups, Date.now());
          const applied = applyFamilyWindows(models, windows);
          const missingFamilies = (['gemini', 'claude', 'argon'] as const).filter(family =>
            models.some(model => model.family === family && model.disabled !== true)
            && !groups.some(group => group.family === family && group.buckets.some(bucket => bucket.remaining_fraction_known)));
          const quotaData: QuotaData = {
            models: applied.map(modelQuotaFromNormalized),
            quota_groups: groups.map(groupToQuotaGroup),
            is_forbidden: false,
            subscription_tier: tier,
            last_updated: observedAt,
            model_forwarding_rules: {},
            source: 'live',
            refresh_state: {
              complete: models.length > 0 && groups.length > 0 && missingFamilies.length === 0,
              endpointsAttempted: ['live:GetUserStatus', 'live:RetrieveUserQuotaSummary'],
              endpointsSucceeded: ['live:GetUserStatus', ...(quotaSummaryData ? ['live:RetrieveUserQuotaSummary'] : [])],
              missingFamilies,
              missingWindows: [],
              carriedGroups: 0,
              refreshedAt: observedAt,
            },
            quota_warnings: models.length === 0 ? ['NO_MODEL_RECORDS: live 未返回模型列表'] : undefined,
          };

          return {
            email,
            name,
            tier,
            quota: quotaData,
          };
        } catch {}
      }
    } catch {}
    return null;
    };

    if (fetchImpl !== globalThis.fetch) {
      return await doProbe();
    }

    const probePromise = doProbe();
    this.inFlightProbe = probePromise;
    try {
      const res = await probePromise;
      this.liveProbeCache = { status: res, expiresAt: Date.now() + 5000 };
      return res;
    } finally {
      this.inFlightProbe = null;
    }
  }

  /**
   * 提取当前系统/IDE真实登录态并存入账号池
   */
  async saveCurrentAccount(options?: {
    keychain?: KeychainAdapter;
    homeDir?: string;
    appSupportDir?: string;
  }): Promise<Account> {
    const homeDir = options?.homeDir ?? homedir();
    const appSupportDir = options?.appSupportDir ?? join(homedir(), 'Library', 'Application Support');
    const keychain = options?.keychain ?? new SystemKeychainAdapter();

    const isSandboxHome = homeDir !== homedir();
    let extractedToken: TokenData | null = null;
    let extractedEmail: string | null = null;
    let extractedName: string | null = null;
    let liveQuota: QuotaData | null = null;

    const readSessionToken = async () => {
      const candidates = [
        join(homeDir, '.gemini', 'jetski-standalone-oauth-token'),
        join(homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
      ];
      for (const p of candidates) {
        try {
          const raw = await readFile(p, 'utf8');
          const json = JSON.parse(raw);
          const t = json.token || json;
          if (t?.refresh_token) {
            extractedToken = {
              access_token: t.access_token || '',
              refresh_token: t.refresh_token,
              expires_in: t.expires_in || 3600,
              expiry_timestamp: t.expiry_timestamp || Math.floor(Date.now() / 1000) + 3600,
              token_type: t.token_type || 'Bearer',
              email: t.email || null,
              project_id: t.project_id || null,
              is_gcp_tos: t.is_gcp_tos || false,
              id_token: t.id_token || null,
            };
            extractedEmail = t.email || null;
            return;
          }
        } catch {}
      }
    };

    // 1. 若在沙箱目录下，优先读取沙箱 session 文件，避免越界读取宿主真实 Keychain
    if (isSandboxHome) {
      await readSessionToken();
    }

    // 2. Keychain 优先读取 (显式传入 keychain 或非沙箱模式)
    if (!extractedToken && (options?.keychain || !isSandboxHome)) {
      try {
        const pass = await keychain.readPassword('gemini', 'antigravity');
        if (pass && pass.startsWith('go-keyring-base64:')) {
          const raw = Buffer.from(pass.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
          const parsed = JSON.parse(raw);
          if (parsed?.token?.refresh_token) {
            extractedToken = {
              access_token: parsed.token.access_token || '',
              refresh_token: parsed.token.refresh_token,
              expires_in: parsed.token.expires_in || 3600,
              expiry_timestamp: parsed.token.expiry_timestamp || (Number.isFinite(Date.parse(parsed.token.expiry)) ? Math.floor(Date.parse(parsed.token.expiry) / 1000) : Math.floor(Date.now() / 1000) + 3600),
              token_type: parsed.token.token_type || 'Bearer',
              email: parsed.token.email || parsed.id_token_email || null,
              project_id: parsed.token.project_id || null,
              is_gcp_tos: parsed.token.is_gcp_tos || false,
              id_token: parsed.token.id_token || null,
            };
            extractedEmail = parsed.token.email || parsed.id_token_email || null;
          }
        }
      } catch {}
    }

    // 3. 检查本地 session 文件 (非沙箱模式回退)
    if (!extractedToken) {
      await readSessionToken();
    }

    // 4. 检查 state.vscdb (补充 token 或补充 email)
    if (!extractedToken || !extractedEmail) {
      const candidateVscdbPaths = options?.appSupportDir
        ? Array.from(new Set([this.target.name, ...allApplicationTargets().map(t => t.name)])).map(name => join(appSupportDir, name, 'User', 'globalStorage', 'state.vscdb'))
        : Array.from(new Set([this.target.profile, ...allApplicationTargets().map(t => t.profile)])).map(p => join(p, 'User', 'globalStorage', 'state.vscdb'));
      for (const vscdbPath of candidateVscdbPaths) {
        if (extractedToken && extractedEmail) break;
        try {
          const { stdout } = await execFileAsync('/usr/bin/sqlite3', [
            '-readonly', '-json',
            vscdbPath,
            "SELECT key, value FROM ItemTable WHERE key IN ('antigravityUnifiedStateSync.oauthToken', 'antigravityUnifiedStateSync.userStatus');",
          ]);
          const rows = JSON.parse(stdout || '[]');
          let oauthRawB64 = '';
          let userStatusB64 = '';
          for (const r of rows) {
            if (r.key === 'antigravityUnifiedStateSync.oauthToken') {
              try {
                const valObj = JSON.parse(r.value);
                oauthRawB64 = valObj.data || '';
              } catch {
                oauthRawB64 = r.value;
              }
            } else if (r.key === 'antigravityUnifiedStateSync.userStatus') {
              try {
                const valObj = JSON.parse(r.value);
                userStatusB64 = valObj.data || '';
              } catch {
                userStatusB64 = r.value;
              }
            }
          }

          if (!extractedToken && oauthRawB64) {
            const payloadBuf = decodeTopicRow(oauthRawB64, 'oauthTokenInfoSentinelKey');
            if (payloadBuf) {
              const accessToken = ProtobufReader.findString(payloadBuf, 1) || '';
              const refreshToken = ProtobufReader.findString(payloadBuf, 3) || '';
              let expirySec = Math.floor(Date.now() / 1000) + 3600;
              const timeBuf = ProtobufReader.findField(payloadBuf, 4);
              if (timeBuf) {
                const sec = ProtobufReader.findVarint(timeBuf, 1);
                if (sec && sec > 0) expirySec = sec;
              }

              if (refreshToken) {
                extractedToken = {
                  access_token: accessToken,
                  refresh_token: refreshToken,
                  expires_in: Math.max(60, expirySec - Math.floor(Date.now() / 1000)),
                  expiry_timestamp: expirySec,
                  token_type: 'Bearer',
                  email: null,
                  is_gcp_tos: false,
                };
              }
            }
          }

          if (!extractedEmail && userStatusB64 && oauthRawB64 && extractedToken?.refresh_token === ProtobufReader.findString(decodeTopicRow(oauthRawB64, 'oauthTokenInfoSentinelKey') ?? Buffer.alloc(0), 3)) {
            const payloadBuf = decodeTopicRow(userStatusB64, 'userStatusSentinelKey');
            if (payloadBuf) {
              const email = ProtobufReader.findString(payloadBuf, 7);
              if (email) extractedEmail = email;
            }
          }
        } catch {}
      }
    }

    // A live identity may enrich the same account, or provide the email for the active local session when state.vscdb is absent.
    if (!isSandboxHome && (extractedEmail || extractedToken)) {
      const lsStatus = await this.probeLiveLanguageServer();
      if (lsStatus?.email && (!extractedEmail || lsStatus.email.toLowerCase() === extractedEmail.toLowerCase())) {
        extractedEmail = extractedEmail || lsStatus.email;
        extractedName = lsStatus.name || null;
        liveQuota = { ...lsStatus.quota, source: 'live' };
      }
    }

    if (!extractedToken || !extractedToken.refresh_token) {
      throw new Error('未在系统 Keychain、会话凭据或应用数据库中找到有效登录态');
    }

    if (extractedEmail && !extractedToken.email) {
      extractedToken.email = extractedEmail;
    }

    const email = extractedEmail || extractedToken.email;
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email) || email.endsWith('@antigravity.user')) throw new Error('无法核实此凭据的账号邮箱，请通过登录凭据添加并核实身份');

    const account = await this.upsertAccount({
      email,
      name: extractedName || undefined,
      refreshToken: extractedToken.refresh_token,
      accessToken: extractedToken.access_token,
      expiresIn: Math.max(60, extractedToken.expiry_timestamp - Math.floor(Date.now() / 1000)),
      projectId: extractedToken.project_id || undefined,
    });

    if (liveQuota) {
      account.quota = liveQuota;
      await this.saveAccount(account);
    }

    await this.setCurrentAccount(account.id);
    return (await this.getAccount(account.id)) ?? account;
  }

  /**
   * 获取账号额度综合概览（包含 3 分组 5 桶详细百分比、相对倒计时、套餐与 13 模型明细）
   */
  getAccountQuotaOverview(account: Account | AccountSummary | { quota?: QuotaData | null }, options?: { nowMs?: number }): QuotaOverview {
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
        resetTime: null, resetCountdown: '',
        subscriptionTier: '待确认', quotaGroups: [], staleGroups: [], unknownBuckets: [], models: [],
        lastUpdated: null, isStale: false, staleHours: 0,
        argonStatus: emptyArgon,
        familyWindows: {
          gemini: { fiveHour: null, weekly: null }, claude: { fiveHour: null, weekly: null }, argon: { fiveHour: null, weekly: null },
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
    for (const family of ['gemini', 'claude', 'argon'] as const) {
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
      familyWindows: {
        gemini: { fiveHour: windowOut(familyWindows.gemini.fiveHour), weekly: windowOut(familyWindows.gemini.weekly) },
        claude: { fiveHour: windowOut(familyWindows.claude.fiveHour), weekly: windowOut(familyWindows.claude.weekly) },
        argon: { fiveHour: windowOut(familyWindows.argon.fiveHour), weekly: windowOut(familyWindows.argon.weekly) },
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
   * 刷新指定账号的 OAuth Token 与配额数据 (支持三级端点容灾与双窗口熔合)
   */
  private async saveRefreshedAccount(account: Account, expectedRefresh = account.token.refresh_token, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const latest = await this.getAccount(account.id);
    if (!latest) throw new Error('此账号已移除，停止保存刷新结果');
    if (latest.token.refresh_token !== expectedRefresh) throw new Error('账号凭据已更新，停止覆盖新的登录记录');
    // Refresh work runs in the background; keep remarks, order, flags and usage edited meanwhile.
    const toSave: Account = {
      ...latest,
      name: latest.name || account.name,
      token: account.token,
      quota: account.quota,
      quota_refresh_error: account.quota_refresh_error,
    };
    (toSave as any)._expectedRefreshToken = expectedRefresh;
    (toSave as any)._isRefreshUpdate = true;
    signal?.throwIfAborted();
    await this.saveAccount(toSave, { expectedRefreshToken: expectedRefresh, isRefreshUpdate: true });
  }

  async refreshQuota(
    id?: string,
    fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    options?: { skipSyncExternal?: boolean; signal?: AbortSignal }
  ): Promise<Account> {
    options?.signal?.throwIfAborted();
    const index = await this.loadIndex();
    const targetId = id || index.current_account_id;
    if (!targetId) {
      throw new Error('未指定账号 ID 且当前没有激活账号');
    }

    const inFlight = this.inFlightRefreshes.get(targetId);
    if (inFlight) {
      return await inFlight;
    }

    const job = (async () => {
      try {
        if (!options?.skipSyncExternal) {
          await this.syncFromExternalAgySwitch();
        }
        options?.signal?.throwIfAborted();
        const account = await this.refreshQuotaFromProvider(targetId, fetchImpl, options?.signal);
        options?.signal?.throwIfAborted();
        return account;
      } catch (error) {
        // 取消是用户意图，不是网络故障：不得把取消写成 quota_refresh_error，也不得落盘任何中间 token/配额。
        if (options?.signal?.aborted) throw error;
        const account = await this.getAccount(targetId);
        if (account) {
          if(error instanceof CloudQuotaAuthorityError && account.quota?.source!=='live') {
            if(account.quota)await atomicJson(join(this.stateDir,'quota-rejected',`${account.id}-${Date.now()}.json`),{at:new Date().toISOString(),accountId:account.id,reason:error.message,quota:account.quota});
            account.quota={models:[],quota_groups:[],last_updated:0,is_forbidden:false,subscription_tier:account.quota?.subscription_tier,model_forwarding_rules:{},source:'cloud',quota_warnings:['UNVERIFIED_CLOUD_SCOPE: '+error.message]};
          }
          // A recent read-only Switch snapshot is an explicit fallback, not a new cloud observation.
          if (account.quota?.source === 'external' && Date.now() / 1000 - account.quota.last_updated < 300) {
            account.quota_refresh_error = '在线刷新未完成，显示 AntiGravity Switch 最近记录';
            await this.saveRefreshedAccount(account);
            return account;
          }
          account.quota_refresh_error = error instanceof Error ? error.message : '刷新失败，请稍后重试';
          await this.saveRefreshedAccount(account);
        }
        throw error;
      }
    })();

    this.inFlightRefreshes.set(targetId, job);
    try {
      return await job;
    } finally {
      this.inFlightRefreshes.delete(targetId);
    }
  }

  private async refreshQuotaFromProvider(id: string | undefined, fetchImpl: typeof globalThis.fetch, signal?: AbortSignal): Promise<Account> {
    signal?.throwIfAborted();
    const index = await this.loadIndex();
    const targetId = id || index.current_account_id;
    if (!targetId) throw new Error('未指定账号 ID 且当前没有激活账号');
    const account = await this.getAccount(targetId);
    if (!account) throw new Error(`找不到 ID 为 ${targetId} 的账号`);

    // 1) 本机 live 优先：仅当邮箱严格匹配且返回模型记录时采用（不跨账号借数据）。
    signal?.throwIfAborted();
    const lsStatus = await this.probeLiveLanguageServer(fetchImpl, {forceRefresh:true});
    signal?.throwIfAborted();
    if (lsStatus && account.email && lsStatus.email && lsStatus.email.trim().toLowerCase() === account.email.trim().toLowerCase() && (lsStatus.quota.models?.length ?? 0) > 0) {
      const fresh = lsStatus.quota;
      const freshState = this.getAccountQuotaOverview({ quota: fresh }).refreshState;
      const old = account.quota;
      const { groups, staleGroups } = mergeGroupsWithPrevious(
        normalizeStoredGroups(fresh.quota_groups, fresh.last_updated, 'live'),
        normalizeStoredGroups(old?.quota_groups, old?.last_updated ?? fresh.last_updated), Date.now());
      const { models, carriedCount } = mergeModelsWithPrevious(
        fresh.models.map(model => normalizedModelFromStored(model, 'live')),
        (old?.models ?? []).map(model => normalizedModelFromStored(model)));
      const missingWindows = groups.flatMap(group => group.buckets.filter(bucket => bucket.stale)
        .map(bucket => ({ family: group.family, window: bucket.window })));
      account.quota = { ...fresh, source: 'live',
        models: applyFamilyWindows(models, familyWindowsFromGroups(groups, Date.now())).map(modelQuotaFromNormalized),
        quota_groups: groups.map(groupToQuotaGroup),
        ...(staleGroups.length ? { stale_groups: staleGroups } : {}),
        refresh_state: { ...freshState, complete: freshState.complete && staleGroups.length === 0,
          missingWindows, carriedGroups: staleGroups.length, carriedModels: carriedCount },
      };
      account.quota_refresh_error = null;
      if (lsStatus.name && !account.name) account.name = lsStatus.name;
      signal?.throwIfAborted();
      await this.saveRefreshedAccount(account, account.token.refresh_token, signal);
      return account;
    }

    const providerContext=await this.resolveProviderContext(fetchImpl);
    const endpointSet=(method:string,legacy:string[])=>providerContext?[providerContext.origin+'/v1internal:'+method]:legacy;
    const providerAgent=providerContext?.userAgent??'Antigravity/0.9.0';
    account.quota_refresh_error = null;
    const nowSec = Math.floor(Date.now() / 1000);
    const needTokenRefresh =
      !account.token.access_token ||
      account.token.access_token === 'pending_refresh' ||
      !Number.isFinite(account.token.expiry_timestamp) ||
      account.token.expiry_timestamp - nowSec < 300;

    // 整体预算：所有已配置端点默认都查一遍；阶段内 3 并发；整体 12s 上限；用户 signal 可取消。
    const budget = new AbortController();
    let deadlineFired = false;
    const deadline = setTimeout(() => {
      deadlineFired = true;
      budget.abort(new Error('配额刷新整体预算超时'));
    }, 12_000);
    const parentSignal = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
    const requestSignal = (timeoutMs: number) => AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)]);
    const ordered = (endpoints: string[]) => [...endpoints].sort((left, right) => endpointPriority(left) - endpointPriority(right));
    let projectContextRecovered = false;
    let projectObserved = false;
    const attempted: string[] = [];
    const succeeded: string[] = [];
    const note = (kind: string, endpoint: string, ok: boolean) => {
      const tag = `${kind}:${endpointHost(endpoint)}`;
      attempted.push(tag);
      if (ok) succeeded.push(tag);
    };
    const userAborted = (): boolean => signal?.aborted === true;
    const throwIfUserAborted = () => {
      if (userAborted()) throw signal?.reason ?? new Error('已取消');
    };

    try {
      if (needTokenRefresh) {
        const previousRefresh = account.token.refresh_token;
        if (!account.token.refresh_token) throw new Error('此账号缺少登录凭据，请重新添加');
        try {
          const response = await fetchImpl('https://oauth2.googleapis.com/token', {
            method: 'POST', signal: requestSignal(10000),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: getGoogleClientId(), client_secret: getGoogleClientSecret(),
              refresh_token: account.token.refresh_token, grant_type: 'refresh_token' }).toString(),
          });
          if (!response.ok) throw new Error('登录凭据无法刷新，请重新添加此账号');
          const data: any = typeof response.json === 'function'
            ? await response.json()
            : JSON.parse(await (response as any).text());
          if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('登录服务未返回有效凭据');
          account.token.access_token = data.access_token;
          account.token.expires_in = Number(data.expires_in) || 3600;
          account.token.expiry_timestamp = nowSec + account.token.expires_in;
          if (data.refresh_token) account.token.refresh_token = data.refresh_token;
          signal?.throwIfAborted();
          await this.saveRefreshedAccount(account, previousRefresh, signal);
        } catch (error) {
          if (userAborted()) throw error;
          if (error instanceof Error && /凭据/.test(error.message)) throw error;
          throw new Error('无法连接登录服务，请检查网络后重试');
        }
      }

      type EndpointResult<T> = { endpoint: string; ok: boolean; data?: T; error?: string };
      const httpFailure=async(response:Response):Promise<string>=>{
        if(response.status===403){
          try {const data:any=await response.json();if(data?.error?.status==='PERMISSION_DENIED'&&/\(#3501\)/.test(String(data?.error?.message??'')))return 'HTTP 403（官方产品许可校验未通过，错误码 3501；请在官方应用核对该账号状态）';}catch{}
        }
        return `HTTP ${response.status}`;
      };
      let projectId = account.token.project_id || null;
      let subscriptionTier: string | null = account.quota?.subscription_tier || null;
      let tierObserved = false;
      let loadReady: Promise<void> = Promise.resolve();
      const queryAll = async <T>(endpoints: string[], body: (projectId: string | null) => unknown): Promise<EndpointResult<T>[]> => {
        return Promise.all(ordered(endpoints).map(async endpoint => {
          if (parentSignal.aborted) return { endpoint, ok: false, error: 'aborted' };
          try {
            const response = await fetchImpl(endpoint, {
              method: 'POST', signal: requestSignal(6000),
              headers: {
                Authorization: `Bearer ${account.token.access_token}`,
                'Content-Type': 'application/json',
                'User-Agent': providerAgent,
              },
              body: JSON.stringify(body(projectId)),
            });
            if (!response.ok) {
              const failure = await httpFailure(response);
              if (providerContext && endpoint.endsWith(':retrieveUserQuotaSummary') && failure.includes('3501')) {
                await loadReady;
                if (projectObserved && projectId) {
                  const retry = await fetchImpl(endpoint,{method:'POST',signal:requestSignal(6000),headers:{Authorization:`Bearer ${account.token.access_token}`,'Content-Type':'application/json','User-Agent':providerAgent},body:JSON.stringify({project:projectId})});
                  if(!retry.ok)return {endpoint,ok:false,error:await httpFailure(retry)};
                  const data=await retry.json() as T;
                  if(!normalizeCloudGroups(data,nowSec).some(group=>group.buckets.some(bucket=>bucket.remaining_fraction_known)))return{endpoint,ok:false,error:'项目上下文未返回可验证配额'};
                  projectContextRecovered=true;return{endpoint,ok:true,data};
                }
              }
              if (!projectId || JSON.stringify(body(projectId))===JSON.stringify(body(null))) return { endpoint, ok: false, error: failure };
              // 403/权限受阻时按官方惯例去掉 project 再试一次（同端点内重试）。
              const retry = await fetchImpl(endpoint, {
                method: 'POST', signal: requestSignal(6000),
                headers: {
                  Authorization: `Bearer ${account.token.access_token}`,
                  'Content-Type': 'application/json',
                  'User-Agent': providerAgent,
                },
                body: JSON.stringify(body(null)),
              });
              if (!retry.ok) return { endpoint, ok: false, error: await httpFailure(retry) };
              return { endpoint, ok: true, data: await retry.json() as T };
            }
            return { endpoint, ok: true, data: await response.json() as T };
          } catch (error) {
            return { endpoint, ok: false, error: error instanceof Error ? error.message : 'request failed' };
          }
        }));
      };

      // 2-4) 并行发起 loadCodeAssist、fetchAvailableModels 与 retrieveUserQuotaSummary，消除 3 阶段串行 RTT 等待。
      const loadPromise = queryAll<any>(endpointSet('loadCodeAssist',CLOUD_CODE_LOAD_PROJECT_ENDPOINTS), () => ({ metadata: { ideType: 'ANTIGRAVITY' } })).then(results => {
        for (const result of results) {
          if (!result.ok) continue;
          const data = result.data ?? {};
          const project = data.cloudaicompanionProject;
          if (!projectObserved && (typeof project === 'string' || typeof project?.id === 'string')) {
            projectId = typeof project === 'string' ? project : project.id;
            account.token.project_id = projectId;
            projectObserved = true;
          }
          const rawTier = data.paidTier?.name || data.paidTier?.id || data.paid_tier?.name || data.paid_tier?.id ||
            data.currentTier?.name || data.currentTier?.id || data.current_tier?.name || data.current_tier?.id;
          if (!tierObserved && typeof rawTier === 'string' && rawTier.trim()) {
            subscriptionTier = String(rawTier);
            tierObserved = true;
          }
        }
        return results;
      });
      loadReady = loadPromise.then(() => undefined, () => undefined);
      const [loadResults, modelResults, summaryResults] = await Promise.all([
        loadPromise,
        queryAll<any>(endpointSet('fetchAvailableModels',QUOTA_API_ENDPOINTS), () => ({})),
        queryAll<any>(endpointSet('retrieveUserQuotaSummary',QUOTA_SUMMARY_ENDPOINTS), () => ({})),
      ]);
      for (const result of loadResults) {
        note('load', result.endpoint, result.ok);
      }
      throwIfUserAborted();

      // 3) fetchAvailableModels：全部端点各查一次，按优先级合并模型目录（prod 已知值不被 daily 覆盖）。
      const modelCatalogues: NormalizedModel[][] = [];
      let forwarding: Record<string, string> = {};
      for (const result of modelResults) {
        note('models', result.endpoint, result.ok);
        if (!result.ok) continue;
        modelCatalogues.push(normalizeCloudModels(result.data ?? {}, nowSec));
        const deprecated = result.data?.deprecatedModelIds;
        if (deprecated && typeof deprecated === 'object') {
          for (const [oldId, info] of Object.entries<any>(deprecated)) {
            if (info?.newModelId && !forwarding[oldId]) forwarding[oldId] = String(info.newModelId);
          }
        }
      }
      throwIfUserAborted();
      let freshModels = mergeModelCatalogues(modelCatalogues);

      // 4) retrieveUserQuotaSummary：全部端点各查一次，语义合并 family+window。
      const groupSets: NormalizedGroup[][] = [];
      for (const result of summaryResults) {
        note('summary', result.endpoint, result.ok);
        if (!result.ok) continue;
        groupSets.push(normalizeCloudGroups(result.data ?? {}, nowSec));
      }
      throwIfUserAborted();
      const freshGroups = mergeGroupSets(groupSets);
      if(providerContext&&!freshGroups.some(group=>group.buckets.some(bucket=>bucket.remaining_fraction_known))) {
        const reason=summaryResults.map(row=>row.error||(!row.ok?'读取失败':'未返回额度窗口')).join('；');
        throw new CloudQuotaAuthorityError('当前官方配额服务未返回可验证额度：'+reason+'。未采用其他环境的 100% 默认值');
      }

      if (freshModels.length === 0 && freshGroups.length === 0) {
        throw new Error('未能取得此账号的配额，已保留上次记录');
      }

      if(providerContext && !freshModels.some(model=>model.is_argon&&model.own_percentage_known) && !freshGroups.some(group=>group.family==='argon')) {
        const independent=await queryAll<any>([providerContext.origin+'/v1internal:retrieveUserQuota'],()=>projectContextRecovered&&projectObserved&&projectId?{project:projectId}:{});
        for(const result of independent) {note('independent-quota',result.endpoint,result.ok);if(result.ok)freshModels=mergeModelCatalogues([normalizeIndependentArgonQuota(result.data,nowSec),freshModels]);}
      }

      // 5) 与上一次快照做语义 carryover：fresh 覆盖同 family+window，旧桶/旧模型单独标 stale。
      const previousSource: QuotaSource = account.quota?.source === 'live' ? 'live' : 'cloud';
      const matchingScope=!providerContext||account.quota?.source==='live'||(account.quota?.refresh_state?.providerOrigin===providerContext.origin&&account.quota?.refresh_state?.providerUserAgent===providerContext.userAgent&&account.quota?.refresh_state?.requestScope==='account');
      const previousGroups = normalizeStoredGroups(matchingScope?account.quota?.quota_groups ?? []:[], account.quota?.last_updated ?? nowSec, previousSource);
      const previousModels = (matchingScope?account.quota?.models ?? []:[]).map(model => normalizedModelFromStored(model, previousSource));
      const { groups: mergedGroups, staleGroups } = mergeGroupsWithPrevious(freshGroups, previousGroups, Date.now());
      const { models: mergedModels, carriedCount } = mergeModelsWithPrevious(freshModels, previousModels);
      const windows = familyWindowsFromGroups(mergedGroups, Date.now());
      const applied = applyFamilyWindows(mergedModels, windows);

      // 6) 完整性：缺 family / 缺已知窗口 / 生产端点失败 / 预算超时 → complete=false，并保留原因。
      const expectedFamilies = new Set<Family>();
      for (const group of previousGroups) if (group.family !== 'other') expectedFamilies.add(group.family);
      for (const model of freshModels) if (model.family !== 'other' && model.disabled !== true) expectedFamilies.add(model.family);
      const presentFamilies = new Set(mergedGroups.filter(group => group.buckets.some(bucket => bucket.remaining_fraction_known && !bucket.stale)).map(group => group.family));
      const missingFamilies = [...expectedFamilies].filter(family => !presentFamilies.has(family));
      const missingWindows: { family: Family; window: WindowKind }[] = [];
      for (const previous of previousGroups) {
        for (const bucket of previous.buckets) {
          if (bucket.window === 'unspecified') continue;
          const present = mergedGroups.some(group => group.family === previous.family
            && group.buckets.some(item => item.window === bucket.window && item.remaining_fraction_known && !item.stale));
          if (!present) missingWindows.push({ family: previous.family, window: bucket.window });
        }
      }
      const production = (endpoint: string) => providerContext ? new URL(endpoint).origin===providerContext.origin : endpointPriority(endpoint) === 0;
      const productionSucceeded = summaryResults.some(result => result.ok && production(result.endpoint)
        && normalizeCloudGroups(result.data ?? {}, nowSec).length > 0)
        && modelResults.some(result => result.ok && production(result.endpoint)
          && normalizeCloudModels(result.data ?? {}, nowSec).length > 0);
      const usedFallbackEndpoint = !productionSucceeded;
      const hasFreshKnownBucket = mergedGroups.some(group => group.buckets.some(bucket => bucket.remaining_fraction_known && !bucket.stale));
      const complete = !deadlineFired && !userAborted() && missingFamilies.length === 0 && missingWindows.length === 0
        && freshModels.length > 0 && hasFreshKnownBucket && !usedFallbackEndpoint;

      const warnings: string[] = [];
      if (deadlineFired) warnings.push('REFRESH_BUDGET_TIMEOUT: 配额刷新超出整体预算，已保存本轮取得的有效数据');
      if (usedFallbackEndpoint) warnings.push('FALLBACK_ENDPOINT: 生产端点未成功，本轮数据来自 daily/sandbox');
      for (const family of missingFamilies) warnings.push(`MISSING_FAMILY:${family}: ${familyLabel(family)} 本轮未返回`);
      for (const item of missingWindows) warnings.push(`MISSING_WINDOW:${item.family}:${item.window}: ${familyLabel(item.family)} ${item.window} 窗口未返回`);
      for (const stale of staleGroups.slice(0, 12)) warnings.push(`CARRIED:${stale.name}: 沿用上次记录（${new Date(stale.observed_at * 1000).toISOString()}）`);
      if (applied.some(model => model.family === 'argon' && model.disabled === true)) warnings.push('ARGON_DISABLED: 当前账号无 Gemini 4 Argon 权限');
      if (applied.some(model => model.family === 'argon' && model.disabled === null && model.own_percentage_known)) warnings.push('ARGON_MODEL_QUOTA: Argon 模型自带 quotaInfo，但未返回明确周期窗口');

      const missingLabels = missingFamilies.map(familyLabel);
      account.quota_refresh_error = missingLabels.length > 0 ? `${missingLabels.join('、')} 配额未返回，已保留上次记录` : null;

      const groupObservations = mergedGroups
        .map(group => group.observed_at)
        .filter((value): value is number => typeof value === 'number');
      const lastUpdated = groupObservations.length > 0 ? Math.min(...groupObservations) : nowSec;
      const refreshState: QuotaRefreshState = {
        complete,
        endpointsAttempted: attempted,
        endpointsSucceeded: succeeded,
        missingFamilies,
        missingWindows,
        carriedGroups: staleGroups.length,
        carriedModels: carriedCount,
        refreshedAt: nowSec,
        usedFallbackEndpoint,
        ...(providerContext?{providerOrigin:providerContext.origin,providerUserAgent:providerContext.userAgent,requestScope:'account' as const,projectContextRecovered}:{}),
        ...(deadlineFired ? { error: '整体预算超时，已保存部分结果' } : {}),
      };

      account.quota = {
        models: applied.map(modelQuotaFromNormalized),
        quota_groups: mergedGroups.map(groupToQuotaGroup),
        is_forbidden: false,
        subscription_tier: subscriptionTier,
        last_updated: lastUpdated,
        model_forwarding_rules: forwarding,
        source: 'cloud',
        ...(staleGroups.length > 0 ? { stale_groups: staleGroups } : {}),
        refresh_state: refreshState,
        ...(warnings.length > 0 ? { quota_warnings: warnings } : {}),
      };

      signal?.throwIfAborted();
      await this.saveRefreshedAccount(account, account.token.refresh_token, signal);
      return account;
    } finally {
      clearTimeout(deadline);
    }
  }

  /**
   * 刷新账号池所有可用账号的配额数据
   */
  async refreshAllQuotas(fetchImpl: typeof globalThis.fetch = globalThis.fetch, options?: { signal?: AbortSignal }): Promise<{ accounts: Account[]; failures: { id: string; message: string }[] }> {
    options?.signal?.throwIfAborted();
    await this.syncFromExternalAgySwitch();
    options?.signal?.throwIfAborted();
    const index = await this.loadIndex();
    const enabledAccounts = index.accounts.filter(acc => !acc.disabled);
    if (fetchImpl === globalThis.fetch && enabledAccounts.length > 0) {
      await Promise.all([
        this.probeLiveLanguageServer(fetchImpl, { forceRefresh: true }).catch(() => null),
        this.resolveProviderContext(fetchImpl).catch(() => null),
      ]);
    }
    const results: Account[] = [];
    const failures: { id: string; message: string }[] = [];
    const concurrency = fetchImpl === globalThis.fetch ? Math.min(3, Math.max(1, enabledAccounts.length)) : 1;
    let cursor = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (cursor < enabledAccounts.length) {
        options?.signal?.throwIfAborted();
        const accMeta = enabledAccounts[cursor++]!;
        try {
          const updated = await this.refreshQuota(accMeta.id, fetchImpl, { skipSyncExternal: true, signal: options?.signal });
          results.push(updated);
        } catch (error) {
          if (options?.signal?.aborted) throw error;
          failures.push({ id: accMeta.id, message: error instanceof Error ? error.message : '刷新失败' });
        }
      }
    }));
    options?.signal?.throwIfAborted();
    return { accounts: results, failures };
  }

  private desktopEmailCache: { email: string | null; expiresAt: number } | null = null;

  /**
   * 探测本机 Antigravity 当前真实登录邮箱：
   * 1. 优先通过运行中 language_server RPC 探测；
   * 2. 若 language_server 未启动（如未打开工作区窗口），在宿主默认状态目录下回退读取 Antigravity state.vscdb 与 Keychain。
   */
  async detectCurrentAntigravityEmail(): Promise<string | null> {
    const ls = await this.probeLiveLanguageServer().catch(() => null);
    if (ls?.email) return ls.email;
    const isDefaultStateDir = this.stateDir === join(homedir(), 'Library', 'Application Support', 'GravityBox');
    if (!isDefaultStateDir) return null;
    const now = Date.now();
    if (this.desktopEmailCache && now < this.desktopEmailCache.expiresAt) {
      return this.desktopEmailCache.email;
    }
    let detected: string | null = null;
    const profiles = Array.from(new Set([this.target.profile, ...allApplicationTargets().map(t => t.profile)]));
    for (const profilePath of profiles) {
      if (detected) break;
      try {
        const vscdbPath = join(profilePath, 'User', 'globalStorage', 'state.vscdb');
        const { stdout } = await execFileAsync('/usr/bin/sqlite3', [
          '-readonly', '-json', vscdbPath,
          "SELECT key, value FROM ItemTable WHERE key IN ('antigravityUnifiedStateSync.userStatus', 'antigravityAuthStatus');",
        ], { timeout: 2000 });
        const rows = JSON.parse(stdout || '[]');
        for (const r of rows) {
          if (r.key === 'antigravityUnifiedStateSync.userStatus' && r.value) {
            let b64 = r.value;
            try { b64 = JSON.parse(r.value).data || r.value; } catch {}
            const buf = decodeTopicRow(b64, 'userStatusSentinelKey');
            const email = buf ? ProtobufReader.findString(buf, 7) : null;
            if (email && /^[^\s@]+@[^\s@]+$/.test(email)) { detected = email; break; }
          }
        }
        if (!detected) {
          for (const r of rows) {
            if (r.key === 'antigravityAuthStatus' && r.value) {
              try {
                const parsed = JSON.parse(r.value);
                if (typeof parsed?.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(parsed.email)) {
                  detected = parsed.email;
                  break;
                }
              } catch {}
            }
          }
        }
      } catch {}
    }
    if (!detected) {
      try {
        const pass = await new SystemKeychainAdapter().readPassword('gemini', 'antigravity');
        if (pass && pass.startsWith('go-keyring-base64:')) {
          const raw = Buffer.from(pass.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
          const parsed = JSON.parse(raw);
          const email = parsed?.token?.email || parsed?.id_token_email;
          if (typeof email === 'string' && /^[^\s@]+@[^\s@]+$/.test(email)) detected = email;
        }
      } catch {}
    }
    this.desktopEmailCache = { email: detected, expiresAt: now + 5000 };
    return detected;
  }

  /**
   * 列出所有账号及当前激活账号详情
   */
  async listAccounts(): Promise<{
    active_account_id: string | null;
    active_account: Account | null;
    accounts: AccountSummary[];
    total: number;
    revision: string;
  }> {
    const index = await this.loadIndex();
    let effectiveActiveId = index.current_account_id;
    const detectedEmail = await this.detectCurrentAntigravityEmail().catch(() => null);
    if (detectedEmail) {
      const matched = index.accounts.find(a => a.email.toLowerCase() === detectedEmail.toLowerCase());
      effectiveActiveId = matched?.id ?? null;
    }
    const activeAccount = effectiveActiveId ? await this.getAccount(effectiveActiveId) : null;
    const accountsWithRevision = await Promise.all(index.accounts.map(async acc => {
      const saved = await this.getAccount(acc.id);
      const readiness = accountCredentialReadiness(saved ?? acc as Account);
      return { ...acc, quota: saved?.quota ?? null, quota_refresh_error: saved?.quota_refresh_error ?? null, revision: computeAccountRevision(saved ?? acc) + ':' + readiness.state, credentialReadiness: readiness, quota_last_updated: saved?.quota?.last_updated ?? 0 };
    }));
    // 确保当前激活账号始终排在第一位
    accountsWithRevision.sort((a, b) => {
      const aActive = a.id === effectiveActiveId ? 1 : 0;
      const bActive = b.id === effectiveActiveId ? 1 : 0;
      return bActive - aActive;
    });
    const activeRevision = activeAccount ? computeAccountRevision(activeAccount) : '';
    const poolRevision = accountsWithRevision.map(a => a.revision).join(':');
    return {
      active_account_id: effectiveActiveId,
      active_account: activeAccount,
      accounts: accountsWithRevision,
      total: index.accounts.length,
      revision: createHash('sha256').update(activeRevision + ':' + poolRevision).digest('hex'),
    };
  }
}

/**
 * 将指定账号写入系统 Keychain (gemini/antigravity) 免密持久化
 */
export async function syncAccountToKeychain(
  acc: Account,
  keychain: KeychainAdapter = new SystemKeychainAdapter()
): Promise<void> {
  // 官方 Go 端按 oauth2.Token 解析：缺少 `expiry` 会被视为永不过期，从而永不刷新（约 1 小时后 401 并跳登录页）。
  // 因此必须写入 RFC3339 `expiry`；旧字段保留供 GravityBox 自身读取与回滚。
  const expirySec = Number(acc.token.expiry_timestamp);
  const expiry = Number.isFinite(expirySec) && expirySec > 0 ? new Date(expirySec * 1000).toISOString() : undefined;
  const expiresIn = expirySec > 0 ? Math.max(0, Math.floor(expirySec - Date.now() / 1000)) : acc.token.expires_in;
  const payload = JSON.stringify({
      token: {
        access_token: acc.token.access_token,
        token_type: acc.token.token_type || 'Bearer',
        refresh_token: acc.token.refresh_token,
        expiry,
        expires_in: expiresIn,
        expiry_timestamp: acc.token.expiry_timestamp,
        email: acc.email,
        project_id: acc.token.project_id,
        is_gcp_tos: acc.token.is_gcp_tos,
        id_token: acc.token.id_token,
      },
      ...(acc.token.is_gcp_tos ? {} : { auth_method: 'consumer' }),
      id_token_email: acc.email,
    });
    const b64 = Buffer.from(payload, 'utf8').toString('base64');
    await keychain.writePassword('gemini', 'antigravity', `go-keyring-base64:${b64}`);
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
