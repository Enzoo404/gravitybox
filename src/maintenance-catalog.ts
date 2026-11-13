import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, relative, resolve, sep } from 'node:path';

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

export const PARTITION_SAFE_SUBDIRS = [
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

export const BROWSER_TOP_SAFE_SUBDIRS = [
  'GraphiteDawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'GrShaderCache',
  'component_crx_cache',
  'WasmTtsEngine',
  'Crashpad',
] as const;

export const BROWSER_PROFILE_SAFE_SUBDIRS = [
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

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
    subtitle: '界面资源与临时网络缓存',
    icon: 'internaldrive',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'Code Cache': {
    title: 'V8 字节码编译缓存',
    subtitle: 'JS / Wasm 预编译加速缓存',
    icon: 'cpu',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'GPUCache': {
    title: '图形与着色器缓存',
    subtitle: 'Metal 与 WebGL 着色器缓存',
    icon: 'sparkles.rectangle.stack',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'DawnCache': {
    title: 'WebGPU 图形加速缓存',
    subtitle: 'Dawn 引擎图形管线缓存',
    icon: 'cube.transparent',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'DawnWebGPUCache': {
    title: 'WebGPU 管线缓存',
    subtitle: 'WebGPU 管线与着色器缓存',
    icon: 'cube.transparent',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'DawnGraphiteCache': {
    title: 'Graphite 渲染管线缓存',
    subtitle: 'Chromium 图形管线预编译缓存',
    icon: 'cube.transparent',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'GraphiteDawnCache': {
    title: 'Graphite 着色器加速缓存',
    subtitle: '图形后端着色器与管线缓存',
    icon: 'sparkles.rectangle.stack',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'ShaderCache': {
    title: '底层着色器缓存',
    subtitle: '图形驱动预编译着色器缓存',
    icon: 'sparkles.rectangle.stack',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'CachedData': {
    title: '工作区运行编译缓存',
    subtitle: '主进程与渲染进程脚本缓存',
    icon: 'memorychip',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'CachedExtensionVSIXs': {
    title: '扩展安装包残留',
    subtitle: '插件安装遗留的 VSIX 压缩包',
    icon: 'shippingbox',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'CachedProfilesData': {
    title: '配置快照临时缓存',
    subtitle: '配置切换生成的临时加速缓存',
    icon: 'doc.badge.gearshape',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'Crashpad': {
    title: '崩溃转储与诊断残留',
    subtitle: '历史崩溃报告与诊断转储',
    icon: 'exclamationmark.triangle',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'logs': {
    title: '历史运行日志',
    subtitle: '应用与扩展宿主运行日志',
    icon: 'doc.text',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'blob_storage': {
    title: '临时二进制块缓存',
    subtitle: '运行期临时二进制块数据',
    icon: 'archivebox',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'PartitionsCache': {
    title: '内嵌视图子分区缓存',
    subtitle: '隔离视图静态资源与编译缓存',
    icon: 'square.split.2x2',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'AgentBrowserCache': {
    title: '浏览器沙箱加速缓存',
    subtitle: '内置浏览器缓存（保留登录与 Cookie）',
    icon: 'globe',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'OrphanAgentData': {
    title: '崩溃日志与临时媒体',
    subtitle: '已删对话碎片、崩溃日志与临时媒体',
    icon: 'trash.slash',
    category: 'safe',
    section: 'runtime',
    defaultSelected: true,
  },
  'AgentTaskStepLogs': {
    title: '历史任务与步骤输出日志',
    subtitle: '非活跃对话的终端、步骤日志与草稿',
    icon: 'terminal',
    category: 'stateful',
    section: 'history',
    defaultSelected: false,
    impactWarning: '清理中间运行日志，主对话与正式产物完好保留',
  },
  'AgentVerboseTranscripts': {
    title: '全量冗余转录与分片镜像',
    subtitle: '非活跃对话冗余转录（保留精简版）',
    icon: 'doc.on.doc',
    category: 'stateful',
    section: 'history',
    defaultSelected: false,
    impactWarning: '仅移除冗余大体积镜像，对话界面与紧凑版记录不受影响',
  },
  'AgentSubagentDatabases': {
    title: '历史子智能体轨迹库',
    subtitle: '已完成子智能体库（账单已归档）',
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

const execFileAsync = promisify(execFile);

export async function readProcessCommands(): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'command='], { timeout: 3000 });
    return stdout.split('\n').map(line => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

export function hasAntigravityCommand(commands: string[], appPath = '/Applications/Antigravity.app'): boolean {
  const appRoots = Array.from(new Set([appPath, '/Applications/Antigravity.app']));
  const macOsPrefixes = appRoots.map(p => p + '/Contents/MacOS/');
  const lsPrefixes = appRoots.map(p => p + '/Contents/Resources/bin/language_server');
  return commands.some(trimmed =>
    macOsPrefixes.some(prefix => trimmed.startsWith(prefix)) ||
    lsPrefixes.some(prefix => trimmed.startsWith(prefix) || trimmed.includes(prefix))
  );
}

export function hasBrowserProfileCommand(commands: string[], browserProfileDir: string): boolean {
  if (!browserProfileDir) return false;
  return commands.some(trimmed => trimmed.includes(browserProfileDir) && !trimmed.includes('/bin/ps'));
}

export async function antigravityRunning(appPath = '/Applications/Antigravity.app') {
  const commands = await readProcessCommands();
  return commands ? hasAntigravityCommand(commands, appPath) : false;
}

export async function browserProfileRunning(browserProfileDir: string): Promise<boolean> {
  if (!browserProfileDir) return false;
  const commands = await readProcessCommands();
  return commands ? hasBrowserProfileCommand(commands, browserProfileDir) : false;
}

export interface CacheMaintenanceOptions {
  appPath?: string;
  stateDir?: string;
  geminiDir?: string;
  browserRunning?: () => Promise<boolean>;
  archiveDatabases?: (dbPaths: string[]) => Promise<unknown>;
  onMutated?: () => void | Promise<void>;
}

export interface SubTargetSpec {
  path: string;
  isUsageDb?: boolean;
}

export interface InspectedCacheEntry {
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

export interface ConversationIndexSnapshot {
  available: boolean;
  summaryMap: Map<string, { parentId: string; status: string }>;
  runningTreeIds: Set<string>;
  archivedTreeIds: Set<string>;
}

export function isStrictSubpath(parentDir: string, candidatePath: string): boolean {
  const rel = relative(resolve(parentDir), resolve(candidatePath));
  return Boolean(rel && !rel.startsWith('..') && !rel.includes(`..${sep}`) && rel !== '.');
}

