import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { fileSha256, sourceDigest } from './release-integrity.mjs';
import { parseTestCounts, parseBrowserLog, parseGateLog, countFiles } from './update-acceptance.mjs';

/**
 * 文档一致性检查（只读，供最终发版前运行）：
 * 对比 文档/当前版本验收摘要.json、AGENTS.md、README.md 中的
 * revision / sourceDigest / 测试数 / DMG 路径与哈希 / 账号示例，与当前产物（.cache/verified-release.json、
 * 质检报告日志、成品/*.dmg、已安装 build-info、accounts.json 当前账号）是否一致。
 * 有差异时 exit 1，无差异 exit 0。
 */
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

async function readText(path) { try { return await readFile(path, 'utf8'); } catch { return null; } }
async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
const shorten = (value) => { const text = String(value); return text.length > 22 ? `${text.slice(0, 18)}…` : text; };

export function lastClaim(text, regex) {
  let last = null;
  for (const match of text.matchAll(regex)) last = match;
  if (!last) return null;
  const line = text.slice(0, last.index).split('\n').length;
  return { text: last[0], groups: last.slice(1), index: last.index, line };
}

/** 采集文档检查所需的“当前事实”（只读）。 */
export async function collectDocFacts({
  root = repoRoot,
  installedApp = '/Applications/GravityBox.app',
  accountsPath = join(homedir(), 'Library', 'Application Support', 'GravityBox', 'accounts.json'),
} = {}) {
  const pkg = await readJson(join(root, 'package.json'));
  const version = pkg?.version ?? null;
  const verified = await readJson(join(root, '.cache/verified-release.json'));
  const buildInfo = await readJson(join(installedApp, 'Contents/Resources/build-info.json'));
  const digest = await sourceDigest(root).catch(() => null);
  const verifiedDigest = verified?.digest ?? null;
  const reportDir = version ? join(root, '质检报告', `${version}-改造验收`) : null;
  const unitText = reportDir ? await readText(join(reportDir, '单元与集成.log')) : null;
  const browserText = reportDir ? await readText(join(reportDir, '浏览器回归.log')) : null;
  const unit = unitText === null ? null : parseTestCounts(unitText);
  const browser = browserText === null ? null : parseBrowserLog(browserText);
  const gates = [];
  if (reportDir && existsSync(reportDir)) {
    const { readdir } = await import('node:fs/promises');
    for (const name of (await readdir(reportDir)).filter(entry => /^词典门禁-.+\.log$/.test(entry)).sort()) {
      const parsed = parseGateLog((await readText(join(reportDir, name))) ?? '');
      gates.push({ version: name.replace(/^词典门禁-/, '').replace(/\.log$/, ''), pass: parsed.pass });
    }
  }
  const dmg = version ? join(root, '成品', `GravityBox-${version}-arm64.dmg`) : null;
  const dmgSHA256 = dmg && existsSync(dmg) ? await fileSha256(dmg) : null;
  const installedFiles = existsSync(installedApp) ? await countFiles(installedApp) : null;
  const accountsIndex = await readJson(accountsPath);
  const currentAccount = accountsIndex?.accounts?.find(account => account.id === accountsIndex.current_account_id) ?? accountsIndex?.accounts?.[0] ?? null;
  const accountEmails = (accountsIndex?.accounts ?? []).map(account => account.email).filter(Boolean);
  return {
    version, digest, verifiedDigest, installedApp, dmg, dmgSHA256, installedFiles,
    unit, browser, gates,
    currentAccountEmail: currentAccount?.email ?? null,
    accountEmails,
  };
}

export async function checkDocs({
  root = repoRoot,
  summaryPath = join(root, '文档', '当前版本验收摘要.json'),
  agentsPath = join(root, 'AGENTS.md'),
  readmePath = join(root, 'README.md'),
  installedApp = '/Applications/GravityBox.app',
  accountsPath = join(homedir(), 'Library', 'Application Support', 'GravityBox', 'accounts.json'),
  facts: injectedFacts,
} = {}) {
  const facts = injectedFacts ?? await collectDocFacts({ root, installedApp, accountsPath });
  const issues = [];
  let checked = 0;
  const add = (level, code, file, line, message) => { issues.push({ level, code, file, line, message }); };
  const verify = (level, code, file, line, message, condition) => { checked += 1; if (!condition) add(level, code, file, line, message); };

  if (!facts.digest) add('error','SOURCE_UNAVAILABLE','源码',null,'当前源码不完整，无法计算摘要，不得继承历史验收');
  if (facts.digest && facts.verifiedDigest) verify('error', 'SOURCE_NOT_VERIFIED', '源码', null, '当前源码与验证记录不同，不能继承历史验收', facts.digest === facts.verifiedDigest);
  // ---------- 1) 文档/当前版本验收摘要.json ----------
  const summaryFile = '文档/当前版本验收摘要.json';
  const summary = await readJson(summaryPath);
  if (!summary) add('error', 'SUMMARY_MISSING', summaryFile, null, '缺少验收摘要文件');
  else {
    if (facts.version) verify('error', 'SUMMARY_VERSION_MISMATCH', summaryFile, null, `version ${shorten(summary.version)} ≠ 实际 ${facts.version}`, summary.version === facts.version);
    if (facts.digest && summary.sourceDigest) verify('error', 'SUMMARY_SOURCE_STALE', summaryFile, null, `sourceDigest ${shorten(summary.sourceDigest)} ≠ 当前 ${shorten(facts.digest)}`, summary.sourceDigest === facts.digest);
    if (facts.digest && summary.revision) verify('error', 'SUMMARY_REVISION_STALE', summaryFile, null, `revision ${shorten(summary.revision)} ≠ 当前 ${facts.digest.slice(0, 8)}`, summary.revision === facts.digest.slice(0, 8));
    if (summary.dmg) verify('error', 'SUMMARY_DMG_PATH_MISSING', summaryFile, null, `摘要 DMG 路径不存在：${summary.dmg}`, existsSync(summary.dmg));
    const hashTarget = summary.dmg && existsSync(summary.dmg) ? summary.dmg : facts.dmg;
    if (hashTarget && existsSync(hashTarget) && summary.dmgSHA256) {
      const actual = await fileSha256(hashTarget);
      verify('error', 'SUMMARY_DMG_MISMATCH', summaryFile, null, `dmgSHA256 ${shorten(summary.dmgSHA256)} ≠ 实际 ${shorten(actual)}`, summary.dmgSHA256.toLowerCase() === actual);
    }
    if (facts.installedFiles !== null && typeof summary.installedFilesVerified === 'number') verify('error', 'SUMMARY_INSTALLED_FILES_MISMATCH', summaryFile, null, `installedFilesVerified ${summary.installedFilesVerified} ≠ 实机 ${facts.installedFiles}`, summary.installedFilesVerified === facts.installedFiles);
    if (facts.unit?.tests != null && summary.automated?.unitIntegrationPassed != null) verify('error', 'SUMMARY_UNIT_COUNT_MISMATCH', summaryFile, null, `automated.unitIntegrationPassed ${summary.automated.unitIntegrationPassed} ≠ 日志 ${facts.unit.tests}`, summary.automated.unitIntegrationPassed === facts.unit.tests);
    if (facts.browser?.passed != null && summary.automated?.browserPassed != null) verify('error', 'SUMMARY_BROWSER_COUNT_MISMATCH', summaryFile, null, `automated.browserPassed ${summary.automated.browserPassed} ≠ 日志 ${facts.browser.passed}`, summary.automated.browserPassed === facts.browser.passed);
    if (Array.isArray(summary.automated?.dictionaryGates) && facts.gates.length) {
      const actual = facts.gates.filter(gate => gate.pass === true).map(gate => gate.version).sort().join(',');
      const claimed = [...summary.automated.dictionaryGates].sort().join(',');
      verify('error', 'SUMMARY_DICTIONARY_GATES_MISMATCH', summaryFile, null, `dictionaryGates [${claimed}] ≠ 门禁日志 [${actual}]`, claimed === actual);
    }
  }

  // ---------- 2) AGENTS.md / 3) README.md 的“最近一次声明” ----------
  const checkDocFile = async (file, path) => {
    const text = await readText(path);
    if (text === null) { add('error', 'DOC_MISSING', file, null, '缺少文档文件'); return; }
    // DMG 路径：所有出现过的成品 DMG 都必须存在
    for (const match of text.matchAll(/成品\/(GravityBox-[0-9]+\.[0-9]+\.[0-9]+-arm64\.dmg)/g)) {
      const name = match[1];
      const line = text.slice(0, match.index).split('\n').length;
      verify('error', 'DOC_DMG_PATH_MISSING', file, line, `文档引用的成品 DMG 不存在：成品/${name}`, existsSync(join(root, '成品', name)));
    }
    // 版本号
    const versionClaim = lastClaim(text, /#\s*GravityBox\s+(\d+\.\d+\.\d+)/g) ?? lastClaim(text, /GravityBox\s+(\d+\.\d+\.\d+)\s*$/gm);
    if (versionClaim && facts.version) verify('error', 'DOC_VERSION_MISMATCH', file, versionClaim.line, `版本 ${versionClaim.groups[0]} ≠ 实际 ${facts.version}`, versionClaim.groups[0] === facts.version);
    // 测试数（只看最近一次声明，兼容历史段落）
    const unitClaim = lastClaim(text, /(\d+)\/(\d+)\s*单元与集成/g);
    if (unitClaim && facts.unit?.tests != null) {
      const claimed = Number(unitClaim.groups[0]);
      verify('error', 'DOC_UNIT_COUNT_STALE', file, unitClaim.line, `最近声明 ${unitClaim.text.trim()} ≠ 日志 ${facts.unit.tests}`, claimed === facts.unit.tests && Number(unitClaim.groups[1]) === facts.unit.tests);
    }
    const browserClaim = lastClaim(text, /(\d+)\/(\d+)\s*(?:独立)?浏览器/g);
    if (browserClaim && facts.browser?.passed != null) {
      const claimed = Number(browserClaim.groups[0]);
      verify('error', 'DOC_BROWSER_COUNT_STALE', file, browserClaim.line, `最近声明 ${browserClaim.text.trim()} ≠ 日志 ${facts.browser.passed}`, claimed === facts.browser.passed && Number(browserClaim.groups[1]) === facts.browser.passed);
    }
    // revision / sourceDigest 声明
    const digestClaim = lastClaim(text, /(?:sourceDigest|源码摘要)[^\n]{0,40}?\b([0-9a-f]{8,64})\b/gi);
    if (digestClaim && facts.digest) verify('error', 'DOC_SOURCE_STALE', file, digestClaim.line, `sourceDigest ${shorten(digestClaim.groups[0])} ≠ 当前 ${shorten(facts.digest)}`, facts.digest.startsWith(digestClaim.groups[0]) || digestClaim.groups[0].startsWith(facts.digest));
    const revisionClaim = lastClaim(text, /revision[^\n]{0,30}?\b([0-9a-f]{8,64})\b/gi);
    if (revisionClaim && facts.digest) verify('error', 'DOC_REVISION_STALE', file, revisionClaim.line, `revision ${shorten(revisionClaim.groups[0])} ≠ 当前 ${facts.digest.slice(0, 8)}`, facts.digest.startsWith(revisionClaim.groups[0]) || revisionClaim.groups[0].startsWith(facts.digest.slice(0, 8)));
    // 账号示例：最近一次提到的邮箱必须与当前激活账号一致（号池存在性另行提示）
    const emailClaim = lastClaim(text, /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/g);
    if (emailClaim) {
      const claimedEmail = emailClaim.text.toLowerCase();
      if (facts.currentAccountEmail) verify('error', 'DOC_ACCOUNT_STALE', file, emailClaim.line, `账号示例 ${emailClaim.text} ≠ 当前账号 ${facts.currentAccountEmail}${facts.accountEmails.length ? `（号池：${facts.accountEmails.join('、')}）` : ''}`, claimedEmail === facts.currentAccountEmail.toLowerCase());
      else if (facts.accountEmails.length) add('warning', 'DOC_ACCOUNT_UNVERIFIED', file, emailClaim.line, `无法确认当前账号，账号示例 ${emailClaim.text} 未比对`);
    }
  };

  await checkDocFile('AGENTS.md', agentsPath);
  await checkDocFile('README.md', readmePath);

  const errors = issues.filter(issue => issue.level === 'error').length;
  return { ok: errors === 0, issues, checked, errorCount: errors, warningCount: issues.length - errors, facts };
}

export function formatIssues(issues) {
  return issues.map(issue => `${issue.level === 'error' ? '[错误]' : '[提示]'} ${issue.code} ${issue.file}${issue.line ? `:${issue.line}` : ''} ${issue.message}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const root = resolve(option('--root') ?? repoRoot);
  const result = await checkDocs({
    root,
    ...(option('--installed') ? { installedApp: resolve(option('--installed')) } : {}),
    ...(option('--accounts') ? { accountsPath: resolve(option('--accounts')) } : {}),
  });
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ok: result.ok, checked: result.checked, errorCount: result.errorCount, warningCount: result.warningCount, issues: result.issues }, null, 2)}\n`);
  } else {
    for (const line of formatIssues(result.issues)) process.stdout.write(`${line}\n`);
    process.stdout.write(`检查完成：${result.checked} 项，发现 ${result.errorCount} 处不一致${result.warningCount ? `、${result.warningCount} 处提示` : ''}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}
