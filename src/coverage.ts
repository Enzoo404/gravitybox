import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { extractUiStrings, extractedKind, fetchBuffer, isEnglishSource } from './bundle.js';
import { decodeScopedKey } from './candidates.js';
import type { Dictionary } from './dictionary.js';
import type { DeepReport } from './deep-scan.js';

export type CoverageSource = { id: string; scope: 'renderer' | 'native'; source: string };
export type CoverageEntry = { key: string; translation?: string; status: string; sources: string[]; confidence: 'ui' | 'literal'; kind?: string; observed?: 'verified' | 'untranslated'; observations?: number; scoped?: boolean };
export type CoverageScope = { route: string; kind: string };
export type CoverageReport = {
  schema: 1; appVersion: string; bundleSha256: string; dictionaryVersion: string; generatedAt: string;
  resources: { id: string; scope: string; bytes: number; sha256: string }[]; skipped: { id: string; reason: string }[];
  entries: CoverageEntry[];
  /** 互斥终态计数：每个词条恰好一个桶（实机观察优先于扫描状态），sum(counts) === entries.length。 */
  counts: Record<string, number>;
  /** 两轴明细：纯扫描状态（不受实机观察影响）。旧报告可能没有，读取方需容错。 */
  statusCounts?: Record<string, number>;
  /** 两轴明细：实机观察值（verified/untranslated），单独计数，不重复计入 counts。 */
  observedCounts?: Record<string, number>;
  visits: { at: string; route: string; observations: number; unknownUiCount: number; protectedCount: number; truncated: boolean }[];
  auditExpiresAt?: string;
  deep?: DeepReport;
  limits: string[];
};
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 必须保留英文原样的专有名词单一事实源（供 coverage-report 与 merge-translations 共同引用）。 */
export const PROPER_NOUNS: string[] = [
  'Antigravity', 'GravityBox', 'Gemini', 'GitHub', 'Git', 'MCP', 'OAuth', 'npm', 'Node.js', 'Python',
  'Docker', 'Kubernetes', 'Puppeteer', 'Playwright', 'Jetski', 'Sidecar', 'Firebase',
  'Flutter', 'Dart', 'Electron', 'LaTeX', 'Mermaid', 'Catppuccin', 'AGY', 'Google',
  'Inter', 'Gruvbox', 'Solarized', 'Dracula', 'Nord', 'Monokai', 'Tokyo Night',
  'Aoede', 'Arlo', 'Charon', 'Cleo', 'Fenrir', 'Finn', 'Fola', 'Gero', 'Kore', 'Leda', 'Lora', 'Neno', 'Olin', 'Orus', 'Puck', 'Tari', 'Zephyr', 'Project 4K',
  'Ayu', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Roboto Mono', 'SF Mono', 'Source Code Pro',
  'One Dark', 'One Light',
];

/** 核心术语一致性词表单一事实源（供 merge-translations 与质检复用）。 */
export const GLOSSARY_RULES: { en: RegExp; zh: string; forbid: string[]; note: string }[] = [
  { en: /\bconversations?\b/i, zh: '对话', forbid: ['会话', '聊天'], note: 'conversation → 对话' },
  { en: /\bchats?\b/i, zh: '对话', forbid: ['聊天'], note: 'chat → 对话' },
  { en: /\btokens?\b/i, zh: 'Token', forbid: ['令牌', '标记'], note: 'token → Token' },
  { en: /\ballow ?lists?\b/i, zh: '允许列表', forbid: ['白名单'], note: 'allowlist → 允许列表' },
  { en: /\bdeny ?lists?\b/i, zh: '拒绝列表', forbid: ['黑名单'], note: 'denylist → 允许列表' },
  { en: /\bcustomizations?\b/i, zh: '自定义', forbid: ['个性化', '定制'], note: 'customization → 自定义' },
  { en: /\bplugins?\b/i, zh: '插件', forbid: [], note: 'plugin → 插件' },
  { en: /\bextensions?\b/i, zh: '扩展', forbid: [], note: 'extension → 扩展' },
];
export const preservedIdentifier = (key: string) => [
  '!text-black','/abns/…','Alt','Android (main)','Aoede','Arlo','Ayu','Ayu Dark','Ayu Light','Ayu Mirage','BoN','Buganizer','Cascadia Code','Cascadia Mono','Catppuccin',
  'Catppuccin Frappe','Catppuccin Latte','Catppuccin Macchiato','Catppuccin Mocha','Charon','Chromium','Cleo','Consolas','Cookie','Courier New','Ctrl',
  'Dracula','Fenrir','Finn','Fira Code','Fira Mono','Flash','Fola','Gemini 2.5 Flash Image','Gemini 3 Pro Image','Gemini 3.1 Flash Image','Gemini Enterprise','Gero',
  'Google Antigravity SDK','Google Chat','Google Chrome','Google Sans','Google Sans Code','Google Sans Text','Google3',
  'Gruvbox','Gruvbox Dark','Gruvbox Light','Gruvbox Material','Hack','Inconsolata','Inter','items-start overflow-y-auto overflow-x-hidden [&>*]:my-auto','JetBrains Mono','Jetski','Kore','Leda','Linux','Lora','MacOS',
  'Menlo','Monaco','Monokai','Monokai Dimmed','Monokai Pro','my-gcp-project-id','Neno','Nord','Olin','One Dark','One Dark Pro','One Light','Orus','PID','PID ',
  'Pro','Project 4K','Puck','Quiet Light','Roboto Mono','Sec-Fetch-Dest','SF Mono','Shift','Solarized','Solarized Dark','Solarized Light','Source Code Pro','Tari',
  'Tokyo Night','Ubuntu Mono','Windows','Workspace_1','Workspace_2','Workspace_3','Zephyr'
].includes(key) || /^(?:Antigravity|GravityBox|Google|Gemini|Claude|GPT(?:-OSS)?|OpenAI|DeepSeek|Ollama|GitHub|OAuth|MCP|API|JSON|HTTP|HTTPS|URL|URI|SSH|SQL|HTML|CSS|JavaScript|TypeScript|Node\.js|macOS|Linux|Windows|Docker|VS Code)(?:$|\s+[\d.(])/.test(key);
export function classifyCoverage(key: string, translation?: string, template = false): string {
  if (template || key.includes('${') || key === 'Resets in {duration}') return 'dynamic';
  if (translation && normalize(translation).toLowerCase() !== normalize(key).toLowerCase()) return 'translated';
  if (preservedIdentifier(key)) return 'preserved';
  return translation ? 'unchanged' : 'missing';
}

/* ------------------------------------------------------------------ 场景键 {@ui:} 查表与覆盖率诊断噪声 */

export type CoverageTranslationLookup = {
  dictionary: Dictionary;
  /** 普通键（规范化 + 小写折叠）→ 译文。 */
  folded: Map<string, string>;
  /** scoped 键（小写折叠）→ 原键与译文。 */
  scoped: Map<string, { key: string; value: string }>;
  /** scoped 键解出的原文（规范化 + 小写）→ 所有场景译文，用于资源扫描时没有场景信息也能判定“已有场景译文”。 */
  scopedText: Map<string, string[]>;
};
const lookupCache = new WeakMap<Dictionary, CoverageTranslationLookup>();

/** 构造（并按词典对象缓存）覆盖率查表，普通键 + @ui: 场景键一起索引。 */
export function coverageTranslationLookup(dictionary: Dictionary): CoverageTranslationLookup {
  const cached = lookupCache.get(dictionary);
  if (cached) return cached;
  const folded = new Map<string, string>();
  const scoped = new Map<string, { key: string; value: string }>();
  const scopedText = new Map<string, string[]>();
  for (const [key, value] of Object.entries(dictionary.entries)) {
    folded.set(normalize(key).toLowerCase(), value);
    const scope = decodeScopedKey(key);
    if (!scope) continue;
    scoped.set(key.toLowerCase(), { key, value });
    const text = normalize(scope.key).toLowerCase();
    const values = scopedText.get(text) ?? [];
    values.push(value);
    scopedText.set(text, values);
  }
  const lookup = { dictionary, folded, scoped, scopedText };
  lookupCache.set(dictionary, lookup);
  return lookup;
}

/**
 * 解析词条译文（B16）：先按已知场景精确命中 `@ui:<route>|<kind>|<原文>`，再退回普通键；
 * 没有场景信息（资源扫描阶段）时，只要词典里存在该原文的场景译文且译文一致，也算已翻译——
 * 避免“已有场景译文却被判 missing、再次进入补译候选”。多个场景译文互相冲突时返回 ambiguous（人工核对，不算缺失）。
 */
export function resolveCoverageTranslation(
  key: string,
  lookup: CoverageTranslationLookup,
  scopes: CoverageScope[] = []
): { translation?: string; scoped?: boolean; ambiguous?: boolean } {
  const text = normalize(key), lower = text.toLowerCase();
  for (const scope of scopes) {
    const exact = lookup.scoped.get(`@ui:${scope.route}|${scope.kind}|${text}`.toLowerCase());
    if (exact) return { translation: exact.value, scoped: true };
  }
  const plain = lookup.folded.get(lower);
  if (plain !== undefined) return { translation: plain };
  const scopedValues = lookup.scopedText.get(lower);
  if (scopedValues?.length) {
    const variants = [...new Set(scopedValues)];
    if (variants.length === 1) return { translation: variants[0]!, scoped: true };
    return { ambiguous: true, scoped: true };
  }
  return {};
}

/** 从“可见界面 <route> <kind>”来源解析场景；资源扫描来源没有场景信息时返回空数组。 */
export function coverageScopes(entry: Pick<CoverageEntry, 'sources'>): CoverageScope[] {
  const scopes = new Map<string, CoverageScope>();
  for (const source of entry.sources) {
    const match = source.match(/^可见界面 (\S+) (\S+)$/);
    if (!match) continue;
    const scope = { route: normalize(match[1]!), kind: normalize(match[2]!) };
    scopes.set(`${scope.route}|${scope.kind}`, scope);
  }
  return [...scopes.values()];
}

const NOISE_PATTERNS: RegExp[] = [
  /^(?:at\s+[\w$.<>[\]]+\s*\(|at\s+[\w$.<>[\]]+@)/,
  /\b(?:Error generating stack|Uncaught (?:Type)?Error|stack trace|Traceback)\b/i,
  /^(?:Uncaught|Error|TypeError|ReferenceError|SyntaxError|RangeError|DOMException)\b/,
  /^\[[A-Za-z][\w .-]{0,40}\]/,
  /\b(?:node_modules|\.asar)\b/,
  /(?:https?|file|webpack|chrome-extension):\/\//,
  /\.[A-Za-z]{1,5}:\d+(?::\d+)?\b/,
  /;\s*(?:break|case)\b/,
  /\bcase\s+-?\d+\s*:/,
  /=>|\b(?:function|return|typeof|instanceof|delete|void)\s*[({]/,
  /(?:^|[^A-Za-z])(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=/,
  /[A-Za-z_$][\w$]*\s*=\s*[A-Za-z_$'"`[{]/,
  /\b(?:console|document|window|globalThis|process)\.\w+/,
  /\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/,
  /(?:^|\s)--[a-z][\w-]*/,
  /[{}]\s*[;,}]|;\s*[})\]]/,
  /\b[A-Za-z_$][\w$]*\(\)/ ,
  /^[_,+\-*#;:,)\]}/*=!?'"]/,
  /\b(?:stroke-[a-z]+|fill-[a-z]+|data-[a-z][\w-]*|aria-[a-z][\w-]*|stroke-dasharray|stroke-width)\b/,
  /\[[&_][^\]]*\]/,
  /\b[A-Za-z][\w ]{0,30}:\s*\$\{[^}]*\}/,
  /^\[\.\.\.|\[object [A-Z]/,
  /^\s*\((?:display-mode|hover|pointer|prefers-[a-z-]+)\s*:/,
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f]|\u001b\[/,
  /\\\\|\\(?:[\(\)\[\]{}|+*?^$.])/,
];

/** Tailwind/CSS 工具类串：由若干小写 token 组成且至少一个 token 带 CSS 特征符（- : [ ] ! & %）。 */
const isCssUtilityList = (text: string) => {
  if (!/[-:[\]!&%]/.test(text)) return false;
  const tokens = text.split(/\s+/);
  if (tokens.length > 12) return false;
  const cssToken = /^!?[a-z][a-z0-9:/[\]&%._-]*$/;
  return tokens.every(token => cssToken.test(token));
};

/**
 * 覆盖率诊断噪声（I07）：**先 trim/规范化再匹配**。
 * 覆盖前导换行/空白、堆栈、日志前缀、压缩 JS 片段、纯标识符/路径/键名；不误伤正常界面文案与模板串。
 */
export function isCoverageNoise(raw: string): boolean {
  if (typeof raw !== 'string') return true;
  const text = normalize(raw);
  if (!text || text.length > 400) return true;
  if (/[\u3400-\u9fff]/.test(text)) return false;          // 中文内容按正常词条处理
  if (preservedIdentifier(text)) return false;             // 品牌/专名保留原样，不算噪声
  if (NOISE_PATTERNS.some(pattern => pattern.test(text))) return true;
  if (isCssUtilityList(text)) return true;                  // 压缩 JS 里的 Tailwind/CSS 类名串
  // 纯标识符/键名/路径：无空格且含代码或路径分隔符（单个正常单词如 Settings/Cancel 不在此列）
  if (!/\s/.test(text) && /[._/\\:@$=<>[\]{};|&*+~^%#]/.test(text)) return true;
  // 小驼峰压缩标识符（macOS 等保留名已在上面放行）
  if (!/\s/.test(text) && /^[a-z][A-Za-z0-9]{1,}[A-Z]/.test(text)) return true;
  return false;
}

/**
 * 覆盖页应隐藏的诊断行：只对“待译/待确认”类行做噪声过滤；
 * dynamic/native/translated 等分类行仍保留，便于解释计数。
 */
export function shouldHideCoverageRow(entry: { key: string; status?: string; observed?: string }): boolean {
  const state = entry.observed ?? entry.status ?? '';
  if (!['missing', 'review', 'untranslated', 'unchanged'].includes(state)) return false;
  return isCoverageNoise(entry.key);
}

// Broader than online extraction. Low-confidence literals are review-only and never sent automatically.
export function extractCoverageStrings(source: string) {
  const found = new Map<string, { key: string; confidence: 'ui' | 'literal'; kind?: string; template: boolean }>();
  const blocked = (key: string) => !key || key.length > 400 || /[\u3400-\u9fff]/.test(key) || /(?:https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:sk-|AIza)[\w-]{12,})/.test(key);
  /** I07：所有候选（结构化抽取 + literal 兜底）都先 trim/规范化并过噪声判定，堆栈/日志/压缩 JS/纯标识符不进覆盖率清单。 */
  const add = (raw: string, confidence: 'ui' | 'literal', kind?: string, template = false) => {
    const key = normalize(raw);
    if (blocked(key) || !isEnglishSource(template ? key.replace(/\$\{[^}]+\}/g, 'variable') : key) || isCoverageNoise(key)) return;
    if (!found.has(key)) found.set(key, { key, confidence, kind, template });
    else if (confidence === 'ui') { const existing = found.get(key)!; existing.confidence = 'ui'; existing.kind ??= kind; }
  };
  for (const entry of extractUiStrings(source)) add(entry.text, 'ui', extractedKind(entry.kinds), entry.kinds.includes('template') || entry.kinds.includes('fragment'));
  for (const match of source.matchAll(/"(?:[^"\\\n]|\\.){2,2000}"|'(?:[^'\\\n]|\\.){2,2000}'/g)) {
    let key: string;
    try { key = match[0][0] === '"' ? JSON.parse(match[0]) : match[0].slice(1,-1).replace(/\\'/g,"'").replace(/\\n/g,' '); } catch { continue; }
    add(key, 'literal');
  }
  return [...found.values()];
}

export function staticReferences(source: string): string[] {
  const refs = new Set<string>();
  // Only static files, never API paths, account requests, query strings or absolute hosts.
  const patterns = [/(?:src|href)=["']([^"'?#]+\.(?:m?js|html))["']/g, /(?:import\s*(?:\(\s*)?|from\s*)["']([^"'?#]+\.m?js)["']/g];
  for (const pattern of patterns) for (const m of source.matchAll(pattern)) if (/^(?:\.?\.?\/)?[\w./-]+\.(?:m?js|html)$/.test(m[1]!) && !m[1]!.includes('..')) refs.add(m[1]!);
  return [...refs];
}
export async function rendererSources(origin: string, main: string, signal: AbortSignal, progress: (done: number, total: number) => void) {
  const resources: CoverageSource[] = [{ id: '/main.js', scope: 'renderer', source: main }];
  const skipped: {id: string; reason: string}[] = []; const seen = new Set(['/main.js']);
  const queue = ['/', ...staticReferences(main)]; let bytes = Buffer.byteLength(main);
  while (queue.length) {
    signal.throwIfAborted(); const raw = queue.shift()!; const url = new URL(raw, origin + '/');
    if (url.origin !== origin || url.search || url.hash || seen.has(url.pathname)) continue;
    seen.add(url.pathname);
    if (seen.size > 64 || bytes > 50_000_000) { skipped.push({ id: url.pathname, reason: '资源数量或总大小达到扫描上限' }); continue; }
    try {
      const buffer = await fetchBuffer(url.href, 5000); signal.throwIfAborted();
      const source = buffer.toString('utf8'); bytes += buffer.length;
      resources.push({ id: url.pathname, scope: 'renderer', source });
      for (const ref of staticReferences(source)) queue.push(new URL(ref, url).pathname);
    } catch (error) { signal.throwIfAborted(); skipped.push({ id: url.pathname, reason: '静态资源读取失败' }); }
    progress(resources.length, resources.length + queue.length);
  }
  return { resources, skipped };
}

// Read only this application's first-party ASAR files; do not execute or unpack into its bundle.
export function asarSources(buffer: Buffer): CoverageSource[] {
  if (buffer.length < 16) throw new Error('应用资源头不完整');
  const headerSize = buffer.readUInt32LE(4), jsonSize = buffer.readUInt32LE(12);
  if (jsonSize > 8_000_000 || jsonSize + 16 > buffer.length || headerSize + 8 > buffer.length) throw new Error('应用资源索引无效');
  const header = JSON.parse(buffer.subarray(16,16+jsonSize).toString()); const result: CoverageSource[] = [];
  const walk = (files: Record<string, any>, prefix = '') => {
    for (const [name, entry] of Object.entries(files)) {
      const path = prefix + name;
      if (entry.files) { if (!/^(?:node_modules|vendor)(?:\/|$)/.test(path)) walk(entry.files, path + '/'); continue; }
      if (entry.link || entry.unpacked || !/^dist\/.+\.(?:js|html)$/.test(path) || /(?:^|\/)(?:__mocks__|test|tests)\/|\.test\./.test(path)) continue;
      const size = Number(entry.size), offset = Number(entry.offset) + headerSize + 8;
      if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset) || size < 0 || size > 2_000_000 || offset < headerSize + 8 || offset + size > buffer.length) throw new Error('应用资源位置无效');
      result.push({ id: `app.asar/${path}`, scope: 'native', source: buffer.subarray(offset,offset+size).toString() });
    }
  }; walk(header.files); return result;
}
export async function nativeSources(appPath: string) { return asarSources(await readFile(join(appPath,'Contents/Resources/app.asar'))); }

export function createCoverage(sources: CoverageSource[], dictionary: Dictionary, appVersion: string, bundleSha256: string, skipped: CoverageReport['skipped'] = []): CoverageReport {
  const lookup = coverageTranslationLookup(dictionary);
  const found = new Map<string,CoverageEntry>();
  for (const resource of sources) for (const item of extractCoverageStrings(resource.source)) {
    const id = `${resource.scope}:${item.key}`; const old = found.get(id); if (old) { if (!old.sources.includes(resource.id)) old.sources.push(resource.id); if (item.confidence === 'ui') old.confidence = 'ui'; old.kind ??= item.kind; continue; }
    /* B16：资源扫描阶段没有 route/kind，也要把 @ui: 场景译文算作已翻译，避免重复判 missing/再次补译。 */
    const resolved = resolveCoverageTranslation(item.key, lookup);
    const translation = resolved.translation;
    let status = resolved.ambiguous ? 'review' : classifyCoverage(item.key,translation,item.template);
    if(item.confidence==='literal'&&status==='missing')status='review';
    found.set(id, { key: item.key, translation, status: resource.scope === 'native' ? 'native' : status, sources: [resource.id], confidence: item.confidence, kind: item.kind, ...(resolved.scoped?{scoped:true}:{}) });
  }
  // Auditable built-in display strings delivered by the service, absent from the main bundle.
  for (const key of ['compact','teamwork-preview','Compact the conversation now (summarize history to free up the context window).','Weekly Limit Remaining','Five Hour Limit Remaining','Gemini Models','Claude and GPT models','Resets in {duration}']) {
    if (![...found.values()].some(e => e.key === key)) {
      const resolved = resolveCoverageTranslation(key, lookup);
      found.set('catalog:' + key,{ key, translation: resolved.translation, status: resolved.ambiguous?'review':classifyCoverage(key,resolved.translation), sources: ['reviewed-ui-catalog'], confidence: 'ui', ...(resolved.scoped?{scoped:true}:{}) });
    }
  }
  const report: CoverageReport = { schema: 1, appVersion, bundleSha256, dictionaryVersion: dictionary.version, generatedAt: new Date().toISOString(), resources: sources.map(r => ({ id:r.id, scope:r.scope, bytes:Buffer.byteLength(r.source),sha256:createHash('sha256').update(r.source).digest('hex') })), skipped, entries:[...found.values()].sort((a,b)=>a.key.localeCompare(b.key)), counts:{},statusCounts:{},observedCounts:{},visits:[],limits:['扫描受时间、节点和采样上限约束；跨域 iframe、关闭的 Shadow DOM、%s/ICU 以及重排的内联占位暂不支持。','资源扫描不等于实际页面验收；低置信度文字需人工核对。','未知页面文本只计数，不保存正文，不用于在线补译。','原生菜单、账号条件、插件自定义文字和危险操作后的界面需单独验收。'] };
  recountCoverage(report);return report;
}

/**
 * B14/B15：把 status 与 observed 分成两个计数轴，并给出**互不重复**的终态计数：
 * - `counts`：每词条一个桶（实机观察优先：verified/untranslated；未观察按扫描状态），sum === entries.length；
 * - `statusCounts`：纯扫描状态（不受实机观察影响）；
 * - `observedCounts`：实机观察值（verified/untranslated），单独计数。
 * 旧报告（无两轴字段）在读取时由主进程补齐，不会出现 sum 大于词条数。
 */
export function recountCoverage(report: CoverageReport) {
  const counts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  const observedCounts: Record<string, number> = {};
  for (const entry of report.entries) {
    statusCounts[entry.status] = (statusCounts[entry.status] ?? 0) + 1;
    if (entry.observed) {
      observedCounts[entry.observed] = (observedCounts[entry.observed] ?? 0) + 1;
      counts[entry.observed] = (counts[entry.observed] ?? 0) + 1;
    } else {
      counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    }
  }
  report.counts = counts;
  report.statusCounts = statusCounts;
  report.observedCounts = observedCounts;
}

/** 覆盖率口径快照：总览与覆盖页共用同一来源（B15），并带应用版本/生成时间/词典版本。 */
export type CoverageMetrics = {
  available: boolean;
  appVersion: string;
  generatedAt: string;
  dictionaryVersion: string;
  bundleSha256: string;
  /** 已抽取词条数（分母）。 */
  extracted: number;
  /** 与覆盖页“已覆盖”同源的计数：counts.translated。 */
  translated: number;
  verified: number;
  /** translated + verified：真实“已覆盖”上界，供后续 UI 采用。 */
  covered: number;
  missing: number;
  review: number;
  dynamic: number;
  native: number;
  preserved: number;
  unchanged: number;
  observedUntranslated: number;
  counts: Record<string, number>;
  statusCounts: Record<string, number>;
  observedCounts: Record<string, number>;
};
export function coverageMetricSnapshot(report?: CoverageReport): CoverageMetrics {
  const counts = report?.counts ?? {};
  const translated = counts.translated ?? 0;
  const verified = counts.verified ?? 0;
  return {
    available: !!report,
    appVersion: report?.appVersion ?? '',
    generatedAt: report?.generatedAt ?? '',
    dictionaryVersion: report?.dictionaryVersion ?? '',
    bundleSha256: report?.bundleSha256 ?? '',
    extracted: report?.entries.length ?? 0,
    translated,
    verified,
    covered: translated + verified,
    missing: counts.missing ?? 0,
    review: counts.review ?? 0,
    dynamic: counts.dynamic ?? 0,
    native: counts.native ?? 0,
    preserved: counts.preserved ?? 0,
    unchanged: counts.unchanged ?? 0,
    observedUntranslated: counts.untranslated ?? 0,
    counts,
    statusCounts: report?.statusCounts ?? {},
    observedCounts: report?.observedCounts ?? {},
  };
}

export function recordCoverageVisit(report: CoverageReport, route: string, audit: any) {
  // A report may contain only keys already catalogued, even if a page returns an unexpected payload.
  const observations = new Map<string,string>();
  for (const row of Array.isArray(audit?.observations) ? audit.observations.slice(0,20000) : []) if (typeof row?.key === 'string' && ['verified','untranslated'].includes(row.state)) observations.set(normalize(row.key),row.state);
  for (const entry of report.entries) { const state=observations.get(normalize(entry.key)); if(state && !['native','preserved'].includes(entry.status)) { entry.observed=state as 'verified'|'untranslated';entry.observations=(entry.observations??0)+1;entry.confidence='ui';if(entry.status==='review')entry.status='missing'; } }
  report.visits.push({ at:new Date().toISOString(),route: /^\/(?:settings(?:\/[a-z-]+)?|history|customizations(?:\/[a-z-]+)?|automations)?$/.test(route)?route:'/other',observations:report.entries.filter(e=>e.status!=='native'&&observations.has(normalize(e.key))).length,unknownUiCount:Math.max(0,Number(audit?.unmatchedCount)||0),protectedCount:Math.max(0,Number(audit?.protectedCount)||0),truncated:!!audit?.truncated });
  report.visits=report.visits.slice(-100);recountCoverage(report);
}
export const coverageStatusNames: Record<string,string> = { translated:'词典已覆盖', missing:'缺少译文', unchanged:'原样译文待确认', preserved:'保留名称',review:'候选需人工分类',dynamic:'动态片段待分类',native:'原生界面单独处理',verified:'实机已验证',untranslated:'实机仍为英文' };
export function coverageMarkdown(report: CoverageReport) {
  const metric = coverageMetricSnapshot(report);
  const sum = Object.values(report.counts).reduce((total, count) => total + count, 0);
  const lines=['# 界面汉化覆盖清单','',`应用 ${report.appVersion} · ${report.generatedAt}`,`词典版本 ${report.dictionaryVersion}；界面包 ${report.bundleSha256}`,'','资源扫描与实机验收分别记录，不以词典命中率宣称全部界面已汉化。','',`已抽取词条 ${metric.extracted} 条；分类合计 ${sum} 条（每词条一个终态，实机观察优先，不重复计数）。`,'','## 分类（互斥终态）','',...Object.entries(report.counts).map(([key,count])=>`- ${coverageStatusNames[key]??key}：${count}`),'','## 实机观察（另计，不重复计入分类）','',...(Object.entries(report.observedCounts ?? {}).length?Object.entries(report.observedCounts!).map(([key,count])=>`- ${coverageStatusNames[key]??key}：${count}`):['- 尚无实机观察']),'',`已读资源 ${report.resources.length} 个；记录页面采样 ${report.visits.length} 次；未读资源 ${report.skipped.length} 个。`,'',...report.limits.map(s=>'- '+s),'','| 原文 | 分类 | 实机结果 | 来源 |','| --- | --- | --- | --- |'];
  const esc=(s:string)=>s.replace(/\|/g,'\\|').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,' ');
  for(const e of report.entries)lines.push(`| ${esc(e.key)} | ${coverageStatusNames[e.status]??e.status}${e.confidence==='literal'?'（需核对）':''} | ${e.observed?coverageStatusNames[e.observed]:'未检查'} | ${e.sources.map(esc).join(', ')} |`);
  return lines.join('\n')+'\n';
}

export function coverageEntryType(entry: {status:string; viewType?:string}): string {
  if (entry.viewType) return entry.viewType;
  return ['dynamic','native','preserved','plugin','native-live','route'].includes(entry.status) ? entry.status : 'ui';
}
export function filterCoverageEntries<T extends {key:string;translation?:string;status:string;observed?:string;viewType?:string}>(entries:T[], query:string, status:string, type='all'):T[] {
  const q=query.toLowerCase().replace(/\s+/g,' ').trim().slice(0,200);
  return entries.filter(e=>{
    if (shouldHideCoverageRow(e)) return false;
    if (q && !e.key.replace(/\s+/g,' ').trim().toLowerCase().includes(q) && !(e.translation??'').toLowerCase().includes(q)) return false;
    if (type!=='all' && coverageEntryType(e)!==type) return false;
    if (status==='missing') return ['missing','untranslated'].includes(e.status) || ['missing','untranslated'].includes(e.observed??'');
    return ['all','plugin','native-live','route'].includes(status) || e.status===status || e.observed===status;
  });
}
