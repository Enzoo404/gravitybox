import test from 'node:test';
import { execSqlite } from './sqlite-helper.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MISSING_OAUTH_CLIENT_PATTERN,
  computeAccountRemaining,
  computeStandbyRefreshStatus,
  evaluateStandbyCandidate,
  projectAccountForIpc,
} from '../dist/account-quota.js';
import { projectAccountForIpcNormalized } from '../dist/ipc-projections.js';
import { AccountsManager, MockKeychainAdapter, accountErrorCode } from '../dist/accounts.js';
import { AccountSwitchService } from '../dist/account-switch.js';
import { replaceTopicRow } from '../dist/account-state.js';
import { bt, getActiveLocale, setActiveLocale } from '../dist/i18n.js';
import { ProtobufWriter as Writer } from '../dist/protobuf.js';

function makeQuota({
  lastUpdatedSec,
  gemini5h = 0.8,
  gemini5hResetIso,
  geminiWeekly = 0.85,
  geminiWeeklyResetIso,
  claude5h = 0.9,
  claude5hResetIso,
  tier = 'PRO',
  stale = false,
  forbidden = false,
}) {
  return {
    last_updated: lastUpdatedSec,
    is_forbidden: forbidden,
    subscription_tier: tier,
    model_forwarding_rules: {},
    models: [
      {
        name: 'gemini-2.5-pro',
        display_name: 'Gemini 2.5 Pro',
        family: 'gemini',
        percentage: Math.round(Math.min(gemini5h, geminiWeekly) * 100),
        percentage_known: true,
        own_percentage: Math.round(gemini5h * 100),
        own_percentage_known: true,
        own_observed_at: lastUpdatedSec,
        own_stale: stale,
        reset_time: gemini5hResetIso,
      },
      {
        name: 'claude-sonnet-4',
        display_name: 'Claude Sonnet 4',
        family: 'claude',
        percentage: Math.round(claude5h * 100),
        percentage_known: true,
        own_percentage: Math.round(claude5h * 100),
        own_percentage_known: true,
        own_observed_at: lastUpdatedSec,
        own_stale: stale,
        reset_time: claude5hResetIso,
      },
    ],
    quota_groups: [
      {
        display_name: 'Gemini',
        family: 'gemini',
        observed_at: lastUpdatedSec,
        stale,
        buckets: [
          {
            bucket_id: 'gemini-5h',
            window: '5h',
            remaining_fraction: gemini5h,
            remaining_fraction_known: true,
            reset_time: gemini5hResetIso,
            observed_at: lastUpdatedSec,
            stale,
          },
          {
            bucket_id: 'gemini-weekly',
            window: 'weekly',
            remaining_fraction: geminiWeekly,
            remaining_fraction_known: true,
            reset_time: geminiWeeklyResetIso,
            observed_at: lastUpdatedSec,
            stale,
          },
        ],
      },
      {
        display_name: 'Claude',
        family: 'claude',
        observed_at: lastUpdatedSec,
        stale,
        buckets: [
          {
            bucket_id: 'claude-5h',
            window: '5h',
            remaining_fraction: claude5h,
            remaining_fraction_known: true,
            reset_time: claude5hResetIso,
            observed_at: lastUpdatedSec,
            stale,
          },
        ],
      },
    ],
  };
}

function buildKeychainSecret(tokenObj, idTokenEmail) {
  return `go-keyring-base64:${Buffer.from(
    JSON.stringify({ token: tokenObj, ...(idTokenEmail ? { id_token_email: idTokenEmail } : {}) }),
    'utf8',
  ).toString('base64')}`;
}

async function createStateVscdb(vscdbPath, { accessToken, refreshToken, expirySec, email }) {
  await mkdir(join(vscdbPath, '..'), { recursive: true });
  const rows = [];
  if (refreshToken !== undefined) {
    const oauthPayload = Buffer.concat([
      Writer.encodeString(1, accessToken ?? ''),
      Writer.encodeString(2, 'Bearer'),
      Writer.encodeString(3, refreshToken),
      Writer.encodeLengthDelimited(
        4,
        Buffer.concat([Writer.encodeVarintField(1, expirySec ?? 0), Writer.encodeVarintField(2, 0)]),
      ),
    ]);
    rows.push({
      key: 'antigravityUnifiedStateSync.oauthToken',
      value: replaceTopicRow(undefined, 'oauthTokenInfoSentinelKey', oauthPayload),
    });
  }
  if (email) {
    rows.push({
      key: 'antigravityUnifiedStateSync.userStatus',
      value: replaceTopicRow(undefined, 'userStatusSentinelKey', Buffer.concat([Writer.encodeString(7, email)])),
    });
  }
  const sql = [
    'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT);',
    ...rows.map(r => `INSERT OR REPLACE INTO ItemTable(key, value) VALUES('${r.key}', '${r.value}');`),
  ].join('\n');
  execSqlite(vscdbPath, sql);
}

const pause = ms => new Promise(r => setTimeout(r, ms));
async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), pause(3000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}
async function waitReady(dir) {
  for (let i = 0; i < 300; i++) {
    try {
      await access(join(dir, 'control.sock'));
      await new Promise((res, rej) => {
        const s = createConnection(join(dir, 'control.sock'));
        s.once('connect', () => { s.destroy(); res(); });
        s.once('error', rej);
      });
      return;
    } catch {}
    await pause(20);
  }
  throw new Error('backend socket not ready');
}
const rpc = (dir, payload) => new Promise((resolve, reject) => {
  const s = createConnection(join(dir, 'control.sock'));
  let buf = '';
  s.on('error', reject);
  s.on('connect', () => s.write(JSON.stringify(payload) + '\n'));
  s.setTimeout(10_000, () => { s.destroy(); reject(new Error('rpc timeout')); });
  s.on('data', chunk => {
    buf += chunk;
    if (buf.includes('\n')) {
      s.end();
      resolve(JSON.parse(buf.split('\n')[0]));
    }
  });
});

test('Scenario 1: computeStandbyRefreshStatus, plain-language OAuth patterns, IPC projection & revision', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-standby-s1-'));
  const prevLocale = getActiveLocale();
  t.after(async () => {
    setActiveLocale(prevLocale);
    await rm(dir, { recursive: true, force: true });
  });

  const mgr = new AccountsManager(dir);
  const nowMs = Date.UTC(2026, 10, 21, 12, 0, 0);
  const nowSec = Math.floor(nowMs / 1000);
  const future1 = new Date(nowMs + 2 * 3600_000).toISOString();
  const future2 = new Date(nowMs + 5 * 86400_000).toISOString();
  const futureClaude = new Date(nowMs + 4 * 3600_000).toISOString();
  const pastReset = new Date(nowMs - 10 * 60_000).toISOString();

  const coolingAcc = await mgr.upsertAccount({
    email: 'cooling@example.invalid',
    refreshToken: '1//cooling-rt',
    accessToken: 'expired-cooling',
    expiryTimestamp: nowSec - 600,
    expiresIn: 0,
  });
  coolingAcc.quota = makeQuota({
    lastUpdatedSec: nowSec - 3600,
    gemini5h: 0.4,
    gemini5hResetIso: future1,
    geminiWeekly: 0.7,
    geminiWeeklyResetIso: future2,
    claude5h: 0.6,
    claude5hResetIso: futureClaude,
  });
  coolingAcc.quota_refresh_error_code = 'missing_oauth_client';
  coolingAcc.quota_refresh_error = '切换并使用该账号后会自动更新最新额度；未切换前可参考上次记录和倒计时。';

  // 1) live_active
  const liveStatus = computeStandbyRefreshStatus(coolingAcc, { isActive: true, hasLocalOAuthClient: false, nowMs });
  assert.equal(liveStatus.mode, 'live_active');
  assert.equal(liveStatus.canBackgroundRefresh, true);
  assert.deepEqual(liveStatus.cooldownElapsedFamilies, []);

  // 2) cloud_auto via local OAuth client or valid >= 300s access_token
  const oauthStatus = computeStandbyRefreshStatus(coolingAcc, { isActive: false, hasLocalOAuthClient: true, nowMs });
  assert.equal(oauthStatus.mode, 'cloud_auto');
  assert.equal(oauthStatus.canBackgroundRefresh, true);

  const freshTokenAcc = {
    ...coolingAcc,
    token: { ...coolingAcc.token, access_token: 'valid-access', expiry_timestamp: nowSec + 600 },
  };
  const validTokenStatus = computeStandbyRefreshStatus(freshTokenAcc, { isActive: false, hasLocalOAuthClient: false, nowMs });
  assert.equal(validTokenStatus.mode, 'cloud_auto');
  assert.equal(validTokenStatus.canBackgroundRefresh, true);

  // 3) snapshot_cooling (expired token + no OAuth client + all future resets)
  const coolingStatus = computeStandbyRefreshStatus(coolingAcc, { isActive: false, hasLocalOAuthClient: false, nowMs });
  assert.equal(coolingStatus.mode, 'snapshot_cooling');
  assert.equal(coolingStatus.canBackgroundRefresh, false);
  assert.equal(coolingStatus.lastSampledAt, nowSec - 3600);
  assert.equal(coolingStatus.nextResetAt, future1);
  assert.deepEqual(coolingStatus.cooldownElapsedFamilies, []);

  // 4) snapshot_cooldown_elapsed (gemini 5h reset passed; weekly & claude in future; deduplicated family)
  const elapsedAcc = {
    ...coolingAcc,
    quota: makeQuota({
      lastUpdatedSec: nowSec - 7200,
      gemini5h: 0.0,
      gemini5hResetIso: pastReset,
      geminiWeekly: 0.65,
      geminiWeeklyResetIso: future2,
      claude5h: 0.0,
      claude5hResetIso: pastReset,
    }),
  };
  const elapsedStatus = computeStandbyRefreshStatus(elapsedAcc, { isActive: false, hasLocalOAuthClient: false, nowMs });
  assert.equal(elapsedStatus.mode, 'snapshot_cooldown_elapsed');
  assert.equal(elapsedStatus.canBackgroundRefresh, false);
  assert.deepEqual(elapsedStatus.cooldownElapsedFamilies.sort(), ['claude', 'gemini']);
  assert.equal(elapsedStatus.nextResetAt, future2);

  // Never fabricate 100% on expired standby snapshot
  assert.equal(elapsedAcc.quota.quota_groups[0].buckets[0].remaining_fraction, 0.0);

  // 5) Plain-language OAuth patterns match both legacy and new texts
  for (const variant of [
    '切换并使用该账号后会自动更新最新额度；未切换前可参考上次记录和倒计时。',
    'Quota updates automatically after you switch to this account. Until then, refer to the last record and timer.',
    '请先打开 Antigravity 并进入任意项目，即可刷新当前账号额度。',
    "Open Antigravity and enter any project to refresh the current account's quota.",
  ]) {
    assert.equal(MISSING_OAUTH_CLIENT_PATTERN.test(variant), true, `should match: ${variant}`);
  }

  // 6) projectAccountForIpc & projectAccountForIpcNormalized suppress missing_oauth_client in standby snapshot modes
  const projectedStandby = projectAccountForIpc(coolingAcc, { isActive: false, hasLocalOAuthClient: false, nowMs });
  assert.equal(projectedStandby.standbyRefreshStatus.mode, 'snapshot_cooling');
  assert.equal(projectedStandby.quota_refresh_error, null);

  const normalizedElapsed = projectAccountForIpcNormalized(elapsedAcc, mgr, {
    isActive: false,
    hasLocalOAuthClient: false,
    nowMs,
    revisionWithReadiness: true,
  });
  assert.equal(normalizedElapsed.standbyRefreshStatus.mode, 'snapshot_cooldown_elapsed');
  assert.equal(normalizedElapsed.quota_refresh_error, null);
  assert.ok(normalizedElapsed.revision.endsWith(':needs_refresh:snapshot_cooldown_elapsed'));

  // Non-OAuth error is still preserved
  const otherErrAcc = {
    ...coolingAcc,
    quota_refresh_error_code: 'http_3501',
    quota_refresh_error: 'HTTP 403 (Official product license verification failed, error 3501; check this account in the official app)',
  };
  const projectedOtherErr = projectAccountForIpc(otherErrAcc, { isActive: false, hasLocalOAuthClient: false, nowMs });
  assert.ok(projectedOtherErr.quota_refresh_error);

  // Active live missing_oauth_client is preserved on live_active
  setActiveLocale('zh-Hans');
  const activeErrAcc = {
    ...coolingAcc,
    quota_refresh_error_code: 'missing_oauth_client',
    quota_refresh_error: bt('account_cloud.err.missing_oauth_client_active_live'),
  };
  const projectedActive = projectAccountForIpc(activeErrAcc, { isActive: true, hasLocalOAuthClient: false, nowMs });
  assert.equal(projectedActive.standbyRefreshStatus.mode, 'live_active');
  assert.equal(projectedActive.quota_refresh_error, bt('account_cloud.err.missing_oauth_client_active_live'));
});

test('Scenario 2: refreshAllQuotas skips expired standby without OAuth client and clears stale missing_oauth_client error', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-standby-s2-'));
  const prevCid = process.env.GRAVITYBOX_GOOGLE_CLIENT_ID;
  const prevSec = process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET;
  delete process.env.GRAVITYBOX_GOOGLE_CLIENT_ID;
  delete process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET;
  t.after(async () => {
    if (prevCid === undefined) delete process.env.GRAVITYBOX_GOOGLE_CLIENT_ID;
    else process.env.GRAVITYBOX_GOOGLE_CLIENT_ID = prevCid;
    if (prevSec === undefined) delete process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET;
    else process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET = prevSec;
    await rm(dir, { recursive: true, force: true });
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const futureIso = new Date((nowSec + 3600) * 1000).toISOString();
  const mgr = new AccountsManager(dir);

  const activeAcc = await mgr.upsertAccount({
    email: 'active-live@example.invalid',
    refreshToken: '1//active-rt',
    accessToken: 'expired-active',
    expiryTimestamp: nowSec - 600,
    expiresIn: 0,
  });
  const standbyAcc = await mgr.upsertAccount({
    email: 'standby-expired@example.invalid',
    refreshToken: '1//standby-rt',
    accessToken: 'expired-standby',
    expiryTimestamp: nowSec - 600,
    expiresIn: 0,
  });
  standbyAcc.quota_refresh_error = '切换并使用该账号后会自动更新最新额度；未切换前可参考上次记录和倒计时。';
  standbyAcc.quota_refresh_error_code = 'missing_oauth_client';
  await mgr.saveAccount(standbyAcc);
  await mgr.setCurrentAccount(activeAcc.id);

  // Mock live LS matching activeAcc
  mgr.probeLiveLanguageServer = async () => ({
    email: 'active-live@example.invalid',
    name: 'Active User',
    tier: 'PRO',
    accountType: 'consumer',
    quota: makeQuota({
      lastUpdatedSec: nowSec,
      gemini5h: 0.9,
      gemini5hResetIso: futureIso,
      geminiWeekly: 0.95,
      geminiWeeklyResetIso: new Date((nowSec + 86400) * 1000).toISOString(),
      claude5h: 0.9,
      claude5hResetIso: futureIso,
    }),
  });

  const res = await mgr.refreshAllQuotas(globalThis.fetch);
  assert.equal(res.accounts.length, 1);
  assert.equal(res.accounts[0].id, activeAcc.id);
  assert.equal(res.failures.length, 0);
  assert.equal(res.skippedStandby, 1);

  const standbyAfter = await mgr.getAccount(standbyAcc.id);
  assert.equal(standbyAfter.quota_refresh_error, null);
  assert.equal(standbyAfter.quota_refresh_error_code, null);

  // Direct refreshQuota on standby missing_oauth_client rejects without persisting quota_refresh_error
  standbyAfter.quota_refresh_error = bt('account_cloud.err.missing_oauth_client');
  standbyAfter.quota_refresh_error_code = 'missing_oauth_client';
  await mgr.saveAccount(standbyAfter);

  await assert.rejects(
    mgr.refreshQuota(standbyAcc.id),
    err => accountErrorCode(err) === 'missing_oauth_client',
  );
  const standbyAfterDirect = await mgr.getAccount(standbyAcc.id);
  assert.equal(standbyAfterDirect.quota_refresh_error, null);
  assert.equal(standbyAfterDirect.quota_refresh_error_code, null);
});

test('Scenario 3: opportunistic token harvest (strict email match, >+60s expiry, live & outgoing switch)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gb-standby-s3-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const stateDir = join(root, 'state');
  const profileDir = join(root, 'Antigravity');
  await mkdir(join(profileDir, 'User', 'globalStorage'), { recursive: true });
  const nowSec = Math.floor(Date.now() / 1000);

  const mgr = new AccountsManager(stateDir, {
    target: {
      channel: 'stable',
      label: 'Antigravity',
      appName: 'Antigravity',
      appPath: '/Applications/Antigravity.app',
      bundleId: 'com.google.antigravity',
      name: 'Antigravity',
      profile: profileDir,
      dataDirName: 'antigravity',
      supportsAccountSwitch: true,
    },
  });

  const accA = await mgr.upsertAccount({
    email: 'user-a@example.invalid',
    refreshToken: '1//rt-a-old',
    accessToken: 'at-a-old',
    expiryTimestamp: nowSec + 100,
    expiresIn: 100,
  });
  accA.quota_refresh_error = bt('account_cloud.err.missing_oauth_client');
  accA.quota_refresh_error_code = 'missing_oauth_client';
  await mgr.saveAccount(accA);

  const accB = await mgr.upsertAccount({
    email: 'user-b@example.invalid',
    refreshToken: '1//rt-b',
    accessToken: 'at-b',
    expiryTimestamp: nowSec + 3600,
    expiresIn: 3600,
  });
  await mgr.setCurrentAccount(accA.id);

  // Email mismatch in keychain/vscdb must NOT harvest into accA
  const keychain = new MockKeychainAdapter();
  await keychain.writePassword(
    'gemini',
    'antigravity',
    buildKeychainSecret({
      access_token: 'at-wrong',
      refresh_token: '1//rt-wrong',
      expiry_timestamp: nowSec + 3600,
      email: 'someone-else@example.invalid',
    }),
  );
  assert.equal(await mgr.harvestActiveSessionTokenIfMatched('user-a@example.invalid', { keychain, homeDir: root }), null);
  assert.equal(await mgr.harvestTokenForAccountId(accA.id, { keychain, homeDir: root }), null);

  // Within +60s window must NOT overwrite
  await keychain.writePassword(
    'gemini',
    'antigravity',
    buildKeychainSecret({
      access_token: 'at-a-within-60',
      refresh_token: '1//rt-a-new',
      expiry_timestamp: nowSec + 140,
      email: 'user-a@example.invalid',
    }),
  );
  assert.equal(await mgr.harvestTokenForAccountId(accA.id, { keychain, homeDir: root }), null);

  // Fresher (> +60s) token in state.vscdb is harvested during AccountSwitchService.switchAccount BEFORE host overwrite
  await createStateVscdb(join(profileDir, 'User', 'globalStorage', 'state.vscdb'), {
    accessToken: 'at-a-fresh-from-ide',
    refreshToken: '1//rt-a-rotated',
    expirySec: nowSec + 3500,
    email: 'user-a@example.invalid',
  });

  const switchService = new AccountSwitchService(mgr, {
    stateDir,
    profile: profileDir,
    keychain,
    homeDir: root,
    isRunning: async () => false,
  });
  await switchService.switchAccount(accB.id);

  const accAAfterSwitch = await mgr.getAccount(accA.id);
  assert.equal(accAAfterSwitch.token.access_token, 'at-a-fresh-from-ide');
  assert.equal(accAAfterSwitch.token.refresh_token, '1//rt-a-rotated');
  assert.equal(accAAfterSwitch.token.expiry_timestamp, nowSec + 3500);
  assert.equal(accAAfterSwitch.quota_refresh_error, null);
  assert.equal(accAAfterSwitch.quota_refresh_error_code, null);

  // Verify live persistLiveResult() also opportunistically harvests fresher token from state.vscdb
  const futureIso = new Date((nowSec + 3600) * 1000).toISOString();
  await createStateVscdb(join(profileDir, 'User', 'globalStorage', 'state.vscdb'), {
    accessToken: 'at-b-fresh-live',
    refreshToken: '1//rt-b-rotated',
    expirySec: nowSec + 7200,
    email: 'user-b@example.invalid',
  });
  mgr.probeLiveLanguageServer = async () => ({
    email: 'user-b@example.invalid',
    name: 'User B',
    tier: 'PRO',
    accountType: 'consumer',
    quota: makeQuota({
      lastUpdatedSec: nowSec,
      gemini5h: 0.8,
      gemini5hResetIso: futureIso,
      geminiWeekly: 0.9,
      geminiWeeklyResetIso: new Date((nowSec + 86400) * 1000).toISOString(),
      claude5h: 0.85,
      claude5hResetIso: futureIso,
    }),
  });
  const refreshedB = await mgr.refreshQuota(accB.id);
  assert.equal(refreshedB.token.access_token, 'at-b-fresh-live');
  assert.equal(refreshedB.token.refresh_token, '1//rt-b-rotated');
});

test('Scenario 4: evaluateStandbyCandidate & selectBestAccount 3-tier ordering, round_robin, and Free protection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-standby-s4-'));
  const prevLocale = getActiveLocale();
  t.after(async () => {
    setActiveLocale(prevLocale);
    await rm(dir, { recursive: true, force: true });
  });
  setActiveLocale('zh-Hans');

  const mgr = new AccountsManager(dir);
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const future5h = new Date(nowMs + 2 * 3600_000).toISOString();
  const futureWeekly = new Date(nowMs + 5 * 86400_000).toISOString();
  const pastResetEarly = new Date(nowMs - 3600_000).toISOString();
  const pastResetLate = new Date(nowMs - 600_000).toISOString();

  const currentAcc = await mgr.upsertAccount({
    email: 'current@example.invalid',
    refreshToken: '1//cur',
    accessToken: 'at-cur',
    expiryTimestamp: nowSec + 3600,
  });
  currentAcc.quota = makeQuota({
    lastUpdatedSec: nowSec - 10,
    gemini5h: 0.05,
    gemini5hResetIso: future5h,
    geminiWeekly: 0.5,
    geminiWeeklyResetIso: futureWeekly,
    tier: 'PRO',
  });
  await mgr.saveAccount(currentAcc);
  await mgr.setCurrentAccount(currentAcc.id);

  // Candidate 1: FREE fresh 95% (must NOT beat PRO candidates)
  const freeFresh = await mgr.upsertAccount({
    email: 'free-fresh@example.invalid',
    refreshToken: '1//free',
    accessToken: 'at-free',
    expiryTimestamp: nowSec + 3600,
  });
  freeFresh.quota = makeQuota({
    lastUpdatedSec: nowSec - 10,
    gemini5h: 0.95,
    gemini5hResetIso: future5h,
    geminiWeekly: 0.95,
    geminiWeeklyResetIso: futureWeekly,
    tier: 'FREE',
  });
  await mgr.saveAccount(freeFresh);

  // Candidate 2: PRO cooldown_elapsed (early reset)
  const proResetEarly = await mgr.upsertAccount({
    email: 'pro-reset-early@example.invalid',
    refreshToken: '1//pre',
    accessToken: 'expired',
    expiryTimestamp: nowSec - 600,
  });
  proResetEarly.quota = makeQuota({
    lastUpdatedSec: nowSec - 7200,
    gemini5h: 0.0,
    gemini5hResetIso: pastResetEarly,
    geminiWeekly: 0.8,
    geminiWeeklyResetIso: futureWeekly,
    tier: 'PRO',
  });
  await mgr.saveAccount(proResetEarly);

  // Candidate 3: PRO cooldown_elapsed (late reset)
  const proResetLate = await mgr.upsertAccount({
    email: 'pro-reset-late@example.invalid',
    refreshToken: '1//prl',
    accessToken: 'expired',
    expiryTimestamp: nowSec - 600,
  });
  proResetLate.quota = makeQuota({
    lastUpdatedSec: nowSec - 7200,
    gemini5h: 0.0,
    gemini5hResetIso: pastResetLate,
    geminiWeekly: 0.8,
    geminiWeeklyResetIso: futureWeekly,
    tier: 'PRO',
  });
  await mgr.saveAccount(proResetLate);

  // Candidate 4: PRO snapshot (aged 3h, reset still in future, 75%)
  const proSnapshot = await mgr.upsertAccount({
    email: 'pro-snapshot@example.invalid',
    refreshToken: '1//ps',
    accessToken: 'expired',
    expiryTimestamp: nowSec - 600,
  });
  proSnapshot.quota = makeQuota({
    lastUpdatedSec: nowSec - 10800,
    gemini5h: 0.75,
    gemini5hResetIso: future5h,
    geminiWeekly: 0.8,
    geminiWeeklyResetIso: futureWeekly,
    tier: 'PRO',
  });
  await mgr.saveAccount(proSnapshot);

  // Candidate 5: PRO fresh (60%) -> beats PRO snapshot (75%)!
  const proFresh = await mgr.upsertAccount({
    email: 'pro-fresh@example.invalid',
    refreshToken: '1//pf',
    accessToken: 'at-pf',
    expiryTimestamp: nowSec + 3600,
  });
  proFresh.quota = makeQuota({
    lastUpdatedSec: nowSec - 30,
    gemini5h: 0.6,
    gemini5hResetIso: future5h,
    geminiWeekly: 0.8,
    geminiWeeklyResetIso: futureWeekly,
    tier: 'PRO',
  });
  await mgr.saveAccount(proFresh);

  // computeAccountRemaining strictness untouched
  assert.equal(computeAccountRemaining(proSnapshot, 'gemini', { nowMs }), null);
  assert.equal(computeAccountRemaining(proResetEarly, 'gemini', { nowMs }), null);

  // evaluateStandbyCandidate returns exact tiers
  assert.deepEqual(evaluateStandbyCandidate(proFresh, 'gemini', { nowMs, minPercentage: 30 }), {
    tier: 'fresh',
    remaining: 60,
    earliestResetMs: null,
  });
  assert.deepEqual(evaluateStandbyCandidate(proSnapshot, 'gemini', { nowMs, minPercentage: 30 }), {
    tier: 'snapshot',
    remaining: 75,
    earliestResetMs: null,
  });
  assert.equal(evaluateStandbyCandidate(proResetEarly, 'gemini', { nowMs, minPercentage: 30 })?.tier, 'cooldown_elapsed');
  assert.equal(evaluateStandbyCandidate(proResetEarly, 'gemini', { nowMs, minPercentage: 30 })?.remaining, null);

  const baseCfg = {
    enabled: true,
    strategy: 'priority',
    reserve_percentage: 10,
    candidate_min_percentage: 30,
    monitored_model: 'gemini',
  };

  // Priority: PRO fresh (60%) beats PRO snapshot (75%) & FREE fresh (95%)
  const recFresh = await mgr.selectBestAccount({
    ...baseCfg,
    candidate_account_ids: [freeFresh.id, proResetLate.id, proResetEarly.id, proSnapshot.id, proFresh.id],
  });
  assert.equal(recFresh.shouldSwitch, true);
  assert.equal(recFresh.bestCandidate?.id, proFresh.id);
  assert.equal(recFresh.reason, bt('accounts.recommend.should_switch', { currentRem: 5, bestDisplay: proFresh.email, bestRem: 60 }));

  // Without fresh PRO: PRO snapshot beats PRO cooldown_elapsed
  const recSnap = await mgr.selectBestAccount({
    ...baseCfg,
    candidate_account_ids: [freeFresh.id, proResetLate.id, proResetEarly.id, proSnapshot.id],
  });
  assert.equal(recSnap.shouldSwitch, true);
  assert.equal(recSnap.bestCandidate?.id, proSnapshot.id);
  assert.equal(recSnap.reason, bt('accounts.recommend.should_switch_snapshot', { currentRem: 5, bestDisplay: proSnapshot.email, bestRem: 75 }));

  // Without fresh or snapshot PRO: earliest reset PRO cooldown_elapsed wins
  const recReset = await mgr.selectBestAccount({
    ...baseCfg,
    candidate_account_ids: [freeFresh.id, proResetLate.id, proResetEarly.id],
  });
  assert.equal(recReset.shouldSwitch, true);
  assert.equal(recReset.bestCandidate?.id, proResetEarly.id);
  assert.equal(recReset.reason, bt('accounts.recommend.should_switch_reset', { currentRem: 5, bestDisplay: proResetEarly.email }));

  // Free downgrade protection still holds when only FREE candidate exists and current is 5% > 0%
  const recFreeOnly = await mgr.selectBestAccount({
    ...baseCfg,
    candidate_account_ids: [freeFresh.id],
  });
  assert.equal(recFreeOnly.shouldSwitch, false);
  assert.equal(recFreeOnly.bestCandidate?.id, freeFresh.id);

  // Round-robin includes snapshot & cooldown_elapsed candidates
  const rr1 = await mgr.selectBestAccount({
    ...baseCfg,
    strategy: 'round_robin',
    candidate_account_ids: [currentAcc.id, proSnapshot.id, proResetEarly.id],
  });
  assert.equal(rr1.shouldSwitch, true);
  assert.equal(rr1.bestCandidate?.id, proSnapshot.id);

  const rr2 = await mgr.selectBestAccount({
    ...baseCfg,
    strategy: 'round_robin',
    last_switched_id: proSnapshot.id,
    candidate_account_ids: [currentAcc.id, proSnapshot.id, proResetEarly.id],
  });
  assert.equal(rr2.shouldSwitch, true);
  assert.equal(rr2.bestCandidate?.id, proResetEarly.id);
});

test('Scenario 5: IPC quota_refresh standbyDeferred, quota_refresh_start task summary, and standbyRefreshStatus projection', { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-standby-s5-'));
  await mkdir(join(dir, '词典'), { recursive: true });
  await mkdir(join(dir, 'profile'), { recursive: true });
  await mkdir(join(dir, 'home'), { recursive: true });
  await mkdir(join(dir, 'appsupport'), { recursive: true });
  await mkdir(join(dir, 'gemini'), { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify({ schema: 2, appLanguage: 'zh-Hans', applicationChannel: 'stable' }));

  const nowSec = Math.floor(Date.now() / 1000);
  const futureIso = new Date((nowSec + 3600) * 1000).toISOString();
  const mgr = new AccountsManager(dir);
  const activeAcc = await mgr.upsertAccount({
    email: 'active-ipc@example.invalid',
    refreshToken: '1//act-ipc',
    accessToken: 'expired-act',
    expiryTimestamp: nowSec - 600,
    expiresIn: 0,
  });
  const standbyAcc = await mgr.upsertAccount({
    email: 'standby-ipc@example.invalid',
    refreshToken: '1//stb-ipc',
    accessToken: 'expired-stb',
    expiryTimestamp: nowSec - 600,
    expiresIn: 0,
  });
  standbyAcc.quota = makeQuota({
    lastUpdatedSec: nowSec - 1800,
    gemini5h: 0.7,
    gemini5hResetIso: futureIso,
    geminiWeekly: 0.8,
    geminiWeeklyResetIso: new Date((nowSec + 86400) * 1000).toISOString(),
  });
  await mgr.saveAccount(standbyAcc);
  await mgr.setCurrentAccount(activeAcc.id);

  const preload = join(dir, 'preload.mjs');
  await writeFile(
    preload,
    `import { AccountsManager } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/accounts.js')).href)};
const futureIso = ${JSON.stringify(futureIso)};
const nowSec = ${nowSec};
const liveQuota = ${JSON.stringify(makeQuota({
  lastUpdatedSec: nowSec,
  gemini5h: 0.9,
  gemini5hResetIso: futureIso,
  geminiWeekly: 0.95,
  geminiWeeklyResetIso: new Date((nowSec + 86400) * 1000).toISOString(),
}))};
AccountsManager.prototype.probeLiveLanguageServer = async () => ({
  email: 'active-ipc@example.invalid',
  name: 'Active IPC',
  tier: 'PRO',
  accountType: 'consumer',
  quota: liveQuota,
});`,
  );

  const env = { ...process.env };
  delete env.GRAVITYBOX_GOOGLE_CLIENT_ID;
  delete env.GRAVITYBOX_GOOGLE_CLIENT_SECRET;
  env.GRAVITYBOX_DISABLE_AUTO_QUOTA_REFRESH = '1';

  const child = spawn(
    process.execPath,
    [
      '--import', preload,
      fileURLToPath(new URL('../dist/main.js', import.meta.url)),
      '--state-dir', dir,
      '--app', '/nonexistent',
      '--profile', join(dir, 'profile'),
      '--gemini-dir', join(dir, 'gemini'),
      '--home-dir', join(dir, 'home'),
      '--app-support-dir', join(dir, 'appsupport'),
    ],
    { cwd: dir, stdio: 'ignore', env },
  );
  t.after(async () => {
    await stopChild(child);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  await waitReady(dir);

  // 1) account_list returns standbyRefreshStatus on both accounts
  const listRes = await rpc(dir, { command: 'account_list' });
  assert.equal(listRes.ok, true);
  const projActive = listRes.accounts.find(a => a.id === activeAcc.id);
  const projStandby = listRes.accounts.find(a => a.id === standbyAcc.id);
  assert.equal(projActive.standbyRefreshStatus.mode, 'live_active');
  assert.equal(projStandby.standbyRefreshStatus.mode, 'snapshot_cooling');

  // 2) quota_refresh on standby account returns standbyDeferred: true with plain-language notice
  const singleRes = await rpc(dir, { command: 'quota_refresh', id: standbyAcc.id });
  assert.equal(singleRes.ok, true);
  assert.equal(singleRes.partial, false);
  assert.equal(singleRes.standbyDeferred, true);
  assert.match(singleRes.notice, /切换并使用该账号后会自动更新最新额度/);
  assert.equal(singleRes.account.standbyRefreshStatus.mode, 'snapshot_cooling');
  assert.equal(singleRes.account.quota_refresh_error, null);

  // 3) quota_refresh_start finishes succeeded with skippedStandby: 1
  const startRes = await rpc(dir, { command: 'quota_refresh_start' });
  assert.equal(startRes.ok, true);
  let task;
  for (let i = 0; i < 60; i++) {
    const tasksRes = await rpc(dir, { command: 'task_list' });
    task = tasksRes.tasks.find(tItem => tItem.id === startRes.taskId);
    if (task && task.state !== 'running') break;
    await pause(50);
  }
  assert.equal(task.state, 'succeeded');
  assert.equal(task.result.ok, true);
  assert.equal(task.result.partial, false);
  assert.equal(task.result.updated, 1);
  assert.equal(task.result.skippedStandby, 1);
  assert.match(task.result.message, /已更新 1 个账号，其余 1 个备用账号将在切换后自动更新/);
});

test('Scenario 6: maybeScheduleAutoQuotaRefresh skips expired standby and triggers Pre-expiry Last-Mile Snap once per token expiry', { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-standby-s6-'));
  await mkdir(join(dir, '词典'), { recursive: true });
  await mkdir(join(dir, 'profile'), { recursive: true });
  await mkdir(join(dir, 'home'), { recursive: true });
  await mkdir(join(dir, 'appsupport'), { recursive: true });
  await mkdir(join(dir, 'gemini'), { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    schema: 2,
    appLanguage: 'zh-Hans',
    applicationChannel: 'stable',
    quotaRefreshMinutes: 30,
  }));

  const nowSec = Math.floor(Date.now() / 1000);
  const futureIso = new Date((nowSec + 3600) * 1000).toISOString();
  const mgr = new AccountsManager(dir);

  // Active account: recently updated -> NOT overdue
  const activeFresh = await mgr.upsertAccount({
    email: 'active-s6@example.invalid',
    refreshToken: '1//act-s6',
    accessToken: 'at-act-s6',
    expiryTimestamp: nowSec + 3600,
  });
  activeFresh.quota = makeQuota({
    lastUpdatedSec: nowSec - 60,
    gemini5h: 0.9,
    gemini5hResetIso: futureIso,
    geminiWeekly: 0.9,
    geminiWeeklyResetIso: futureIso,
  });
  await mgr.saveAccount(activeFresh);
  await mgr.setCurrentAccount(activeFresh.id);

  // Standby 1: expired token, old quota -> must NOT count as overdue for refreshAllQuotas
  const expiredStandby = await mgr.upsertAccount({
    email: 'expired-s6@example.invalid',
    refreshToken: '1//exp-s6',
    accessToken: 'expired',
    expiryTimestamp: nowSec - 600,
    expiresIn: 0,
  });
  expiredStandby.quota = makeQuota({
    lastUpdatedSec: nowSec - 7200,
    gemini5h: 0.7,
    gemini5hResetIso: futureIso,
    geminiWeekly: 0.8,
    geminiWeeklyResetIso: futureIso,
  });
  await mgr.saveAccount(expiredStandby);

  // Standby 2: harvested valid token in [315, 420]s window, last_updated >= 300s ago -> MUST fire single refreshQuota once
  const snapStandby = await mgr.upsertAccount({
    email: 'snap-s6@example.invalid',
    refreshToken: '1//snap-s6',
    accessToken: 'valid-last-mile',
    expiryTimestamp: nowSec + 360,
    expiresIn: 360,
  });
  snapStandby.quota = makeQuota({
    lastUpdatedSec: nowSec - 600,
    gemini5h: 0.8,
    gemini5hResetIso: futureIso,
    geminiWeekly: 0.8,
    geminiWeeklyResetIso: futureIso,
  });
  await mgr.saveAccount(snapStandby);

  const logFile = join(dir, 'scheduler-calls.log');
  const preload = join(dir, 'preload.mjs');
  await writeFile(
    preload,
    `import { appendFileSync } from 'node:fs';
import { AccountsManager } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/accounts.js')).href)};
const logFile = ${JSON.stringify(logFile)};
const origSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, delay, ...args) => origSetTimeout(fn, delay === 5000 ? 60 : delay, ...args);
const origSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, delay, ...args) => origSetInterval(fn, delay === 30000 ? 120 : delay, ...args);
AccountsManager.prototype.probeLiveLanguageServer = async () => null;
AccountsManager.prototype.refreshAllQuotas = async () => {
  appendFileSync(logFile, 'refreshAllQuotas\\n');
  return { accounts: [], failures: [], skippedStandby: 0 };
};
AccountsManager.prototype.refreshQuota = async function(id) {
  appendFileSync(logFile, 'refreshQuota:' + id + '\\n');
  return await this.getAccount(id);
};`,
  );

  const env = { ...process.env };
  delete env.GRAVITYBOX_GOOGLE_CLIENT_ID;
  delete env.GRAVITYBOX_GOOGLE_CLIENT_SECRET;
  delete env.GRAVITYBOX_DISABLE_AUTO_QUOTA_REFRESH;

  const child = spawn(
    process.execPath,
    [
      '--import', preload,
      fileURLToPath(new URL('../dist/main.js', import.meta.url)),
      '--state-dir', dir,
      '--app', '/nonexistent',
      '--profile', join(dir, 'profile'),
      '--gemini-dir', join(dir, 'gemini'),
      '--home-dir', join(dir, 'home'),
      '--app-support-dir', join(dir, 'appsupport'),
    ],
    { cwd: dir, stdio: 'ignore', env },
  );
  t.after(async () => {
    await stopChild(child);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  await waitReady(dir);
  await pause(450);

  const { readFile } = await import('node:fs/promises');
  const calls = (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(calls.includes('refreshAllQuotas'), false, 'expired standby must not trigger refreshAllQuotas');
  assert.deepEqual(calls.filter(c => c.startsWith('refreshQuota:')), [`refreshQuota:${snapStandby.id}`], 'last-mile snap must fire exactly once');
});
