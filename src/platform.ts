import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const isMacOS = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

/** Resolve GravityBox persistent data directory (`~/Library/Application Support/GravityBox` on macOS, XDG data dir on Linux). */
export function defaultGravityBoxStateDir(home = homedir()): string {
  if (isLinux) {
    const xdgData = process.env.XDG_DATA_HOME?.trim();
    if (xdgData && home === homedir()) return join(xdgData, 'GravityBox');
    return join(home, '.local', 'share', 'GravityBox');
  }
  return join(home, 'Library', 'Application Support', 'GravityBox');
}

/** Resolve GravityBox cache directory (`~/Library/Caches/GravityBox` on macOS, XDG cache dir on Linux). */
export function defaultGravityBoxCacheDir(home = homedir()): string {
  if (isLinux) {
    const xdgCache = process.env.XDG_CACHE_HOME?.trim();
    if (xdgCache && home === homedir()) return join(xdgCache, 'GravityBox');
    return join(home, '.cache', 'GravityBox');
  }
  return join(home, 'Library', 'Caches', 'GravityBox');
}

/** Resolve GravityBox log directory (`~/Library/Logs/GravityBox` on macOS, XDG state dir on Linux). */
export function defaultGravityBoxLogDir(home = homedir()): string {
  if (isLinux) {
    const xdgState = process.env.XDG_STATE_HOME?.trim();
    if (xdgState && home === homedir()) return join(xdgState, 'GravityBox', 'logs');
    return join(home, '.local', 'state', 'GravityBox', 'logs');
  }
  return join(home, 'Library', 'Logs', 'GravityBox');
}

/** Resolve host application config/support root (`~/Library/Application Support` on macOS, `~/.config` on Linux). */
export function defaultAppSupportDir(home = homedir()): string {
  if (isLinux) {
    const xdgConfig = process.env.XDG_CONFIG_HOME?.trim();
    if (xdgConfig && home === homedir()) return xdgConfig;
    return join(home, '.config');
  }
  return join(home, 'Library', 'Application Support');
}

/** Resolve user trash files directory (`~/.Trash` on macOS, XDG Trash files dir on Linux). */
export function defaultTrashDir(home = homedir()): string {
  if (isLinux) {
    const xdgData = process.env.XDG_DATA_HOME?.trim();
    if (xdgData && home === homedir()) return join(xdgData, 'Trash', 'files');
    return join(home, '.local', 'share', 'Trash', 'files');
  }
  return join(home, '.Trash');
}

/** Candidate Linux Antigravity installation directories in priority order. */
export function linuxAntigravityAppCandidates(home = homedir()): string[] {
  const candidates: string[] = [];
  const envPath = process.env.GRAVITYBOX_APP_PATH?.trim();
  if (envPath) candidates.push(envPath);
  candidates.push(
    join(home, '.local', 'share', 'antigravity'),
    '/usr/share/antigravity',
    '/opt/Antigravity',
    '/opt/antigravity',
    '/usr/lib/antigravity',
  );
  return Array.from(new Set(candidates));
}

/** Default Antigravity application bundle/directory path for the current platform. */
export function defaultAntigravityAppPath(home = homedir(), applicationsDir?: string): string {
  if (applicationsDir) {
    if (isLinux && !applicationsDir.startsWith('/Applications')) {
      const candidate = join(applicationsDir, 'antigravity');
      if (existsSync(candidate)) return candidate;
    }
    if (!isLinux || applicationsDir === '/Applications') {
      if (!isLinux) return join(applicationsDir, 'Antigravity.app');
      if (existsSync(join(applicationsDir, 'Antigravity.app'))) return join(applicationsDir, 'Antigravity.app');
    }
  }
  if (isLinux) {
    for (const candidate of linuxAntigravityAppCandidates(home)) {
      if (existsSync(join(candidate, 'resources', 'app.asar'))) return candidate;
    }
    return linuxAntigravityAppCandidates(home)[0]!;
  }
  return join(applicationsDir ?? '/Applications', 'Antigravity.app');
}

/** True if `appPath` uses macOS `.app` bundle layout (`Contents/Resources/app.asar`). */
export function isMacAppBundlePath(appPath: string): boolean {
  return appPath.endsWith('.app')
    || existsSync(join(appPath, 'Contents', 'Info.plist'))
    || existsSync(join(appPath, 'Contents', 'Resources'));
}

/** Path to bundle resources directory (`Contents/Resources` on macOS, `resources` on Linux). */
export function bundleResourcesDir(appPath: string): string {
  if (isMacAppBundlePath(appPath)) return join(appPath, 'Contents', 'Resources');
  return join(appPath, 'resources');
}

/** Path to `app.asar` inside either a macOS `.app` bundle or a Linux Electron directory. */
export function bundleAsarPath(appPath: string): string {
  return join(bundleResourcesDir(appPath), 'app.asar');
}

/** Path to main Antigravity desktop executable inside `appPath`. */
export function bundleExecutablePath(appPath: string, executable = 'Antigravity'): string {
  if (isMacAppBundlePath(appPath)) return join(appPath, 'Contents', 'MacOS', executable);
  const lower = join(appPath, executable.toLowerCase());
  if (existsSync(lower)) return lower;
  const exact = join(appPath, executable);
  if (existsSync(exact)) return exact;
  return lower;
}

/** Path to bundled `language_server` binary inside `appPath`. */
export function bundleLanguageServerPath(appPath: string): string {
  if (isMacAppBundlePath(appPath)) return join(appPath, 'Contents', 'Resources', 'bin', 'language_server');
  return join(appPath, 'resources', 'bin', 'language_server');
}

/** Process argv prefix that identifies processes spawned from `appPath`. */
export function bundleProcessPrefix(appPath: string): string {
  if (isMacAppBundlePath(appPath)) return `${appPath}/Contents/`;
  return `${appPath}/`;
}

/** Resolve platform path to `lsof`. */
export function resolveLsofBinary(): string {
  if (isLinux) {
    if (existsSync('/usr/bin/lsof')) return '/usr/bin/lsof';
    if (existsSync('/usr/sbin/lsof')) return '/usr/sbin/lsof';
    return 'lsof';
  }
  return '/usr/sbin/lsof';
}

/** Resolve platform path to `ps`. */
export function resolvePsBinary(): string {
  if (existsSync('/bin/ps')) return '/bin/ps';
  if (existsSync('/usr/bin/ps')) return '/usr/bin/ps';
  return 'ps';
}
