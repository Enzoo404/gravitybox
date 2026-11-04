import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{AccountsManager,cloudProviderContextFromCommand,validCachedCloudProviderContext}from'../dist/accounts.js';
const origin='https://daily-cloudcode-pa.googleapis.com',version='2.25.0',exe='/Applications/Antigravity.app/Contents/Resources/bin/language_server';
test('官方 hub 客户端身份随进程参数提取，支持空格及等号，版本不跨安装源',()=>{
 const space=cloudProviderContextFromCommand(`${exe} --cloud_code_endpoint ${origin} --subclient_type hub --override_ide_version ${version}`,version);
 const equal=cloudProviderContextFromCommand(`${exe} --cloud_code_endpoint=${origin} --subclient_type=hub --override_user_agent_name=antigravity`,version);
 assert.deepEqual(space,equal);assert.equal(space.userAgent,'antigravity/hub/2.25.0');assert.equal(space.identityVersion,2);
 assert.equal(cloudProviderContextFromCommand(`${exe} --cloud_code_endpoint ${origin}`,version).userAgent,'antigravity/2.25.0');
 for(const command of[`${exe} --cloud_code_endpoint ${origin} --subclient_type hub/other`,`${exe} --cloud_code_endpoint ${origin} --override_ide_version 2.24.0`,`${exe} --cloud_code_endpoint ${origin} --override_user_agent_name other`,`${exe.replace('/Applications','/tmp')} --cloud_code_endpoint ${origin}`])assert.equal(cloudProviderContextFromCommand(command,version),null);
});
test('旧版缺少客户端类型的配额源缓存失效，合法新版缓存才可离线沿用',()=>{
 const ctx=cloudProviderContextFromCommand(`${exe} --cloud_code_endpoint ${origin} --subclient_type hub`,version);
 assert.equal(validCachedCloudProviderContext(ctx,version),true);
 for(const candidate of[{origin,userAgent:'antigravity/'+version,appVersion:version},{...ctx,userAgent:'antigravity/'+version},{...ctx,clientSubType:'hub --other value'},{...ctx,origin:origin+' --subclient_type hub'},{...ctx,origin:'https://attacker.invalid'},{...ctx,appVersion:'2.24.0'}])assert.equal(validCachedCloudProviderContext(candidate,version),false);
});
test('备用账号按官方 hub 请求取得 Argon 独立周桶，不借 Gemini 额度或旧客户端快照',async t=>{
 const d=await mkdtemp(join(tmpdir(),'gb-argon-'));t.after(()=>rm(d,{recursive:true,force:true}));const ctx=cloudProviderContextFromCommand(`${exe} --cloud_code_endpoint ${origin} --subclient_type hub`,version),manager=new AccountsManager(d,{providerContext:ctx});manager.probeLiveLanguageServer=async()=>null;
 const a=await manager.upsertAccount({email:'synthetic@example.invalid',accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresIn:3600});
 a.quota={models:[],quota_groups:[{display_name:'Gemini 4 Argon',buckets:[{bucket_id:'old-argon-week',window:'weekly',remaining_fraction:1,remaining_fraction_known:true}]}],last_updated:Math.floor(Date.now()/1000),refresh_state:{providerOrigin:origin,providerUserAgent:'antigravity/'+version,requestScope:'account'}};await manager.saveAccount(a);
 const calls=[];const transport=async(url,o)=>{calls.push(url);assert.equal(o.headers['User-Agent'],'antigravity/hub/2.25.0');assert.equal(new URL(url).origin,origin);if(url.endsWith(':loadCodeAssist'))return Response.json({paidTier:{id:'g1-pro-tier'}});assert.deepEqual(JSON.parse(o.body),{});if(url.endsWith(':fetchAvailableModels'))return Response.json({models:{'gemini-4-argon-high':{displayName:'Gemini 4 Argon (High)',quotaInfo:{remainingFraction:.00803,resetTime:'2030-10-24T15:07:45Z'}},'gemini-3.8-flash':{quotaInfo:{remainingFraction:1}}}});return Response.json({groups:[{displayName:'Gemini Models',buckets:[{bucketId:'gemini-weekly',window:'weekly',remainingFraction:.36}]},{displayName:'Gemini 4 Argon',buckets:[{bucketId:'gemini-argon-wtu-weekly',window:'weekly',remainingFraction:.00803,resetTime:'2030-10-24T15:07:45Z'}]}]})};
 const fresh=await manager.refreshQuota(a.id,transport),overview=manager.getAccountQuotaOverview(fresh);assert.equal(overview.argonStatus.availability,'available');assert.equal(overview.argonStatus.period,'weekly');assert.equal(overview.argonStatus.remaining,.00803);assert.equal(overview.geminiWeeklyRemaining,36);assert.equal(overview.argonWeeklyRemaining,1);assert.equal(fresh.quota.refresh_state.carriedGroups,0);assert.equal(fresh.quota.refresh_state.providerUserAgent,ctx.userAgent);assert.ok(!calls.some(url=>url.endsWith(':retrieveUserQuota')));
});
