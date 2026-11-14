import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoLocal, parseTestCounts, parseBrowserLog, parseGateLog, parseCodesignIdentity, collectAcceptance, buildSummary, formatDiff, updateAcceptance } from '../tools/update-acceptance.mjs';
import { checkDocs, collectDocFacts, lastClaim, formatIssues } from '../tools/check-docs.mjs';
import { fileSha256, sourceDigest } from '../tools/release-integrity.mjs';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const DIGEST = 'a1b2c3d4' + 'e'.repeat(56);
const OTHER_DIGEST = 'c3d4e5f6' + '9'.repeat(56);
const FAKE_SIGNATURE = async (appPath) => ({ available: false, strictVerified: appPath.endsWith('GravityBox.app'), identity: ['CDHash=' + '0'.repeat(40), 'TeamIdentifier=not set'] });

async function writeJson(path, value) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

async function makeFixture({ stale = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gb-acceptance-'));
  await writeJson(join(root, 'package.json'), { name: 'gravitybox', version: '0.9.0' });
  await writeJson(join(root, '.cache/verified-release.json'), { digest: DIGEST, nativeBinarySha256: 'b'.repeat(64), at: '2026-10-21T12:00:00.000Z', version: '0.9.0' });

  const reportDir = join(root, '质检报告', '0.9.0-改造验收');
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, '单元与集成.log'), '# tests 12\n# pass 12\n# fail 0\n# cancelled 0\n# duration_ms 1234.5\n');
  await writeFile(join(reportDir, '浏览器回归.log'), 'PASS 场景一\nPASS 场景二\n{"passed":5,"updateDurationMs":12}\n');
  await writeFile(join(reportDir, '词典门禁-2.24.0.log'), '{\n "summary": {\n  "pass": true\n }\n}\n');

  const dmgDir = join(root, '成品');
  await mkdir(dmgDir, { recursive: true });
  const dmg = join(dmgDir, 'GravityBox-0.9.0-arm64.dmg');
  await writeFile(dmg, 'synthetic-dmg-bytes-for-dry-run');
  const dmgSHA256 = await fileSha256(dmg);

  const installedApp = join(root, 'fake-app', 'GravityBox.app');
  const resources = join(installedApp, 'Contents/Resources');
  await mkdir(join(installedApp, 'Contents/MacOS'), { recursive: true });
  await mkdir(resources, { recursive: true });
  await writeJson(join(resources, 'build-info.json'), { version: '0.9.0', revision: DIGEST.slice(0, 8), sourceDigest: DIGEST });
  await writeFile(join(installedApp, 'Contents/MacOS/GravityBox'), 'synthetic-binary');
  await writeFile(join(resources, 'AppIcon.icns'), 'synthetic-icon');
  const installedFiles = 3;

  const accountsPath = join(root, 'accounts.json');
  await writeJson(accountsPath, { version: '2.0', current_account_id: 'id-1', accounts: [{ id: 'id-1', email: 'current@example.test' }, { id: 'id-2', email: 'standby@example.test' }] });

  const summary = {
    at: '2026-10-21T11:45:10.544039+08:00',
    version: '0.9.0',
    revision: DIGEST.slice(0, 8),
    sourceDigest: DIGEST,
    installed: installedApp,
    dmg,
    dmgSHA256,
    installedFilesVerified: installedFiles,
    automated: { unitIntegrationPassed: 12, browserPassed: 5, dictionaryGates: ['2.24.0'], nativePageLayouts: 36 },
    liveAcceptance: { screenshots: ['synthetic.png'], realAccountSwitchExecuted: false },
  };
  if (stale) Object.assign(summary, {
    revision: 'deadbeef',
    sourceDigest: OTHER_DIGEST,
    dmg: '/nonexistent/history/Antigravity汉化/成品/GravityBox-0.9.0-arm64.dmg',
    dmgSHA256: 'd'.repeat(64),
    installedFilesVerified: 999,
  });
  if (stale) Object.assign(summary.automated, { unitIntegrationPassed: 9, browserPassed: 1 });
  await writeJson(join(root, '文档/当前版本验收摘要.json'), summary);

  const agents = [
    '# 项目约定',
    '- 当前运行程序为 `/Applications/GravityBox.app`；保留 `成品/GravityBox-0.9.0-arm64.dmg`。',
    '- 0.9.0 最终已安装：12/12 单元与集成测试、5/5 浏览器回归测试；账号示例 `current@example.test`。',
    '',
  ].join('\n').replace('12/12 单元与集成测试', stale ? '74/74 单元与集成测试' : '12/12 单元与集成测试').replace('5/5 浏览器回归测试', stale ? '46/46 浏览器回归测试' : '5/5 浏览器回归测试').replace('current@example.test', stale ? 'old@example.test' : 'current@example.test');
  await writeFile(join(root, 'AGENTS.md'), stale ? `${agents}\n- 历史保留 成品/GravityBox-0.8.1-arm64.dmg\n` : agents);
  await writeFile(join(root, 'README.md'), '# GravityBox 0.9.0\n\n1. 安装包：`成品/GravityBox-0.9.0-arm64.dmg`\n');
  return { root, dmg, dmgSHA256, installedApp, accountsPath, installedFiles };
}

async function cleanup(contexts) { for (const root of contexts) await rm(root, { recursive: true, force: true }); }

// ---------------- 计数解析 ----------------
test('解析 node --test 计数与浏览器/门禁日志', () => {
  const unit = parseTestCounts('# tests 221\n# pass 221\n# fail 0\n# cancelled 0\n# skipped 0\n# duration_ms 64286.6\n');
  assert.deepEqual({ tests: unit.tests, pass: unit.pass, fail: unit.fail }, { tests: 221, pass: 221, fail: 0 });
  assert.equal(unit.durationMs, 64286.6);
  assert.equal(parseTestCounts('1..7\n# fail 1\n').tests, 7);

  assert.deepEqual(parseBrowserLog('PASS a\nPASS b\nFAIL c\n{"passed":50,"updateDurationMs":1}\n'), { passed: 50, failed: 1 });
  assert.equal(parseBrowserLog('PASS a\nPASS b\n').passed, 2);

  assert.equal(parseGateLog('{ "summary": { "pass": true } }').pass, true);
  assert.equal(parseGateLog('{ "pass": false }').pass, false);
  assert.equal(parseGateLog('no json').pass, null);

  assert.deepEqual(parseCodesignIdentity('Identifier=x\nCDHash=abc123\nTeamIdentifier=EQHXZ8M8AV\n'), ['CDHash=abc123', 'TeamIdentifier=EQHXZ8M8AV']);
  assert.deepEqual(parseCodesignIdentity('Identifier=x\n'), ['TeamIdentifier=not set']);
  assert.match(isoLocal(new Date('2026-10-21T12:00:00Z')), /^2026-10-21T\d{2}:00:00\.000[+-]\d{2}:\d{2}$/);
});

// ---------------- update-acceptance ----------------
test('collectAcceptance 汇总日志/DMG/build-info/签名，缺文件只警告不崩溃', async () => {
  const { root, installedApp, dmgSHA256 } = await makeFixture();
  try {
    const collected = await collectAcceptance({ root, installedApp, stagingApp: join(root, 'none'), signatureProbe: FAKE_SIGNATURE });
    assert.equal(collected.version, '0.9.0');
    assert.equal(collected.digest, DIGEST);
    assert.equal(collected.dmgSHA256, dmgSHA256);
    assert.equal(collected.automated.unitIntegrationPassed, 12);
    assert.equal(collected.automated.browserPassed, 5);
    assert.deepEqual(collected.automated.dictionaryGates, ['2.24.0']);
    assert.equal(collected.installedFilesVerified, 3);
    assert.equal(collected.signatures.GravityBox.strictVerified, true);

    const empty = await mkdtemp(join(tmpdir(), 'gb-acceptance-empty-'));
    try {
      await writeJson(join(empty, 'package.json'), { version: '0.9.0' });
      const bare = await collectAcceptance({ root: empty, installedApp: join(empty, 'nope'), stagingApp: join(empty, 'nope2'), signatureProbe: FAKE_SIGNATURE });
      assert.equal(bare.digest, null);
      assert.equal(bare.dmgSHA256, null);
      assert.ok(bare.warnings.length >= 4, bare.warnings.join('；'));
    } finally { await rm(empty, { recursive: true, force: true }); }
  } finally { await cleanup([root]); }
});

test('buildSummary 保留人工证据，只覆盖可自动验证字段', async () => {
  const { root, installedApp } = await makeFixture();
  try {
    const collected = await collectAcceptance({ root, installedApp, stagingApp: join(root, 'none'), signatureProbe: FAKE_SIGNATURE });
    const existing = { liveAcceptance: { screenshots: ['a.png'] }, preservation: { changedProtectedFiles: [] }, rollback: { previousDMG: 'x' }, automated: { nativePageLayouts: 36 } };
    const summary = buildSummary(existing, collected);
    assert.deepEqual(summary.liveAcceptance, existing.liveAcceptance);
    assert.deepEqual(summary.preservation, existing.preservation);
    assert.deepEqual(summary.rollback, existing.rollback);
    assert.equal(summary.automated.nativePageLayouts, 36);
    assert.equal(summary.automated.unitIntegrationPassed, 12);
    assert.equal(summary.revision, DIGEST.slice(0, 8));
  } finally { await cleanup([root]); }
});

test('updateAcceptance --dry-run 不写盘、有差异时可读输出；写入模式生成完整摘要', async () => {
  const { root, installedApp, dmgSHA256 } = await makeFixture({ stale: true });
  try {
    const summaryPath = join(root, '文档/当前版本验收摘要.json');
    const before = await readFile(summaryPath, 'utf8');
    const dry = await updateAcceptance({ root, out: summaryPath, dryRun: true, installedApp, stagingApp: join(root, 'none'), signatureProbe: FAKE_SIGNATURE });
    assert.equal(dry.written, false);
    assert.equal(await readFile(summaryPath, 'utf8'), before, 'dry-run 不得修改摘要文件');
    assert.ok(dry.diff.some(change => change.path === 'dmgSHA256' && change.to === dmgSHA256), JSON.stringify(dry.diff.map(c => c.path)));
    assert.match(formatDiff(dry.diff).join('\n'), /^~ dmgSHA256:/m);

    const out = join(root, 'out/summary.json');
    await mkdir(join(root, 'out'), { recursive: true });
    await writeFile(out, before, 'utf8'); // 以现有摘要为底，人工证据必须保留
    const written = await updateAcceptance({ root, out, dryRun: false, installedApp, stagingApp: join(root, 'none'), signatureProbe: FAKE_SIGNATURE });
    assert.equal(written.written, true);
    const saved = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(saved.sourceDigest, DIGEST);
    assert.equal(saved.revision, DIGEST.slice(0, 8));
    assert.equal(saved.dmgSHA256, dmgSHA256);
    assert.equal(saved.automated.unitIntegrationPassed, 12);
    assert.equal(saved.automated.browserPassed, 5);
    assert.equal(saved.installedFilesVerified, 3);
    assert.deepEqual(saved.liveAcceptance, { screenshots: ['synthetic.png'], realAccountSwitchExecuted: false });
    assert.match(saved.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  } finally { await cleanup([root]); }
});

test('update-acceptance CLI --dry-run 退出 0 且不写文档', async () => {
  const { root } = await makeFixture({ stale: true });
  try {
    const summaryPath = join(root, '文档/当前版本验收摘要.json');
    const before = await readFile(summaryPath, 'utf8');
    const { stdout } = await run(process.execPath, [join(repo, 'tools/update-acceptance.mjs'), '--root', root, '--dry-run'], { cwd: repo });
    assert.match(stdout, /dry-run 未写盘/);
    assert.match(stdout, /~ dmgSHA256:/);
    assert.equal(await readFile(summaryPath, 'utf8'), before);
  } finally { await cleanup([root]); }
});

// ---------------- check-docs ----------------
test('checkDocs：一致的假产物返回 ok，差异检测覆盖 summary/AGENTS 各类声明', async () => {
  const consistent = await makeFixture();
  const stale = await makeFixture({ stale: true });
  try {
    const ok = await checkDocs({ root: consistent.root, installedApp: consistent.installedApp, accountsPath: consistent.accountsPath, facts: {...await collectDocFacts({root:consistent.root, installedApp:consistent.installedApp, accountsPath:consistent.accountsPath}),digest:DIGEST,verifiedDigest:DIGEST} });
    assert.equal(ok.ok, true, formatIssues(ok.issues).join('\n'));
    assert.equal(ok.errorCount, 0, formatIssues(ok.issues).join('\n'));

    const bad = await checkDocs({ root: stale.root, installedApp: stale.installedApp, accountsPath: stale.accountsPath, facts: {...await collectDocFacts({root:stale.root, installedApp:stale.installedApp, accountsPath:stale.accountsPath}),digest:DIGEST,verifiedDigest:DIGEST} });
    assert.equal(bad.ok, false);
    const codes = new Set(bad.issues.map(issue => issue.code));
    for (const expected of [
      'SUMMARY_SOURCE_STALE', 'SUMMARY_REVISION_STALE', 'SUMMARY_DMG_PATH_MISSING', 'SUMMARY_DMG_MISMATCH',
      'SUMMARY_INSTALLED_FILES_MISMATCH', 'SUMMARY_UNIT_COUNT_MISMATCH', 'SUMMARY_BROWSER_COUNT_MISMATCH',
      'DOC_DMG_PATH_MISSING', 'DOC_UNIT_COUNT_STALE', 'DOC_BROWSER_COUNT_STALE', 'DOC_ACCOUNT_STALE',
    ]) assert.ok(codes.has(expected), `缺少检测项 ${expected}；实际：${[...codes].join(',')}`);
    for (const issue of bad.issues) assert.equal(issue.level, 'error');
    assert.ok(bad.issues.some(issue => issue.file === 'AGENTS.md' && issue.line === 3 && issue.code === 'DOC_UNIT_COUNT_STALE'));
  } finally { await cleanup([consistent.root, stale.root]); }
});

test('checkDocs：缺文件不崩溃，返回明确错误清单', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'gb-docs-empty-'));
  try {
    const result = await checkDocs({ root: empty, installedApp: join(empty, 'none'), accountsPath: join(empty, 'none.json') });
    assert.equal(result.ok, false);
    const codes = new Set(result.issues.map(issue => issue.code));
    for (const expected of ['SUMMARY_MISSING', 'DOC_MISSING']) assert.ok(codes.has(expected), [...codes].join(','));
    // 不因缺 accounts.json / build-info 抛错
    assert.ok(Array.isArray(result.facts.accountEmails) && result.facts.accountEmails.length === 0);
  } finally { await rm(empty, { recursive: true, force: true }); }
});

test('lastClaim 取最近一次声明与行号', () => {
  const text = '- 67/67 单元与集成\n- 74/74 单元与集成\n- 12/12 单元与集成\n';
  const claim = lastClaim(text, /(\d+)\/(\d+)\s*单元与集成/g);
  assert.equal(claim.groups[0], '12');
  assert.equal(claim.line, 3);
});

test('check-docs CLI：差异 exit 1，一致 exit 0，--json 可解析', async () => {
  const consistent = await makeFixture();
  const stale = await makeFixture({ stale: true });
  try {
    // CLI success needs a real, hashable source tree; a stamp alone is insufficient.
    for(const name of ['src','runtime','native','tools','test','dict','ui-strings','assets','licenses'])await mkdir(join(consistent.root,name));
    for(const name of ['package-lock.json','tsconfig.json','THIRD_PARTY_NOTICES.md'])await writeFile(join(consistent.root,name),'fixture');
    const currentDigest=await sourceDigest(consistent.root);
    const summaryPath=join(consistent.root,'文档/当前版本验收摘要.json');const currentSummary=JSON.parse(await readFile(summaryPath,'utf8'));currentSummary.sourceDigest=currentDigest;currentSummary.revision=currentDigest.slice(0,8);await writeJson(summaryPath,currentSummary);
    await writeJson(join(consistent.root,'.cache/verified-release.json'),{digest:currentDigest});
    const okRun = await run(process.execPath, [join(repo, 'tools/check-docs.mjs'), '--root', consistent.root, '--installed', consistent.installedApp, '--accounts', consistent.accountsPath], { cwd: repo });
    assert.match(okRun.stdout, /发现 0 处不一致/);

    await assert.rejects(
      () => run(process.execPath, [join(repo, 'tools/check-docs.mjs'), '--root', stale.root, '--installed', stale.installedApp, '--accounts', stale.accountsPath], { cwd: repo }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(String(error.stdout), /\[错误\]/);
        return true;
      }
    );

    const jsonRun = await run(process.execPath, [join(repo, 'tools/check-docs.mjs'), '--root', stale.root, '--installed', stale.installedApp, '--accounts', stale.accountsPath, '--json'], { cwd: repo }).catch(error => error);
    const parsed = JSON.parse(jsonRun.stdout);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.errorCount > 0);

    const sourceOnlyRun = await run(process.execPath, [join(repo, 'tools/check-docs.mjs'), '--source-only'], { cwd: repo });
    assert.match(sourceOnlyRun.stdout, /发现 0 处不一致/);
  } finally { await cleanup([consistent.root, stale.root]); }
});
