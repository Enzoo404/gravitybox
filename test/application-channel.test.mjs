import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import {
  applicationChannel,
  applicationTarget,
  channelStateDirectory,
  detectInstalledChannels,
  matchingTargetForLanguageServerCommand,
  probeBundleCapabilities,
  targetForApp,
} from '../dist/application-target.js';
import { compareLayers } from '../dist/dictionary.js';
import { UsageStatsManager } from '../dist/usage.js';
import { AccountsManager, MockKeychainAdapter, cloudProviderContextFromCommand, syncAccountToKeychain, validCachedCloudProviderContext } from '../dist/accounts.js';
import { AccountSwitchService } from '../dist/account-switch.js';

const temporary = async t => { const dir = await mkdtemp(join(tmpdir(), 'gb-channel-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const quota = fraction => ({ models: [], last_updated: 1700000000, is_forbidden: false, model_forwarding_rules: {}, subscription_tier: fraction });
const account = {
  id: 'fixture',
  email: 'fixture@example.invalid',
  token: { access_token: 'synthetic', refresh_token: 'synthetic-refresh', expiry_timestamp: 9999999999 },
  disabled: false,
  protected_models: [],
  validation_blocked: false,
  created_at: 1,
  last_used: 1,
};

test('Antigravity 与 Antigravity - Insiders 统一对外显示 Antigravity 且全功能默认开启', () => {
  assert.equal(applicationChannel(undefined), 'stable');
  assert.throws(() => applicationChannel('preview'));
  const stableTarget = applicationTarget('stable', '/synthetic-home');
  const insidersTarget = applicationTarget('insiders', '/synthetic-home');
  assert.equal(stableTarget.label, 'Antigravity');
  assert.equal(insidersTarget.label, 'Antigravity');
  assert.equal(stableTarget.supportsAccountSwitch, true);
  assert.equal(insidersTarget.supportsAccountSwitch, true);
  assert.equal(insidersTarget.bundleId, 'com.google.antigravity.insiders');
  assert.equal(insidersTarget.executable, 'Antigravity - Insiders');
  assert.equal(insidersTarget.profile, '/synthetic-home/Library/Application Support/Antigravity - Insiders');
  assert.equal(targetForApp(insidersTarget.appPath).channel, 'insiders');
  assert.equal(channelStateDirectory('/state', 'stable'), '/state');
  assert.equal(channelStateDirectory('/state', 'insiders'), '/state');
});

test('单应用自动回落、双应用并存识别与 WCV 架构无感全功能兼容', async t => {
  const appsDir = await temporary(t);
  await mkdir(join(appsDir, 'Antigravity.app', 'Contents', 'Resources'), { recursive: true });
  const onlyStable = detectInstalledChannels('insiders', appsDir);
  assert.equal(onlyStable.bothInstalled, false);
  assert.deepEqual(onlyStable.channels, ['stable']);
  assert.equal(onlyStable.effectiveChannel, 'stable');

  await mkdir(join(appsDir, 'Antigravity - Insiders.app', 'Contents', 'Resources'), { recursive: true });
  const both = detectInstalledChannels('insiders', appsDir);
  assert.equal(both.bothInstalled, true);
  assert.deepEqual(both.channels, ['stable', 'insiders']);
  assert.equal(both.effectiveChannel, 'insiders');

  await rm(join(appsDir, 'Antigravity.app'), { recursive: true, force: true });
  const onlyInsiders = detectInstalledChannels('stable', appsDir);
  assert.equal(onlyInsiders.bothInstalled, false);
  assert.deepEqual(onlyInsiders.channels, ['insiders']);
  assert.equal(onlyInsiders.effectiveChannel, 'insiders');

  // Antigravity 2.29+ / Insiders WCV-Hub architecture maintains full feature support including account switch
  const futureStableApp = join(appsDir, 'Antigravity.app');
  await mkdir(join(futureStableApp, 'Contents', 'Resources'), { recursive: true });
  const pkgJson = Buffer.from(JSON.stringify({ version: '2.29.0', productName: 'Antigravity' }), 'utf8');
  const headerObj = {
    files: {
      'package.json': { size: pkgJson.length, offset: '0' },
      dist: { files: { 'wcvBrowserRegistry.js': { size: 10, offset: String(pkgJson.length) } } },
    },
  };
  const headerBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const alignedHeaderSize = Math.ceil((headerBuf.length + 4) / 4) * 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(alignedHeaderSize + 4, 4);
  prefix.writeUInt32LE(alignedHeaderSize, 8);
  prefix.writeUInt32LE(headerBuf.length, 12);
  const paddedHeader = Buffer.alloc(alignedHeaderSize - 4);
  headerBuf.copy(paddedHeader, 0);
  await writeFile(join(futureStableApp, 'Contents', 'Resources', 'app.asar'), Buffer.concat([prefix, paddedHeader, pkgJson]));

  const futureCaps = probeBundleCapabilities(futureStableApp, 'stable');
  assert.equal(futureCaps.architecture, 'wcv-hub');
  assert.equal(futureCaps.supportsAccountSwitch, true);
  assert.equal(futureCaps.dataDirectoryName, 'antigravity');

  assert.equal(compareLayers('2.28.0.json', '1.0.20261103010115.json') < 0, true);
});

test('默认聚合发现 antigravity 与 antigravity-insiders 会话库，严格排除备份、IDE 及符号链接', async t => {
  const root = await temporary(t);
  for (const name of ['antigravity', 'antigravity-insiders', 'antigravity-backup', 'antigravity-ide']) {
    await mkdir(join(root, name, 'conversations'), { recursive: true });
    await writeFile(join(root, name, 'conversations', 'same.db'), 'synthetic');
    await writeFile(join(root, name, 'token_usage_archive.db'), 'synthetic');
  }
  await symlink(join(root, 'antigravity-backup', 'conversations', 'same.db'), join(root, 'antigravity-insiders', 'conversations', 'linked.db'));

  // Default manager aggregates both antigravity and antigravity-insiders
  const unifiedManager = new UsageStatsManager({ geminiDir: root, stateDir: root });
  const unifiedPaths = await unifiedManager.discoverDatabaseFiles();
  assert.deepEqual(
    unifiedPaths.sort(),
    [
      join(root, 'antigravity', 'conversations', 'same.db'),
      join(root, 'antigravity', 'token_usage_archive.db'),
      join(root, 'antigravity-insiders', 'conversations', 'same.db'),
      join(root, 'antigravity-insiders', 'token_usage_archive.db'),
    ].sort(),
  );

  // Explicit single-directory filter still works when specified
  for (const name of ['antigravity', 'antigravity-insiders']) {
    const manager = new UsageStatsManager({ geminiDir: root, stateDir: root, dataDirectoryName: name });
    const paths = await manager.discoverDatabaseFiles();
    assert.deepEqual(paths.sort(), [join(root, name, 'conversations', 'same.db'), join(root, name, 'token_usage_archive.db')].sort());
  }
});

test('Antigravity 与 Antigravity - Insiders 共享统一账号池、配额与无 state.vscdb 下的切号与回滚', async t => {
  const state = await temporary(t);
  const profileDir = await temporary(t);
  const stable = new AccountsManager(state);
  const insiders = new AccountsManager(state, { target: applicationTarget('insiders') });

  await stable.saveAccount({ ...account, quota: quota('PRO') });
  const fromInsiders = await insiders.getAccount(account.id);
  assert.equal(fromInsiders.quota.subscription_tier, 'PRO');

  // Switch account and rollback on Insiders / WCV 2.29+ profile where state.vscdb does NOT exist
  const keychain = new MockKeychainAdapter();
  await keychain.writePassword('gemini', 'antigravity', 'go-keyring-base64:previous-session');
  const switchService = new AccountSwitchService(insiders, {
    stateDir: state,
    profile: profileDir,
    externalDir: join(state, 'external'),
    channel: 'insiders',
    keychain,
    isRunning: async () => false,
  });

  const switched = await switchService.switchAccount(account.id);
  assert.equal(switched.switchedTo, account.email);
  const writtenKeychain = await keychain.readPassword('gemini', 'antigravity');
  assert.match(writtenKeychain ?? '', /^go-keyring-base64:/);

  // Rollback restores previous Keychain credential and account records even without state.vscdb
  const rolledBack = await switchService.rollback();
  assert.match(rolledBack.message, /已恢复切换前的账号记录/);
  assert.equal(await keychain.readPassword('gemini', 'antigravity'), 'go-keyring-base64:previous-session');

  // Re-switch and verify saveCurrentAccount from Keychain in Insiders mode
  await switchService.switchAccount(account.id);
  const captured = await insiders.saveCurrentAccount({
    keychain,
    homeDir: profileDir,
    appSupportDir: profileDir,
  });
  assert.equal(captured.email, account.email);
});

test('语言服务命令行自动匹配正式版或 Insiders，且保留对应版本与 hub 身份', () => {
  const target = applicationTarget('insiders');
  const version = '1.0.20261103010115';
  const command = target.appPath + '/Contents/Resources/bin/language_server --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com --subclient_type hub --override_ide_version ' + version;
  assert.equal(matchingTargetForLanguageServerCommand(command)?.channel, 'insiders');
  assert.equal(cloudProviderContextFromCommand(command, version), null);
  const context = cloudProviderContextFromCommand(command, version, target);
  assert.equal(cloudProviderContextFromCommand(command + ' --app_data_dir antigravity', version, target), null);
  assert.equal(context.userAgent, 'antigravity/hub/' + version);
  assert.equal(validCachedCloudProviderContext(context, version, target), true);
  assert.equal(validCachedCloudProviderContext(context, '2.28.2', applicationTarget()), false);
});

function request(socket, command) {
  return new Promise((resolve, reject) => {
    const client = createConnection(socket); let data = '';
    client.setTimeout(4000, () => client.destroy(new Error('fixture timeout')));
    client.on('connect', () => client.write(JSON.stringify(command) + '\n'));
    client.on('data', b => { data += b; if (data.includes('\n')) { client.end(); resolve(JSON.parse(data.split('\n')[0])); } });
    client.on('error', reject);
  });
}

test('IPC 在正式版与 Insiders 下均对外统一显示 Antigravity 并开放全部账号功能', { timeout: 15000 }, async t => {
  const state = await temporary(t);
  await mkdir(join(state, 'profile'));
  await writeFile(join(state, 'config.json'), JSON.stringify({ applicationChannel: 'insiders' }));
  const child = spawn(
    process.execPath,
    ['dist/main.js', '--state-dir', state, '--profile', join(state, 'profile'), '--gemini-dir', join(state, 'gemini')],
    { env: { ...process.env, GRAVITYBOX_PROBE_LS: 'false' }, stdio: 'ignore' },
  );
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
  const socket = join(state, 'control.sock');
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await request(socket, { command: 'ping' }); ready = true; break; } catch {}
    await new Promise(r => setTimeout(r, 30));
  }
  assert.equal(ready, true);

  const preflight = await request(socket, { command: 'account_switch_preflight', id: 'fixture' });
  assert.equal(preflight.ok, true);

  const status = await request(socket, { command: 'status', includeAccounts: false });
  assert.equal(status.status.accountSwitchSupported, true);
  assert.equal(status.status.applicationLabel, 'Antigravity');

  const beforePid = status.status.pid;
  const switched = await request(socket, { command: 'set_application_channel', channel: 'stable' });
  assert.equal(switched.ok, true);
  assert.equal(switched.applicationLabel, 'Antigravity');
  assert.equal(switched.accountSwitchSupported, true);
  const statusAfter = await request(socket, { command: 'status', includeAccounts: false });
  assert.equal(statusAfter.status.pid, beforePid);
  assert.equal(statusAfter.status.applicationLabel, 'Antigravity');
  assert.equal(statusAfter.status.accountSwitchSupported, true);

  await request(socket, { command: 'stop' });
  if (child.exitCode === null) await once(child, 'exit');
});
