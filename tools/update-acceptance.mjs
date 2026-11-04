import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileSha256 } from './release-integrity.mjs';

/**
 * 验收摘要生成/更新工具。
 * 数据来源（全部只读）：.cache/verified-release.json、质检报告/<version>-改造验收/*.log、
 * 成品/<version>-arm64.dmg 实际 sha256、已安装/暂存 build-info、codesign 签名状态、现有摘要。
 * 只写 `文档/当前版本验收摘要.json`（或用 --out 指定），绝不触碰词典/账号/成品等用户数据。
 * `--dry-run` 只打印差异，不落盘。
 */
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);

const pad = (value, width = 2) => String(value).padStart(width, '0');
export function isoLocal(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function readText(path) { try { return await readFile(path, 'utf8'); } catch { return null; } }
export async function countFiles(dir) {
  let total = 0;
  async function walk(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) { if (entry.isDirectory()) await walk(join(current, entry.name)); else if (entry.isFile()) total += 1; }
  }
  await walk(dir);
  return total;
}

/** 解析 node --test TAP 输出里的计数（单元与集成.log）。 */
export function parseTestCounts(text) {
  const number = (label) => { const match = new RegExp(`^# ${label} (\\d+)$`, 'm').exec(text); return match ? Number(match[1]) : null; };
  const planned = /^1\.\.(\d+)$/m.exec(text);
  const duration = /^# duration_ms ([\d.]+)$/m.exec(text);
  return {
    tests: number('tests') ?? (planned ? Number(planned[1]) : null),
    pass: number('pass'),
    fail: number('fail'),
    cancelled: number('cancelled'),
    skipped: number('skipped'),
    durationMs: duration ? Number(duration[1]) : null,
  };
}

/** 解析浏览器回归日志：优先读末尾 {"passed":N,…}，否则数 PASS 行。 */
export function parseBrowserLog(text) {
  const jsonMatches = [...text.matchAll(/\{"passed":\s*(\d+)/g)];
  const last = jsonMatches.at(-1);
  return {
    passed: last ? Number(last[1]) : (text.match(/^PASS /gm) ?? []).length,
    failed: (text.match(/^FAIL /gm) ?? []).length,
  };
}

/** 解析词典门禁日志里的最终 pass 字段。 */
export function parseGateLog(text) {
  const matches = [...text.matchAll(/"pass":\s*(true|false)/g)];
  const last = matches.at(-1);
  return { pass: last ? last[1] === 'true' : null };
}

export function parseCodesignIdentity(text) {
  const identity = [];
  const cdhash = /CDHash=([0-9a-f]+)/i.exec(text);
  const team = /TeamIdentifier=(.+)/.exec(text);
  if (cdhash) identity.push(`CDHash=${cdhash[1]}`);
  identity.push(`TeamIdentifier=${team ? team[1].trim() : 'not set'}`);
  return identity;
}

/** codesign 只读探测：严格校验结果 + CDHash/TeamIdentifier。 */
export async function probeSignature(appPath, runner = run) {
  if (!appPath || !existsSync(appPath)) return { available: false, strictVerified: false, identity: [] };
  let identity = [];
  try {
    const { stderr } = await runner('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], { maxBuffer: 2e6 });
    identity = parseCodesignIdentity(stderr);
  } catch (error) {
    identity = parseCodesignIdentity(String(error?.stderr ?? ''));
  }
  let strictVerified = false;
  try { await runner('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', appPath], { maxBuffer: 2e6 }); strictVerified = true; } catch { strictVerified = false; }
  return { available: true, strictVerified, identity };
}

function omitNulls(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined));
}

/** 采集验收事实（只读）；任何缺失都记录到 warnings，不抛错。 */
export async function collectAcceptance({
  root = repoRoot,
  installedApp = '/Applications/GravityBox.app',
  stagingApp = join(root, 'build/dmg-stage/GravityBox.app'),
  now = new Date(),
  signatureProbe = probeSignature,
} = {}) {
  const warnings = [];
  const pkg = await readJson(join(root, 'package.json'));
  const version = pkg?.version ?? '0.0.0';
  if (!pkg) warnings.push('缺少 package.json，无法确定版本号');
  const verified = await readJson(join(root, '.cache/verified-release.json'));
  if (!verified) warnings.push('缺少 .cache/verified-release.json：请先运行 npm run verify');
  const installedInfo = await readJson(join(installedApp, 'Contents/Resources/build-info.json'));
  const stagingInfo = await readJson(join(stagingApp, 'Contents/Resources/build-info.json'));
  const digest = verified?.digest ?? installedInfo?.sourceDigest ?? null;

  const reportDir = join(root, '质检报告', `${version}-改造验收`);
  const unitText = await readText(join(reportDir, '单元与集成.log'));
  const unit = unitText === null ? null : parseTestCounts(unitText);
  if (unit === null) warnings.push(`缺少 质检报告/${version}-改造验收/单元与集成.log`);
  const browserText = await readText(join(reportDir, '浏览器回归.log'));
  const browser = browserText === null ? null : parseBrowserLog(browserText);
  if (browser === null) warnings.push(`缺少 质检报告/${version}-改造验收/浏览器回归.log`);
  const gateNames = existsSync(reportDir) ? (await readdir(reportDir)).filter(name => /^词典门禁-.+\.log$/.test(name)).sort() : [];
  const gates = [];
  for (const name of gateNames) {
    const ledgerVersion = name.replace(/^词典门禁-/, '').replace(/\.log$/, '');
    const parsed = parseGateLog((await readText(join(reportDir, name))) ?? '');
    gates.push({ version: ledgerVersion, pass: parsed.pass });
  }

  const dmg = join(root, '成品', `GravityBox-${version}-arm64.dmg`);
  let dmgSHA256 = null;
  if (existsSync(dmg)) dmgSHA256 = await fileSha256(dmg);
  else warnings.push(`缺少成品 DMG：成品/GravityBox-${version}-arm64.dmg`);

  let installedFilesVerified = null;
  if (existsSync(installedApp)) installedFilesVerified = await countFiles(installedApp);
  else warnings.push(`未找到已安装应用：${installedApp}`);

  const signatures = { GravityBox: await signatureProbe(installedApp), Antigravity: await signatureProbe('/Applications/Antigravity.app') };

  return {
    at: isoLocal(now),
    version,
    verifiedAt: verified?.at ?? null,
    digest,
    dmg,
    dmgSHA256,
    installed: installedApp,
    installedFilesVerified,
    automated: {
      unitIntegrationPassed: unit?.tests ?? null,
      unitIntegrationFailed: unit?.fail ?? null,
      browserPassed: browser?.passed ?? null,
      dictionaryGates: gates.filter(gate => gate.pass === true).map(gate => gate.version),
      dictionaryGateFailed: gates.filter(gate => gate.pass !== true).map(gate => gate.version),
    },
    signatures,
    buildInfo: { installed: installedInfo, staging: stagingInfo },
    warnings,
  };
}

/** 以现有摘要为底，覆盖可自动验证的字段；liveAcceptance/preservation/rollback 等人工证据原样保留。 */
export function buildSummary(existing, collected) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const automated = { ...(base.automated ?? {}), ...omitNulls(collected.automated) };
  return {
    ...base,
    at: collected.at,
    version: collected.version,
    revision: collected.digest ? collected.digest.slice(0, 8) : null,
    sourceDigest: collected.digest,
    verifiedAt: collected.verifiedAt,
    dmg: collected.dmg,
    dmgSHA256: collected.dmgSHA256,
    installed: collected.installed,
    installedFilesVerified: collected.installedFilesVerified,
    automated,
    signatures: { ...(base.signatures ?? {}), ...collected.signatures },
    buildInfo: collected.buildInfo,
  };
}

/** 递归 diff（叶子比较；对象缺失记为 (不存在)），返回 [{path, from, to}]。 */
export function diffObjects(before, after, prefix = '') {
  const changes = [];
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of [...keys].sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const left = before?.[key], right = after?.[key];
    if (isObject(left) && isObject(right)) changes.push(...diffObjects(left, right, path));
    else if (isObject(left) !== isObject(right)) changes.push({ path, from: left, to: right });
    else if (JSON.stringify(left) !== JSON.stringify(right)) changes.push({ path, from: left, to: right });
  }
  return changes;
}

function formatValue(value) {
  if (value === undefined) return '(不存在)';
  const text = JSON.stringify(value);
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

export function formatDiff(changes) {
  return changes.map(change => `~ ${change.path}: ${formatValue(change.from)} => ${formatValue(change.to)}`);
}

/** 生成并（非 dry-run 时）原子写入摘要。 */
export async function updateAcceptance({ root = repoRoot, out = join(root, '文档/当前版本验收摘要.json'), dryRun = false, now = new Date(), signatureProbe = probeSignature, installedApp, stagingApp } = {}) {
  const existing = await readJson(out);
  const collected = await collectAcceptance({ root, now, signatureProbe, ...(installedApp ? { installedApp } : {}), ...(stagingApp ? { stagingApp } : {}) });
  const summary = buildSummary(existing, collected);
  const changes = diffObjects(existing ?? {}, summary);
  if (!dryRun) {
    await mkdir(dirname(out), { recursive: true });
    const temp = `${out}.tmp`;
    await writeFile(temp, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await rename(temp, out);
  }
  return { written: !dryRun, out, summary, diff: changes, warnings: collected.warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const root = resolve(option('--root') ?? repoRoot);
  const out = resolve(option('--out') ?? join(root, '文档/当前版本验收摘要.json'));
  const dryRun = args.includes('--dry-run');
  const result = await updateAcceptance({ root, out, dryRun });
  for (const warning of result.warnings) process.stderr.write(`警告：${warning}\n`);
  if (dryRun) {
    if (!result.diff.length) process.stdout.write('验收摘要与产物一致，无需更新\n');
    else {
      process.stdout.write(`将更新 ${out}（${result.diff.length} 处差异，dry-run 未写盘）\n`);
      for (const line of formatDiff(result.diff)) process.stdout.write(`${line}\n`);
    }
  } else {
    process.stdout.write(`已写入 ${out}（${result.diff.length} 处更新）\n`);
    for (const line of formatDiff(result.diff)) process.stdout.write(`${line}\n`);
  }
}
