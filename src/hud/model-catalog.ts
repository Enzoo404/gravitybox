import { normalizeModelId } from '../model-identity.js';
/**
 * Antigravity 模型有效上下文窗口阈值映射目录
 * 严格对齐 Antigravity 官方运行时与 assets/model-catalog.json 标准上下文阈值 (<=200K / 256K / 128K)
 * 彻底剔除从第三方插件照搬的 1M / 2M 虚假容量
 */

export interface ModelCapacitySpec {
  modelId: string;
  displayName: string;
  capacityTokens: number;
  capacityCompact: string;
  isFallback: boolean;
}

/**
 * Antigravity 标准上下文压缩阈值 (对齐 assets/model-catalog.json <=200K 标准上下文基准)
 */
export const DEFAULT_CONTEXT_CAPACITY_TOKENS = 200_000;

/**
 * 保留纯数学辅助函数默认参数导出以兼容历史单元测试调用，但生产渲染层严禁展示虚构基线
 */
export const DEFAULT_SYSTEM_PROMPT_BASELINE_TOKENS = 0;
export const DEFAULT_TOOL_DEFINITIONS_BASELINE_TOKENS = 0;

interface ModelFamilyRule {
  pattern: RegExp;
  capacityTokens: number;
  capacityCompact: string;
  defaultDisplayName: string;
}

/**
 * 模型族参考容量（只有请求明确返回的容量才是实测值）
 * 缺少明确容量时才使用这些参考值；不能据此断言宿主实际窗口或压缩阈值，
 * 绝不展示虚构的 1M / 2M 容量。
 */
const MODEL_CAPACITY_RULES: readonly ModelFamilyRule[] = [
  {
    pattern: /^gemini-(?:1\.5|2\.0|2\.5|3(?:\.\d+)?)-pro|^gemini-pro/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Gemini Pro',
  },
  {
    pattern: /^gemini-(?:1\.5|2\.0|2\.5|3(?:\.\d+)?)-flash/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Gemini Flash',
  },
  {
    pattern: /^gemini-4-argon/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Gemini 4 Argon',
  },
  {
    pattern: /^gemini-4-carbon/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Gemini 4 Carbon',
  },
  {
    pattern: /^gemini-[4-9](?:\.\d+)?-[a-z0-9]+/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Gemini',
  },
  {
    pattern: /^claude-(?:3|4|5)|^claude-(?:sonnet|opus|haiku)/i,
    capacityTokens: 200_000,
    capacityCompact: '200K',
    defaultDisplayName: 'Claude',
  },
  {
    pattern: /^gpt-4o|^gpt-4\.1|^gpt-5|^o1|^o3|^o4/i,
    capacityTokens: 128_000,
    capacityCompact: '128K',
    defaultDisplayName: 'GPT-4o',
  },
  {
    pattern: /^gpt-oss/i,
    capacityTokens: 128_000,
    capacityCompact: '128K',
    defaultDisplayName: 'GPT-OSS',
  },
];

const DISPLAY_NAME_MAP: Record<string, string> = {
  'gemini-4-argon': 'Gemini 4 Argon',
  'gemini-4-argon-trial': 'Gemini 4 Argon Trial',
  'gemini-4-carbon': 'Gemini 4 Carbon',
  'gemini-4-carbon-trial': 'Gemini 4 Carbon Trial',
  'gemini-3.9-flash': 'Gemini 3.9 Flash',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-3.8-flash-n': 'Gemini 3.8 Flash',
  'gemini-3.8-flash-tiered': 'Gemini 3.8 Flash',
  'gemini-3.8-flash-exp-a': 'Gemini 3.8 Flash',
  'gemini-3.8-pro': 'Gemini 3.8 Pro',
  'gemini-3.7-flash': 'Gemini 3.7 Flash',
  'gemini-3.7-flash-tiered': 'Gemini 3.7 Flash',
  'gemini-3.7-flash-safety-le': 'Gemini 3.7 Flash',
  'gemini-3.6-flash': 'Gemini 3.6 Flash',
  'gemini-3.6-flash-tiered': 'Gemini 3.6 Flash',
  'gemini-3.6-flash-exp-a': 'Gemini 3.6 Flash',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
  'gemini-3-flash': 'Gemini 3 Flash',
  'gemini-3-flash-a': 'Gemini 3 Flash',
  'gemini-3.1-pro': 'Gemini 3.1 Pro',
  'gemini-pro-default': 'Gemini Pro',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-3-7-sonnet': 'Claude 3.7 Sonnet',
  'claude-3-5-sonnet': 'Claude 3.5 Sonnet',
  'claude-3-5-haiku': 'Claude 3.5 Haiku',
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o mini',
  'gpt-oss-120b': 'GPT-OSS 120B',
};

function autoFormatDynamicModelName(normalizedId: string): string | null {
  const geminiMatch = normalizedId.match(/^gemini-([4-9](?:\.\d+)?)-([a-z][a-z0-9]*?)(?:-(trial|preview|exp))?$/i);
  if (geminiMatch) {
    const ver = geminiMatch[1]!;
    const code = geminiMatch[2]!.charAt(0).toUpperCase() + geminiMatch[2]!.slice(1).toLowerCase();
    const suffix = geminiMatch[3]
      ? ` ${geminiMatch[3].charAt(0).toUpperCase() + geminiMatch[3].slice(1).toLowerCase()}`
      : '';
    return `Gemini ${ver} ${code}${suffix}`;
  }
  return null;
}

/**
 * 归一化前端 DOM 探针或 SQLite gen_metadata 传入的模型字符串，解析对应的 Antigravity 有效上下文阈值与展示名称
 */
export function resolveModelCapacity(rawModelInput?: string | null): ModelCapacitySpec {
  const raw = typeof rawModelInput === 'string' ? rawModelInput.trim() : '';
  if (!raw) {
    return {
      modelId: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      capacityTokens: DEFAULT_CONTEXT_CAPACITY_TOKENS,
      capacityCompact: '200K',
      isFallback: false,
    };
  }

  // 清理 API 前缀、前端按钮可能附带的加号、下拉箭头及思考档位后缀（如 "models/gemini-3.8-flash", "+ Gemini 3.8 Flash High ^"）
  const withoutApiPrefix = raw.replace(/^models\//i, '').trim();
  const cleanedRaw = (withoutApiPrefix || raw)
    .replace(/^[+\s·•]+|[⌃⌄^\s]+$/g, '')
    .replace(/[（(]\s*(?:High|Medium|Low|Extra\s+Low|Thinking|高|中|低|思考)\s*[）)]/gi, '')
    .replace(/\s+(?:High|Medium|Low|Extra\s+Low|Thinking)\b.*$/i, '')
    .trim();

  let normalizedId = (cleanedRaw || withoutApiPrefix || raw)
    .toLowerCase()
    .replace(/^models-/, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');

  normalizedId = normalizeModelId(normalizedId)
    .replace(/^claude-3\.([57])-/, 'claude-3-$1-')
    .replace(/^claude-(opus|sonnet)-3\.([57])\b/, 'claude-3-$2-$1')
    .replace(/^claude-4\.6-opus/, 'claude-opus-4-6')
    .replace(/^claude-4\.6-sonnet/, 'claude-sonnet-4-6')
    .replace(/^claude-5\.5-opus/, 'claude-opus-5-5')
    .replace(/^claude-5\.5-sonnet/, 'claude-sonnet-5-5')
    .replace(/^claude-(opus|sonnet)-(\d+)\.(\d+)/, 'claude-$1-$2-$3')
    .replace(/(?:-(?:high|medium|low|extra-low|thinking|latest))+$/, '');

  const displayName =
    DISPLAY_NAME_MAP[normalizedId] ||
    autoFormatDynamicModelName(normalizedId) ||
    cleanedRaw ||
    raw;

  for (const rule of MODEL_CAPACITY_RULES) {
    if (rule.pattern.test(normalizedId)) {
      return {
        modelId: normalizedId,
        displayName,
        capacityTokens: rule.capacityTokens,
        capacityCompact: rule.capacityCompact,
        isFallback: false,
      };
    }
  }

  return {
    modelId: normalizedId || 'unknown-model',
    displayName: cleanedRaw || raw || 'Unknown Model',
    capacityTokens: DEFAULT_CONTEXT_CAPACITY_TOKENS,
    capacityCompact: '~200K',
    isFallback: true,
  };
}
