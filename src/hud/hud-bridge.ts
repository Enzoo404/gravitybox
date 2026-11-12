import type { CDP } from '../cdp.js';
import type { ConversationHudMetrics, HudActivityPhase, HudClientEvent, ICdpHudBridge } from './types.js';
import { ConversationMetricsEngine } from './metrics-engine.js';

export const HUD_BRIDGE_BINDING_NAME = '__gravityboxHudBridge';

export interface ActivePaneSession {
  targetId: string;
  paneSlotId: string;
  cascadeId: string;
  conversationId: string;
  sessionRevision: number;
  metricsSequence: number;
  modelId: string;
  foregroundStreaming: boolean;
  isStreaming: boolean;
  activityPhase: HudActivityPhase;
  isSubagentRunning: boolean;
  runningSubagentCount: number;
  childConversationIds: string[];
  lastUpdatedAt: number;
  lastMetricsKey: string;
  lastActivityAt: number;
}

const ACTIVITY_GRACE_WINDOW_MS = 15_000;

/**
 * CDP HUD 双向通信与多窗口/多分栏会话协调桥
 * 复用 Controller 维护的 PageSession CDP 通道与 AGZH-localization-v1 隔离世界
 */
export class CdpHudBridge implements ICdpHudBridge {
  private readonly engine: ConversationMetricsEngine;
  private readonly targets = new Map<
    string,
    { cdp: CDP; getContextId: () => number | undefined }
  >();
  private readonly activePanes = new Map<string, ActivePaneSession>();
  private readonly clientEventHandlers = new Set<(event: HudClientEvent) => void>();
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private lastPollStartedAt = 0;
  private sequenceCounter = 0;
  private readonly basePollIntervalMs: number;
  private disposed = false;

  constructor(options?: {
    engine?: ConversationMetricsEngine;
    geminiDir?: string;
    conversationsDir?: string;
    pollIntervalMs?: number;
  }) {
    this.engine =
      options?.engine ??
      new ConversationMetricsEngine({
        geminiDir: options?.geminiDir,
        conversationsDir: options?.conversationsDir,
      });
    const interval = options?.pollIntervalMs ?? 500;
    this.basePollIntervalMs = interval;
    if (interval > 0) {
      this.pollTimer = setInterval(() => {
        void this.pollActiveSessions(false);
      }, interval);
      this.pollTimer.unref?.();
    }
  }

  /**
   * 绑定到已连接的 CDP PageSession
   */
  public async attachToTarget(
    targetId: string,
    cdp?: CDP,
    getContextId?: () => number | undefined,
    worldName = 'AGZH-localization-v1'
  ): Promise<void> {
    if (this.disposed || !cdp || !getContextId) return;
    this.targets.set(targetId, { cdp, getContextId });
    try {
      await cdp.send('Runtime.addBinding', {
        name: HUD_BRIDGE_BINDING_NAME,
        executionContextName: worldName,
      });
    } catch {
      // 若已绑定或目标窗口正在切换，忽略重复绑定错误
    }
  }

  public detachTarget(targetId: string): void {
    this.targets.delete(targetId);
    this.detachTargetPanes(targetId);
  }

  public detachTargetPanes(targetId: string): void {
    for (const key of this.activePanes.keys()) {
      if (key.startsWith(`${targetId}::`)) {
        this.activePanes.delete(key);
      }
    }
  }

  public clearActivePanes(): void {
    this.activePanes.clear();
  }

  /**
   * 处理来自隔离世界 `window.__gravityboxHudBridge(jsonPayload)` 的事件
   */
  public handleRawBindingPayload(targetId: string, rawPayload: string): void {
    if (this.disposed || typeof rawPayload !== 'string') return;
    let parsed: HudClientEvent;
    try {
      parsed = JSON.parse(rawPayload) as HudClientEvent;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return;

    for (const handler of this.clientEventHandlers) {
      try {
        handler(parsed);
      } catch {}
    }

    const cascadeId = String(parsed.cascadeId || 'default-pane');
    const paneSlotId = String(parsed.paneSlotId || cascadeId);
    const conversationId = String(parsed.conversationId || '');
    if (!conversationId) return;

    const paneKey = `${targetId}::${paneSlotId}`;

    if (parsed.type === 'SESSION_DETACHED') {
      this.activePanes.delete(paneKey);
      this.activePanes.delete(`${targetId}::${cascadeId}`);
      return;
    }

    const existing = this.activePanes.get(paneKey);
    const sameConv = existing && existing.conversationId === conversationId ? existing : undefined;
    const minNextRevision = sameConv
      ? sameConv.sessionRevision
      : (existing?.sessionRevision ?? 0) + 1;
    const nextRevision =
      typeof parsed.sessionRevision === 'number' && parsed.sessionRevision > 0
        ? Math.max(parsed.sessionRevision, minNextRevision)
        : minNextRevision;

    const isSubagentRunning =
      typeof parsed.isSubagentRunning === 'boolean'
        ? parsed.isSubagentRunning
        : sameConv
        ? sameConv.isSubagentRunning
        : false;

    const runningSubagentCount =
      typeof parsed.runningSubagentCount === 'number' && parsed.runningSubagentCount >= 0
        ? parsed.runningSubagentCount
        : isSubagentRunning
        ? Math.max(1, sameConv?.runningSubagentCount ?? 1)
        : 0;

    const childConversationIds = Array.isArray(parsed.childConversationIds)
      ? parsed.childConversationIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : sameConv
      ? sameConv.childConversationIds
      : [];

    const foregroundStreaming =
      typeof parsed.isStreaming === 'boolean'
        ? parsed.isStreaming
        : (sameConv?.foregroundStreaming ?? false);
    const resolvedStreaming = foregroundStreaming || isSubagentRunning;
    const resolvedPhase: HudActivityPhase = !resolvedStreaming
      ? 'idle'
      : parsed.activityPhase === 'generating' || parsed.activityPhase === 'executing'
      ? parsed.activityPhase
      : parsed.activityPhase === 'idle' && isSubagentRunning
      ? 'executing'
      : sameConv?.activityPhase && sameConv.activityPhase !== 'idle'
      ? sameConv.activityPhase
      : isSubagentRunning && !foregroundStreaming
      ? 'executing'
      : 'generating';

    const nowMs = Date.now();
    const session: ActivePaneSession = {
      targetId,
      paneSlotId,
      cascadeId,
      conversationId,
      sessionRevision: nextRevision,
      metricsSequence: sameConv?.metricsSequence ?? 0,
      modelId:
        (typeof parsed.modelId === 'string' && parsed.modelId.trim()) ||
        sameConv?.modelId ||
        '',
      foregroundStreaming,
      isStreaming: resolvedStreaming,
      activityPhase: resolvedPhase,
      isSubagentRunning,
      runningSubagentCount,
      childConversationIds,
      lastUpdatedAt: nowMs,
      lastMetricsKey: sameConv ? sameConv.lastMetricsKey : '',
      lastActivityAt:
        resolvedStreaming || parsed.type === 'STREAMING_CHANGED' || isSubagentRunning
          ? nowMs
          : sameConv?.lastActivityAt ?? nowMs,
    };

    this.activePanes.set(paneKey, session);
    void this.refreshPaneMetrics(paneKey, true).catch(() => {});
  }

  /**
   * 计算并向指定分栏所在窗口推送最新 ConversationHudMetrics
   */
  public async refreshPaneMetrics(paneKey: string, forcePush = false): Promise<void> {
    if (this.disposed) return;
    const session = this.activePanes.get(paneKey);
    if (!session) return;

    const nextSeq = ++this.sequenceCounter;
    const metrics = await this.engine.getConversationMetrics({
      conversationId: session.conversationId,
      paneSlotId: session.paneSlotId,
      sessionRevision: session.sessionRevision,
      metricsSequence: nextSeq,
      modelId: session.modelId,
      isStreaming: session.foregroundStreaming,
      activityPhase: session.activityPhase,
      isSubagentRunning: session.isSubagentRunning,
      runningSubagentCount: session.runningSubagentCount,
      childConversationIds: session.childConversationIds,
    });

    // 若异步查询期间会话已被切换或移除，或已有更新序号的度量推入，丢弃陈旧结果
    const latestSession = this.activePanes.get(paneKey);
    if (
      !latestSession ||
      latestSession !== session ||
      latestSession.conversationId !== metrics.conversationId ||
      latestSession.sessionRevision > metrics.sessionRevision ||
      latestSession.metricsSequence > nextSeq
    ) {
      return;
    }

    const fingerprint = JSON.stringify({
      session: metrics.session,
      tokens: metrics.tokens,
      context: metrics.context,
      availability: metrics.availability,
      observedAt: metrics.observedAt,
      failedChildCount: metrics.failedChildCount,
      isStreaming: metrics.isStreaming,
      activityPhase: metrics.activityPhase,
      isSubagentRunning: metrics.isSubagentRunning,
      runningSubagentCount: metrics.runningSubagentCount,
    });

    if (!forcePush && latestSession.lastMetricsKey === fingerprint) {
      latestSession.metricsSequence = Math.max(latestSession.metricsSequence, nextSeq);
      return;
    }

    const pushed = await this.pushMetricsToTarget(latestSession.targetId, metrics);
    if (pushed) {
      latestSession.metricsSequence = nextSeq;
      latestSession.lastMetricsKey = fingerprint;
      latestSession.lastUpdatedAt = Date.now();
    }
  }

  /**
   * 广播度量数据到所有已绑定目标窗口
   */
  public async broadcastMetrics(metrics: ConversationHudMetrics): Promise<void> {
    if (this.disposed) return;
    await Promise.allSettled(
      [...this.targets.keys()].map((targetId) => this.pushMetricsToTarget(targetId, metrics))
    );
  }

  private async pushMetricsToTarget(
    targetId: string,
    metrics: ConversationHudMetrics
  ): Promise<boolean> {
    const target = this.targets.get(targetId);
    if (!target) return false;
    const contextId = target.getContextId();
    if (contextId === undefined) return false;
    const serialized = JSON.stringify(metrics);
    try {
      await target.cdp.evaluate(
        `(globalThis.__gravityboxUpdateHudMetrics ? globalThis.__gravityboxUpdateHudMetrics(${serialized}) : globalThis.__GRAVITYBOX_HUD_V1__?.dispatchMetrics?.(${serialized}))`,
        contextId
      );
      return true;
    } catch {
      // 忽略窗口关闭或导航瞬间的执行上下文失效
      return false;
    }
  }

  /**
   * 定时增量轮询所有活跃会话（活跃或处于 15 秒宽限窗口时按 300ms 高频轮询，彻底沉寂后降频至 1000ms）
   */
  public async pollActiveSessions(force = true): Promise<void> {
    if (this.disposed || this.pollInFlight || this.activePanes.size === 0) return;
    const now = Date.now();
    if (!force && this.basePollIntervalMs > 0) {
      const anyActive = [...this.activePanes.values()].some(
        (p) =>
          p.isStreaming ||
          p.isSubagentRunning ||
          (p.lastActivityAt && now - p.lastActivityAt < ACTIVITY_GRACE_WINDOW_MS)
      );
      const effectiveInterval = anyActive
        ? Math.min(this.basePollIntervalMs, 300)
        : Math.max(this.basePollIntervalMs, 1000);
      if (now - this.lastPollStartedAt < effectiveInterval - 20) {
        return;
      }
    }
    this.pollInFlight = true;
    this.lastPollStartedAt = now;
    try {
      await Promise.allSettled(
        [...this.activePanes.keys()].map((paneKey) => this.refreshPaneMetrics(paneKey, false))
      );
    } finally {
      this.pollInFlight = false;
    }
  }

  public onClientEvent(handler: (event: HudClientEvent) => void): void {
    this.clientEventHandlers.add(handler);
  }

  public getEngine(): ConversationMetricsEngine {
    return this.engine;
  }

  public getActivePanes(): ActivePaneSession[] {
    return [...this.activePanes.values()];
  }

  public dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.targets.clear();
    this.activePanes.clear();
    this.clientEventHandlers.clear();
    this.engine.clearCache();
  }
}
