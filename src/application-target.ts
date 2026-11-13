import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { openAsarSync } from './asar.js';

export type ApplicationChannel = 'stable';
export type ApplicationArchitecture = 'legacy-hub' | 'wcv-hub';

export const ALLOWED_DATA_DIRECTORY_NAMES = ['antigravity'] as const;
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

/** Inspect the supported stable bundle without changing the official application. */
export function probeBundleCapabilities(
  appPath: string,
  channel: ApplicationChannel = 'stable',
): BundleCapabilities {
  applicationChannel(channel);
  assertStablePaths(appPath);
  const now = Date.now();
  const cached = capabilityCache.get(appPath);
  if (cached && cached.expiresAt > now) return cached.value;

  const fallback: BundleCapabilities = {
    architecture: 'wcv-hub',
    version: '',
    productName: 'Antigravity',
    dataDirectoryName: 'antigravity',
    supportsAccountSwitch: true,
  };

  const asarPath = join(appPath, 'Contents', 'Resources', 'app.asar');
  let archive: ReturnType<typeof openAsarSync> | undefined;
  try {
    if (!existsSync(asarPath)) return fallback;
    archive = openAsarSync(asarPath, 16_000_000);
    const distFiles = archive.header.files?.dist?.files ?? {};
    const hasWcvArchitecture = Boolean(
      distFiles['wcvBrowserRegistry.js'] ||
      distFiles['wcvIpcHandlers.js'] ||
      distFiles['browserEngine'] ||
      distFiles['windowState.js'],
    );

    let version = '';
    let productName = fallback.productName;
    const pkgBuf = archive.readEntryBuffer(archive.header.files?.['package.json'], 256_000, 1);
    if (pkgBuf) {
      const pkg = JSON.parse(pkgBuf.toString('utf8'));
      if (typeof pkg?.version === 'string') version = pkg.version.trim();
      if (typeof pkg?.productName === 'string' && pkg.productName.trim()) productName = pkg.productName.trim();
    }

    const architecture: ApplicationArchitecture = hasWcvArchitecture
      ? 'wcv-hub'
      : 'legacy-hub';
    const dataDirectoryName: DataDirectoryName = 'antigravity';

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
    archive?.close();
  }
}

export function applicationChannel(value: unknown): ApplicationChannel {
  if (value === undefined || value === 'stable') return 'stable';
  if (value === 'insiders') throw new Error('GravityBox 仅支持 Antigravity 正式版');
  throw new Error('应用版本选择无效');
}

/** Only persisted legacy configuration is migrated; explicit channel requests are rejected. */
export function savedApplicationChannel(value: unknown): ApplicationChannel {
  return value === 'insiders' ? 'stable' : applicationChannel(value);
}

function assertStablePaths(appPath: string, profile?: string): void {
  if (basename(appPath) === 'Antigravity - Insiders.app' ||
      (profile && basename(profile) === 'Antigravity - Insiders')) {
    throw new Error('GravityBox 仅支持 Antigravity 正式版');
  }
}

export function detectInstalledChannels(
  preferredChannel: ApplicationChannel = 'stable',
  applicationsDir = '/Applications',
): InstalledChannelsInfo {
  applicationChannel(preferredChannel);
  return {
    channels: existsSync(join(applicationsDir, 'Antigravity.app')) ? ['stable'] : [],
    bothInstalled: false,
    effectiveChannel: 'stable',
  };
}

/** Keep identity, executable, profile, and conversation storage bound to the target while unifying user-facing label and full feature support. */
export function applicationTarget(
  channel: ApplicationChannel = 'stable',
  home = homedir(),
  options?: { appPath?: string; profile?: string; applicationsDir?: string },
) {
  applicationChannel(channel);
  const name = 'Antigravity';
  const applicationsDir = options?.applicationsDir ?? '/Applications';
  const appPath = options?.appPath ?? join(applicationsDir, `${name}.app`);
  assertStablePaths(appPath, options?.profile);
  const capabilities = probeBundleCapabilities(appPath, channel);
  return {
    channel,
    name,
    label: 'Antigravity',
    bundleId: 'com.google.antigravity',
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
  ];
}

export function resolveDefaultTarget(home = homedir(), applicationsDir = '/Applications'): ApplicationTarget {
  const info = detectInstalledChannels('stable', applicationsDir);
  return applicationTarget(info.effectiveChannel, home, { applicationsDir });
}

export function targetForApp(appPath: string, home = homedir()): ApplicationTarget {
  return applicationTarget('stable', home, { appPath });
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
