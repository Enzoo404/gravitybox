import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';
import { openAsarArchive } from './asar.js';
import { assertLoopback } from './cdp.js';
import { targetForApp } from './application-target.js';
const execute = promisify(execFile);
export type Endpoint = { port: number; pid: number; browserURL: string; appVersion: string; legacyPatch: boolean; appPath?: string; profile?: string };

export function parseListeners(stdout: string, port: number): { pid: number; names: string[] }[] {
  const results: { pid: number; names: string[] }[] = [];
  let current: { pid: number; names: string[] } | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) { current = { pid: Number(line.slice(1)), names: [] }; results.push(current); }
    if (line.startsWith('n') && current) current.names.push(line.slice(1));
  }
  for (const owner of results) for (const name of owner.names) {
    if (![`127.0.0.1:${port}`, `[::1]:${port}`].includes(name)) throw new Error('调试接口存在非回环监听，已停止连接');
  }
  return results.filter(owner => owner.names.length > 0);
}

const bundleCache = new Map<string, { value: { version: string; legacyPatch: boolean }; expiresAt: number; hardExpiresAt: number; plistMtimeMs: number; asarMtimeMs: number; asarSize: number }>();

export async function inspectBundle(appPath: string): Promise<{ version: string; legacyPatch: boolean }> {
  const now = Date.now();
  const cached = bundleCache.get(appPath);
  if (cached && cached.expiresAt > now) return cached.value;

  const plist = join(appPath, 'Contents', 'Info.plist');
  const asarPath = join(appPath, 'Contents', 'Resources', 'app.asar');
  if (cached && cached.hardExpiresAt > now) {
    try {
      const [pStat, aStat] = await Promise.all([fsStat(plist), fsStat(asarPath)]);
      if (pStat.mtimeMs === cached.plistMtimeMs && aStat.mtimeMs === cached.asarMtimeMs && aStat.size === cached.asarSize) {
        cached.expiresAt = now + 60_000;
        return cached.value;
      }
    } catch {}
  }

  const id = (await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])).stdout.trim();
  if (id !== targetForApp(appPath).bundleId) throw new Error('应用身份不匹配');
  const version = (await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])).stdout.trim();
  const signature = await execute('/usr/bin/codesign', ['-dv', appPath]);
  if (!signature.stderr.includes('TeamIdentifier=EQHXZ8M8AV')) throw new Error('Antigravity 签名身份未通过 Google TeamID 检查');
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  const plistStat = await fsStat(plist);
  const archive = await openAsarArchive(asarPath, 16_000_000);
  try {
    let legacyPatch = false;
    for (const name of ['preload.js', 'main.js', 'utils.js']) {
      const entry = archive.header.files?.dist?.files?.[name];
      if (!entry || entry.unpacked) continue;
      const bytes = await archive.readEntryBuffer(entry, 3_000_000, 1);
      if (!bytes) continue;
      const text = bytes.toString();
      legacyPatch ||= /ANTIGRAVITY CHINESE LOCALIZATION START|injectAntigravityI18n|__ANTIGRAVITY_I18N_DATA__|createI18nEngine|__ag_hanhua_engine__/.test(text);
    }
    const asarStat = await fsStat(asarPath);
    const val = { version, legacyPatch };
    bundleCache.set(appPath, { value: val, expiresAt: now + 60_000, hardExpiresAt: now + 600_000, plistMtimeMs: plistStat.mtimeMs, asarMtimeMs: asarStat.mtimeMs, asarSize: archive.fileSize });
    return val;
  } finally {
    await archive.close();
  }
}

async function discoverSingle(appPath: string, profile: string): Promise<Endpoint | undefined> {
  let contents: string;
  try { contents = await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return undefined; }
  const port = Number(contents.split('\n')[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  let listeners: string;
  try { listeners = (await execute('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpfn'])).stdout; } catch { return undefined; }
  const owners = parseListeners(listeners, port);
  if (owners.length !== 1) return undefined;
  const owner = owners[0]!;
  let executable: string;
  try { executable = (await execute('/usr/sbin/lsof', ['-nP', '-a', '-p', String(owner.pid), '-d', 'txt', '-Fn'])).stdout; } catch { return undefined; }
  const expected = join(appPath, 'Contents', 'MacOS', targetForApp(appPath).executable);
  if (!executable.split('\n').includes(`n${expected}`)) return undefined;
  const bundle = await inspectBundle(appPath);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  } catch { return undefined; }
  if (!response.ok) return undefined;
  const version = await response.json() as Record<string, string>;
  if (!version.webSocketDebuggerUrl) return undefined;
  const ws = assertLoopback(version.webSocketDebuggerUrl);
  if (Number(ws.port) !== port) throw new Error('调试接口端口不匹配');
  return { port, pid: owner.pid, browserURL: ws.href, appVersion: bundle.version, legacyPatch: bundle.legacyPatch, appPath, profile };
}

export async function discover(appPath: string, profile: string): Promise<Endpoint | undefined> {
  return discoverSingle(appPath, profile);
}

export function allowedTarget(target: { type: string; url: string }, fixtureOrigin?: string): boolean {
  if (target.type !== 'page') return false;
  try {
    const url = new URL(target.url);
    if (fixtureOrigin) return url.origin === fixtureOrigin && url.pathname === '/fixture';
    const blockedPaths = /^\/(?:api|oauth|login|browser|preview)(?:\/|$)/i;
    const pathAllowed = !blockedPaths.test(url.pathname) && (
      url.pathname === '/' ||
      /^\/(?:history|sidecars|customizations|automations|settings|settings-standalone|terminal-standalone|new-project|onboarding|multi|artifact|s|chatski-connect)(?:\/.*)?$/i.test(url.pathname) ||
      /^\/c(?:\/|\/(?:[0-9a-f-]{36}|_new)(?:\/.*)?)?$/i.test(url.pathname) ||
      /^\/(?:forked|view|battle)\/.*$/i.test(url.pathname)
    );
    return url.protocol === 'https:' && url.hostname === '127.0.0.1' && !!url.port && pathAllowed && !url.username && !url.password;
  } catch { return false; }
}

const verifiedPortCache = new Map<string, { valid: boolean; expiresAt: number }>();

export async function verifyPageService(url: string, appPath: string): Promise<boolean> {
  if (!allowedTarget({ type: 'page', url })) return false;
  const port = Number(new URL(url).port);
  const cacheKey = `${appPath}:${port}`;
  const now = Date.now();
  const cached = verifiedPortCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.valid;

  try {
    const listeners = (await execute('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpfn'])).stdout;
    const owners = parseListeners(listeners, port);
    if (owners.length !== 1) {
      verifiedPortCache.delete(cacheKey);
      return false;
    }
    const executable = (await execute('/usr/sbin/lsof', ['-nP', '-a', '-p', String(owners[0]!.pid), '-d', 'txt', '-Fn'])).stdout;
    const lines = executable.split('\n');
    const valid = lines.some(line => {
      if (!line.startsWith('n')) return false;
      const binPath = line.slice(1);
      return binPath === join(appPath, 'Contents', 'Resources', 'bin', 'language_server') ||
        binPath.startsWith(appPath + '/Contents/');
    });
    if (valid) verifiedPortCache.set(cacheKey, { valid: true, expiresAt: now + 60_000 });
    else verifiedPortCache.delete(cacheKey);
    return valid;
  } catch {
    verifiedPortCache.delete(cacheKey);
    return false;
  }
}

/** Verify the real executable and official bundle before trusting a language-server listener. */
export async function verifyLanguageServerIdentity(pid: number, appPath = '/Applications/Antigravity.app'): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    await inspectBundle(appPath);
    const executable = (await execute('/usr/sbin/lsof', ['-nP','-a','-p',String(pid),'-d','txt','-Fn'])).stdout;
    if (!executable.split('\n').includes('n'+join(appPath,'Contents/Resources/bin/language_server'))) return false;
    const listeners = (await execute('/usr/sbin/lsof',['-nP','-a','-p',String(pid),'-iTCP','-sTCP:LISTEN','-Fn'])).stdout.split('\n').filter(line=>line.startsWith('n'));
    return listeners.length > 0 && listeners.every(line=>/^n(?:127\.0\.0\.1|\[::1\]):\d+$/.test(line));
  } catch { return false; }
}
