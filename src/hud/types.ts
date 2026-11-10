/**
 * 会话状态 HUD 与向上展开详情卡片 (Popover Panels) 核心类型与接口契约
 * 遵循 GRAVITYBOX-SPEC-HUD-001 (v1.2 工业级全链路闭环基准)
 */

export interface ConversationHudMetrics {
  /** 目标会话 UUID (对应 ~/.gemini/antigravity/conversations/<id>.db) */
  conversationId: string;
  /** 会话代数版本号 (单调自增，用于防跨会话污染与异步迟到包篡改) */
  sessionRevision: number;
  /** 毫秒级快照生成时间戳 */
  updatedAt: number;
  /** 当前是否处于活跃流式生成中 */
  isStreaming: boolean;

  /** 胶囊 1 & Popover 1: 会话统计 */
  session: {
    /** 用户输入轮次 (step_type === 101 计数) */
    turns: number;
    /** 执行总步数 (steps 表总行数) */
    steps: number;
    /** 模型累计总用时 (秒) */
    modelDurationSeconds: number;
    /** 模型用时中文格式化展示 (如 "65 分 59 秒") */
    modelDurationFormatted: string;
    /** 模型用时英文格式化展示 (如 "65m 59s") */
    modelDurationFormattedEn?: string;
    /** 工具调用累计总用时 (秒) */
    toolDurationSeconds: number;
    /** 工具调用用时中文格式化展示 (如 "12 分 31 秒") */
    toolDurationFormatted: string;
    /** 工具调用用时英文格式化展示 (如 "12m 31s") */
    toolDurationFormattedEn?: string;
    /** 首 Token 平均响应时间 (秒) */
    averageTtftSeconds: number;
    /** 首 Token 平均响应时间中文格式化 (如 "19.7 秒" 或 "—") */
    averageTtftFormatted: string;
    /** 首 Token 平均响应时间英文格式化 (如 "19.7s" 或 "—") */
    averageTtftFormattedEn?: string;
    /** 令牌输出速度 (tok/s, 物理上限 500, 窗口不足时为 0) */
    outputTps: number;
    /** 输出速度格式化展示 (如 "90 tok/s" 或 "—") */
    outputTpsFormatted: string;
  };

  /** 胶囊 2 & Popover 2: Token 用量 (严格数学守恒) */
  tokens: {
    /** 总 Token 数 (uncachedInput + cachedRead + output + cacheWrite) */
    totalTokens: number;
    /** 紧凑读数 (如 "58.6M tok") */
    totalTokensCompact: string;
    /** 千分位全量读数 (如 "58,593,793 tok") */
    totalTokensFormatted: string;
    /** 缓存命中率 (0.0 ~ 1.0) */
    cacheHitRate: number;
    /** 缓存命中率百分比文本 (如 "97%") */
    cacheHitRateFormatted: string;
    /** 未缓存输入 Token 数 */
    uncachedInputTokens: number;
    /** 未缓存输入千分位读数 (如 "1,961,501 tok") */
    uncachedInputFormatted: string;
    /** 缓存读取 Token 数 */
    cachedReadTokens: number;
    /** 缓存读取千分位读数 (如 "56,526,799 tok") */
    cachedReadFormatted: string;
    /** 缓存写入 Token 数 (若存在) */
    cacheWriteTokens?: number;
    /** 缓存写入千分位读数 */
    cacheWriteFormatted?: string;
    /** 输出 Token 数 */
    outputTokens: number;
    /** 输出千分位读数 (如 "105,493 tok") */
    outputFormatted: string;
    /** 思维链/推理 Token 数 (subfield 9) */
    reasoningTokens?: number;
    /** 候选文本回复 Token 数 (subfield 10) */
    candidateTokens?: number;
  };

  /** 胶囊 3 & Popover 3: 上下文窗口 (级联独立裁剪，杜绝负百分比) */
  context: {
    /** 当前激活模型 ID (如 "gemini-4-argon") */
    modelId: string;
    /** 模型展示名称 (如 "Gemini 4 Argon") */
    modelDisplayName: string;
    /** 当前上下文已用 Token 数 (最后一步生成的 Prompt 总量) */
    usedTokens: number;
    /** 已用上下文紧凑读数 (如 "~672K" 或 "0") */
    usedTokensCompact: string;
    /** 模型物理上下文容量上限 (如 1048576) */
    capacityTokens: number;
    /** 模型容量紧凑读数 (如 "1M" 或 "~1M") */
    capacityTokensCompact: string;
    /** 是否为未知模型回退容量 */
    isFallbackCapacity?: boolean;
    /** 上下文已用比例 (0.0 ~ 1.0 夹紧值) */
    usedRatio: number;
    /** 上下文已用百分比格式化 (如 "64%") */
    usedRatioFormatted: string;
    /** 三段式级联独立裁剪明细 (T_sys + T_tool + T_msg === usedTokens) */
    breakdown: {
      /** 系统提示词 Token (T_sys = min(U, K_sys)) */
      systemTokens: number;
      /** 系统提示词紧凑读数 (如 "~1.9K") */
      systemTokensCompact: string;
      /** 系统提示词占总容量百分比 (0 ~ 100) */
      systemRatio: number;
      /** 工具定义 Token (T_tool = min(max(0, U - T_sys), K_tool)) */
      toolTokens: number;
      /** 工具定义紧凑读数 (如 "~7.6K") */
      toolTokensCompact: string;
      /** 工具定义占总容量百分比 (0 ~ 100) */
      toolRatio: number;
      /** 对话消息与上下文 Token (T_msg = max(0, U - T_sys - T_tool)) */
      messageTokens: number;
      /** 对话消息紧凑读数 (如 "~662K") */
      messageTokensCompact: string;
      /** 对话消息占总容量百分比 (0 ~ 100) */
      messageRatio: number;
    };
  };
}

/** 单步解析后的数据结构 */
export interface ParsedConversationStep {
  idx: number;
  stepType: number;
  status: number;
  startTimeSeconds: number | null;
  firstTokenSeconds: number | null;
  endTimeSeconds: number | null;
  rawInputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cachedReadTokens: number;
  reasoningTokens: number;
  candidateTokens: number;
}

/** 前端隔离世界向 Node.js 派发的事件负载 */
export type HudClientEvent =
  | {
      type: 'SESSION_ATTACHED';
      conversationId: string;
      cascadeId: string;
      sessionRevision?: number;
      modelId?: string;
      isStreaming?: boolean;
      timestamp: number;
    }
  | {
      type: 'SESSION_DETACHED';
      conversationId: string;
      cascadeId: string;
      timestamp: number;
    }
  | {
      type: 'REQUEST_REFRESH';
      conversationId: string;
      cascadeId: string;
      sessionRevision?: number;
      modelId?: string;
      isStreaming?: boolean;
      timestamp: number;
    }
  | {
      type: 'MODEL_CHANGED';
      conversationId: string;
      cascadeId: string;
      sessionRevision?: number;
      modelId: string;
      isStreaming?: boolean;
      timestamp: number;
    }
  | {
      type: 'STREAMING_CHANGED';
      conversationId: string;
      cascadeId: string;
      sessionRevision?: number;
      modelId?: string;
      isStreaming: boolean;
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
