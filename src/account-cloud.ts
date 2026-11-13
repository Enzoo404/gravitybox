import { CloudQuotaAuthorityError, type CloudProviderContext } from './account-probe.js';
import {
  endpointHost,
  endpointPriority,
  familyLabel,
  groupToQuotaGroup,
  modelQuotaFromNormalized,
  normalizedModelFromStored,
  type Account,
  type QuotaRefreshState,
} from './account-quota.js';
import {
  applyFamilyWindows,
  familyWindowsFromGroups,
  mergeGroupSets,
  mergeGroupsWithPrevious,
  mergeModelCatalogues,
  mergeModelsWithPrevious,
  normalizeCloudGroups,
  normalizeCloudModels,
  normalizeIndependentArgonQuota,
  normalizeStoredGroups,
  type Family,
  type NormalizedGroup,
  type NormalizedModel,
  type QuotaSource,
  type WindowKind,
} from './quota.js';

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


export async function fetchCloudQuotaForAccount(params: {
  account: Account;
  providerContext: CloudProviderContext | null;
  fetchImpl: typeof globalThis.fetch;
  signal?: AbortSignal;
  onTokenRefreshed: (account: Account, previousRefresh: string) => Promise<void>;
}): Promise<Account> {
  const { account, providerContext, fetchImpl, signal } = params;
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
        await params.onTokenRefreshed(account, previousRefresh);
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
    const hasStandaloneOwnQuota = freshModels.some(model =>
      (model.family === 'argon' || model.family === 'carbon') && model.disabled !== true
      && model.own_percentage_known && !model.own_stale);
    if(providerContext&&!freshGroups.some(group=>group.buckets.some(bucket=>bucket.remaining_fraction_known)) && !hasStandaloneOwnQuota) {
      const reason=summaryResults.map(row=>row.error||(!row.ok?'读取失败':'未返回额度窗口')).join('；');
      throw new CloudQuotaAuthorityError('当前官方配额服务未返回可验证额度：'+reason+'。未采用其他环境的 100% 默认值');
    }

    if (freshModels.length === 0 && freshGroups.length === 0) {
      throw new Error('未能取得此账号的配额，已保留上次记录');
    }

    if(providerContext && ['argon','carbon'].some(family => (family === 'argon' || freshModels.some(m=>m.family===family) || freshGroups.some(g=>g.family===family)) && !freshModels.some(model=>model.family===family&&model.own_percentage_known) && !freshGroups.some(group=>group.family===family))) {
      const independent=await queryAll<any>([providerContext.origin+'/v1internal:retrieveUserQuota'],()=>projectContextRecovered&&projectObserved&&projectId?{project:projectId}:{});
      for(const result of independent) {note('independent-quota',result.endpoint,result.ok);if(result.ok)freshModels=mergeModelCatalogues([freshModels,normalizeIndependentArgonQuota(result.data,nowSec)]);}
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
    for (const model of applied) if ((model.family === 'argon' || model.family === 'carbon') && model.disabled !== true && model.own_percentage_known && !model.own_stale) presentFamilies.add(model.family);
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
      && (normalizeCloudGroups(result.data ?? {}, nowSec).length > 0 || hasStandaloneOwnQuota))
      && modelResults.some(result => result.ok && production(result.endpoint)
        && normalizeCloudModels(result.data ?? {}, nowSec).length > 0);
    const usedFallbackEndpoint = !productionSucceeded;
    const hasFreshKnownBucket = hasStandaloneOwnQuota || mergedGroups.some(group => group.buckets.some(bucket => bucket.remaining_fraction_known && !bucket.stale));
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
    return account;
  } finally {
    clearTimeout(deadline);
  }
}
