#!/usr/bin/env node
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isEnglishSource, isFragmentLiteral, CODE_ONLY_WORDS, fetchBuffer, computeBundleSha256 } from '../dist/bundle.js';
import { discover, allowedTarget, verifyPageService } from '../dist/discovery.js';
import { compareVersions } from './release-scope.mjs';
import { extractUiStringsAst as extractUiStrings } from './extract-ui-ast.mjs';
import { snapshotDigest } from './extraction-snapshot.mjs';
export { isEnglishSource, isFragmentLiteral, CODE_ONLY_WORDS };
const root = fileURLToPath(new URL('../', import.meta.url)), args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const APP = option('--app', '/Applications/Antigravity.app'), PROFILE = option('--profile', join(homedir(), 'Library/Application Support/Antigravity'));
const MAX_BUNDLE_BYTES = 20_000_000; // 与 fetchBuffer 的下载上限一致
export async function appVersion(app = APP) { try { return (await promisify(execFile)('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')])).stdout.trim(); } catch { return undefined; } }

/**
 * 把界面包字节解码为 UTF-8 文本；缺失/空/非 UTF-8 都必须明确失败，不能静默替换成 U+FFFD 后继续产出提取结果。
 * 失败时抛出的错误信息会直接出现在 CLI stderr 上，方便 CI 判断是文件问题还是版本问题。
 */
export function decodeBundle(buffer, label = '界面包') {
  if (!buffer?.length) throw new Error(`${label} 为空，无法提取界面串`);
  if (buffer.length > MAX_BUNDLE_BYTES) throw new Error(`${label} 超过 ${MAX_BUNDLE_BYTES} 字节上限，拒绝提取`);
  if (buffer.includes(0)) throw new Error(`${label} 含 NUL 字节，不是 UTF-8 文本界面包`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error(`${label} 不是有效 UTF-8 文本，拒绝提取（避免产出带替换字符的假提取结果）`); }
}

/** 读取 --bundle 指定的本机界面包：路径必须存在且是普通文件，返回绝对路径与严格解码后的文本。 */
export async function readBundleFile(bundlePath) {
  const absolute = resolve(bundlePath);
  let info;
  try { info = await stat(absolute); } catch (error) { throw new Error(`无法读取 --bundle ${absolute}：${error.code === 'ENOENT' ? '文件不存在' : error.message}`); }
  if (!info.isFile()) throw new Error(`--bundle ${absolute} 不是普通文件`);
  const buffer = await readFile(absolute);
  return { source: absolute, text: decodeBundle(buffer, `--bundle ${absolute}`) };
}

/**
 * 将已确认官方身份的新版本界面包指纹自动登记到 src/bundle.ts 的 SUPPORTED_BUNDLES 中。
 * 这样当本机 Antigravity 升级到 2.29.x 或更高版本时，提取后即可无缝纳入覆盖率门禁与全量测试。
 */
export async function registerSupportedBundle(version, bundleSha256, projectRoot = root) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  if (typeof bundleSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(bundleSha256)) return false;
  const bundleTsPath = join(projectRoot, 'src', 'bundle.ts');
  let content;
  try { content = await readFile(bundleTsPath, 'utf8'); } catch { return false; }
  const mapRegex = /export const SUPPORTED_BUNDLES = new Map\(\[([\s\S]*?)\]\);/;
  const match = content.match(mapRegex);
  if (!match) return false;
  const entries = new Map();
  for (const row of match[1].matchAll(/\['([^']+)',\s*'([0-9a-f]{64})'\]/g)) {
    entries.set(row[1], row[2]);
  }
  if (entries.get(version) === bundleSha256) return false;
  entries.set(version, bundleSha256);
  const sorted = [...entries.entries()].sort(([a], [b]) => compareVersions(a, b));
  const formatted = sorted.map(([ver, sha]) => `  ['${ver}', '${sha}'],`).join('\n');
  const updated = content.replace(mapRegex, `export const SUPPORTED_BUNDLES = new Map([\n${formatted}\n]);`);
  await writeFile(bundleTsPath, updated, 'utf8');
  return true;
}

export async function registerExtractionSnapshot(value, projectRoot = root) {
  const file = join(projectRoot, 'assets', 'ui-extraction-manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.versions[value.appVersion] = { bundleSha256: value.bundleSha256, snapshotSha256: snapshotDigest(value),
    extractor: value.extractor, trust: 'explicit-byte-extraction', byteVerifiedAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
}

/**
 * 从当前运行中的官方 Antigravity 实例自动提取最新版本的界面串并落盘 ui-strings/<version>.json。
 */
export async function extractFromRunningApp({ app = APP, profile = PROFILE, base, outPath, registerBundle = false, projectRoot = root } = {}) {
  const version = await appVersion(app);
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('无法读取本机 Antigravity 版本号');
  const endpoint = await discover(app, profile);
  if (!endpoint || endpoint.appVersion !== version) throw new Error(`Antigravity (${version}) 未运行或调试端口未就绪`);
  const targets = await (await fetch(`http://127.0.0.1:${endpoint.port}/json/list`, { signal: AbortSignal.timeout(3000), redirect: 'error' })).json();
  const target = targets.find(t => allowedTarget(t));
  const origin = base ?? (target && new URL(target.url).origin);
  if (!origin || !await verifyPageService(origin + '/', app)) throw new Error('本机界面服务身份未确认');
  const source = decodeBundle(await fetchBuffer(origin + '/main.js'), '本机界面包 main.js');
  const bundleRelative = join('vendor', 'antigravity', version, 'main.js');
  const bundleFile = join(projectRoot, bundleRelative);
  await mkdir(dirname(bundleFile), { recursive: true });
  await writeFile(bundleFile, source);
  const strings = extractUiStrings(source), byKind = {};
  for (const entry of strings) for (const kind of entry.kinds) byKind[kind] = (byKind[kind] ?? 0) + 1;
  const bundleSha256 = computeBundleSha256(source);
  const value = {
    schema: 1, extractor: 'typescript-ast-v1',
    appVersion: version,
    source: bundleRelative,
    bundleSha256,
    bundleBytes: Buffer.byteLength(source),
    extractedAt: new Date().toISOString(),
    counts: { total: strings.length, ...byKind },
    strings,
  };
  const out = outPath ?? join(projectRoot, 'ui-strings', `${version}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(value, null, 1) + '\n');
  const registered = registerBundle ? await registerSupportedBundle(version, bundleSha256, projectRoot) : false;
  if (registerBundle) await registerExtractionSnapshot(value, projectRoot);
  return { out, count: strings.length, appVersion: version, bundleSha256, registered, value };
}

async function main() {
  const version = option('--version') ?? await appVersion();
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('请明确指定目标应用版本');
  const bundle = option('--bundle');
  let source, sourceName;
  if (bundle) {
    /* 记录 source 用绝对路径：后续 coverage-report 的来源校验会按这个路径重算哈希。 */
    const loaded = await readBundleFile(bundle); source = loaded.text; sourceName = loaded.source;
  } else {
    const endpoint = await discover(APP, PROFILE);
    if (!endpoint || endpoint.appVersion !== version) throw new Error('应用未运行或版本不匹配；离线重跑请指定 --bundle');
    const targets = await (await fetch(`http://127.0.0.1:${endpoint.port}/json/list`, { signal: AbortSignal.timeout(3000), redirect: 'error' })).json();
    const target = targets.find(t => allowedTarget(t));
    const origin = option('--base') ?? (target && new URL(target.url).origin);
    if (!origin || !await verifyPageService(origin + '/', APP)) throw new Error('本机界面服务身份未确认');
    source = decodeBundle(await fetchBuffer(origin + '/main.js'), '本机界面包 main.js');
    /* 记录可重算的来源：来源路径（相对 root）而不是 loopback URL，coverage-report 可据此重算字节哈希。 */
    const bundleRelative = join('vendor', 'antigravity', version, 'main.js');
    const bundleFile = join(root, bundleRelative); await mkdir(dirname(bundleFile), { recursive: true }); await writeFile(bundleFile, source);
    sourceName = bundleRelative;
  }
  const strings = extractUiStrings(source), byKind = {};
  for (const entry of strings) for (const kind of entry.kinds) byKind[kind] = (byKind[kind] ?? 0) + 1;
  const bundleSha256 = computeBundleSha256(source);
  /* schema 保持不变；只保证 source 对 --bundle 路径是可回溯的绝对路径。 */
  const value = { schema: 1, extractor: 'typescript-ast-v1', appVersion: version, source: sourceName, bundleSha256, bundleBytes: Buffer.byteLength(source), extractedAt: new Date().toISOString(), counts: { total: strings.length, ...byKind }, strings };
  if (args.includes('--stdout')) { process.stdout.write(JSON.stringify(value, null, 1) + '\n'); return; }
  const out = option('--out', join(root, 'ui-strings', `${version}.json`)); await mkdir(dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(value, null, 1) + '\n');
  const shouldRegister = args.includes('--register-bundle');
  const registered = shouldRegister ? await registerSupportedBundle(version, bundleSha256, root) : false;
  if (shouldRegister) await registerExtractionSnapshot(value, root);
  console.log(JSON.stringify({ out, count: strings.length, appVersion: version, ...(registered ? { registeredInBundleTs: true } : {}) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
