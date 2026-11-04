import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsManager, normalizedModelFromStored } from '../dist/accounts.js';
import { normalizeFraction, normalizeCloudModels, normalizeLiveModels, normalizeCloudGroups,
  familyWindowsFromGroups, buildArgonStatus, applyFamilyWindows, mergeGroupSets,
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
