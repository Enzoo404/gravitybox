import type { CDP } from '../cdp.js';
import type { ConversationHudMetrics, HudClientEvent, ICdpHudBridge } from './types.js';
import { ConversationMetricsEngine } from './metrics-engine.js';

export const HUD_BRIDGE_BINDING_NAME = '__gravityboxHudBridge';

export interface ActivePaneSession {
  targetId: string;
  cascadeId: string;
  conversationId: string;
  sessionRevision: number;
  modelId: string;
  isStreaming: boolean;
  isSubagentRunning: boolean;
  runningSubagentCount: number;
  childConversationIds: string[];
  lastUpdatedAt: number;
  lastMetricsKey: string;
}

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
    const interval = options?.pollIntervalMs ?? 1000;
    if (interval > 0) {
      this.pollTimer = setInterval(() => {
        void this.pollActiveSessions();
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
    const conversationId = String(parsed.conversationId || '');
    if (!conversationId) return;

    const paneKey = `${targetId}::${cascadeId}`;

    if (parsed.type === 'SESSION_DETACHED') {
      this.activePanes.delete(paneKey);
      return;
    }

    const existing = this.activePanes.get(paneKey);
    const nextRevision =
      typeof parsed.sessionRevision === 'number' && parsed.sessionRevision > 0
        ? parsed.sessionRevision
        : existing && existing.conversationId === conversationId
        ? existing.sessionRevision
        : (existing?.sessionRevision ?? 0) + 1;

    const isSubagentRunning =
      typeof parsed.isSubagentRunning === 'boolean'
        ? parsed.isSubagentRunning
        : existing && existing.conversationId === conversationId
        ? existing.isSubagentRunning
        : false;

    const runningSubagentCount =
      typeof parsed.runningSubagentCount === 'number' && parsed.runningSubagentCount >= 0
        ? parsed.runningSubagentCount
        : isSubagentRunning
        ? Math.max(1, existing?.runningSubagentCount ?? 1)
        : 0;

    const childConversationIds = Array.isArray(parsed.childConversationIds)
      ? parsed.childConversationIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : existing && existing.conversationId === conversationId
      ? existing.childConversationIds
      : [];

    const session: ActivePaneSession = {
      targetId,
      cascadeId,
      conversationId,
      sessionRevision: nextRevision,
      modelId:
        (typeof parsed.modelId === 'string' && parsed.modelId.trim()) ||
        existing?.modelId ||
        'gemini-3.8-flash',
      isStreaming:
        typeof parsed.isStreaming === 'boolean'
          ? parsed.isStreaming || isSubagentRunning
          : (existing?.isStreaming ?? false) || isSubagentRunning,
      isSubagentRunning,
      runningSubagentCount,
      childConversationIds,
      lastUpdatedAt: Date.now(),
      lastMetricsKey:
        existing && existing.conversationId === conversationId ? existing.lastMetricsKey : '',
    };

    this.activePanes.set(paneKey, session);
    void this.refreshPaneMetrics(paneKey, true);
  }

  /**
   * 计算并向指定分栏所在窗口推送最新 ConversationHudMetrics
   */
  public async refreshPaneMetrics(paneKey: string, forcePush = false): Promise<void> {
    if (this.disposed) return;
    const session = this.activePanes.get(paneKey);
    if (!session) return;

    const metrics = await this.engine.getConversationMetrics({
      conversationId: session.conversationId,
      sessionRevision: session.sessionRevision,
      modelId: session.modelId,
      isStreaming: session.isStreaming,
      isSubagentRunning: session.isSubagentRunning,
      runningSubagentCount: session.runningSubagentCount,
      childConversationIds: session.childConversationIds,
    });

    // 若异步查询期间会话已被切换或移除，丢弃陈旧结果
    const latestSession = this.activePanes.get(paneKey);
    if (
      !latestSession ||
      latestSession !== session ||
      latestSession.conversationId !== metrics.conversationId ||
      latestSession.sessionRevision > metrics.sessionRevision
    ) {
      return;
    }

    const fingerprint = JSON.stringify({
      session: metrics.session, tokens: metrics.tokens, context: metrics.context,
      isStreaming: metrics.isStreaming, isSubagentRunning: metrics.isSubagentRunning,
      runningSubagentCount: metrics.runningSubagentCount,
    });

    if (!forcePush && latestSession.lastMetricsKey === fingerprint) {
      return;
    }
    latestSession.lastMetricsKey = fingerprint;
    latestSession.lastUpdatedAt = Date.now();

    await this.pushMetricsToTarget(latestSession.targetId, metrics);
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
  ): Promise<void> {
    const target = this.targets.get(targetId);
    if (!target) return;
    const contextId = target.getContextId();
    if (contextId === undefined) return;
    const serialized = JSON.stringify(metrics);
    try {
      await target.cdp.evaluate(
        `(globalThis.__gravityboxUpdateHudMetrics ? globalThis.__gravityboxUpdateHudMetrics(${serialized}) : globalThis.__GRAVITYBOX_HUD_V1__?.dispatchMetrics?.(${serialized}))`,
        contextId
      );
    } catch {
      // 忽略窗口关闭或导航瞬间的执行上下文失效
    }
  }

  /**
   * 定时增量轮询所有活跃会话
   */
  public async pollActiveSessions(): Promise<void> {
    if (this.disposed || this.pollInFlight || this.activePanes.size === 0) return;
    this.pollInFlight = true;
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
