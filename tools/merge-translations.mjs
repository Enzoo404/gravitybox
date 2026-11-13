#!/usr/bin/env node
/**
 * 把译文回填进词典层，并做校验。
 *
 * 这是补译闭环的后半段：coverage-report.mjs 产出 `<版本>-pending.json`（待译清单），
 * 翻译环节（人或 LLM）填写后，本工具负责**校验 + 合并 + 落盘**，避免手改大 JSON 出错。
 *
 * 校验项（任何一项不过都整批拒绝，不写半成品）：
 *   1. 只能补充 pending 清单里存在的键（防止把错键写进词典）
 *   2. 译文必须是非空字符串、必须含中文、长度有上限；**拒绝“英文原文当译文”**
 *   3. 占位符（%s / {x} / $1）必须与原文一致，缺失/多余都拒绝
 *   4. 专有名词必须原样保留（运行时表 ∪ 覆盖率门禁表）
 *   5. 术语表一致性（conversation=对话、token=Token 等）
 *   6. 与已有词典层的冲突检查（默认拒绝覆盖，`--force` 才允许）
 * 基础校验集中在本文件的 validateWithRuntime，额外约束由 validateTranslations 处理。
 *
 * 用法：
 *   node tools/merge-translations.mjs --version 2.23.0 --input filled.json --dry-run
 *   node tools/merge-translations.mjs --version 2.23.0 --input filled.json
 *   node tools/merge-translations.mjs --version 2.23.0 --input filled.json --out dict/2.23.0.json
 *
 * 输入格式（待译清单的 entries[].zh 由翻译环节填写）：
 *   { "appVersion": "2.23.0", "entries": [ { "key": "Zoom in", "zh": "放大" }, ... ] }
 * 也接受简化的 `{ "Zoom in": "放大" }` 映射。
 */
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUPPORTED_BUNDLES, normalizeText as normalize } from '../dist/bundle.js';
import { validateEntries } from '../dist/dictionary.js';
import { atomicJson } from '../dist/files.js';
import { preservedIdentifier, PROPER_NOUNS, GLOSSARY_RULES } from '../dist/coverage.js';
export { PROPER_NOUNS, GLOSSARY_RULES };

const placeholderTokens = (text) => (text.match(/\{\{?\w+\}?\}|\$\d+|%[sd]/g) ?? []).sort().join('|');
const hasCJK = (text) => /[\u3400-\u9fff]/.test(text);

function validateWithRuntime(items, existing = {}) {
  const accepted = [];
  const rejected = [];
  const reject = (key, reason) => rejected.push({ key, reason });

  for (const item of items) {
    const key = normalize(String(item.key ?? ''));
    if (!key) { reject('(空键)', '键为空'); continue; }
    if (typeof item.zh !== 'string') { reject(key, '译文不是字符串'); continue; }
    const zh = normalize(item.zh);
    if (!zh) { reject(key, '译文为空'); continue; }
    if (zh.length > 4000) { reject(key, '译文超长'); continue; }
    if (zh.toLowerCase() === key.toLowerCase() && !preservedIdentifier(key)) {
      reject(key, '普通界面文案返回英文原文，未产生可应用的中文译文'); continue;
    }

    const originalPlaceholders = placeholderTokens(key);
    const translatedPlaceholders = placeholderTokens(zh);
    if (originalPlaceholders !== translatedPlaceholders) {
      reject(key, `占位符不匹配：原文 [${originalPlaceholders}]，译文 [${translatedPlaceholders}]`);
      continue;
    }

    if (existing[key] && existing[key] !== zh) {
      reject(key, `与现有词典冲突：已有 "${existing[key]}"`);
      continue;
    }

    // 检查专有名词
    let nounViolated;
    for (const noun of PROPER_NOUNS) {
      const reg = new RegExp(`\\b${noun}\\b`, 'i');
      if (reg.test(key) && !zh.toLowerCase().includes(noun.toLowerCase())) {
        nounViolated = noun;
        break;
      }
    }
    if (nounViolated) {
      reject(key, `篡改了专有名词 "${nounViolated}"，专有名词必须保持英文原样`);
      continue;
    }

    // 术语一致性
    let glossaryViolated;
    for (const rule of GLOSSARY_RULES) {
      if (rule.en.test(key)) {
        for (const forbid of rule.forbid) {
          if (zh.includes(forbid)) {
            glossaryViolated = `${rule.note}（译文错误包含了 "${forbid}"）`;
            break;
          }
        }
      }
      if (glossaryViolated) break;
    }
    if (glossaryViolated) {
      reject(key, `术语违规：${glossaryViolated}`);
      continue;
    }

    // 若原文包含英文单词且译文不含 CJK，检查是否是纯标识符/代码
    const hasWord = /[a-zA-Z]{2,}/.test(key);
    if (hasWord && !hasCJK(zh)) {
      const isIdentifierOrCode = /^[\w\-./\\]+$/.test(key) || /^(Alt|Ctrl|Cmd|Shift)\+/i.test(key);
      if (!isIdentifierOrCode) {
        reject(key, '译文缺少中文字符');
        continue;
      }
    }

    accepted.push({ key, zh });
  }

  return { accepted, rejected };
}


const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };

const inKeyAsWord = (key, noun) => new RegExp(`(?:^|[^A-Za-z])${noun.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^A-Za-z])`).test(key);
/** 保留本工具要求的专有名词，沿用现有大小写检查规则。 */
const REQUIRED_PROPER_NOUNS = PROPER_NOUNS;

/**
 * 校验一批译文。返回 `{ accepted, rejected }`，不做任何写入。
 * 基础格式规则由本文件的 validateWithRuntime 校验；
 * 在其之上额外拒绝：英文原文当译文（identity/纯英文）与任一侧要求保留的专有名词被译掉。
 * `existing` 是当前词典（键 -> 译文），用于冲突检查；`allowOverride` 时跳过冲突检查（--force）。
 */
export function validateTranslations(items, existing, { allowOverride = false } = {}) {
  const normalizedItems = items.map(item => ({ key: normalize(String(item.key ?? '')), zh: item.zh }));
  const runtime = validateWithRuntime(normalizedItems, allowOverride ? {} : existing);
  const accepted = [];
  const rejected = [...runtime.rejected];
  for (const row of runtime.accepted) {
    if (normalize(row.zh) === row.key) { rejected.push({ key: row.key, reason: '译文与原文相同（英文原文不能当译文）' }); continue; }
    if (!hasCJK(row.zh)) { rejected.push({ key: row.key, reason: '译文缺少中文字符（英文原文不能当译文）' }); continue; }
    const dropped = REQUIRED_PROPER_NOUNS.filter(noun => inKeyAsWord(row.key, noun) && !row.zh.includes(noun));
    if (dropped.length) { rejected.push({ key: row.key, reason: `专有名词被译掉：${dropped.join(', ')}` }); continue; }
    accepted.push({ key: row.key, zh: normalize(row.zh) });
  }
  return { accepted, rejected };
}

async function main() {
  const input = option('--input');
  if (!input) throw new Error('需要 --input <译文文件>');
  const version = option('--version') ?? JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const payload = JSON.parse(await readFile(input, 'utf8'));

  const items = Array.isArray(payload?.entries)
    ? payload.entries
    : Object.entries(payload ?? {}).filter(([key]) => key !== 'appVersion' && key !== 'schema').map(([key, zh]) => ({ key, zh }));

  // 现有词典（用于冲突检查）
  const existing = {};
  for (const file of [option('--base', join(root, 'dict', 'base.json'))]) {
    try { Object.assign(existing, JSON.parse(await readFile(file, 'utf8'))); } catch { /* 首次使用可无基础层 */ }
  }

  const pendingPath = option('--pending');
  if (!pendingPath) throw new Error('合并前必须指定 --pending <已审查清单>');
  const pending = JSON.parse(await readFile(pendingPath, 'utf8'));
  const allowed = new Set((pending.entries ?? []).map(e => normalize(e.key)));
  if (items.some(e => !allowed.has(normalize(String(e.key))))) throw new Error('译文包含待译清单之外的键');
  const out = option('--out') ?? join(root, 'dict', 'base.json');
  let layer = {};
  try { layer = validateEntries(JSON.parse(await readFile(out, 'utf8'))); }
  catch(error) { if(error.code!=='ENOENT')throw new Error('目标词典无法读取，原文件已保留'); }
  const { accepted, rejected } = validateTranslations(items, { ...existing, ...layer }, { allowOverride: args.includes('--force') });

  console.log(JSON.stringify({
    input,
    appVersion: payload?.appVersion ?? version,
    total: items.length,
    accepted: accepted.length,
    rejected: rejected.length,
    rejections: rejected.slice(0, 40),
  }, null, 1));

  if (rejected.length && !args.includes('--keep-partial')) {
    console.error(`[merge-translations] 有 ${rejected.length} 条未通过校验，整批拒绝写入（用 --keep-partial 可只写入通过的部分）`);
    process.exitCode = 1;
    return;
  }
  if (!accepted.length) { console.error('[merge-translations] 没有可写入的译文'); process.exitCode = 1; return; }

  if (args.includes('--dry-run')) { console.log(JSON.stringify({ dryRun: true, wouldWrite: out, entries: accepted.length })); return; }

  // 合并进目标层（保留已有内容）
  try { const previous=await readFile(out,'utf8'); await atomicJson(join(dirname(out),'.backups',basename(out)+'.'+Date.now()+'.json'),JSON.parse(previous)); } catch(error) { if(error.code!=='ENOENT')throw error; }
  for (const { key, zh } of accepted) layer[key] = zh;
  const sorted = Object.fromEntries(Object.entries(layer).sort(([a], [b]) => a.localeCompare(b)));
  await mkdir(dirname(out), { recursive: true });
  validateEntries(sorted);
  await atomicJson(out, sorted);
  console.log(JSON.stringify({ wrote: out, added: accepted.length, totalInLayer: Object.keys(sorted).length }));
}

const invokedDirectly = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(error => { console.error(`[merge-translations] ${error.stack ?? error.message}`); process.exitCode = 1; });
}
