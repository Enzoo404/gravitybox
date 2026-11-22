import test from 'node:test';
import { execSqlite } from './sqlite-helper.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  AccountsManager,
  MockKeychainAdapter,
  accountCredentialReadiness,
  accountErrorCode,
  cleanAndLocalizeRefreshError,
  localizeStoredQuotaError,
} from '../dist/accounts.js';
import { replaceTopicRow } from '../dist/account-state.js';
import { bt, getActiveLocale, setActiveLocale } from '../dist/i18n.js';
import { ProtobufWriter as Writer } from '../dist/protobuf.js';

const execFileAsync = promisify(execFile);

function buildKeychainSecret(tokenObj, idTokenEmail) {
  const payload = JSON.stringify({
    token: tokenObj,
    ...(idTokenEmail ? { id_token_email: idTokenEmail } : {}),
  });
  return `go-keyring-base64:${Buffer.from(payload, 'utf8').toString('base64')}`;
}

async function createStateVscdb(vscdbPath, {
  accessToken,
  refreshToken,
  expirySec,
  idToken,
  isGcpTos = false,
  email,
  enterpriseProjectId,
}) {
  await mkdir(join(vscdbPath, '..'), { recursive: true });
  const rows = [];
  if (refreshToken !== undefined) {
    const oauthPayload = Buffer.concat([
      Writer.encodeString(1, accessToken ?? ''),
      Writer.encodeString(2, 'Bearer'),
      Writer.encodeString(3, refreshToken),
      ...(expirySec !== undefined
        ? [Writer.encodeLengthDelimited(4, Buffer.concat([Writer.encodeVarintField(1, expirySec), Writer.encodeVarintField(2, 0)]))]
        : []),
      ...(idToken ? [Writer.encodeString(5, idToken)] : []),
      Writer.encodeVarintField(6, isGcpTos ? 1 : 0),
    ]);
    rows.push([
      'antigravityUnifiedStateSync.oauthToken',
      replaceTopicRow(undefined, 'oauthTokenInfoSentinelKey', oauthPayload),
    ]);
  }
  if (email) {
    const userPayload = Writer.encodeString(7, email);
    rows.push([
      'antigravityUnifiedStateSync.userStatus',
      replaceTopicRow(undefined, 'userStatusSentinelKey', userPayload),
    ]);
  }
  if (enterpriseProjectId) {
    const entPayload = Writer.encodeString(3, enterpriseProjectId);
    rows.push([
      'antigravityUnifiedStateSync.enterprisePreferences',
      replaceTopicRow(undefined, 'enterpriseGcpProjectId', entPayload),
    ]);
  }
  const sql = [
    'CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT);',
    ...rows.map(([k, v]) => `INSERT INTO ItemTable(key, value) VALUES('${k.replaceAll("'", "''")}', '${v.replaceAll("'", "''")}');`),
  ].join('\n');
  execSqlite(vscdbPath, sql);
}

function makeLiveStatus(email, pct = 82) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    email,
    name: 'Live Test User',
    tier: 'PRO',
    accountType: 'consumer',
    userTierId: 'g1-pro-tier',
    userTierName: 'Google AI Pro',
    quota: {
      models: [{ name: 'gemini-3.8-flash', percentage: pct, percentage_known: true, reset_time: '' }],
      quota_groups: [{
        display_name: 'Gemini',
        buckets: [{ bucket_id: 'gemini-5h', window: '5h', remaining_fraction: pct / 100, remaining_fraction_known: true, reset_time: '' }],
      }],
      last_updated: nowSec,
      is_forbidden: false,
      subscription_tier: 'PRO',
      model_forwarding_rules: {},
      source: 'live',
    },
  };
}

test('saveCurrentAccount: Keychain 过期凭据与 state.vscdb 较新凭据合并，并保留缺失元信息', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gb-save-merge-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const nowSec = Math.floor(Date.now() / 1000);
  const stateDir = join(root, 'state');
  const appSupportDir = join(root, 'AppSupport');
  const vscdbPath = join(appSupportDir, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');

  const keychain = new MockKeychainAdapter();
  await keychain.writePassword(
    'gemini',
    'antigravity',
    buildKeychainSecret({
      access_token: 'expired-keychain-access',
      refresh_token: '1//shared-refresh-token',
      expires_in: 0,
      expiry_timestamp: nowSec - 1800,
      email: 'merge-user@example.invalid',
      project_id: 'proj-from-keychain',
      is_gcp_tos: true,
    })
  );

  await createStateVscdb(vscdbPath, {
    accessToken: 'fresh-vscdb-access-token',
    refreshToken: '1//shared-refresh-token',
    expirySec: nowSec + 3400,
    idToken: 'eyJ.vscdb.id.token',
    isGcpTos: false,
    email: 'merge-user@example.invalid',
  });

  const mgr = new AccountsManager(stateDir);
  const saved = await mgr.saveCurrentAccount({
    keychain,
    homeDir: root,
    appSupportDir,
  });

  assert.equal(saved.email, 'merge-user@example.invalid');
  assert.equal(saved.token.access_token, 'fresh-vscdb-access-token');
  assert.equal(saved.token.refresh_token, '1//shared-refresh-token');
  assert.equal(saved.token.expiry_timestamp, nowSec + 3400);
  assert.equal(saved.token.project_id, 'proj-from-keychain', '应从落选候选保留缺失的 project_id');
  assert.equal(saved.token.id_token, 'eyJ.vscdb.id.token');
  assert.equal(saved.token.is_gcp_tos, true, '应保留 is_gcp_tos=true');

  // 反向：Keychain 较新而 state.vscdb 已过期时保留 Keychain 的有效 token，并从 state.vscdb 补全 enterpriseProjectId
  const rootReverse = await mkdtemp(join(tmpdir(), 'gb-save-reverse-'));
  t.after(() => rm(rootReverse, { recursive: true, force: true }));
  const revAppSupport = join(rootReverse, 'AppSupport');
  const revVscdb = join(revAppSupport, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
  const revKeychain = new MockKeychainAdapter();
  await revKeychain.writePassword(
    'gemini',
    'antigravity',
    buildKeychainSecret({
      access_token: 'fresh-keychain-access',
      refresh_token: '1//reverse-refresh',
      expiry_timestamp: nowSec + 3200,
      email: 'reverse-user@example.invalid',
    })
  );
  await createStateVscdb(revVscdb, {
    accessToken: 'stale-vscdb-access',
    refreshToken: '1//reverse-refresh',
    expirySec: nowSec - 900,
    idToken: 'eyJ.reverse.id',
    email: 'reverse-user@example.invalid',
    enterpriseProjectId: 'ent-project-from-vscdb',
  });

  const mgrReverse = new AccountsManager(join(rootReverse, 'state'));
  const savedRev = await mgrReverse.saveCurrentAccount({
    keychain: revKeychain,
    homeDir: rootReverse,
    appSupportDir: revAppSupport,
  });
  assert.equal(savedRev.token.access_token, 'fresh-keychain-access');
  assert.equal(savedRev.token.expiry_timestamp, nowSec + 3200);
  assert.equal(savedRev.token.project_id, 'ent-project-from-vscdb');
  assert.equal(savedRev.token.id_token, 'eyJ.reverse.id');

  // 邮箱与 refresh_token 均不匹配时，严禁将 state.vscdb 的异主凭据串号合并到 Keychain 账号
  const rootMismatch = await mkdtemp(join(tmpdir(), 'gb-save-mismatch-'));
  t.after(() => rm(rootMismatch, { recursive: true, force: true }));
  const mismatchAppSupport = join(rootMismatch, 'AppSupport');
  const mismatchVscdb = join(mismatchAppSupport, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
  const mismatchKeychain = new MockKeychainAdapter();
  await mismatchKeychain.writePassword(
    'gemini',
    'antigravity',
    buildKeychainSecret({
      access_token: 'keychain-owner-a',
      refresh_token: '1//owner-a-rt',
      expiry_timestamp: nowSec - 300,
      email: 'owner-a@example.invalid',
    })
  );
  await createStateVscdb(mismatchVscdb, {
    accessToken: 'vscdb-owner-b',
    refreshToken: '1//owner-b-rt',
    expirySec: nowSec + 3600,
    email: 'owner-b@example.invalid',
  });
  const mgrMismatch = new AccountsManager(join(rootMismatch, 'state'));
  const savedMismatch = await mgrMismatch.saveCurrentAccount({
    keychain: mismatchKeychain,
    homeDir: rootMismatch,
    appSupportDir: mismatchAppSupport,
  });
  assert.equal(savedMismatch.email, 'owner-a@example.invalid');
  assert.equal(savedMismatch.token.refresh_token, '1//owner-a-rt');
  assert.equal(savedMismatch.token.access_token, 'keychain-owner-a');
});

test('upsertAccount: 同 refresh_token 下保留更鲜活的有效 access_token，且不误清 missing_oauth_client 错误', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gb-upsert-fresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const prevCid = process.env.GRAVITYBOX_GOOGLE_CLIENT_ID;
  const prevSec = process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET;
  delete process.env.GRAVITYBOX_GOOGLE_CLIENT_ID;
  delete process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET;
  t.after(() => {
    if (prevCid === undefined) delete process.env.GRAVITYBOX_GOOGLE_CLIENT_ID;
    else process.env.GRAVITYBOX_GOOGLE_CLIENT_ID = prevCid;
    if (prevSec === undefined) delete process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET;
    else process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET = prevSec;
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const mgr = new AccountsManager(root);

  // 1. 已有账号持有更鲜活的 access_token，传入同 refresh_token 的已过期旧 token 不得回退覆盖
  const existing = await mgr.upsertAccount({
    email: 'fresh-keep@example.invalid',
    refreshToken: '1//same-rt',
    accessToken: 'valid-fresher-access',
    expiryTimestamp: nowSec + 3500,
    expiresIn: 3500,
  });

  const afterOlderUpsert = await mgr.upsertAccount({
    email: 'fresh-keep@example.invalid',
    refreshToken: '1//same-rt',
    accessToken: 'older-expired-access',
    expiryTimestamp: nowSec - 600,
    expiresIn: 0,
  });

  assert.equal(afterOlderUpsert.id, existing.id);
  assert.equal(afterOlderUpsert.token.access_token, 'valid-fresher-access');
  assert.equal(afterOlderUpsert.token.expiry_timestamp, nowSec + 3500);
  assert.equal(afterOlderUpsert.token.expires_in, 3500);

  // 2. 已有账号存在 missing_oauth_client 错误且 token 已过期：再次传入同 refresh_token + 过期 token 时，不得虚假清空错误变成“待刷新”循环
  const stuck = await mgr.upsertAccount({
    email: 'stuck@example.invalid',
    refreshToken: '1//stuck-rt',
    accessToken: 'expired-access-1',
    expiryTimestamp: nowSec - 1200,
    expiresIn: 0,
  });
  stuck.quota_refresh_error = bt('account_cloud.err.missing_oauth_client_active_live');
  stuck.quota_refresh_error_code = 'missing_oauth_client';
  await mgr.saveAccount(stuck);

  const afterResaveExpired = await mgr.upsertAccount({
    email: 'stuck@example.invalid',
    refreshToken: '1//stuck-rt',
    accessToken: 'expired-access-2',
    expiryTimestamp: nowSec - 300,
    expiresIn: 0,
  });
  assert.equal(afterResaveExpired.quota_refresh_error_code, 'missing_oauth_client');
  assert.equal(afterResaveExpired.quota_refresh_error, bt('account_cloud.err.missing_oauth_client_active_live'));

  // 3. 当获得真正可用（未过期 > now+300）的新 access_token 时，正常清除 missing_oauth_client 错误
  const afterGainedValid = await mgr.upsertAccount({
    email: 'stuck@example.invalid',
    refreshToken: '1//stuck-rt',
    accessToken: 'newly-valid-access',
    expiryTimestamp: nowSec + 1800,
    expiresIn: 1800,
  });
  assert.equal(afterGainedValid.quota_refresh_error, null);
  assert.equal(afterGainedValid.quota_refresh_error_code, null);

  // 4. saveCurrentAccount 在 Keychain 与 state.vscdb 均为同一已过期 token 时保留错误不假清除；在 state.vscdb 具备新鲜 token 时清除错误
  const loopRoot = await mkdtemp(join(tmpdir(), 'gb-save-noloop-'));
  t.after(() => rm(loopRoot, { recursive: true, force: true }));
  const loopAppSupport = join(loopRoot, 'AppSupport');
  const loopVscdb = join(loopAppSupport, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
  const loopKeychain = new MockKeychainAdapter();
  await loopKeychain.writePassword(
    'gemini',
    'antigravity',
    buildKeychainSecret({
      access_token: 'loop-expired-access',
      refresh_token: '1//loop-rt',
      expiry_timestamp: nowSec - 900,
      email: 'loop@example.invalid',
    })
  );
  await createStateVscdb(loopVscdb, {
    accessToken: 'loop-expired-access-2',
    refreshToken: '1//loop-rt',
    expirySec: nowSec - 600,
    email: 'loop@example.invalid',
  });
  const loopMgr = new AccountsManager(join(loopRoot, 'state'));
  const seededLoop = await loopMgr.upsertAccount({
    email: 'loop@example.invalid',
    refreshToken: '1//loop-rt',
    accessToken: 'loop-expired-access',
    expiryTimestamp: nowSec - 900,
    expiresIn: 0,
  });
  seededLoop.quota_refresh_error = bt('account_cloud.err.missing_oauth_client_active_live');
  seededLoop.quota_refresh_error_code = 'missing_oauth_client';
  await loopMgr.saveAccount(seededLoop);

  const resavedExpired = await loopMgr.saveCurrentAccount({
    keychain: loopKeychain,
    homeDir: loopRoot,
    appSupportDir: loopAppSupport,
  });
  assert.equal(resavedExpired.quota_refresh_error_code, 'missing_oauth_client');
  assert.equal(resavedExpired.quota_refresh_error, bt('account_cloud.err.missing_oauth_client_active_live'));

  await rm(loopVscdb, { force: true });
  await createStateVscdb(loopVscdb, {
    accessToken: 'loop-fresh-access',
    refreshToken: '1//loop-rt',
    expirySec: nowSec + 2400,
    email: 'loop@example.invalid',
  });
  const resavedFresh = await loopMgr.saveCurrentAccount({
    keychain: loopKeychain,
    homeDir: loopRoot,
    appSupportDir: loopAppSupport,
  });
  assert.equal(resavedFresh.token.access_token, 'loop-fresh-access');
  assert.equal(resavedFresh.quota_refresh_error, null);
  assert.equal(resavedFresh.quota_refresh_error_code, null);
});

test('probeLiveLanguageServer: 不缓存 null 结果（5 秒窗口内可立即重探并命中有效结果）', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gb-probe-nocache-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const prevProbeEnv = process.env.GRAVITYBOX_PROBE_LS;
  delete process.env.GRAVITYBOX_PROBE_LS;
  t.after(() => {
    if (prevProbeEnv === undefined) delete process.env.GRAVITYBOX_PROBE_LS;
    else process.env.GRAVITYBOX_PROBE_LS = prevProbeEnv;
  });

  let callCount = 0;
  const statusFixture = makeLiveStatus('live-probe@example.invalid', 91);
  const mgr = new AccountsManager(root, {
    probeLiveOnce: async () => {
      callCount++;
      if (callCount === 1) return null;
      if (callCount === 2) return statusFixture;
      return null;
    },
  });

  const first = await mgr.probeLiveLanguageServer();
  assert.equal(first, null);
  assert.equal(callCount, 1);

  // 立即再次调用（不传 forceRefresh）：因为 null 未被缓存，必须重新触发探测并成功返回
  const second = await mgr.probeLiveLanguageServer();
  assert.equal(second?.email, 'live-probe@example.invalid');
  assert.equal(callCount, 2);

  // 非空结果应正常缓存 5 秒
  const third = await mgr.probeLiveLanguageServer();
  assert.equal(third?.email, 'live-probe@example.invalid');
  assert.equal(callCount, 2, '非空结果在 5 秒窗口内应命中缓存');

  // forceRefresh 返回 null 时应清掉旧缓存，避免陈旧在线态残留
  const fourth = await mgr.probeLiveLanguageServer(globalThis.fetch, { forceRefresh: true });
  assert.equal(fourth, null);
  assert.equal(callCount, 3);
  const fifth = await mgr.probeLiveLanguageServer();
  assert.equal(fifth, null);
  assert.equal(callCount, 4);
});

test('refreshQuota: 当前桌面账号缺失 OAuth client 且 LS 不可用时抛出 missing_oauth_client_active_live 并保留 needs_refresh 就绪度', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gb-active-live-err-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const prevCid = process.env.GRAVITYBOX_GOOGLE_CLIENT_ID;
  const prevSec = process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET;
  const prevLocale = getActiveLocale();
  delete process.env.GRAVITYBOX_GOOGLE_CLIENT_ID;
  delete process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET;
  t.after(() => {
    setActiveLocale(prevLocale);
    if (prevCid === undefined) delete process.env.GRAVITYBOX_GOOGLE_CLIENT_ID;
    else process.env.GRAVITYBOX_GOOGLE_CLIENT_ID = prevCid;
    if (prevSec === undefined) delete process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET;
    else process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET = prevSec;
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const providerContext = {
    origin: 'https://cloudcode-pa.googleapis.com',
    userAgent: 'antigravity/2.34.0',
    appVersion: '2.34.0',
  };
  const mgr = new AccountsManager(root, { providerContext });
  mgr.probeLiveLanguageServer = async () => null;
  mgr.detectCurrentAntigravityEmail = async () => 'Active.Desktop@Example.Invalid';

  const activeAcc = await mgr.upsertAccount({
    email: 'active.desktop@example.invalid',
    refreshToken: '1//active-rt',
    accessToken: 'expired-active-access',
    expiryTimestamp: nowSec - 600,
    expiresIn: 0,
  });
  const standbyAcc = await mgr.upsertAccount({
    email: 'standby@example.invalid',
    refreshToken: '1//standby-rt',
    accessToken: 'expired-standby-access',
    expiryTimestamp: nowSec - 600,
    expiresIn: 0,
  });

  setActiveLocale('zh-Hans');
  await assert.rejects(
    mgr.refreshQuota(activeAcc.id),
    err =>
      accountErrorCode(err) === 'missing_oauth_client' &&
      err.message === bt('account_cloud.err.missing_oauth_client_active_live')
  );

  // 备用账号（与桌面账号邮箱不匹配）仍提示切换/重保存路径
  await assert.rejects(
    mgr.refreshQuota(standbyAcc.id),
    err =>
      accountErrorCode(err) === 'missing_oauth_client' &&
      err.message === bt('account_cloud.err.missing_oauth_client')
  );

  const savedActive = await mgr.getAccount(activeAcc.id);
  assert.equal(savedActive.quota_refresh_error_code, 'missing_oauth_client');
  assert.equal(savedActive.quota_refresh_error, bt('account_cloud.err.missing_oauth_client_active_live'));

  // 验证中英文切换与就绪度分类（必须保持 needs_refresh，不得被“已过期/expired”正则误判为 needs_authorization）
  const zhText = bt('account_cloud.err.missing_oauth_client_active_live');
  setActiveLocale('en');
  const enText = bt('account_cloud.err.missing_oauth_client_active_live');
  assert.notEqual(zhText, enText);

  for (const locale of ['zh-Hans', 'en']) {
    setActiveLocale(locale);
    const expected = bt('account_cloud.err.missing_oauth_client_active_live');
    for (const rawVariant of [zhText, enText]) {
      assert.equal(localizeStoredQuotaError(rawVariant), expected);
      assert.equal(cleanAndLocalizeRefreshError(rawVariant), expected);
      assert.equal(
        accountCredentialReadiness({
          ...savedActive,
          quota_refresh_error: rawVariant,
          quota_refresh_error_code: undefined,
        }, nowSec).state,
        'needs_refresh'
      );
    }
  }
});
