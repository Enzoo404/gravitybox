/**
 * 模型物理上下文窗口容量映射目录与基线常量配置
 * 对齐 GRAVITYBOX-SPEC-HUD-001 第 5.2.6 节与 assets/model-catalog.json
 */

export interface ModelCapacitySpec {
  modelId: string;
  displayName: string;
  capacityTokens: number;
  capacityCompact: string;
  isFallback: boolean;
}

/** 系统提示词默认基线 Token (1.9K) */
export const DEFAULT_SYSTEM_PROMPT_BASELINE_TOKENS = 1_900;

/** 工具定义默认基线 Token (7.6K) */
export const DEFAULT_TOOL_DEFINITIONS_BASELINE_TOKENS = 7_600;

/** 默认安全兜底物理上下文容量 (1M = 1,048,576 Tokens) */
export const DEFAULT_CONTEXT_CAPACITY_TOKENS = 1_048_576;

interface ModelFamilyRule {
  pattern: RegExp;
  capacityTokens: number;
  capacityCompact: string;
  defaultDisplayName: string;
}

const MODEL_CAPACITY_RULES: readonly ModelFamilyRule[] = [
  {
    pattern: /^gemini-(?:1\.5|2\.0|2\.5)-pro/i,
    capacityTokens: 2_097_152,
    capacityCompact: '2M',
    defaultDisplayName: 'Gemini Pro',
  },
  {
    pattern: /^gemini-(?:3(?:\.\d+)?)-pro/i,
    capacityTokens: 2_097_152,
    capacityCompact: '2M',
    defaultDisplayName: 'Gemini 3 Pro',
  },
  {
    pattern: /^gemini-(?:1\.5|2\.0|2\.5|3(?:\.\d+)?)-flash/i,
    capacityTokens: 1_048_576,
    capacityCompact: '1M',
    defaultDisplayName: 'Gemini Flash',
  },
  {
    pattern: /^gemini-4-argon/i,
    capacityTokens: 1_048_576,
    capacityCompact: '1M',
    defaultDisplayName: 'Gemini 4 Argon',
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
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-3.8-flash-n': 'Gemini 3.8 Flash',
  'gemini-3.8-flash-exp-a': 'Gemini 3.8 Flash',
  'gemini-3.8-pro': 'Gemini 3.8 Pro',
  'gemini-3.7-flash': 'Gemini 3.7 Flash',
  'gemini-3.6-flash': 'Gemini 3.6 Flash',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
  'gemini-3.1-pro': 'Gemini 3.1 Pro',
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

/**
 * 归一化前端 DOM 探针或配置传入的模型字符串，解析对应的物理上下文容量与展示名称
 */
export function resolveModelCapacity(rawModelInput?: string | null): ModelCapacitySpec {
  const raw = typeof rawModelInput === 'string' ? rawModelInput.trim() : '';
  if (!raw) {
    return {
      modelId: 'gemini-4-argon',
      displayName: 'Gemini 4 Argon',
      capacityTokens: DEFAULT_CONTEXT_CAPACITY_TOKENS,
      capacityCompact: '1M',
      isFallback: false,
    };
  }

  // 将展示名（如 "Gemini 4 Argon (High)" 或 "Claude Sonnet 5.5"）归一化为标准 modelId
  let normalizedId = raw
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');

  normalizedId = normalizedId
    .replace(/^claude-3\.([57])-/, 'claude-3-$1-')
    .replace(/^claude-4\.6-opus/, 'claude-opus-4-6')
    .replace(/^claude-4\.6-sonnet/, 'claude-sonnet-4-6')
    .replace(/^claude-5\.5-opus/, 'claude-opus-5-5')
    .replace(/^claude-5\.5-sonnet/, 'claude-sonnet-5-5')
    .replace(/-(?:high|medium|low|extra-low|thinking|latest)$/, '');

  const displayName = DISPLAY_NAME_MAP[normalizedId] || raw;

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

  // C3: 未知或自定义模型安全回退为 1M，容量数字前加注 "~" 约数符号
  return {
    modelId: normalizedId || 'unknown-model',
    displayName: raw || 'Unknown Model',
    capacityTokens: DEFAULT_CONTEXT_CAPACITY_TOKENS,
    capacityCompact: '~1M',
    isFallback: true,
  };
}
