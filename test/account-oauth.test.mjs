import test from 'node:test';import assert from 'node:assert/strict';
import {request} from 'node:http';
import {createHash} from 'node:crypto';
process.env.GRAVITYBOX_GOOGLE_CLIENT_ID = process.env.GRAVITYBOX_GOOGLE_CLIENT_ID || 'mock-id.apps.googleusercontent.com';
process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET = process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET || 'mock-client-secret-placeholder';
const {GoogleAccountLogin} = await import('../dist/account-oauth.js');
const turn=()=>new Promise(r=>setTimeout(r,10));
async function settled(login,id){for(let i=0;i<100;i++){const s=login.status(id);if(!['waiting','exchanging','saving'].includes(s.phase))return s;await turn()}throw Error('Login did not settle')}
function callback(url,state,code='fixture-code'){const u=new URL(new URL(url).searchParams.get('redirect_uri'));u.search=new URLSearchParams({state,code});return u}
test('Google account login uses loopback, state and S256 PKCE; tokens stay behind IPC status',async t=>{
 let writes=0,exchange;const login=new GoogleAccountLogin(async token=>{assert.equal(token.refresh_token,'fixture-refresh');writes++},async(url,init)=>{assert.equal(url,'https://oauth2.googleapis.com/token');exchange=new URLSearchParams(init.body);return Response.json({access_token:'fixture-access',refresh_token:'fixture-refresh'})});t.after(()=>login.close());
 const {id,url}=await login.begin();const auth=new URL(url);assert.equal(auth.host,'accounts.google.com');assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.equal(new URL(auth.searchParams.get('redirect_uri')).hostname,'127.0.0.1');
 const state=auth.searchParams.get('state');assert.ok(state.length>=43);
 assert.equal((await fetch(callback(url,'wrong-state'))).status,400);assert.equal(login.status(id).phase,'waiting');
 const spoof=await new Promise((resolve,reject)=>{const req=request(callback(url,state),{headers:{Host:'attacker.invalid'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.end()});assert.equal(spoof,404);
 const response=await fetch(callback(url,state));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(response.headers.get('content-security-policy').includes("default-src 'none'"));
 assert.equal((await settled(login,id)).phase,'succeeded');assert.equal(writes,1);assert.equal(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'),auth.searchParams.get('code_challenge'));assert.equal(exchange.get('redirect_uri'),auth.searchParams.get('redirect_uri'));
 assert.ok(!JSON.stringify(login.status(id)).includes('fixture-access'));assert.ok(!JSON.stringify(login.status(id)).includes('fixture-refresh'));
 await assert.rejects(fetch(callback(url,state)));assert.equal(writes,1);
});
test('OAuth cancel, expiration and denied consent do not save accounts',async t=>{
 let saves=0;const login=new GoogleAccountLogin(async()=>{saves++},async()=>{throw Error('must not request token')},80);t.after(()=>login.close());
 const a=await login.begin();assert.equal(login.cancel(a.id).phase,'cancelled');await assert.rejects(fetch(callback(a.url,new URL(a.url).searchParams.get('state'))));
 const b=await login.begin();await new Promise(r=>setTimeout(r,100));assert.equal(login.status(b.id).phase,'expired');
 const c=await login.begin();const denied=callback(c.url,new URL(c.url).searchParams.get('state'));denied.searchParams.set('error','access_denied');await fetch(denied);assert.equal(login.status(c.id).phase,'cancelled');assert.equal(saves,0);
});
test('OAuth cancelled during exchange aborts network and prevents saving',async t=>{
 let saves=0;const login=new GoogleAccountLogin(async()=>{saves++},async(_u,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true})));t.after(()=>login.close());
 const a=await login.begin();await fetch(callback(a.url,new URL(a.url).searchParams.get('state')));assert.equal(login.status(a.id).phase,'exchanging');login.cancel(a.id);await turn();assert.equal(login.status(a.id).phase,'cancelled');assert.equal(saves,0);
});
test('OAuth malformed token and Google errors are sanitized, never stored',async t=>{
 for(const reply of [()=>Response.json({access_token:'only-access'}),()=>new Response('sensitive-token-error',{status:400})]){
 let saves=0;const login=new GoogleAccountLogin(async()=>{saves++},async()=>reply());t.after(()=>login.close());const a=await login.begin();await fetch(callback(a.url,new URL(a.url).searchParams.get('state')));const result=await settled(login,a.id);assert.equal(result.phase,'failed');assert.equal(saves,0);assert.ok(!JSON.stringify(result).includes('sensitive-token-error'));
 }
});

test('OAuth client ID and secret are non-empty and support environment override', async () => {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, getGoogleClientId, getGoogleClientSecret } = await import('../dist/accounts.js');
  assert.ok(typeof GOOGLE_CLIENT_ID === 'string' && GOOGLE_CLIENT_ID.length > 10);
  assert.ok(typeof GOOGLE_CLIENT_SECRET === 'string' && GOOGLE_CLIENT_SECRET.length > 10);
  assert.ok(GOOGLE_CLIENT_ID.includes('.apps.googleusercontent.com'));
  assert.equal(getGoogleClientId(), GOOGLE_CLIENT_ID);
  assert.equal(getGoogleClientSecret(), GOOGLE_CLIENT_SECRET);
});
