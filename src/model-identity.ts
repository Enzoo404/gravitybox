/** Normalize spelling only; this does not authorize a model to inherit a price. */
export function normalizeModelId(name: string): string {
  return name.trim().replace(/^models\//i, '').toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
    .replace(/^claude-(opus|sonnet|haiku)-(\d+)\.(\d+)/, 'claude-$1-$2-$3')
    .replace(/^claude-3\.([57])-(sonnet|haiku)/, 'claude-3-$1-$2')
    .replace(/^claude-(3)-(5|7)-(sonnet|haiku)/, 'claude-$1-$2-$3')
    .replace(/^claude-([4-9])\.(\d+)-(opus|sonnet|haiku)/, 'claude-$3-$1-$2')
    .replace(/^claude-3\.([57])-/, 'claude-3-$1-');
}
