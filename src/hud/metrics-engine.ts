import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  ConversationHudMetrics,
  HudActivityPhase,
  ParsedConversationStep,
  ParsedGenMetadata,
} from './types.js';
import { resolveModelCapacity } from './model-catalog.js';
import { projectProtobuf, type ProtoSelection } from '../protobuf-projection.js';

// 精确拦截 node:sqlite 首次加载时的 ExperimentalWarning，不移除或破坏宿主进程的其它 warning 监听器
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: any[]) => {
  const msg = typeof warning === 'string' ? warning : warning?.message ?? '';
  const type = typeof warning === 'object' && warning ? warning.name : typeof args[0] === 'string' ? args[0] : (args[0]?.type ?? '');
  if ((type === 'ExperimentalWarning' || String(msg).includes('SQLite')) && String(msg).includes('SQLite')) {
    return;
  }
  return (originalEmitWarning as (...a: any[]) => void)(warning, ...args);
}) as typeof process.emitWarning;

const { DatabaseSync } = await import('node:sqlite');

const UUID_REGEX_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ACTIVE_STEP_STATUSES = new Set([1, 2, 8, 9]);
const SUBAGENT_TOOL_NAMES = new Set([
  'invoke_subagent',
  'default_api:invoke_subagent',
  'browser_subagent',
  'start_subagent',
  'spawn_subagent',
]);
const MAX_CACHED_CONVERSATIONS = 24;
const ACTIVE_DB_RECENCY_MS = 5 * 60 * 1000;
const INLINE_BLOB_LIMIT_BYTES = 65_536;

const HUD_STEP_METADATA_PROJECTION: ProtoSelection = {
  1: true,
  4: { 2: true, 3: true, 8: true },
  6: true,
  7: true,
  8: true,
  9: true,
  12: true,
  22: true,
  24: { 4: true, 8: true, 12: true, 20: true },
  32: true,
};

const HUD_GEN_METADATA_PROJECTION: ProtoSelection = {
  1: {
    4: true,
    9: { 10: { 1: true, 3: true, 4: true } },
    11: true,
    12: true,
    19: true,
    21: true,
  },
  2: true,
  4: true,
  3: {
    14: true,
    27: { 4: true, 8: true, 12: true, 20: true },
    28: true,
  },
};

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
 * 解析 Protobuf Timestamp / Duration (field 1: 秒数 int64/uint64, field 2: 纳秒数 int32)
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
 * 解析 steps.metadata 中的 ModelUsageStats (field 9)
 * subfield 2: input_tokens (uncached input tokens)
 * subfield 3: output_tokens (total completion tokens)
 * subfield 4: cache_write_tokens
 * subfield 5: cache_read_tokens (cached read tokens)
 * subfield 9: thinking_output_tokens (reasoning output tokens)
 * subfield 10: response_output_tokens (candidate output tokens)
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
 * 解析 ModelInfo (steps.metadata field 24 或 planner_config field 27)
 * subfield 4: max_tokens
 * subfield 8: model_name
 * subfield 12: chat_model_name
 * subfield 20: display_name
 */
function parseModelInfoBlob(buf: Uint8Array): { maxTokens?: number; modelName?: string } {
  const cursor = { pos: 0 };
  let maxTokens: number | undefined;
  let modelName: string | undefined;
  const decoder = new TextDecoder('utf-8');

  while (cursor.pos < buf.length) {
    const tag = Number(decodeVarint64(buf, cursor));
    if (!tag) break;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 0) {
      const val = Number(decodeVarint64(buf, cursor));
      if (fieldNum === 4 && val > 0) maxTokens = val;
    } else if (wireType === 2) {
      const len = Number(decodeVarint64(buf, cursor));
      if (!Number.isSafeInteger(len) || len < 0 || cursor.pos + len > buf.length) break;
      if ((fieldNum === 8 || fieldNum === 12 || fieldNum === 20) && len > 0 && len < 256) {
        const str = decoder.decode(buf.subarray(cursor.pos, cursor.pos + len)).trim();
        if (str && (!modelName || fieldNum === 20)) modelName = str;
      }
      cursor.pos += len;
    } else {
      if (!skipProtobufField(buf, cursor, wireType)) break;
    }
  }
  return { maxTokens, modelName };
}

/**
 * 解析 ChatToolCall (CortexStepMetadata.field 4)
 * subfield 2: name (e.g. "invoke_subagent", "browser_subagent", "send_message")
 * subfield 3: arguments_json
 */
function parseChatToolCallBlob(buf: Uint8Array): { name?: string; childIds: string[] } {
  const cursor = { pos: 0 };
  let name: string | undefined;
  const candidateSlices: Array<{ start: number; end: number }> = [];
  const decoder = new TextDecoder('utf-8');

  while (cursor.pos < buf.length) {
    const tag = Number(decodeVarint64(buf, cursor));
    if (!tag) break;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 2) {
      const len = Number(decodeVarint64(buf, cursor));
      if (!Number.isSafeInteger(len) || len < 0 || cursor.pos + len > buf.length) break;
      if (fieldNum === 2 && len > 0 && len < 256) {
        name = decoder.decode(buf.subarray(cursor.pos, cursor.pos + len)).trim();
      } else if ((fieldNum === 3 || fieldNum === 8) && len > 0 && len < 65536) {
        candidateSlices.push({ start: cursor.pos, end: cursor.pos + len });
      }
      cursor.pos += len;
    } else {
      if (!skipProtobufField(buf, cursor, wireType)) break;
    }
  }

  // 仅当工具确实为子智能体调度工具时才提取参数/结果中的子会话 UUID，杜绝 run_command / read_file 参数中的无关 UUID 串号污染
  const childIds = new Set<string>();
  if (name && SUBAGENT_TOOL_NAMES.has(name)) {
    for (const slice of candidateSlices) {
      const jsonStr = decoder.decode(buf.subarray(slice.start, slice.end));
      for (const m of jsonStr.matchAll(UUID_REGEX_GLOBAL)) {
        if (m[0]) childIds.add(m[0].toLowerCase());
      }
    }
  }
  return { name, childIds: [...childIds] };
}

/**
 * 从二进制切片中提取 UUID 字符串（用于 step_type = 127 INVOKE_SUBAGENT 等载荷提取子会话 ID）
 */
function extractUuidsFromBlob(buf: Uint8Array | null | undefined, maxBytes = 65536): string[] {
  if (!buf || buf.length === 0) return [];
  const slice = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
  const found = new Set<string>();
  for (const m of text.matchAll(UUID_REGEX_GLOBAL)) {
    if (m[0]) found.add(m[0].toLowerCase());
  }
  return [...found];
}

function parentReferences(buf: Uint8Array): Set<string> {
  const references = new Set<string>();
  const cursor = { pos: 0 };
  while (cursor.pos < buf.length) {
    const tag = Number(decodeVarint64(buf, cursor));
    const field = tag >>> 3;
    const wire = tag & 7;
    if ((field === 5 || field === 6) && wire === 2) {
      const length = Number(decodeVarint64(buf, cursor));
      if (!Number.isSafeInteger(length) || cursor.pos + length > buf.length) break;
      if (length === 36) {
        const value = Buffer.from(buf.subarray(cursor.pos, cursor.pos + length)).toString('utf8');
        if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) references.add(value.toLowerCase());
      }
      cursor.pos += length;
    } else if (!skipProtobufField(buf, cursor, wire)) {
      break;
    }
  }
  return references;
}

/**
 * 解析单行 steps.metadata BLOB (CortexStepMetadata)：
 * - field 1: created_at (Timestamp)
 * - field 4: tool_call (ChatToolCall -> field 2: name, field 3: arguments_json)
 * - field 6: viewable_at (Timestamp)
 * - field 7: finished_generating_at (Timestamp)
 * - field 8: completed_at (Timestamp)
 * - field 9: model_usage (ModelUsageStats)
 * - field 22: last_completed_chunk_at (Timestamp)
 * - field 24: model_info (ModelInfo)
 * - field 32: started_at (Timestamp)
 */
export function parseStepMetadataBlob(
  idx: number,
  stepType: number,
  status: number,
  metadataBlob: Uint8Array | Buffer | null | undefined,
  dataBlob?: Uint8Array | Buffer | null | undefined,
  extraSubagentBlobs?: Array<Uint8Array | Buffer | null | undefined>
): ParsedConversationStep {
  const result: ParsedConversationStep = {
    idx,
    stepType,
    status,
    createdAtSeconds: null,
    startedAtSeconds: null,
    startTimeSeconds: null,
    firstTokenSeconds: null,
    finishedGeneratingSeconds: null,
    completedAtSeconds: null,
    endTimeSeconds: null,
    rawInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cachedReadTokens: 0,
    reasoningTokens: 0,
    candidateTokens: 0,
    hasUsage: false,
    isSubagentStep: stepType === 127,
  };

  const childIds = new Set<string>();

  if (metadataBlob && metadataBlob.length > 0) {
    const buf: Uint8Array = metadataBlob;
    const cursor = { pos: 0 };
    let field1CreatedTs: number | null = null;
    let field6ViewableTs: number | null = null;
    let field7FinishedGenTs: number | null = null;
    let field8CompletedTs: number | null = null;
    let field22LastChunkTs: number | null = null;
    let field32StartedTs: number | null = null;

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
          if (ts > 0) field1CreatedTs = ts;
        } else if (fieldNum === 4) {
          const toolInfo = parseChatToolCallBlob(subBuf);
          if (toolInfo.name) {
            result.toolCallName = toolInfo.name;
            if (SUBAGENT_TOOL_NAMES.has(toolInfo.name)) {
              result.isSubagentStep = true;
            }
          }
          for (const cid of toolInfo.childIds) childIds.add(cid);
        } else if (fieldNum === 6 && stepType === 15) {
          const ts = parseProtobufTimestamp(subBuf);
          if (ts > 0) field6ViewableTs = ts;
        } else if (fieldNum === 7) {
          const ts = parseProtobufTimestamp(subBuf);
          if (ts > 0) field7FinishedGenTs = ts;
        } else if (fieldNum === 8) {
          const ts = parseProtobufTimestamp(subBuf);
          if (ts > 0) field8CompletedTs = ts;
        } else if (fieldNum === 9 && stepType === 15) {
          const usage = parseModelUsageStatsField9(subBuf);
          result.hasUsage = true;
          result.rawInputTokens = usage.rawInputTokens;
          result.outputTokens = usage.outputTokens;
          result.cacheWriteTokens = usage.cacheWriteTokens;
          result.cachedReadTokens = usage.cachedReadTokens;
          result.reasoningTokens = usage.reasoningTokens;
          result.candidateTokens = usage.candidateTokens;
        } else if (fieldNum === 12) {
          result.executionId = Buffer.from(subBuf).toString('hex');
        } else if (fieldNum === 22 && stepType === 15) {
          const ts = parseProtobufTimestamp(subBuf);
          if (ts > 0) field22LastChunkTs = ts;
        } else if (fieldNum === 24) {
          const info = parseModelInfoBlob(subBuf);
          if (info.maxTokens) result.modelMaxTokens = info.maxTokens;
          if (info.modelName) result.modelName = info.modelName;
        } else if (fieldNum === 32) {
          const ts = parseProtobufTimestamp(subBuf);
          if (ts > 0) field32StartedTs = ts;
        }
      } else {
        if (!skipProtobufField(buf, cursor, wireType)) break;
      }
    }

    result.createdAtSeconds = field1CreatedTs;
    result.startedAtSeconds = field32StartedTs;
    result.firstTokenSeconds = field6ViewableTs;
    result.finishedGeneratingSeconds = field7FinishedGenTs;
    result.completedAtSeconds = field8CompletedTs;

    if (stepType === 15) {
      // 模型响应步骤 (PLANNER_RESPONSE):
      // 起始时间取 created_at (field 1)；生成结束时间优先取 finished_generating_at (field 7) 或 last_completed_chunk_at (field 22)，回退 completed_at (field 8)
      result.startTimeSeconds = field1CreatedTs ?? field32StartedTs;
      result.endTimeSeconds = field7FinishedGenTs ?? field22LastChunkTs ?? field8CompletedTs;
    } else {
      // 工具调用步骤:
      // 结束时间取 completed_at (field 8) ?? finished_generating_at (field 7)
      // 起始时间若存在有效的 started_at (field 32，代表工具实际开始执行时刻，不含前置排队/审批等待)，优先采用 started_at
      const toolEnd = field8CompletedTs ?? field7FinishedGenTs;
      result.endTimeSeconds = toolEnd;
      if (
        field32StartedTs !== null &&
        (field1CreatedTs === null || field32StartedTs >= field1CreatedTs) &&
        (toolEnd === null || field32StartedTs <= toolEnd)
      ) {
        result.startTimeSeconds = field32StartedTs;
      } else {
        result.startTimeSeconds = field1CreatedTs ?? field32StartedTs;
      }
    }
  }

  if (result.isSubagentStep && dataBlob && dataBlob.length > 0) {
    for (const cid of extractUuidsFromBlob(dataBlob)) {
      childIds.add(cid);
    }
  }
  if (result.isSubagentStep && extraSubagentBlobs && extraSubagentBlobs.length > 0) {
    for (const extra of extraSubagentBlobs) {
      if (!extra || extra.length === 0) continue;
      for (const cid of extractUuidsFromBlob(extra)) {
        childIds.add(cid);
      }
    }
  }

  if (childIds.size > 0) {
    result.childConversationIds = [...childIds];
  }

  return result;
}

/**
 * 解析 gen_metadata.data 的真实模型、权威流式耗时与上下文窗口配置 (零大块拷贝，O(fields) 游标跳跃)
 * CortexStepGeneratorMetadata:
 * - field 1: chat_model (ChatModelMetadata)
 *   - field 9: chat_start_metadata -> field 10: context_window_metadata
 *     - field 1: estimated_tokens_used
 *     - field 3: token_breakdown -> field 1: groups (TopLevelTokenGroup: field 2 type, field 4 num_tokens)
 *     - field 4: max_context_tokens
 *   - field 11: time_to_first_token (google.protobuf.Duration)
 *   - field 12: streaming_duration (google.protobuf.Duration)
 *   - field 19: response_model
 *   - field 21: model_display_name
 * - field 3: planner_config (CascadePlannerConfig)
 *   - field 14: truncation_threshold_tokens
 *   - field 27: custom_model_info_override -> field 4: max_tokens
 *   - field 28: model_name
 */
export function parseLatestGenMetadataBlob(
  dataBlob: Uint8Array | Buffer | null | undefined
): ParsedGenMetadata {
  const out: ParsedGenMetadata = {};
  if (!dataBlob || dataBlob.length === 0) return out;

  const buf: Uint8Array = dataBlob;
  const decoder = new TextDecoder('utf-8');
  const cursor = { pos: 0 };

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

      if (fieldNum === 2) {
        const packed = { pos: 0 };
        out.stepIndices ??= [];
        while (packed.pos < subBuf.length && out.stepIndices.length < 10000) {
          const value = Number(decodeVarint64(subBuf, packed));
          if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) {
            out.stepIndices.push(value);
          }
        }
      } else if (fieldNum === 4) {
        out.executionId = Buffer.from(subBuf).toString('hex');
      } else if (fieldNum === 1) {
        // ChatModelMetadata
        const c1 = { pos: 0 };
        while (c1.pos < subBuf.length) {
          const t1 = Number(decodeVarint64(subBuf, c1));
          if (!t1) break;
          const fn1 = t1 >>> 3;
          const wt1 = t1 & 0x07;
          if (wt1 === 2) {
            const l1 = Number(decodeVarint64(subBuf, c1));
            if (!Number.isSafeInteger(l1) || l1 < 0 || c1.pos + l1 > subBuf.length) break;
            const fieldSlice = subBuf.subarray(c1.pos, c1.pos + l1);
            if (fn1 === 4) {
              out.usage = parseModelUsageStatsField9(fieldSlice);
            } else if ((fn1 === 19 || fn1 === 21) && l1 > 0 && l1 < 256) {
              const str = decoder.decode(fieldSlice).trim();
              if (str) {
                if (fn1 === 19) out.responseModel = str;
                else if (fn1 === 21) out.modelDisplayName = str;
              }
            } else if (fn1 === 11 && l1 <= 32) {
              // field 11: time_to_first_token (google.protobuf.Duration)
              const ttftSec = parseProtobufTimestamp(fieldSlice);
              if (ttftSec >= 0 && Number.isFinite(ttftSec)) {
                out.timeToFirstTokenSeconds = ttftSec;
              }
            } else if (fn1 === 12 && l1 <= 32) {
              // field 12: streaming_duration (google.protobuf.Duration)
              const streamSec = parseProtobufTimestamp(fieldSlice);
              if (streamSec >= 0 && Number.isFinite(streamSec)) {
                out.streamingDurationSeconds = streamSec;
              }
            } else if (fn1 === 9) {
              // ChatStartMetadata -> field 10: ContextWindowMetadata
              const startBuf = fieldSlice;
              const cStart = { pos: 0 };
              while (cStart.pos < startBuf.length) {
                const tS = Number(decodeVarint64(startBuf, cStart));
                if (!tS) break;
                const fnS = tS >>> 3;
                const wtS = tS & 0x07;
                if (wtS === 2 && fnS === 10) {
                  const lS = Number(decodeVarint64(startBuf, cStart));
                  if (!Number.isSafeInteger(lS) || lS < 0 || cStart.pos + lS > startBuf.length) break;
                  const cwBuf = startBuf.subarray(cStart.pos, cStart.pos + lS);
                  cStart.pos += lS;
                  const cCw = { pos: 0 };
                  while (cCw.pos < cwBuf.length) {
                    const tCw = Number(decodeVarint64(cwBuf, cCw));
                    if (!tCw) break;
                    const fnCw = tCw >>> 3;
                    const wtCw = tCw & 0x07;
                    if (wtCw === 0) {
                      const val = Number(decodeVarint64(cwBuf, cCw));
                      if (fnCw === 1 && val > 0) out.estimatedTokensUsed = val;
                      else if (fnCw === 4 && val > 0) out.maxContextTokens = val;
                    } else if (wtCw === 2 && fnCw === 3) {
                      // TokenBreakdown -> repeated field 1: TopLevelTokenGroup (field 2: type, field 4: num_tokens)
                      const lTb = Number(decodeVarint64(cwBuf, cCw));
                      if (!Number.isSafeInteger(lTb) || lTb < 0 || cCw.pos + lTb > cwBuf.length) break;
                      const tbBuf = cwBuf.subarray(cCw.pos, cCw.pos + lTb);
                      cCw.pos += lTb;
                      const cTb = { pos: 0 };
                      let sysTok = 0;
                      let toolTok = 0;
                      let msgTok = 0;
                      while (cTb.pos < tbBuf.length) {
                        const tTb = Number(decodeVarint64(tbBuf, cTb));
                        if (!tTb) break;
                        const fnTb = tTb >>> 3;
                        const wtTb = tTb & 0x07;
                        if (wtTb === 2 && fnTb === 1) {
                          const lGrp = Number(decodeVarint64(tbBuf, cTb));
                          if (!Number.isSafeInteger(lGrp) || lGrp < 0 || cTb.pos + lGrp > tbBuf.length) break;
                          const grpBuf = tbBuf.subarray(cTb.pos, cTb.pos + lGrp);
                          cTb.pos += lGrp;
                          const cGrp = { pos: 0 };
                          let gType = 0;
                          let gTokens = 0;
                          while (cGrp.pos < grpBuf.length) {
                            const tG = Number(decodeVarint64(grpBuf, cGrp));
                            if (!tG) break;
                            const fnG = tG >>> 3;
                            const wtG = tG & 0x07;
                            if (wtG === 0) {
                              const vG = Number(decodeVarint64(grpBuf, cGrp));
                              if (fnG === 2) gType = vG;
                              else if (fnG === 4 && vG > 0) gTokens = vG;
                            } else {
                              if (!skipProtobufField(grpBuf, cGrp, wtG)) break;
                            }
                          }
                          if (gTokens > 0) {
                            if (gType === 1 || gType === 3) sysTok += gTokens; // SYSTEM_PROMPT / RULES
                            else if (gType === 2 || gType === 4 || gType === 5 || gType === 6) toolTok += gTokens; // TOOLS / MCP / SKILLS / SUBAGENTS
                            else if (gType === 7) msgTok += gTokens; // CHAT_MESSAGES
                          }
                        } else {
                          if (!skipProtobufField(tbBuf, cTb, wtTb)) break;
                        }
                      }
                      if (sysTok + toolTok + msgTok > 0) {
                        out.systemTokens = sysTok;
                        out.toolTokens = toolTok;
                        out.messageTokens = msgTok;
                      }
                    } else {
                      if (!skipProtobufField(cwBuf, cCw, wtCw)) break;
                    }
                  }
                } else {
                  if (!skipProtobufField(startBuf, cStart, wtS)) break;
                }
              }
            }
            c1.pos += l1;
          } else {
            if (!skipProtobufField(subBuf, c1, wt1)) break;
          }
        }
      } else if (fieldNum === 3) {
        // CascadePlannerConfig
        const c3 = { pos: 0 };
        while (c3.pos < subBuf.length) {
          const t3 = Number(decodeVarint64(subBuf, c3));
          if (!t3) break;
          const fn3 = t3 >>> 3;
          const wt3 = t3 & 0x07;
          if (wt3 === 0) {
            const val = Number(decodeVarint64(subBuf, c3));
            if (fn3 === 14 && val > 0 && !out.maxContextTokens) {
              out.maxContextTokens = val;
            }
          } else if (wt3 === 2) {
            const l3 = Number(decodeVarint64(subBuf, c3));
            if (!Number.isSafeInteger(l3) || l3 < 0 || c3.pos + l3 > subBuf.length) break;
            if (fn3 === 28 && l3 > 0 && l3 < 256) {
              const str = decoder.decode(subBuf.subarray(c3.pos, c3.pos + l3)).trim();
              if (str) out.plannerModelName = str;
            } else if (fn3 === 27) {
              const info = parseModelInfoBlob(subBuf.subarray(c3.pos, c3.pos + l3));
              if (info.maxTokens && !out.maxContextTokens) out.maxContextTokens = info.maxTokens;
              if (info.modelName && !out.plannerModelName) out.plannerModelName = info.modelName;
            }
            c3.pos += l3;
          } else {
            if (!skipProtobufField(subBuf, c3, wt3)) break;
          }
        }
      }
    } else if (fieldNum === 2 && wireType === 0) {
      const value = Number(decodeVarint64(buf, cursor));
      if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) {
        (out.stepIndices ??= []).push(value);
      }
    } else {
      if (!skipProtobufField(buf, cursor, wireType)) break;
    }
  }

  return out;
}

/**
 * 级联独立裁剪数学模型 (保留纯数学导出以兼容边界测试套件)
 * 严格保证 T_i >= 0, W_i >= 0, sum(T_i) === U, sum(W_i) === Ratio_total
 */
export function computeCascadeContextBreakdown(
  usedTokens: number,
  capacityLimit: number,
  K_sys: number = 1900,
  K_tool: number = 7600
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
 * 有效输出速度：只对匹配的 Token 与完整正耗时计算，保留未舍入结果。
 */
export function computeTps(
  activeSec: number,
  totalOutputTokens: number,
  minWindow: number = 0
): {
  status: 'pending_or_fallback' | 'calculated';
  rawTps: number | null;
  outputTps: number;
  formatted: string;
} {
  if (!Number.isFinite(activeSec) || activeSec <= 0 || activeSec < minWindow || !Number.isFinite(totalOutputTokens) || totalOutputTokens < 0) {
    return {
      status: 'pending_or_fallback',
      rawTps: null,
      outputTps: 0,
      formatted: '—',
    };
  }
  const rawTps = totalOutputTokens / activeSec;
  return {
    status: 'calculated',
    rawTps,
    outputTps: rawTps,
    formatted: `${rawTps.toFixed(2)} tok/s`,
  };
}

/**
 * 格式化紧凑 Token 读数 (如 23196078 -> "23.2M", 226412 -> "226K", 8312 -> "8.3K")
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
 * 格式化千分位 Token 读数 (如 "23,196,078 tok")
 */
export function formatThousandsTokens(tokens: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(tokens) ? tokens : 0));
  return `${safe.toLocaleString('en-US')} tok`;
}

/**
 * 格式化用时 (如 1348 秒 -> "22 分 28 秒", 360 秒 -> "6 分 0 秒", 0 秒 -> "0 秒")
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
  activityPhase?: HudActivityPhase;
  isSubagentRunning?: boolean;
  runningSubagentCount?: number;
  subagentCount?: number;
  subagentSteps?: number;
  totalStepsOverride?: number;
  allowDbActiveStepInference?: boolean;
  modelId?: string;
  modelCapacity?: number;
  genMetadata?: ParsedGenMetadata;
  contextSteps?: ComputeHudMetricsInput['steps'];
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
    modelMaxTokens?: number;
    modelName?: string;
    toolCallName?: string;
    isSubagentStep?: boolean;
    hasUsage?: boolean;
    generation?: ParsedGenMetadata;
  }>;
}

const NON_TOOL_STEP_TYPES = new Set([0, 1, 2, 14, 15, 23, 81, 98, 99, 101, 102, 104]);

function validSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function safeTokens(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : 0;
}
export function buildConversationHudMetrics(input: ComputeHudMetricsInput): ConversationHudMetrics {
  const steps = input.steps || [];
  const contextSteps = input.contextSteps ?? steps;
  let modelSteps = 0;
  let toolSteps = 0;
  let modelDurationSeconds = 0;
  let toolDurationSeconds = 0;
  let timedOutputTokens = 0;
  let timedOutputSeconds = 0;
  let timedOutputCount = 0;
  let validTtftSum = 0;
  let validTtftCount = 0;
  let detectedSubagents = 0;
  let detectedRunningSubagents = 0;
  let uncachedInputTokens = 0;
  let cachedReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let candidateTokens = 0;

  for (const step of steps) {
    const stepType = step.step_type ?? step.stepType ?? 0;
    const start = step.t_start ?? step.startTimeSeconds;
    const first = step.t_first_token ?? step.firstTokenSeconds;
    const end = step.t_end ?? step.endTimeSeconds;
    const complete = (step.status ?? 3) === 3;
    const hasInterval = validSeconds(start) && validSeconds(end) && end > start;
    const subagent = Boolean(step.isSubagentStep) || stepType === 127 ||
      Boolean(step.toolCallName && SUBAGENT_TOOL_NAMES.has(step.toolCallName));
    if (subagent) {
      detectedSubagents++;
      if (input.allowDbActiveStepInference !== false && ACTIVE_STEP_STATUSES.has(step.status ?? 3)) {
        detectedRunningSubagents++;
      }
    }
    if (stepType === 15) {
      modelSteps++;
      const rawInput = safeTokens(step.rawInput ?? step.rawInputTokens);
      const cached = safeTokens(step.cachedTokens ?? step.cachedReadTokens);
      const written = safeTokens(step.cacheWriteTokens);
      const output = safeTokens(step.outputTokens);
      uncachedInputTokens += rawInput;
      cachedReadTokens += cached;
      cacheWriteTokens += written;
      outputTokens += output;
      reasoningTokens += safeTokens(step.reasoningTokens);
      candidateTokens += safeTokens(step.candidateTokens);

      const gen = step.generation;
      const rawTtft = gen?.timeToFirstTokenSeconds;
      const rawStreaming = gen?.streamingDurationSeconds;
      const duration = validSeconds(rawTtft) && validSeconds(rawStreaming) && rawTtft + rawStreaming > 0
        ? rawTtft + rawStreaming
        : hasInterval ? end! - start! : null;
      if (complete && duration !== null) {
        modelDurationSeconds += duration;
        if (step.hasUsage !== false && Number.isSafeInteger(step.outputTokens) && step.outputTokens! >= 0) {
          timedOutputTokens += output;
          timedOutputSeconds += duration;
          timedOutputCount++;
        }
      }
      const ttft = validSeconds(rawTtft)
        ? rawTtft
        : hasInterval && validSeconds(first) && first >= start! && first <= end!
        ? first - start! : null;
      if (complete && ttft !== null) {
        validTtftSum += ttft;
        validTtftCount++;
      }
    } else if (!NON_TOOL_STEP_TYPES.has(stepType)) {
      toolSteps++;
      if (hasInterval && !ACTIVE_STEP_STATUSES.has(step.status ?? 3)) {
        toolDurationSeconds += end! - start!;
      }
    }
  }

  let latestStep: ComputeHudMetricsInput['steps'][number] | undefined;
  let peakContextTokens = 0;
  let turns = 0;
  let compactionCount = 0;
  for (const step of contextSteps) {
    const stepType = step.step_type ?? step.stepType ?? 0;
    if (stepType === 14) turns++;
    if (stepType === 23 && (step.status ?? 3) === 3) compactionCount++;
    if (stepType !== 15 || step.hasUsage === false) continue;
    const prompt = safeTokens(step.rawInput ?? step.rawInputTokens) +
      safeTokens(step.cachedTokens ?? step.cachedReadTokens) + safeTokens(step.cacheWriteTokens);
    if (step.hasUsage === true || prompt > 0) {
      latestStep = step;
      peakContextTokens = Math.max(peakContextTokens, prompt);
    }
  }
  const genMeta = latestStep?.generation ?? input.genMetadata;
  const historicalModel = genMeta?.modelDisplayName || genMeta?.responseModel ||
    genMeta?.plannerModelName || latestStep?.modelName;
  const modelSpec = resolveModelCapacity(historicalModel || input.modelId);
  const explicitCapacity = [
    input.modelCapacity, genMeta?.maxContextTokens, latestStep?.modelMaxTokens,
  ].find(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
  const capacityTokens = explicitCapacity ?? modelSpec.capacityTokens;
  const capacityTokensCompact = explicitCapacity
    ? formatCompactTokenNumber(explicitCapacity)
    : `~${formatCompactTokenNumber(capacityTokens)}`;
  const stepCached = safeTokens(latestStep?.cachedTokens ?? latestStep?.cachedReadTokens);
  const stepUncached = safeTokens(latestStep?.rawInput ?? latestStep?.rawInputTokens) +
    safeTokens(latestStep?.cacheWriteTokens);
  const usedTokens = stepCached + stepUncached;
  const usedRatio = capacityTokens > 0 ? usedTokens / capacityTokens : 0;
  const stepCacheRatio = usedTokens > 0 ? stepCached / usedTokens : 0;
  const denominator = Math.max(capacityTokens, usedTokens, 1);
  const cachedBarRatio = stepCached / denominator * 100;
  const uncachedBarRatio = stepUncached / denominator * 100;
  const latestOutput = safeTokens(latestStep?.outputTokens);
  const runningSubagentCount = Math.max(
    input.runningSubagentCount ?? 0, detectedRunningSubagents, input.isSubagentRunning ? 1 : 0
  );
  const isSubagentRunning = Boolean(input.isSubagentRunning || runningSubagentCount > 0);
  const isStreaming = Boolean(input.isStreaming || isSubagentRunning);
  let dbActiveModelStep = false;
  let dbActiveToolStep = false;
  if (input.allowDbActiveStepInference) {
    for (let index = contextSteps.length - 1; index >= 0; index--) {
      const candidate = contextSteps[index]!;
      const candidateType = candidate.step_type ?? candidate.stepType ?? 0;
      if (candidateType === 14) break;
      const candidateStatus = candidate.status ?? 3;
      const candidateEnd = candidate.t_end ?? candidate.endTimeSeconds;
      if (!ACTIVE_STEP_STATUSES.has(candidateStatus) || candidateEnd != null) continue;
      if (candidateType === 15) {
        dbActiveModelStep = true;
        break;
      }
      if (!NON_TOOL_STEP_TYPES.has(candidateType)) {
        dbActiveToolStep = true;
      }
    }
  }
  let activityPhase: HudActivityPhase = 'idle';
  if (isStreaming) {
    if (dbActiveModelStep) {
      activityPhase = 'generating';
    } else if (dbActiveToolStep) {
      activityPhase = 'executing';
    } else if (input.activityPhase === 'executing' || input.activityPhase === 'generating') {
      activityPhase = input.activityPhase;
    } else if (!input.isStreaming && isSubagentRunning) {
      activityPhase = 'executing';
    } else {
      activityPhase = 'generating';
    }
  }
  const tpsInfo = computeTps(timedOutputSeconds, timedOutputTokens);
  const outputTpsFormatted = timedOutputCount > 0 ? tpsInfo.formatted : isStreaming ? '计算中...' : '—';
  const averageTtftSeconds = validTtftCount > 0 ? validTtftSum / validTtftCount : 0;
  const totalTokens = uncachedInputTokens + cachedReadTokens + cacheWriteTokens + outputTokens;
  const inputTokens = uncachedInputTokens + cachedReadTokens + cacheWriteTokens;
  const cacheHitRate = inputTokens > 0 ? cachedReadTokens / inputTokens : 0;

  return {
    conversationId: input.conversationId || 'default',
    sessionRevision: input.sessionRevision ?? 1,
    updatedAt: Date.now(),
    isStreaming,
    activityPhase,
    isSubagentRunning,
    runningSubagentCount,
    session: {
      turns,
      steps: input.totalStepsOverride ?? steps.length + Math.max(0, input.subagentSteps ?? 0),
      modelSteps,
      toolSteps,
      compactionCount,
      subagentCount: Math.max(input.subagentCount ?? detectedSubagents, runningSubagentCount),
      runningSubagentCount,
      subagentSteps: input.subagentSteps ?? 0,
      modelDurationSeconds,
      modelDurationFormatted: formatDurationSeconds(modelDurationSeconds, 'zh'),
      modelDurationFormattedEn: formatDurationSeconds(modelDurationSeconds, 'en'),
      toolDurationSeconds,
      toolDurationFormatted: formatDurationSeconds(toolDurationSeconds, 'zh'),
      toolDurationFormattedEn: formatDurationSeconds(toolDurationSeconds, 'en'),
      averageTtftSeconds,
      averageTtftFormatted: validTtftCount > 0 ? `${averageTtftSeconds.toFixed(2)} 秒` : '—',
      averageTtftFormattedEn: validTtftCount > 0 ? `${averageTtftSeconds.toFixed(2)}s` : '—',
      outputTps: tpsInfo.outputTps,
      outputTpsFormatted,
    },
    tokens: {
      totalTokens,
      totalTokensCompact: `${formatCompactTokenNumber(totalTokens)} tok`,
      totalTokensFormatted: formatThousandsTokens(totalTokens),
      cacheHitRate,
      cacheHitRateFormatted: `${(cacheHitRate * 100).toFixed(2)}%`,
      uncachedInputTokens,
      uncachedInputFormatted: formatThousandsTokens(uncachedInputTokens),
      cachedReadTokens,
      cachedReadFormatted: formatThousandsTokens(cachedReadTokens),
      ...(cacheWriteTokens > 0 ? { cacheWriteTokens, cacheWriteFormatted: formatThousandsTokens(cacheWriteTokens) } : {}),
      outputTokens,
      outputFormatted: formatThousandsTokens(outputTokens),
      ...(reasoningTokens > 0 ? { reasoningTokens, reasoningFormatted: formatThousandsTokens(reasoningTokens) } : {}),
      ...(candidateTokens > 0 ? { candidateTokens, candidateFormatted: formatThousandsTokens(candidateTokens) } : {}),
    },
    context: {
      hasUsageData: Boolean(latestStep),
      modelId: modelSpec.modelId,
      modelDisplayName: genMeta?.modelDisplayName || modelSpec.displayName,
      usedTokens,
      usedTokensCompact: formatCompactTokenNumber(usedTokens),
      usedTokensFormatted: formatThousandsTokens(usedTokens),
      peakContextTokens,
      peakContextCompact: formatCompactTokenNumber(peakContextTokens),
      peakContextFormatted: formatThousandsTokens(peakContextTokens),
      capacityTokens,
      capacityTokensCompact,
      hasExplicitDbCapacity: explicitCapacity !== undefined,
      isFallbackCapacity: explicitCapacity === undefined,
      usedRatio,
      usedRatioFormatted: `${(usedRatio * 100).toFixed(2)}%`,
      stepCacheRatio,
      stepCacheRatioFormatted: `${(stepCacheRatio * 100).toFixed(2)}%`,
      breakdown: {
        cachedContextTokens: stepCached,
        cachedContextFormatted: formatThousandsTokens(stepCached),
        cachedContextRatio: cachedBarRatio,
        uncachedContextTokens: stepUncached,
        uncachedContextFormatted: formatThousandsTokens(stepUncached),
        uncachedContextRatio: uncachedBarRatio,
        latestOutputTokens: latestOutput,
        latestOutputFormatted: formatThousandsTokens(latestOutput),
        systemTokens: stepCached,
        systemTokensCompact: formatThousandsTokens(stepCached),
        systemRatio: cachedBarRatio,
        toolTokens: stepUncached,
        toolTokensCompact: formatThousandsTokens(stepUncached),
        toolRatio: uncachedBarRatio,
        messageTokens: latestOutput,
        messageTokensCompact: formatThousandsTokens(latestOutput),
        messageRatio: 0,
      },
    },
  };
}

interface CachedConversationState {
  fileId: string;
  mtimeMs: number;
  size: number;
  walMtimeMs: number;
  walSize: number;
  lastStepIdx: number;
  lastGenIdx: number;
  hasDataColumn?: boolean;
  hasRenderInfoColumn?: boolean;
  hasStepPayloadColumn?: boolean;
  hasTrajectoryMeta?: boolean;
  hasParentMetadataBlob?: boolean;
  trajectoryId?: string;
  referencedUuidsInMetaBlob: Set<string>;
  steps: ParsedConversationStep[];
  childConversationIds: Set<string>;
  genMetadata?: ParsedGenMetadata;
  generations: Map<number, ParsedGenMetadata>;
  lastMetrics?: ConversationHudMetrics;
}

/**
 * 零阻塞、单语句自动提交 (Auto-Commit) 会话指标增量采集引擎
 * 严禁显式 BEGIN 事务，100% 保障宿主 wal_checkpoint(TRUNCATE) 畅通无阻 (busy: 0)
 */
export class ConversationMetricsEngine {
  private readonly conversationsDir: string;
  private readonly cache = new Map<string, CachedConversationState>();
  private readonly pendingReads = new Map<string, Promise<CachedConversationState | null>>();

  constructor(options?: { geminiDir?: string; conversationsDir?: string }) {
    const baseGemini = options?.geminiDir ?? join(homedir(), '.gemini');
    this.conversationsDir =
      options?.conversationsDir ?? join(baseGemini, 'antigravity', 'conversations');
  }

  public resolveDbPath(conversationId: string): string {
    const cleanId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleanId) {
      throw new Error('无效的会话 ID');
    }
    return join(this.conversationsDir, `${cleanId}.db`);
  }

  private setCachedState(dbPath: string, state: CachedConversationState): void {
    if (this.cache.has(dbPath)) {
      this.cache.delete(dbPath);
    }
    this.cache.set(dbPath, state);
    while (this.cache.size > MAX_CACHED_CONVERSATIONS) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }

  private readStepMetadataSafe(
    db: DatabaseSyncType,
    idx: number,
    inlineMetadata: Uint8Array | null | undefined,
    metadataLen: number
  ): Uint8Array | null {
    if (inlineMetadata && inlineMetadata.length > 0) return inlineMetadata;
    if (!Number.isSafeInteger(metadataLen) || metadataLen <= INLINE_BLOB_LIMIT_BYTES) return null;
    try {
      const stmt = db.prepare('SELECT substr(metadata, ?, ?) AS chunk FROM steps WHERE idx = ?');
      const projected = projectProtobuf(
        metadataLen,
        (offset, length) => (stmt.get(offset + 1, length, idx) as { chunk?: Uint8Array } | undefined)?.chunk ?? new Uint8Array(0),
        HUD_STEP_METADATA_PROJECTION
      );
      return projected.data;
    } catch {
      return null;
    }
  }

  private readGenMetadataSafe(db: DatabaseSyncType, idx: number): ParsedGenMetadata | undefined {
    const sizeRow = db
      .prepare('SELECT length(data) AS dataLen FROM gen_metadata WHERE idx = ? AND data IS NOT NULL LIMIT 1')
      .get(idx) as { dataLen?: number } | undefined;
    const dataLen = Number(sizeRow?.dataLen ?? 0);
    if (dataLen <= 0) return undefined;
    if (dataLen <= INLINE_BLOB_LIMIT_BYTES) {
      const row = db
        .prepare('SELECT data FROM gen_metadata WHERE idx = ? AND data IS NOT NULL LIMIT 1')
        .get(idx) as { data?: Uint8Array | null } | undefined;
      return row?.data ? parseLatestGenMetadataBlob(row.data) : undefined;
    }
    try {
      const stmt = db.prepare('SELECT substr(data, ?, ?) AS chunk FROM gen_metadata WHERE idx = ?');
      const projected = projectProtobuf(
        dataLen,
        (offset, length) => (stmt.get(offset + 1, length, idx) as { chunk?: Uint8Array } | undefined)?.chunk ?? new Uint8Array(0),
        HUD_GEN_METADATA_PROJECTION
      );
      return parseLatestGenMetadataBlob(projected.data);
    } catch {
      return undefined;
    }
  }

  private async readSingleDbState(
    dbPath: string,
    selfConversationId: string
  ): Promise<CachedConversationState | null> {
    const pending = this.pendingReads.get(dbPath);
    if (pending) return pending;
    const operation = this.loadSingleDbState(dbPath, selfConversationId);
    this.pendingReads.set(dbPath, operation);
    try {
      return await operation;
    } finally {
      if (this.pendingReads.get(dbPath) === operation) this.pendingReads.delete(dbPath);
    }
  }

  private async loadSingleDbState(
    dbPath: string,
    selfConversationId: string
  ): Promise<CachedConversationState | null> {
    if (!existsSync(dbPath)) return null;

    let dbStat: { mtimeMs: number; size: number; fileId: string } | null = null;
    let walStat: { mtimeMs: number; size: number } | null = null;
    try {
      const st = await lstat(dbPath);
      if (!st.isFile() || st.isSymbolicLink()) return null;
      dbStat = { mtimeMs: st.mtimeMs, size: st.size, fileId: `${st.dev}:${st.ino}` };
      try {
        const wst = await lstat(`${dbPath}-wal`);
        walStat = { mtimeMs: wst.mtimeMs, size: wst.size };
      } catch {
        walStat = null;
      }
    } catch {
      return null;
    }

    const cached = this.cache.get(dbPath);
    const existing = cached?.fileId === dbStat.fileId ? cached : undefined;
    const walMtimeMs = walStat?.mtimeMs ?? 0;
    const walSize = walStat?.size ?? 0;

    if (
      existing &&
      existing.fileId === dbStat.fileId &&
      existing.mtimeMs === dbStat.mtimeMs &&
      existing.size === dbStat.size &&
      existing.walMtimeMs === walMtimeMs &&
      existing.walSize === walSize
    ) {
      this.setCachedState(dbPath, existing);
      return existing;
    }

    let db: DatabaseSyncType | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 2000; PRAGMA read_uncommitted = ON;');

      let hasDataColumn = existing?.hasDataColumn;
      let hasRenderInfoColumn = existing?.hasRenderInfoColumn;
      let hasStepPayloadColumn = existing?.hasStepPayloadColumn;
      let hasTrajectoryMeta = existing?.hasTrajectoryMeta;
      let hasParentMetadataBlob = existing?.hasParentMetadataBlob;
      let trajectoryId = existing?.trajectoryId;
      const referencedUuidsInMetaBlob = new Set<string>(existing?.referencedUuidsInMetaBlob ?? []);

      if (
        hasDataColumn === undefined ||
        hasRenderInfoColumn === undefined ||
        hasStepPayloadColumn === undefined
      ) {
        try {
          const cols = db.prepare('PRAGMA table_info(steps)').all() as Array<{ name?: string }>;
          const colSet = new Set(cols.map((c) => String(c.name ?? '')));
          hasDataColumn = colSet.has('data');
          hasRenderInfoColumn = colSet.has('render_info');
          hasStepPayloadColumn = colSet.has('step_payload');
        } catch {
          hasDataColumn = false;
          hasRenderInfoColumn = false;
          hasStepPayloadColumn = false;
        }
      }

      {
        try {
          referencedUuidsInMetaBlob.clear();
          hasParentMetadataBlob = false;
          const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('trajectory_meta', 'trajectory_metadata_blob')")
            .all() as Array<{ name?: string }>;
          const tableSet = new Set(tables.map((t) => String(t.name ?? '')));
          hasTrajectoryMeta = tableSet.has('trajectory_meta');
          if (hasTrajectoryMeta && !trajectoryId) {
            const tm = db
              .prepare('SELECT trajectory_id FROM trajectory_meta LIMIT 1')
              .get() as { trajectory_id?: string } | undefined;
            if (tm?.trajectory_id) {
              trajectoryId = String(tm.trajectory_id).toLowerCase();
            }
          }
          if (tableSet.has('trajectory_metadata_blob')) {
            const tmbRows = db
              .prepare('SELECT id, length(data) AS size FROM trajectory_metadata_blob WHERE data IS NOT NULL LIMIT 4')
              .all() as Array<{ id: string; size: number }>;
            if (tmbRows.length > 0) {
              hasParentMetadataBlob = true;
              for (const r of tmbRows) {
                const statement = db.prepare('SELECT substr(data, ?, ?) AS chunk FROM trajectory_metadata_blob WHERE id = ?');
                const projected = projectProtobuf(r.size,
                  (offset, length) => (statement.get(offset + 1, length, r.id) as { chunk: Uint8Array }).chunk,
                  { 5: true, 6: true });
                for (const u of parentReferences(projected.data)) {
                  referencedUuidsInMetaBlob.add(u);
                }
              }
            } else {
              hasParentMetadataBlob = false;
            }
          } else if (hasParentMetadataBlob === undefined) {
            hasParentMetadataBlob = false;
          }
        } catch {
          hasTrajectoryMeta = false;
          hasParentMetadataBlob = false;
        }
      }

      const summaryRow = db
        .prepare('SELECT COUNT(*) as totalCount, COALESCE(MAX(idx), -1) as maxIdx FROM steps')
        .get() as { totalCount?: number; maxIdx?: number } | undefined;

      const totalCount = Number(summaryRow?.totalCount ?? 0);
      const maxIdx = Number(summaryRow?.maxIdx ?? -1);

      let baseSteps: ParsedConversationStep[] = [];
      let lastIdx = -1;
      const childConversationIds = new Set<string>(existing?.childConversationIds ?? []);

      const canReuse = existing && existing.fileId === dbStat.fileId &&
        existing.lastStepIdx <= maxIdx && existing.steps.length <= totalCount;
      if (canReuse) {
        baseSteps = [...existing.steps];
        lastIdx = existing.lastStepIdx;
      }

      const prevLastIdx = lastIdx;
      const selfLower = selfConversationId.toLowerCase();
      const selfTrajLower = trajectoryId?.toLowerCase() ?? '';

      const buildStepSelectColumns = (singleRow = false) => {
        const metaExpr = singleRow
          ? `CASE WHEN length(metadata) <= ${INLINE_BLOB_LIMIT_BYTES} THEN metadata ELSE NULL END as metadata, COALESCE(length(metadata), 0) as metadata_len`
          : `CASE WHEN step_type NOT IN (14, 23, 101) AND length(metadata) <= ${INLINE_BLOB_LIMIT_BYTES} THEN metadata ELSE NULL END as metadata, CASE WHEN step_type NOT IN (14, 23, 101) THEN COALESCE(length(metadata), 0) ELSE 0 END as metadata_len`;
        const extraCols: string[] = [];
        if (hasDataColumn) {
          extraCols.push(`CASE WHEN step_type IN (127, 132) AND length(data) <= ${INLINE_BLOB_LIMIT_BYTES} THEN data ELSE NULL END as data`);
        }
        if (hasRenderInfoColumn) {
          extraCols.push(`CASE WHEN step_type IN (127, 132) AND length(render_info) <= ${INLINE_BLOB_LIMIT_BYTES} THEN render_info ELSE NULL END as render_info`);
        }
        if (hasStepPayloadColumn) {
          extraCols.push(`CASE WHEN step_type IN (127, 132) THEN substr(step_payload, 1, ${INLINE_BLOB_LIMIT_BYTES}) ELSE NULL END as step_payload`);
        }
        return ['idx', 'step_type', 'status', metaExpr, ...extraCols].join(', ');
      };

      type RawStepQueryRow = {
        idx: number;
        step_type: number;
        status: number;
        metadata: Uint8Array | null;
        metadata_len: number;
        data?: Uint8Array | null;
        render_info?: Uint8Array | null;
        step_payload?: Uint8Array | null;
      };

      const parseStepRow = (row: RawStepQueryRow): ParsedConversationStep => {
        const effectiveMeta = this.readStepMetadataSafe(
          db!,
          Number(row.idx),
          row.metadata,
          Number(row.metadata_len ?? 0)
        );
        // 优先从精准的 render_info 提取子智能体会话 ID，缺失时再回退 step_payload
        const extraBlobs =
          row.render_info && row.render_info.length > 0
            ? [row.render_info]
            : row.step_payload && row.step_payload.length > 0
            ? [row.step_payload]
            : undefined;
        const parsed = parseStepMetadataBlob(
          Number(row.idx),
          Number(row.step_type),
          Number(row.status),
          effectiveMeta,
          row.data,
          extraBlobs
        );
        if (parsed.childConversationIds) {
          for (const cid of parsed.childConversationIds) {
            if (cid !== selfLower && cid !== selfTrajLower) {
              childConversationIds.add(cid);
            }
          }
        }
        return parsed;
      };

      if (maxIdx > lastIdx || baseSteps.length !== totalCount) {
        if (baseSteps.length > totalCount) {
          baseSteps = [];
          lastIdx = -1;
        }
        const sql = `SELECT ${buildStepSelectColumns(false)} FROM steps WHERE idx > ? ORDER BY idx ASC`;
        const rows = db.prepare(sql).all(lastIdx) as RawStepQueryRow[];

        for (const row of rows) {
          const parsed = parseStepRow(row);
          baseSteps.push(parsed);
          if (parsed.idx > lastIdx) {
            lastIdx = parsed.idx;
          }
        }
      }

      // 重查所有此前处于活跃态的步骤以及最近 2 步尾部记录，彻底杜绝并发工具超过 5 个或先落盘 status=3 后补写 model_usage 导致的漏计
      const recheckSet = new Set<number>();
      for (const s of baseSteps) {
        if (s.idx <= prevLastIdx && (ACTIVE_STEP_STATUSES.has(s.status) || s.idx >= prevLastIdx - 1)) {
          recheckSet.add(s.idx);
        }
      }

      if (recheckSet.size > 0) {
        const singleStmt = db.prepare(`SELECT ${buildStepSelectColumns(true)} FROM steps WHERE idx = ? LIMIT 1`);
        for (const activeIdx of recheckSet) {
          const row = singleStmt.get(activeIdx) as RawStepQueryRow | undefined;
          if (row) {
            const updated = parseStepRow(row);
            const pos = baseSteps.findIndex((s) => s.idx === activeIdx);
            if (pos !== -1) baseSteps[pos] = updated;
          }
        }
      }

      let lastGenIdx = -1;
      const generations = new Map<number, ParsedGenMetadata>(
        canReuse ? existing?.generations : []
      );
      try {
        const maxRow = db.prepare('SELECT MAX(idx) AS maxIdx FROM gen_metadata').get() as { maxIdx?: number };
        lastGenIdx = Number(maxRow?.maxIdx ?? -1);
        const sameGenerationSeries = canReuse && lastGenIdx >= (existing?.lastGenIdx ?? -1);
        if (!sameGenerationSeries) generations.clear();
        const genRows = db.prepare(
          'SELECT idx FROM gen_metadata WHERE data IS NOT NULL AND idx >= ? ORDER BY idx'
        ).all(sameGenerationSeries ? existing?.lastGenIdx ?? -1 : -1) as Array<{ idx: number }>;
        for (const row of genRows) {
          const parsed = this.readGenMetadataSafe(db, Number(row.idx));
          if (parsed) generations.set(Number(row.idx), parsed);
        }
        for (const key of generations.keys()) {
          if (key > lastGenIdx) generations.delete(key);
        }
      } catch {}

      baseSteps = baseSteps.map(step => ({ ...step, generation: undefined }));
      const stepByIndex = new Map(baseSteps.map(step => [step.idx, step]));
      for (const generation of generations.values()) {
        const linked = [...new Set(generation.stepIndices ?? [])]
          .map(index => stepByIndex.get(index)).filter(step => step?.stepType === 15);
        if (linked.length !== 1 || !generation.usage || !generation.executionId) continue;
        const step = linked[0]!;
        if (!step.hasUsage || step.executionId !== generation.executionId) continue;
        const usageKeys = ['rawInputTokens', 'outputTokens', 'cachedReadTokens', 'cacheWriteTokens',
          'reasoningTokens', 'candidateTokens'] as const;
        if (!usageKeys.every(key => step[key] === generation.usage![key])) continue;
        step.generation = generation;
      }
      const latestModelStep = [...baseSteps].reverse().find(step => step.stepType === 15 && step.hasUsage);
      const genMetadata = latestModelStep?.generation;
      childConversationIds.clear();
      for (const step of baseSteps) {
        for (const childId of step.childConversationIds ?? []) {
          if (childId !== selfLower && childId !== selfTrajLower) childConversationIds.add(childId);
        }
      }

      db.close();
      db = null;

      const nextState: CachedConversationState = {
        fileId: dbStat.fileId,
        mtimeMs: dbStat.mtimeMs,
        size: dbStat.size,
        walMtimeMs,
        walSize,
        lastStepIdx: lastIdx,
        lastGenIdx,
        hasDataColumn,
        hasRenderInfoColumn,
        hasStepPayloadColumn,
        hasTrajectoryMeta,
        hasParentMetadataBlob,
        trajectoryId,
        referencedUuidsInMetaBlob,
        steps: baseSteps,
        childConversationIds,
        genMetadata,
        generations,
      };
      this.setCachedState(dbPath, nextState);
      return nextState;
    } catch {
      try {
        db?.close();
      } catch {}
      return existing ?? null;
    }
  }

  public async getConversationMetrics(options: {
    conversationId: string;
    sessionRevision?: number;
    modelId?: string;
    isStreaming?: boolean;
    activityPhase?: HudActivityPhase;
    isSubagentRunning?: boolean;
    runningSubagentCount?: number;
    childConversationIds?: string[];
    dbPathOverride?: string;
  }): Promise<ConversationHudMetrics> {
    const {
      conversationId,
      sessionRevision = 1,
      modelId,
      isStreaming = false,
      activityPhase,
      isSubagentRunning = false,
      runningSubagentCount = 0,
      childConversationIds: domHintChildIds,
      dbPathOverride,
    } = options;

    const dbPath = dbPathOverride || this.resolveDbPath(conversationId);
    const mainState = await this.readSingleDbState(dbPath, conversationId);
    if (!mainState) {
      return buildConversationHudMetrics({
        conversationId,
        sessionRevision,
        isStreaming,
        activityPhase,
        isSubagentRunning,
        runningSubagentCount,
        modelId,
        steps: [],
      });
    }

    const nowMs = Date.now();
    const mainIsRecent = nowMs - Math.max(mainState.mtimeMs, mainState.walMtimeMs) <= ACTIVE_DB_RECENCY_MS;
    const mainIdLower = conversationId.toLowerCase();
    const mainTrajLower = mainState.trajectoryId?.toLowerCase() ?? '';

    let combinedSteps = mainState.steps;
    let totalSubagentSteps = 0;
    let activeChildSubagents = 0;
    const verifiedChildIds = new Set<string>();

    const candidateChildIds = new Set<string>(mainState.childConversationIds);
    if (Array.isArray(domHintChildIds)) {
      for (const rawHint of domHintChildIds) {
        if (typeof rawHint !== 'string') continue;
        const trimmed = rawHint.trim().toLowerCase();
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(trimmed)) {
          candidateChildIds.add(trimmed);
        }
      }
    }

    if (!dbPathOverride) {
      const pendingChildren = [...candidateChildIds].map(childId => ({
        childId, parentId: mainIdLower, explicit: mainState.childConversationIds.has(childId),
      }));
      const descendants: ParsedConversationStep[] = [];
      const processedEdges = new Set<string>();
      while (pendingChildren.length > 0) {
        const edge = pendingChildren.shift()!;
        const childId = edge.childId.toLowerCase();
        const edgeKey = `${edge.parentId}::${childId}`;
        if (processedEdges.has(edgeKey) || verifiedChildIds.has(childId) ||
            childId === mainIdLower || childId === mainTrajLower) continue;
        processedEdges.add(edgeKey);
        try {
          const childState = await this.readSingleDbState(this.resolveDbPath(childId), childId);
          if (!childState) continue;
          const belongsToParent = childState.referencedUuidsInMetaBlob.has(edge.parentId) ||
            (edge.explicit && childState.referencedUuidsInMetaBlob.has(mainIdLower));
          if (childState.hasParentMetadataBlob) {
            if (!belongsToParent) continue;
          } else if (!edge.explicit || childState.hasTrajectoryMeta) {
            continue;
          }
          verifiedChildIds.add(childId);
          totalSubagentSteps += childState.steps.length;
          const recent = nowMs - Math.max(childState.mtimeMs, childState.walMtimeMs) <= ACTIVE_DB_RECENCY_MS;
          if (recent && childState.steps.some(step => ACTIVE_STEP_STATUSES.has(step.status) &&
              step.completedAtSeconds == null && step.finishedGeneratingSeconds == null)) {
            activeChildSubagents++;
          }
          descendants.push(...childState.steps);
          for (const nested of childState.childConversationIds) {
            pendingChildren.push({ childId: nested, parentId: childId, explicit: true });
          }
        } catch {}
      }
      combinedSteps = [...mainState.steps, ...descendants];
    }

    const effectiveRunningSubagents = Math.max(runningSubagentCount, activeChildSubagents);
    const effectiveSubagentRunning = Boolean(isSubagentRunning || effectiveRunningSubagents > 0);

    const metrics = buildConversationHudMetrics({
      conversationId,
      sessionRevision,
      isStreaming: isStreaming || effectiveSubagentRunning,
      activityPhase,
      isSubagentRunning: effectiveSubagentRunning,
      runningSubagentCount: effectiveRunningSubagents,
      subagentCount: verifiedChildIds.size,
      subagentSteps: totalSubagentSteps,
      totalStepsOverride: mainState.steps.length + totalSubagentSteps,
      allowDbActiveStepInference: mainIsRecent,
      modelId,
      genMetadata: mainState.genMetadata,
      contextSteps: mainState.steps,
      steps: combinedSteps,
    });

    mainState.lastMetrics = metrics;
    return metrics;
  }

  public async readConversationMetrics(options: {
    conversationId: string;
    sessionRevision?: number;
    modelId?: string;
    isStreaming?: boolean;
    isSubagentRunning?: boolean;
    runningSubagentCount?: number;
    childConversationIds?: string[];
    dbPathOverride?: string;
  }): Promise<ConversationHudMetrics> {
    return this.getConversationMetrics(options);
  }

  public clearCache(): void {
    this.cache.clear();
  }
}
