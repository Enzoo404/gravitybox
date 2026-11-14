/** Strip Vertex AI / GCP / Cloud publisher prefixes and RPC method suffixes while preserving case. */
export function stripModelProviderPrefix(name: string): string {
  return name.trim()
    .replace(/^(?:projects\/[^/]+\/locations\/[^/]+\/)?(?:publishers\/[^/]+\/)?models\//i, '')
    .replace(/^publishers\/[^/]+\/models\//i, '')
    .replace(/^(?:vertex_ai|google|anthropic|openai)\//i, '')
    .replace(/^models\//i, '')
    .replace(/:(?:predict|generateContent|streamGenerateContent)$/i, '');
}

/** Normalize spelling only; this does not authorize a model to inherit a price. */
export function normalizeModelId(name: string): string {
  return stripModelProviderPrefix(name)
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
    .replace(/^claude-(opus|sonnet|haiku)-3\.([57])\b/, 'claude-3-$2-$1')
    .replace(/^claude-(opus|sonnet|haiku)-(\d+)\.(\d+)/, 'claude-$1-$2-$3')
    .replace(/^claude-3\.([57])-(sonnet|haiku)/, 'claude-3-$1-$2')
    .replace(/^claude-(3)-(5|7)-(sonnet|haiku)/, 'claude-$1-$2-$3')
    .replace(/^claude-([4-9])\.(\d+)-(opus|sonnet|haiku)/, 'claude-$3-$1-$2')
    .replace(/^claude-3\.([57])-/, 'claude-3-$1-');
}
