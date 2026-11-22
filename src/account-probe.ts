import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as https from 'node:https';
import * as http from 'node:http';
import { applicationTarget, matchingTargetForLanguageServerCommand, type ApplicationTarget } from './application-target.js';
import { resolveVerifiedLanguageServerPorts } from './discovery.js';
import { bundleLanguageServerPath, isLinux, resolveLsofBinary, resolvePsBinary } from './platform.js';
import { SqliteReadSnapshot } from './sqlite-read.js';
import {
  applyFamilyWindows,
  buildArgonStatus,
  buildCarbonStatus,
  familyWindowsFromGroups,
  isExcludedFromStandaloneModelPool,
  mergeGroupSets,
  mergeModelCatalogues,
  normalizeLiveGroups,
  normalizeLiveModels,
  resolveModelsWithGroupDescriptions,
} from './quota.js';
import type { LiveLanguageServerStatus, ModelQuota, QuotaData, QuotaGroup } from './accounts.js';
import { bt } from './i18n.js';

const execFileAsync = promisify(execFile);

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number; maxBuffer?: number }
) => Promise<{ stdout: string; stderr?: string }>;

export type ProbeLiveLanguageServerOptions = {
  forceRefresh?: boolean;
  execFileImpl?: ExecFileLike;
};

export type LanguageServerCandidate = {
  pid: number;
  cmd: string;
  appPath: string;
};

const defaultExecFile: ExecFileLike = (file, args, options) =>
  execFileAsync(file, args, { encoding: 'utf8', ...options });

/** Collect all running language_server candidates matching the supported application target. */
export function collectLanguageServerCandidates(
  psOut: string,
  target: ApplicationTarget = applicationTarget()
): LanguageServerCandidate[] {
  const candidates: LanguageServerCandidate[] = [];
  for (const line of psOut.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const mPid = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!mPid) continue;
    const pidText = mPid[1];
    const cmd = mPid[2];
    if (!pidText || !cmd) continue;
    const pid = Number.parseInt(pidText, 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const matchedTarget = matchingTargetForLanguageServerCommand(cmd, target);
    if (!matchedTarget) continue;
    candidates.push({ pid, cmd, appPath: matchedTarget.appPath });
  }
  return candidates;
}

/** Extract legacy (<= 2.33.0) `--csrf_token` from language_server CLI arguments. */
export function extractCsrfTokenFromCommand(cmd: string): string | null {
  const match = cmd.match(/(?:^|\s)--csrf_token(?:=|\s+)([^\s]+)/);
  return match?.[1] ?? null;
}

/**
 * Extract `ANTIGRAVITY_SERVER_CSRF_TOKEN` (>= 2.34.0) from `ps -E -p <pid> -ww -o args=` output.
 * Strips the leading command-line prefix when present so args or spaces in preceding env vars do not interfere.
 */
export function extractCsrfTokenFromPsEnv(psEnvOutput: string, cmd = ''): string | null {
  const trimmedOut = psEnvOutput.trim();
  if (!trimmedOut) return null;
  const trimmedCmd = cmd.trim();
  let envSection = trimmedOut;
  if (trimmedCmd && trimmedOut.startsWith(trimmedCmd)) {
    const rest = trimmedOut.slice(trimmedCmd.length);
    if (rest.length === 0 || /^\s/.test(rest)) {
      envSection = rest;
    }
  }
  const match = envSection.match(/(?:^|\s)ANTIGRAVITY_SERVER_CSRF_TOKEN=([^\s]+)/);
  return match?.[1] ?? null;
}

/** Parse unique loopback IPv4 listening ports from `lsof -Fn` output. */
export function parseLoopbackListenPorts(lsofOut: string): number[] {
  const ports: number[] = [];
  for (const match of lsofOut.matchAll(/n127\.0\.0\.1:(\d+)/g)) {
    const portText = match[1];
    if (!portText) continue;
    const port = Number.parseInt(portText, 10);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      ports.push(port);
    }
  }
  return Array.from(new Set(ports));
}

/** Extract `ANTIGRAVITY_SERVER_CSRF_TOKEN` (>= 2.34.0) from Linux `/proc/<pid>/environ` NUL-delimited bytes. */
export function extractCsrfTokenFromProcEnviron(raw: Buffer | string): string | null {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  for (const entry of text.split('\0')) {
    if (entry.startsWith('ANTIGRAVITY_SERVER_CSRF_TOKEN=')) {
      const value = entry.slice('ANTIGRAVITY_SERVER_CSRF_TOKEN='.length).trim();
      if (value) return value;
    }
  }
  return null;
}

async function resolveCandidateCsrfToken(
  candidate: LanguageServerCandidate,
  execFileFn: ExecFileLike,
  useNativeLinuxProc = false
): Promise<string | null> {
  const cliToken = extractCsrfTokenFromCommand(candidate.cmd);
  if (cliToken) return cliToken;
  if (useNativeLinuxProc) {
    try {
      const rawEnv = await readFile(`/proc/${candidate.pid}/environ`);
      const token = extractCsrfTokenFromProcEnviron(rawEnv);
      if (token) return token;
    } catch {}
  }
  try {
    const { stdout: psEnvOut } = await execFileFn(
      resolvePsBinary(),
      ['-E', '-p', String(candidate.pid), '-ww', '-o', 'args='],
      { timeout: 3000 }
    );
    return extractCsrfTokenFromPsEnv(psEnvOut, candidate.cmd);
  } catch {
    return null;
  }
}

async function resolveCandidatePorts(
  candidate: LanguageServerCandidate,
  useVerifiedBundlePorts: boolean,
  execFileFn: ExecFileLike
): Promise<number[]> {
  if (useVerifiedBundlePorts) {
    const verifiedPorts = await resolveVerifiedLanguageServerPorts(candidate.pid, candidate.appPath);
    return verifiedPorts ?? [];
  }
  try {
    const { stdout: lsofOut } = await execFileFn(
      resolveLsofBinary(),
      ['-nP', '-a', '-p', String(candidate.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
      { timeout: 3000 }
    );
    return parseLoopbackListenPorts(lsofOut);
  } catch {
    return [];
  }
}

export type CloudProviderContext = { origin: string; userAgent: string; appVersion: string; clientSubType?: string; identityVersion?: 2 };
const CLOUD_ORIGINS = new Set(['https://cloudcode-pa.googleapis.com', 'https://daily-cloudcode-pa.googleapis.com', 'https://daily-cloudcode-pa.sandbox.googleapis.com']);

export function cloudOriginFromCommand(command: string, target = applicationTarget()): string | null {
  if (!command.startsWith(bundleLanguageServerPath(target.appPath) + ' ')) return null;
  const dataDirectory = command.match(/(?:^|\s)--app_data_dir(?:=|\s+)([^\s"]+)/)?.[1];
  if (dataDirectory && dataDirectory !== target.dataDirectoryName) return null;
  const value = command.match(/(?:^|\s)--cloud_code_endpoint(?:=|\s+)([^\s"]+)/)?.[1];
  return value && CLOUD_ORIGINS.has(value.replace(/\/$/, '')) ? value.replace(/\/$/, '') : null;
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
  return {
    origin,
    appVersion,
    clientSubType,
    identityVersion: 2,
    userAgent: ['antigravity', clientSubType, appVersion].filter(Boolean).join('/'),
  };
}

export function validCachedCloudProviderContext(value: any, appVersion: string, target = applicationTarget()): value is CloudProviderContext {
  if (!value || value.identityVersion !== 2 || !CLOUD_ORIGINS.has(value.origin)
    || typeof value.clientSubType !== 'string'
    || (value.clientSubType !== '' && !/^[a-z][a-z0-9_-]{0,31}$/.test(value.clientSubType))) return false;
  const expected = cloudProviderContextFromCommand(bundleLanguageServerPath(target.appPath) + ' --cloud_code_endpoint '
    + value.origin + (value.clientSubType ? ' --subclient_type ' + value.clientSubType : ''), appVersion, target);
  return !!expected && value.appVersion === expected.appVersion && value.userAgent === expected.userAgent;
}

export class CloudQuotaAuthorityError extends Error {}

const MAX_LOCAL_RPC_BYTES = 4 * 1024 * 1024;

/**
 * 本地免密 RPC 请求 helper，自动处理 HTTP/HTTPS、自签名证书、硬挂钟超时与 4MB 载荷上限
 */
export async function localRpcFetch(
  protocol: 'http' | 'https',
  port: number,
  path: string,
  csrfToken: string,
  body = '{}',
  timeoutMs = 2500
): Promise<any> {
  return new Promise((resolveReply, rejectReply) => {
    let settled = false;
    let wallTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (fn: (val: any) => void, val: any) => {
      if (settled) return;
      settled = true;
      if (wallTimer) {
        clearTimeout(wallTimer);
        wallTimer = null;
      }
      fn(val);
    };
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
        timeout: timeoutMs,
      },
      res => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        res.on('data', (chunk: Buffer | string) => {
          if (settled) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buf.length;
          if (receivedBytes > MAX_LOCAL_RPC_BYTES) {
            req.destroy();
            finish(rejectReply, new Error(bt('main.response_too_large')));
            return;
          }
          chunks.push(buf);
        });
        res.on('error', err => finish(rejectReply, err));
        res.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks, receivedBytes).toString('utf8');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              finish(resolveReply, JSON.parse(data));
            } catch (err) {
              finish(rejectReply, err);
            }
          } else {
            finish(rejectReply, new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    wallTimer = setTimeout(() => {
      req.destroy();
      finish(rejectReply, new Error(bt('account_probe.err.rpc_timeout')));
    }, Math.max(250, timeoutMs));
    wallTimer.unref?.();
    req.on('error', err => finish(rejectReply, err));
    req.on('timeout', () => {
      req.destroy();
      finish(rejectReply, new Error(bt('account_probe.err.rpc_timeout')));
    });
    req.write(body);
    req.end();
  });
}

export async function readAntigravityStateDb(vscdbPath: string, keys: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!existsSync(vscdbPath) || keys.length === 0) return out;
  const reader = new SqliteReadSnapshot(vscdbPath);
  try {
    const quotedKeys = keys.map(k => `'${String(k).replaceAll("'", "''")}'`).join(', ');
    const res = await reader.query(`SELECT key, value FROM ItemTable WHERE key IN (${quotedKeys});`);
    if (res.ok && Array.isArray(res.rows)) {
      for (const r of res.rows) {
        if (typeof r?.key === 'string' && typeof r?.value === 'string') {
          out.set(r.key, r.value);
        }
      }
    }
  } catch {}
  finally {
    await reader.close().catch(() => {});
  }
  return out;
}

export function extractTopicDataString(rawValue: string | undefined): string {
  if (!rawValue) return '';
  try {
    const parsed = JSON.parse(rawValue);
    return typeof parsed?.data === 'string' ? parsed.data : rawValue;
  } catch {
    return rawValue;
  }
}

let cachedLiveEndpoint: {
  targetAppPath: string;
  pid: number;
  port: number;
  protocol: 'https' | 'http';
  csrfToken: string;
} | null = null;

export function clearLiveEndpointCache(): void {
  cachedLiveEndpoint = null;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isEnterpriseVertexUserStatus(userStatus: any): boolean {
  const userTierId = typeof userStatus?.userTier?.id === 'string' ? userStatus.userTier.id : null;
  const userTierName = typeof userStatus?.userTier?.name === 'string' ? userStatus.userTier.name : null;
  return Boolean(
    userTierId === 'agy-business-paygo-tier' ||
    userStatus?.userTier?.usesGcpTos === true ||
    userStatus?.userTier?.userDefinedCloudaicompanionProject === true ||
    /agent platform|business|enterprise/i.test(userTierName || '')
  );
}

function classifySubscriptionTierCandidate(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (!text) return '';
  if (/ultra/i.test(text)) return 'ULTRA';
  if (/enterprise/i.test(text)) return 'ENTERPRISE';
  if (/\b(?:business|team|teams|workspace)\b/i.test(text)) return 'TEAM';
  if (/\bplus\b/i.test(text)) return 'PLUS';
  if (/\b(?:pro|ai\s+premium)\b/i.test(text)) return 'PRO';
  if (/\b(?:free|starter|trial)\b/i.test(text)) return 'FREE';
  return '';
}

/**
 * 解析 GetUserStatus 返回的订阅等级：
 * Google AI Ultra 消费级账号在 planStatus.planInfo.planName 中同样返回 "Pro"，
 * 真实 Ultra 身份位于 userStatus.userTier (id: "g1-ultra-tier", name: "Google AI Ultra") 或 g1Tier。
 */
export function resolveProbeSubscriptionTier(
  userStatus: any,
  isEnterpriseVertex = isEnterpriseVertexUserStatus(userStatus)
): string {
  if (!userStatus || typeof userStatus !== 'object') return '';
  const primaryCandidates = isEnterpriseVertex
    ? [
        userStatus.planStatus?.planInfo?.planName,
        userStatus.planStatus?.planInfo?.teamsTier,
        userStatus.paidTier?.id,
        userStatus.paidTier?.name,
      ]
    : [
        userStatus.userTier?.id,
        userStatus.userTier?.name,
        userStatus.userTier?.description,
        userStatus.g1Tier,
        userStatus.g1_tier,
        userStatus.paidTier?.id,
        userStatus.paidTier?.name,
      ];
  const fallbackCandidates = isEnterpriseVertex
    ? []
    : [
        userStatus.planStatus?.planInfo?.planName,
        userStatus.planStatus?.planInfo?.teamsTier,
      ];
  const allCandidates = [...primaryCandidates, ...fallbackCandidates];
  if (allCandidates.some(v => typeof v === 'string' && /ultra/i.test(v))) {
    return 'ULTRA';
  }
  for (const candidate of primaryCandidates) {
    const resolved = classifySubscriptionTierCandidate(candidate);
    if (resolved) return resolved;
  }
  for (const candidate of fallbackCandidates) {
    const resolved = classifySubscriptionTierCandidate(candidate);
    if (resolved) return resolved;
  }
  return '';
}

/**
 * 合并实时/新探测到的套餐等级与历史落盘套餐：
 * - 新探测为空串/缺失（如瞬态未返回或企业 Vertex AI 缺省）时保留已保存的高阶套餐；
 * - 新探测明确返回 FREE 且本次刷新具备完整可信依据（allowFreeDowngrade !== false）时，允许从 PRO/ULTRA 正常降级为 FREE。
 */
export function mergeSubscriptionTier(
  freshTier: string | null | undefined,
  savedTier: string | null | undefined,
  options?: boolean | { allowFreeDowngrade?: boolean }
): string | null | undefined {
  const fresh = typeof freshTier === 'string' ? freshTier.trim() : '';
  const saved = typeof savedTier === 'string' ? savedTier.trim() : '';
  if (!fresh) return saved || freshTier;
  const allowFreeDowngrade =
    typeof options === 'boolean' ? options : options?.allowFreeDowngrade !== false;
  if (/^(?:FREE|STARTER|TRIAL)$/i.test(fresh) && !allowFreeDowngrade) {
    return saved || 'FREE';
  }
  return fresh;
}

export async function probeLiveLanguageServerOnce(
  target: ApplicationTarget,
  fetchImpl: typeof fetch,
  options: ProbeLiveLanguageServerOptions,
  mappers: {
    modelQuotaFromNormalized: (model: ReturnType<typeof applyFamilyWindows>[number]) => ModelQuota;
    groupToQuotaGroup: (group: ReturnType<typeof mergeGroupSets>[number]) => QuotaGroup;
  }
): Promise<LiveLanguageServerStatus | null> {
  const tryPortList = async (
    targetPid: number,
    csrfToken: string,
    ports: number[],
    preferredProtocol?: 'https' | 'http'
  ): Promise<LiveLanguageServerStatus | null> => {
    const probeSinglePortStatus = async (port: number): Promise<{ port: number; userStatusData: any; activeProtocol: 'https' | 'http' } | null> => {
      if (fetchImpl !== globalThis.fetch) {
        try {
          const resp = await fetchImpl(`http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrfToken },
            body: '{}',
          });
          if (resp.ok) {
            const data = await resp.json();
            if (data?.userStatus?.email) return { port, userStatusData: data, activeProtocol: preferredProtocol ?? 'https' };
          }
        } catch {}
        return null;
      }
      const firstProto: 'https' | 'http' = preferredProtocol ?? 'https';
      const secondProto: 'https' | 'http' = firstProto === 'https' ? 'http' : 'https';
      try {
        const data = await localRpcFetch(firstProto, port, '/exa.language_server_pb.LanguageServerService/GetUserStatus', csrfToken, '{}', 1200);
        if (data?.userStatus?.email) return { port, userStatusData: data, activeProtocol: firstProto };
      } catch {
        try {
          const data = await localRpcFetch(secondProto, port, '/exa.language_server_pb.LanguageServerService/GetUserStatus', csrfToken, '{}', 1000);
          if (data?.userStatus?.email) return { port, userStatusData: data, activeProtocol: secondProto };
        } catch {}
      }
      return null;
    };

    let matchedPortInfo: { port: number; userStatusData: any; activeProtocol: 'https' | 'http' } | null = null;
    if (fetchImpl !== globalThis.fetch || ports.length <= 1) {
      for (const port of ports) {
        const found = await probeSinglePortStatus(port);
        if (found) {
          matchedPortInfo = found;
          break;
        }
      }
    } else {
      try {
        matchedPortInfo = await Promise.any(
          ports.map(async port => {
            const found = await probeSinglePortStatus(port);
            if (!found) throw new Error('port_not_rpc');
            return found;
          })
        );
      } catch {
        matchedPortInfo = null;
      }
    }

    if (!matchedPortInfo) return null;
    const { port, userStatusData, activeProtocol } = matchedPortInfo;
    const userStatus = userStatusData?.userStatus;
    if (!userStatus?.email) return null;

    if (fetchImpl === globalThis.fetch) {
      cachedLiveEndpoint = {
        targetAppPath: target.appPath,
        pid: targetPid,
        port,
        protocol: activeProtocol,
        csrfToken,
      };
    }

    let quotaSummaryData: any = null;
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
      const reqBody = JSON.stringify({ forceRefresh: options?.forceRefresh === true });
      // GetUserStatus 已验证端口传输协议，严禁反向协议重试以免超时翻倍；被动探测收紧预算防止拖慢冷启动
      const summaryTimeoutMs = options?.forceRefresh === true ? 4500 : 2200;
      try {
        const qRes = await localRpcFetch(activeProtocol, port, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', csrfToken, reqBody, summaryTimeoutMs);
        quotaSummaryData = qRes?.response || qRes;
      } catch {}
    }

    try {
      const email = String(userStatus.email);
      const name = userStatus.name ? String(userStatus.name) : null;
      const userTierId = typeof userStatus.userTier?.id === 'string' ? userStatus.userTier.id : null;
      const userTierName = typeof userStatus.userTier?.name === 'string' ? userStatus.userTier.name : null;
      const isEnterpriseVertex = isEnterpriseVertexUserStatus(userStatus);
      const accountType: 'consumer' | 'enterprise_vertex' = isEnterpriseVertex ? 'enterprise_vertex' : 'consumer';
      const tier = resolveProbeSubscriptionTier(userStatus, isEnterpriseVertex);

      const observedAt = Math.floor(Date.now() / 1000);
      const cascadeData = userStatus.cascadeModelConfigData ?? {};
      const clientConfigs = cascadeData.clientModelConfigs || cascadeData.client_model_configs || [];
      const clientModelSorts = cascadeData.clientModelSorts ?? cascadeData.client_model_sorts;
      const groups = mergeGroupSets([normalizeLiveGroups(quotaSummaryData, observedAt)]);
      const models = resolveModelsWithGroupDescriptions(
        mergeModelCatalogues([normalizeLiveModels(clientConfigs, observedAt, { clientModelSorts })]),
        groups,
      );
      const windows = familyWindowsFromGroups(groups, Date.now());
      const applied = applyFamilyWindows(models, windows);
      const liveArgon = buildArgonStatus(applied, groups, windows, Date.now(), tier);
      const liveCarbon = buildCarbonStatus(applied, groups, windows, Date.now(), liveArgon, tier);
      const isIgnoredStandalone = (family: 'gemini' | 'claude' | 'argon' | 'carbon'): boolean =>
        (family === 'argon' && (liveArgon.mode === 'unified' || liveArgon.mode === 'disabled'))
        || (family === 'carbon' && (liveCarbon.mode === 'unified' || liveCarbon.mode === 'disabled'));
      const missingFamilies = (['gemini', 'claude', 'argon', 'carbon'] as const).filter(family =>
        !isIgnoredStandalone(family)
        && models.some(model => model.family === family && !isExcludedFromStandaloneModelPool(model))
        && !groups.some(group => group.family === family && group.buckets.some(bucket => bucket.disabled !== true && bucket.remaining_fraction_known))
        && !((family === 'argon' || family === 'carbon') && models.some(m => m.family === family && !isExcludedFromStandaloneModelPool(m) && m.own_percentage_known && !m.own_stale)));
      const quotaData: QuotaData = {
        models: applied.map(mappers.modelQuotaFromNormalized),
        quota_groups: groups.map(mappers.groupToQuotaGroup),
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
        quota_warnings: models.length === 0 ? [`NO_MODEL_RECORDS:${bt('account_probe.warn.no_model_records')}`] : undefined,
      };

      return {
        email,
        name,
        tier,
        accountType,
        userTierId,
        userTierName,
        quota: quotaData,
      };
    } catch {}
    return null;
  };

  try {
    if (
      fetchImpl === globalThis.fetch &&
      cachedLiveEndpoint &&
      cachedLiveEndpoint.targetAppPath === target.appPath &&
      isPidAlive(cachedLiveEndpoint.pid)
    ) {
      const fastRes = await tryPortList(
        cachedLiveEndpoint.pid,
        cachedLiveEndpoint.csrfToken,
        [cachedLiveEndpoint.port],
        cachedLiveEndpoint.protocol
      );
      if (fastRes) return fastRes;
      cachedLiveEndpoint = null;
    }

    const execFileFn = options?.execFileImpl ?? defaultExecFile;
    const useVerifiedBundlePorts = fetchImpl === globalThis.fetch;
    const { stdout: psOut } = await execFileFn(resolvePsBinary(), ['-ax', '-ww', '-o', 'pid=,args='], { timeout: 3000 });
    const candidates = collectLanguageServerCandidates(psOut, target);

    for (const candidate of candidates) {
      const csrfToken = await resolveCandidateCsrfToken(candidate, execFileFn, isLinux && !options?.execFileImpl);
      if (!csrfToken) continue;

      const ports = await resolveCandidatePorts(candidate, useVerifiedBundlePorts, execFileFn);
      if (ports.length === 0) continue;

      const liveStatus = await tryPortList(candidate.pid, csrfToken, ports);
      if (liveStatus) return liveStatus;
    }

    return null;
  } catch {}
  return null;
}
