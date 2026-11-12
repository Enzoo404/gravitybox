/**
 * 会话状态 HUD 与向上展开详情卡片 (Popover Panels) 核心类型与接口契约
 * 指标来源、统计范围与缺失值遵循 CONVERSATION_STATUS_HUD_ARCHITECTURE.md。
 */

export type HudActivityPhase = 'idle' | 'generating' | 'executing';
export type HudDataAvailability = 'loading' | 'ready' | 'partial' | 'cached' | 'unavailable';
export type HudCapacitySource = 'explicit' | 'reference' | 'unknown';

export interface ConversationHudMetrics {
  /** 目标会话 UUID (对应 ~/.gemini/antigravity/conversations/<id>.db) */
  conversationId: string;
  /** 物理分栏稳定槽位标识 (用于同会话多分栏定向隔离) */
  paneSlotId?: string;
  /** 会话代数版本号 (单调自增，用于防跨会话污染与异步迟到包篡改) */
  sessionRevision: number;
  /** 同代单调递增消息序号 (拒绝同会话同代乱序旧包) */
  metricsSequence?: number;
  /** 数据可信度与可用性状态 */
  availability?: HudDataAvailability;
  /** 底层数据库/WAL 真实观测毫秒时间戳 (读失败回退旧缓存时不刷新) */
  observedAt?: number | null;
  /** 最近一次成功读取底层数据库的毫秒时间戳 */
  lastSuccessAt?: number | null;
  /** 读取失败的关联子会话数据库数量 */
  failedChildCount?: number;
  /** 毫秒级快照生成时间戳 */
  updatedAt: number;
  /** 当前是否处于活跃流式生成中（含主智能体生成与子智能体后台运行） */
  isStreaming: boolean;
  /** 当前精确活动阶段：idle=空闲灰，generating=模型思考输出常亮蓝，executing=脚本/工具/后台执行蓝色呼吸 */
  activityPhase?: HudActivityPhase;
  /** 当前是否有子智能体正在运行 */
  isSubagentRunning?: boolean;
  /** 当前正在运行的子智能体数量 */
  runningSubagentCount?: number;

  /** 模块 1 & Popover 1: 会话与执行耗时统计 (100% 源自 steps 表纳秒时间戳与步骤类型) */
  session: {
    /** 用户输入轮次 (仅统计主会话 step_type === 14 USER_INPUT) */
    turns: number;
    /** 执行总步数 (steps 表总行数，含已关联子智能体步数) */
    steps: number;
    /** 模型生成步数 (step_type === 15 计数) */
    modelSteps?: number;
    samples?: { usage: number; timed: number; ttft: number };
    /** 工具执行步数 (工具调用 step 计数) */
    toolSteps?: number;
    /** 上下文自动压缩次数 (step_type === 23 CHECKPOINT 计数) */
    compactionCount?: number;
    /** 会话累计调度的子智能体数量 */
    subagentCount?: number;
    /** 当前活跃运行中的子智能体数量 */
    runningSubagentCount?: number;
    /** 子智能体累计执行步数 */
    subagentSteps?: number;
    /** 模型累计总用时 (秒) */
    modelDurationSeconds: number;
    /** 模型用时中文格式化展示 (如 "22 分 28 秒") */
    modelDurationFormatted: string;
    /** 模型用时英文格式化展示 (如 "22m 28s") */
    modelDurationFormattedEn?: string;
    /** 工具调用累计总用时 (秒) */
    toolDurationSeconds: number;
    /** 工具调用用时中文格式化展示 (如 "6 分 0 秒") */
    toolDurationFormatted: string;
    /** 工具调用用时英文格式化展示 (如 "6m 0s") */
    toolDurationFormattedEn?: string;
    /** 宿主原始 TTFT（可见回复等待）平均值，未经思维链估算修正 */
    averageTtftSeconds: number;
    /** 首 Token 平均响应时间中文格式化 (如 "3.8 秒" 或 "—") */
    averageTtftFormatted: string;
    /** 首 Token 平均响应时间英文格式化 (如 "3.8s" 或 "—") */
    averageTtftFormattedEn?: string;
    /** 完整有效请求的总输出 / 总耗时，保留未舍入 tok/s；缺失状态见格式化字段 */
    outputTps: number;
    /** 输出速度格式化展示 (如 "82 tok/s" 或 "—") */
    outputTpsFormatted: string;
    /** 本轮总用时 (秒，含模型生成思考与工具调用) */
    currentTurnDurationSeconds?: number;
    /** 本轮总用时中文卡片格式化 (如 "18.4 秒" 或 "—") */
    currentTurnDurationFormatted?: string;
    /** 本轮总用时英文卡片格式化 (如 "18.4s" 或 "—") */
    currentTurnDurationFormattedEn?: string;
    /** 本轮用时常驻栏紧凑中文展示 (如 "本轮 18s") */
    currentTurnDurationCompactZh?: string;
    /** 本轮用时常驻栏紧凑英文展示 (如 "Turn 18s") */
    currentTurnDurationCompactEn?: string;
    /** 本轮模型思考与生成用时 (秒) */
    currentTurnModelDurationSeconds?: number;
    /** 本轮工具调用用时 (秒) */
    currentTurnToolDurationSeconds?: number;
  };

  /** 模块 2 & Popover 2: 累计 Token 账本 (100% 源自 steps.metadata field 9 ModelUsageStats) */
  tokens: {
    /** 总 Token 数 (uncachedInput + cachedRead + output + cacheWrite) */
    totalTokens: number;
    /** 紧凑读数 (如 "23.2M tok") */
    totalTokensCompact: string;
    /** 千分位全量读数 (如 "23,196,078 tok") */
    totalTokensFormatted: string;
    /** 缓存命中率 (0.0 ~ 1.0) */
    cacheHitRate: number;
    /** 缓存命中率百分比文本 (如 "97%") */
    cacheHitRateFormatted: string;
    /** 未缓存输入 Token 数 (subfield 2) */
    uncachedInputTokens: number;
    /** 未缓存输入千分位读数 (如 "708,929 tok") */
    uncachedInputFormatted: string;
    /** 缓存读取 Token 数 (subfield 5) */
    cachedReadTokens: number;
    /** 缓存读取千分位读数 (如 "22,416,293 tok") */
    cachedReadFormatted: string;
    /** 缓存写入 Token 数 (subfield 4, 若存在) */
    cacheWriteTokens?: number;
    /** 缓存写入千分位读数 */
    cacheWriteFormatted?: string;
    /** 输出 Token 数 (subfield 3) */
    outputTokens: number;
    /** 输出千分位读数 (如 "70,856 tok") */
    outputFormatted: string;
    /** 思维链/推理 Token 数 (subfield 9, 恒满足 reasoning + candidate === output) */
    reasoningTokens?: number;
    /** 思维链 Token 千分位读数 */
    reasoningFormatted?: string;
    /** 候选文本回复 Token 数 (subfield 10) */
    candidateTokens?: number;
    /** 候选文本 Token 千分位读数 */
    candidateFormatted?: string;
  };

  /** 模块 3 & Popover 3: 当前上下文实况 (100% 源自最近一步生成记录与会话真实峰值，零虚构 1M/1.9K/7.6K) */
  context: {
    hasUsageData?: boolean;
    /** 当前激活模型 ID (如 "gemini-3.8-flash") */
    modelId: string;
    /** 模型展示名称 (如 "Gemini 3.8 Flash") */
    modelDisplayName: string;
    /** 当前上下文实际总输入 Token 数 (最近一步 rawInput + cachedRead + cacheWrite) */
    usedTokens: number;
    /** 当前上下文紧凑读数 (如 "226.4K" 或 "0") */
    usedTokensCompact: string;
    /** 当前上下文千分位精确读数 (如 "226,412 tok") */
    usedTokensFormatted?: string;
    /** 会话历史单步最高上下文 Token 数 (真实观测峰值) */
    peakContextTokens?: number;
    /** 会话历史峰值紧凑读数 (如 "226.4K") */
    peakContextCompact?: string;
    /** 会话历史峰值千分位读数 (如 "226,412 tok") */
    peakContextFormatted?: string;
    /** 当前上下文窗口有效容量阈值 (优先取 DB context_window_metadata / planner_config 真实阈值，无则取 Antigravity 标准压缩阈值) */
    capacityTokens: number;
    /** 容量阈值紧凑读数 (如 "200K" / "256K") */
    capacityTokensCompact: string;
    /** 容量是否直接来自会话底层 Protobuf 显式字段 */
    hasExplicitDbCapacity?: boolean;
    /** 是否为未知模型回退容量 */
    isFallbackCapacity?: boolean;
    /** 容量来源分类：explicit=数据库明确返回，reference=模型族参考阈值，unknown=未知模型默认参考 */
    capacitySource?: HudCapacitySource;
    /** 当前上下文占有效容量比例 (0.0 ~ 1.0 夹紧值) */
    usedRatio: number;
    /** 上下文占比格式化 (如 "88%") */
    usedRatioFormatted: string;
    /** 当前单步上下文缓存复用率 (0.0 ~ 1.0, 即 cachedContextTokens / usedTokens) */
    stepCacheRatio?: number;
    /** 当前单步上下文缓存复用率格式化 (如 "96%") */
    stepCacheRatioFormatted?: string;
    /**
     * 100% 真实底层上下文构成明细：
     * - cachedContextTokens (缓存复用上下文, 对应原 system 槽位兼容字段)
     * - uncachedContextTokens (本步新增未缓存输入, 对应原 tool 槽位兼容字段)
     * - latestOutputTokens (本步生成输出, 对应原 message 槽位兼容字段)
     */
    breakdown: {
      /** 当前步缓存复用上下文 Token (lastStep.cachedReadTokens) */
      cachedContextTokens?: number;
      /** 当前步缓存复用千分位读数 (如 "218,100 tok") */
      cachedContextFormatted?: string;
      /** 当前步缓存复用占当前上下文比例 (0 ~ 100) */
      cachedContextRatio?: number;
      /** 当前步新增未缓存输入 Token (lastStep.rawInputTokens + lastStep.cacheWriteTokens) */
      uncachedContextTokens?: number;
      /** 当前步新增未缓存千分位读数 (如 "8,312 tok") */
      uncachedContextFormatted?: string;
      /** 当前步新增未缓存占当前上下文比例 (0 ~ 100) */
      uncachedContextRatio?: number;
      /** 当前步生成输出 Token (lastStep.outputTokens) */
      latestOutputTokens?: number;
      /** 当前步生成输出千分位读数 (如 "1,240 tok") */
      latestOutputFormatted?: string;
      /** 兼容字段：若底层存在真实分组或映射至真实缓存复用/新增输入 */
      systemTokens: number;
      systemTokensCompact: string;
      systemRatio: number;
      toolTokens: number;
      toolTokensCompact: string;
      toolRatio: number;
      messageTokens: number;
      messageTokensCompact: string;
      messageRatio: number;
    };
  };
}

/** 单步解析后的数据结构 */
export interface ParsedConversationStep {
  idx: number;
  stepType: number;
  status: number;
  /** 步骤创建时间 (CortexStepMetadata.field 1 created_at) */
  createdAtSeconds?: number | null;
  /** 原始 metadata 字节长度 (用于增量缓存前缀校验) */
  metadataByteLength?: number;
  /** 工具实际启动时间 (CortexStepMetadata.field 32 started_at) */
  startedAtSeconds?: number | null;
  /** 步骤有效起始时间 (模型步取 created_at，工具步优先取 started_at) */
  startTimeSeconds: number | null;
  /** 步骤可见时间 / 首块时间 (CortexStepMetadata.field 6 viewable_at) */
  firstTokenSeconds: number | null;
  /** 模型完成生成时间 (CortexStepMetadata.field 7 finished_generating_at) */
  finishedGeneratingSeconds?: number | null;
  /** 步骤完成时间 (CortexStepMetadata.field 8 completed_at) */
  completedAtSeconds?: number | null;
  /** 步骤有效结束时间 (模型步优先取 finished_generating_at，工具步优先取 completed_at) */
  endTimeSeconds: number | null;
  rawInputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cachedReadTokens: number;
  reasoningTokens: number;
  candidateTokens: number;
  modelMaxTokens?: number;
  modelName?: string;
  /** 工具调用名称 (CortexStepMetadata.field 4 tool_call.field 2 name) */
  toolCallName?: string;
  /** 是否为子智能体调度步骤 (step_type === 127 或 tool_call.name === 'invoke_subagent' | 'browser_subagent') */
  isSubagentStep?: boolean;
  /** 从步骤元数据/载荷中提取出的关联子智能体会话 UUID 列表 */
  childConversationIds?: string[];
  executionId?: string;
  hasUsage?: boolean;
  generation?: ParsedGenMetadata;
}

/** 从 gen_metadata 提取的真实会话配置、权威流式耗时与上下文元数据 */
export interface ParsedGenMetadata {
  stepIndices?: number[];
  executionId?: string;
  usage?: {
    rawInputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cachedReadTokens: number;
    reasoningTokens: number;
    candidateTokens: number;
  };
  responseModel?: string;
  modelDisplayName?: string;
  plannerModelName?: string;
  maxContextTokens?: number;
  estimatedTokensUsed?: number;
  systemTokens?: number;
  toolTokens?: number;
  messageTokens?: number;
  /** ChatModelMetadata.field 11 time_to_first_token (秒) */
  timeToFirstTokenSeconds?: number;
  /** ChatModelMetadata.field 12 streaming_duration (秒) */
  streamingDurationSeconds?: number;
}

/** 前端隔离世界向 Node.js 派发的事件负载 */
export type HudClientEvent =
  | {
      type: 'SESSION_ATTACHED';
      conversationId: string;
      cascadeId: string;
      paneSlotId?: string;
      sessionRevision?: number;
      modelId?: string;
      isStreaming?: boolean;
      activityPhase?: HudActivityPhase;
      isSubagentRunning?: boolean;
      runningSubagentCount?: number;
      childConversationIds?: string[];
      timestamp: number;
    }
  | {
      type: 'SESSION_DETACHED';
      conversationId: string;
      cascadeId: string;
      paneSlotId?: string;
      sessionRevision?: number;
      timestamp: number;
    }
  | {
      type: 'REQUEST_REFRESH';
      conversationId: string;
      cascadeId: string;
      paneSlotId?: string;
      sessionRevision?: number;
      modelId?: string;
      isStreaming?: boolean;
      activityPhase?: HudActivityPhase;
      isSubagentRunning?: boolean;
      runningSubagentCount?: number;
      childConversationIds?: string[];
      timestamp: number;
    }
  | {
      type: 'MODEL_CHANGED';
      conversationId: string;
      cascadeId: string;
      paneSlotId?: string;
      sessionRevision?: number;
      modelId: string;
      isStreaming?: boolean;
      activityPhase?: HudActivityPhase;
      isSubagentRunning?: boolean;
      runningSubagentCount?: number;
      childConversationIds?: string[];
      timestamp: number;
    }
  | {
      type: 'STREAMING_CHANGED';
      conversationId: string;
      cascadeId: string;
      paneSlotId?: string;
      sessionRevision?: number;
      modelId?: string;
      isStreaming: boolean;
      activityPhase?: HudActivityPhase;
      isSubagentRunning?: boolean;
      runningSubagentCount?: number;
      childConversationIds?: string[];
      timestamp: number;
    };

/** 生命周期控制器接口 */
export interface IHudLifecycleController {
  start(): void;
  updateMetrics(metrics: ConversationHudMetrics): void;
  dispose(): void;
  readonly active: boolean;
}

/** CDP 桥接器接口 */
export interface ICdpHudBridge {
  attachToTarget(targetId: string): Promise<void>;
  broadcastMetrics(metrics: ConversationHudMetrics): Promise<void>;
  onClientEvent(handler: (event: HudClientEvent) => void): void;
  dispose(): void;
}
