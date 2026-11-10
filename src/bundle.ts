import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';
import { createHash } from 'node:crypto';
import type { Dictionary } from './dictionary.js';

/** 当前经过完整实机验收与界面对账的版本。 */
export const SUPPORTED_BUNDLES = new Map([
  ['2.23.0', '867d1990b61d87f4b9ff8c5ecb1551c8688135267f32e56e02563f2d3e78fd68'],
  ['2.23.1', 'ad12ecf66061edab6a3835d1360e1bad50787bc7b2f2c9d86568281360864696'],
  ['2.24.0', '7a0bf9576e8ffd8e9fb39716368b1c79c2ccd965da65e049fe846100f34edf88'],
  ['2.26.0', '94abc09ac34dcae3a98f5e0fb74b66c87f8a8ad6ad214136544f924da2099e5e'],
  ['2.27.0', '40f3e1bb1441eebcba05e47c2d043954659b69788e9c513a86fc04493cd5fe66'],
  ['2.28.0', '4d2d2f3ab5aaaeda254ec4b773593fc5db683f0b5ddf81225c65a5f60e644038'],
  ['2.29.0', '8d1196a22cd3eb9779e8faf5c31eb732d3df8d9d037b685733ed4e3d6cdfb5a2'],
  ['2.29.1', 'eec7297695f3b4f25d4e92f5f9d0bc4efeec86523cddcddddefc3410c5efe37a'],
  ['2.30.0', '35e0da21894a7f6560075eae2501c88fede5204eb6067fac2653e2c7a63dc403'],
  ['2.31.0', '00c7aa77bcd1f0bce710f98a97be1e10c0b0fe91770d79216c94b47f2e591308'],
]);
export const VERIFIED_VERSIONS = new Set(SUPPORTED_BUNDLES.keys());

export function isVerifiedVersion(version?: string): boolean {
  return typeof version === 'string' && VERIFIED_VERSIONS.has(version);
}

/** 取回回环界面服务内容。界面服务是自签名 HTTPS，需要 rejectUnauthorized: false。 */
export function fetchBuffer(url: string, timeout = 10000): Promise<Buffer> {
  const parsed = new URL(url);
  if (!['127.0.0.1', '[::1]'].includes(parsed.hostname) || !['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return Promise.reject(new Error('只允许读取本机界面包'));
  const secure = url.startsWith('https:');
  const get = secure ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const request = get(url, secure ? { rejectUnauthorized: false, timeout } : { timeout }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('error', reject);
      response.on('data', chunk => { size += chunk.length; if (size > 20_000_000) { request.destroy(new Error('界面包超过大小限制')); return; } chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('timeout', () => request.destroy(new Error('读取界面包超时')));
    request.on('error', reject);
  });
}

export async function fetchBundleFromOrigin(origin: string, timeout = 10000): Promise<string> {
  const bytes = await fetchBuffer(`${origin.replace(/\/+$/, '')}/main.js`, timeout);
  return bytes.toString('utf8');
}

export function computeBundleSha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

/* ------------------------------------------------------------------ 界面串抽取与噪声过滤 */

export const ICON_NAMES = new Set((
  'add,close,check,edit,delete,search,settings,more_vert,more_horiz,arrow_back,arrow_forward,' +
  'arrow_upward,arrow_downward,expand_more,expand_less,chevron_left,chevron_right,cancel,done,' +
  'refresh,download,upload,content_copy,content_paste,visibility,visibility_off,lock,lock_open,' +
  'person,group,home,menu,notifications,history,star,star_border,favorite,info,help,error,warning,' +
  'play_arrow,pause,stop,send,share,link,attach_file,image,code,terminal,build,extension,' +
  'integration_instructions,auto_awesome,rocket_launch,bolt,flash_on,lightbulb,psychology,' +
  'smart_toy,hub,sync,cloud,cloud_off,storage,folder,folder_open,description,insert_drive_file,' +
  'schedule,calendar_today,today,date_range,filter_list,sort,tune,list,grid_view,view_list,' +
  'view_module,refresh_rounded,drag_indicator,drag_handle,open_in_new,launch,exit_to_app,logout,' +
  'login,account_circle,manage_accounts,key,shield,verified,new_releases,push_pin,push_pin_off,' +
  'block,report,flag,label,tag,bookmark,bookmark_border,thumb_up,thumb_down,reply,forward,undo,' +
  'redo,clear,remove,minimize,maximize,fullscreen,crop_square,swap_horiz,compare_arrows,' +
  'trending_up,trending_down,insights,analytics,query_stats,bar_chart,pie_chart,show_chart,' +
  'timeline,functions,calculate,memory,speed,network_check,wifi,bluetooth,usb,battery_full,' +
  'power,restart_alt,update,upgrade,download_for_offline,cloud_download,cloud_upload,file_upload,' +
  'file_download,drive_file_move,create_new_folder,note_add,post_add,add_circle,add_box,' +
  'check_circle,cancel_schedule_send,delete_forever,restore,restore_from_trash,archive,unarchive,' +
  'inventory,shopping_cart,payments,receipt,credit_card,workspace_premium,stars,emoji_events,' +
  'military_tech'
).split(','));

export const UI_PROPERTIES = [
  'label', 'title', 'description', 'placeholder', 'ariaLabel', 'aria-label', 'tooltip',
  'header', 'subheader', 'subtitle', 'confirmLabel', 'cancelLabel', 'emptyText', 'helperText',
  'tooltipText', 'message', 'text', 'heading', 'hint', 'name', 'alt', 'summary'
];

export const GENERIC_PROP_NAMES = new Set([
  'label', 'title', 'description', 'placeholder', 'ariaLabel', 'tooltip', 'header', 'subheader',
  'subtitle', 'confirmLabel', 'cancelLabel', 'emptyText', 'helperText', 'tooltipText', 'message',
  'text', 'heading', 'hint', 'alt', 'summary', 'labelText', 'displayName',
  'errorMessage', 'successMessage', 'warningMessage', 'infoMessage', 'promptText', 'buttonText',
  'primaryLabel', 'secondaryLabel', 'actionLabel', 'screenReaderText', 'caption', 'notice'
]);

export const CODE_ONLY_WORDS = new Set([
  'Apostrophe', 'Quote', 'Tilde', 'Declaration', 'Inv', 'Hub', 'Drawer', 'Exec', 'Fig', 'Semantic',
  'Regular', 'Solid', 'Dashed', 'Dotted', 'Handler', 'Annotation', 'Edition', 'Critique',
  'Visit', 'Removed', 'Toggle', 'Label', 'Right', 'Left', 'Hold', 'For', 'This', 'The', 'Class',
  'Combobox', 'CType', 'JSType', 'Invocation', 'Interpolation'
]);

const CSS_SIGNAL = /(?:^|[;{])\s*(?:--[\w-]+|@media|@keyframes|@supports|from|to|\d+%)\s*[:{]|(?:position|display|transform|transition|animation|background|border|margin|padding|font-size|font-weight|font-family|color|opacity|z-index|flex|grid|width|height|overflow|cursor|content|box-shadow|min-width|max-width|line-height|letter-spacing|text-align|border-radius|white-space|word-break|pointer-events|user-select|aspect-ratio|inset|transform-origin)\s*:/;
const CODE_SIGNAL = /=>|&&|\|\||\$\{|\bfunction\b|\breturn\b|\bvar\b|\bconst\b|\blet\b|\btypeof\b|\bvoid 0\b|\bnew [A-Z]|\.push\(|\.map\(|Object\.|Array\.|JSON\.|Math\.|window\.|document\.|console\./;

export function looksLikeNoise(text: string): boolean {
  if (!text) return true;
  if (text.length < 2 || text.length > 400) return true;
  if (!/[A-Za-z]/.test(text)) return true;
  if (/^[\d\s.,:%$+\-*/()]+$/.test(text)) return true;
  if (ICON_NAMES.has(text)) return true;
  if (/^(https?:|data:|blob:|mailto:|ws:|wss:|file:)/.test(text)) return true;
  if (/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(text)) return true;
  if (/^[.#][\w-]/.test(text)) return true;
  if (/^\/\*/.test(text)) return true;
  if (/^\/(?:[\w.-]+\/)*[\w.-]*$/.test(text) || /^~\//.test(text)) return true;
  if (/^[A-Za-z]:\\/.test(text)) return true;
  if (/\.(?:js|mjs|cjs|css|json|png|jpe?g|svg|gif|webp|woff2?|ttf|html|ts|tsx|md|yaml|yml|toml|lock|map)$/i.test(text)) return true;
  if (/^(?:application|text|image|audio|video)\/[\w.+-]+$/.test(text)) return true;
  if (/^(?:true|false|null|undefined|NaN)$/.test(text)) return true;
  if (/^[A-Z_]{2,}$/.test(text)) return true;
  if (/^[a-z][A-Za-z0-9]*$/.test(text)) return true;
  if (/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(text)) return true;
  if (/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/i.test(text)) return true;
  if (/^[a-z0-9_-]+\s*:/.test(text) && !/^[A-Za-z ]+:\s+[A-Z]/.test(text)) return true;
  if (CSS_SIGNAL.test(text)) return true;
  if (CODE_SIGNAL.test(text)) return true;
  if (/[{}]/.test(text)) return true;
  if (/;\s*$/.test(text)) return true;
  if (!/[A-Za-z]{2}/.test(text)) return true;
  if (!/\s/.test(text.trim()) && text.trim().length > 24) return true;
  if (!/[A-Za-z]{3}/.test(text)) return true;
  if (/^[a-z0-9_.\-/:,]+$/.test(text)) return true;
  /* 1. KaTeX / LaTeX 宏命令：以单或双反斜杠开头，或包含数学符号宏名 */
  if (/^\\+/.test(text)) return true;
  if (/\\+(?:cdleftarrow|cdlongequal|cdrightarrow|globalfuture|globallet|globallong|dots[bi]|fbox|angl|iiint|prime|ldots|Vert|blue)\b/i.test(text)) return true;
  /* 2. HTML 标签残片与属性拼接碎片（如 </span><span style= 等） */
  if (/<\/?(?:span|div|p|a|b|i|u|strong|em|code|pre|table|tr|td|th|ul|ol|li|br|hr|svg|path|g|button|input|label)\b/i.test(text)) return true;
  if (/<[a-zA-Z/][^>]*>/.test(text) || /\b(?:style|class|id|href|src)\s*=\s*['"]/i.test(text)) return true;
  /* 3. 单字符符号、未闭合尾随引号与代码语法碎片 */
  if (text.trim().length <= 1) return true;
  if (/['"]\s*$/.test(text) && !/^['"].*['"]$/.test(text.trim())) return true;
  if (/^Invalid \w+ type\b/i.test(text)) return true;
  if (/^[A-Za-z]+_[A-Z0-9]+$/.test(text)) return true;
  if (/^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/.test(text) && text.length < 26) return true;
  if (/\s/.test(text) && text.trim().split(/\s+/).every(part => /^(?:[a-z-]+:)*[a-z][a-z0-9]*(?:-[a-z0-9./%[\]]+)*$/.test(part) && /-|:/.test(part))) return true;
  if (/^[),;\]]/.test(text) && /[(){}[\]]|\.(?:createElement|push|map)\b/.test(text)) return true;
  if (/createElement\(|\.prototype|\.startsWith\(|\.slice\(/.test(text)) return true;
  if (/^\[[A-Za-z][\w.]*\]$/.test(text)) return true;
  if (/^!?[a-z-]+(?:-[a-z0-9./%[\]]+)*\s/.test(text) && /\s[a-z-]+:/.test(text)) return true;
  if (/^[+.]/.test(text) || /this\.|style\[/.test(text)) return true;
  if (/^(?:solid|dashed|dotted|double|groove|ridge|inset|outset|none|hidden)$/i.test(text)) return true;
  if (/^(?:translate|scale|rotate|skew|matrix|blur|grayscale|opacity|hue-rotate|rgba?|hsla?|url|linear-gradient|radial-gradient|calc|var|repeat|drop-shadow)\(/.test(text)) return true;
  if (/^-?\d+(?:\.\d+)?(?:deg|rad|turn|s|ms)?$/.test(text)) return true;
  if (/^[A-Za-z]+\d+[-_][A-Za-z0-9-]+$/.test(text)) return true;
  if (/^\[object [A-Za-z]+\]$/.test(text)) return true;
  if (/^(?:Handler|Sheet|Drawer|Dialog|Panel) #?$/.test(text)) return true;
  if (/^[A-Za-z]+ #$/.test(text)) return true;
  if (/^(?:a|an|and|as|at|by|for|from|in|into|of|on|or|the|to|with|including|class)$/i.test(text)) return true;
  if (/^(?:additions|removals|text|all|polite|assertive|off|none|aria\w*)(?:\s+(?:additions|removals|text|all))?$/i.test(text)) return true;
  if (/^(?:top|bottom|left|right|center)(?:\s+(?:top|bottom|left|right|center))?$/i.test(text)) return true;
  if (/^(?:no arrow|arrow|long equal|left arrow|right arrow)$/i.test(text)) return true;
  if (/[=!?<>]{1,3}[\w.$]*\)|throw new |separator\)|colonOffset/.test(text)) return true;
  /* 4. 扩展 Tailwind 类名、CSS 与内部常量噪声拦截 */
  if (/\[(?:calc|\d+|min|max|var|rgba?)[^\]]*\]/.test(text)) return true;
  if (/^\d+px\s+solid/i.test(text) || /^rgba?\(/i.test(text) || /cubic-bezier/i.test(text)) return true;
  if (/^system-ui,|^ui-monospace,/.test(text)) return true;
  if (/^translate[XY]\(/.test(text)) return true;
  if (/^(?:grid-rows-|opacity-|scale-|max-h-|max-w-|min-w-|h-|w-|p-|bg-|border)/.test(text) && /-|:/.test(text)) return true;
  if (/\b(?:flex|grid|items-center|justify-center|bg-|text-|border-|opacity-|animate-|px-|py-|shrink|grow|sticky|top-0|z-10)\b/.test(text) && /\s/.test(text)) return true;
  if (/\bminmax\(/.test(text) || /^page\.(?:reload|goBack|goForward)\(\)$/.test(text)) return true;
  if (/^[A-Z_]+(?:\s+[A-Z_]+)+$/.test(text)) return true;
  if (/^[a-z_]+(?:\s+[a-z_]+){2,}$/.test(text)) return true;
  if (/^[A-Z0-9_]{4,}$/.test(text)) return true;
  if (/^[A-Z]{3,}\d+$/.test(text)) return true;
  if (/^[A-Z][a-z0-9]+[A-Z0-9][a-zA-Z0-9]*$/.test(text) && !/\s/.test(text) && /(?:Validation|Handler|Descriptor|Helper|Schema|Service|Manager|State)$/.test(text)) return true;
  if (/\($/.test(text)) return true;
  if (/^EDITION_\d+_TEST_ONLY$/.test(text)) return true;
  if (/^Optional(?:Double|Int)?\.empty\(\)$/.test(text)) return true;
  if (/^(?:auxPaneV2|sidePanelV2)\//.test(text) || /^code\/timeOrigin$/.test(text) || /^no-cache,/.test(text) || /^X-Frame-Options$/.test(text)) return true;
  if (/^(?:(?:Alt|Ctrl|Cmd|Shift)\+[\w.]+\s*)+$/i.test(text)) return true;
  /* 5. 快捷键组合（空格写法）、CSS 过渡片段与模型代号：都不是界面文案，不参与翻译与门禁 */
  if (/^(?:Command|Cmd|Ctrl|Control|Option|Alt|Shift)(?:\s+(?:Command|Cmd|Ctrl|Control|Option|Alt|Shift))*\s+[A-Z0-9]$/.test(text)) return true;
  if (/^(?:(?:height|width|min-height|max-height|opacity|transform|filter|all|color|background(?:-color)?|visibility)\s+\d*\.?\d+m?s(?:\s+(?:ease(?:-(?:in|out|in-out))?|linear))?(?:\s+\d*\.?\d+m?s)?(?:\s*,\s*|$))+$/.test(text)) return true;
  if (/^(?:Flash|Gemini|Claude|GPT|Gemma)(?:\s+(?:Lite|Pro|Flash|Max|Ultra|Mini|Nano|Thinking|High|Medium|Low|Argon)){0,3}$/.test(text)) return true;
  return false;
}

export function hasWord(text: string): boolean {
  return /[A-Za-z]{3}/.test(text) || /\b(?:OK|On|Off|ID|AI|UI|OS)\b/.test(text);
}

export function isEnglishSource(text: string): boolean {
  if (looksLikeNoise(text)) return false;
  if (CODE_ONLY_WORDS.has(text)) return false;
  return hasWord(text);
}

export const isFragmentLiteral = (text: string) => /^\s|\s$/.test(text) && text.trim().length > 0;

function decodeLiteral(raw: string): string | null {
  try {
    const value = JSON.parse(raw);
    return typeof value === 'string' ? value : null;
  } catch { return null; }
}

function readLiteral(source: string, quoteIndex: number): { raw: string } | null {
  if (source[quoteIndex] !== '"') return null;
  let i = quoteIndex + 1;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\') { i += 2; continue; }
    if (char === '"') return { raw: source.slice(quoteIndex, i + 1) };
    if (char === '\n') return null;
    i += 1;
  }
  return null;
}

export type ExtractedString = { text: string; kinds: string[]; count: number };

const PROP_PATTERN = new RegExp(String.raw`(?:^|[\s,{;(])(?:${UI_PROPERTIES.map(p => p.replace(/-/g, '\\-')).join('|')}):"`, 'g');

export function extractUiStrings(source: string): ExtractedString[] {
  const found = new Map<string, { text: string; kinds: Set<string>; count: number }>();
  const record = (text: string | null, kind: string) => {
    if (!text || !isEnglishSource(kind === 'template' ? text.replace(/\$\{[^}]+\}/g, 'variable') : text)) return;
    const entry = found.get(text) ?? { text, kinds: new Set(), count: 0 };
    entry.kinds.add(kind);
    if (isFragmentLiteral(text)) entry.kinds.add('fragment');
    entry.count += 1;
    found.set(text, entry);
  };

  // 1) 明确界面属性名
  PROP_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PROP_PATTERN.exec(source))) {
    const start = match.index + match[0].length - 1;
    const literal = readLiteral(source, start);
    if (literal) { const property = match[0].slice(0,-2).match(/([\w-]+)$/)?.[1]; record(decodeLiteral(literal.raw), property ?? 'prop'); }
  }

  // 2) createElement 文本子节点
  const childPattern = /\.createElement\(\s*(?:"[^"]{1,40}"|[A-Za-z_$][\w$.]*)\s*,\s*(?:\{[^{}]*\}|\([^()]*\)|\s*\[[^[\]]*\]|[^,(){}[\]])*?,\s*("(?:[^"\\\n]|\\.)*")/g;
  while ((match = childPattern.exec(source))) {
    const decoded = decodeLiteral(match[1]!);
    if (decoded) { const tag = match[0].match(/createElement\(\s*"([^"]+)"/)?.[1]; record(decoded, tag === 'button' ? 'button' : /^h[1-6]$/.test(tag ?? '') ? 'heading' : 'text'); }
  }

  // 3) 三元/键值对中的界面串
  const pairPattern = /"(?:[^"\\\n]|\\.)*"\s*:\s*("(?:[^"\\\n]|\\.)*")/g;
  while ((match = pairPattern.exec(source))) {
    const decoded = decodeLiteral(match[1]!);
    if (decoded) record(decoded, 'text');
  }

  // 4) 泛化字段
  const genericPattern = /(?:^|[\s,{;(])([A-Za-z_$][\w$]*):\s*"((?:[^"\\\n]|\\.)*)"/g;
  let generic: RegExpExecArray | null;
  while ((generic = genericPattern.exec(source))) {
    const name = generic[1]!;
    if (!GENERIC_PROP_NAMES.has(name)) continue;
    const decoded = decodeLiteral(`"${generic[2]!}"`) ?? generic[2]!;
    record(decoded, name);
  }

  // 5) 模板串
  const templatePattern = /`((?:[^`\\]|\\.)*\$\{[^}]+\}(?:[^`\\]|\\.)*)`/g;
  let template: RegExpExecArray | null;
  while ((template = templatePattern.exec(source))) {
    const raw = template[1]!;
    if (!isEnglishSource(raw.replace(/\$\{[^}]+\}/g, ' '))) continue;
    record(raw, 'template');
  }

  const concatPattern = /"((?:[^"\\\n]|\\.){6,})"\s*\+\s*[A-Za-z_$]/g;
  while ((match = concatPattern.exec(source))) {
    const decoded = decodeLiteral(`"${match[1]}"`);
    if (decoded) record(decoded, 'template');
  }

  return [...found.values()]
    .map(e => ({ text: e.text, kinds: [...e.kinds], count: e.count }))
    .sort((a, b) => a.text.localeCompare(b.text));
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/** 对比提取结果与当前词典，筛选出缺失词条。 */
export function findMissingStrings(extracted: { text: string; kinds?: string[] }[], dictionary: Dictionary): string[] {
  const entries = dictionary.entries;
  const missing: string[] = [];
  const foldedMap = new Set<string>();
  for (const k of Object.keys(entries)) {
    foldedMap.add(k.toLowerCase());
  }
  for (const item of extracted) {
    if (item.kinds?.includes('template') || item.kinds?.includes('fragment')) continue;
    const key = normalize(item.text);
    if (Object.hasOwn(entries, key)) continue;
    if (foldedMap.has(key.toLowerCase())) continue;
    missing.push(key);
  }
  return [...new Set(missing)].sort((a, b) => a.localeCompare(b));
}

export type PendingList = {
  schema: 1;
  appVersion: string;
  bundleSha256: string;
  generatedAt: string;
  missingCount: number;
  entries: { key: string; count?: number; kinds?: string[] }[];
};

export function createPendingList(appVersion: string, bundleSha256: string, missing: string[]): PendingList {
  return {
    schema: 1,
    appVersion,
    bundleSha256,
    generatedAt: new Date().toISOString(),
    missingCount: missing.length,
    entries: missing.map(key => ({ key }))
  };
}

/** Hash during download. Only extraction callers need a decoded source string. */
export async function fetchBundleWithHash(origin:string,timeout=8000):Promise<{source:string;hash:string;bytes:number}>{
  const url=new URL('/main.js',origin);
  if(!['127.0.0.1','[::1]'].includes(url.hostname)||!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('仅允许本机界面资源');
  return new Promise((resolve,reject)=>{
    const get=url.protocol==='https:'?httpsGet:httpGet;
    const request=get(url,{rejectUnauthorized:false,timeout},response=>{
      if(response.statusCode!==200){response.resume();reject(new Error(`HTTP ${response.statusCode}`));return;}
      const chunks:Buffer[]=[];const hash=createHash('sha256');let size=0;
      response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>20_000_000){request.destroy(new Error('界面包过大'));return;}hash.update(chunk);chunks.push(chunk);});
      response.on('error',reject);response.on('end',()=>resolve({source:Buffer.concat(chunks).toString('utf8'),hash:hash.digest('hex'),bytes:size}));
    });request.on('error',reject);request.on('timeout',()=>request.destroy(new Error('界面包读取超时')));
  });
}

/** Keep extractor evidence; generic text is a label, never invent a button role. */
export function extractedKind(kinds: string[] = []): string | undefined {
  const mapping: Record<string,string> = {button:'button',buttonText:'button',primaryLabel:'button',secondaryLabel:'button',confirmLabel:'button',cancelLabel:'button',heading:'heading',header:'heading',title:'heading',subtitle:'heading',placeholder:'placeholder',tooltip:'tooltip',tooltipText:'tooltip',hint:'tooltip',label:'label',labelText:'label',ariaLabel:'attribute','aria-label':'attribute',text:'label',description:'description',message:'toast'};
  for (const kind of kinds) if (mapping[kind]) return mapping[kind]; return undefined;
}
