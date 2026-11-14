import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as https from 'node:https';
import * as http from 'node:http';
import { applicationTarget, matchingTargetForLanguageServerCommand, type ApplicationTarget } from './application-target.js';
import { resolveVerifiedLanguageServerPorts } from './discovery.js';
import { SqliteReadSnapshot } from './sqlite-read.js';
import {
  applyFamilyWindows,
  familyWindowsFromGroups,
  mergeGroupSets,
  mergeModelCatalogues,
  normalizeLiveGroups,
  normalizeLiveModels,
} from './quota.js';
import type { LiveLanguageServerStatus, ModelQuota, QuotaData, QuotaGroup } from './accounts.js';

const execFileAsync = promisify(execFile);

export type CloudProviderContext = { origin: string; userAgent: string; appVersion: string; clientSubType?: string; identityVersion?: 2 };
const CLOUD_ORIGINS = new Set(['https://cloudcode-pa.googleapis.com', 'https://daily-cloudcode-pa.googleapis.com', 'https://daily-cloudcode-pa.sandbox.googleapis.com']);

export function cloudOriginFromCommand(command: string, target = applicationTarget()): string | null {
  if (!command.startsWith(target.appPath + '/Contents/Resources/bin/language_server ')) return null;
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
  const expected = cloudProviderContextFromCommand(target.appPath + '/Contents/Resources/bin/language_server --cloud_code_endpoint '
    + value.origin + (value.clientSubType ? ' --subclient_type ' + value.clientSubType : ''), appVersion, target);
  return !!expected && value.appVersion === expected.appVersion && value.userAgent === expected.userAgent;
}

export class CloudQuotaAuthorityError extends Error {}

/**
 * 本地免密 RPC 请求 helper，自动处理 HTTP/HTTPS 与自签名证书
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

export async function probeLiveLanguageServerOnce(
  target: ApplicationTarget,
  fetchImpl: typeof fetch,
  options: { forceRefresh?: boolean },
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
    for (const port of ports) {
      try {
        let userStatusData: any = null;
        let quotaSummaryData: any = null;
        let activeProtocol: 'https' | 'http' = preferredProtocol ?? 'https';

        if (fetchImpl !== globalThis.fetch) {
          const resp = await fetchImpl(`http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrfToken },
            body: '{}',
          });
          if (resp.ok) userStatusData = await resp.json();
        } else {
          const firstProto: 'https' | 'http' = preferredProtocol ?? 'https';
          const secondProto: 'https' | 'http' = firstProto === 'https' ? 'http' : 'https';
          try {
            userStatusData = await localRpcFetch(firstProto, port, '/exa.language_server_pb.LanguageServerService/GetUserStatus', csrfToken);
            activeProtocol = firstProto;
          } catch {
            try {
              userStatusData = await localRpcFetch(secondProto, port, '/exa.language_server_pb.LanguageServerService/GetUserStatus', csrfToken);
              activeProtocol = secondProto;
            } catch {}
          }
        }

        const userStatus = userStatusData?.userStatus;
        if (!userStatus?.email) continue;

        if (fetchImpl === globalThis.fetch) {
          cachedLiveEndpoint = {
            targetAppPath: target.appPath,
            pid: targetPid,
            port,
            protocol: activeProtocol,
            csrfToken,
          };
        }

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
          const reqBody = JSON.stringify({ forceRefresh: options.forceRefresh === true });
          const summaryTimeoutMs = 6000;
          try {
            const qRes = await localRpcFetch(activeProtocol, port, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', csrfToken, reqBody, summaryTimeoutMs);
            quotaSummaryData = qRes?.response || qRes;
          } catch {
            try {
              const qRes = await localRpcFetch(fallbackProtocol, port, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', csrfToken, reqBody, summaryTimeoutMs);
              quotaSummaryData = qRes?.response || qRes;
            } catch {}
          }
        }

        const email = String(userStatus.email);
        const name = userStatus.name ? String(userStatus.name) : null;
        const userTierId = typeof userStatus.userTier?.id === 'string' ? userStatus.userTier.id : null;
        const userTierName = typeof userStatus.userTier?.name === 'string' ? userStatus.userTier.name : null;
        const isEnterpriseVertex = Boolean(
          userTierId === 'agy-business-paygo-tier' ||
          userStatus.userTier?.usesGcpTos === true ||
          userStatus.userTier?.userDefinedCloudaicompanionProject === true ||
          /agent platform|business|enterprise/i.test(userTierName || '')
        );
        const accountType: 'consumer' | 'enterprise_vertex' = isEnterpriseVertex ? 'enterprise_vertex' : 'consumer';
        const tierRaw = isEnterpriseVertex
          ? (userStatus.planStatus?.planInfo?.planName || userStatus.planStatus?.planInfo?.teamsTier || userStatus.paidTier?.name || '')
          : (userStatus.userTier?.name || userStatus.userTier?.id || userStatus.planStatus?.planInfo?.planName || userStatus.paidTier?.name || '');
        let tier = isEnterpriseVertex ? '' : 'FREE';
        if (/ultra/i.test(tierRaw)) tier = 'ULTRA';
        else if (/pro/i.test(tierRaw)) tier = 'PRO';
        else if (!isEnterpriseVertex && tierRaw) tier = 'FREE';

        const observedAt = Math.floor(Date.now() / 1000);
        const clientConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs || [];
        const models = mergeModelCatalogues([normalizeLiveModels(clientConfigs, observedAt)]);
        const groups = mergeGroupSets([normalizeLiveGroups(quotaSummaryData, observedAt)]);
        const windows = familyWindowsFromGroups(groups, Date.now());
        const applied = applyFamilyWindows(models, windows);
        const missingFamilies = (['gemini', 'claude', 'argon', 'carbon'] as const).filter(family =>
          models.some(model => model.family === family && model.disabled !== true)
          && !groups.some(group => group.family === family && group.buckets.some(bucket => bucket.remaining_fraction_known))
          && !((family === 'argon' || family === 'carbon') && models.some(m => m.family === family && m.own_percentage_known && !m.own_stale)));
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
          quota_warnings: models.length === 0 ? ['NO_MODEL_RECORDS: live 未返回模型列表'] : undefined,
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
    }
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

    const { stdout: psOut } = await execFileAsync('/bin/ps', ['-ax', '-ww', '-o', 'pid=,args='], { timeout: 3000 });
    const lines = psOut.split('\n');
    let targetPid = 0;
    let csrfToken = '';
    let matchedAppPath = target.appPath;

    for (const line of lines) {
      if (line.includes('--csrf_token')) {
        const trimmed = line.trim();
        const mPid = trimmed.match(/^(\d+)\s+(.+)$/);
        if (mPid) {
          const pid = parseInt(mPid[1]!, 10);
          const cmd = mPid[2]!;
          const matchedTarget = matchingTargetForLanguageServerCommand(cmd, target);
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

    let ports: number[] = [];
    if (fetchImpl === globalThis.fetch) {
      const verifiedPorts = await resolveVerifiedLanguageServerPorts(targetPid, matchedAppPath);
      if (!verifiedPorts || verifiedPorts.length === 0) return null;
      ports = verifiedPorts;
    } else {
      const { stdout: lsofOut } = await execFileAsync(
        '/usr/sbin/lsof',
        ['-nP', '-a', '-p', String(targetPid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
        { timeout: 3000 }
      );
      const portMatches = Array.from(lsofOut.matchAll(/n127\.0\.0\.1:(\d+)/g)).map(m => parseInt(m[1]!, 10));
      ports = Array.from(new Set(portMatches));
      if (ports.length === 0) return null;
    }

    return await tryPortList(targetPid, csrfToken, ports);

    for (const port of ports) {
      try {
        let userStatusData: any = null;
        let quotaSummaryData: any = null;
        let activeProtocol: 'https' | 'http' = 'https';

        if (fetchImpl !== globalThis.fetch) {
          const resp = await fetchImpl(`http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrfToken },
            body: '{}',
          });
          if (resp.ok) userStatusData = await resp.json();
        } else {
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
          const reqBody = JSON.stringify({ forceRefresh: options.forceRefresh === true });
          const summaryTimeoutMs = 6000;
          try {
            const qRes = await localRpcFetch(activeProtocol, port, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', csrfToken, reqBody, summaryTimeoutMs);
            quotaSummaryData = qRes?.response || qRes;
          } catch {
            try {
              const qRes = await localRpcFetch(fallbackProtocol, port, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', csrfToken, reqBody, summaryTimeoutMs);
              quotaSummaryData = qRes?.response || qRes;
            } catch {}
          }
        }

        const email = String(userStatus.email);
        const name = userStatus.name ? String(userStatus.name) : null;
        const userTierId = typeof userStatus.userTier?.id === 'string' ? userStatus.userTier.id : null;
        const userTierName = typeof userStatus.userTier?.name === 'string' ? userStatus.userTier.name : null;
        const isEnterpriseVertex = Boolean(
          userTierId === 'agy-business-paygo-tier' ||
          userStatus.userTier?.usesGcpTos === true ||
          userStatus.userTier?.userDefinedCloudaicompanionProject === true ||
          /agent platform|business|enterprise/i.test(userTierName || '')
        );
        const accountType: 'consumer' | 'enterprise_vertex' = isEnterpriseVertex ? 'enterprise_vertex' : 'consumer';
        const tierRaw = isEnterpriseVertex
          ? (userStatus.planStatus?.planInfo?.planName || userStatus.planStatus?.planInfo?.teamsTier || userStatus.paidTier?.name || '')
          : (userStatus.userTier?.name || userStatus.userTier?.id || userStatus.planStatus?.planInfo?.planName || userStatus.paidTier?.name || '');
        let tier = isEnterpriseVertex ? '' : 'FREE';
        if (/ultra/i.test(tierRaw)) tier = 'ULTRA';
        else if (/pro/i.test(tierRaw)) tier = 'PRO';
        else if (!isEnterpriseVertex && tierRaw) tier = 'FREE';

        const observedAt = Math.floor(Date.now() / 1000);
        const clientConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs || [];
        const models = mergeModelCatalogues([normalizeLiveModels(clientConfigs, observedAt)]);
        const groups = mergeGroupSets([normalizeLiveGroups(quotaSummaryData, observedAt)]);
        const windows = familyWindowsFromGroups(groups, Date.now());
        const applied = applyFamilyWindows(models, windows);
        const missingFamilies = (['gemini', 'claude', 'argon', 'carbon'] as const).filter(family =>
          models.some(model => model.family === family && model.disabled !== true)
          && !groups.some(group => group.family === family && group.buckets.some(bucket => bucket.remaining_fraction_known))
          && !((family === 'argon' || family === 'carbon') && models.some(m => m.family === family && m.own_percentage_known && !m.own_stale)));
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
          quota_warnings: models.length === 0 ? ['NO_MODEL_RECORDS: live 未返回模型列表'] : undefined,
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
    }
  } catch {}
  return null;
}
