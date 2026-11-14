import type { ApiPricing } from './pricing.js';
import { stripModelProviderPrefix } from './model-identity.js';
import type { LedgerEvent } from './usage-ledger.js';

export interface TokenUsageTotals {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
}

export interface ModelTokenUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
  estimated_usd: number;
  priced?: boolean;
  partiallyPriced?: boolean;
  unpriced_tokens?: number;
  pricingKey?: string; pricingStatus?: string; pricingProvenance?: ApiPricing["provenance"] | null;
}

export interface DailyTokenUsage {
  date: string; // YYYY-MM-DD
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
}

export interface HourlyTokenUsage {
  hour: string; // YYYY-MM-DD HH:00
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
}

export interface TokenUsagePeriod {
  totals: TokenUsageTotals;
  estimated_usd: number;
  by_model: ModelTokenUsage[];
  priced_models?: number;
  unpriced_models?: number;
}

export interface TokenUsageSummary {
  today: TokenUsagePeriod;
  last_7_days: TokenUsagePeriod;
  last_30_days: TokenUsagePeriod;
  all_time: TokenUsagePeriod;
  daily_trends: DailyTokenUsage[];
  today_hourly: HourlyTokenUsage[];
  databases_scanned: number;
  databases_discovered?: number;
  scan_scope_description?: string;
  generations_scanned: number;
  skipped_large_records: number;
  generated_at: number;
  priced_models?: number;
  unpriced_models?: number;
  failed_databases_count?: number;
  has_error?: boolean;
  hasError?: boolean;
  availability?: 'complete' | 'partial' | 'cached' | 'unavailable';
  unknown_time_records?: number;
  unknown_time_tokens?: number;
  database_diagnostics?: { id: string; state: string; category: string; lastSuccessAt?: number }[];
  snapshot_id?: string;
  last_attempt_at?: number;
  pricing_warnings?: string[];
  unattributed_requests?: number;
  unattributed_tokens?: number;
  ledger_review_records?: number;
  historical_amount_receipts?: { unmatchedCount: number; unmatchedUsd: number };
  available_accounts?: AvailableAccountUsageOption[];
  selected_account_id?: string;
}

export interface AvailableAccountUsageOption {
  id: string; // 'all' | accountId | email
  label: string; // '全部账号' | 'account-one@example.invalid' | 'account-two@example.invalid'
  email?: string;
  name?: string | null;
  type?: 'all' | 'account';
  total_tokens?: number;
  request_count?: number;
}

export interface GenerationEvent {
  event_key?: string;
  source_id?: string;
  source_observed_at?: number;
  generation_index?: number;
  legacy_event_key?: string;
  account_confidence?: 'observed' | 'unknown' | 'legacy';
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  timestamp_seconds: number;
  account_id?: string;
  account_email?: string;
  account_type?: 'consumer' | 'enterprise_vertex' | 'unknown';
  project_id?: string;
}

/**
 * 基于 Antigravity 数据库 (gen_metadata) 提取真实 Response model 名称（如 "gemini-3.8-flash-n", "gemini-3.8-flash-exp-a"），不包含推理程度 high/medium/low。
 * 针对 Vertex AI / GCP 路径前缀（如 publishers/google/models/gemini-4-carbon）自动解耦并清洗为规范模型名称。
 * 同时对 Orchestrator 双阶段模式（Plan Mode: Argon / Carbon；Execution Mode: gemini-flash-worker-agy / 1669）执行方案 B 归一化合并。
 */
export function resolveDatabaseModelFullName(
  modelId: string | null | undefined,
  label: string | null | undefined,
  modelEnum?: number | null
): string {
  const cleanId = typeof modelId === 'string' ? modelId.trim() : '';
  const strippedId = cleanId ? (stripModelProviderPrefix(cleanId) || cleanId) : '';
  const cleanLabel = typeof label === 'string' ? label.trim() : '';

  // Antigravity Orchestrator 双阶段模型归一化（方案 B）：
  // 1. 规划阶段 (Plan Mode)：response_model 恒为 "gemini-pro-orchestrator-g1-pro"，由 label ("Orchestrator (Argon)" / "Orchestrator (Carbon)") 或 model_enum (1668 / 1667) 区分底层规划模型；
  // 2. 执行阶段 (Execution Mode)：model_enum 为 1669 (MODEL_PLACEHOLDER_M669)，response_model 为 "gemini-flash-worker-agy"，label 为 "Gemini Flash"，对应底层 Gemini 3.8 Flash。
  const isOrchestratorId = /\borchestrator\b/i.test(strippedId) || /^MODEL_PLACEHOLDER_M66[78]$/i.test(strippedId);
  const isOrchestratorLabel = /\borchestrator\b/i.test(cleanLabel);
  if (isOrchestratorId || isOrchestratorLabel || modelEnum === 1667 || modelEnum === 1668) {
    if (/\bcarbon\b/i.test(cleanLabel) || /\bcarbon\b/i.test(strippedId) || modelEnum === 1667 || /M667$/i.test(strippedId)) {
      return 'gemini-4-carbon';
    }
    if (/\bhydrogen\b/i.test(cleanLabel) || /\bhydrogen\b/i.test(strippedId)) {
      return 'gemini-4-hydrogen';
    }
    if (/\bargon\b/i.test(cleanLabel) || /\bargon\b/i.test(strippedId) || modelEnum === 1668 || /M668$/i.test(strippedId) || /^gemini-pro-orchestrator/i.test(strippedId)) {
      return 'gemini-4-argon';
    }
  }
  if (
    /^gemini-flash-worker(?:-agy)?$/i.test(strippedId) ||
    /^MODEL_PLACEHOLDER_M669$/i.test(strippedId) ||
    modelEnum === 1669 ||
    (!strippedId && /^Gemini\s+Flash$/i.test(cleanLabel))
  ) {
    if (/\bhydrogen\b/i.test(cleanLabel) || /\bhydrogen\b/i.test(strippedId)) {
      return 'gemini-4-hydrogen';
    }
    return 'gemini-3.8-flash';
  }

  if (cleanId) {
    if (strippedId) return strippedId;
    return cleanId;
  }
  if (cleanLabel) {
    return cleanLabel
      .replace(/\s*[（(]\s*(?:extra[\s-]*low|high|medium|low|thinking|max)\s*[）)]\s*$/i, '')
      .replace(/\s+(?:extra[\s-]*low|high|medium|low|thinking|max)\s*$/i, '')
      .trim() || cleanLabel;
  }
  return '未知模型';
}

export interface FileCacheEntry {
  mtimeMs: number;
  size: number;
  walMtimeMs: number;
  walSize: number;
  events: GenerationEvent[];
  generationsScanned: number;
  skippedLargeRecords: number;
  hasError?: boolean;
  error?: string;
  lastSuccessAt?: number;
}

export function ledgerEventsEqual(a: LedgerEvent, b: LedgerEvent): boolean {
  for (const key of Object.keys(a) as (keyof LedgerEvent)[]) {
    if (a[key] !== b[key]) return false;
  }
  for (const key of Object.keys(b) as (keyof LedgerEvent)[]) {
    if (!(key in a) && b[key] !== undefined) return false;
  }
  return true;
}
