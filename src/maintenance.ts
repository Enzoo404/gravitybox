import { allApplicationTargets } from './application-target.js';
import { lstat, readdir, rename, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicJson } from './files.js';
import { ReentrantMutex } from './mutex.js';
import { SqliteReadSnapshot } from './sqlite-read.js';

export type CacheCategory = 'safe' | 'stateful';
export type CacheSection = 'runtime' | 'history';

export interface CacheItemMetadata {
  title: string;
  subtitle: string;
  icon: string;
  category: CacheCategory;
  section?: CacheSection;
  defaultSelected: boolean;
  impactWarning?: string;
}

// 核心常驻无损缓存（始终展示，默认勾选）
export const CACHE_NAMES = ['Cache', 'Code Cache', 'GPUCache'] as const;

// 扩展无损加速与废弃垃圾缓存（存在时自动发现并纳入，默认勾选，应删尽删）
export const EXTENDED_CACHE_NAMES = [
  'DawnCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'CachedData',
  'CachedExtensionVSIXs',
  'CachedProfilesData',
  'Crashpad',
  'logs',
  'blob_storage',
] as const;

// 多路径聚合无损缓存与孤儿残留（存在非零体积或受阻时纳入分组 1，默认勾选）
export const MULTI_SAFE_CACHE_NAMES = [
  'PartitionsCache',
  'AgentBrowserCache',
  'OrphanAgentData',
] as const;

// Agent 历史深度瘦身项（分组 2，按保留天数扫描，默认不勾选，供用户按需勾选）
export const HISTORY_SLIMMING_NAMES = [
  'AgentTaskStepLogs',
  'AgentVerboseTranscripts',
  'AgentSubagentDatabases',
] as const;

// 受保护的会话、站点存储与网络授权状态目录（严禁纳入清理，仅作只读保护统计）
export const STATEFUL_CACHE_NAMES = [
  'Service Worker',
  'Session Storage',
  'WebStorage',
  'Local Storage',
  'Cookies',
  'Network Persistent State',
] as const;

export const ALL_SAFE_CACHE_NAMES = [
  ...CACHE_NAMES,
  ...EXTENDED_CACHE_NAMES,
  ...MULTI_SAFE_CACHE_NAMES,
] as const;

export const ALL_ALLOWED_CACHE_NAMES = [
  ...ALL_SAFE_CACHE_NAMES,
  ...HISTORY_SLIMMING_NAMES,
] as const;

const PARTITION_SAFE_SUBDIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'blob_storage',
] as const;

const BROWSER_TOP_SAFE_SUBDIRS = [
  'GraphiteDawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'GrShaderCache',
  'component_crx_cache',
  'WasmTtsEngine',
  'Crashpad',
] as const;

const BROWSER_PROFILE_SAFE_SUBDIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'blob_storage',
  join('Service Worker', 'CacheStorage'),
  join('Service Worker', 'ScriptCache'),
] as const;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ALLOWED_RETENTION_DAYS = [0, 7, 30] as const;

export function normalizeRetentionDays(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const rounded = Math.max(0, Math.min(365, Math.floor(raw)));
    return rounded;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(365, Math.floor(parsed)));
    }
  }
  return 7;
}

export const CACHE_METADATA: Record<string, CacheItemMetadata> = {
  'Cache': {
    title: '网络与静态资源缓存',
    subtitle: '界面静态资源与临时网络响应数据',
    icon: 'internaldrive',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'Code Cache': {
    title: 'V8 字节码编译缓存',
    subtitle: 'JavaScript 与 WebAssembly 预编译加速缓存',
    icon: 'cpu',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'GPUCache': {
    title: '图形与着色器缓存',
    subtitle: 'Metal 与 WebGL 图形渲染管线编译产物',
    icon: 'sparkles.rectangle.stack',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'DawnCache': {
    title: 'WebGPU 图形加速缓存',
    subtitle: 'Dawn 引擎图形管线与计算着色器缓存',
    icon: 'cube.transparent',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'DawnWebGPUCache': {
    title: 'WebGPU 管线缓存',
    subtitle: 'WebGPU 渲染管线与着色器加速缓存',
    icon: 'cube.transparent',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'DawnGraphiteCache': {
    title: 'Graphite 渲染管线缓存',
    subtitle: 'Chromium Graphite 图形管线预编译产物',
    icon: 'cube.transparent',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'GraphiteDawnCache': {
    title: 'Graphite 着色器加速缓存',
    subtitle: '现代图形后端预编译着色器与管线缓存',
    icon: 'sparkles.rectangle.stack',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'ShaderCache': {
    title: '底层着色器缓存',
    subtitle: '图形驱动预编译着色器残留数据',
    icon: 'sparkles.rectangle.stack',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'CachedData': {
    title: '工作区运行编译缓存',
    subtitle: '主进程与渲染进程预编译脚本缓存',
    icon: 'memorychip',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'CachedExtensionVSIXs': {
    title: '扩展安装包残留',
    subtitle: '插件安装与更新遗留的 VSIX 压缩包',
    icon: 'shippingbox',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'CachedProfilesData': {
    title: '配置快照临时缓存',
    subtitle: '工作区配置切换生成的临时加速缓存',
    icon: 'doc.badge.gearshape',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'Crashpad': {
    title: '崩溃转储与诊断残留',
    subtitle: '历史崩溃报告与废弃诊断转储文件',
    icon: 'exclamationmark.triangle',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'logs': {
    title: '历史运行日志',
    subtitle: '主进程、渲染进程与扩展宿主历史日志',
    icon: 'doc.text',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'blob_storage': {
    title: '临时二进制块缓存',
    subtitle: '运行期产生的临时二进制块数据',
    icon: 'archivebox',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'PartitionsCache': {
    title: '内嵌视图子分区缓存',
    subtitle: '内嵌浏览器与隔离分区的静态资源及编译缓存',
    icon: 'square.split.2x2',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'AgentBrowserCache': {
    title: '浏览器沙箱加速缓存',
    subtitle: 'Browser 沙箱的网页与编译缓存（保留站点登录与 Cookie）',
    icon: 'globe',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'OrphanAgentData': {
    title: '已删对话残留与临时文件',
    subtitle: '父对话已删除的孤儿任务碎片、崩溃日志与临时媒体缓存',
    icon: 'trash.slash',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'AgentTaskStepLogs': {
    title: '历史任务与步骤输出日志',
    subtitle: '非活跃对话的后台终端日志、步骤输出与 scratch 临时草稿',
    icon: 'terminal',
    category: 'stateful',
    section: 'history',
    defaultSelected: false,
    impactWarning: '清理中间运行日志，主对话与正式产物完好保留',
  },
  'AgentVerboseTranscripts': {
    title: '全量冗余转录与分片镜像',
    subtitle: '非活跃对话的 transcript_full 与分片镜像（保留紧凑版记录）',
    icon: 'doc.on.doc',
    category: 'stateful',
    section: 'history',
    defaultSelected: false,
    impactWarning: '仅移除冗余大体积镜像，对话界面与紧凑版记录不受影响',
  },
  'AgentSubagentDatabases': {
    title: '历史子智能体轨迹库',
    subtitle: '已完成任务的后台 Subagent 数据库（清理前自动归档 Token 账单）',
    icon: 'arrow.triangle.branch',
    category: 'stateful',
    section: 'history',
    defaultSelected: false,
    impactWarning: '主对话与历史账单完好保留，旧子智能体内部过程不再展开',
  },
  'Service Worker': {
    title: '后台服务工作线程',
    subtitle: '按需清理 · 清理后重新初始化扩展后台状态',
    icon: 'gearshape.2',
    category: 'stateful',
    defaultSelected: false,
    impactWarning: '重置扩展后台状态',
  },
  'Session Storage': {
    title: '内嵌视图会话缓存',
    subtitle: '按需清理 · 清理后重置部分内嵌视图临时会话',
    icon: 'rectangle.stack',
    category: 'stateful',
    defaultSelected: false,
    impactWarning: '重置临时会话状态',
  },
  'WebStorage': {
    title: 'Web 视图持久缓存',
    subtitle: '按需清理 · 清理后重置扩展内嵌网页状态',
    icon: 'globe',
    category: 'stateful',
    defaultSelected: false,
    impactWarning: '重置内嵌网页状态',
  },
  'Local Storage': {
    title: '扩展与站点本地存储',
    subtitle: '按需清理 · 清理后可能需重新授权部分扩展',
    icon: 'externaldrive.badge.person.crop',
    category: 'stateful',
    defaultSelected: false,
    impactWarning: '可能需重新授权扩展',
  },
  'Cookies': {
    title: '网络会话与授权凭据',
    subtitle: '按需清理 · 清理后部分服务需重新登录授权',
    icon: 'key.horizontal',
    category: 'stateful',
    defaultSelected: false,
    impactWarning: '清理后需重新登录授权',
  },
  'Network Persistent State': {
    title: '网络连接协商状态',
    subtitle: '按需清理 · 清理后重新协商网络连接参数',
    icon: 'network',
    category: 'stateful',
    defaultSelected: false,
    impactWarning: '重置网络连接偏好',
  },
};

export async function antigravityRunning(appPath = '/Applications/Antigravity.app') {
  try {
    const appRoots = Array.from(new Set([appPath, ...allApplicationTargets().map(t => t.appPath)]));
    const macOsPrefixes = appRoots.map(p => p + '/Contents/MacOS/');
    const lsPrefixes = appRoots.map(p => p + '/Contents/Resources/bin/language_server');
    const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'command=']);
    return stdout.split('\n').some(line => {
      const trimmed = line.trim();
      return (
        macOsPrefixes.some(prefix => trimmed.startsWith(prefix)) ||
        lsPrefixes.some(prefix => trimmed.startsWith(prefix) || trimmed.includes(prefix))
      );
    });
  } catch {
    return false;
  }
}

export async function browserProfileRunning(browserProfileDir: string): Promise<boolean> {
  if (!browserProfileDir) return false;
  try {
    const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'command=']);
    return stdout.split('\n').some(line => {
      const trimmed = line.trim();
      return trimmed.includes(browserProfileDir) && !trimmed.includes('/bin/ps');
    });
  } catch {
    return false;
  }
}

export interface CacheMaintenanceOptions {
  appPath?: string;
  stateDir?: string;
  geminiDir?: string;
  browserRunning?: () => Promise<boolean>;
  archiveDatabases?: (dbPaths: string[]) => Promise<unknown>;
  onMutated?: () => void | Promise<void>;
}

interface SubTargetSpec {
  path: string;
  isUsageDb?: boolean;
}

interface InspectedCacheEntry {
  name: string;
  title: string;
  subtitle: string;
  icon: string;
  category: CacheCategory;
  section: CacheSection;
  defaultSelected: boolean;
  impactWarning?: string;
  bytes: number;
  fileCount: number;
  itemCount?: number;
  lastModifiedAt: number;
  exists: boolean;
  clearable: boolean;
  fingerprint: string;
  reason?: string;
  isSingleLegacyRoot: boolean;
  subTargets: SubTargetSpec[];
}

interface ConversationIndexSnapshot {
  available: boolean;
  summaryMap: Map<string, { parentId: string; status: string }>;
  runningTreeIds: Set<string>;
  archivedTreeIds: Set<string>;
}

function isStrictSubpath(parentDir: string, candidatePath: string): boolean {
  const rel = relative(resolve(parentDir), resolve(candidatePath));
  return Boolean(rel && !rel.startsWith('..') && !rel.includes(`..${sep}`) && rel !== '.');
}

export class CacheMaintenance {
  private mutex = new ReentrantMutex();
  private lastRetentionDays = 7;
  private prepared?: {
    token: string;
    at: number;
    retentionDays: number;
    entries: Array<{
      name: string;
      fingerprint: string;
      bytes: number;
      fileCount: number;
      category: CacheCategory;
      defaultSelected: boolean;
      isSingleLegacyRoot: boolean;
      subTargets: SubTargetSpec[];
    }>;
    fingerprints: string[];
  };

  constructor(
    private profile: string,
    private trash = join(homedir(), '.Trash'),
    private running = antigravityRunning,
    private options: CacheMaintenanceOptions = {},
  ) {
    if (running === antigravityRunning) this.running = () => antigravityRunning(this.options.appPath);
  }

  setTarget(profile: string, options: CacheMaintenanceOptions = {}) {
    this.profile = profile;
    this.options = options;
    this.prepared = undefined;
    this.cachedProtectedSummary = undefined;
    this.running = () => antigravityRunning(this.options.appPath);
  }

  setHooks(hooks: Pick<CacheMaintenanceOptions, 'archiveDatabases' | 'onMutated' | 'browserRunning'>) {
    this.options = { ...this.options, ...hooks };
  }

  private officialAgentDir(): string | undefined {
    if (!this.options.geminiDir) return undefined;
    return join(this.options.geminiDir, 'antigravity');
  }

  private allowedRootDirs(): string[] {
    const roots = [resolve(this.profile)];
    const agentDir = this.officialAgentDir();
    if (agentDir) roots.push(resolve(agentDir));
    return roots;
  }

  private isAllowedTargetPath(candidatePath: string): boolean {
    return this.allowedRootDirs().some(root => isStrictSubpath(root, candidatePath));
  }

  private async isBrowserProfileBusy(): Promise<boolean> {
    if (this.options.browserRunning) {
      return await this.options.browserRunning();
    }
    const agentDir = this.officialAgentDir();
    if (!agentDir) return false;
    return await browserProfileRunning(join(agentDir, 'browser_profile'));
  }

  private async ensureSafeAncestors(rootDir: string, targetPath: string): Promise<void> {
    const resolvedRoot = resolve(rootDir);
    const resolvedTarget = resolve(targetPath);
    if (!isStrictSubpath(resolvedRoot, resolvedTarget)) {
      throw Error('缓存路径超出受控目录边界，已跳过');
    }
    const rootStat = await lstat(resolvedRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw Error('缓存路径包含链接，已跳过');
    }
    const relParts = relative(resolvedRoot, dirname(resolvedTarget)).split(sep).filter(Boolean);
    let cursor = resolvedRoot;
    for (const seg of relParts) {
      cursor = join(cursor, seg);
      const st = await lstat(cursor);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw Error('缓存含符号链接，已跳过');
      }
    }
  }

  private async inspectPathTree(root: string, deadline: number, counter: { count: number }): Promise<{
    bytes: number;
    fileCount: number;
    lastModifiedAt: number;
    items: string[];
  }> {
    const items: string[] = [];
    let bytes = 0;
    let fileCount = 0;
    let lastModifiedAt = 0;

    const walk = async (path: string) => {
      if (++counter.count > 250000 || Date.now() > deadline) throw Error('目录过大，请手动检查');
      const s = await lstat(path);
      if (s.isSymbolicLink()) throw Error('缓存含符号链接，已跳过');
      if (!s.isDirectory() && !s.isFile()) throw Error('缓存含非常规文件，已跳过');
      items.push(JSON.stringify([path.slice(root.length), s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]));
      if (s.mtimeMs > lastModifiedAt) lastModifiedAt = s.mtimeMs;
      if (s.isDirectory()) {
        for (const n of (await readdir(path)).sort()) await walk(join(path, n));
      } else {
        bytes += s.size;
        fileCount++;
      }
    };
    await walk(root);
    return { bytes, fileCount, lastModifiedAt, items };
  }

  private async inspectSingleProfileItem(name: string): Promise<InspectedCacheEntry> {
    const meta: CacheItemMetadata = CACHE_METADATA[name] ?? {
      title: name,
      subtitle: `应用运行缓存目录（${name}）`,
      icon: 'folder',
      category: 'safe',
      section: 'runtime',
      defaultSelected: true,
    };
    const root = join(this.profile, name);
    const deadline = Date.now() + 8000;
    try {
      const base = await lstat(this.profile);
      if (base.isSymbolicLink() || !base.isDirectory()) throw Error('缓存路径包含链接，已跳过');
      const tree = await this.inspectPathTree(root, deadline, { count: 0 });
      return {
        name,
        title: meta.title,
        subtitle: meta.subtitle,
        icon: meta.icon,
        category: meta.category,
        section: meta.section ?? 'runtime',
        defaultSelected: meta.defaultSelected,
        ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
        bytes: tree.bytes,
        fileCount: tree.fileCount,
        lastModifiedAt: tree.lastModifiedAt > 0 ? Math.floor(tree.lastModifiedAt / 1000) : 0,
        exists: true,
        clearable: true,
        fingerprint: createHash('sha256').update(tree.items.join('\n')).digest('hex'),
        isSingleLegacyRoot: true,
        subTargets: [{ path: root }],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          name,
          title: meta.title,
          subtitle: meta.subtitle,
          icon: meta.icon,
          category: meta.category,
          section: meta.section ?? 'runtime',
          defaultSelected: meta.defaultSelected,
          ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
          bytes: 0,
          fileCount: 0,
          lastModifiedAt: 0,
          exists: false,
          clearable: true,
          fingerprint: 'missing',
          isSingleLegacyRoot: true,
          subTargets: [],
        };
      }
      return {
        name,
        title: meta.title,
        subtitle: meta.subtitle,
        icon: meta.icon,
        category: meta.category,
        section: meta.section ?? 'runtime',
        defaultSelected: meta.defaultSelected,
        ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
        bytes: 0,
        fileCount: 0,
        lastModifiedAt: 0,
        exists: true,
        clearable: false,
        fingerprint: 'blocked',
        reason: (error as Error).message,
        isSingleLegacyRoot: true,
        subTargets: [],
      };
    }
  }

  private async inspectMultiTargetItem(
    name: string,
    candidates: SubTargetSpec[],
    options?: { dynamicSubtitle?: string; itemCount?: number }
  ): Promise<InspectedCacheEntry> {
    const meta: CacheItemMetadata = CACHE_METADATA[name] ?? {
      title: name,
      subtitle: name,
      icon: 'folder',
      category: 'safe',
      section: 'runtime',
      defaultSelected: false,
    };
    const subtitle = options?.dynamicSubtitle ?? meta.subtitle;
    if (candidates.length === 0) {
      return {
        name,
        title: meta.title,
        subtitle,
        icon: meta.icon,
        category: meta.category,
        section: meta.section ?? (meta.category === 'stateful' ? 'history' : 'runtime'),
        defaultSelected: meta.defaultSelected,
        ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
        bytes: 0,
        fileCount: 0,
        ...(options?.itemCount !== undefined ? { itemCount: options.itemCount } : {}),
        lastModifiedAt: 0,
        exists: false,
        clearable: true,
        fingerprint: 'missing',
        isSingleLegacyRoot: false,
        subTargets: [],
      };
    }

    const deadline = Date.now() + 12000;
    const counter = { count: 0 };
    const hash = createHash('sha256');
    const activeTargets: SubTargetSpec[] = [];
    let totalBytes = 0;
    let totalFiles = 0;
    let lastModifiedAt = 0;

    try {
      const sorted = [...candidates].sort((a, b) => a.path.localeCompare(b.path));
      for (const spec of sorted) {
        const rootOwner = this.allowedRootDirs().find(r => isStrictSubpath(r, spec.path));
        if (!rootOwner) throw Error('缓存路径超出受控目录边界，已跳过');
        await this.ensureSafeAncestors(rootOwner, spec.path);
        try {
          const tree = await this.inspectPathTree(spec.path, deadline, counter);
          let sidecarBytes = 0;
          let sidecarFiles = 0;
          const sidecarMarks: string[] = [];
          for (const suffix of ['-journal', '-wal', '-shm']) {
            try {
              const sideStat = await lstat(`${spec.path}${suffix}`);
              if (sideStat.isSymbolicLink()) throw Error('缓存含符号链接，已跳过');
              if (sideStat.isFile()) {
                sidecarBytes += sideStat.size;
                sidecarFiles += 1;
                if (sideStat.mtimeMs > lastModifiedAt) lastModifiedAt = sideStat.mtimeMs;
                sidecarMarks.push(`${suffix}:${sideStat.size}:${sideStat.mtimeMs}`);
              }
            } catch (sideErr) {
              if ((sideErr as NodeJS.ErrnoException).code !== 'ENOENT') throw sideErr;
            }
          }
          totalBytes += tree.bytes + sidecarBytes;
          totalFiles += tree.fileCount + sidecarFiles;
          if (tree.lastModifiedAt > lastModifiedAt) lastModifiedAt = tree.lastModifiedAt;
          hash.update(`TARGET:${spec.path}\n${tree.items.join('\n')}\nSIDE:${sidecarMarks.join(',')}\n`);
          activeTargets.push(spec);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw err;
        }
      }

      if (activeTargets.length === 0) {
        return {
          name,
          title: meta.title,
          subtitle,
          icon: meta.icon,
          category: meta.category,
          section: meta.section ?? (meta.category === 'stateful' ? 'history' : 'runtime'),
          defaultSelected: meta.defaultSelected,
          ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
          bytes: 0,
          fileCount: 0,
          ...(options?.itemCount !== undefined ? { itemCount: options.itemCount } : {}),
          lastModifiedAt: 0,
          exists: false,
          clearable: true,
          fingerprint: 'missing',
          isSingleLegacyRoot: false,
          subTargets: [],
        };
      }

      return {
        name,
        title: meta.title,
        subtitle,
        icon: meta.icon,
        category: meta.category,
        section: meta.section ?? (meta.category === 'stateful' ? 'history' : 'runtime'),
        defaultSelected: meta.defaultSelected,
        ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
        bytes: totalBytes,
        fileCount: totalFiles,
        ...(options?.itemCount !== undefined ? { itemCount: options.itemCount } : {}),
        lastModifiedAt: lastModifiedAt > 0 ? Math.floor(lastModifiedAt / 1000) : 0,
        exists: totalBytes > 0 || totalFiles > 0,
        clearable: true,
        fingerprint: hash.digest('hex'),
        isSingleLegacyRoot: false,
        subTargets: activeTargets,
      };
    } catch (error) {
      return {
        name,
        title: meta.title,
        subtitle,
        icon: meta.icon,
        category: meta.category,
        section: meta.section ?? (meta.category === 'stateful' ? 'history' : 'runtime'),
        defaultSelected: meta.defaultSelected,
        ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
        bytes: 0,
        fileCount: 0,
        lastModifiedAt: 0,
        exists: true,
        clearable: false,
        fingerprint: 'blocked',
        reason: (error as Error).message,
        isSingleLegacyRoot: false,
        subTargets: [],
      };
    }
  }

  private async collectPartitionsCandidates(): Promise<SubTargetSpec[]> {
    const partRoot = join(this.profile, 'Partitions');
    const targets: SubTargetSpec[] = [];
    try {
      const st = await lstat(partRoot);
      if (st.isSymbolicLink()) return [{ path: partRoot }];
      if (!st.isDirectory()) return [];
      const partitions = await readdir(partRoot);
      for (const part of partitions) {
        const partDir = join(partRoot, part);
        const pst = await lstat(partDir).catch(() => null);
        if (!pst) continue;
        if (pst.isSymbolicLink()) {
          targets.push({ path: partDir });
          continue;
        }
        if (!pst.isDirectory()) continue;
        for (const sub of PARTITION_SAFE_SUBDIRS) {
          const candidate = join(partDir, sub);
          const cst = await lstat(candidate).catch(() => null);
          if (cst) targets.push({ path: candidate });
        }
      }
    } catch {}
    return targets;
  }

  private async collectBrowserProfileCandidates(): Promise<SubTargetSpec[]> {
    const agentDir = this.officialAgentDir();
    if (!agentDir) return [];
    const bpRoot = join(agentDir, 'browser_profile');
    const targets: SubTargetSpec[] = [];
    try {
      const st = await lstat(bpRoot);
      if (st.isSymbolicLink()) return [{ path: bpRoot }];
      if (!st.isDirectory()) return [];

      for (const topSub of BROWSER_TOP_SAFE_SUBDIRS) {
        const candidate = join(bpRoot, topSub);
        if (await lstat(candidate).catch(() => null)) {
          targets.push({ path: candidate });
        }
      }

      const entries = await readdir(bpRoot);
      for (const entry of entries) {
        const isProfileDir =
          entry === 'Default' ||
          entry === 'Guest Profile' ||
          entry === 'System Profile' ||
          /^Profile \d+$/.test(entry);
        if (!isProfileDir) continue;
        const profPath = join(bpRoot, entry);
        const pst = await lstat(profPath).catch(() => null);
        if (!pst) continue;
        if (pst.isSymbolicLink()) {
          targets.push({ path: profPath });
          continue;
        }
        if (!pst.isDirectory()) continue;
        for (const sub of BROWSER_PROFILE_SAFE_SUBDIRS) {
          const candidate = join(profPath, sub);
          if (await lstat(candidate).catch(() => null)) {
            targets.push({ path: candidate });
          }
        }
      }
    } catch {}
    return targets;
  }

  private async loadConversationIndex(agentDir: string): Promise<ConversationIndexSnapshot> {
    const summaryMap = new Map<string, { parentId: string; status: string }>();
    const runningTreeIds = new Set<string>();
    const archivedTreeIds = new Set<string>();
    const dbPath = join(agentDir, 'conversation_summaries.db');

    const dbStat = await lstat(dbPath).catch(() => null);
    if (!dbStat || !dbStat.isFile() || dbStat.isSymbolicLink()) {
      return { available: false, summaryMap, runningTreeIds, archivedTreeIds };
    }

    const reader = new SqliteReadSnapshot(dbPath);
    try {
      const sumRes = await reader.query(
        'SELECT conversation_id, parent_conversation_id, status FROM conversation_summaries;'
      );
      if (!sumRes.ok) {
        return { available: false, summaryMap, runningTreeIds, archivedTreeIds };
      }
      for (const row of sumRes.rows) {
        const cid = typeof row.conversation_id === 'string' ? row.conversation_id.trim() : '';
        if (!cid) continue;
        summaryMap.set(cid, {
          parentId: typeof row.parent_conversation_id === 'string' ? row.parent_conversation_id.trim() : '',
          status: typeof row.status === 'string' ? row.status.trim() : '',
        });
      }

      const directArchived = new Set<string>();
      const ftsRes = await reader.query(
        'SELECT DISTINCT conversation_id FROM conversations_fts WHERE archived = 1;'
      );
      if (ftsRes.ok) {
        for (const row of ftsRes.rows) {
          if (typeof row.conversation_id === 'string' && row.conversation_id.trim()) {
            directArchived.add(row.conversation_id.trim());
          }
        }
      }

      // 向上查找祖先链，确保只要树上任一节点处于运行中或已归档，整棵树受保护
      const ancestorsOf = (cid: string): string[] => {
        const chain: string[] = [cid];
        const visited = new Set<string>([cid]);
        let cur = summaryMap.get(cid)?.parentId ?? '';
        while (cur && !visited.has(cur)) {
          visited.add(cur);
          chain.push(cur);
          cur = summaryMap.get(cur)?.parentId ?? '';
        }
        return chain;
      };

      const runningSeeds = new Set<string>();
      for (const [cid, info] of summaryMap.entries()) {
        if (info.status === 'CASCADE_RUN_STATUS_RUNNING') {
          for (const a of ancestorsOf(cid)) runningSeeds.add(a);
        }
      }
      for (const cid of summaryMap.keys()) {
        const chain = ancestorsOf(cid);
        if (chain.some(id => runningSeeds.has(id))) {
          for (const id of chain) runningTreeIds.add(id);
        }
        if (chain.some(id => directArchived.has(id))) {
          for (const id of chain) archivedTreeIds.add(id);
        }
      }

      return { available: true, summaryMap, runningTreeIds, archivedTreeIds };
    } catch {
      return { available: false, summaryMap, runningTreeIds, archivedTreeIds };
    } finally {
      await reader.close();
    }
  }

  async hasRunningConversation(): Promise<boolean> {
    const agentDir = this.officialAgentDir();
    if (!agentDir) return false;
    const index = await this.loadConversationIndex(agentDir);
    if (!index.available || index.runningTreeIds.size === 0) return false;
    const recentThresholdMs = Date.now() - 180_000;
    const convDir = join(agentDir, 'conversations');
    const brainDir = join(agentDir, 'brain');
    for (const cid of index.runningTreeIds) {
      if (!UUID_REGEX.test(cid)) continue;
      const dbPath = join(convDir, `${cid}.db`);
      const [dbSt, walSt, bSt] = await Promise.all([
        lstat(dbPath).catch(() => null),
        lstat(`${dbPath}-wal`).catch(() => null),
        lstat(join(brainDir, cid)).catch(() => null),
      ]);
      const latest = Math.max(dbSt?.mtimeMs ?? 0, walSt?.mtimeMs ?? 0, bSt?.mtimeMs ?? 0);
      if (latest >= recentThresholdMs) return true;
    }
    return false;
  }

  private async collectAgentConversationTargets(retentionDays: number): Promise<{
    orphanTargets: SubTargetSpec[];
    orphanConvCount: number;
    taskStepTargets: SubTargetSpec[];
    verboseTranscriptTargets: SubTargetSpec[];
    subagentDbTargets: SubTargetSpec[];
    subagentCount: number;
  }> {
    const empty = {
      orphanTargets: [] as SubTargetSpec[],
      orphanConvCount: 0,
      taskStepTargets: [] as SubTargetSpec[],
      verboseTranscriptTargets: [] as SubTargetSpec[],
      subagentDbTargets: [] as SubTargetSpec[],
      subagentCount: 0,
    };
    const agentDir = this.officialAgentDir();
    if (!agentDir) return empty;
    const agentStat = await lstat(agentDir).catch(() => null);
    if (!agentStat || !agentStat.isDirectory() || agentStat.isSymbolicLink()) return empty;

    const nowMs = Date.now();
    const quietThresholdMs = nowMs - 60_000; // 排除 60 秒内刚写入的瞬态会话文件
    const cutoffMs = retentionDays > 0 ? nowMs - retentionDays * 86_400_000 : quietThresholdMs;

    const index = await this.loadConversationIndex(agentDir);
    const convDir = join(agentDir, 'conversations');
    const brainDir = join(agentDir, 'brain');

    const orphanTargets: SubTargetSpec[] = [];
    const orphanIds = new Set<string>();

    // 1. 崩溃日志与全局 tempmediaStorage
    const crashesDir = join(agentDir, 'crashes');
    const crashesStat = await lstat(crashesDir).catch(() => null);
    if (crashesStat && !crashesStat.isSymbolicLink() && crashesStat.isDirectory()) {
      const crashFiles = await readdir(crashesDir).catch(() => [] as string[]);
      for (const f of crashFiles) {
        orphanTargets.push({ path: join(crashesDir, f) });
      }
    }
    const globalTempMedia = join(brainDir, 'tempmediaStorage');
    const gtmStat = await lstat(globalTempMedia).catch(() => null);
    if (gtmStat && !gtmStat.isSymbolicLink() && gtmStat.isDirectory()) {
      const gtmFiles = await readdir(globalTempMedia).catch(() => [] as string[]);
      for (const f of gtmFiles) {
        orphanTargets.push({ path: join(globalTempMedia, f) });
      }
    }

    // 2. 识别父对话已被删除的孤儿 Subagent
    if (index.available) {
      for (const [cid, info] of index.summaryMap.entries()) {
        if (!UUID_REGEX.test(cid)) continue;
        if (!info.parentId || index.summaryMap.has(info.parentId)) continue;
        if (index.runningTreeIds.has(cid) || index.archivedTreeIds.has(cid)) continue;

        const dbFile = join(convDir, `${cid}.db`);
        const bDir = join(brainDir, cid);
        const dbSt = await lstat(dbFile).catch(() => null);
        const bSt = await lstat(bDir).catch(() => null);
        const latestMtime = Math.max(dbSt?.mtimeMs ?? 0, bSt?.mtimeMs ?? 0);
        if (latestMtime > quietThresholdMs) continue;

        let added = false;
        if (dbSt && dbSt.isFile() && !dbSt.isSymbolicLink()) {
          orphanTargets.push({ path: dbFile, isUsageDb: true });
          added = true;
        }
        if (bSt && bSt.isDirectory() && !bSt.isSymbolicLink()) {
          orphanTargets.push({ path: bDir });
          added = true;
        }
        if (added) orphanIds.add(cid);
      }

      // 识别磁盘上超过 5 分钟、连 summaryMap 都不存在的无主残留
      const unindexedQuietMs = nowMs - 300_000;
      const convFiles = await readdir(convDir).catch(() => [] as string[]);
      for (const f of convFiles) {
        if (!f.endsWith('.db')) continue;
        const cid = f.slice(0, -3);
        if (!UUID_REGEX.test(cid) || index.summaryMap.has(cid) || index.archivedTreeIds.has(cid) || orphanIds.has(cid)) continue;
        const dbFile = join(convDir, f);
        const st = await lstat(dbFile).catch(() => null);
        if (st && st.isFile() && !st.isSymbolicLink() && st.mtimeMs <= unindexedQuietMs) {
          orphanTargets.push({ path: dbFile, isUsageDb: true });
          orphanIds.add(cid);
        }
      }
      const brainEntries = await readdir(brainDir).catch(() => [] as string[]);
      for (const cid of brainEntries) {
        if (!UUID_REGEX.test(cid) || index.summaryMap.has(cid) || index.archivedTreeIds.has(cid)) continue;
        const bDir = join(brainDir, cid);
        const st = await lstat(bDir).catch(() => null);
        if (st && st.isDirectory() && !st.isSymbolicLink() && st.mtimeMs <= unindexedQuietMs) {
          orphanTargets.push({ path: bDir });
          orphanIds.add(cid);
        }
      }
    }

    // 3. 收集非孤儿会话的 brain 派生运行日志（与孤儿集合严格互不相交）
    const taskStepTargets: SubTargetSpec[] = [];
    const verboseTranscriptTargets: SubTargetSpec[] = [];
    const brainDirs = await readdir(brainDir).catch(() => [] as string[]);

    for (const cid of brainDirs) {
      if (!UUID_REGEX.test(cid) || orphanIds.has(cid) || index.runningTreeIds.has(cid)) continue;
      const bPath = join(brainDir, cid);
      const bSt = await lstat(bPath).catch(() => null);
      if (!bSt || !bSt.isDirectory() || bSt.isSymbolicLink()) continue;

      // .tempmediaStorage 属于纯临时缓存（只要该会话未运行且静止 >60s，归入无损孤儿/临时残留）
      const dotTemp = join(bPath, '.tempmediaStorage');
      const dotTempSt = await lstat(dotTemp).catch(() => null);
      if (dotTempSt && !dotTempSt.isSymbolicLink() && dotTempSt.mtimeMs <= quietThresholdMs) {
        orphanTargets.push({ path: dotTemp });
      }

      // 判断会话最后活跃时间是否早于保留窗口 cutoffMs
      // 优先以会话库 (.db / -wal) 与紧凑转录文件 (transcript.jsonl) 的修改时间为准，
      // 避免移走 scratch 等同级子目录时因父目录 brain/<cid> mtime 刷新而误判为刚活跃。
      const dbPath = join(convDir, `${cid}.db`);
      const compactLogPath = join(bPath, '.system_generated', 'logs', 'transcript.jsonl');
      const [dbSt, walSt, logSt] = await Promise.all([
        lstat(dbPath).catch(() => null),
        lstat(`${dbPath}-wal`).catch(() => null),
        lstat(compactLogPath).catch(() => null),
      ]);
      const anchorMtime = Math.max(dbSt?.mtimeMs ?? 0, walSt?.mtimeMs ?? 0, logSt?.mtimeMs ?? 0);
      const sessionLastMtime = anchorMtime > 0 ? anchorMtime : bSt.mtimeMs;
      if (sessionLastMtime > cutoffMs || sessionLastMtime > quietThresholdMs) continue;

      for (const rel of [
        join('.system_generated', 'tasks'),
        join('.system_generated', 'steps'),
        'scratch',
      ]) {
        const candidate = join(bPath, rel);
        if (await lstat(candidate).catch(() => null)) {
          taskStepTargets.push({ path: candidate });
        }
      }

      for (const rel of [
        join('.system_generated', 'logs', 'chunks'),
        join('.system_generated', 'logs', 'transcript_full.jsonl'),
      ]) {
        const candidate = join(bPath, rel);
        if (await lstat(candidate).catch(() => null)) {
          verboseTranscriptTargets.push({ path: candidate });
        }
      }
    }

    // 4. 收集超期非活跃 Subagent 数据库（仅收集 conversations/<sub-cid>.db，与 brain 派生日志严格互不相交）
    const subagentDbTargets: SubTargetSpec[] = [];
    let subagentCount = 0;
    if (index.available) {
      for (const [cid, info] of index.summaryMap.entries()) {
        if (!UUID_REGEX.test(cid) || !info.parentId || orphanIds.has(cid)) continue;
        if (!index.summaryMap.has(info.parentId)) continue;
        if (index.runningTreeIds.has(cid) || index.archivedTreeIds.has(cid)) continue;

        const dbFile = join(convDir, `${cid}.db`);
        const dbSt = await lstat(dbFile).catch(() => null);
        if (!dbSt || !dbSt.isFile() || dbSt.isSymbolicLink()) continue;
        const walSt = await lstat(`${dbFile}-wal`).catch(() => null);
        const latestMtime = Math.max(dbSt.mtimeMs, walSt?.mtimeMs ?? 0);
        if (latestMtime > cutoffMs || latestMtime > quietThresholdMs) continue;

        subagentDbTargets.push({ path: dbFile, isUsageDb: true });
        subagentCount++;
      }
    }

    return {
      orphanTargets,
      orphanConvCount: orphanIds.size,
      taskStepTargets,
      verboseTranscriptTargets,
      subagentDbTargets,
      subagentCount,
    };
  }

  private async inspectNamedEntry(name: string, retentionDays: number): Promise<InspectedCacheEntry> {
    if (
      (CACHE_NAMES as readonly string[]).includes(name) ||
      (EXTENDED_CACHE_NAMES as readonly string[]).includes(name)
    ) {
      return await this.inspectSingleProfileItem(name);
    }
    if (name === 'PartitionsCache') {
      const candidates = await this.collectPartitionsCandidates();
      return await this.inspectMultiTargetItem(name, candidates);
    }
    if (name === 'AgentBrowserCache') {
      const candidates = await this.collectBrowserProfileCandidates();
      return await this.inspectMultiTargetItem(name, candidates);
    }
    const agentTargets = await this.collectAgentConversationTargets(retentionDays);
    const windowDesc = retentionDays > 0 ? `${retentionDays} 天前` : '非活跃';
    if (name === 'OrphanAgentData') {
      const sub = agentTargets.orphanConvCount > 0
        ? `含 ${agentTargets.orphanConvCount} 个已删主对话遗留的孤儿记录、崩溃日志与临时媒体`
        : CACHE_METADATA.OrphanAgentData!.subtitle;
      return await this.inspectMultiTargetItem(name, agentTargets.orphanTargets, {
        dynamicSubtitle: sub,
        itemCount: agentTargets.orphanConvCount,
      });
    }
    if (name === 'AgentTaskStepLogs') {
      return await this.inspectMultiTargetItem(name, agentTargets.taskStepTargets, {
        dynamicSubtitle: `${windowDesc}对话的后台终端日志、步骤输出与 scratch 草稿`,
      });
    }
    if (name === 'AgentVerboseTranscripts') {
      return await this.inspectMultiTargetItem(name, agentTargets.verboseTranscriptTargets, {
        dynamicSubtitle: `${windowDesc}对话的 transcript_full 与分片镜像（保留紧凑版记录）`,
      });
    }
    if (name === 'AgentSubagentDatabases') {
      const sub = agentTargets.subagentCount > 0
        ? `${windowDesc}共 ${agentTargets.subagentCount} 个后台子智能体库（清理前自动归档 Token 账单）`
        : CACHE_METADATA.AgentSubagentDatabases!.subtitle;
      return await this.inspectMultiTargetItem(name, agentTargets.subagentDbTargets, {
        dynamicSubtitle: sub,
        itemCount: agentTargets.subagentCount,
      });
    }
    return await this.inspectSingleProfileItem(name);
  }

  private async inspectReadOnlyPaths(paths: string[], limitCount = 80000, budgetMs = 2800) {
    let bytes = 0, fileCount = 0, count = 0, exists = false, truncated = false;
    const deadline = Date.now() + budgetMs;
    const walk = async (path: string) => {
      if (++count > limitCount || Date.now() > deadline) {
        truncated = true;
        return;
      }
      try {
        const s = await lstat(path);
        if (s.isSymbolicLink()) return;
        exists = true;
        if (s.isDirectory()) {
          for (const n of await readdir(path)) {
            if (count > limitCount || Date.now() > deadline) {
              truncated = true;
              break;
            }
            await walk(join(path, n));
          }
        } else if (s.isFile()) {
          bytes += s.size;
          fileCount++;
        }
      } catch {}
    };
    for (const p of paths) await walk(p);
    return { bytes, fileCount, exists, truncated };
  }

  private cachedProtectedSummary?: {
    at: number;
    rawGroups: Array<{
      id: string;
      title: string;
      subtitle: string;
      icon: string;
      bytes: number;
      fileCount: number;
      exists: boolean;
      truncated?: boolean;
    }>;
  };

  private async scanProtectedSummary(reclaimableAgentBytes = 0, reclaimableAgentFiles = 0) {
    let rawGroups = this.cachedProtectedSummary && Date.now() - this.cachedProtectedSummary.at < 60_000
      ? this.cachedProtectedSummary.rawGroups
      : undefined;

    if (!rawGroups) {
      const groups: Array<{ id: string; title: string; subtitle: string; icon: string; paths: string[] }> = [
        {
          id: 'workspace',
          title: '工作区与核心账号凭据',
          subtitle: 'User/globalStorage（OAuth 令牌库 state.vscdb）、Cookies、Local Storage 与工作区配置',
          icon: 'folder.badge.gearshape',
          paths: [
            join(this.profile, 'User'),
            ...STATEFUL_CACHE_NAMES.map(name => join(this.profile, name)),
          ],
        },
      ];
      const agentDir = this.officialAgentDir();
      if (agentDir) {
        const agentDirExists = Boolean(await lstat(agentDir).catch(() => null));
        groups.push({
          id: 'conversations',
          title: 'Agent 历史对话与上下文库',
          subtitle: '受保护的主对话、已归档对话、正式产物与站点会话',
          icon: 'bubble.left.and.bubble.right',
          paths: agentDirExists ? [agentDir] : [this.options.geminiDir!],
        });
      }
      if (this.options.stateDir) {
        groups.push({
          id: 'gravitybox',
          title: '多账号凭据与个人词典',
          subtitle: 'GravityBox 账号库、刷新凭据、用量账本与外置汉化词典',
          icon: 'person.text.rectangle',
          paths: [this.options.stateDir],
        });
      }
      rawGroups = await Promise.all(groups.map(async group => {
        const stats = await this.inspectReadOnlyPaths(group.paths);
        return {
          id: group.id,
          title: group.title,
          subtitle: group.subtitle,
          icon: group.icon,
          bytes: stats.bytes,
          fileCount: stats.fileCount,
          exists: stats.exists,
          truncated: stats.truncated,
        };
      }));
      this.cachedProtectedSummary = { at: Date.now(), rawGroups };
    }

    const protectedEntries = rawGroups.map(g => {
      if (g.id === 'conversations') {
        return {
          ...g,
          bytes: Math.max(0, g.bytes - reclaimableAgentBytes),
          fileCount: Math.max(0, g.fileCount - reclaimableAgentFiles),
          protected: true as const,
        };
      }
      return { ...g, protected: true as const };
    });

    return {
      protectedEntries,
      protectedBytes: protectedEntries.reduce((n, e) => n + e.bytes, 0),
      truncated: protectedEntries.some(e => e.truncated),
    };
  }

  async history() {
    const snapshots: Array<{
      id: string;
      at: string;
      timestamp: number;
      totalBytes: number;
      fileCount: number;
      items: string[];
      itemTitles: string[];
      movedCount: number;
      restorable: boolean;
      interrupted: boolean;
      restoredAt?: string;
    }> = [];
    try {
      const names = (await readdir(this.trash)).filter(n => /^GravityBox-缓存-\d+$/.test(n)).sort().reverse();
      for (const id of names.slice(0, 8)) {
        const dir = join(this.trash, id);
        try {
          const st = await lstat(dir);
          if (st.isSymbolicLink() || !st.isDirectory()) continue;
          const manifestRaw = await readFile(join(dir, '恢复清单.json'), 'utf8');
          const manifest = JSON.parse(manifestRaw);
          const moved = Array.isArray(manifest.moved) ? manifest.moved : [];
          const logicalSet = new Set<string>();
          let restorableCount = 0;
          let fallbackBytes = 0;
          let fallbackFiles = 0;
          for (const m of moved) {
            const toPath = typeof m?.to === 'string' ? m.to : '';
            const logicalName = typeof m?.entryName === 'string' && m.entryName
              ? m.entryName
              : (toPath ? basename(toPath) : '');
            if (logicalName) logicalSet.add(logicalName);
            if (toPath && !manifest.restoredAt) {
              try {
                const targetStat = await lstat(toPath);
                if (!targetStat.isSymbolicLink() && (targetStat.isDirectory() || targetStat.isFile())) {
                  restorableCount++;
                  if (typeof manifest.totalBytes !== 'number') {
                    const stats = await this.inspectReadOnlyPaths([toPath], 10000, 600);
                    fallbackBytes += stats.bytes;
                    fallbackFiles += stats.fileCount;
                  }
                }
              } catch {}
            }
          }
          const items = Array.from(logicalSet);
          const itemTitles = items.map(k => CACHE_METADATA[k]?.title ?? k);
          const tsMatch = id.match(/GravityBox-缓存-(\d+)/);
          const timestamp = tsMatch ? Number(tsMatch[1]) : Date.parse(manifest.at || '') || 0;
          snapshots.push({
            id,
            at: typeof manifest.at === 'string' ? manifest.at : new Date(timestamp).toISOString(),
            timestamp: Math.floor(timestamp / 1000),
            totalBytes: typeof manifest.totalBytes === 'number' ? manifest.totalBytes : fallbackBytes,
            fileCount: typeof manifest.fileCount === 'number' ? manifest.fileCount : fallbackFiles,
            items,
            itemTitles,
            movedCount: Array.isArray(manifest.scope) && manifest.scope.length > 0 ? manifest.scope.length : items.length || moved.length,
            restorable: !manifest.interrupted && !manifest.restoredAt && restorableCount > 0 && restorableCount === moved.length,
            interrupted: manifest.interrupted === true,
            ...(typeof manifest.restoredAt === 'string' ? { restoredAt: manifest.restoredAt } : {}),
          });
        } catch {}
      }
    } catch {}
    return snapshots;
  }

  async scan(scanOptions?: { retentionDays?: unknown }) {
    return this.mutex.run(async () => {
      const retentionDays = scanOptions?.retentionDays !== undefined
        ? normalizeRetentionDays(scanOptions.retentionDays)
        : this.lastRetentionDays;
      this.lastRetentionDays = retentionDays;

      const [baseEntries, extEntries, partCandidates, browserCandidates, agentConvTargets, _prewarmedProtected] = await Promise.all([
        Promise.all(CACHE_NAMES.map(name => this.inspectSingleProfileItem(name))),
        Promise.all(EXTENDED_CACHE_NAMES.map(async extName => {
          try {
            await lstat(join(this.profile, extName));
            return await this.inspectSingleProfileItem(extName);
          } catch {
            return null;
          }
        })),
        this.collectPartitionsCandidates(),
        this.collectBrowserProfileCandidates(),
        this.collectAgentConversationTargets(retentionDays),
        this.scanProtectedSummary(0, 0),
      ]);

      const windowDesc = retentionDays > 0 ? `${retentionDays} 天前` : '非活跃';
      const [partEntry, browserEntry, orphanEntry, taskStepEntry, verboseTranscriptEntry, subagentDbEntry] = await Promise.all([
        partCandidates.length > 0 ? this.inspectMultiTargetItem('PartitionsCache', partCandidates) : Promise.resolve(null),
        browserCandidates.length > 0 ? this.inspectMultiTargetItem('AgentBrowserCache', browserCandidates) : Promise.resolve(null),
        agentConvTargets.orphanTargets.length > 0
          ? this.inspectMultiTargetItem('OrphanAgentData', agentConvTargets.orphanTargets, {
              dynamicSubtitle: agentConvTargets.orphanConvCount > 0
                ? `含 ${agentConvTargets.orphanConvCount} 个已删主对话遗留的孤儿记录、崩溃日志与临时媒体`
                : CACHE_METADATA.OrphanAgentData!.subtitle,
              itemCount: agentConvTargets.orphanConvCount,
            })
          : Promise.resolve(null),
        agentConvTargets.taskStepTargets.length > 0
          ? this.inspectMultiTargetItem('AgentTaskStepLogs', agentConvTargets.taskStepTargets, {
              dynamicSubtitle: `${windowDesc}对话的后台终端日志、步骤输出与 scratch 草稿`,
            })
          : Promise.resolve(null),
        agentConvTargets.verboseTranscriptTargets.length > 0
          ? this.inspectMultiTargetItem('AgentVerboseTranscripts', agentConvTargets.verboseTranscriptTargets, {
              dynamicSubtitle: `${windowDesc}对话的 transcript_full 与分片镜像（保留紧凑版记录）`,
            })
          : Promise.resolve(null),
        agentConvTargets.subagentDbTargets.length > 0
          ? this.inspectMultiTargetItem('AgentSubagentDatabases', agentConvTargets.subagentDbTargets, {
              dynamicSubtitle: `${windowDesc}共 ${agentConvTargets.subagentCount} 个后台子智能体库（清理前自动归档 Token 账单）`,
              itemCount: agentConvTargets.subagentCount,
            })
          : Promise.resolve(null),
      ]);

      const dynamicEntries = [
        partEntry,
        browserEntry,
        orphanEntry,
        taskStepEntry,
        verboseTranscriptEntry,
        subagentDbEntry,
      ].filter((e): e is InspectedCacheEntry => e !== null && (e.bytes > 0 || !e.clearable));

      const fullEntries: InspectedCacheEntry[] = [
        ...baseEntries,
        ...extEntries.filter((e): e is InspectedCacheEntry => e !== null),
        ...dynamicEntries,
      ];

      const token = randomUUID();
      this.prepared = {
        token,
        at: Date.now(),
        retentionDays,
        entries: fullEntries.map(e => ({
          name: e.name,
          fingerprint: e.fingerprint,
          bytes: e.bytes,
          fileCount: e.fileCount,
          category: e.category,
          defaultSelected: e.defaultSelected,
          isSingleLegacyRoot: e.isSingleLegacyRoot,
          subTargets: e.subTargets,
        })),
        fingerprints: fullEntries.map(e => e.fingerprint),
      };

      const agentItemSet = new Set<string>([
        'AgentBrowserCache',
        'OrphanAgentData',
        'AgentTaskStepLogs',
        'AgentVerboseTranscripts',
        'AgentSubagentDatabases',
      ]);
      const reclaimableAgentBytes = fullEntries
        .filter(e => agentItemSet.has(e.name))
        .reduce((n, e) => n + e.bytes, 0);
      const reclaimableAgentFiles = fullEntries
        .filter(e => agentItemSet.has(e.name))
        .reduce((n, e) => n + e.fileCount, 0);

      const [running, browserBusy, protectedSummary, snapshots] = await Promise.all([
        this.running(),
        this.isBrowserProfileBusy(),
        this.scanProtectedSummary(reclaimableAgentBytes, reclaimableAgentFiles),
        this.history(),
      ]);

      const entries = fullEntries.map(({ isSingleLegacyRoot: _legacy, subTargets: _subs, ...publicEntry }) => publicEntry);
      const safeBytes = entries.filter(e => e.category === 'safe').reduce((n, e) => n + e.bytes, 0);
      const statefulBytes = entries.filter(e => e.category === 'stateful').reduce((n, e) => n + e.bytes, 0);

      return {
        ok: true,
        token,
        retentionDays,
        entries,
        safeBytes,
        statefulBytes,
        totalBytes: safeBytes + statefulBytes,
        totalFiles: entries.reduce((n, e) => n + e.fileCount, 0),
        protectedEntries: protectedSummary.protectedEntries,
        protectedBytes: protectedSummary.protectedBytes,
        truncated: protectedSummary.truncated === true,
        snapshots,
        running,
        browserBusy,
        scannedAt: Math.floor(Date.now() / 1000),
      };
    }, { label: '缓存扫描' });
  }

  async clear(token: unknown, selectedNames?: unknown, _options?: { force?: boolean }) {
    return this.mutex.run(async () => {
      const saved = this.prepared;
      this.prepared = undefined;
      if (!saved || saved.token !== token || Date.now() - saved.at > 120000) {
        throw Error('缓存清单已过期，请重新扫描');
      }
      if (await this.running()) {
        throw Error('请先退出 Antigravity，再清理缓存；未改动任何缓存');
      }
      const allowedSet = new Set<string>(ALL_ALLOWED_CACHE_NAMES);
      let targetNames: string[];
      if (Array.isArray(selectedNames) && selectedNames.length > 0) {
        targetNames = selectedNames.map(String).filter(n => allowedSet.has(n));
        if (targetNames.length === 0 || targetNames.length !== selectedNames.length) {
          throw Error('所选缓存项无效，请重新扫描后再试');
        }
      } else {
        targetNames = saved.entries.filter(e => e.defaultSelected !== false).map(e => e.name);
      }

      // 独立沙箱浏览器进程（如 MCP Chromium）占用时：局部跳过 AgentBrowserCache，不阻断其余项
      const skippedNames: string[] = [];
      if (targetNames.includes('AgentBrowserCache') && await this.isBrowserProfileBusy()) {
        targetNames = targetNames.filter(n => n !== 'AgentBrowserCache');
        skippedNames.push('AgentBrowserCache');
        if (targetNames.length === 0) {
          throw Error('独立浏览器沙箱正在使用中，请先关闭相关浏览器窗口后再清理该项');
        }
      }

      const targetSet = new Set(targetNames);
      const current: InspectedCacheEntry[] = [];
      for (const savedEntry of saved.entries) {
        if (!targetSet.has(savedEntry.name)) continue;
        const inspected = await this.inspectNamedEntry(savedEntry.name, saved.retentionDays);
        if (!inspected.clearable || inspected.fingerprint !== savedEntry.fingerprint) {
          throw Error('缓存内容或路径已变化，请重新扫描');
        }
        current.push(inspected);
      }

      // 前置钩子：在移动任何 Subagent / 孤儿 .db 之前，先固化本地 Token 用量事件与费率锁
      const usageDbsToArchive = current
        .flatMap(entry => entry.subTargets)
        .filter(sub => sub.isUsageDb)
        .map(sub => sub.path);
      if (usageDbsToArchive.length > 0 && this.options.archiveDatabases) {
        await this.options.archiveDatabases(usageDbsToArchive);
      }

      const usesMultiSchema = current.some(row => !row.isSingleLegacyRoot);
      const target = join(this.trash, `GravityBox-缓存-${Date.now()}`);
      await mkdir(target, { recursive: true, mode: 0o700 });

      const moved: Array<{
        entryName: string;
        from: string;
        to: string;
        sidecars: string[];
      }> = [];
      let clearedBytes = 0;
      let clearedFiles = 0;
      const movedLogicalNames = new Set<string>();
      let multiSeq = 0;

      try {
        for (const row of current) {
          if (!row.exists || row.subTargets.length === 0) continue;
          if (await this.running()) throw Error('应用已重新打开，停止清理');
          const recheck = row.isSingleLegacyRoot
            ? await this.inspectSingleProfileItem(row.name)
            : await this.inspectMultiTargetItem(row.name, row.subTargets);
          if (recheck.fingerprint !== row.fingerprint) throw Error('缓存正在变化，停止清理');

          for (const sub of row.subTargets) {
            const from = sub.path;
            if (!this.isAllowedTargetPath(from)) {
              throw Error(`清理路径超出安全边界（${row.name}）`);
            }
            let to: string;
            if (row.isSingleLegacyRoot && !usesMultiSchema) {
              to = join(target, row.name);
            } else if (row.isSingleLegacyRoot) {
              to = join(target, row.name);
            } else {
              const itemsDir = join(target, 'items', row.name);
              await mkdir(itemsDir, { recursive: true, mode: 0o700 });
              to = join(itemsDir, `${++multiSeq}-${basename(from)}`);
            }

            try {
              await rename(from, to);
            } catch (err) {
              throw Error(`移动缓存到废纸篓失败（${row.name}）: ${(err as Error).message}`);
            }

            const movedSidecars: string[] = [];
            for (const suffix of ['-journal', '-wal', '-shm']) {
              const sideFrom = `${from}${suffix}`, sideTo = `${to}${suffix}`;
              try {
                const st = await lstat(sideFrom);
                if (!st.isSymbolicLink() && st.isFile()) {
                  await rename(sideFrom, sideTo);
                  movedSidecars.push(suffix);
                }
              } catch (sideErr) {
                if ((sideErr as NodeJS.ErrnoException).code !== 'ENOENT') {
                  for (const rolledSuffix of movedSidecars) {
                    await rename(`${to}${rolledSuffix}`, `${from}${rolledSuffix}`).catch(() => {});
                  }
                  await rename(to, from).catch(() => {});
                  throw Error(`移动 ${row.name} 事务日志 (${suffix}) 失败: ${(sideErr as Error).message}`);
                }
              }
            }

            moved.push({ entryName: row.name, from, to, sidecars: movedSidecars });
          }

          movedLogicalNames.add(row.name);
          clearedBytes += row.bytes;
          clearedFiles += row.fileCount;
        }
      } catch (error) {
        const recovery = [];
        for (const item of [...moved].reverse()) {
          let restored = false;
          try {
            await lstat(item.from);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
              try {
                await mkdir(dirname(item.from), { recursive: true });
                await rename(item.to, item.from);
                restored = true;
              } catch {}
            }
          }
          const suffixes = item.sidecars.length > 0 ? item.sidecars : ['-journal', '-wal', '-shm'];
          for (const suffix of suffixes) {
            const sideTo = `${item.to}${suffix}`, sideFrom = `${item.from}${suffix}`;
            try {
              const st = await lstat(sideTo);
              if (!st.isSymbolicLink()) {
                await rename(sideTo, sideFrom).catch(() => {});
              }
            } catch {}
          }
          recovery.push({ entryName: item.entryName, from: item.from, to: item.to, restored });
        }
        await atomicJson(join(target, '恢复清单.json'), {
          schema: usesMultiSchema ? 2 : 1,
          at: new Date().toISOString(),
          moved: recovery,
          interrupted: true,
          scope: targetNames,
        });
        throw Error(`${(error as Error).message}。已尝试撤回本轮移动，恢复记录：${target}`);
      }

      this.cachedProtectedSummary = undefined;
      await atomicJson(join(target, '恢复清单.json'), {
        schema: usesMultiSchema ? 2 : 1,
        at: new Date().toISOString(),
        moved: moved.map(m => usesMultiSchema
          ? { entryName: m.entryName, from: m.from, to: m.to }
          : { from: m.from, to: m.to }
        ),
        totalBytes: clearedBytes,
        fileCount: clearedFiles,
        scope: targetNames,
      });

      if (this.options.onMutated) {
        await this.options.onMutated();
      }

      const movedItemCount = movedLogicalNames.size;
      const skipSuffix = skippedNames.length > 0 ? '（浏览器沙箱正在使用中，已自动跳过该项）' : '';
      return {
        ok: true,
        message: `已将 ${movedItemCount} 个存储维护项移到废纸篓；核心账号、主对话与历史账单完好保留${skipSuffix}`,
        moved: movedItemCount,
        movedPaths: moved.length,
        skipped: skippedNames,
        clearedBytes,
        clearedFiles,
        restorePath: target,
      };
    }, { label: '缓存清理' });
  }

  async restore(snapshotId: unknown) {
    return this.mutex.run(async () => {
      if (typeof snapshotId !== 'string' || !/^GravityBox-缓存-\d+$/.test(snapshotId)) {
        throw Error('无效的恢复快照标识');
      }
      if (await this.running()) {
        throw Error('请先退出 Antigravity，再恢复缓存快照');
      }
      const dir = join(this.trash, snapshotId);
      const dirStat = await lstat(dir).catch(() => null);
      if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        throw Error('废纸篓中未找到该缓存快照，可能已被系统清空');
      }
      const manifestPath = join(dir, '恢复清单.json');
      let manifest: any;
      try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      } catch {
        throw Error('恢复清单损坏，无法恢复');
      }
      if (manifest.interrupted) throw Error('该快照为中断回滚记录，无需再次恢复');
      if (manifest.restoredAt) throw Error('该缓存快照已经恢复过了');
      const moved = Array.isArray(manifest.moved) ? manifest.moved : [];
      if (moved.length === 0) throw Error('快照内没有可恢复的缓存目录');

      const isSchemaV2 = manifest.schema === 2;
      const allowedLegacySet = new Set<string>([
        ...ALL_ALLOWED_CACHE_NAMES,
        ...STATEFUL_CACHE_NAMES,
      ]);

      interface ValidatedMovePlan {
        label: string;
        entryName: string;
        expectedFrom: string;
        expectedTo: string;
        ownerRoot: string;
      }
      const plans: ValidatedMovePlan[] = [];
      const seenFromPaths = new Set<string>();
      const seenToPaths = new Set<string>();

      // === 阶段 1：全量预检 ===
      for (const item of moved) {
        const toPath = typeof item?.to === 'string' ? item.to : '';
        const fromPath = typeof item?.from === 'string' ? item.from : '';

        if (!isSchemaV2) {
          const name = basename(toPath);
          if (!name || !allowedLegacySet.has(name)) throw Error('快照包含未授权的目录名称，已拒绝恢复');
          if (seenToPaths.has(name)) throw Error(`快照清单中包含重复的缓存项 ${name}，已拒绝恢复`);
          seenToPaths.add(name);
          const expectedTo = join(dir, name);
          const expectedFrom = join(this.profile, name);
          if (toPath !== expectedTo) throw Error('快照路径校验不通过，已拒绝恢复');
          plans.push({
            label: name,
            entryName: name,
            expectedFrom,
            expectedTo,
            ownerRoot: resolve(this.profile),
          });
        } else {
          const entryName = typeof item?.entryName === 'string' ? item.entryName : basename(toPath);
          if (!entryName || !allowedLegacySet.has(entryName)) {
            throw Error('快照包含未授权的目录名称，已拒绝恢复');
          }
          if (!toPath || !fromPath || !isStrictSubpath(dir, toPath)) {
            throw Error('快照路径校验不通过，已拒绝恢复');
          }
          const ownerRoot = this.allowedRootDirs().find(r => isStrictSubpath(r, fromPath));
          if (!ownerRoot) {
            throw Error('快照原路径超出受控目录边界，已拒绝恢复');
          }
          const normFrom = resolve(fromPath);
          const normTo = resolve(toPath);
          if (seenFromPaths.has(normFrom) || seenToPaths.has(normTo)) {
            throw Error(`快照清单中包含重复的缓存项 ${entryName}，已拒绝恢复`);
          }
          seenFromPaths.add(normFrom);
          seenToPaths.add(normTo);
          plans.push({
            label: basename(normFrom),
            entryName,
            expectedFrom: normFrom,
            expectedTo: normTo,
            ownerRoot,
          });
        }
      }

      for (const plan of plans) {
        const toStat = await lstat(plan.expectedTo).catch(() => null);
        if (!toStat || toStat.isSymbolicLink()) {
          throw Error(`快照中的 ${plan.label} 已缺失或为符号链接，无法完整恢复`);
        }
        // 检查目标父目录链是否存在符号链接
        const relParent = relative(plan.ownerRoot, dirname(plan.expectedFrom));
        if (relParent && relParent !== '.') {
          let cursor = plan.ownerRoot;
          for (const seg of relParent.split(sep).filter(Boolean)) {
            cursor = join(cursor, seg);
            const pst = await lstat(cursor).catch(() => null);
            if (pst && pst.isSymbolicLink()) {
              throw Error(`目标父路径 ${seg} 存在符号链接，已拒绝恢复`);
            }
          }
        }
        for (const suffix of ['-journal', '-wal', '-shm']) {
          const sideTo = `${plan.expectedTo}${suffix}`;
          const sideStat = await lstat(sideTo).catch(() => null);
          if (sideStat && sideStat.isSymbolicLink()) {
            throw Error(`快照中的 ${plan.label} 日志 (${suffix}) 为符号链接，已拒绝恢复`);
          }
          const sideExisting = await lstat(`${plan.expectedFrom}${suffix}`).catch(() => null);
          if (sideExisting && sideExisting.isSymbolicLink()) {
            throw Error(`目标路径 ${plan.label}${suffix} 存在符号链接，已拒绝恢复`);
          }
        }
        const existingFrom = await lstat(plan.expectedFrom).catch(() => null);
        if (existingFrom && existingFrom.isSymbolicLink()) {
          throw Error(`目标路径 ${plan.label} 存在符号链接，已拒绝恢复`);
        }
      }

      // === 阶段 2：冲突安全位移（归档至 displaced/，严禁 rm 物理删除） ===
      const displacedDir = join(dir, 'displaced');
      const displacedItems: Array<{ original: string; displaced: string; isSidecar?: boolean }> = [];
      let dispSeq = 0;
      try {
        for (const plan of plans) {
          const existingFrom = await lstat(plan.expectedFrom).catch(() => null);
          if (existingFrom) {
            await mkdir(displacedDir, { recursive: true, mode: 0o700 });
            const prefix = isSchemaV2 ? `${++dispSeq}-${plan.label}` : plan.label;
            const displacedPath = join(displacedDir, `${prefix}.displaced-${Date.now()}`);
            await rename(plan.expectedFrom, displacedPath);
            displacedItems.push({ original: plan.expectedFrom, displaced: displacedPath });
          }
          for (const suffix of ['-journal', '-wal', '-shm']) {
            const sideFrom = `${plan.expectedFrom}${suffix}`;
            const sideStat = await lstat(sideFrom).catch(() => null);
            if (sideStat) {
              await mkdir(displacedDir, { recursive: true, mode: 0o700 });
              const prefix = isSchemaV2 ? `${++dispSeq}-${plan.label}${suffix}` : `${plan.label}${suffix}`;
              const sideDisplaced = join(displacedDir, `${prefix}.displaced-${Date.now()}`);
              await rename(sideFrom, sideDisplaced);
              displacedItems.push({ original: sideFrom, displaced: sideDisplaced, isSidecar: true });
            }
          }
        }
      } catch (displaceError) {
        for (const rec of [...displacedItems].reverse()) {
          await rename(rec.displaced, rec.original).catch(() => {});
        }
        throw Error(`冲突位移过程失败: ${(displaceError as Error).message}。已自动回滚恢复现场。`);
      }

      // === 阶段 3：原子还原与双向逆向回滚 ===
      const restoredRecords: Array<{ from: string; to: string }> = [];
      const restoredLogicalNames = new Set<string>();
      try {
        for (const plan of plans) {
          await mkdir(dirname(plan.expectedFrom), { recursive: true });
          await rename(plan.expectedTo, plan.expectedFrom);
          restoredRecords.push({ from: plan.expectedTo, to: plan.expectedFrom });
          for (const suffix of ['-journal', '-wal', '-shm']) {
            const sideTo = `${plan.expectedTo}${suffix}`, sideFrom = `${plan.expectedFrom}${suffix}`;
            const sideStat = await lstat(sideTo).catch(() => null);
            if (sideStat && !sideStat.isSymbolicLink() && sideStat.isFile()) {
              await rename(sideTo, sideFrom);
              restoredRecords.push({ from: sideTo, to: sideFrom });
            }
          }
          restoredLogicalNames.add(plan.entryName);
        }
      } catch (restoreError) {
        for (const rec of [...restoredRecords].reverse()) {
          await rename(rec.to, rec.from).catch(() => {});
        }
        for (const rec of [...displacedItems].reverse()) {
          await rename(rec.displaced, rec.original).catch(() => {});
        }
        throw Error(`还原快照过程失败: ${(restoreError as Error).message}。已自动双向回滚恢复现场。`);
      }

      // === 阶段 4：清单固化与完成标记 ===
      this.cachedProtectedSummary = undefined;
      const uniqueDisplacedCount = displacedItems.filter(d => !d.isSidecar).length;
      await atomicJson(manifestPath, {
        ...manifest,
        restoredAt: new Date().toISOString(),
        displacedCount: uniqueDisplacedCount,
        displaced: displacedItems.map(d => ({ from: d.original, to: d.displaced })),
      });

      if (this.options.onMutated) {
        await this.options.onMutated();
      }

      const restoredNames = Array.from(restoredLogicalNames);
      const restoredTitles = restoredNames.map(n => CACHE_METADATA[n]?.title ?? n);
      return {
        ok: true,
        restored: restoredNames.length,
        items: restoredNames,
        displacedCount: uniqueDisplacedCount,
        message: uniqueDisplacedCount > 0
          ? `已原位恢复 ${restoredTitles.join('、')}（原路径下新生成的 ${uniqueDisplacedCount} 项缓存已安全归档备查）`
          : `已原位恢复 ${restoredTitles.join('、')}`,
      };
    }, { label: '缓存恢复' });
  }
}
