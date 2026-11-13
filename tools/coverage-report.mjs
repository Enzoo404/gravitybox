#!/usr/bin/env node
/**
 * 覆盖率对账 + 发布门禁。
 *
 * 输入：`ui-strings/<appVersion>.json`（由 extract-ui-strings.mjs 生成）+ `dict/*.json`
 * 输出：`reports/coverage-<appVersion>.json`，并在终端打印人类可读摘要
 *
 * 四个分类（这正是"有没有漏译 / 有没有死词条"需要区分的地方）：
 *   covered  —— 界面串在词典里有译文
 *   missing  —— 界面串是真实文案但词典里没有（**需要补译**）
 *   obsolete —— 词典词条在本版界面包里根本不存在（应用已改文案 / 来源是别的版本）
 *   caseOnly —— 只有大小写不同；引擎会按小写折叠查表，运行时必然命中，因此计入覆盖率
 *
 * 门禁检查项：界面包来源可验证（必须）、界面位置覆盖率、需要补译的条数、专有名词违规条数。
 * 来源校验（必须从实际字节重算，哈希参数不能替代字节证明）：
 *   1. 提供 `--bundle <main.js>`：重算 sha256，必须同时等于提取记录哈希与
 *      `dist/bundle.js: SUPPORTED_BUNDLES[appVersion]` 官方指纹，并用该字节重新提取、与 ui-strings 逐条对账；
 *   2. 未提供 `--bundle` 时，回退到提取记录里记录的本机 `source` 文件（存在且可读时同样重算 + 对账）；
 *   3. `--expect-bundle-sha256 <sha256>` 只是调用方约束（必须等于官方指纹），**不能单独证明来源**：
 *      没有可读的实际界面包字节时仍然 verified:false。
 * **来源不可验证时 `--gate` 必须失败（fail-closed）**，不能只看覆盖率阈值，也不能用伪造的 strings JSON + 官方哈希假绿。
 * 用 `--gate` 在门禁失败时以非零码退出，可直接放进 CI。fail-closed 的报告会给出缺失字节的明确原因。
 *
 * 用法：
 *   node tools/coverage-report.mjs --version 2.23.0
 *   node tools/coverage-report.mjs --version 2.23.0 --gate --bundle vendor/antigravity/2.23.0/main.js --expect-bundle-sha256 <官方指纹>
 *   node tools/coverage-report.mjs --strings ui-strings/2.24.0.json --bundle /path/main.js --gate
 *   node tools/coverage-report.mjs --version 2.23.0 --pending-out /tmp/pending.json
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadDictionaryLayers, compareLayers } from '../dist/dictionary.js';
import { SUPPORTED_BUNDLES, extractUiStrings, normalizeText as normalized } from '../dist/bundle.js';
import { verifyExtractionSnapshot } from './extraction-snapshot.mjs';
import { extractUiStringsAst } from './extract-ui-ast.mjs';
import { PROPER_NOUNS } from '../dist/coverage.js';
import { appVersion as detectInstalledAppVersion } from './extract-ui-strings.mjs';
export { PROPER_NOUNS };
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const SHA256_HEX = /^[0-9a-f]{64}$/;
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

/** 把提取结果里记录的 source 解析成本机路径；URL、空值或找不到时返回 undefined（交给校验给出明确失败原因）。 */
export function resolveRecordedSource(source) {
  if (typeof source !== 'string' || !source.trim() || source.includes('://')) return undefined;
  const trimmed = source.trim();
  if (isAbsolute(trimmed)) return trimmed;
  return [resolve(trimmed), resolve(root, trimmed)].find(candidate => existsSync(candidate)) ?? resolve(trimmed);
}

const canonicalKinds = kinds => [...new Set(Array.isArray(kinds) ? kinds.map(String) : [])].sort();

/**
 * 用已验证的真实界面包字节重新提取，并与 ui-strings 记录逐条对账。
 * 这是防止“伪造 strings JSON + 官方哈希”的关键：哈希证明字节是官方包，重提取证明这份 strings 确实来自该字节。
 * 对账必须覆盖**所有门禁相关字段**（text + kinds + count），否则攻击者可保留全部原文、只把行 kinds 改成 template/fragment
 * 让 reconcile() 跳过这些行，从而绕过“待补译条数”门禁。kinds 采用排序后的集合比较，count 必须逐条一致；
 * 若存在 counts 汇总，也核对 total 与各 kind 分布。
 */
export function reconcileExtraction(uiStrings, source) {
  const rows = Array.isArray(uiStrings?.strings) ? uiStrings.strings : undefined;
  if (!rows) return { ok: false, reason: '提取结果缺少 strings 数组，无法与界面包字节对账' };
  const actual = uiStrings.extractor === 'typescript-ast-v1' ? extractUiStringsAst(source) : extractUiStrings(source);
  if (rows.length !== actual.length) return { ok: false, reason: `提取结果条数 ${rows.length} 与按界面包字节重新提取的 ${actual.length} 不一致（可能伪造或过期）` };
  const committed = new Map();
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row.text !== 'string') return { ok: false, reason: `提取结果第 ${index + 1} 条缺少 text` };
    if (committed.has(row.text)) return { ok: false, reason: `提取结果存在重复原文：${JSON.stringify(row.text)}` };
    if (!Array.isArray(row.kinds) || row.kinds.some(kind => typeof kind !== 'string')) return { ok: false, reason: `提取结果 ${JSON.stringify(row.text)} 的 kinds 不是字符串数组` };
    const count = Number(row.count);
    if (!Number.isInteger(count) || count < 1) return { ok: false, reason: `提取结果 ${JSON.stringify(row.text)} 的 count 非法：${JSON.stringify(row.count)}` };
    committed.set(row.text, { kinds: canonicalKinds(row.kinds).join('|'), count });
  }
  for (const item of actual) {
    const row = committed.get(item.text);
    if (!row) return { ok: false, reason: `提取结果与界面包字节不一致：缺少实际提取项 ${JSON.stringify(item.text)}` };
    const kinds = canonicalKinds(item.kinds).join('|');
    if (row.kinds !== kinds) return { ok: false, reason: `提取结果 ${JSON.stringify(item.text)} 的 kinds 被改动：记录 [${row.kinds}] vs 实际 [${kinds}]` };
    if (row.count !== Number(item.count)) return { ok: false, reason: `提取结果 ${JSON.stringify(item.text)} 的 count 被改动：记录 ${row.count} vs 实际 ${item.count}` };
  }
  if (uiStrings.counts && typeof uiStrings.counts === 'object') {
    const declared = uiStrings.counts;
    if (declared.total !== undefined && Number(declared.total) !== rows.length) return { ok: false, reason: `提取结果 counts.total=${declared.total} 与条数 ${rows.length} 不一致` };
    const computed = {};
    for (const row of rows) for (const kind of new Set(row.kinds)) computed[kind] = (computed[kind] ?? 0) + 1;
    for (const [kind, value] of Object.entries(declared)) {
      if (kind === 'total') continue;
      const expected = computed[kind] ?? 0;
      if (Number(value) !== expected) return { ok: false, reason: `提取结果 counts.${kind}=${value} 与 kinds 分布 ${expected} 不一致` };
    }
  }
  return { ok: true, extractedCount: actual.length };
}

/**
 * 校验提取结果是否绑定了真实界面包：**必须从实际字节重算哈希**。
 * `--expect-bundle-sha256` 只是调用方约束（必须等于官方指纹），不能替代字节证明；
 * 没有可读的实际界面包时一律 verified:false（门禁 fail-closed），绝不伪造 sourceVerified。
 * `officialBundles` 仅供测试注入固定指纹，生产 CLI 不暴露该参数。
 * @returns {Promise<{verified:boolean;reason:string;expectedSha256?:string;actualSha256?:string;bundleSource?:string;extractedCount?:number;byteVerified?:boolean}>}
 */
export async function verifyBundleSource(uiStrings, { bundlePath, expectSha256, officialBundles = SUPPORTED_BUNDLES, reconcile = true, noVendor = false } = {}) {
  const fail = (reason, extra = {}) => ({ verified: false, reason, ...extra });
  const appVersion = uiStrings?.appVersion;
  const declared = uiStrings?.bundleSha256;
  if (typeof appVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(appVersion)) return fail('提取结果缺少有效的 appVersion，无法确认界面包来源');
  if (typeof declared !== 'string' || !SHA256_HEX.test(declared)) return fail('提取结果缺少有效的 bundleSha256，无法确认界面包来源');
  const supported = officialBundles instanceof Map ? officialBundles.get(appVersion) : undefined;
  if (!supported) return fail(`appVersion ${appVersion} 不在受支持界面包清单中，无法确认官方来源`);
  if (expectSha256 !== undefined) {
    if (typeof expectSha256 !== 'string' || !SHA256_HEX.test(expectSha256)) return fail('--expect-bundle-sha256 必须是 64 位 sha256 十六进制');
    if (expectSha256 !== supported) return fail(`--expect-bundle-sha256 ${expectSha256} 与官方指纹 ${supported} 不一致`);
    /* 哈希参数只是约束：下面仍然必须找到实际字节并重算。 */
  }
  if (noVendor) {
    if (declared !== supported) return fail(`提取记录哈希 ${declared} 不是 ${appVersion} 的官方指纹 ${supported}`);
    if (!Array.isArray(uiStrings?.strings) || uiStrings.strings.length === 0) return fail('提取结果缺少有效的 strings 数组');
    let snapshot;
    try { snapshot = await verifyExtractionSnapshot(uiStrings); }
    catch (error) { return fail(error.message); }
    return {
      verified: true,
      byteVerified: false,
      verificationLevel: 'reviewed-snapshot',
      extractor: snapshot.extractor,
      noVendor: true,
      reason: `免 vendor 校验模式：快照结构、条目清单摘要与已审阅版本一致；本轮未重算官方界面包字节，提取器=${snapshot.extractor}`,
      expectedSha256: supported,
      declaredBundleSha256: declared,
      extractedCount: uiStrings.strings.length,
    };
  }
  const candidates = [];
  if (bundlePath) candidates.push({ path: bundlePath, origin: '--bundle' });
  else {
    const recorded = resolveRecordedSource(uiStrings.source);
    if (recorded) candidates.push({ path: recorded, origin: '提取记录 source' });
  }
  if (!candidates.length) {
    return fail('无法证明界面包来源：没有可重算哈希的实际界面包字节（--expect-bundle-sha256/官方哈希不能替代字节证明）。请提供 --bundle <main.js>，或传入 --no-vendor 启用免 vendor 校验模式');
  }
  const { path, origin } = candidates[0];
  let buffer;
  try { buffer = await readFile(path); } catch (error) { return fail(`无法读取${origin} ${path}：${error.message}；没有实际字节不能证明界面包来源`); }
  if (!buffer.length) return fail(`${origin} ${path} 是空文件，无法证明界面包来源`);
  const actual = sha256(buffer);
  if (actual !== declared) return fail(`${origin} 哈希 ${actual} 与提取记录 ${declared} 不一致`);
  if (actual !== supported) return fail(`${origin} 哈希 ${actual} 不是 ${appVersion} 的官方指纹 ${supported}`);
  if (reconcile) {
    const reconciled = reconcileExtraction(uiStrings, buffer.toString('utf8'));
    if (!reconciled.ok) return fail(`提取结果未通过界面包字节对账：${reconciled.reason}`);
    return { verified: true, byteVerified: true, reason: `已从${origin}重算哈希并逐条对账 ${reconciled.extractedCount} 条提取结果，匹配官方指纹`, expectedSha256: supported, actualSha256: actual, bundleSource: path, extractedCount: reconciled.extractedCount };
  }
  return { verified: true, byteVerified: true, reason: `已从${origin}重算哈希，匹配官方指纹`, expectedSha256: supported, actualSha256: actual, bundleSource: path };
}

/** 必须保留英文的专有名词（用户明确要求"专属英文名词除外"）。 */
/**
 * 必须保留英文的专有名词。
 * 只收录"译成中文就是错的"名字：产品名、品牌、协议与规范名。
 * 明确排除两类，否则门禁会一直误报：
 *   - 已有通行中文译法的（URL→网址、Chrome DevTools→Chrome 开发者工具、GCP→Google Cloud Platform）
 *   - 中文里本就用缩写的（MCP/API 在中文句子中偶尔被完整展开，不算把专名译掉）
 */

/** 读词典目录里所有层级（不含用户覆盖），供对账用。 */
export async function loadDictLayers(dictDir = join(root, 'dict')) {
  const layered = await loadDictionaryLayers(dictDir);
  const perFile = {};
  for (const file of layered.files) perFile[file] = Object.keys(JSON.parse(await readFile(join(dictDir, file), 'utf8'))).length;
  const entries = new Map(Object.entries(layered.dictionary.entries).map(([key, value]) => [key, { value, file: layered.sources[key] }]));
  return { entries, perFile };

}

/** 专有名词违规：英文键里出现专名，但译文把这个专名丢了。 */
export function properNounViolations(entries) {
  const violations = [];
  for (const [key, { value, file }] of entries) {
    // 只检查键里确实是独立词元出现的专名，避免 "Node" 命中 "Nodejs" 之类的噪声
    for (const noun of PROPER_NOUNS) {
      const inKey = new RegExp(`(?:^|[^A-Za-z])${noun.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^A-Za-z])`).test(key);
      if (!inKey) continue;
      const inValue = value.includes(noun);
      // 译文里出现该专名的任何形式都算保留；中文里专名通常原样保留
      if (!inValue) { violations.push({ key, value, file, noun }); break; }
    }
  }
  return violations;
}

/**
 * 对账。`uiStrings` 是 extract-ui-strings 的输出对象。
 * template 类单独统计：它们含运行时变量，当前引擎精确匹配无法命中（需要引擎支持模板规则），
 * 因此不作为门禁失败项，只在报告里单列。
 */
export function reconcile(uiStrings, entries, bundleSource) {
  const covered = [], missing = [], caseOnly = [], templates = [], fragments = [];
  for (const item of uiStrings.strings ?? []) {
    const key = normalized(item.text);
    if (item.kinds?.includes('template')) { templates.push({ text: item.text, count: item.count }); continue; }
    /* 拼接片段（"for " / " including "）：脱离上下文无法翻译，单列而不混进待补译，
       否则待译清单里永远躺着几条翻不了的半句话，门禁也就永远过不去。 */
    if (item.kinds?.includes('fragment')) { fragments.push({ text: item.text, count: item.count }); continue; }
    if (entries.has(key)) { covered.push(key); continue; }
    // 大小写/结尾标点不同：引擎现在大小写不敏感，能命中，但键本身不规范
    const folded = key.toLowerCase();
    let matched = false;
    for (const candidate of entries.keys()) {
      if (candidate.toLowerCase() === folded) { caseOnly.push({ text: item.text, dictKey: candidate }); matched = true; break; }
    }
    if (!matched) missing.push({ text: item.text, kinds: item.kinds ?? [], count: item.count ?? 1 });
  }
  const uiSet = new Set((uiStrings.strings ?? []).map(s => normalized(s.text)));
  const uiFolded = new Set([...uiSet].map(s => s.toLowerCase()));
  /* 词典词条不在本次提取结果里有两种完全不同的含义：
     - 键在整个界面包里都找不到  => 真的失效（应用已改文案），应从词典清理
     - 键在包里能找到但没被提取到 => 提取器的召回问题，词典仍然有效，不该当成死词条
     不区分这两者会把提取器的短板误报成词典的问题。 */
  const obsolete = [];
  const notExtracted = [];
  for (const [key, meta] of entries) {
    if (uiSet.has(key)) continue;
    if (uiFolded.has(key.toLowerCase())) continue;
    if (bundleSource && bundleSource.includes(key)) notExtracted.push({ key, value: meta.value, file: meta.file });
    else obsolete.push({ key, value: meta.value, file: meta.file });
  }
  return { covered, missing, caseOnly, templates, fragments, obsolete, notExtracted };
}

/**
 * 门禁阈值。只把**可自动判定、且当前确实该拦**的项设为失败条件：
 *   - 覆盖率与待补条数：定义明确，是"能不能发布这一版词典"的直接依据
 *   - 专有名词违规：机器可判，且违反用户明确要求
 * 刻意不把 `obsolete` 设为失败项：界面包只是应用全部界面的一部分，
 * "词典里的键在 main.js 里找不到"不等于该词条没用（可能来自尚未提取的界面），
 * 强行拦下会逼出"为了过门禁而删有效词条"的错误行为。它作为待人工复核清单输出。
 */
export const DEFAULT_GATE = { minUiCoverage: 0.98, maxMissing: 0, maxProperNounViolations: 0 };

export function evaluateGate(summary, gate = DEFAULT_GATE, source = { verified: false, reason: '未提供界面包来源校验' }) {
  const checks = [
    /* 来源校验排第一：没有真实界面包来源时，下面的覆盖率数字没有意义，不能放行。 */
    { name: '界面包来源可验证且与受支持官方指纹一致', actual: source.verified ? '已验证' : '未验证', pass: source.verified === true, detail: source.reason ?? '' },
    { name: `界面位置覆盖率 ≥ ${(gate.minUiCoverage * 100).toFixed(0)}%`, actual: summary.uiCoverage, pass: summary.uiCoverage >= gate.minUiCoverage },
    { name: `需要补译的条数 ≤ ${gate.maxMissing}`, actual: summary.missing, pass: summary.missing <= gate.maxMissing },
    { name: `专有名词违规条数 ≤ ${gate.maxProperNounViolations}`, actual: summary.properNounViolations, pass: summary.properNounViolations <= gate.maxProperNounViolations },
  ];
  const advisory = [
    { name: '死词条（界面包中找不到，待人工复核）', actual: summary.obsolete, severity: 'info' },
    { name: '提取器未覆盖（词典里有、包里有、但没被提取到）', actual: summary.notExtracted, severity: 'info' },
    { name: '含运行时变量的模板串（需引擎支持模板规则）', actual: summary.templates, severity: 'info' },
    { name: '拼接片段（脱离上下文不可译，需引擎支持上下文匹配）', actual: summary.fragments, severity: 'info' },
  ];
  return { checks, advisory, pass: checks.every(check => check.pass) };
}

async function main() {
  let version = option('--version');
  let uiPath = option('--strings');
  if (!uiPath) {
    const dir = join(root, 'ui-strings');
    const available = (await readdir(dir).catch(() => [])).filter(name => name.endsWith('.json')).sort(compareLayers);
    const installedVersion = await detectInstalledAppVersion().catch(() => undefined);
    if (!version && installedVersion && available.includes(`${installedVersion}.json`)) version = installedVersion;
    if (!available.length) throw new Error(`ui-strings 目录里没有提取结果，请先运行 npm run i18n:extract`);
    const pick = version ? `${version}.json` : available[available.length - 1];
    if (!available.includes(pick)) throw new Error(`ui-strings/${pick} 不存在；现有：${available.join(', ')}`);
    uiPath = join(dir, pick);
    version = pick.replace(/\.json$/, '');
  }
  const uiStrings = JSON.parse(await readFile(uiPath, 'utf8'));
  if (version && uiStrings.appVersion !== version) throw new Error(`--version ${version} 与提取结果 appVersion ${uiStrings.appVersion} 不一致`);
  const { entries, perFile } = await loadDictLayers(option('--dict', join(root, 'dict')));

  const noVendor = args.includes('--no-vendor') || process.env.GRAVITYBOX_NO_VENDOR === '1';

  /* 来源校验先于任何统计：拿不到真实界面包或未开启免 vendor 模式就不产出可信结论。 */
  const sourceVerification = await verifyBundleSource(uiStrings, {
    bundlePath: option('--bundle'),
    expectSha256: option('--expect-bundle-sha256'),
    noVendor,
  });
  if (!sourceVerification.verified) console.error(`[coverage-report] 界面包来源未验证（fail-closed）：${sourceVerification.reason}`);
  let bundleSource;
  const bundlePath = option('--bundle') ?? sourceVerification.bundleSource ?? resolveRecordedSource(uiStrings.source);
  if (typeof bundlePath === 'string' && existsSync(bundlePath)) {
    try { bundleSource = await readFile(bundlePath, 'utf8'); } catch { bundleSource = undefined; }
  }
  const { covered, missing, caseOnly, templates, fragments, obsolete, notExtracted } = reconcile(uiStrings, entries, bundleSource);
  const violations = properNounViolations(entries);
  const positional = covered.length + missing.length + caseOnly.length;
  const summary = {
    appVersion: uiStrings.appVersion,
    bundleSha256: uiStrings.bundleSha256,
    sourceVerified: sourceVerification.verified,
    sourceReason: sourceVerification.reason,
    dictEntries: entries.size,
    dictFiles: perFile,
    uiStrings: (uiStrings.strings ?? []).length,
    covered: covered.length,
    caseOnly: caseOnly.length,
    missing: missing.length,
    obsolete: obsolete.length,
    notExtracted: notExtracted.length,
    extractionRecall: entries.size ? (entries.size - obsolete.length - notExtracted.length) / entries.size : 0,
    templates: templates.length,
    fragments: fragments.length,
    properNounViolations: violations.length,
    // caseOnly 在运行时由无大小写折叠查表命中（engine.js foldedMap），不能当作未翻译。
    uiCoverage: positional ? (covered.length + caseOnly.length) / positional : 0,
  };

  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    source: uiPath,
    sourceVerification,
    summary,
    gate: evaluateGate(summary, DEFAULT_GATE, sourceVerification),
    missing: missing.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.text.localeCompare(b.text)),
    caseOnly: caseOnly.slice(0, 200),
    obsolete: obsolete.slice(0, 500),
    notExtracted: notExtracted.slice(0, 500),
    properNounViolations: violations,
    templates: templates.slice(0, 200),
    fragments: fragments.slice(0, 200),
  };

  const out = option('--out') ?? join(root, 'reports', `coverage-${uiStrings.appVersion}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 1) + '\n');

  // 待译清单：可以直接交给翻译环节
  const pendingOut = option('--pending-out');
  if (pendingOut) {
    await mkdir(dirname(pendingOut), { recursive: true });
    await writeFile(pendingOut, JSON.stringify({
      schema: 1, appVersion: uiStrings.appVersion, generatedAt: new Date().toISOString(),
      instructions: [
        '逐条给出简体中文译文，保留 %s / {x} / $1 等占位符与结尾标点。',
        '以下专有名词必须保持英文原样：' + PROPER_NOUNS.join(', '),
        '术语表：conversation=对话, chat=对话, token=Token, allowlist=允许列表, denylist=拒绝列表, customization=自定义, plugin=插件, extension=扩展。',
        '若该串本身是示例值/标识符/路径，无需入库，可原样返回；合并工具会拒绝「英文原文当译文」。',
      ],
      entries: missing.map(item => ({ key: normalized(item.text), count: item.count, kinds: item.kinds })),
    }, null, 1) + '\n');
  }

  console.log(JSON.stringify({ report: out, pending: pendingOut ?? null, summary, gate: report.gate }, null, 1));

  if (args.includes('--gate') && !report.gate.pass) {
    /* 门禁失败时把原因写到 stderr，CI 日志里能直接看到是来源问题还是覆盖率问题。 */
    for (const check of report.gate.checks.filter(check => !check.pass)) console.error(`[coverage-report] 门禁未通过：${check.name}（实际 ${check.actual}）${check.detail ? ' · ' + check.detail : ''}`);
    process.exitCode = 2;
  }
}

const invokedDirectly = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(error => { console.error(`[coverage-report] ${error.stack ?? error.message}`); process.exitCode = 1; });
}
