import { lstat, readdir, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ReentrantMutex } from './mutex.js';
import { executeMoves, reconcileMoves, readMaintenanceManifest, type JournalMove } from './maintenance-journal.js';
import {
  ALL_ALLOWED_CACHE_NAMES,
  CACHE_NAMES,
  EXTENDED_CACHE_NAMES,
  HISTORY_SLIMMING_NAMES,
  STATEFUL_CACHE_NAMES,
  antigravityRunning,
  browserProfileRunning,
  getCacheMetadata,
  hasAntigravityCommand,
  hasBrowserProfileCommand,
  isStrictSubpath,
  namesForMaintenanceScopes,
  normalizeMaintenanceScopes,
  normalizeRetentionDays,
  readProcessCommands,
  type CacheCategory,
  type CacheMaintenanceOptions,
  type InspectedCacheEntry,
  type MaintenanceScope,
  type SubTargetSpec,
} from './maintenance-catalog.js';
import { bt } from './i18n.js';
import { defaultGravityBoxCacheDir, defaultTrashDir } from './platform.js';
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

function isTrashPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

function formatClearedBytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
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
    private trash = defaultTrashDir(homedir()),
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

  private fallbackTrashDir(): string {
    if (this.options.fallbackTrashDir) {
      return resolve(this.options.fallbackTrashDir);
    }
    if (this.options.stateDir) {
      return join(resolve(this.options.stateDir), 'maintenance-trash');
    }
    return join(defaultGravityBoxCacheDir(homedir()), 'maintenance-trash');
  }

  private candidateTrashDirs(): string[] {
    return Array.from(new Set([resolve(this.trash), this.fallbackTrashDir()]));
  }

  private async isPrimaryTrashAccessible(): Promise<boolean> {
    try {
      await readdir(resolve(this.trash));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      if (isTrashPermissionError(error)) return false;
      return false;
    }
  }

  private async collectSupersededFallbackSnapshots(
    currentSnapshotId: string,
    keepLocalSnapshots = 1,
  ): Promise<string[]> {
    const fallbackRoot = this.fallbackTrashDir();
    let names: string[];
    try {
      names = await readdir(fallbackRoot);
    } catch {
      return [];
    }
    const discovered: Array<{ id: string; numericTs: number }> = [];
    for (const name of names) {
      const m = name.match(/^GravityBox-缓存-(\d+)$/);
      if (!m) continue;
      discovered.push({ id: name, numericTs: Number(m[1]) || 0 });
    }
    discovered.sort((a, b) => b.numericTs - a.numericTs || b.id.localeCompare(a.id));

    const maxKeep = Math.max(0, Math.min(8, Math.floor(keepLocalSnapshots)));
    let keptRestorable = 0;
    const superseded: string[] = [];

    for (const { id } of discovered) {
      const dir = resolve(join(fallbackRoot, id));
      if (!isStrictSubpath(fallbackRoot, dir)) continue;
      const st = await lstat(dir).catch(() => null);
      if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
      try {
        const manifestRaw = await readFile(join(dir, '恢复清单.json'), 'utf8');
        const manifest = JSON.parse(manifestRaw);
        const phase = manifest?.transaction?.phase;
        if (phase === 'prepared' || phase === 'recovery-required') {
          continue;
        }
        const rolledBack = phase === 'rolled-back' && manifest?.transaction?.purpose !== 'restore';
        const isRestorable = !rolledBack && !manifest?.interrupted && !manifest?.restoredAt;
        if (id === currentSnapshotId && maxKeep >= 1) {
          keptRestorable++;
          continue;
        }
        if (isRestorable && keptRestorable < maxKeep) {
          keptRestorable++;
          continue;
        }
        superseded.push(dir);
      } catch {
        // 无法解析清单的目录保持不动，避免误触异常现场
      }
    }
    return superseded;
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
    if (await this.running()) throw Error(bt('maintenance.err.quit_before_recovery'));
    for (const path of [move.from, move.to]) {
      const root = isStrictSubpath(snapshot, path) ? snapshot : this.allowedRootDirs().find(root => isStrictSubpath(root, path));
      if (!root) throw Error(bt('maintenance.err.tx_out_of_bounds'));
      // Reject symlink ancestors even when the last few destination directories do not exist yet.
      await this.assertSafeDirectoryChain(root, path, {
        allowMissing: true,
        boundaryError: bt('maintenance.err.tx_out_of_bounds'),
        rootError: bt('maintenance.err.tx_root_mismatch'),
        segmentError: bt('maintenance.err.tx_parent_mismatch'),
      });
    }
    if (move.from.includes('browser_profile') || move.to.includes('browser_profile')) {
      if (await this.isBrowserProfileBusy()) throw Error(bt('maintenance.err.browser_busy_pause'));
    }
  }

  private async recoverPendingSnapshots(): Promise<void> {
    if (await this.running()) return;
    for (const vaultRoot of this.candidateTrashDirs()) {
      let names: string[];
      try {
        names = await readdir(vaultRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || isTrashPermissionError(error)) continue;
        throw error;
      }
      for (const id of names.filter(name => /^GravityBox-缓存-\d+$/.test(name))) {
        const dir = join(vaultRoot, id), file = join(dir, '恢复清单.json');
        const stat = await lstat(dir).catch(() => null);
        if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
        try {
          const manifest = await readMaintenanceManifest(file);
          await reconcileMoves(file, manifest, move => this.guardJournalMove(dir, move));
        } catch { /* Keep the prepared plan visible; explicit restore can retry after conflicts are resolved. */ }
      }
    }
  }

  private async ensureSafeAncestors(rootDir: string, targetPath: string): Promise<void> {
    await this.assertSafeDirectoryChain(rootDir, targetPath, {
      allowMissing: false,
      boundaryError: bt('maintenance.err.out_of_bounds_skipped'),
      rootError: bt('maintenance.err.path_link_skipped'),
      segmentError: bt('maintenance.err.symlink_skipped'),
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

  private inspectReadOnlyPaths(paths: string[], limitCount = 80000, budgetMs = 2800, excludePaths?: ReadonlySet<string>) {
    return inspectReadOnlyPaths(paths, limitCount, budgetMs, excludePaths);
  }

  private cachedProtectedSummary?: {
    at: number;
    retentionDays: number;
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

  private async scanProtectedSummary(
    retentionDays = this.lastRetentionDays,
    precomputed?: {
      browserSpecs: SubTargetSpec[];
      agentTargets: AgentConversationTargetsResult;
    }
  ) {
    let rawGroups = this.cachedProtectedSummary
      && this.cachedProtectedSummary.retentionDays === retentionDays
      && Date.now() - this.cachedProtectedSummary.at < 60_000
      ? this.cachedProtectedSummary.rawGroups
      : undefined;

    if (!rawGroups) {
      const groups: Array<{ id: string; title: string; subtitle: string; icon: string; paths: string[]; excludePaths?: ReadonlySet<string> }> = [
        {
          id: 'workspace',
          title: bt('maintenance.protected.workspace.title'),
          subtitle: bt('maintenance.protected.workspace.sub'),
          icon: 'folder.badge.gearshape',
          paths: [
            join(this.profile, 'User'),
            ...STATEFUL_CACHE_NAMES.map(name => join(this.profile, name)),
          ],
        },
      ];
      const agentDir = this.officialAgentDir();
      if (agentDir) {
        const [agentDirStat, browserCacheSpecs, agentTargets] = await Promise.all([
          lstat(agentDir).catch(() => null),
          precomputed ? Promise.resolve(precomputed.browserSpecs) : this.collectBrowserProfileCandidates(),
          precomputed ? Promise.resolve(precomputed.agentTargets) : this.collectAgentConversationTargets(retentionDays),
        ]);
        const agentDirExists = Boolean(agentDirStat);
        const convExcludeSet = new Set<string>();
        for (const spec of browserCacheSpecs) convExcludeSet.add(spec.path);
        for (const spec of agentTargets.orphanTargets) convExcludeSet.add(spec.path);
        for (const spec of agentTargets.taskStepTargets) convExcludeSet.add(spec.path);
        for (const spec of agentTargets.verboseTranscriptTargets) convExcludeSet.add(spec.path);
        for (const spec of agentTargets.subagentDbTargets) {
          convExcludeSet.add(spec.path);
          for (const suffix of ['-journal', '-wal', '-shm']) {
            convExcludeSet.add(`${spec.path}${suffix}`);
          }
        }
        groups.push({
          id: 'conversations',
          title: bt('maintenance.protected.conversations.title'),
          subtitle: bt('maintenance.protected.conversations.sub'),
          icon: 'bubble.left.and.bubble.right',
          paths: agentDirExists ? [agentDir] : [this.options.geminiDir!],
          excludePaths: convExcludeSet,
        });
      }
      if (this.options.stateDir) {
        groups.push({
          id: 'gravitybox',
          title: bt('maintenance.protected.gravitybox.title'),
          subtitle: bt('maintenance.protected.gravitybox.sub'),
          icon: 'person.text.rectangle',
          paths: [this.options.stateDir],
          excludePaths: new Set([this.fallbackTrashDir()]),
        });
      }
      rawGroups = await Promise.all(groups.map(async group => {
        const stats = await this.inspectReadOnlyPaths(group.paths, 80000, 2800, group.excludePaths);
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
      this.cachedProtectedSummary = { at: Date.now(), retentionDays, rawGroups };
    }

    const protectedEntries = rawGroups.map(g => {
      const title = bt(`maintenance.protected.${g.id}.title`, undefined, g.title);
      const subtitle = bt(`maintenance.protected.${g.id}.sub`, undefined, g.subtitle);
      return { ...g, title, subtitle, protected: true as const };
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
      snapshotPath: string;
      restoredAt?: string;
    }> = [];

    const discovered: Array<{ vaultRoot: string; id: string; numericTs: number }> = [];
    const seenIds = new Set<string>();
    for (const vaultRoot of this.candidateTrashDirs()) {
      let names: string[];
      try {
        names = await readdir(vaultRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || isTrashPermissionError(error)) continue;
        continue;
      }
      for (const name of names) {
        const m = name.match(/^GravityBox-缓存-(\d+)$/);
        if (!m || seenIds.has(name)) continue;
        seenIds.add(name);
        discovered.push({ vaultRoot, id: name, numericTs: Number(m[1]) || 0 });
      }
    }
    discovered.sort((a, b) => b.numericTs - a.numericTs || b.id.localeCompare(a.id));

    for (const { vaultRoot, id, numericTs } of discovered.slice(0, 8)) {
      const dir = join(vaultRoot, id);
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
        const itemTitles = items.map(k => getCacheMetadata(k)?.title ?? k);
        const timestamp = numericTs || Date.parse(manifest.at || '') || 0;
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
          snapshotPath: dir,
          ...(typeof manifest.restoredAt === 'string' ? { restoredAt: manifest.restoredAt } : {}),
        });
      } catch {}
    }
    return snapshots;
  }

  async scan(scanOptions?: { retentionDays?: unknown }) {
    return this.mutex.run(async () => {
      const retentionDays = scanOptions?.retentionDays !== undefined
        ? normalizeRetentionDays(scanOptions.retentionDays)
        : this.lastRetentionDays;
      this.lastRetentionDays = retentionDays;

      const [baseEntries, extEntries, partCandidates, browserCandidates, agentConvTargets] = await Promise.all([
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
      ]);

      const windowDesc = retentionDays > 0 ? bt('maintenance.window.days_ago', { days: retentionDays }) : bt('maintenance.window.inactive');
      const [
        partEntry,
        browserEntry,
        orphanEntry,
        taskStepEntry,
        verboseTranscriptEntry,
        subagentDbEntry,
        procState,
        protectedSummary,
        snapshots,
        primaryAccessible,
      ] = await Promise.all([
        partCandidates.length > 0 ? this.inspectMultiTargetItem('PartitionsCache', partCandidates) : Promise.resolve(null),
        browserCandidates.length > 0 ? this.inspectMultiTargetItem('AgentBrowserCache', browserCandidates) : Promise.resolve(null),
        agentConvTargets.orphanTargets.length > 0
          ? this.inspectMultiTargetItem('OrphanAgentData', agentConvTargets.orphanTargets)
          : Promise.resolve(null),
        agentConvTargets.taskStepTargets.length > 0
          ? this.inspectMultiTargetItem('AgentTaskStepLogs', agentConvTargets.taskStepTargets, {
              dynamicSubtitle: bt('maintenance.dynamic.task_step_sub', { windowDesc }),
            })
          : Promise.resolve(null),
        agentConvTargets.verboseTranscriptTargets.length > 0
          ? this.inspectMultiTargetItem('AgentVerboseTranscripts', agentConvTargets.verboseTranscriptTargets, {
              dynamicSubtitle: bt('maintenance.dynamic.verbose_sub', { windowDesc }),
            })
          : Promise.resolve(null),
        agentConvTargets.subagentDbTargets.length > 0
          ? this.inspectMultiTargetItem('AgentSubagentDatabases', agentConvTargets.subagentDbTargets, {
              dynamicSubtitle: bt('maintenance.dynamic.subagent_sub', { windowDesc, count: agentConvTargets.subagentCount }),
              itemCount: agentConvTargets.subagentCount,
            })
          : Promise.resolve(null),
        this.inspectProcessState(),
        this.scanProtectedSummary(retentionDays, {
          browserSpecs: browserCandidates,
          agentTargets: agentConvTargets,
        }),
        this.history(),
        this.isPrimaryTrashAccessible(),
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

      const { running, browserBusy } = procState;
      const usingFallbackTrash = !primaryAccessible;
      const trashDir = primaryAccessible ? resolve(this.trash) : this.fallbackTrashDir();

      const entries = fullEntries.map(({ isSingleLegacyRoot: _legacy, subTargets: _subs, ...publicEntry }) => publicEntry);
      const safeBytes = entries.filter(e => e.category === 'safe').reduce((n, e) => n + e.bytes, 0);
      const statefulBytes = entries.filter(e => e.category === 'stateful').reduce((n, e) => n + e.bytes, 0);

      const clearableSafeEntries = entries.filter(e => e.category === 'safe' && e.clearable !== false && e.bytes > 0);
      const clearableHistoryEntries = entries.filter(e => e.category === 'stateful' && e.clearable !== false && e.bytes > 0);
      const runtimeClearableBytes = clearableSafeEntries.reduce((n, e) => n + e.bytes, 0);
      const runtimeClearableFiles = clearableSafeEntries.reduce((n, e) => n + e.fileCount, 0);
      const historyClearableBytes = clearableHistoryEntries.reduce((n, e) => n + e.bytes, 0);
      const historyClearableFiles = clearableHistoryEntries.reduce((n, e) => n + e.fileCount, 0);

      const firstRestorable = snapshots.find(s => s.restorable === true);
      const latestRestorableSnapshot = firstRestorable
        ? {
            id: firstRestorable.id,
            at: firstRestorable.at,
            timestamp: firstRestorable.timestamp,
            totalBytes: firstRestorable.totalBytes,
            fileCount: firstRestorable.fileCount,
            snapshotPath: firstRestorable.snapshotPath,
          }
        : null;

      return {
        ok: true,
        token,
        retentionDays,
        entries,
        buckets: {
          runtimeCache: {
            id: 'runtime_cache' as const,
            bytes: runtimeClearableBytes,
            clearableBytes: runtimeClearableBytes,
            fileCount: runtimeClearableFiles,
            available: runtimeClearableBytes > 0,
          },
          historyLogs: {
            id: 'history_logs' as const,
            bytes: historyClearableBytes,
            clearableBytes: historyClearableBytes,
            fileCount: historyClearableFiles,
            subagentCount: agentConvTargets.subagentCount,
            retentionDays,
            available: historyClearableBytes > 0,
          },
        },
        safeBytes,
        statefulBytes,
        totalBytes: safeBytes + statefulBytes,
        totalFiles: entries.reduce((n, e) => n + e.fileCount, 0),
        uncertainConversations: { count: agentConvTargets.uncertainCount, message: bt('maintenance.scan.uncertain_msg') },
        protectedEntries: protectedSummary.protectedEntries,
        protectedBytes: protectedSummary.protectedBytes,
        truncated: protectedSummary.truncated === true,
        snapshots,
        latestRestorableSnapshot,
        trashDir,
        usingFallbackTrash,
        running,
        browserBusy,
        scannedAt: Math.floor(Date.now() / 1000),
      };
    }, { label: bt('maintenance.lock.scan') });
  }

  private async commitActiveRowsToVault(
    activeRows: InspectedCacheEntry[],
    scopeNames: string[],
    skippedNames: string[],
    options: { keepLocalSnapshots: number; simpleMessage: boolean },
  ) {
    // 前置钩子：在移动任何 Subagent / 孤儿 .db 之前，先固化本地 Token 用量事件与费率锁
    const usageDbsToArchive = activeRows
      .flatMap(entry => entry.subTargets)
      .filter(sub => sub.isUsageDb)
      .map(sub => sub.path);
    if (usageDbsToArchive.length > 0) {
      if (!this.options.archiveDatabases) throw Error(bt('maintenance.err.missing_archive_service'));
      await this.options.archiveDatabases(usageDbsToArchive);
    }

    const usesMultiSchema = activeRows.some(row => !row.isSingleLegacyRoot);
    const stamp = Date.now();
    const snapshotFolderName = `GravityBox-缓存-${stamp}`;
    const primaryRoot = resolve(this.trash);
    let vaultRoot = primaryRoot;
    let primaryUsable = true;
    try {
      await mkdir(primaryRoot, { recursive: true });
      await readdir(primaryRoot);
    } catch (error) {
      if (isTrashPermissionError(error)) {
        primaryUsable = false;
      } else {
        throw error;
      }
    }
    let target = join(vaultRoot, snapshotFolderName);
    if (primaryUsable) {
      try {
        await mkdir(target, { recursive: true, mode: 0o700 });
      } catch (error) {
        if (isTrashPermissionError(error)) {
          primaryUsable = false;
        } else {
          throw error;
        }
      }
    }
    if (!primaryUsable) {
      vaultRoot = this.fallbackTrashDir();
      target = join(vaultRoot, snapshotFolderName);
      await mkdir(target, { recursive: true, mode: 0o700 });
    }

    const moved: Array<{ entryName: string; from: string; to: string }> = [];
    const operations: JournalMove[] = [];
    let sequence = 0;
    const needPostArchiveRecheck = usageDbsToArchive.length > 0;
    for (const row of activeRows) {
      if (needPostArchiveRecheck) {
        const recheck = row.isSingleLegacyRoot
          ? await this.inspectSingleProfileItem(row.name)
          : await this.inspectMultiTargetItem(row.name, row.subTargets);
        if (recheck.fingerprint !== row.fingerprint) throw Error(bt('maintenance.err.cache_changing_stop'));
      }
      for (const sub of row.subTargets) {
        if (!this.isAllowedTargetPath(sub.path)) throw Error(bt('maintenance.err.clear_out_of_bounds'));
        const resolvedSub = resolve(sub.path);
        const forbiddenSegments = new Set(['User', 'Cookies', 'Local Storage', 'Session Storage', 'WebStorage', 'Network Persistent State', 'conversation_summaries.db', 'state.vscdb']);
        if (resolvedSub.split(sep).some(seg => forbiddenSegments.has(seg))) {
          throw Error(bt('maintenance.err.protected_path_hit'));
        }
        const to = row.isSingleLegacyRoot
          ? join(target, row.name)
          : join(target, 'items', row.name, `${++sequence}-${basename(sub.path)}`);
        moved.push({ entryName: row.name, from: sub.path, to });
        operations.push({ from: sub.path, to });
        for (const suffix of ['-journal', '-wal', '-shm']) {
          const stat = await lstat(sub.path + suffix).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (stat) {
            if (stat.isSymbolicLink() || !stat.isFile()) throw Error(bt('maintenance.err.wal_identity'));
            operations.push({ from: sub.path + suffix, to: to + suffix });
          }
        }
      }
    }

    const clearedBytes = activeRows.reduce((sum, row) => sum + row.bytes, 0);
    const clearedFiles = activeRows.reduce((sum, row) => sum + row.fileCount, 0);
    const movedLogicalNames = new Set(moved.map(row => row.entryName));
    const manifest = {
      schema: usesMultiSchema ? 2 : 1,
      at: new Date().toISOString(),
      moved,
      totalBytes: clearedBytes,
      fileCount: clearedFiles,
      scope: scopeNames,
    };
    await executeMoves(join(target, '恢复清单.json'), manifest, operations, move => this.guardJournalMove(target, move));
    this.cachedProtectedSummary = undefined;

    if (this.options.onMutated) {
      await this.options.onMutated();
    }

    const usingFallbackTrash = vaultRoot !== primaryRoot;
    const supersededSnapshotPaths = usingFallbackTrash
      ? await this.collectSupersededFallbackSnapshots(snapshotFolderName, options.keepLocalSnapshots)
      : [];

    const movedItemCount = movedLogicalNames.size;
    const hasSkippedBrowser = skippedNames.includes('AgentBrowserCache');
    const skipSuffix = hasSkippedBrowser ? bt('maintenance.clear.skip_browser_suffix') : '';
    const message = options.simpleMessage
      ? bt('maintenance.simple.cleared_msg', { size: formatClearedBytesLabel(clearedBytes), skipSuffix })
      : bt('maintenance.clear.success', { count: movedItemCount, skipSuffix });

    return {
      ok: true,
      message,
      moved: movedItemCount,
      movedPaths: moved.length,
      skipped: skippedNames,
      clearedBytes,
      clearedFiles,
      snapshotId: snapshotFolderName,
      restorePath: target,
      trashDir: vaultRoot,
      usingFallbackTrash,
      supersededSnapshotPaths,
    };
  }

  async smartClear(smartOptions?: {
    scopes?: unknown;
    retentionDays?: unknown;
    keepLocalSnapshots?: unknown;
  }) {
    return this.mutex.run(async () => {
      this.prepared = undefined;
      if (await this.running()) {
        throw Error(bt('maintenance.err.quit_before_clear'));
      }
      const scopes: MaintenanceScope[] = normalizeMaintenanceScopes(smartOptions?.scopes);
      const retentionDays = smartOptions?.retentionDays !== undefined
        ? normalizeRetentionDays(smartOptions.retentionDays)
        : this.lastRetentionDays;
      this.lastRetentionDays = retentionDays;
      const keepLocalSnapshots = typeof smartOptions?.keepLocalSnapshots === 'number' && Number.isFinite(smartOptions.keepLocalSnapshots)
        ? Math.max(0, Math.min(8, Math.floor(smartOptions.keepLocalSnapshots)))
        : 1;

      let candidateNames = namesForMaintenanceScopes(scopes);
      const skippedNames: string[] = [];
      if (candidateNames.includes('AgentBrowserCache') && await this.isBrowserProfileBusy()) {
        candidateNames = candidateNames.filter(n => n !== 'AgentBrowserCache');
        skippedNames.push('AgentBrowserCache');
      }

      const needsAgentTargets = candidateNames.some(n =>
        n === 'OrphanAgentData' || (HISTORY_SLIMMING_NAMES as readonly string[]).includes(n)
      );
      const sharedAgentTargets = needsAgentTargets
        ? await this.collectAgentConversationTargets(retentionDays)
        : undefined;

      const extSet = new Set<string>(EXTENDED_CACHE_NAMES);
      const inspectedList = await Promise.all(candidateNames.map(async name => {
        if (extSet.has(name)) {
          const exists = await lstat(join(this.profile, name)).then(() => true).catch(() => false);
          if (!exists) return null;
        }
        return await this.inspectNamedEntry(name, retentionDays, sharedAgentTargets);
      }));

      const activeRows: InspectedCacheEntry[] = [];
      for (const inspected of inspectedList) {
        if (!inspected) continue;
        if (!inspected.clearable) {
          skippedNames.push(inspected.name);
          continue;
        }
        if (inspected.exists && inspected.bytes > 0 && inspected.subTargets.length > 0) {
          activeRows.push(inspected);
        }
      }

      if (activeRows.length === 0) {
        this.cachedProtectedSummary = undefined;
        const primaryAccessible = await this.isPrimaryTrashAccessible();
        return {
          ok: true,
          scopes,
          message: bt('maintenance.simple.nothing_cleared'),
          moved: 0,
          movedPaths: 0,
          skipped: skippedNames,
          clearedBytes: 0,
          clearedFiles: 0,
          snapshotId: '',
          restorePath: '',
          trashDir: primaryAccessible ? resolve(this.trash) : this.fallbackTrashDir(),
          usingFallbackTrash: !primaryAccessible,
          supersededSnapshotPaths: [] as string[],
        };
      }

      const committed = await this.commitActiveRowsToVault(
        activeRows,
        activeRows.map(r => r.name),
        skippedNames,
        { keepLocalSnapshots, simpleMessage: true },
      );
      return {
        ...committed,
        scopes,
      };
    }, { label: bt('maintenance.lock.clear') });
  }

  async clear(token: unknown, selectedNames?: unknown, _options?: { force?: boolean; keepLocalSnapshots?: number }) {
    return this.mutex.run(async () => {
      const saved = this.prepared;
      this.prepared = undefined;
      if (!saved || saved.token !== token || Date.now() - saved.at > 120000) {
        throw Error(bt('maintenance.err.manifest_expired'));
      }
      if (await this.running()) {
        throw Error(bt('maintenance.err.quit_before_clear'));
      }
      const allowedSet = new Set<string>(ALL_ALLOWED_CACHE_NAMES);
      let targetNames: string[];
      if (Array.isArray(selectedNames) && selectedNames.length > 0) {
        targetNames = selectedNames.map(String).filter(n => allowedSet.has(n));
        if (targetNames.length === 0 || targetNames.length !== selectedNames.length) {
          throw Error(bt('maintenance.err.invalid_selection'));
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
          throw Error(bt('maintenance.err.browser_busy_clear'));
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
          throw Error(bt('maintenance.err.cache_changed'));
        }
        current.push(inspected);
      }

      const activeRows = current.filter(row => row.exists && row.subTargets.length > 0);
      if (activeRows.length === 0) {
        this.cachedProtectedSummary = undefined;
        const primaryAccessible = await this.isPrimaryTrashAccessible();
        return {
          ok: true,
          message: bt('maintenance.clear.nothing_to_clear'),
          moved: 0,
          movedPaths: 0,
          skipped: skippedNames,
          clearedBytes: 0,
          clearedFiles: 0,
          snapshotId: '',
          restorePath: '',
          trashDir: primaryAccessible ? resolve(this.trash) : this.fallbackTrashDir(),
          usingFallbackTrash: !primaryAccessible,
          supersededSnapshotPaths: [] as string[],
        };
      }

      return await this.commitActiveRowsToVault(activeRows, targetNames, skippedNames, {
        keepLocalSnapshots: _options?.keepLocalSnapshots ?? 1,
        simpleMessage: false,
      });
    }, { label: bt('maintenance.lock.clear') });
  }

  async restore(snapshotId: unknown) {
    return this.mutex.run(async () => {
      if (typeof snapshotId !== 'string' || !/^GravityBox-缓存-\d+$/.test(snapshotId)) {
        throw Error(bt('maintenance.err.invalid_snapshot_id'));
      }
      if (await this.running()) {
        throw Error(bt('maintenance.err.quit_before_restore'));
      }
      let dir = '';
      for (const vaultRoot of this.candidateTrashDirs()) {
        const candidate = join(vaultRoot, snapshotId);
        const st = await lstat(candidate).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' || isTrashPermissionError(error)) return null;
          return null;
        });
        if (st && !st.isSymbolicLink() && st.isDirectory()) {
          dir = candidate;
          break;
        }
      }
      if (!dir) {
        throw Error(bt('maintenance.err.snapshot_not_found'));
      }
      const manifestPath = join(dir, '恢复清单.json');
      let manifest: any;
      try {
        manifest = await readMaintenanceManifest(manifestPath);
      } catch {
        throw Error(bt('maintenance.err.manifest_corrupt'));
      }
      if (manifest.transaction && ['prepared', 'recovery-required'].includes(manifest.transaction.phase)) {
        await reconcileMoves(manifestPath, manifest, move => this.guardJournalMove(dir, move));
        this.cachedProtectedSummary = undefined;
        await this.options.onMutated?.();
        return { ok: true, restored: 0, items: [], displacedCount: 0, message: bt('maintenance.restore.reconciled') };
      }
      if (manifest.transaction?.phase === 'rolled-back' && manifest.transaction.purpose !== 'restore') throw Error(bt('maintenance.err.already_rolled_back'));
      if (manifest.interrupted) throw Error(bt('maintenance.err.interrupted_snapshot'));
      if (manifest.restoredAt) throw Error(bt('maintenance.err.already_restored'));
      const moved = Array.isArray(manifest.moved) ? manifest.moved : [];
      if (moved.length === 0) throw Error(bt('maintenance.err.snapshot_empty'));

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
          if (!name || !allowedLegacySet.has(name)) throw Error(bt('maintenance.err.unauthorized_dir'));
          if (seenToPaths.has(name)) throw Error(bt('maintenance.err.duplicate_item', { name }));
          seenToPaths.add(name);
          const expectedTo = join(dir, name);
          const expectedFrom = join(this.profile, name);
          if (toPath !== expectedTo) throw Error(bt('maintenance.err.snapshot_path_invalid'));
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
            throw Error(bt('maintenance.err.unauthorized_dir'));
          }
          if (!toPath || !fromPath || !isStrictSubpath(dir, toPath)) {
            throw Error(bt('maintenance.err.snapshot_path_invalid'));
          }
          const ownerRoot = this.allowedRootDirs().find(r => isStrictSubpath(r, fromPath));
          if (!ownerRoot) {
            throw Error(bt('maintenance.err.snapshot_out_of_bounds'));
          }
          const normFrom = resolve(fromPath);
          const normTo = resolve(toPath);
          if (seenFromPaths.has(normFrom) || seenToPaths.has(normTo)) {
            throw Error(bt('maintenance.err.duplicate_item', { name: entryName }));
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
          throw Error(bt('maintenance.err.snapshot_entry_missing', { label: plan.label }));
        }
        // 检查目标父目录链是否存在符号链接
        const relParent = relative(plan.ownerRoot, dirname(plan.expectedFrom));
        if (relParent && relParent !== '.') {
          let cursor = plan.ownerRoot;
          for (const seg of relParent.split(sep).filter(Boolean)) {
            cursor = join(cursor, seg);
            const pst = await lstat(cursor).catch(() => null);
            if (pst && pst.isSymbolicLink()) {
              throw Error(bt('maintenance.err.target_parent_symlink', { seg }));
            }
          }
        }
        for (const suffix of ['-journal', '-wal', '-shm']) {
          const sideTo = `${plan.expectedTo}${suffix}`;
          const sideStat = await lstat(sideTo).catch(() => null);
          if (sideStat && sideStat.isSymbolicLink()) {
            throw Error(bt('maintenance.err.snapshot_log_symlink', { label: plan.label, suffix }));
          }
          const sideExisting = await lstat(`${plan.expectedFrom}${suffix}`).catch(() => null);
          if (sideExisting && sideExisting.isSymbolicLink()) {
            throw Error(bt('maintenance.err.target_symlink', { path: `${plan.label}${suffix}` }));
          }
        }
        const existingFrom = await lstat(plan.expectedFrom).catch(() => null);
        if (existingFrom && existingFrom.isSymbolicLink()) {
          throw Error(bt('maintenance.err.target_symlink', { path: plan.label }));
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
      const restoredTitles = restoredNames.map(n => getCacheMetadata(n)?.title ?? n);
      const titles = restoredTitles.join(bt('common.list_separator'));
      return {
        ok: true,
        restored: restoredNames.length,
        items: restoredNames,
        displacedCount: uniqueDisplacedCount,
        message: uniqueDisplacedCount > 0
          ? bt('maintenance.restore.success_displaced', { titles, count: uniqueDisplacedCount })
          : bt('maintenance.restore.success', { titles }),
      };
    }, { label: bt('maintenance.lock.restore') });
  }
}
