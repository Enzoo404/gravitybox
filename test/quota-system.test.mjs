import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsManager, normalizedModelFromStored, accountCredentialReadiness, cloudOriginFromCommand } from '../dist/accounts.js';
import { normalizeFraction, normalizeCloudModels, normalizeLiveModels, normalizeCloudGroups, normalizeLiveGroups,
  familyWindowsFromGroups, buildArgonStatus, buildCarbonStatus, buildStandaloneModels, applyFamilyWindows, mergeGroupSets,
  mergeGroupsWithPrevious, mergeModelsWithPrevious, mergeModelCatalogues, familyModelQuotaFromModels } from '../dist/quota.js';
import { projectQuotaContract, buildDashboardAggregate } from '../dist/main.js';

const now = Date.now(), stamp = Math.floor(now / 1000);
const future = new Date(now + 3600000).toISOString();
const groups = (family, window, fraction, observed = stamp, reset = future) => normalizeCloudGroups({groups:[{
  displayName:family, buckets:[{bucketId:`${family}-${window}`, window, remainingFraction:fraction, resetTime:reset}],
}]}, observed);
const status = (models, gs = []) => buildArgonStatus(models, gs, familyWindowsFromGroups(gs, now), now);

test('真实FREE响应：周窗口与模型自身额度独立，刷新、IPC和dashboard均保留模型真值', async t => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/free-model-quota.json', import.meta.url)));
  const clock = Date.parse(fixture.observedAt); t.mock.method(Date, 'now', () => clock);
  const directory = await mkdtemp(join(tmpdir(), 'gb-free-model-')); t.after(() => rm(directory, { recursive:true, force:true }));
  const manager = new AccountsManager(directory); manager.probeLiveLanguageServer = async () => null;
  const account = await manager.upsertAccount({email:'fixture@example.invalid',refreshToken:'synthetic',accessToken:'synthetic',expiresIn:3600});
  const refreshed = await manager.refreshQuota(account.id, async url => Response.json(String(url).includes('loadCodeAssist')
    ? {currentTier:{name:'Antigravity Starter Quota'}} : String(url).includes('fetchAvailableModels') ? fixture.catalogue : fixture.summary));
  const view = manager.getAccountQuotaOverview(refreshed);
  assert.equal(view.geminiFiveHourRemaining,null); assert.equal(view.claudeFiveHourRemaining,null);
  assert.equal(view.familyModelQuota.gemini.remaining,1); assert.equal(view.familyModelQuota.claude.remaining,1);
  assert.equal(Date.parse(view.familyModelQuota.gemini.resetTime)-clock,5*3600000);
  assert.equal(Date.parse(view.familyModelQuota.claude.resetTime)-clock,7*86400000);
  assert.equal(view.geminiWeeklyRemaining,100); assert.equal(view.claudeWeeklyRemaining,100);
  assert.deepEqual(projectQuotaContract(view).familyModelQuota,view.familyModelQuota);
  const dashboard = await buildDashboardAggregate({
    listAccounts:async()=>({accounts:[refreshed],active_account:refreshed,active_account_id:account.id}),
    getAutoSwitchConfig:async()=>({enabled:false}),probeLiveLanguageServer:async()=>null,getAccount:async()=>refreshed,
    getAccountQuotaOverview:a=>manager.getAccountQuotaOverview(a),getUsageSummary:async()=>{throw Error('isolated')},getPricingTable:async()=>({})});
  assert.deepEqual(dashboard.accounts.familyModelQuota,view.familyModelQuota);
  const missing = manager.getAccountQuotaOverview({quota:manager.fuseQuota({models:{}},fixture.summary)});
  assert.equal(missing.familyModelQuota.gemini,null); assert.equal(missing.familyModelQuota.claude,null);
});

test('模型配额投影不借周值，保留真实0%，忽略禁用与旧模型并确定性选择重置时间', () => {
  const models=normalizeCloudModels({models:{'gemini-weekly':{quotaInfo:{remainingFraction:1,resetTime:new Date(now+7*86400000).toISOString()}},
    'gemini-short':{quotaInfo:{remainingFraction:1,resetTime:future}},'gemini-disabled':{disabled:true,quotaInfo:{remainingFraction:0}},
    'claude-only':{quotaInfo:{remainingFraction:0,resetTime:future}}}},stamp);
  let result=familyModelQuotaFromModels(models);
  assert.equal(result.gemini.resetTime,future);assert.equal(result.claude.remaining,0);
  assert.deepEqual(familyModelQuotaFromModels([...models].reverse()),result);
  models[1].own_stale=true;models[1].own_percentage=0;
  result=familyModelQuotaFromModels(models);assert.equal(result.gemini.remaining,1);
  models[0].own_stale=true;result=familyModelQuotaFromModels(models);
  assert.equal(result.gemini.remaining,0);assert.equal(result.gemini.stale,true);
  assert.deepEqual(familyModelQuotaFromModels([]),{gemini:null,claude:null});
});

test('非法 fraction 不是 0% 或 100%；有效的 0 保持耗尽', () => {
  for (const invalid of [null, undefined, NaN, Infinity, -1, 1.01, '1']) assert.equal(normalizeFraction(invalid), null);
  assert.equal(normalizeFraction(0), 0);
  assert.equal(normalizeFraction(.7), .7);
});

test('识别生产目录顶层模型别名与供应商；没有 Argon 记录不等于无权限', () => {
  const models = normalizeCloudModels({models:{chat_123:{displayName:'New model', model:'MODEL_CLAUDE_SONNET', modelProvider:'ANTHROPIC'},
    'gemini-pro-agent':{displayName:'Gemini Pro', model:'MODEL_GEMINI_PRO'}}}, stamp);
  assert.equal(models[0].family, 'claude'); assert.equal(models[0].model_or_alias, 'MODEL_CLAUDE_SONNET');
  assert.equal(status(models).availability, 'unknown'); assert.equal(status(models).remaining, null);
  assert.match(status(models).message, /不代表无权限/);
});

test('Argon disabled 变体不遮蔽 enabled 变体；禁用模型不继承家族的 100%', () => {
  const models = normalizeLiveModels([{modelId:'gemini-4-argon-disabled', label:'Gemini 4 Argon'},
    {modelId:'gemini-4-argon', disabled:false, quotaInfo:{remainingFraction:.4}}], stamp);
  const gs = groups('Argon','weekly',1), windows = familyWindowsFromGroups(gs, now);
  const applied = applyFamilyWindows(models, windows);
  assert.equal(applied[0].disabled, true); assert.equal(applied[0].effective_percentage, null);
  assert.equal(status(applied,gs).availability, 'available'); assert.equal(status(applied,gs).remaining,.4);
  assert.equal(status(applied,gs).period,'unspecified');
  assert.equal(status([applied[0]]).availability,'disabled');
  assert.equal(normalizedModelFromStored({name:'gemini-4-argon-disabled',percentage:100,percentage_known:false}).disabled,true);
});

test('模型自身额度保持未标明周期；普通 Gemini 不提供 Argon 额度', () => {
  const models = normalizeCloudModels({models:{'gemini-4-argon':{quotaInfo:{remainingFraction:.55}},
    'gemini-pro':{quotaInfo:{remainingFraction:.9}}}}, stamp);
  const gs = groups('Gemini','weekly',.2);
  const applied = applyFamilyWindows(models, familyWindowsFromGroups(gs,now));
  assert.equal(applied[0].percentage,55); assert.equal(applied[1].percentage,20);
  assert.equal(status(applied,gs).period,'unspecified'); assert.equal(status(applied,gs).remaining,.55);
});

test('Argon 两周期按限制窗口取值与重置时间；陈旧周值不盖过新鲜 5h', () => {
  const fresh = groups('Argon','5h',.6), old = groups('Argon','weekly',.1,stamp-1000,new Date(now+7*86400000).toISOString());
  const result = status([], [...old,...fresh]);
  assert.equal(result.period,'5h'); assert.equal(result.remaining,.6); assert.equal(result.quotaState,'known');
  assert.match(result.resetCountdown,/分后重置/);
  const freshWeek = groups('Argon','weekly',.1,stamp,new Date(now+7*86400000).toISOString());
  assert.equal(status([], [...freshWeek,...fresh]).period,'weekly');
});

test('每周值不填 5h；超过采样时限或过重置点的窗口标陈旧', () => {
  const gs = groups('Gemini','weekly',.73);
  const windows = familyWindowsFromGroups(gs,now);
  assert.equal(windows.gemini.fiveHour,null); assert.equal(windows.gemini.weekly.remaining,.73);
  assert.equal(familyWindowsFromGroups(groups('Gemini','5h',.9,stamp-901),now).gemini.fiveHour.stale,true);
  assert.equal(familyWindowsFromGroups(groups('Gemini','5h',.9,stamp,new Date(now-1).toISOString()),now).gemini.fiveHour.stale,true);
});

test('多端点只补缺项，生产端点真值优先；保留同一数值的真实重置时间', () => {
  const prod = groups('Gemini','weekly',.7), lower = groups('Gemini','weekly',.2);
  const merged = mergeGroupSets([prod,[...lower,...groups('Gemini','5h',.6)]]);
  const windows = familyWindowsFromGroups(merged,now);
  assert.equal(windows.gemini.weekly.remaining,.7); assert.equal(windows.gemini.fiveHour.remaining,.6);
  const highModels = normalizeCloudModels({models:{'gemini-pro':{disabled:false,quotaInfo:{remainingFraction:.8}}}},stamp);
  const lowModels = normalizeCloudModels({models:{'gemini-pro':{disabled:true,quotaInfo:{remainingFraction:.2}}}},stamp);
  const model = mergeModelCatalogues([highModels,lowModels])[0];
  assert.equal(model.own_percentage,80); assert.equal(model.disabled,false);
});

test('缺失整个家族仍保留真实旧值和采样时间，并标注 carried', () => {
  const old = groups('Claude','weekly',.3,stamp-600);
  const {groups:merged,staleGroups} = mergeGroupsWithPrevious(groups('Gemini','5h',.8),old,now);
  const clause = merged.find(group=>group.family==='claude');
  assert.equal(clause.buckets[0].remaining_fraction,.3); assert.equal(clause.buckets[0].observed_at,stamp-600);
  assert.equal(clause.buckets[0].source,'carried'); assert.equal(staleGroups.length,1);
  assert.equal(familyWindowsFromGroups(merged,now).claude.weekly.stale,true);
});

test('旧 Argon 模型只有陈旧额度时不授予当前可用判断', () => {
  const old = normalizeCloudModels({models:{'gemini-4-argon':{disabled:false,quotaInfo:{remainingFraction:.8}}}},stamp-100);
  const carried = mergeModelsWithPrevious([],old).models;
  const argon = status(carried);
  assert.equal(argon.availability,'unknown'); assert.equal(argon.quotaState,'stale'); assert.equal(argon.remaining,.8);
});

test('推荐排除未知、禁用、陈旧与重置到期数据；新鲜 own 可用于推荐而不虚构窗口', () => {
  const manager = new AccountsManager('/nonexistent-gravitybox-quota-pure-fixture');
  const quota = manager.fuseQuota({models:{'gemini-pro':{quotaInfo:{remainingFraction:.65}}}});
  assert.equal(manager.getAccountRemaining({quota},'gemini'),65);
  assert.equal(manager.getAccountQuotaOverview({quota}).geminiFiveHourRemaining,null);
  const expired = structuredClone(quota); expired.last_updated = stamp-1000;
  expired.models[0].own_observed_at = stamp-1000;
  assert.equal(manager.getAccountRemaining({quota:expired},'gemini'),null);
  assert.equal(manager.getAccountRemaining({disabled:true,quota},'all'),null);
  const invalid = {models:[{name:'gemini-pro',percentage:NaN,percentage_known:true}],last_updated:stamp};
  assert.equal(manager.getAccountRemaining({quota:invalid}),null);
});

test('真实形状：真实生产目录无 Argon，保留权限未知且刷新状态独立', async t => {
  const directory = await mkdtemp(join(tmpdir(),'gb-quota-contract-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const manager = new AccountsManager(directory); manager.probeLiveLanguageServer=async()=>null;
  const account = await manager.upsertAccount({email:'pro@example.test',refreshToken:'synthetic',accessToken:'synthetic',expiresIn:3600});
  const fetcher = async url => Response.json(String(url).includes('loadCodeAssist')?{paidTier:{id:'PRO'},cloudaicompanionProject:'new-project'}:
    String(url).includes('fetchAvailableModels')?{models:{'gemini-pro-agent':{model:'MODEL_GEMINI_PRO',quotaInfo:{remainingFraction:1}}}}:
    {groups:[{displayName:'Gemini Models',buckets:[{bucketId:'gemini-weekly',window:'weekly',remainingFraction:.87}]}]});
  const refreshed=await manager.refreshQuota(account.id,fetcher), overview=manager.getAccountQuotaOverview(refreshed);
  assert.equal(overview.argonStatus.availability,'unknown');assert.equal(overview.argonStatus.remaining,null);
  assert.equal(overview.geminiFiveHourRemaining,null);assert.equal(overview.geminiWeeklyRemaining,87);
  assert.equal(refreshed.token.project_id,'new-project');assert.equal(overview.refreshState.complete,true);
});

test('本机实时部分返回也沿用旧窗口并明确标陈旧，不能借新时间戳刷新旧值', async t => {
  const directory=await mkdtemp(join(tmpdir(),'gb-quota-live-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const manager=new AccountsManager(directory);
  const account=await manager.upsertAccount({email:'live@example.test',refreshToken:'synthetic'});
  account.quota=manager.fuseQuota({models:{'gemini-pro':{quotaInfo:{remainingFraction:.5}}}},
    {groups:[{displayName:'Gemini',buckets:[{bucketId:'gemini-weekly',window:'weekly',remainingFraction:.2}]}]});
  await manager.saveAccount(account);
  const live=manager.fuseQuota({models:{'gemini-pro':{quotaInfo:{remainingFraction:.8}}}},
    {groups:[{displayName:'Gemini',buckets:[{bucketId:'gemini-5h',window:'5h',remainingFraction:.6}]}]});
  manager.probeLiveLanguageServer=async()=>({email:account.email,quota:live});
  const refreshed=await manager.refreshQuota(account.id,async()=>{throw Error('cloud must not run for matched live account')});
  const overview=manager.getAccountQuotaOverview(refreshed);
  assert.equal(overview.familyWindows.gemini.weekly.remaining,.2);
  assert.equal(overview.familyWindows.gemini.weekly.stale,true);
  assert.equal(overview.geminiFiveHourRemaining,60);
  assert.equal(overview.refreshState.complete,false);
  assert.equal(manager.getAccountRemaining(refreshed,'gemini'),60);
});

test('只有目录的生产端点成功而配额来自备用端点时，必须标为部分刷新',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'gb-quota-fallback-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const manager=new AccountsManager(directory);manager.probeLiveLanguageServer=async()=>null;
  const account=await manager.upsertAccount({email:'fallback@example.test',refreshToken:'synthetic',accessToken:'synthetic',expiresIn:3600});
  const fetcher=async url=>String(url).includes('loadCodeAssist')?Response.json({}):String(url).includes('fetchAvailableModels')?
    Response.json({models:{'gemini-pro':{quotaInfo:{remainingFraction:1}}}}):new URL(url).host==='cloudcode-pa.googleapis.com'?
    new Response('',{status:503}):Response.json({groups:[{displayName:'Gemini',buckets:[{bucketId:'gemini-weekly',window:'weekly',remainingFraction:.4}]}]});
  const refreshed=await manager.refreshQuota(account.id,fetcher);
  assert.equal(refreshed.quota.refresh_state.usedFallbackEndpoint,true);
  assert.equal(refreshed.quota.refresh_state.complete,false);
  assert.equal(manager.getAccountQuotaOverview(refreshed).geminiWeeklyRemaining,40);
});

test('Gemini 4 Carbon 与未来新模型自动检测：无模型证据时保持未知，Ultra 与动态新模型自动同步', () => {
  const proArgonDisabled = normalizeLiveModels([{modelId:'gemini-4-argon-disabled', disabled:true}], stamp);
  const windows = familyWindowsFromGroups([], now);
  const argonState = buildArgonStatus(proArgonDisabled, [], windows, now);
  assert.equal(argonState.availability, 'disabled');
  const carbonForPro = buildCarbonStatus(proArgonDisabled, [], windows, now, argonState, 'PRO');
  assert.equal(carbonForPro.availability, 'unknown');
  assert.equal(carbonForPro.remaining, null);

  const ultraModels = normalizeCloudModels({models:{
    'gemini-4-argon':{quotaInfo:{remainingFraction:.75}},
    'gemini-4-carbon':{quotaInfo:{remainingFraction:.9, resetTime:future}},
    'gemini-4-neon':{quotaInfo:{remainingFraction:.64, resetTime:future}},
  }}, stamp);
  const ultraWindows = familyWindowsFromGroups([], now);
  const applied = applyFamilyWindows(ultraModels, ultraWindows);
  const ultraArgon = buildArgonStatus(applied, [], ultraWindows, now);
  const ultraCarbon = buildCarbonStatus(applied, [], ultraWindows, now, ultraArgon, 'ULTRA');
  assert.equal(ultraCarbon.availability, 'available');
  assert.equal(ultraCarbon.remaining, .9);
  const standalones = buildStandaloneModels(applied, [], ultraWindows, now, ultraArgon, ultraCarbon);
  assert.deepEqual(standalones.map(item => item.key), ['argon', 'carbon', 'gemini-4-neon']);
  assert.equal(standalones[2].remaining, .64);
});

test('Gemini 4 Hydrogen 归入基础 Gemini 共享池，不单独列为独立配额行；共享池新模型及多档位变体不裂变重复行', () => {
  const models = normalizeCloudModels({
    models: {
      'gemini-4-hydrogen-low': { displayName: 'Gemini 4 Hydrogen (Low)', quotaInfo: { remainingFraction: 0.22, resetTime: future } },
      'gemini-4-hydrogen-medium': { displayName: 'Gemini 4 Hydrogen (Medium)', quotaInfo: { remainingFraction: 0.22, resetTime: future } },
      'gemini-4-hydrogen-high': { displayName: 'Gemini 4 Hydrogen (High)', quotaInfo: { remainingFraction: 0.22, resetTime: future } },
      'gemini-4-hydrogen-xhigh': { displayName: 'Gemini 4 Hydrogen (XHigh)', quotaInfo: { remainingFraction: 0.22, resetTime: future } },
      'gemini-4-helium-high': { displayName: 'Gemini 4 Helium (High)', quotaInfo: { remainingFraction: 0.22, resetTime: future } },
      'gemini-4-xenon-low': { displayName: 'Gemini 4 Xenon (Low)', quotaInfo: { remainingFraction: 0.85, resetTime: future } },
      'gemini-4-xenon-high': { displayName: 'Gemini 4 Xenon (High)', quotaInfo: { remainingFraction: 0.85, resetTime: future } },
    },
  }, stamp);
  for (const m of models.filter(m => m.model_id.includes('hydrogen'))) {
    assert.equal(m.family, 'gemini');
  }

  // 旧持久化文件中被误标为 other 的 hydrogen 也必须在读取时自愈归入 gemini
  const repaired = normalizedModelFromStored({
    name: 'gemini-4-hydrogen-xhigh',
    display_name: 'Gemini 4 Hydrogen (XHigh)',
    family: 'other',
    percentage: 22,
    percentage_known: true,
    own_percentage: 22,
    own_percentage_known: true,
    reset_time: future,
  });
  assert.equal(repaired.family, 'gemini');

  const groups = normalizeLiveGroups({
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.22, resetTime: future }],
      },
    ],
  }, stamp);
  const windows = familyWindowsFromGroups(groups, now);
  const applied = applyFamilyWindows(models, windows);
  const standalones = buildStandaloneModels(applied, groups, windows, now);
  // hydrogen 归属 gemini；helium 因与 gemini 共享配额窗口也不单独列出；xenon 多档位收敛为一条
  assert.deepEqual(standalones.map(item => item.key), ['argon', 'carbon', 'gemini-4-xenon']);
  assert.equal(standalones[2].displayName, 'Gemini 4 Xenon');
});

async function withQuotaAccountFixture(fn) {
  const d = await mkdtemp(join(tmpdir(), 'gb-quota-regression-'));
  try {
    await fn(d);
  } finally {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
}

test('配额服务403不被误判为登录凭据失效', () => {
  const account = {
    token: { refresh_token: 'synthetic', access_token: 'synthetic-access', expiry_timestamp: Date.now() / 1000 + 3600 },
    quota_refresh_error: 'HTTP 403（官方产品许可校验未通过，错误码 3501）',
  };
  assert.equal(accountCredentialReadiness(account).state, 'ready');
  account.quota_refresh_error = 'HTTP 401';
  assert.equal(accountCredentialReadiness(account).state, 'needs_authorization');
});

test('已拒绝的配额范围不会被外部旧满额复活；凭据同步仍可继续', () => withQuotaAccountFixture(async d => {
  const ext = join(d, 'external');
  await mkdir(join(ext, 'accounts'), { recursive: true });
  const m = new AccountsManager(join(d, 'state'), { externalDir: ext });
  const a = await m.upsertAccount({ email: 'test@example.test', refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', expiresIn: 3600 });
  a.quota = { models: [], quota_groups: [], last_updated: 0, is_forbidden: false, model_forwarding_rules: {}, quota_warnings: ['UNVERIFIED_CLOUD_SCOPE: HTTP 403'], source: 'cloud' };
  await m.saveAccount(a);
  await writeFile(join(ext, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'external', email: a.email }] }));
  await writeFile(join(ext, 'accounts', 'one.json'), JSON.stringify({
    ...a,
    id: 'external',
    quota: { ...a.quota, last_updated: Math.floor(Date.now() / 1000), quota_warnings: [], models: [{ name: 'gemini-test', percentage: 100 }] },
    token: { ...a.token, access_token: 'new-synthetic', expiry_timestamp: Math.floor(Date.now() / 1000) + 7200 },
  }));
  await m.syncFromExternalAgySwitch();
  const saved = await m.getAccount(a.id);
  assert.deepEqual(saved.quota.models, []);
  assert.equal(saved.quota.source, 'cloud');
  assert.equal(saved.token.access_token, 'new-synthetic');
}));

test('官方3501许可拒绝解释准确且不传播服务端其他内容', () => withQuotaAccountFixture(async d => {
  const m = new AccountsManager(d, { providerContext: { origin: 'https://daily-cloudcode-pa.googleapis.com', userAgent: 'antigravity/2.25.0', appVersion: '2.25.0' } });
  m.probeLiveLanguageServer = async () => null;
  const a = await m.upsertAccount({ email: 'denied@example.test', refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', expiresIn: 3600 });
  await assert.rejects(
    m.refreshQuota(a.id, async url => url.includes('retrieveUserQuotaSummary')
      ? Response.json({ error: { status: 'PERMISSION_DENIED', message: 'license invalid (#3501) private-service-detail' } }, { status: 403 })
      : Response.json({})),
    /官方产品许可校验未通过/
  );
  const saved = await m.getAccount(a.id);
  assert.match(saved.quota_refresh_error, /3501/);
  assert.ok(!saved.quota_refresh_error.includes('private-service-detail'));
}));

test('备用账号按真实桌面服务和版本查询账号额度，不附加项目、不混入另一环境的满额', () => withQuotaAccountFixture(async d => {
  const origin = 'https://daily-cloudcode-pa.googleapis.com';
  const context = { origin, userAgent: 'antigravity/2.25.0', appVersion: '2.25.0' };
  const makeGroup = (family, remaining, window) => ({
    displayName: family,
    buckets: [{ bucketId: family + '-' + window, window, remainingFraction: remaining, resetTime: new Date(Date.now() + 3600000).toISOString() }],
  });
  const m = new AccountsManager(d, { providerContext: context });
  m.probeLiveLanguageServer = async () => null;
  const a = await m.upsertAccount({ email: 'standby@example.test', refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', expiresIn: 3600 });
  a.token.project_id = 'legacy-wrong-project';
  await m.saveAccount(a);
  const calls = [];
  const fetched = await m.refreshQuota(a.id, async (url, options) => {
    calls.push(url);
    assert.equal(new URL(url).origin, origin);
    assert.equal(options.headers['User-Agent'], 'antigravity/2.25.0');
    if (!url.includes('loadCodeAssist')) assert.deepEqual(JSON.parse(options.body), {});
    const json = url.includes('loadCodeAssist')
      ? { paidTier: { name: 'PRO' } }
      : url.includes('fetchAvailableModels')
        ? { models: { 'gemini-3.8-flash': { quotaInfo: { remainingFraction: 0.99 } } } }
        : { groups: [makeGroup('Gemini Models', 0.36, 'weekly'), makeGroup('Gemini Models', 0.99, '5h')] };
    return { ok: true, status: 200, json: async () => json };
  });
  assert.equal(calls.length, 4);
  assert.equal(m.getAccountQuotaOverview(fetched).geminiWeeklyRemaining, 36);
  assert.equal(fetched.quota.refresh_state.providerOrigin, origin);
  assert.equal(fetched.quota.refresh_state.requestScope, 'account');
}));

test('正确服务拒绝额度时不回退到另一个环境的100%，旧错误云端数值留恢复记录', () => withQuotaAccountFixture(async d => {
  const origin = 'https://daily-cloudcode-pa.googleapis.com';
  const context = { origin, userAgent: 'antigravity/2.25.0', appVersion: '2.25.0' };
  const m = new AccountsManager(d, { providerContext: context });
  m.probeLiveLanguageServer = async () => null;
  const a = await m.upsertAccount({ email: 'denied@example.test', refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', expiresIn: 3600 });
  a.quota = { models: [{ name: 'gemini-3.8-flash', percentage: 100, percentage_known: true }], quota_groups: [], last_updated: Date.now() / 1000, is_forbidden: false, model_forwarding_rules: {}, source: 'cloud' };
  await m.saveAccount(a);
  await assert.rejects(
    m.refreshQuota(a.id, async url => {
      assert.equal(new URL(url).origin, origin);
      if (url.includes('retrieveUserQuotaSummary')) return { ok: false, status: 403 };
      return { ok: true, status: 200, json: async () => url.includes('fetchAvailableModels') ? { models: { 'gemini-3.8-flash': { quotaInfo: { remainingFraction: 1 } } } } : { paidTier: { name: 'FREE' } } };
    }),
    /HTTP 403/
  );
  const saved = await m.getAccount(a.id);
  assert.deepEqual(saved.quota.models, []);
  assert.equal(m.getAccountQuotaOverview(saved).geminiWeeklyRemaining, null);
  assert.match(saved.quota_refresh_error, /HTTP 403/);
  const paths = await readdir(join(d, 'quota-rejected'));
  assert.equal(paths.length, 1);
  const archive = await readFile(join(d, 'quota-rejected', paths[0]), 'utf8');
  assert.ok(!archive.includes('synthetic-refresh'));
}));

test('仅采纳官方进程的固定Google服务端点', () => {
  const origin = 'https://daily-cloudcode-pa.googleapis.com';
  assert.equal(cloudOriginFromCommand('/Applications/Antigravity.app/Contents/Resources/bin/language_server --cloud_code_endpoint ' + origin), origin);
  assert.equal(cloudOriginFromCommand('/tmp/fake --cloud_code_endpoint ' + origin), null);
  assert.equal(cloudOriginFromCommand('/Applications/Antigravity.app/Contents/Resources/bin/language_server --cloud_code_endpoint https://attacker.invalid'), null);
});
