import type { ApiPricing } from './pricing.js';
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
 */
export function resolveDatabaseModelFullName(
  modelId: string | null | undefined,
  label: string | null | undefined
): string {
  const cleanId = typeof modelId === 'string' ? modelId.trim() : '';
  if (cleanId) {
    const stripped = cleanId
      .replace(/^(?:projects\/[^/]+\/locations\/[^/]+\/)?(?:publishers\/[^/]+\/)?models\//i, '')
      .replace(/^publishers\/[^/]+\/models\//i, '')
      .replace(/^(?:vertex_ai|google|anthropic|openai)\//i, '')
      .replace(/^models\//i, '')
      .replace(/:(?:predict|generateContent|streamGenerateContent)$/i, '');
    if (stripped) return stripped;
    return cleanId;
  }
  const cleanLabel = typeof label === 'string' ? label.trim() : '';
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
