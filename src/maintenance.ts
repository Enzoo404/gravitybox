import { allApplicationTargets } from './application-target.js';
import { lstat, readdir, rename, mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicJson } from './files.js';
import { ReentrantMutex } from './mutex.js';

export type CacheCategory = 'safe' | 'stateful';

export interface CacheItemMetadata {
  title: string;
  subtitle: string;
  icon: string;
  category: CacheCategory;
  defaultSelected: boolean;
  impactWarning?: string;
}

// 核心常驻无损缓存（始终展示，默认勾选）
export const CACHE_NAMES = ['Cache', 'Code Cache', 'GPUCache'] as const;

// 扩展无损加速与废弃垃圾缓存（存在时自动发现并纳入，默认勾选，应删尽删）
export const EXTENDED_CACHE_NAMES = [
  'DawnCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'CachedData',
  'CachedExtensionVSIXs',
  'CachedProfilesData',
  'Crashpad',
  'logs',
  'blob_storage',
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

export const ALL_SAFE_CACHE_NAMES = [...CACHE_NAMES, ...EXTENDED_CACHE_NAMES] as const;
export const ALL_ALLOWED_CACHE_NAMES = [...ALL_SAFE_CACHE_NAMES] as const;

export const CACHE_METADATA: Record<string, CacheItemMetadata> = {
  'Cache': {
    title: '网络与静态资源缓存',
    subtitle: '界面静态资源与临时网络响应数据',
    icon: 'internaldrive',
    category: 'safe',
    defaultSelected: true,
  },
  'Code Cache': {
    title: 'V8 字节码编译缓存',
    subtitle: 'JavaScript 与 WebAssembly 预编译加速缓存',
    icon: 'cpu',
    category: 'safe',
    defaultSelected: true,
  },
  'GPUCache': {
    title: '图形与着色器缓存',
    subtitle: 'Metal 与 WebGL 图形渲染管线编译产物',
    icon: 'sparkles.rectangle.stack',
    category: 'safe',
    defaultSelected: true,
  },
  'DawnCache': {
    title: 'WebGPU 图形加速缓存',
    subtitle: 'Dawn 引擎图形管线与计算着色器缓存',
    icon: 'cube.transparent',
    category: 'safe',
    defaultSelected: true,
  },
  'DawnWebGPUCache': {
    title: 'WebGPU 管线缓存',
    subtitle: 'WebGPU 渲染管线与着色器加速缓存',
    icon: 'cube.transparent',
    category: 'safe',
    defaultSelected: true,
  },
  'ShaderCache': {
    title: '底层着色器缓存',
    subtitle: '图形驱动预编译着色器残留数据',
    icon: 'sparkles.rectangle.stack',
    category: 'safe',
    defaultSelected: true,
  },
  'CachedData': {
    title: '工作区运行编译缓存',
    subtitle: '主进程与渲染进程预编译脚本缓存',
    icon: 'memorychip',
    category: 'safe',
    defaultSelected: true,
  },
  'CachedExtensionVSIXs': {
    title: '扩展安装包残留',
    subtitle: '插件安装与更新遗留的 VSIX 压缩包',
    icon: 'shippingbox',
    category: 'safe',
    defaultSelected: true,
  },
  'CachedProfilesData': {
    title: '配置快照临时缓存',
    subtitle: '工作区配置切换生成的临时加速缓存',
    icon: 'doc.badge.gearshape',
    category: 'safe',
    defaultSelected: true,
  },
  'Crashpad': {
    title: '崩溃转储与诊断残留',
    subtitle: '历史崩溃报告与废弃诊断转储文件',
    icon: 'exclamationmark.triangle',
    category: 'safe',
    defaultSelected: true,
  },
  'logs': {
    title: '历史运行日志',
    subtitle: '主进程、渲染进程与扩展宿主历史日志',
    icon: 'doc.text',
    category: 'safe',
    defaultSelected: true,
  },
  'blob_storage': {
    title: '临时二进制块缓存',
    subtitle: '运行期产生的临时二进制块数据',
    icon: 'archivebox',
    category: 'safe',
    defaultSelected: true,
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
    const prefixes = Array.from(new Set([appPath, ...allApplicationTargets().map(t => t.appPath)])).map(p => p + '/Contents/MacOS/');
    const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'command=']);
    return stdout.split('\n').some(line => {
      const trimmed = line.trim();
      return prefixes.some(prefix => trimmed.startsWith(prefix));
    });
  } catch {
    return false;
  }
}

export interface CacheMaintenanceOptions {
  appPath?: string;
  stateDir?: string;
  geminiDir?: string;
}

export class CacheMaintenance {
  private mutex = new ReentrantMutex();
  private prepared?: {
    token: string;
    at: number;
    entries: Array<{
      name: string;
      fingerprint: string;
      bytes: number;
      fileCount: number;
      category: CacheCategory;
      defaultSelected: boolean;
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

  private async inspect(name: string) {
    const meta: CacheItemMetadata = CACHE_METADATA[name] ?? {
      title: name,
      subtitle: `应用运行缓存目录（${name}）`,
      icon: 'folder',
      category: 'safe',
      defaultSelected: true,
    };
    const root = join(this.profile, name), items: string[] = [];
    let bytes = 0, count = 0, fileCount = 0, lastModifiedAt = 0;
    const deadline = Date.now() + 8000;
    try {
      const base = await lstat(this.profile);
      if (base.isSymbolicLink() || !base.isDirectory()) throw Error('缓存路径包含链接，已跳过');
      const walk = async (path: string) => {
        if (++count > 200000 || Date.now() > deadline) throw Error('目录过大，请手动检查');
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
      return {
        name,
        title: meta.title,
        subtitle: meta.subtitle,
        icon: meta.icon,
        category: meta.category,
        defaultSelected: meta.defaultSelected,
        ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
        bytes,
        fileCount,
        lastModifiedAt: lastModifiedAt > 0 ? Math.floor(lastModifiedAt / 1000) : 0,
        exists: true,
        clearable: true,
        fingerprint: createHash('sha256').update(items.join('\n')).digest('hex'),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          name,
          title: meta.title,
          subtitle: meta.subtitle,
          icon: meta.icon,
          category: meta.category,
          defaultSelected: meta.defaultSelected,
          ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
          bytes: 0,
          fileCount: 0,
          lastModifiedAt: 0,
          exists: false,
          clearable: true,
          fingerprint: 'missing',
        };
      }
      return {
        name,
        title: meta.title,
        subtitle: meta.subtitle,
        icon: meta.icon,
        category: meta.category,
        defaultSelected: meta.defaultSelected,
        ...(meta.impactWarning ? { impactWarning: meta.impactWarning } : {}),
        bytes: 0,
        fileCount: 0,
        lastModifiedAt: 0,
        exists: true,
        clearable: false,
        fingerprint: 'blocked',
        reason: (error as Error).message,
      };
    }
  }

  private async inspectReadOnlyPaths(paths: string[], limitCount = 60000, budgetMs = 2500) {
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
    value: {
      protectedEntries: Array<{
        id: string;
        title: string;
        subtitle: string;
        icon: string;
        bytes: number;
        fileCount: number;
        exists: boolean;
        truncated?: boolean;
        protected: true;
      }>;
      protectedBytes: number;
      truncated?: boolean;
    };
  };

  private async scanProtectedSummary() {
    if (this.cachedProtectedSummary && Date.now() - this.cachedProtectedSummary.at < 60_000) {
      return this.cachedProtectedSummary.value;
    }
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
    if (this.options.geminiDir) {
      groups.push({
        id: 'conversations',
        title: 'Agent 历史对话与上下文库',
        subtitle: '本地会话历史记录与模型调用统计数据库',
        icon: 'bubble.left.and.bubble.right',
        paths: [this.options.geminiDir],
      });
    }
    if (this.options.stateDir) {
      groups.push({
        id: 'gravitybox',
        title: '多账号凭据与个人词典',
        subtitle: 'GravityBox 账号库、刷新凭据与外置汉化词典',
        icon: 'person.text.rectangle',
        paths: [this.options.stateDir],
      });
    }
    const protectedEntries = await Promise.all(groups.map(async group => {
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
        protected: true as const,
      };
    }));
    const value = {
      protectedEntries,
      protectedBytes: protectedEntries.reduce((n, e) => n + e.bytes, 0),
      truncated: protectedEntries.some(e => e.truncated),
    };
    this.cachedProtectedSummary = { at: Date.now(), value };
    return value;
  }

  async history() {
    const snapshots: Array<{
      id: string;
      at: string;
      timestamp: number;
      totalBytes: number;
      fileCount: number;
      items: string[];
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
          const items: string[] = [];
          let restorableCount = 0;
          let fallbackBytes = 0;
          let fallbackFiles = 0;
          for (const m of moved) {
            const toPath = typeof m?.to === 'string' ? m.to : '';
            const name = toPath ? basename(toPath) : '';
            if (name) items.push(name);
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
          const tsMatch = id.match(/GravityBox-缓存-(\d+)/);
          const timestamp = tsMatch ? Number(tsMatch[1]) : Date.parse(manifest.at || '') || 0;
          snapshots.push({
            id,
            at: typeof manifest.at === 'string' ? manifest.at : new Date(timestamp).toISOString(),
            timestamp: Math.floor(timestamp / 1000),
            totalBytes: typeof manifest.totalBytes === 'number' ? manifest.totalBytes : fallbackBytes,
            fileCount: typeof manifest.fileCount === 'number' ? manifest.fileCount : fallbackFiles,
            items,
            movedCount: moved.length,
            restorable: !manifest.interrupted && !manifest.restoredAt && restorableCount > 0 && restorableCount === moved.length,
            interrupted: manifest.interrupted === true,
            ...(typeof manifest.restoredAt === 'string' ? { restoredAt: manifest.restoredAt } : {}),
          });
        } catch {}
      }
    } catch {}
    return snapshots;
  }

  async scan() {
    return this.mutex.run(async () => {
    const [baseEntries, extEntries] = await Promise.all([
      Promise.all(CACHE_NAMES.map(name => this.inspect(name))),
      Promise.all(EXTENDED_CACHE_NAMES.map(async extName => {
        try {
          await lstat(join(this.profile, extName));
          return await this.inspect(extName);
        } catch {
          return null;
        }
      })),
    ]);
    const entries = [
      ...baseEntries,
      ...extEntries.filter((e): e is NonNullable<typeof e> => e !== null),
    ];
    const token = randomUUID();
    this.prepared = {
      token,
      at: Date.now(),
      entries: entries.map(e => ({
        name: e.name,
        fingerprint: e.fingerprint,
        bytes: e.bytes,
        fileCount: e.fileCount,
        category: e.category,
        defaultSelected: e.defaultSelected,
      })),
      fingerprints: entries.map(e => e.fingerprint),
    };
    const [running, protectedSummary, snapshots] = await Promise.all([
      this.running(),
      this.scanProtectedSummary(),
      this.history(),
    ]);
    const safeBytes = entries.reduce((n, e) => n + e.bytes, 0);
    return {
      ok: true,
      token,
      entries,
      safeBytes,
      statefulBytes: 0,
      totalBytes: safeBytes,
      totalFiles: entries.reduce((n, e) => n + e.fileCount, 0),
      protectedEntries: protectedSummary.protectedEntries,
      protectedBytes: protectedSummary.protectedBytes,
      truncated: protectedSummary.truncated === true,
      snapshots,
      running,
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
    const targetSet = new Set(targetNames);
    const current = [];
    for (const savedEntry of saved.entries) {
      const inspected = await this.inspect(savedEntry.name);
      if (targetSet.has(savedEntry.name)) {
        if (!inspected.clearable || inspected.fingerprint !== savedEntry.fingerprint) {
          throw Error('缓存内容或路径已变化，请重新扫描');
        }
        current.push(inspected);
      }
    }
    const target = join(this.trash, `GravityBox-缓存-${Date.now()}`);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const moved: { from: string; to: string; name: string; bytes: number; fileCount: number; sidecars?: string[] }[] = [];
    try {
      for (const row of current) {
        if (!row.exists) continue;
        if (await this.running()) throw Error('应用已重新打开，停止清理');
        if ((await this.inspect(row.name)).fingerprint !== row.fingerprint) throw Error('缓存正在变化，停止清理');
        const from = join(this.profile, row.name), to = join(target, row.name);
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
        moved.push({ from, to, name: row.name, bytes: row.bytes, fileCount: row.fileCount, sidecars: movedSidecars });
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
              await rename(item.to, item.from);
              restored = true;
            } catch {}
          }
        }
        const suffixes = item.sidecars && item.sidecars.length > 0 ? item.sidecars : ['-journal', '-wal', '-shm'];
        for (const suffix of suffixes) {
          const sideTo = `${item.to}${suffix}`, sideFrom = `${item.from}${suffix}`;
          try {
            const st = await lstat(sideTo);
            if (!st.isSymbolicLink()) {
              await rename(sideTo, sideFrom).catch(() => {});
            }
          } catch {}
        }
        recovery.push({ from: item.from, to: item.to, restored });
      }
      await atomicJson(join(target, '恢复清单.json'), {
        at: new Date().toISOString(),
        moved: recovery,
        interrupted: true,
        scope: targetNames,
      });
      throw Error(`${(error as Error).message}。已尝试撤回本轮移动，恢复记录：${target}`);
    }
    const clearedBytes = moved.reduce((n, m) => n + m.bytes, 0);
    const clearedFiles = moved.reduce((n, m) => n + m.fileCount, 0);
    await atomicJson(join(target, '恢复清单.json'), {
      at: new Date().toISOString(),
      moved: moved.map(m => ({ from: m.from, to: m.to })),
      totalBytes: clearedBytes,
      fileCount: clearedFiles,
      scope: targetNames,
    });
    return {
      ok: true,
      message: `已将 ${moved.length} 个缓存项移到废纸篓；核心账号与对话数据完好保留`,
      moved: moved.length,
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

    // Older releases could create state-store snapshots. They remain recoverable
    // through this explicit, stopped-application restore, but never clearable.
    const allowedSet = new Set<string>([...ALL_ALLOWED_CACHE_NAMES, ...STATEFUL_CACHE_NAMES]);
    const seenNames = new Set<string>();

    // === 阶段 1：全量预检 ===
    for (const item of moved) {
      const toPath = typeof item?.to === 'string' ? item.to : '';
      const name = basename(toPath);
      if (!name || !allowedSet.has(name)) throw Error('快照包含未授权的目录名称，已拒绝恢复');
      if (seenNames.has(name)) throw Error(`快照清单中包含重复的缓存项 ${name}，已拒绝恢复`);
      seenNames.add(name);
      const expectedTo = join(dir, name);
      const expectedFrom = join(this.profile, name);
      if (toPath !== expectedTo) throw Error('快照路径校验不通过，已拒绝恢复');
      const toStat = await lstat(expectedTo).catch(() => null);
      if (!toStat || toStat.isSymbolicLink()) {
        throw Error(`快照中的 ${name} 已缺失或为符号链接，无法完整恢复`);
      }
      for (const suffix of ['-journal', '-wal', '-shm']) {
        const sideTo = `${expectedTo}${suffix}`;
        const sideStat = await lstat(sideTo).catch(() => null);
        if (sideStat && sideStat.isSymbolicLink()) {
          throw Error(`快照中的 ${name} 日志 (${suffix}) 为符号链接，已拒绝恢复`);
        }
        const sideExisting = await lstat(`${expectedFrom}${suffix}`).catch(() => null);
        if (sideExisting && sideExisting.isSymbolicLink()) {
          throw Error(`目标路径 ${name}${suffix} 存在符号链接，已拒绝恢复`);
        }
      }
      const existingFrom = await lstat(expectedFrom).catch(() => null);
      if (existingFrom && existingFrom.isSymbolicLink()) {
        throw Error(`目标路径 ${name} 存在符号链接，已拒绝恢复`);
      }
    }

    // === 阶段 2：冲突安全位移（归档至 displaced/，严禁 rm 物理删除） ===
    const displacedDir = join(dir, 'displaced');
    const displacedItems: Array<{ original: string; displaced: string; isCookiesSidecar?: boolean }> = [];
    try {
      for (const item of moved) {
        const name = basename(item.to);
        const expectedFrom = join(this.profile, name);
        const existingFrom = await lstat(expectedFrom).catch(() => null);
        if (existingFrom) {
          await mkdir(displacedDir, { recursive: true, mode: 0o700 });
          const displacedPath = join(displacedDir, `${name}.displaced-${Date.now()}`);
          await rename(expectedFrom, displacedPath);
          displacedItems.push({ original: expectedFrom, displaced: displacedPath });
        }
        for (const suffix of ['-journal', '-wal', '-shm']) {
          const sideFrom = `${expectedFrom}${suffix}`;
          const sideStat = await lstat(sideFrom).catch(() => null);
          if (sideStat) {
            await mkdir(displacedDir, { recursive: true, mode: 0o700 });
            const sideDisplaced = join(displacedDir, `${name}${suffix}.displaced-${Date.now()}`);
            await rename(sideFrom, sideDisplaced);
            displacedItems.push({ original: sideFrom, displaced: sideDisplaced, isCookiesSidecar: true });
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
    const restoredRecords: Array<{ from: string; to: string; isCookiesSidecar?: boolean }> = [];
    const restoredNames: string[] = [];
    try {
      for (const item of moved) {
        const name = basename(item.to);
        const expectedTo = join(dir, name);
        const expectedFrom = join(this.profile, name);
        await rename(expectedTo, expectedFrom);
        restoredRecords.push({ from: expectedTo, to: expectedFrom });
        for (const suffix of ['-journal', '-wal', '-shm']) {
          const sideTo = `${expectedTo}${suffix}`, sideFrom = `${expectedFrom}${suffix}`;
          const sideStat = await lstat(sideTo).catch(() => null);
          if (sideStat && !sideStat.isSymbolicLink() && sideStat.isFile()) {
            await rename(sideTo, sideFrom);
            restoredRecords.push({ from: sideTo, to: sideFrom, isCookiesSidecar: true });
          }
        }
        restoredNames.push(name);
      }
    } catch (restoreError) {
      // 发生错误，触发双向逆向回滚
      for (const rec of [...restoredRecords].reverse()) {
        await rename(rec.to, rec.from).catch(() => {});
      }
      for (const rec of [...displacedItems].reverse()) {
        await rename(rec.displaced, rec.original).catch(() => {});
      }
      throw Error(`还原快照过程失败: ${(restoreError as Error).message}。已自动双向回滚恢复现场。`);
    }

    // === 阶段 4：清单固化与完成标记 ===
    const uniqueDisplacedCount = displacedItems.filter(d => !d.isCookiesSidecar).length;
    await atomicJson(manifestPath, {
      ...manifest,
      restoredAt: new Date().toISOString(),
      displacedCount: uniqueDisplacedCount,
      displaced: displacedItems.map(d => ({ from: d.original, to: d.displaced })),
    });

    return {
      ok: true,
      restored: restoredNames.length,
      items: restoredNames,
      displacedCount: uniqueDisplacedCount,
      message: `已原位恢复 ${restoredNames.length} 个缓存项（${restoredNames.join('、')}）`,
    };
    }, { label: '缓存恢复' });
  }
}
