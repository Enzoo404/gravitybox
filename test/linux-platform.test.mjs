import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundleAsarPath,
  bundleExecutablePath,
  bundleLanguageServerPath,
  bundleProcessPrefix,
  defaultAppSupportDir,
  defaultGravityBoxCacheDir,
  defaultGravityBoxStateDir,
  isMacAppBundlePath,
  resolveLsofBinary,
  resolvePsBinary,
} from '../dist/platform.js';
import { targetForApp, matchingTargetForLanguageServerCommand } from '../dist/application-target.js';
import {
  cloudOriginFromCommand,
  collectLanguageServerCandidates,
  extractCsrfTokenFromProcEnviron,
} from '../dist/account-probe.js';
import { DatabaseTransaction } from '../dist/account-switch.js';
import { LinuxSecretServiceKeychainAdapter } from '../dist/account-keychain.js';
import {
  buildDebianControl,
  buildDesktopEntry,
  buildLauncherScript,
  resolveDebianArch,
} from '../tools/package-deb.mjs';
import { execSqlite, querySqliteJson } from './sqlite-helper.mjs';

const execFileAsync = promisify(execFile);

test('platform helpers: macOS .app bundle vs Linux Electron directory layout', () => {
  assert.equal(isMacAppBundlePath('/Applications/Antigravity.app'), true);
  assert.equal(isMacAppBundlePath('/usr/share/antigravity'), false);

  assert.equal(bundleAsarPath('/Applications/Antigravity.app'), '/Applications/Antigravity.app/Contents/Resources/app.asar');
  assert.equal(bundleAsarPath('/usr/share/antigravity'), '/usr/share/antigravity/resources/app.asar');

  assert.equal(bundleExecutablePath('/Applications/Antigravity.app', 'Antigravity'), '/Applications/Antigravity.app/Contents/MacOS/Antigravity');
  assert.equal(bundleExecutablePath('/usr/share/antigravity', 'Antigravity'), '/usr/share/antigravity/antigravity');

  assert.equal(bundleLanguageServerPath('/Applications/Antigravity.app'), '/Applications/Antigravity.app/Contents/Resources/bin/language_server');
  assert.equal(bundleLanguageServerPath('/usr/share/antigravity'), '/usr/share/antigravity/resources/bin/language_server');

  assert.equal(bundleProcessPrefix('/Applications/Antigravity.app'), '/Applications/Antigravity.app/Contents/');
  assert.equal(bundleProcessPrefix('/usr/share/antigravity'), '/usr/share/antigravity/');

  assert.ok(resolveLsofBinary().length > 0);
  assert.ok(resolvePsBinary().length > 0);

  if (process.platform === 'linux') {
    assert.equal(defaultGravityBoxStateDir('/home/test'), '/home/test/.local/share/GravityBox');
    assert.equal(defaultGravityBoxCacheDir('/home/test'), '/home/test/.cache/GravityBox');
    assert.equal(defaultAppSupportDir('/home/test'), '/home/test/.config');
  }
});

test('Linux language_server matching & /proc/<pid>/environ CSRF extraction', () => {
  const linuxTarget = targetForApp('/opt/antigravity', '/home/test');
  const lsCmd = '/opt/antigravity/resources/bin/language_server --app_data_dir antigravity --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com --override_ide_version 2.34.0';
  const matched = matchingTargetForLanguageServerCommand(lsCmd, linuxTarget, '/home/test');
  assert.ok(matched);
  assert.equal(matched.appPath, '/opt/antigravity');

  assert.equal(cloudOriginFromCommand(lsCmd, linuxTarget), 'https://daily-cloudcode-pa.googleapis.com');
  const candidates = collectLanguageServerCandidates(`4242 ${lsCmd}\n9999 /usr/bin/sleep 10\n`, linuxTarget);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].pid, 4242);

  const rawEnv = Buffer.from(
    'PATH=/usr/bin:/bin\0ANTIGRAVITY_CSRF_TOKEN=wrong-sidecar\0ANTIGRAVITY_SERVER_CSRF_TOKEN=linux-proc-csrf-2340\0HOME=/home/test\0',
    'utf8',
  );
  assert.equal(extractCsrfTokenFromProcEnviron(rawEnv), 'linux-proc-csrf-2340');
  assert.equal(extractCsrfTokenFromProcEnviron(Buffer.from('PATH=/usr/bin\0HOME=/home/test\0')), null);
});

test('DatabaseTransaction supports commit and rollback via Node 22 node:sqlite', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-linux-dbtx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'state.vscdb');
  execSqlite(dbPath, "CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT); INSERT INTO ItemTable VALUES('antigravityOnboarding','false'),('keep','yes');");

  // Rollback path
  const tx1 = new DatabaseTransaction(dbPath);
  await tx1.begin();
  const before = await tx1.rows();
  assert.equal(before.antigravityOnboarding, 'false');
  await tx1.replace({ antigravityOnboarding: 'true' });
  await tx1.finish(false);
  await tx1.close();
  const afterRollback = querySqliteJson(dbPath, 'SELECT key, value FROM ItemTable ORDER BY key;');
  assert.deepEqual(afterRollback, [
    { key: 'antigravityOnboarding', value: 'false' },
    { key: 'keep', value: 'yes' },
  ]);

  // Commit path
  const tx2 = new DatabaseTransaction(dbPath);
  await tx2.begin();
  await tx2.replace({ antigravityOnboarding: 'true' });
  await tx2.finish(true);
  await tx2.close();
  const afterCommit = querySqliteJson(dbPath, 'SELECT key, value FROM ItemTable ORDER BY key;');
  assert.deepEqual(afterCommit, [
    { key: 'antigravityOnboarding', value: 'true' },
    { key: 'keep', value: 'yes' },
  ]);
});

test('Debian packaging metadata helpers generate policy-compliant control, desktop, and launcher', () => {
  assert.equal(resolveDebianArch('x64'), 'amd64');
  assert.equal(resolveDebianArch('arm64'), 'arm64');
  assert.throws(() => resolveDebianArch('ia32'));

  const control = buildDebianControl({ version: '1.1.3', arch: 'amd64', installedSizeKb: 42000 });
  assert.match(control, /^Package: gravitybox$/m);
  assert.match(control, /^Version: 1\.1\.3$/m);
  assert.match(control, /^Architecture: amd64$/m);
  assert.match(control, /python3-pyqt5/);
  assert.match(control, /gir1\.2-secret-1/);

  const desktop = buildDesktopEntry();
  assert.match(desktop, /^\[Desktop Entry\]$/m);
  assert.match(desktop, /^Exec=\/usr\/bin\/gravitybox %U$/m);
  assert.match(desktop, /^Icon=gravitybox$/m);

  const launcher = buildLauncherScript();
  assert.match(launcher, /--backend-only/);
  assert.match(launcher, /python3 -m gravitybox/);
});

test('Linux Secret Service keychain round-trip on isolated test entry', { skip: process.platform !== 'linux' }, async () => {
  const adapter = new LinuxSecretServiceKeychainAdapter();
  const testService = 'gravitybox-unit-test-only';
  const testAccount = `synthetic-${process.pid}`;
  const testPayload = 'go-keyring-base64:c3ludGhldGljLXRlc3Q=';
  try {
    await adapter.writePassword(testService, testAccount, testPayload);
    const readBack = await adapter.readPassword(testService, testAccount);
    assert.equal(readBack, testPayload);
  } catch (err) {
    // Headless CI containers without a running D-Bus Secret Service daemon are allowed to skip.
    if (!process.env.DBUS_SESSION_BUS_ADDRESS) return;
    throw err;
  } finally {
    await adapter.deletePassword(testService, testAccount).catch(() => {});
  }
  const afterDelete = await adapter.readPassword(testService, testAccount).catch(() => null);
  assert.equal(afterDelete, null);
});

test('Linux PyQt5 frontend Python modules pass import and l10n checks', { skip: process.platform !== 'linux' }, async () => {
  const script = `
import sys
from pathlib import Path
sys.path.insert(0, 'linux')
from gravitybox.l10n import L10n
from gravitybox.paths import resolve_resource_root, read_app_version
from gravitybox.theme import LIGHT, DARK, build_stylesheet
from gravitybox.widgets import format_tokens, format_usd, format_bytes

root = resolve_resource_root()
assert read_app_version(root) == '1.1.3'
zh = L10n(root, 'zh-Hans')
en = L10n(root, 'en')
assert zh.is_zh and not en.is_zh
assert zh.bi('总览', 'Overview') == '总览'
assert en.bi('总览', 'Overview') == 'Overview'
assert format_tokens(1500000) == '1.50M'
assert format_usd(1.25) == '$1.25'
assert format_bytes(2048) == '2.0 KB'
assert 'QMainWindow' in build_stylesheet(LIGHT)
assert 'QMainWindow' in build_stylesheet(DARK)
print('LINUX_PY_OK')
`;
  const { stdout } = await execFileAsync('/usr/bin/python3', ['-c', script], { timeout: 10000 });
  assert.match(stdout, /LINUX_PY_OK/);
});
