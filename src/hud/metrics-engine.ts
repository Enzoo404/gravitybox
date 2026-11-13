import { compactNumber, durationText } from '../metric-format.js';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  ConversationHudMetrics,
  HudActivityPhase,
  HudCapacitySource,
  HudDataAvailability,
  ParsedConversationStep,
  ParsedGenMetadata,
} from './types.js';
import { resolveModelCapacity } from './model-catalog.js';
import { runHudDbScanInWorker } from '../sqlite-read.js';
import type { HudWorkerRawStepRow } from '../sqlite-worker.js';
import { decodeVarint64, skipProtobufField } from '../protobuf.js';
export { decodeVarint64 };

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
const ACTIVE_DB_RECENCY_MS = 60 * 60 * 1000;
const INLINE_BLOB_LIMIT_BYTES = 65_536;
const UTF8_DECODER = new TextDecoder('utf-8');

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
        const str = UTF8_DECODER.decode(buf.subarray(cursor.pos, cursor.pos + len)).trim();
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

  while (cursor.pos < buf.length) {
    const tag = Number(decodeVarint64(buf, cursor));
    if (!tag) break;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 2) {
      const len = Number(decodeVarint64(buf, cursor));
      if (!Number.isSafeInteger(len) || len < 0 || cursor.pos + len > buf.length) break;
      if (fieldNum === 2 && len > 0 && len < 256) {
        name = UTF8_DECODER.decode(buf.subarray(cursor.pos, cursor.pos + len)).trim();
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
      const jsonStr = UTF8_DECODER.decode(buf.subarray(slice.start, slice.end));
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
  const text = UTF8_DECODER.decode(slice);
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
  const decoder = UTF8_DECODER;
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
 * 格式化紧凑 Token 读数 (如 23196078 -> "23.2M", 226412 -> "226K", 8312 -> "8.3K", 999600 -> "1M")
 */
export function formatCompactTokenNumber(tokens: number, prefixTilde = false): string {
  return `${prefixTilde && tokens > 0 ? '~' : ''}${compactNumber(tokens)}`;
}

/**
 * 格式化千分位 Token 读数 (如 "23,196,078 tok")
 */
export function formatThousandsTokens(tokens: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(tokens) ? tokens : 0));
  return `${safe.toLocaleString('en-US')} tok`;
}

/**
 * 格式化用时 (如 1348 秒 -> "22分28秒", 360 秒 -> "6分", 3600 秒 -> "1小时", 0 秒 -> "0秒")
 */
export function formatDurationSeconds(seconds: number, lang: 'zh' | 'en' = 'zh'): string { return durationText(seconds, lang); }

/**
 * 格式化本轮用时展开卡片展示 (整数秒，省略零分/零秒；中文使用汉字时分秒，英文使用 h/m/s)
 */
export function formatTurnDurationCard(seconds: number, lang: 'zh' | 'en' = 'zh'): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  return durationText(seconds, lang);
}

/**
 * 格式化本轮用时常驻栏紧凑展示 (单位统一 s/m/h，省略零分；<60s 显示秒，>=60s 只显示分钟/小时，不显示秒)
 */
export function formatTurnDurationCompact(seconds: number, lang: 'zh' | 'en' = 'zh'): string {
  if (!Number.isFinite(seconds) || seconds < 0) return lang === 'en' ? 'Turn 0s' : '本轮 0s';
  const rounded = Math.max(0, Math.round(seconds));
  const prefix = lang === 'en' ? 'Turn ' : '本轮 ';
  if (rounded < 60) {
    return `${prefix}${rounded}s`;
  }
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  if (hours > 0) {
    return `${prefix}${hours}h${minutes > 0 ? `${minutes}m` : ''}`;
  }
  return `${prefix}${minutes}m`;
}

export interface ComputeHudMetricsInput {
  conversationId?: string;
  paneSlotId?: string;
  sessionRevision?: number;
  metricsSequence?: number;
  availability?: HudDataAvailability;
  observedAt?: number | null;
  lastSuccessAt?: number | null;
  failedChildCount?: number;
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
    createdAtSeconds?: number | null;
    t_first_token?: number | null;
    firstTokenSeconds?: number | null;
    t_end?: number | null;
    endTimeSeconds?: number | null;
    finishedGeneratingSeconds?: number | null;
    completedAtSeconds?: number | null;
    childConversationIds?: string[];
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
  let usageSampleCount = 0;

  for (const step of steps) {
    const stepType = step.step_type ?? step.stepType ?? 0;
    const start = step.t_start ?? step.startTimeSeconds;
    const first = step.t_first_token ?? step.firstTokenSeconds;
    const end = step.t_end ?? step.endTimeSeconds;
    const rawStatus = step.status ?? 3;
    // F-02: 纳管 status=3 (DONE) 以及上下文压缩归档为 status=5 (CLEARED) 且具备完成证据的历史模型步
    const complete =
      rawStatus === 3 ||
      (rawStatus === 5 &&
        (step.generation !== undefined ||
          step.finishedGeneratingSeconds != null ||
          step.completedAtSeconds != null ||
          step.t_end != null));
    const hasInterval = validSeconds(start) && validSeconds(end) && end > start;
    const subagent = Boolean(step.isSubagentStep) || stepType === 127 ||
      Boolean(step.toolCallName && SUBAGENT_TOOL_NAMES.has(step.toolCallName));
    if (subagent) {
      detectedSubagents++;
    }
    if (stepType === 15) {
      modelSteps++;
      if (step.hasUsage !== false) usageSampleCount++;
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
      if (hasInterval && !ACTIVE_STEP_STATUSES.has(rawStatus)) {
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
    const rawStatus = step.status ?? 3;
    if (stepType === 14) turns++;
    if (stepType === 23 && (rawStatus === 3 || rawStatus === 5)) compactionCount++;
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
  const hasExplicitModelEvidence = Boolean(historicalModel || (typeof input.modelId === 'string' && input.modelId.trim()));
  const modelSpec = resolveModelCapacity(historicalModel || input.modelId);
  const explicitCapacity = [
    input.modelCapacity, genMeta?.maxContextTokens, latestStep?.modelMaxTokens,
  ].find(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
  const capacityTokens = explicitCapacity ?? modelSpec.capacityTokens;
  const capacityTokensCompact = explicitCapacity
    ? formatCompactTokenNumber(explicitCapacity)
    : `~${formatCompactTokenNumber(capacityTokens)}`;
  const capacitySource: HudCapacitySource = explicitCapacity !== undefined
    ? 'explicit'
    : modelSpec.isFallback
    ? 'unknown'
    : 'reference';
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
  let latestActiveForegroundKind: 'model' | 'tool' | null = null;
  if (input.allowDbActiveStepInference !== false) {
    let turnFinished = false;
    for (let index = contextSteps.length - 1; index >= 0; index--) {
      const candidate = contextSteps[index]!;
      const candidateType = candidate.step_type ?? candidate.stepType ?? 0;
      if (candidateType === 14) break;
      if (candidateType === 2 && (candidate.status ?? 3) === 3) {
        turnFinished = true;
        break;
      }
      const candidateStatus = candidate.status ?? 3;
      if (!ACTIVE_STEP_STATUSES.has(candidateStatus)) continue;
      const isCandidateSubagent =
        Boolean(candidate.isSubagentStep) ||
        candidateType === 127 ||
        Boolean(candidate.toolCallName && SUBAGENT_TOOL_NAMES.has(candidate.toolCallName));
      if (isCandidateSubagent && !turnFinished) {
        detectedRunningSubagents++;
      }
      if (input.allowDbActiveStepInference && latestActiveForegroundKind === null) {
        if (candidateType === 15) {
          latestActiveForegroundKind = 'model';
        } else if (!NON_TOOL_STEP_TYPES.has(candidateType)) {
          latestActiveForegroundKind = 'tool';
        }
      }
    }
  }
  const runningSubagentCount = Math.max(
    input.runningSubagentCount ?? 0, detectedRunningSubagents, input.isSubagentRunning ? 1 : 0
  );
  const isSubagentRunning = Boolean(input.isSubagentRunning || runningSubagentCount > 0);
  const dbForegroundActive = input.allowDbActiveStepInference === true && latestActiveForegroundKind !== null;
  const isStreaming = Boolean(input.isStreaming || isSubagentRunning || dbForegroundActive);
  let activityPhase: HudActivityPhase = 'idle';
  if (isStreaming) {
    if (latestActiveForegroundKind === 'model') {
      activityPhase = 'generating';
    } else if (latestActiveForegroundKind === 'tool') {
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
  const availability: HudDataAvailability = input.availability ?? 'ready';
  const nowMs = Date.now();
  const observedAt = input.observedAt !== undefined ? input.observedAt : (availability === 'unavailable' ? null : nowMs);
  const lastSuccessAt = input.lastSuccessAt !== undefined ? input.lastSuccessAt : observedAt;
  const resolvedModelId = !hasExplicitModelEvidence ? 'unknown' : modelSpec.modelId;
  const resolvedModelDisplayName =
    !hasExplicitModelEvidence
      ? '—'
      : genMeta?.modelDisplayName || modelSpec.displayName;

  // 计算本轮起步点与当轮耗时 (Turn Duration)
  let lastTurnStartIndex = -1;
  for (let index = contextSteps.length - 1; index >= 0; index--) {
    const candidate = contextSteps[index]!;
    const candidateType = candidate.step_type ?? candidate.stepType ?? 0;
    if (candidateType === 14) {
      lastTurnStartIndex = index;
      break;
    }
  }

  const turnSteps = lastTurnStartIndex >= 0 ? contextSteps.slice(lastTurnStartIndex) : contextSteps;
  let currentTurnModelDurationSeconds = 0;
  let currentTurnToolDurationSeconds = 0;
  let turnWallStart: number | null = null;
  let turnCompletedEnd: number | null = null;
  let hasActiveStepInTurn = false;
  let hasSubagentStepInTurn = false;
  const nowSeconds = nowMs / 1000;
  const allowActiveInference = input.allowDbActiveStepInference !== false;

  const trackWallStart = (ts: number | null | undefined) => {
    if (validSeconds(ts)) {
      turnWallStart = turnWallStart === null ? ts : Math.min(turnWallStart, ts);
    }
  };
  const trackWallEnd = (ts: number | null | undefined) => {
    if (validSeconds(ts)) {
      turnCompletedEnd = turnCompletedEnd === null ? ts : Math.max(turnCompletedEnd, ts);
    }
  };

  for (const step of turnSteps) {
    const stepType = step.step_type ?? step.stepType ?? 0;
    const stepStart = step.t_start ?? step.startTimeSeconds ?? step.createdAtSeconds;
    trackWallStart(stepStart);
    if (stepType === 14) continue;
    const start = step.t_start ?? step.startTimeSeconds;
    const end = step.t_end ?? step.endTimeSeconds;
    const rawStatus = step.status ?? 3;
    if (
      Boolean(step.isSubagentStep) ||
      stepType === 127 ||
      Boolean(step.toolCallName && SUBAGENT_TOOL_NAMES.has(step.toolCallName)) ||
      (step.childConversationIds && step.childConversationIds.length > 0)
    ) {
      hasSubagentStepInTurn = true;
    }
    const complete =
      rawStatus === 3 ||
      (rawStatus === 5 &&
        (step.generation !== undefined ||
          step.finishedGeneratingSeconds != null ||
          step.completedAtSeconds != null ||
          step.t_end != null));
    const hasInterval = validSeconds(start) && validSeconds(end) && end > start;
    if (complete) {
      trackWallEnd(end ?? step.finishedGeneratingSeconds ?? step.completedAtSeconds ?? start);
    } else if (
      (allowActiveInference && ACTIVE_STEP_STATUSES.has(rawStatus)) ||
      (isStreaming && (ACTIVE_STEP_STATUSES.has(rawStatus) || end == null))
    ) {
      hasActiveStepInTurn = true;
    }

    if (stepType === 15) {
      const gen = step.generation;
      const rawTtft = gen?.timeToFirstTokenSeconds;
      const rawStreaming = gen?.streamingDurationSeconds;
      const duration = validSeconds(rawTtft) && validSeconds(rawStreaming) && rawTtft + rawStreaming > 0
        ? rawTtft + rawStreaming
        : hasInterval ? end! - start! : null;
      if (complete && duration !== null) {
        currentTurnModelDurationSeconds += duration;
      } else if (
        validSeconds(start) &&
        ((allowActiveInference && ACTIVE_STEP_STATUSES.has(rawStatus)) ||
          (isStreaming && (ACTIVE_STEP_STATUSES.has(rawStatus) || end == null)))
      ) {
        currentTurnModelDurationSeconds += Math.max(0, nowSeconds - start);
      }
    } else if (!NON_TOOL_STEP_TYPES.has(stepType)) {
      if (hasInterval && !ACTIVE_STEP_STATUSES.has(rawStatus)) {
        currentTurnToolDurationSeconds += end! - start!;
      } else if (
        validSeconds(start) &&
        ((allowActiveInference && ACTIVE_STEP_STATUSES.has(rawStatus)) ||
          (isStreaming && (ACTIVE_STEP_STATUSES.has(rawStatus) || end == null)))
      ) {
        currentTurnToolDurationSeconds += Math.max(0, nowSeconds - start);
      }
    }
  }

  const childStepsAll = steps.length > contextSteps.length ? steps.slice(contextSteps.length) : [];
  const childStepsInTurn = childStepsAll.filter((step) => {
    const start = step.t_start ?? step.startTimeSeconds ?? step.createdAtSeconds;
    const end = step.t_end ?? step.endTimeSeconds ?? step.finishedGeneratingSeconds ?? step.completedAtSeconds;
    if (turnWallStart !== null) {
      if (validSeconds(start)) return start >= turnWallStart - 1;
      if (validSeconds(end)) return end >= turnWallStart - 1;
      return false;
    }
    return isSubagentRunning;
  });
  for (const childStep of childStepsInTurn) {
    const start = childStep.t_start ?? childStep.startTimeSeconds ?? childStep.createdAtSeconds;
    const end = childStep.t_end ?? childStep.endTimeSeconds ?? childStep.finishedGeneratingSeconds ?? childStep.completedAtSeconds;
    const childStatus = childStep.status ?? 3;
    trackWallStart(start);
    if (!ACTIVE_STEP_STATUSES.has(childStatus)) {
      trackWallEnd(end ?? start);
    } else if (allowActiveInference) {
      hasActiveStepInTurn = true;
    }
  }

  const hasSubagentInTurn = Boolean(isSubagentRunning || hasSubagentStepInTurn || childStepsInTurn.length > 0);
  const stepDurationSum = currentTurnModelDurationSeconds + currentTurnToolDurationSeconds;
  let currentTurnDurationSeconds = stepDurationSum;
  if (hasSubagentInTurn && turnWallStart !== null) {
    const completedWallSpan = turnCompletedEnd !== null && turnCompletedEnd > turnWallStart
      ? turnCompletedEnd - turnWallStart
      : 0;
    if (isStreaming || isSubagentRunning || hasActiveStepInTurn) {
      currentTurnDurationSeconds = Math.max(0, nowSeconds - turnWallStart, completedWallSpan);
    } else if (completedWallSpan > 0) {
      currentTurnDurationSeconds = completedWallSpan;
    }
  }
  const hasTurnDuration = turns > 0 || (turnSteps.length > 0 && currentTurnDurationSeconds > 0) || isStreaming;
  const currentTurnDurationFormatted = hasTurnDuration
    ? formatTurnDurationCard(currentTurnDurationSeconds, 'zh')
    : '—';
  const currentTurnDurationFormattedEn = hasTurnDuration
    ? formatTurnDurationCard(currentTurnDurationSeconds, 'en')
    : '—';
  const currentTurnDurationCompactZh = hasTurnDuration
    ? formatTurnDurationCompact(currentTurnDurationSeconds, 'zh')
    : '本轮 0s';
  const currentTurnDurationCompactEn = hasTurnDuration
    ? formatTurnDurationCompact(currentTurnDurationSeconds, 'en')
    : 'Turn 0s';

  return {
    conversationId: input.conversationId || 'default',
    ...(input.paneSlotId ? { paneSlotId: input.paneSlotId } : {}),
    sessionRevision: input.sessionRevision ?? 1,
    ...(typeof input.metricsSequence === 'number' ? { metricsSequence: input.metricsSequence } : {}),
    availability,
    observedAt,
    lastSuccessAt,
    ...(typeof input.failedChildCount === 'number' && input.failedChildCount > 0
      ? { failedChildCount: input.failedChildCount }
      : {}),
    updatedAt: observedAt ?? nowMs,
    isStreaming,
    activityPhase,
    isSubagentRunning,
    runningSubagentCount,
    session: {
      turns,
      steps: input.totalStepsOverride ?? steps.length + Math.max(0, input.subagentSteps ?? 0),
      modelSteps,
      samples: { usage: usageSampleCount,
        timed: timedOutputCount, ttft: validTtftCount },
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
      currentTurnDurationSeconds,
      currentTurnDurationFormatted,
      currentTurnDurationFormattedEn,
      currentTurnDurationCompactZh,
      currentTurnDurationCompactEn,
      currentTurnModelDurationSeconds,
      currentTurnToolDurationSeconds,
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
      modelId: resolvedModelId,
      modelDisplayName: resolvedModelDisplayName,
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
      capacitySource,
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
  headerChecksum: string;
  genChecksum: string;
  observedAt: number;
  lastSuccessAt: number;
  fromErrorFallback?: boolean;
  parentMetaReadError?: boolean;
  hasDataColumn?: boolean;
  hasRenderInfoColumn?: boolean;
  hasStepPayloadColumn?: boolean;
  hasTrajectoryMeta?: boolean;
  hasParentMetadataBlob?: boolean;
  trajectoryId?: string;
  referencedUuidsInMetaBlob: Set<string>;
  steps: ParsedConversationStep[];
  childConversationIds: Set<string>;
  verifiedSniffedChildren: Set<string>;
  genMetadata?: ParsedGenMetadata;
  generations: Map<number, ParsedGenMetadata>;
}

/**
 * 零阻塞、单语句自动提交 (Auto-Commit) 会话指标采集引擎
 * 通过只读 Worker 线程池执行短生命周期查询，严禁显式 BEGIN 事务，每条语句结束释放读取状态，避免长期持有 WAL 快照
 */
export class ConversationMetricsEngine {
  private readonly conversationsDir: string;
  private readonly cache = new Map<string, CachedConversationState>();
  private readonly pendingReads = new Map<string, Promise<CachedConversationState | null>>();
  private sniffDirCache: { at: number; recentIds: string[] } | null = null;
  private sniffDirListCache: { dirMtimeMs: number; dbEntries: Array<{ file: string; id: string }> } | null = null;

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
      !existing.fromErrorFallback &&
      existing.fileId === dbStat.fileId &&
      existing.mtimeMs === dbStat.mtimeMs &&
      existing.size === dbStat.size &&
      existing.walMtimeMs === walMtimeMs &&
      existing.walSize === walSize
    ) {
      this.setCachedState(dbPath, existing);
      return existing;
    }

    const scanParams = {
      dbPath,
      inlineBlobLimitBytes: INLINE_BLOB_LIMIT_BYTES,
      knownColumns:
        existing &&
        existing.hasDataColumn !== undefined &&
        existing.hasRenderInfoColumn !== undefined &&
        existing.hasStepPayloadColumn !== undefined
          ? {
              hasDataColumn: existing.hasDataColumn,
              hasRenderInfoColumn: existing.hasRenderInfoColumn,
              hasStepPayloadColumn: existing.hasStepPayloadColumn,
            }
          : undefined,
      cachedTrajectoryId: existing?.trajectoryId,
    };

    try {
      let workerRes: Awaited<ReturnType<typeof runHudDbScanInWorker>>;
      try {
        workerRes = await runHudDbScanInWorker(scanParams);
      } catch (firstErr) {
        const msg = (firstErr as Error)?.message ?? '';
        if (!/busy|locked|投影失败|工作线程|预算|no such table|unable to open/i.test(msg)) {
          throw firstErr;
        }
        await new Promise(resolve => setTimeout(resolve, 60));
        workerRes = await runHudDbScanInWorker(scanParams);
      }

      const {
        hasDataColumn,
        hasRenderInfoColumn,
        hasStepPayloadColumn,
        hasTrajectoryMeta,
        hasParentMetadataBlob,
        parentMetaReadError,
        trajectoryId,
        metaBlobProjectedSlices,
        maxIdx,
        headerChecksum,
        lastGenIdx,
        genChecksum,
        appendedSteps,
        genBlobs,
      } = workerRes;

      const referencedUuidsInMetaBlob = new Set<string>(
        parentMetaReadError ? existing?.referencedUuidsInMetaBlob ?? [] : []
      );
      if (!parentMetaReadError) {
        for (const slice of metaBlobProjectedSlices) {
          for (const u of parentReferences(slice)) {
            referencedUuidsInMetaBlob.add(u);
          }
        }
      }

      let baseSteps: ParsedConversationStep[] = [];
      let lastIdx = -1;
      const childConversationIds = new Set<string>();
      const selfLower = selfConversationId.toLowerCase();
      const selfTrajLower = trajectoryId?.toLowerCase() ?? '';

      const parseStepRow = (row: HudWorkerRawStepRow): ParsedConversationStep => {
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
          row.metadata,
          row.data,
          extraBlobs
        );
        parsed.metadataByteLength = Number(row.metadata_len ?? 0);
        return parsed;
      };

      for (const row of appendedSteps) {
        const parsed = parseStepRow(row);
        baseSteps.push(parsed);
        if (parsed.idx > lastIdx) {
          lastIdx = parsed.idx;
        }
      }
      if (maxIdx > lastIdx) {
        lastIdx = maxIdx;
      }

      const generations = new Map<number, ParsedGenMetadata>();
      for (const item of genBlobs) {
        const parsed = parseLatestGenMetadataBlob(item.data);
        generations.set(item.idx, parsed);
      }

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
      let genMetadata = latestModelStep?.generation;
      if (!genMetadata && generations.size > 0) {
        const fallbackGens = [...generations.entries()].sort((a, b) => a[0] - b[0]);
        genMetadata = fallbackGens[fallbackGens.length - 1]?.[1];
      }
      for (const step of baseSteps) {
        for (const childId of step.childConversationIds ?? []) {
          if (childId !== selfLower && childId !== selfTrajLower) childConversationIds.add(childId);
        }
      }

      const timelineShrunk = existing && baseSteps.length < existing.steps.length;
      const verifiedSniffedChildren = new Set<string>(
        timelineShrunk ? [] : existing?.verifiedSniffedChildren ?? []
      );

      const nowMs = Date.now();
      const observedAt = Math.max(Math.round(dbStat.mtimeMs), Math.round(walMtimeMs)) || nowMs;
      const nextState: CachedConversationState = {
        fileId: dbStat.fileId,
        mtimeMs: dbStat.mtimeMs,
        size: dbStat.size,
        walMtimeMs,
        walSize,
        lastStepIdx: lastIdx,
        lastGenIdx,
        headerChecksum,
        genChecksum,
        observedAt,
        lastSuccessAt: nowMs,
        fromErrorFallback: false,
        parentMetaReadError,
        hasDataColumn,
        hasRenderInfoColumn,
        hasStepPayloadColumn,
        hasTrajectoryMeta,
        hasParentMetadataBlob,
        trajectoryId,
        referencedUuidsInMetaBlob,
        steps: baseSteps,
        childConversationIds,
        verifiedSniffedChildren,
        genMetadata,
        generations,
      };
      this.setCachedState(dbPath, nextState);
      return nextState;
    } catch {
      if (existing) {
        return { ...existing, fromErrorFallback: true };
      }
      return null;
    }
  }

  public async getConversationMetrics(options: {
    conversationId: string;
    paneSlotId?: string;
    sessionRevision?: number;
    metricsSequence?: number;
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
      paneSlotId,
      sessionRevision = 1,
      metricsSequence,
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
        paneSlotId,
        sessionRevision,
        metricsSequence,
        availability: 'unavailable',
        observedAt: null,
        lastSuccessAt: null,
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
    let failedChildCount = 0;
    const verifiedChildIds = new Set<string>();

    const candidateChildIds = new Set<string>(mainState.childConversationIds);
    for (const persistedChild of mainState.verifiedSniffedChildren) {
      candidateChildIds.add(persistedChild);
    }
    if (Array.isArray(domHintChildIds)) {
      for (const rawHint of domHintChildIds) {
        if (typeof rawHint !== 'string') continue;
        const trimmed = rawHint.trim().toLowerCase();
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(trimmed)) {
          candidateChildIds.add(trimmed);
        }
      }
    }

    // 反向子会话嗅探 (异步无阻塞，同时检查 .db 与 -wal 修改时间，1s 目录下钻缓存)
    const hasActiveSubagentStep = mainState.steps.some(
      (s) =>
        (s.isSubagentStep || (s.toolCallName && SUBAGENT_TOOL_NAMES.has(s.toolCallName))) &&
        ACTIVE_STEP_STATUSES.has(s.status)
    );
    if (!dbPathOverride && (isSubagentRunning || hasActiveSubagentStep)) {
      try {
        let recentIds: string[];
        if (this.sniffDirCache && nowMs - this.sniffDirCache.at < 2500) {
          recentIds = this.sniffDirCache.recentIds;
        } else {
          const dirStat = await lstat(this.conversationsDir).catch(() => null);
          let dbEntries: Array<{ file: string; id: string }>;
          if (dirStat && this.sniffDirListCache && this.sniffDirListCache.dirMtimeMs === dirStat.mtimeMs) {
            dbEntries = this.sniffDirListCache.dbEntries;
          } else {
            const files = await readdir(this.conversationsDir).catch(() => [] as string[]);
            dbEntries = [];
            for (const file of files) {
              if (!file.endsWith('.db') || file.length < 39) continue;
              const potentialChildId = file.slice(0, -3).toLowerCase();
              if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(potentialChildId)) {
                dbEntries.push({ file, id: potentialChildId });
              }
            }
            if (dirStat) {
              this.sniffDirListCache = { dirMtimeMs: dirStat.mtimeMs, dbEntries };
            }
          }
          const found: string[] = [];
          for (let i = 0; i < dbEntries.length; i += 48) {
            const batch = dbEntries.slice(i, i + 48);
            await Promise.all(batch.map(async ({ file, id: potentialChildId }) => {
              const fullChildPath = join(this.conversationsDir, file);
              const [st, walSt] = await Promise.all([
                lstat(fullChildPath).catch(() => null),
                lstat(`${fullChildPath}-wal`).catch(() => null),
              ]);
              if (!st || !st.isFile() || st.isSymbolicLink()) return;
              const latestMtime = Math.max(st.mtimeMs, walSt?.mtimeMs ?? 0);
              if (nowMs - latestMtime <= 30_000) {
                found.push(potentialChildId);
              }
            }));
          }
          recentIds = found;
          this.sniffDirCache = { at: nowMs, recentIds: found };
        }
        for (const potentialChildId of recentIds) {
          if (
            potentialChildId !== mainIdLower &&
            potentialChildId !== mainTrajLower &&
            !candidateChildIds.has(potentialChildId)
          ) {
            candidateChildIds.add(potentialChildId);
          }
        }
      } catch {}
    }

    if (!dbPathOverride) {
      const pendingChildren = [...candidateChildIds].map(childId => ({
        childId,
        parentId: mainIdLower,
        explicit: mainState.childConversationIds.has(childId),
        sniffed: !mainState.childConversationIds.has(childId),
      }));
      const descendants: ParsedConversationStep[] = [];
      const processedEdges = new Set<string>();
      const SUBAGENT_READ_CONCURRENCY = 4;
      while (pendingChildren.length > 0) {
        const wave: Array<{
          edge: { childId: string; parentId: string; explicit: boolean; sniffed: boolean };
          childId: string;
          childDbPath: string;
        }> = [];
        const waveChildIds = new Set<string>();
        while (wave.length < SUBAGENT_READ_CONCURRENCY && pendingChildren.length > 0) {
          const edge = pendingChildren[0]!;
          const childId = edge.childId.toLowerCase();
          if (waveChildIds.has(childId)) break;
          pendingChildren.shift();
          const edgeKey = `${edge.parentId}::${childId}`;
          if (processedEdges.has(edgeKey) || verifiedChildIds.has(childId) ||
              childId === mainIdLower || childId === mainTrajLower) continue;
          processedEdges.add(edgeKey);
          waveChildIds.add(childId);
          wave.push({ edge, childId, childDbPath: this.resolveDbPath(childId) });
        }
        if (wave.length === 0) continue;
        const results = await Promise.all(wave.map(async (item) => {
          try {
            const childState = await this.readSingleDbState(item.childDbPath, item.childId);
            if (!childState) {
              if (item.edge.explicit) {
                const childStat = await lstat(item.childDbPath).catch(() => null);
                if (childStat && childStat.size > 4096) return { item, childState: null, failed: true };
              }
              return { item, childState: null, failed: false };
            }
            return { item, childState, failed: false };
          } catch {
            return { item, childState: null, failed: item.edge.explicit };
          }
        }));
        for (const { item, childState, failed } of results) {
          if (failed) {
            failedChildCount++;
            continue;
          }
          if (!childState) continue;
          const { edge, childId } = item;
          if (verifiedChildIds.has(childId)) continue;
          if (childState.fromErrorFallback) {
            failedChildCount++;
          }
          const belongsToParent =
            childState.referencedUuidsInMetaBlob.has(edge.parentId) ||
            (edge.explicit &&
              (childState.referencedUuidsInMetaBlob.has(mainIdLower) ||
                (mainTrajLower !== '' && childState.referencedUuidsInMetaBlob.has(mainTrajLower)))) ||
            (edge.sniffed &&
              mainTrajLower !== '' &&
              childState.referencedUuidsInMetaBlob.has(mainTrajLower));
          if (childState.parentMetaReadError) {
            failedChildCount++;
            continue;
          }
          if (childState.hasParentMetadataBlob) {
            if (!belongsToParent) continue;
          } else if (!edge.explicit || childState.hasTrajectoryMeta) {
            continue;
          }
          verifiedChildIds.add(childId);
          if (edge.sniffed) {
            mainState.verifiedSniffedChildren.add(childId);
          }
          totalSubagentSteps += childState.steps.length;
          const recent = nowMs - Math.max(childState.mtimeMs, childState.walMtimeMs) <= ACTIVE_DB_RECENCY_MS;
          if (recent) {
            let childActive = false;
            for (let idx = childState.steps.length - 1; idx >= 0; idx--) {
              const step = childState.steps[idx]!;
              if (step.stepType === 14) break;
              if (step.stepType === 2 && step.status === 3) break;
              if (ACTIVE_STEP_STATUSES.has(step.status)) {
                childActive = true;
                break;
              }
            }
            if (childActive) {
              activeChildSubagents++;
            }
          }
          descendants.push(...childState.steps);
          for (const nested of childState.childConversationIds) {
            pendingChildren.push({ childId: nested, parentId: childId, explicit: true, sniffed: false });
          }
        }
      }
      combinedSteps = [...mainState.steps, ...descendants];
    }

    const normalizedContextSteps =
      verifiedChildIds.size > 0 && activeChildSubagents === 0
        ? mainState.steps.map((step) => {
            if (
              step.isSubagentStep &&
              step.childConversationIds &&
              step.childConversationIds.length > 0 &&
              step.childConversationIds.every((cid) => verifiedChildIds.has(cid.toLowerCase())) &&
              ACTIVE_STEP_STATUSES.has(step.status)
            ) {
              return { ...step, status: 3 };
            }
            return step;
          })
        : mainState.steps;

    const effectiveRunningSubagents = Math.max(runningSubagentCount, activeChildSubagents);
    const effectiveSubagentRunning = Boolean(isSubagentRunning || effectiveRunningSubagents > 0);
    const availability: HudDataAvailability = mainState.fromErrorFallback
      ? 'cached'
      : failedChildCount > 0 || mainState.parentMetaReadError
      ? 'partial'
      : 'ready';

    const metrics = buildConversationHudMetrics({
      conversationId,
      paneSlotId,
      sessionRevision,
      metricsSequence,
      availability,
      observedAt: mainState.observedAt,
      lastSuccessAt: mainState.lastSuccessAt,
      failedChildCount,
      // 传入原始前台 isStreaming，使 buildConversationHudMetrics 能准确区分“前台模型生成（常亮蓝）”与“仅后台子智能体运行（呼吸蓝）”
      isStreaming,
      activityPhase,
      isSubagentRunning: effectiveSubagentRunning,
      runningSubagentCount: effectiveRunningSubagents,
      subagentCount: dbPathOverride ? undefined : verifiedChildIds.size,
      subagentSteps: totalSubagentSteps,
      totalStepsOverride: mainState.steps.length + totalSubagentSteps,
      allowDbActiveStepInference: mainIsRecent || isStreaming || effectiveSubagentRunning,
      modelId,
      genMetadata: mainState.genMetadata,
      contextSteps: normalizedContextSteps,
      steps: combinedSteps,
    });

    return metrics;
  }

  public clearCache(): void {
    this.cache.clear();
    this.sniffDirCache = null;
  }
}
