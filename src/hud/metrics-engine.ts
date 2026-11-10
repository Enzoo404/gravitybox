import { DatabaseSync } from 'node:sqlite';
import { lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ConversationHudMetrics, ParsedConversationStep } from './types.js';
import {
  resolveModelCapacity,
  DEFAULT_SYSTEM_PROMPT_BASELINE_TOKENS,
  DEFAULT_TOOL_DEFINITIONS_BASELINE_TOKENS,
} from './model-catalog.js';

/**
 * 64 位 BigInt 无符号 Varint 解码，彻底规避 32 位有符号位移溢出（如 2026+ 时间戳）
 */
export function decodeVarint64(buf: Uint8Array, cursor: { pos: number }): bigint {
  let result = 0n;
  let shift = 0n;
  while (cursor.pos < buf.length && shift <= 63n) {
    const b = BigInt(buf[cursor.pos++]!);
    result |= (b & 0x7fn) << shift;
    shift += 7n;
    if ((b & 0x80n) === 0n) break;
  }
  return result;
}

/**
 * 安全跳过未知或非目标 Protobuf wireType 字段，防止游标错位或死循环
 */
function skipProtobufField(buf: Uint8Array, cursor: { pos: number }, wireType: number): boolean {
  if (wireType === 0) {
    decodeVarint64(buf, cursor);
    return cursor.pos <= buf.length;
  }
  if (wireType === 1) {
    cursor.pos += 8;
    return cursor.pos <= buf.length;
  }
  if (wireType === 2) {
    const len = Number(decodeVarint64(buf, cursor));
    if (!Number.isSafeInteger(len) || len < 0 || cursor.pos + len > buf.length) return false;
    cursor.pos += len;
    return true;
  }
  if (wireType === 5) {
    cursor.pos += 4;
    return cursor.pos <= buf.length;
  }
  return false;
}

/**
 * 解析 Protobuf 时间戳 (field 1: 秒数 uint64, field 2: 纳秒数 uint32)
 * 完整支持 wireType 0 / 1 / 2 / 5 安全跳过
 */
export function parseProtobufTimestamp(fieldBuf: Uint8Array): number {
  const cursor = { pos: 0 };
  let seconds = 0n;
  let nanos = 0n;
  while (cursor.pos < fieldBuf.length) {
    const tag = Number(decodeVarint64(fieldBuf, cursor));
    if (!tag) break;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 0) {
      const val = decodeVarint64(fieldBuf, cursor);
      if (fieldNum === 1) seconds = val;
      else if (fieldNum === 2) nanos = val;
    } else {
      if (!skipProtobufField(fieldBuf, cursor, wireType)) break;
    }
  }
  return Number(seconds) + Number(nanos) / 1e9;
}

/**
 * 解析 steps.metadata 中的 ModelUsageStats (field 9, ~122 字节)
 * subfield 2: rawInput (uncached input tokens)
 * subfield 3: outputTokens (completion tokens)
 * subfield 4: cacheWriteTokens
 * subfield 5: cachedTokens (cached read tokens)
 * subfield 9: reasoningTokens
 * subfield 10: candidateTokens
 */
export function parseModelUsageStatsField9(usageBuf: Uint8Array): {
  rawInputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cachedReadTokens: number;
  reasoningTokens: number;
  candidateTokens: number;
} {
  const cursor = { pos: 0 };
  let rawInputTokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  let cachedReadTokens = 0;
  let reasoningTokens = 0;
  let candidateTokens = 0;

  while (cursor.pos < usageBuf.length) {
    const tag = Number(decodeVarint64(usageBuf, cursor));
    if (!tag) break;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 0) {
      const val = Number(decodeVarint64(usageBuf, cursor));
      const safeVal = Number.isFinite(val) && val >= 0 ? val : 0;
      if (fieldNum === 2) rawInputTokens = safeVal;
      else if (fieldNum === 3) outputTokens = safeVal;
      else if (fieldNum === 4) cacheWriteTokens = safeVal;
      else if (fieldNum === 5) cachedReadTokens = safeVal;
      else if (fieldNum === 9) reasoningTokens = safeVal;
      else if (fieldNum === 10) candidateTokens = safeVal;
    } else {
      if (!skipProtobufField(usageBuf, cursor, wireType)) break;
    }
  }

  return {
    rawInputTokens,
    outputTokens,
    cacheWriteTokens,
    cachedReadTokens,
    reasoningTokens,
    candidateTokens,
  };
}

/**
 * 解析单行 steps.metadata BLOB，提取高精度纳秒级时间戳与 field 9 用量
 */
export function parseStepMetadataBlob(
  idx: number,
  stepType: number,
  status: number,
  metadataBlob: Uint8Array | Buffer | null | undefined
): ParsedConversationStep {
  const result: ParsedConversationStep = {
    idx,
    stepType,
    status,
    startTimeSeconds: null,
    firstTokenSeconds: null,
    endTimeSeconds: null,
    rawInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cachedReadTokens: 0,
    reasoningTokens: 0,
    candidateTokens: 0,
  };

  if (!metadataBlob || metadataBlob.length === 0) {
    return result;
  }

  const buf =
    metadataBlob instanceof Uint8Array
      ? metadataBlob
      : new Uint8Array(metadataBlob);
  const cursor = { pos: 0 };
  let field7Ts: number | null = null;
  let field8Ts: number | null = null;

  while (cursor.pos < buf.length) {
    const tag = Number(decodeVarint64(buf, cursor));
    if (!tag) break;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === 2) {
      const len = Number(decodeVarint64(buf, cursor));
      if (!Number.isSafeInteger(len) || len < 0 || cursor.pos + len > buf.length) break;
      const subBuf = buf.subarray(cursor.pos, cursor.pos + len);
      cursor.pos += len;

      if (fieldNum === 1) {
        const ts = parseProtobufTimestamp(subBuf);
        if (ts > 0) result.startTimeSeconds = ts;
      } else if (fieldNum === 6 && stepType === 15) {
        const ts = parseProtobufTimestamp(subBuf);
        if (ts > 0) result.firstTokenSeconds = ts;
      } else if (fieldNum === 7) {
        const ts = parseProtobufTimestamp(subBuf);
        if (ts > 0) field7Ts = ts;
      } else if (fieldNum === 8) {
        const ts = parseProtobufTimestamp(subBuf);
        if (ts > 0) field8Ts = ts;
      } else if (fieldNum === 9 && stepType === 15) {
        const usage = parseModelUsageStatsField9(subBuf);
        result.rawInputTokens = usage.rawInputTokens;
        result.outputTokens = usage.outputTokens;
        result.cacheWriteTokens = usage.cacheWriteTokens;
        result.cachedReadTokens = usage.cachedReadTokens;
        result.reasoningTokens = usage.reasoningTokens;
        result.candidateTokens = usage.candidateTokens;
      }
    } else {
      if (!skipProtobufField(buf, cursor, wireType)) break;
    }
  }

  result.endTimeSeconds = field8Ts ?? field7Ts;
  return result;
}

/**
 * 级联独立裁剪数学模型 (Cascade Token Truncation)
 * 严格保证 T_i >= 0, W_i >= 0, sum(T_i) === U, sum(W_i) === Ratio_total
 */
export function computeCascadeContextBreakdown(
  usedTokens: number,
  capacityLimit: number,
  K_sys: number = DEFAULT_SYSTEM_PROMPT_BASELINE_TOKENS,
  K_tool: number = DEFAULT_TOOL_DEFINITIONS_BASELINE_TOKENS
): {
  T_sys: number;
  T_tool: number;
  T_msg: number;
  W_sys: number;
  W_tool: number;
  W_msg: number;
  Ratio_total: number;
  sumT: number;
  sumW: number;
} {
  const U = Math.max(0, Math.floor(Number.isFinite(usedTokens) ? usedTokens : 0));
  const C_limit = Math.max(1, Math.floor(Number.isFinite(capacityLimit) ? capacityLimit : 1));

  const T_sys = Math.min(U, K_sys);
  const T_tool = Math.min(Math.max(0, U - T_sys), K_tool);
  const T_msg = Math.max(0, U - T_sys - T_tool);

  const W_sys = (T_sys / C_limit) * 100;
  const W_tool = (T_tool / C_limit) * 100;
  const W_msg = (T_msg / C_limit) * 100;
  const Ratio_total = (Math.min(U, C_limit) / C_limit) * 100;

  return {
    T_sys,
    T_tool,
    T_msg,
    W_sys,
    W_tool,
    W_msg,
    Ratio_total,
    sumT: T_sys + T_tool + T_msg,
    sumW: W_sys + W_tool + W_msg,
  };
}

/**
 * TPS 时间窗口保护 (minWindow = 0.1s) 与物理上限拦截 (maxTpsCap = 500 tok/s)
 */
export function computeTps(
  activeSec: number,
  totalOutputTokens: number,
  minWindow: number = 0.1,
  maxTpsCap: number = 500
): {
  status: 'pending_or_fallback' | 'calculated';
  rawTps: number | null;
  outputTps: number;
  formatted: string;
} {
  if (!Number.isFinite(activeSec) || activeSec < minWindow || totalOutputTokens <= 0) {
    return {
      status: 'pending_or_fallback',
      rawTps: null,
      outputTps: 0,
      formatted: '—',
    };
  }
  const rawTps = totalOutputTokens / activeSec;
  const clampedTps = Math.min(maxTpsCap, Math.max(0, Math.round(rawTps)));
  return {
    status: 'calculated',
    rawTps,
    outputTps: clampedTps,
    formatted: `${clampedTps} tok/s`,
  };
}

/**
 * 格式化紧凑 Token 读数 (如 58593793 -> "58.6M", 672000 -> "672K", 1900 -> "1.9K")
 */
export function formatCompactTokenNumber(tokens: number, prefixTilde = false): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(tokens) ? tokens : 0));
  if (safe === 0) return '0';
  const tilde = prefixTilde ? '~' : '';
  if (safe >= 1_000_000) {
    const val = (safe / 1_000_000).toFixed(1).replace(/\.0$/, '');
    return `${tilde}${val}M`;
  }
  if (safe >= 1_000) {
    const rawK = safe / 1_000;
    const val = rawK >= 100 ? Math.round(rawK).toString() : rawK.toFixed(1).replace(/\.0$/, '');
    return `${tilde}${val}K`;
  }
  return `${tilde}${safe}`;
}

/**
 * 格式化千分位 Token 读数 (如 "58,593,793 tok")
 */
export function formatThousandsTokens(tokens: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(tokens) ? tokens : 0));
  return `${safe.toLocaleString('en-US')} tok`;
}

/**
 * 格式化用时 (如 3959 秒 -> "65 分 59 秒", 751 秒 -> "12 分 31 秒", 0 秒 -> "0 秒")
 */
export function formatDurationSeconds(seconds: number, lang: 'zh' | 'en' = 'zh'): string {
  const totalSec = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  if (totalSec === 0) {
    return lang === 'en' ? '0s' : '0 秒';
  }
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins === 0) {
    return lang === 'en' ? `${secs}s` : `${secs} 秒`;
  }
  if (lang === 'en') {
    return `${mins}m ${secs}s`;
  }
  return `${mins} 分 ${secs} 秒`;
}

export interface ComputeHudMetricsInput {
  conversationId?: string;
  sessionRevision?: number;
  isStreaming?: boolean;
  modelId?: string;
  modelCapacity?: number;
  steps: Array<{
    idx?: number;
    step_type?: number;
    stepType?: number;
    status?: number;
    t_start?: number | null;
    startTimeSeconds?: number | null;
    t_first_token?: number | null;
    firstTokenSeconds?: number | null;
    t_end?: number | null;
    endTimeSeconds?: number | null;
    rawInput?: number;
    rawInputTokens?: number;
    cachedTokens?: number;
    cachedReadTokens?: number;
    cacheWriteTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    candidateTokens?: number;
  }>;
}

/**
 * 从步骤列表聚合完整的 ConversationHudMetrics 快照
 */
export function buildConversationHudMetrics(input: ComputeHudMetricsInput): ConversationHudMetrics {
  const conversationId = input.conversationId || 'default';
  const sessionRevision = input.sessionRevision ?? 1;
  const isStreaming = Boolean(input.isStreaming);
  const modelSpec = resolveModelCapacity(input.modelId);
  const capacityTokens =
    typeof input.modelCapacity === 'number' && input.modelCapacity > 0
      ? input.modelCapacity
      : modelSpec.capacityTokens;

  const steps = input.steps || [];
  let turns = 0;
  const totalSteps = steps.length;

  let modelDurationSeconds = 0;
  let toolDurationSeconds = 0;
  let validTtftSum = 0;
  let validTtftCount = 0;
  let activeGenerationSeconds = 0;

  let uncachedInputTokens = 0;
  let cachedReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let candidateTokens = 0;

  let lastStep15PromptTokens = 0;

  for (const s of steps) {
    const stepType = s.step_type ?? s.stepType ?? 0;
    const tStart = s.t_start ?? s.startTimeSeconds ?? null;
    const tFirst = s.t_first_token ?? s.firstTokenSeconds ?? null;
    const tEnd = s.t_end ?? s.endTimeSeconds ?? null;

    if (stepType === 101) {
      turns++;
    } else if (stepType === 15) {
      if (tStart != null && tEnd != null) {
        modelDurationSeconds += Math.max(0, tEnd - tStart);
      }
      if (tStart != null && tFirst != null && tFirst >= tStart) {
        validTtftSum += Math.max(0, tFirst - tStart);
        validTtftCount++;
      }
      if (tFirst != null && tEnd != null) {
        activeGenerationSeconds += Math.max(0, tEnd - tFirst);
      } else if (tStart != null && tEnd != null) {
        activeGenerationSeconds += Math.max(0, tEnd - tStart);
      }

      const stepRawIn = Math.max(0, s.rawInput ?? s.rawInputTokens ?? 0);
      const stepCachedRead = Math.max(0, s.cachedTokens ?? s.cachedReadTokens ?? 0);
      const stepCacheWrite = Math.max(0, s.cacheWriteTokens ?? 0);
      const stepOut = Math.max(0, s.outputTokens ?? 0);
      const stepReasoning = Math.max(0, s.reasoningTokens ?? 0);
      const stepCandidate = Math.max(0, s.candidateTokens ?? 0);

      uncachedInputTokens += stepRawIn;
      cachedReadTokens += stepCachedRead;
      cacheWriteTokens += stepCacheWrite;
      outputTokens += stepOut;
      reasoningTokens += stepReasoning;
      candidateTokens += stepCandidate;

      if (stepRawIn + stepCachedRead > 0) {
        lastStep15PromptTokens = stepRawIn + stepCachedRead;
      }
    } else if (stepType === 132) {
      if (tStart != null && tEnd != null) {
        toolDurationSeconds += Math.max(0, tEnd - tStart);
      }
    }
  }

  // TTFT
  const averageTtftSeconds = validTtftCount > 0 ? validTtftSum / validTtftCount : 0;
  const averageTtftFormatted = validTtftCount > 0 ? `${averageTtftSeconds.toFixed(1)} 秒` : '—';
  const averageTtftFormattedEn = validTtftCount > 0 ? `${averageTtftSeconds.toFixed(1)}s` : '—';

  // TPS (0.1s 窗口保护 + 500 tok/s 物理上限)
  const tpsInfo = computeTps(activeGenerationSeconds, outputTokens, 0.1, 500);
  const outputTpsFormatted =
    tpsInfo.status === 'calculated'
      ? tpsInfo.formatted
      : isStreaming
      ? '计算中...'
      : '—';

  // Token 总量严格守恒: uncachedInput + cachedRead + output (+ cacheWrite)
  const totalTokens = uncachedInputTokens + cachedReadTokens + outputTokens + cacheWriteTokens;
  const totalTokensCompact = `${formatCompactTokenNumber(totalTokens, false)} tok`;
  const totalTokensFormatted = formatThousandsTokens(totalTokens);

  const hitDenom = uncachedInputTokens + cachedReadTokens;
  const cacheHitRate = hitDenom > 0 ? cachedReadTokens / hitDenom : 0;
  const cacheHitRateFormatted = `${Math.round(cacheHitRate * 100)}%`;

  // 上下文窗口与级联独立裁剪
  const usedTokens = lastStep15PromptTokens;
  const rawUsedRatio = capacityTokens > 0 ? usedTokens / capacityTokens : 0;
  const usedRatio = Math.min(1.0, Math.max(0, rawUsedRatio));
  const usedRatioFormatted = `${Math.round(usedRatio * 100)}%`;

  const cascade = computeCascadeContextBreakdown(usedTokens, capacityTokens);

  return {
    conversationId,
    sessionRevision,
    updatedAt: Date.now(),
    isStreaming,
    session: {
      turns,
      steps: totalSteps,
      modelDurationSeconds,
      modelDurationFormatted: formatDurationSeconds(modelDurationSeconds, 'zh'),
      modelDurationFormattedEn: formatDurationSeconds(modelDurationSeconds, 'en'),
      toolDurationSeconds,
      toolDurationFormatted: formatDurationSeconds(toolDurationSeconds, 'zh'),
      toolDurationFormattedEn: formatDurationSeconds(toolDurationSeconds, 'en'),
      averageTtftSeconds,
      averageTtftFormatted,
      averageTtftFormattedEn,
      outputTps: tpsInfo.outputTps,
      outputTpsFormatted,
    },
    tokens: {
      totalTokens,
      totalTokensCompact,
      totalTokensFormatted,
      cacheHitRate,
      cacheHitRateFormatted,
      uncachedInputTokens,
      uncachedInputFormatted: formatThousandsTokens(uncachedInputTokens),
      cachedReadTokens,
      cachedReadFormatted: formatThousandsTokens(cachedReadTokens),
      ...(cacheWriteTokens > 0
        ? {
            cacheWriteTokens,
            cacheWriteFormatted: formatThousandsTokens(cacheWriteTokens),
          }
        : {}),
      outputTokens,
      outputFormatted: formatThousandsTokens(outputTokens),
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      ...(candidateTokens > 0 ? { candidateTokens } : {}),
    },
    context: {
      modelId: modelSpec.modelId,
      modelDisplayName: modelSpec.displayName,
      usedTokens,
      usedTokensCompact: usedTokens > 0 ? formatCompactTokenNumber(usedTokens, true) : '0',
      capacityTokens,
      capacityTokensCompact:
        input.modelCapacity && input.modelCapacity !== modelSpec.capacityTokens
          ? formatCompactTokenNumber(input.modelCapacity, false)
          : modelSpec.capacityCompact,
      isFallbackCapacity: modelSpec.isFallback,
      usedRatio,
      usedRatioFormatted,
      breakdown: {
        systemTokens: cascade.T_sys,
        systemTokensCompact: formatCompactTokenNumber(cascade.T_sys, true),
        systemRatio: cascade.W_sys,
        toolTokens: cascade.T_tool,
        toolTokensCompact: formatCompactTokenNumber(cascade.T_tool, true),
        toolRatio: cascade.W_tool,
        messageTokens: cascade.T_msg,
        messageTokensCompact: formatCompactTokenNumber(cascade.T_msg, true),
        messageRatio: cascade.W_msg,
      },
    },
  };
}

interface CachedConversationState {
  mtimeMs: number;
  size: number;
  walMtimeMs: number;
  walSize: number;
  lastStepIdx: number;
  steps: ParsedConversationStep[];
  lastMetrics?: ConversationHudMetrics;
}

/**
 * 零阻塞、单语句自动提交 (Auto-Commit) 会话指标增量采集引擎
 * 严禁显式 BEGIN 事务，100% 保障宿主 wal_checkpoint(TRUNCATE) 畅通无阻 (busy: 0)
 */
export class ConversationMetricsEngine {
  private readonly conversationsDir: string;
  private readonly cache = new Map<string, CachedConversationState>();

  constructor(options?: { geminiDir?: string; conversationsDir?: string }) {
    const baseGemini = options?.geminiDir ?? join(homedir(), '.gemini');
    this.conversationsDir =
      options?.conversationsDir ?? join(baseGemini, 'antigravity', 'conversations');
  }

  public resolveDbPath(conversationId: string): string {
    // 严格清洗 conversationId 防止路径穿越
    const cleanId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleanId) {
      throw new Error('无效的会话 ID');
    }
    return join(this.conversationsDir, `${cleanId}.db`);
  }

  /**
   * 读取并计算指定会话的最新 HUD 度量快照
   * Level-1: lstat(db) & lstat(db-wal) 0.1ms 快速门控
   * Level-2: 单语句 Auto-Commit 增量查询 steps (idx > lastStepIdx)
   */
  public async getConversationMetrics(options: {
    conversationId: string;
    sessionRevision?: number;
    modelId?: string;
    isStreaming?: boolean;
    dbPathOverride?: string;
  }): Promise<ConversationHudMetrics> {
    const {
      conversationId,
      sessionRevision = 1,
      modelId,
      isStreaming = false,
      dbPathOverride,
    } = options;

    const dbPath = dbPathOverride || this.resolveDbPath(conversationId);
    if (!existsSync(dbPath)) {
      return buildConversationHudMetrics({
        conversationId,
        sessionRevision,
        isStreaming,
        modelId,
        steps: [],
      });
    }

    let dbStat: { mtimeMs: number; size: number } | null = null;
    let walStat: { mtimeMs: number; size: number } | null = null;
    try {
      const st = await lstat(dbPath);
      if (!st.isFile() || st.isSymbolicLink()) {
        return buildConversationHudMetrics({
          conversationId,
          sessionRevision,
          isStreaming,
          modelId,
          steps: [],
        });
      }
      dbStat = { mtimeMs: st.mtimeMs, size: st.size };
      try {
        const wst = await lstat(`${dbPath}-wal`);
        walStat = { mtimeMs: wst.mtimeMs, size: wst.size };
      } catch {
        walStat = null;
      }
    } catch {
      return buildConversationHudMetrics({
        conversationId,
        sessionRevision,
        isStreaming,
        modelId,
        steps: [],
      });
    }

    const existing = this.cache.get(dbPath);
    const walMtimeMs = walStat?.mtimeMs ?? 0;
    const walSize = walStat?.size ?? 0;

    // Level-1 Stat Gate: 文件与 WAL 均未变化时直接基于内存缓存重算模型/流式状态，0 SQLite 触碰
    if (
      existing &&
      existing.mtimeMs === dbStat.mtimeMs &&
      existing.size === dbStat.size &&
      existing.walMtimeMs === walMtimeMs &&
      existing.walSize === walSize
    ) {
      const metrics = buildConversationHudMetrics({
        conversationId,
        sessionRevision,
        isStreaming,
        modelId,
        steps: existing.steps,
      });
      existing.lastMetrics = metrics;
      return metrics;
    }

    // Level-2: 单语句 Auto-Commit 增量读取（绝不执行 BEGIN / BEGIN DEFERRED）
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 2000; PRAGMA read_uncommitted = ON;');

      // 检查当前 steps 表最大 idx 与总行数（处理会话重置或回滚的边界情况）
      const summaryRow = db
        .prepare('SELECT COUNT(*) as totalCount, COALESCE(MAX(idx), -1) as maxIdx FROM steps')
        .get() as { totalCount?: number; maxIdx?: number } | undefined;

      const totalCount = Number(summaryRow?.totalCount ?? 0);
      const maxIdx = Number(summaryRow?.maxIdx ?? -1);

      let baseSteps: ParsedConversationStep[] = [];
      let lastIdx = -1;

      if (existing && existing.lastStepIdx <= maxIdx && existing.steps.length <= totalCount) {
        baseSteps = existing.steps;
        lastIdx = existing.lastStepIdx;
      }

      if (maxIdx > lastIdx || baseSteps.length !== totalCount) {
        const rows = db
          .prepare(
            'SELECT idx, step_type, status, CASE WHEN step_type IN (15, 132) THEN metadata ELSE NULL END as metadata FROM steps WHERE idx > ? ORDER BY idx ASC'
          )
          .all(lastIdx) as Array<{
          idx: number;
          step_type: number;
          status: number;
          metadata: Uint8Array | null;
        }>;

        for (const row of rows) {
          const parsed = parseStepMetadataBlob(
            Number(row.idx),
            Number(row.step_type),
            Number(row.status),
            row.metadata
          );
          baseSteps.push(parsed);
          if (parsed.idx > lastIdx) {
            lastIdx = parsed.idx;
          }
        }
      }

      db.close();
      db = null;

      const metrics = buildConversationHudMetrics({
        conversationId,
        sessionRevision,
        isStreaming,
        modelId,
        steps: baseSteps,
      });

      this.cache.set(dbPath, {
        mtimeMs: dbStat.mtimeMs,
        size: dbStat.size,
        walMtimeMs,
        walSize,
        lastStepIdx: lastIdx,
        steps: baseSteps,
        lastMetrics: metrics,
      });

      return metrics;
    } catch {
      try {
        db?.close();
      } catch {}
      if (existing?.lastMetrics) {
        return {
          ...existing.lastMetrics,
          conversationId,
          sessionRevision,
          isStreaming,
          updatedAt: Date.now(),
        };
      }
      return buildConversationHudMetrics({
        conversationId,
        sessionRevision,
        isStreaming,
        modelId,
        steps: [],
      });
    }
  }

  public async readConversationMetrics(options: {
    conversationId: string;
    sessionRevision?: number;
    modelId?: string;
    isStreaming?: boolean;
    dbPathOverride?: string;
  }): Promise<ConversationHudMetrics> {
    return this.getConversationMetrics(options);
  }

  public clearCache(): void {
    this.cache.clear();
  }
}
