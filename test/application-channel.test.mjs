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
  savedApplicationChannel,
  allApplicationTargets,
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

test('仅正式版可作为运行目标，旧持久配置可迁移而显式 Insiders 请求失败', () => {
  assert.equal(applicationChannel(undefined), 'stable');
  assert.equal(savedApplicationChannel('insiders'), 'stable');
  assert.throws(() => applicationChannel('preview'));
  assert.throws(() => applicationChannel('insiders'), /仅支持/);
  assert.throws(() => applicationTarget('insiders'), /仅支持/);
  assert.throws(() => targetForApp('/Applications/Antigravity - Insiders.app'), /仅支持/);
  assert.throws(() => applicationTarget('stable', undefined, { profile: '/tmp/Antigravity - Insiders' }), /仅支持/);
  const stable = applicationTarget('stable', '/synthetic-home');
  assert.equal(stable.bundleId, 'com.google.antigravity');
  assert.equal(stable.profile, '/synthetic-home/Library/Application Support/Antigravity');
  assert.equal(channelStateDirectory('/state', 'stable'), '/state');
  assert.equal(allApplicationTargets().length, 1);
});

test('只发现正式版，不向仅安装的 Insiders 回落；保留正式版 WCV 架构兼容', async t => {
  const appsDir = await temporary(t);
  await mkdir(join(appsDir, 'Antigravity.app', 'Contents', 'Resources'), { recursive: true });
  const onlyStable = detectInstalledChannels('stable', appsDir);
  assert.equal(onlyStable.bothInstalled, false);
  assert.deepEqual(onlyStable.channels, ['stable']);
  assert.equal(onlyStable.effectiveChannel, 'stable');

  await mkdir(join(appsDir, 'Antigravity - Insiders.app', 'Contents', 'Resources'), { recursive: true });
  const both = detectInstalledChannels('stable', appsDir);
  assert.equal(both.bothInstalled, false);
  assert.deepEqual(both.channels, ['stable']);
  assert.equal(both.effectiveChannel, 'stable');

  await rm(join(appsDir, 'Antigravity.app'), { recursive: true, force: true });
  const onlyInsiders = detectInstalledChannels('stable', appsDir);
  assert.equal(onlyInsiders.bothInstalled, false);
  assert.deepEqual(onlyInsiders.channels, []);
  assert.equal(onlyInsiders.effectiveChannel, 'stable');

  // Stable 2.29 uses WCV as well; removing Insiders must not remove this support.
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

test('仅统计正式版会话库，排除 Insiders、备份、IDE 和符号链接', async t => {
  const root = await temporary(t);
  for (const name of ['antigravity', 'antigravity-insiders', 'antigravity-backup', 'antigravity-ide']) {
    await mkdir(join(root, name, 'conversations'), { recursive: true });
    await writeFile(join(root, name, 'conversations', 'same.db'), 'synthetic');
    await writeFile(join(root, name, 'token_usage_archive.db'), 'synthetic');
  }
  await symlink(join(root, 'antigravity-backup', 'conversations', 'same.db'), join(root, 'antigravity-insiders', 'conversations', 'linked.db'));

  // Default discovery must never count Insiders data.
  const unifiedManager = new UsageStatsManager({ geminiDir: root, stateDir: root });
  const unifiedPaths = await unifiedManager.discoverDatabaseFiles();
  assert.deepEqual(
    unifiedPaths.sort(),
    [
      join(root, 'antigravity', 'conversations', 'same.db'),
      join(root, 'antigravity', 'token_usage_archive.db'),
    ].sort(),
  );

  // Explicit single-directory filter still works when specified
  for (const name of ['antigravity']) {
    const manager = new UsageStatsManager({ geminiDir: root, stateDir: root, dataDirectoryName: name });
    const paths = await manager.discoverDatabaseFiles();
    assert.deepEqual(paths.sort(), [join(root, name, 'conversations', 'same.db'), join(root, name, 'token_usage_archive.db')].sort());
  }
});

test('正式版 WCV 无 state.vscdb 时仍支持保存、切号和回滚', async t => {
  const state = await temporary(t);
  const profileDir = await temporary(t);
  const stable = new AccountsManager(state);
  const manager = new AccountsManager(state, { target: applicationTarget('stable') });

  await stable.saveAccount({ ...account, quota: quota('PRO') });
  const fromInsiders = await manager.getAccount(account.id);
  assert.equal(fromInsiders.quota.subscription_tier, 'PRO');

  // Switch account and rollback on stable WCV 2.29+ profile where state.vscdb does NOT exist
  const keychain = new MockKeychainAdapter();
  await keychain.writePassword('gemini', 'antigravity', 'go-keyring-base64:previous-session');
  const switchService = new AccountSwitchService(manager, {
    stateDir: state,
    profile: profileDir,
    externalDir: join(state, 'external'),
    channel: 'stable',
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

  // Re-switch and verify saveCurrentAccount from Keychain in stable mode
  await switchService.switchAccount(account.id);
  const captured = await manager.saveCurrentAccount({
    keychain,
    homeDir: profileDir,
    appSupportDir: profileDir,
  });
  assert.equal(captured.email, account.email);
});

test('旧共享恢复记录原样保留，不能被正式版自动回滚', async t => {
  const state = await temporary(t);
  const manager = new AccountsManager(state);
  const legacyPath = join(state, 'account-switch-journal.json');
  const legacy = JSON.stringify({ version: 1, status: 'complete', at: new Date().toISOString(),
    before: { oauthToken: 'synthetic-old-channel' }, after: {}, files: [],
    keychainBefore: 'synthetic-previous', keychainAfter: 'synthetic-next' });
  await writeFile(legacyPath, legacy);
  const service = new AccountSwitchService(manager, { stateDir: state, profile: state,
    externalDir: join(state, 'external'), keychain: new MockKeychainAdapter(), isRunning: async () => false });
  assert.equal((await service.recoveryInfo()).available, false);
  await assert.rejects(service.rollback(), /ENOENT/);
  assert.equal(await readFile(legacyPath, 'utf8'), legacy);
  await manager.saveAccount(account);
  await service.switchAccount(account.id);
  assert.equal((await service.recoveryInfo()).available, true);
  assert.equal(await readFile(legacyPath, 'utf8'), legacy);
});

test('语言服务只匹配正式版并保留 WCV hub 身份，拒绝 Insiders 进程', () => {
  const target = applicationTarget('stable');
  const version = '2.29.0';
  const command = target.appPath + '/Contents/Resources/bin/language_server --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com --subclient_type hub --override_ide_version ' + version;
  assert.equal(matchingTargetForLanguageServerCommand(command)?.channel, 'stable');
  const context = cloudProviderContextFromCommand(command, version, target);
  assert.equal(cloudProviderContextFromCommand(command + ' --app_data_dir antigravity-insiders', version, target), null);
  assert.equal(context.userAgent, 'antigravity/hub/' + version);
  assert.equal(validCachedCloudProviderContext(context, version, target), true);
  const unsupported = command.replace('Antigravity.app', 'Antigravity - Insiders.app');
  assert.equal(matchingTargetForLanguageServerCommand(unsupported), null);
  assert.equal(cloudProviderContextFromCommand(unsupported, version), null);
});

test('历史 Insiders 配额原样保留但不作为正式版配额展示', async t => {
  const state = await temporary(t);
  const manager = new AccountsManager(state);
  await manager.saveAccount({ ...account, insiders_quota: quota('ULTRA') });
  const loaded = await manager.getAccount(account.id);
  assert.equal(loaded.quota ?? null, null);
  assert.equal(loaded.insiders_quota.subscription_tier, 'ULTRA');
  assert.throws(() => new UsageStatsManager({ stateDir: state, dataDirectoryName: 'antigravity-insiders' }), /仅统计/);
  const usage = new UsageStatsManager({ stateDir: state });
  assert.throws(() => usage.setDataDirectoryName('antigravity-insiders'), /仅统计/);
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

test('IPC 将旧 Insiders 配置备份后迁移到正式版，拒绝通道切换', { timeout: 15000 }, async t => {
  const state = await temporary(t);
  await mkdir(join(state, 'profile'));
  await writeFile(join(state, 'config.json'), JSON.stringify({ applicationChannel: 'insiders', futureSetting: 'preserve' }));
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

  assert.equal(status.status.applicationChannel, 'stable');
  assert.equal(status.status.bothApplicationsInstalled, false);
  const persisted = JSON.parse(await readFile(join(state, 'config.json'), 'utf8'));
  assert.equal(persisted.applicationChannel, 'stable');
  assert.equal(persisted.futureSetting, 'preserve');
  const backup = JSON.parse(await readFile(join(state, 'config-before-stable-only.json'), 'utf8'));
  assert.equal(backup.applicationChannel, 'insiders');
  const rejected = await request(socket, { command: 'set_application_channel', channel: 'insiders' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /仅支持/);
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
