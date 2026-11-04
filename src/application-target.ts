import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export type ApplicationChannel = 'stable' | 'insiders';
export type ApplicationArchitecture = 'legacy-hub' | 'wcv-hub';

export const ALLOWED_DATA_DIRECTORY_NAMES = ['antigravity', 'antigravity-insiders'] as const;
export type DataDirectoryName = (typeof ALLOWED_DATA_DIRECTORY_NAMES)[number];

export interface InstalledChannelsInfo {
  channels: ApplicationChannel[];
  bothInstalled: boolean;
  effectiveChannel: ApplicationChannel;
}

export interface BundleCapabilities {
  architecture: ApplicationArchitecture;
  version: string;
  productName: string;
  dataDirectoryName: DataDirectoryName;
  supportsAccountSwitch: boolean;
}

const capabilityCache = new Map<string, { value: BundleCapabilities; expiresAt: number }>();

/**
 * Inspects an installed Antigravity bundle's `app.asar` header and `package.json`
 * to determine its runtime architecture (`wcv-hub` vs `legacy-hub`) and conversation
 * data directory name (`antigravity` vs `antigravity-insiders`).
 * Both Antigravity (2.29+) and Antigravity - Insiders share the same CompositeTokenStorage
 * (`gemini/antigravity` Keychain + `~/.gemini/jetski-standalone-oauth-token`) and support
 * all GravityBox features including account switching.
 */
export function probeBundleCapabilities(
  appPath: string,
  fallbackChannel: ApplicationChannel = basename(appPath) === 'Antigravity - Insiders.app' ? 'insiders' : 'stable',
): BundleCapabilities {
  const now = Date.now();
  const cached = capabilityCache.get(appPath);
  if (cached && cached.expiresAt > now) return cached.value;

  const isInsidersBundleName = fallbackChannel === 'insiders' || basename(appPath) === 'Antigravity - Insiders.app';
  const fallback: BundleCapabilities = {
    architecture: 'wcv-hub',
    version: '',
    productName: isInsidersBundleName ? 'Antigravity - Insiders' : 'Antigravity',
    dataDirectoryName: isInsidersBundleName ? 'antigravity-insiders' : 'antigravity',
    supportsAccountSwitch: true,
  };

  const asarPath = join(appPath, 'Contents', 'Resources', 'app.asar');
  let fd: number | undefined;
  try {
    if (!existsSync(asarPath)) return fallback;
    fd = openSync(asarPath, 'r');
    const prefix = Buffer.alloc(16);
    if (readSync(fd, prefix, 0, 16, 0) !== 16) return fallback;
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (jsonSize <= 0 || jsonSize > 16_000_000) return fallback;
    const headerBytes = Buffer.alloc(jsonSize);
    if (readSync(fd, headerBytes, 0, jsonSize, 16) !== jsonSize) return fallback;
    const header = JSON.parse(headerBytes.toString('utf8'));
    const distFiles = header?.files?.dist?.files ?? {};
    const hasWcvArchitecture = Boolean(
      distFiles['wcvBrowserRegistry.js'] ||
      distFiles['wcvIpcHandlers.js'] ||
      distFiles['browserEngine'] ||
      distFiles['windowState.js'],
    );

    let version = '';
    let productName = fallback.productName;
    const pkgEntry = header?.files?.['package.json'];
    if (pkgEntry && !pkgEntry.unpacked) {
      const pkgSize = Number(pkgEntry.size);
      const pkgOffset = Number(pkgEntry.offset);
      if (Number.isSafeInteger(pkgSize) && pkgSize > 0 && pkgSize <= 256_000 && Number.isSafeInteger(pkgOffset) && pkgOffset >= 0) {
        const pkgBuf = Buffer.alloc(pkgSize);
        if (readSync(fd, pkgBuf, 0, pkgSize, 8 + headerSize + pkgOffset) === pkgSize) {
          const pkg = JSON.parse(pkgBuf.toString('utf8'));
          if (typeof pkg?.version === 'string') version = pkg.version.trim();
          if (typeof pkg?.productName === 'string' && pkg.productName.trim()) productName = pkg.productName.trim();
        }
      }
    }

    const isDateVersion = /^1\.0\.\d{8,}/.test(version);
    const architecture: ApplicationArchitecture = (hasWcvArchitecture || isDateVersion || isInsidersBundleName)
      ? 'wcv-hub'
      : 'legacy-hub';
    const rawDataDir = productName.toLowerCase().replace(/\s+/g, '');
    const dataDirectoryName: DataDirectoryName =
      rawDataDir === 'antigravity-insiders' || isInsidersBundleName ? 'antigravity-insiders' : 'antigravity';

    const resolved: BundleCapabilities = {
      architecture,
      version,
      productName,
      dataDirectoryName,
      supportsAccountSwitch: true,
    };
    capabilityCache.set(appPath, { value: resolved, expiresAt: now + 30_000 });
    return resolved;
  } catch {
    return fallback;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

export function applicationChannel(value: unknown): ApplicationChannel {
  if (value === undefined || value === 'stable') return 'stable';
  if (value === 'insiders') return 'insiders';
  throw new Error('应用版本选择无效');
}

export function detectInstalledChannels(
  preferredChannel: ApplicationChannel = 'stable',
  applicationsDir = '/Applications',
): InstalledChannelsInfo {
  const stableInstalled = existsSync(join(applicationsDir, 'Antigravity.app'));
  const insidersInstalled = existsSync(join(applicationsDir, 'Antigravity - Insiders.app'));
  const channels: ApplicationChannel[] = [];
  if (stableInstalled) channels.push('stable');
  if (insidersInstalled) channels.push('insiders');

  let effectiveChannel: ApplicationChannel = preferredChannel;
  if (channels.length === 1) {
    effectiveChannel = channels[0]!;
  } else if (channels.length > 1 && !channels.includes(preferredChannel)) {
    effectiveChannel = channels[0]!;
  }
  return {
    channels: channels.length > 0 ? channels : [preferredChannel],
    bothInstalled: stableInstalled && insidersInstalled,
    effectiveChannel,
  };
}

/** Keep identity, executable, profile, and conversation storage bound to the target while unifying user-facing label and full feature support. */
export function applicationTarget(
  channel: ApplicationChannel = 'stable',
  home = homedir(),
  options?: { appPath?: string; profile?: string; applicationsDir?: string },
) {
  const insiders = channel === 'insiders';
  const name = insiders ? 'Antigravity - Insiders' : 'Antigravity';
  const applicationsDir = options?.applicationsDir ?? '/Applications';
  const appPath = options?.appPath ?? join(applicationsDir, `${name}.app`);
  const capabilities = probeBundleCapabilities(appPath, channel);
  return {
    channel,
    name,
    label: 'Antigravity',
    bundleId: insiders ? 'com.google.antigravity.insiders' : 'com.google.antigravity',
    appPath,
    executable: name,
    profile: options?.profile ?? join(home, 'Library', 'Application Support', name),
    dataDirectoryName: capabilities.dataDirectoryName,
    architecture: capabilities.architecture,
    supportsAccountSwitch: true,
  };
}

export type ApplicationTarget = ReturnType<typeof applicationTarget>;

export function allApplicationTargets(home = homedir(), applicationsDir = '/Applications'): ApplicationTarget[] {
  return [
    applicationTarget('stable', home, { applicationsDir }),
    applicationTarget('insiders', home, { applicationsDir }),
  ];
}

export function resolveDefaultTarget(home = homedir(), applicationsDir = '/Applications'): ApplicationTarget {
  const info = detectInstalledChannels('stable', applicationsDir);
  return applicationTarget(info.effectiveChannel, home, { applicationsDir });
}

export function targetForApp(appPath: string, home = homedir()): ApplicationTarget {
  const channel: ApplicationChannel = basename(appPath) === 'Antigravity - Insiders.app' ? 'insiders' : 'stable';
  return applicationTarget(channel, home, { appPath });
}

export function matchingTargetForLanguageServerCommand(
  command: string,
  preferredTarget?: ApplicationTarget,
  home = homedir(),
): ApplicationTarget | null {
  const candidates = preferredTarget
    ? [preferredTarget, ...allApplicationTargets(home).filter(t => t.appPath !== preferredTarget.appPath)]
    : allApplicationTargets(home);
  for (const candidate of candidates) {
    if (!command.startsWith(candidate.appPath + '/Contents/Resources/bin/language_server ')) continue;
    const dataDirectory = command.match(/(?:^|\s)--app_data_dir(?:=|\s+)([^\s"]+)/)?.[1];
    if (dataDirectory && dataDirectory !== candidate.dataDirectoryName) continue;
    return candidate;
  }
  return null;
}

export function channelStateDirectory(stateDir: string, _channel?: ApplicationChannel): string {
  return stateDir;
}
