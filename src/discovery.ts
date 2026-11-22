import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readlink, realpath, stat as fsStat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { openAsarArchive } from './asar.js';
import { assertLoopback } from './cdp.js';
import { targetForApp } from './application-target.js';
import { bt } from './i18n.js';
import {
  bundleAsarPath,
  bundleExecutablePath,
  bundleLanguageServerPath,
  bundleProcessPrefix,
  defaultAntigravityAppPath,
  defaultGravityBoxCacheDir,
  isLinux,
  isMacAppBundlePath,
  resolveLsofBinary,
  resolvePsBinary,
} from './platform.js';
const execFileRaw = promisify(execFile);
const execute = (file: string, args: string[], timeout = 3000) => execFileRaw(file, args, { timeout });
export type Endpoint = { port: number; pid: number; browserURL: string; appVersion: string; legacyPatch: boolean; appPath?: string; profile?: string };

export function parseListeners(stdout: string, port: number): { pid: number; names: string[] }[] {
  const results: { pid: number; names: string[] }[] = [];
  let current: { pid: number; names: string[] } | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) { current = { pid: Number(line.slice(1)), names: [] }; results.push(current); }
    if (line.startsWith('n') && current) current.names.push(line.slice(1));
  }
  for (const owner of results) for (const name of owner.names) {
    if (![`127.0.0.1:${port}`, `[::1]:${port}`].includes(name)) throw new Error(bt('discovery.non_loopback'));
  }
  return results.filter(owner => owner.names.length > 0);
}

function parseListenersWithFds(stdout: string, port: number): { pid: number; names: string[]; fds: string[] }[] {
  parseListeners(stdout, port);
  const results: { pid: number; names: string[]; fds: string[] }[] = [];
  let current: { pid: number; names: string[]; fds: string[] } | undefined;
  let pendingFd = '';
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) { current = { pid: Number(line.slice(1)), names: [], fds: [] }; pendingFd = ''; results.push(current); }
    else if (line.startsWith('f') && current) { pendingFd = line.slice(1); }
    else if (line.startsWith('n') && current) { current.names.push(line.slice(1)); if (pendingFd) current.fds.push(pendingFd); }
  }
  return results.filter(owner => owner.names.length > 0);
}

type PersistedBundleEntry = {
  value: { version: string; legacyPatch: boolean };
  verifiedAt: number;
  plistMtimeMs: number;
  plistSize: number;
  asarMtimeMs: number;
  asarSize: number;
  execMtimeMs: number;
  execSize: number;
  codeResMtimeMs: number;
  codeResSize: number;
};

const bundleCache = new Map<string, PersistedBundleEntry & { expiresAt: number; hardExpiresAt: number }>();
const inFlightBundleInspect = new Map<string, Promise<{ version: string; legacyPatch: boolean }>>();
const BUNDLE_DISK_CACHE_PATH = join(defaultGravityBoxCacheDir(), 'bundle-verify-cache-v1.json');
let diskBundleCacheLoaded = false;

async function ensureDiskBundleCacheLoaded(): Promise<void> {
  if (diskBundleCacheLoaded) return;
  diskBundleCacheLoaded = true;
  try {
    const parsed = JSON.parse(await readFile(BUNDLE_DISK_CACHE_PATH, 'utf8'));
    if (!parsed || parsed.schema !== 1 || typeof parsed.entries !== 'object' || !parsed.entries) return;
    const now = Date.now();
    for (const [k, raw] of Object.entries<any>(parsed.entries)) {
      if (
        raw?.value &&
        typeof raw.value.version === 'string' &&
        typeof raw.value.legacyPatch === 'boolean' &&
        typeof raw.verifiedAt === 'number' &&
        now - raw.verifiedAt < 24 * 3600_000
      ) {
        bundleCache.set(k, {
          ...raw,
          expiresAt: 0,
          hardExpiresAt: raw.verifiedAt + 24 * 3600_000,
        });
      }
    }
  } catch {}
}

async function saveDiskBundleCache(): Promise<void> {
  try {
    const entries: Record<string, PersistedBundleEntry> = {};
    for (const [k, entry] of bundleCache.entries()) {
      const { expiresAt: _e, hardExpiresAt: _h, ...persisted } = entry;
      entries[k] = persisted;
    }
    await mkdir(dirname(BUNDLE_DISK_CACHE_PATH), { recursive: true, mode: 0o700 });
    await writeFile(BUNDLE_DISK_CACHE_PATH, JSON.stringify({ schema: 1, entries }) + '\n', { mode: 0o600 });
  } catch {}
}

export async function inspectBundle(appPath: string): Promise<{ version: string; legacyPatch: boolean }> {
  const now = Date.now();
  const memCached = bundleCache.get(appPath);
  if (memCached && memCached.expiresAt > now) return memCached.value;

  const inflight = inFlightBundleInspect.get(appPath);
  if (inflight) return inflight;

  const work = (async () => {
    await ensureDiskBundleCacheLoaded();
    const target = targetForApp(appPath);
    if (!isMacAppBundlePath(appPath)) {
      const asarPath = bundleAsarPath(appPath);
      const execPath = bundleExecutablePath(appPath, target.executable);
      const cached = bundleCache.get(appPath);
      if (cached && cached.hardExpiresAt > Date.now()) {
        try {
          const [aStat, eStat] = await Promise.all([fsStat(asarPath), fsStat(execPath)]);
          if (
            aStat.mtimeMs === cached.asarMtimeMs &&
            aStat.size === cached.asarSize &&
            eStat.mtimeMs === cached.execMtimeMs &&
            eStat.size === cached.execSize
          ) {
            cached.expiresAt = Date.now() + 120_000;
            return cached.value;
          }
        } catch {}
      }
      const [execStat, asarStat] = await Promise.all([fsStat(execPath), fsStat(asarPath)]);
      const archive = await openAsarArchive(asarPath, 16_000_000);
      try {
        let version = '';
        const pkgEntry = archive.header.files?.['package.json'];
        const pkgBuf = pkgEntry ? await archive.readEntryBuffer(pkgEntry, 256_000, 1) : undefined;
        if (pkgBuf) {
          const pkg = JSON.parse(pkgBuf.toString('utf8'));
          const productName = String(pkg?.productName ?? pkg?.name ?? '').trim();
          if (productName && !/antigravity/i.test(productName)) {
            throw new Error(bt('discovery.app_mismatch'));
          }
          if (typeof pkg?.version === 'string') version = pkg.version.trim();
        }
        if (!version) {
          try {
            const verFile = (await readFile(join(appPath, 'version'), 'utf8')).trim();
            if (verFile) version = verFile;
          } catch {}
        }
        let legacyPatch = false;
        for (const name of ['preload.js', 'main.js', 'utils.js']) {
          const entry = archive.header.files?.dist?.files?.[name];
          if (!entry || entry.unpacked) continue;
          const bytes = await archive.readEntryBuffer(entry, 3_000_000, 1);
          if (!bytes) continue;
          const text = bytes.toString();
          legacyPatch ||= /ANTIGRAVITY CHINESE LOCALIZATION START|injectAntigravityI18n|__ANTIGRAVITY_I18N_DATA__|createI18nEngine|__ag_hanhua_engine__/.test(text);
        }
        const val = { version, legacyPatch };
        const completedAt = Date.now();
        bundleCache.set(appPath, {
          value: val,
          verifiedAt: completedAt,
          expiresAt: completedAt + 120_000,
          hardExpiresAt: completedAt + 24 * 3600_000,
          plistMtimeMs: 0,
          plistSize: 0,
          asarMtimeMs: asarStat.mtimeMs,
          asarSize: archive.fileSize,
          execMtimeMs: execStat.mtimeMs,
          execSize: execStat.size,
          codeResMtimeMs: 0,
          codeResSize: 0,
        });
        void saveDiskBundleCache();
        return val;
      } finally {
        await archive.close();
      }
    }

    const plist = join(appPath, 'Contents', 'Info.plist');
    const asarPath = join(appPath, 'Contents', 'Resources', 'app.asar');
    const execPath = join(appPath, 'Contents', 'MacOS', target.executable);
    const codeResPath = join(appPath, 'Contents', '_CodeSignature', 'CodeResources');
    const cached = bundleCache.get(appPath);
    if (cached && cached.hardExpiresAt > Date.now()) {
      try {
        const [pStat, aStat, eStat, cStat] = await Promise.all([
          fsStat(plist),
          fsStat(asarPath),
          fsStat(execPath),
          fsStat(codeResPath),
        ]);
        if (
          pStat.mtimeMs === cached.plistMtimeMs &&
          pStat.size === cached.plistSize &&
          aStat.mtimeMs === cached.asarMtimeMs &&
          aStat.size === cached.asarSize &&
          eStat.mtimeMs === cached.execMtimeMs &&
          eStat.size === cached.execSize &&
          cStat.mtimeMs === cached.codeResMtimeMs &&
          cStat.size === cached.codeResSize
        ) {
          const sig = await execute('/usr/bin/codesign', ['-dv', appPath]);
          if (sig.stderr.includes('TeamIdentifier=EQHXZ8M8AV')) {
            cached.expiresAt = Date.now() + 120_000;
            return cached.value;
          }
        }
      } catch {}
    }

    const id = (await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])).stdout.trim();
    if (id !== target.bundleId) throw new Error(bt('discovery.app_mismatch'));
    const version = (await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])).stdout.trim();
    const signature = await execute('/usr/bin/codesign', ['-dv', appPath]);
    if (!signature.stderr.includes('TeamIdentifier=EQHXZ8M8AV')) throw new Error(bt('discovery.signature_failed'));
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], 8000);
    const [plistStat, execStat, codeResStat] = await Promise.all([
      fsStat(plist),
      fsStat(execPath),
      fsStat(codeResPath),
    ]);
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
      const completedAt = Date.now();
      bundleCache.set(appPath, {
        value: val,
        verifiedAt: completedAt,
        expiresAt: completedAt + 120_000,
        hardExpiresAt: completedAt + 24 * 3600_000,
        plistMtimeMs: plistStat.mtimeMs,
        plistSize: plistStat.size,
        asarMtimeMs: asarStat.mtimeMs,
        asarSize: archive.fileSize,
        execMtimeMs: execStat.mtimeMs,
        execSize: execStat.size,
        codeResMtimeMs: codeResStat.mtimeMs,
        codeResSize: codeResStat.size,
      });
      void saveDiskBundleCache();
      return val;
    } finally {
      await archive.close();
    }
  })().finally(() => {
    inFlightBundleInspect.delete(appPath);
  });

  inFlightBundleInspect.set(appPath, work);
  return work;
}

async function resolveProcessExecutablePath(pid: number): Promise<string | null> {
  if (isLinux) {
    try {
      const exe = await readlink(`/proc/${pid}/exe`);
      return exe.replace(/ \(deleted\)$/, '');
    } catch {}
  }
  return null;
}

async function resolveVerifiedSocketOwner(
  owners: { pid: number; names: string[]; fds?: string[] }[],
  matchesExecutable: (pid: number) => Promise<boolean>,
): Promise<{ pid: number; names: string[] } | undefined> {
  if (owners.length === 0) return undefined;
  if (owners.length === 1) {
    const only = owners[0]!;
    return (await matchesExecutable(only.pid)) ? only : undefined;
  }
  if (!isLinux) return undefined;
  // On Linux, child processes may inherit an open listening socket fd when FD_CLOEXEC is unset.
  // Verify all live holders reference the exact same kernel socket inode (rejecting SO_REUSEPORT spoofing),
  // then select the matching application process with the lowest PID (the owning parent).
  const inodes = new Set<string>();
  const matchedOwners: { pid: number; names: string[] }[] = [];
  for (const owner of owners) {
    const fds = owner.fds ?? [];
    for (const fd of fds) {
      if (!/^\d+$/.test(fd)) continue;
      const target = await readlink(`/proc/${owner.pid}/fd/${fd}`).catch(() => null);
      if (target && target.startsWith('socket:[')) {
        inodes.add(target);
      }
    }
    if (await matchesExecutable(owner.pid)) {
      matchedOwners.push(owner);
    }
  }
  if (inodes.size !== 1 || matchedOwners.length === 0) return undefined;
  matchedOwners.sort((a, b) => a.pid - b.pid);
  return matchedOwners[0];
}

async function discoverSingle(appPath: string, profile: string): Promise<Endpoint | undefined> {
  let contents: string;
  try { contents = await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return undefined; }
  const port = Number(contents.split('\n')[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  let listeners: string;
  try { listeners = (await execute(resolveLsofBinary(), ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpfn'])).stdout; } catch { return undefined; }
  const owners = parseListenersWithFds(listeners, port);
  const expected = bundleExecutablePath(appPath, targetForApp(appPath).executable);
  const expectedReal = await realpath(expected).catch(() => expected);
  const owner = await resolveVerifiedSocketOwner(owners, async (pid) => {
    const linuxExe = await resolveProcessExecutablePath(pid);
    if (linuxExe) {
      const linuxExeReal = await realpath(linuxExe).catch(() => linuxExe);
      return linuxExe === expected || linuxExeReal === expectedReal;
    }
    let executable: string;
    try { executable = (await execute(resolveLsofBinary(), ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-Fn'])).stdout; } catch { return false; }
    const lines = executable.split('\n');
    return lines.includes(`n${expected}`) || lines.includes(`n${expectedReal}`);
  });
  if (!owner) return undefined;
  const bundle = await inspectBundle(appPath);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  } catch { return undefined; }
  if (!response.ok) return undefined;
  const version = await response.json() as Record<string, string>;
  if (!version.webSocketDebuggerUrl) return undefined;
  const ws = assertLoopback(version.webSocketDebuggerUrl);
  if (Number(ws.port) !== port) throw new Error(bt('discovery.port_mismatch'));
  return { port, pid: owner.pid, browserURL: ws.href, appVersion: bundle.version, legacyPatch: bundle.legacyPatch, appPath, profile };
}

export async function discover(appPath: string, profile: string): Promise<Endpoint | undefined> {
  return discoverSingle(appPath, profile);
}

/** Read-only check whether the stable desktop application main process is currently running. */
export async function isApplicationRunning(appPath: string): Promise<boolean> {
  if (!appPath) return false;
  let target: ReturnType<typeof targetForApp>;
  try {
    target = targetForApp(appPath);
  } catch {
    return false;
  }
  const expectedExecutable = bundleExecutablePath(appPath, target.executable);
  try {
    if (isLinux) {
      const { stdout } = await execute(resolvePsBinary(), ['-ax', '-ww', '-o', 'args='], 2000);
      return stdout.split('\n').some(line => {
        const trimmed = line.trim();
        return trimmed === expectedExecutable || trimmed.startsWith(`${expectedExecutable} `);
      });
    }
    const { stdout } = await execute(resolvePsBinary(), ['-ax', '-ww', '-o', 'comm='], 2000);
    return stdout.split('\n').some(line => line.trim() === expectedExecutable);
  } catch {
    return false;
  }
}

export function allowedTarget(target: { type: string; url: string }, fixtureOrigin?: string): boolean {
  if (target.type !== 'page') return false;
  try {
    const url = new URL(target.url);
    if (fixtureOrigin) return url.origin === fixtureOrigin && url.pathname === '/fixture';
    const blockedPaths = /^\/(?:api|oauth|login|browser|preview)(?:\/|$)/i;
    const pathAllowed = !blockedPaths.test(url.pathname) && (
      url.pathname === '/' ||
      /^\/(?:history|sidecars|customizations|automations|settings|settings-standalone|terminal-standalone|new-project|multi|artifact|s|chatski-connect)(?:\/.*)?$/i.test(url.pathname) ||
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
    const lsof = resolveLsofBinary();
    const listeners = (await execute(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpfn'])).stdout;
    const owners = parseListenersWithFds(listeners, port);
    const expectedLs = bundleLanguageServerPath(appPath);
    const expectedPrefix = bundleProcessPrefix(appPath);
    const owner = await resolveVerifiedSocketOwner(owners, async (pid) => {
      const linuxExe = await resolveProcessExecutablePath(pid);
      if (linuxExe) {
        return linuxExe === expectedLs || linuxExe.startsWith(expectedPrefix);
      }
      const executable = (await execute(lsof, ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-Fn'])).stdout;
      const lines = executable.split('\n');
      return lines.some(line => {
        if (!line.startsWith('n')) return false;
        const binPath = line.slice(1);
        return binPath === expectedLs || binPath.startsWith(expectedPrefix);
      });
    });
    const valid = Boolean(owner);
    if (valid) verifiedPortCache.set(cacheKey, { valid: true, expiresAt: now + 60_000 });
    else verifiedPortCache.delete(cacheKey);
    return valid;
  } catch {
    verifiedPortCache.delete(cacheKey);
    return false;
  }
}

const verifiedLsPidPortsCache = new Map<string, { ports: number[]; expiresAt: number }>();

/** Verify the real executable and official bundle before trusting a language-server listener, returning verified loopback IPv4 ports. */
export async function resolveVerifiedLanguageServerPorts(pid: number, appPath = defaultAntigravityAppPath()): Promise<number[] | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const cacheKey = `${pid}:${appPath}`;
  const now = Date.now();
  const cachedPorts = verifiedLsPidPortsCache.get(cacheKey);
  if (cachedPorts && cachedPorts.expiresAt > now) {
    try {
      process.kill(pid, 0);
      return cachedPorts.ports;
    } catch {
      verifiedLsPidPortsCache.delete(cacheKey);
      return null;
    }
  }
  try {
    await inspectBundle(appPath);
    const lsof = resolveLsofBinary();
    const expectedLs = bundleLanguageServerPath(appPath);
    const linuxExe = await resolveProcessExecutablePath(pid);
    let listenerOut = '';
    if (linuxExe) {
      const expectedReal = await realpath(expectedLs).catch(() => expectedLs);
      const linuxExeReal = await realpath(linuxExe).catch(() => linuxExe);
      if (linuxExe !== expectedLs && linuxExeReal !== expectedReal) return null;
      const listenerRes = await execute(lsof, ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn']);
      listenerOut = listenerRes.stdout;
    } else {
      const [execRes, listenerRes] = await Promise.all([
        execute(lsof, ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-Fn']),
        execute(lsof, ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn']),
      ]);
      if (!execRes.stdout.split('\n').includes('n' + expectedLs)) return null;
      listenerOut = listenerRes.stdout;
    }
    const listeners = listenerOut.split('\n').filter(line => line.startsWith('n'));
    if (listeners.length === 0 || !listeners.every(line => /^n(?:127\.0\.0\.1|\[::1\]):\d+$/.test(line))) return null;
    const portMatches = Array.from(listenerOut.matchAll(/n127\.0\.0\.1:(\d+)/g)).map(m => parseInt(m[1]!, 10));
    const ports = Array.from(new Set(portMatches));
    if (ports.length > 0) {
      verifiedLsPidPortsCache.set(cacheKey, { ports, expiresAt: Date.now() + 15_000 });
    }
    return ports;
  } catch {
    return null;
  }
}


