import { lstat, readdir, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ReentrantMutex } from './mutex.js';
import { executeMoves, reconcileMoves, readMaintenanceManifest, type JournalMove } from './maintenance-journal.js';
import {
  ALL_ALLOWED_CACHE_NAMES,
  CACHE_METADATA,
  CACHE_NAMES,
  EXTENDED_CACHE_NAMES,
  HISTORY_SLIMMING_NAMES,
  STATEFUL_CACHE_NAMES,
  antigravityRunning,
  browserProfileRunning,
  hasAntigravityCommand,
  hasBrowserProfileCommand,
  isStrictSubpath,
  normalizeRetentionDays,
  readProcessCommands,
  type CacheCategory,
  type CacheMaintenanceOptions,
  type InspectedCacheEntry,
  type SubTargetSpec,
} from './maintenance-catalog.js';
import {
  checkRunningConversation,
  collectAgentConversationTargets,
  collectBrowserProfileCandidates,
  collectPartitionsCandidates,
  inspectMultiTargetItem,
  inspectNamedEntry,
  inspectReadOnlyPaths,
  inspectSingleProfileItem,
  loadConversationIndex,
  type AgentConversationTargetsResult,
  type MaintenanceDiscoveryContext,
} from './maintenance-discovery.js';

export * from './maintenance-catalog.js';

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

  private async inspectProcessState(): Promise<{ running: boolean; browserBusy: boolean }> {
    const agentDir = this.officialAgentDir();
    const browserProfileDir = agentDir ? join(agentDir, 'browser_profile') : '';
    if (this.options.browserRunning) {
      const [running, browserBusy] = await Promise.all([
        this.running(),
        this.options.browserRunning(),
      ]);
      return { running, browserBusy };
    }
    const commands = await readProcessCommands();
    if (!commands) return { running: false, browserBusy: false };
    return {
      running: hasAntigravityCommand(commands, this.options.appPath),
      browserBusy: browserProfileDir ? hasBrowserProfileCommand(commands, browserProfileDir) : false,
    };
  }

  private async assertSafeDirectoryChain(
    rootDir: string,
    targetPath: string,
    options: { allowMissing?: boolean; boundaryError: string; rootError: string; segmentError: string }
  ): Promise<void> {
    const resolvedRoot = resolve(rootDir);
    const resolvedTarget = resolve(targetPath);
    if (!isStrictSubpath(resolvedRoot, resolvedTarget)) {
      throw Error(options.boundaryError);
    }
    const rootStat = await lstat(resolvedRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw Error(options.rootError);
    }
    let cursor = resolvedRoot;
    for (const seg of relative(resolvedRoot, dirname(resolvedTarget)).split(sep).filter(Boolean)) {
      cursor = join(cursor, seg);
      const st = options.allowMissing
        ? await lstat(cursor).catch(error => { if (error.code === 'ENOENT') return null; throw error; })
        : await lstat(cursor);
      if (st && (st.isSymbolicLink() || !st.isDirectory())) {
        throw Error(options.segmentError);
      }
    }
  }

  private async guardJournalMove(snapshot: string, move: JournalMove): Promise<void> {
    if (await this.running()) throw Error('请先退出 Antigravity，再恢复维护事务');
    for (const path of [move.from, move.to]) {
      const root = isStrictSubpath(snapshot, path) ? snapshot : this.allowedRootDirs().find(root => isStrictSubpath(root, path));
      if (!root) throw Error('维护事务路径超出受控目录');
      // Reject symlink ancestors even when the last few destination directories do not exist yet.
      await this.assertSafeDirectoryChain(root, path, {
        allowMissing: true,
        boundaryError: '维护事务路径超出受控目录',
        rootError: '维护事务根目录身份不匹配',
        segmentError: '维护事务父路径身份不匹配',
      });
    }
    if (move.from.includes('browser_profile') || move.to.includes('browser_profile')) {
      if (await this.isBrowserProfileBusy()) throw Error('独立浏览器仍在使用该路径，暂停恢复');
    }
  }

  private async recoverPendingSnapshots(): Promise<void> {
    if (await this.running()) return;
    const names = await readdir(this.trash).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const id of names.filter(name => /^GravityBox-缓存-\d+$/.test(name))) {
      const dir = join(this.trash, id), file = join(dir, '恢复清单.json');
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      try {
        const manifest = await readMaintenanceManifest(file);
        await reconcileMoves(file, manifest, move => this.guardJournalMove(dir, move));
      } catch { /* Keep the prepared plan visible; explicit restore can retry after conflicts are resolved. */ }
    }
  }

  private async ensureSafeAncestors(rootDir: string, targetPath: string): Promise<void> {
    await this.assertSafeDirectoryChain(rootDir, targetPath, {
      allowMissing: false,
      boundaryError: '缓存路径超出受控目录边界，已跳过',
      rootError: '缓存路径包含链接，已跳过',
      segmentError: '缓存含符号链接，已跳过',
    });
  }

  private discoveryContext(): MaintenanceDiscoveryContext {
    return {
      profile: this.profile,
      options: this.options,
      officialAgentDir: () => this.officialAgentDir(),
      allowedRootDirs: () => this.allowedRootDirs(),
      ensureSafeAncestors: (rootDir, targetPath) => this.ensureSafeAncestors(rootDir, targetPath),
    };
  }

  private inspectSingleProfileItem(name: string): Promise<InspectedCacheEntry> {
    return inspectSingleProfileItem(this.discoveryContext(), name);
  }

  private inspectMultiTargetItem(
    name: string,
    candidates: SubTargetSpec[],
    options?: { dynamicSubtitle?: string; itemCount?: number }
  ): Promise<InspectedCacheEntry> {
    return inspectMultiTargetItem(this.discoveryContext(), name, candidates, options);
  }

  private collectPartitionsCandidates(): Promise<SubTargetSpec[]> {
    return collectPartitionsCandidates(this.discoveryContext());
  }

  private collectBrowserProfileCandidates(): Promise<SubTargetSpec[]> {
    return collectBrowserProfileCandidates(this.discoveryContext());
  }

  async loadConversationIndex(agentDir: string) {
    return loadConversationIndex(agentDir);
  }

  async hasRunningConversation(): Promise<boolean> {
    return checkRunningConversation(this.officialAgentDir());
  }

  private collectAgentConversationTargets(retentionDays: number): Promise<AgentConversationTargetsResult> {
    return collectAgentConversationTargets(this.discoveryContext(), retentionDays);
  }

  private inspectNamedEntry(
    name: string,
    retentionDays: number,
    cachedAgentTargets?: AgentConversationTargetsResult
  ): Promise<InspectedCacheEntry> {
    return inspectNamedEntry(this.discoveryContext(), name, retentionDays, cachedAgentTargets);
  }

  private inspectReadOnlyPaths(paths: string[], limitCount = 80000, budgetMs = 2800) {
    return inspectReadOnlyPaths(paths, limitCount, budgetMs);
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
    await this.recoverPendingSnapshots();
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
          const pendingRecovery = ['prepared', 'recovery-required'].includes(manifest.transaction?.phase);
          const rolledBack = manifest.transaction?.phase === 'rolled-back' && manifest.transaction.purpose !== 'restore';
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
            restorable: pendingRecovery || (!rolledBack && !manifest.interrupted && !manifest.restoredAt && restorableCount > 0 && restorableCount === moved.length),
            interrupted: manifest.interrupted === true || pendingRecovery,
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
          ? this.inspectMultiTargetItem('OrphanAgentData', agentConvTargets.orphanTargets)
          : Promise.resolve(null),
        agentConvTargets.taskStepTargets.length > 0
          ? this.inspectMultiTargetItem('AgentTaskStepLogs', agentConvTargets.taskStepTargets, {
              dynamicSubtitle: `${windowDesc}对话的终端、步骤日志与草稿`,
            })
          : Promise.resolve(null),
        agentConvTargets.verboseTranscriptTargets.length > 0
          ? this.inspectMultiTargetItem('AgentVerboseTranscripts', agentConvTargets.verboseTranscriptTargets, {
              dynamicSubtitle: `${windowDesc}冗余转录（保留精简版记录）`,
            })
          : Promise.resolve(null),
        agentConvTargets.subagentDbTargets.length > 0
          ? this.inspectMultiTargetItem('AgentSubagentDatabases', agentConvTargets.subagentDbTargets, {
              dynamicSubtitle: `${windowDesc} ${agentConvTargets.subagentCount} 个子智能体库（账单已归档）`,
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

      const [procState, protectedSummary, snapshots] = await Promise.all([
        this.inspectProcessState(),
        this.scanProtectedSummary(reclaimableAgentBytes, reclaimableAgentFiles),
        this.history(),
      ]);
      const { running, browserBusy } = procState;

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
        uncertainConversations: { count: agentConvTargets.uncertainCount, message: '索引或父关系无法确认的会话已保护，未纳入安全清理' },
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
      const needsAgentTargets = targetNames.some(n =>
        n === 'OrphanAgentData' || (HISTORY_SLIMMING_NAMES as readonly string[]).includes(n)
      );
      const sharedAgentTargets = needsAgentTargets
        ? await this.collectAgentConversationTargets(saved.retentionDays)
        : undefined;
      for (const savedEntry of saved.entries) {
        if (!targetSet.has(savedEntry.name)) continue;
        const inspected = await this.inspectNamedEntry(savedEntry.name, saved.retentionDays, sharedAgentTargets);
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
      if (usageDbsToArchive.length > 0) {
        if (!this.options.archiveDatabases) throw Error('缺少完整用量归档服务，未移动任何会话数据库');
        await this.options.archiveDatabases(usageDbsToArchive);
      }

      const usesMultiSchema = current.some(row => !row.isSingleLegacyRoot);
      const target = join(this.trash, `GravityBox-缓存-${Date.now()}`);
      await mkdir(target, { recursive: true, mode: 0o700 });

      const moved: Array<{ entryName: string; from: string; to: string }> = [];
      const operations: JournalMove[] = [];
      let sequence = 0;
      const needPostArchiveRecheck = usageDbsToArchive.length > 0;
      for (const row of current) {
        if (!row.exists || !row.subTargets.length) continue;
        if (needPostArchiveRecheck) {
          const recheck = row.isSingleLegacyRoot
            ? await this.inspectSingleProfileItem(row.name)
            : await this.inspectMultiTargetItem(row.name, row.subTargets);
          if (recheck.fingerprint !== row.fingerprint) throw Error('缓存正在变化，停止清理');
        }
        for (const sub of row.subTargets) {
          if (!this.isAllowedTargetPath(sub.path)) throw Error('清理路径超出安全边界');
          const resolvedSub = resolve(sub.path);
          const forbiddenSegments = new Set(['User', 'Cookies', 'Local Storage', 'Session Storage', 'WebStorage', 'Network Persistent State', 'conversation_summaries.db', 'state.vscdb']);
          if (resolvedSub.split(sep).some(seg => forbiddenSegments.has(seg))) {
            throw Error('命中受保护的核心数据路径，已中止清理');
          }
          const to = row.isSingleLegacyRoot ? join(target, row.name)
            : join(target, 'items', row.name, `${++sequence}-${basename(sub.path)}`);
          moved.push({ entryName: row.name, from: sub.path, to });
          operations.push({ from: sub.path, to });
          for (const suffix of ['-journal', '-wal', '-shm']) {
            const stat = await lstat(sub.path + suffix).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
            if (stat) {
              if (stat.isSymbolicLink() || !stat.isFile()) throw Error('数据库事务日志身份不匹配');
              operations.push({ from: sub.path + suffix, to: to + suffix });
            }
          }
        }
      }
      const clearedBytes = current.reduce((sum, row) => sum + row.bytes, 0);
      const clearedFiles = current.reduce((sum, row) => sum + row.fileCount, 0);
      const movedLogicalNames = new Set(moved.map(row => row.entryName));
      const manifest = { schema: usesMultiSchema ? 2 : 1, at: new Date().toISOString(), moved,
        totalBytes: clearedBytes, fileCount: clearedFiles, scope: targetNames };
      await executeMoves(join(target, '恢复清单.json'), manifest, operations, move => this.guardJournalMove(target, move));
      this.cachedProtectedSummary = undefined;

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
        manifest = await readMaintenanceManifest(manifestPath);
      } catch {
        throw Error('恢复清单损坏，无法恢复');
      }
      if (manifest.transaction && ['prepared', 'recovery-required'].includes(manifest.transaction.phase)) {
        await reconcileMoves(manifestPath, manifest, move => this.guardJournalMove(dir, move));
        this.cachedProtectedSummary = undefined;
        await this.options.onMutated?.();
        return { ok: true, restored: 0, items: [], displacedCount: 0, message: '已恢复中断维护操作的原始现场' };
      }
      if (manifest.transaction?.phase === 'rolled-back' && manifest.transaction.purpose !== 'restore') throw Error('该维护事务已回滚，无需再次恢复');
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

      // Plan both displacement and restoration before the first rename. The reverse plan
      // also restores regenerated caches if the process exits halfway through restoration.
      const displacedDir = join(dir, 'displaced');
      const displacedItems: Array<{ original: string; displaced: string; isSidecar?: boolean }> = [];
      const operations: JournalMove[] = [];
      let sequence = 0;
      for (const plan of plans) {
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
          const original = plan.expectedFrom + suffix;
          const existing = await lstat(original).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (existing) {
            const displaced = join(displacedDir, `${plan.label}${suffix}.displaced-${Date.now()}-${++sequence}-${randomUUID()}`);
            displacedItems.push({ original, displaced, ...(suffix ? { isSidecar: true } : {}) });
            operations.push({ from: original, to: displaced });
          }
        }
      }
      for (const plan of plans) {
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
          const source = plan.expectedTo + suffix;
          if (await lstat(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
            operations.push({ from: source, to: plan.expectedFrom + suffix });
          }
        }
      }
      const uniqueDisplacedCount = displacedItems.filter(item => !item.isSidecar).length;
      await executeMoves(manifestPath, manifest, operations, move => this.guardJournalMove(dir, move), {
        restoredAt: new Date().toISOString(), displacedCount: uniqueDisplacedCount,
        displaced: displacedItems.map(item => ({ from: item.original, to: item.displaced })),
      });
      this.cachedProtectedSummary = undefined;
      const restoredLogicalNames = new Set(plans.map(plan => plan.entryName));

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
