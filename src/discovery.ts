import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { assertLoopback } from './cdp.js';
import { allApplicationTargets, targetForApp } from './application-target.js';
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

const bundleCache = new Map<string, { value: { version: string; legacyPatch: boolean }; expiresAt: number }>();

export async function inspectBundle(appPath: string): Promise<{ version: string; legacyPatch: boolean }> {
  const now = Date.now();
  const cached = bundleCache.get(appPath);
  if (cached && cached.expiresAt > now) return cached.value;

  const plist = join(appPath, 'Contents', 'Info.plist');
  const id = (await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])).stdout.trim();
  if (id !== targetForApp(appPath).bundleId) throw new Error('应用身份不匹配');
  const version = (await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])).stdout.trim();
  const signature = await execute('/usr/bin/codesign', ['-dv', appPath]);
  if (!signature.stderr.includes('TeamIdentifier=EQHXZ8M8AV')) throw new Error('Antigravity 签名身份未通过 Google TeamID 检查');
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  const file = await open(join(appPath, 'Contents', 'Resources', 'app.asar'), 'r');
  try {
    const prefix = Buffer.alloc(16); await file.read(prefix, 0, 16, 0);
    const headerLength = prefix.readUInt32LE(12);
    if (headerLength > 16_000_000) throw new Error('应用资源头超出限制');
    const headerBytes = Buffer.alloc(headerLength); await file.read(headerBytes, 0, headerLength, 16);
    const header = JSON.parse(headerBytes.toString());
    let legacyPatch = false;
    const stat = await file.stat();
    for (const name of ['preload.js', 'main.js', 'utils.js']) {
      const entry = header.files?.dist?.files?.[name];
      if (!entry || entry.unpacked) continue;
      const size = Number(entry.size), offset = Number(entry.offset);
      if (!Number.isSafeInteger(size) || size <= 0 || size > 3_000_000) throw new Error('应用脚本超出检查范围');
      if (!Number.isSafeInteger(offset) || offset < 0 || 8 + prefix.readUInt32LE(4) + offset + size > stat.size) throw new Error('应用资源位置无效');
      const bytes = Buffer.alloc(size);
      const { bytesRead } = await file.read(bytes, 0, size, 8 + prefix.readUInt32LE(4) + offset);
      if (bytesRead !== size) throw new Error('应用脚本读取不完整');
      const text = bytes.toString();
      legacyPatch ||= /ANTIGRAVITY CHINESE LOCALIZATION START|injectAntigravityI18n|__ANTIGRAVITY_I18N_DATA__|createI18nEngine|__ag_hanhua_engine__/.test(text);
    }
    const val = { version, legacyPatch };
    bundleCache.set(appPath, { value: val, expiresAt: now + 60_000 });
    return val;
  } finally { await file.close(); }
}

async function discoverSingle(appPath: string, profile: string): Promise<Endpoint | undefined> {
  let contents: string;
  try { contents = await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return undefined; }
  const port = Number(contents.split('\n')[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  let listeners: string;
  try { listeners = (await execute('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpfn'])).stdout; } catch { return undefined; }
  const owners = parseListeners(listeners, port);
  if (owners.length !== 1) throw new Error('调试端口进程身份无法唯一确认');
  const owner = owners[0]!;
  const executable = (await execute('/usr/sbin/lsof', ['-nP', '-a', '-p', String(owner.pid), '-d', 'txt', '-Fn'])).stdout;
  const expected = join(appPath, 'Contents', 'MacOS', targetForApp(appPath).executable);
  if (!executable.split('\n').includes(`n${expected}`)) throw new Error('调试端口不属于指定 Antigravity 应用');
  const bundle = await inspectBundle(appPath);
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  if (!response.ok) throw new Error('调试接口无响应');
  const version = await response.json() as Record<string, string>;
  if (!version.webSocketDebuggerUrl) throw new Error('调试接口缺少 WebSocket 地址');
  const ws = assertLoopback(version.webSocketDebuggerUrl);
  if (Number(ws.port) !== port) throw new Error('调试接口端口不匹配');
  return { port, pid: owner.pid, browserURL: ws.href, appVersion: bundle.version, legacyPatch: bundle.legacyPatch, appPath, profile };
}

export async function discover(appPath: string, profile: string): Promise<Endpoint | undefined> {
  const primary = await discoverSingle(appPath, profile);
  if (primary) return primary;
  const knownTargets = allApplicationTargets();
  const isDefaultTarget = knownTargets.some(t => t.appPath === appPath && t.profile === profile);
  if (!isDefaultTarget) return undefined;
  for (const candidate of knownTargets) {
    if (candidate.appPath === appPath && candidate.profile === profile) continue;
    try {
      const found = await discoverSingle(candidate.appPath, candidate.profile);
      if (found) return found;
    } catch {}
  }
  return undefined;
}

export function allowedTarget(target: { type: string; url: string }, fixtureOrigin?: string): boolean {
  if (target.type !== 'page') return false;
  try {
    const url = new URL(target.url);
    if (fixtureOrigin) return url.origin === fixtureOrigin && url.pathname === '/fixture';
    const blockedPaths = /^\/(?:api|oauth|login|browser|preview)(?:\/|$)/i;
    const pathAllowed = !blockedPaths.test(url.pathname) && (
      url.pathname === '/' ||
      /^\/(?:history|sidecars|customizations|settings|settings-standalone|terminal-standalone|new-project|onboarding|multi|artifact|s)(?:\/.*)?$/i.test(url.pathname) ||
      /^\/c\/[0-9a-f-]{36}$/i.test(url.pathname) ||
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
      verifiedPortCache.set(cacheKey, { valid: false, expiresAt: now + 10_000 });
      return false;
    }
    const executable = (await execute('/usr/sbin/lsof', ['-nP', '-a', '-p', String(owners[0]!.pid), '-d', 'txt', '-Fn'])).stdout;
    const lines = executable.split('\n');
    const candidateApps = allApplicationTargets().some(t => t.appPath === appPath)
      ? allApplicationTargets().map(t => t.appPath)
      : [appPath];
    const valid = lines.some(line => {
      if (!line.startsWith('n')) return false;
      const binPath = line.slice(1);
      return candidateApps.some(candidateApp =>
        binPath === join(candidateApp, 'Contents', 'Resources', 'bin', 'language_server') ||
        binPath.startsWith(candidateApp + '/Contents/')
      );
    });
    verifiedPortCache.set(cacheKey, { valid, expiresAt: now + 60_000 });
    return valid;
  } catch {
    verifiedPortCache.set(cacheKey, { valid: false, expiresAt: now + 10_000 });
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
