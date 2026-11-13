import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractUiStrings, SUPPORTED_BUNDLES } from '../dist/bundle.js';
import { reconcileExtraction, verifyBundleSource } from '../tools/coverage-report.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
const FIXTURE = 'const a={label:"Open a review",description:"Synthetic tip"};const b={title:"Cancel"};';
const FIXTURE_SHA = sha(FIXTURE);
/** 测试注入：把 fixture 哈希当作 2.24.0 的“官方指纹”，用于验证真实字节路径可通过；生产 CLI 不暴露该参数。 */
const official = new Map([['2.24.0', FIXTURE_SHA]]);
const extractionOf = (source = FIXTURE) => ({
  schema: 1,
  appVersion: '2.24.0',
  bundleSha256: sha(source),
  source: 'fixture',
  strings: extractUiStrings(source).map(entry => ({ text: entry.text, kinds: entry.kinds, count: entry.count })),
});
async function tempFile(dir, name, content) { const path = join(dir, name); await writeFile(path, content); return path; }
async function runGate(args) {
  try {
    const result = await exec(process.execPath, [join(root, 'tools/coverage-report.mjs'), ...args], { cwd: root, maxBuffer: 4e6, env: { ...process.env, GRAVITYBOX_NO_VENDOR: '0' } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

test('I02 provenance：真实界面包字节 + 官方指纹 + 逐条对账才 verified（fixture 注入证明字节路径可通过）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-prov-ok-'));
  try {
    const bundlePath = await tempFile(dir, 'main.js', FIXTURE);
    const uiStrings = extractionOf();
    const result = await verifyBundleSource(uiStrings, { bundlePath, officialBundles: official });
    assert.equal(result.verified, true);
    assert.equal(result.byteVerified, true);
    assert.equal(result.actualSha256, FIXTURE_SHA);
    assert.equal(result.extractedCount, uiStrings.strings.length);
    assert.equal(result.bundleSource, bundlePath);
    assert.match(result.reason, /重算哈希并逐条对账/);
    /* 只给官方哈希、不给字节：即使 hash 与官方一致也必须 fail-closed。 */
    const hashOnly = await verifyBundleSource(uiStrings, { expectSha256: FIXTURE_SHA, officialBundles: official });
    assert.equal(hashOnly.verified, false);
    assert.match(hashOnly.reason, /不能替代字节证明|不能证明|无法读取/);
    /* expect 约束与字节同时具备时通过，但 expect 不匹配官方时仍拒绝。 */
    const constrained = await verifyBundleSource(uiStrings, { bundlePath, expectSha256: FIXTURE_SHA, officialBundles: official });
    assert.equal(constrained.verified, true);
    const wrongConstraint = await verifyBundleSource(uiStrings, { bundlePath, expectSha256: sha('other'), officialBundles: official });
    assert.equal(wrongConstraint.verified, false);
    assert.match(wrongConstraint.reason, /与官方指纹/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('I02 provenance：伪造/篡改 strings JSON 即使带官方哈希也被逐条对账拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-prov-tamper-'));
  try {
    const bundlePath = await tempFile(dir, 'main.js', FIXTURE);
    const base = extractionOf();
    const dropped = { ...base, strings: base.strings.slice(0, -1) };
    const droppedResult = await verifyBundleSource(dropped, { bundlePath, officialBundles: official });
    assert.equal(droppedResult.verified, false);
    assert.match(droppedResult.reason, /对账|条数/);

    const injected = { ...base, strings: [...base.strings, { text: 'Fabricated string not in bundle', kinds: [], count: 1 }] };
    const injectedResult = await verifyBundleSource(injected, { bundlePath, officialBundles: official });
    assert.equal(injectedResult.verified, false);
    assert.match(injectedResult.reason, /对账|条数/);

    const replaced = { ...base, strings: base.strings.map((row, index) => index === 0 ? { ...row, text: 'Fabricated replacement' } : row) };
    const replacedResult = await verifyBundleSource(replaced, { bundlePath, officialBundles: official });
    assert.equal(replacedResult.verified, false);
    assert.match(replacedResult.reason, /对账|不一致/);

    assert.equal(reconcileExtraction(base, FIXTURE).ok, true);
    assert.equal(reconcileExtraction(dropped, FIXTURE).ok, false);
    assert.equal(reconcileExtraction(replaced, FIXTURE).ok, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('I02 provenance：保留全部 text 但篡改 kinds/count/counts 必须拒绝（防 template 跳过绕过）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-prov-adversarial-'));
  try {
    const bundlePath = await tempFile(dir, 'main.js', FIXTURE);
    const base = extractionOf();
    const checkReduced = async (payload, pattern, label) => {
      const result = await verifyBundleSource(payload, { bundlePath, officialBundles: official });
      assert.equal(result.verified, false, `${label} 必须被拒绝`);
      assert.match(result.reason, pattern, `${label} 拒绝原因应说明字段：${result.reason}`);
      assert.equal(reconcileExtraction(payload, FIXTURE).ok, false, `${label} 对账必须失败`);
    };
    /* 攻击者保留全部原文，仅把所有行 kinds 改成 template/fragment：reconcile() 会跳过这些行从而绕过缺译门禁。 */
    await checkReduced({ ...base, strings: base.strings.map(row => ({ ...row, kinds: ['template'] })) }, /kinds/, '全部行 kinds 改成 template');
    await checkReduced({ ...base, strings: base.strings.map(row => ({ ...row, kinds: [...row.kinds, 'fragment'] })) }, /kinds/, '全部行追加 fragment');
    /* 只改一条 count（权重/缺译排序的依据）也要拒绝。 */
    await checkReduced({ ...base, strings: base.strings.map((row, index) => index === 0 ? { ...row, count: (Number(row.count) || 1) + 1 } : row) }, /count/, '篡改 count');
    /* kinds 与 count 均保留，仅改 counts 汇总（total 或分 kind 分布）。 */
    await checkReduced({ ...base, counts: { total: base.strings.length + 1 } }, /counts\.total/, '篡改 counts.total');
    await checkReduced({ ...base, counts: { total: base.strings.length, template: 1 } }, /counts\.template/, '篡改 counts 分 kind 分布');
    /* 长度不变但出现重复原文：同样拒绝。 */
    await checkReduced({ ...base, strings: [...base.strings.slice(0, -1), base.strings[0]] }, /重复原文/, '重复原文行');
    /* 只打乱 kinds 顺序（集合语义一致）应通过：canonical 比较不能误伤。 */
    const reordered = { ...base, strings: base.strings.map(row => ({ ...row, kinds: [...row.kinds].reverse() })) };
    const reorderedResult = await verifyBundleSource(reordered, { bundlePath, officialBundles: official });
    assert.equal(reorderedResult.verified, true, reorderedResult.reason);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('I02 provenance：本地最新已存官方包核对提取，无 vendor 时仅核对最新清单基本结构', async () => {
  const versions = [...SUPPORTED_BUNDLES.keys()];
  const available = versions.filter(version =>
    existsSync(join(root, 'vendor', 'antigravity', version, 'main.js')) &&
    existsSync(join(root, 'ui-strings', `${version}.json`))
  );
  if (available.length > 0) {
    const version = available.at(-1);
    const uiStrings = JSON.parse(await readFile(join(root, 'ui-strings', `${version}.json`), 'utf8'));
    const source = await readFile(join(root, 'vendor', 'antigravity', version, 'main.js'), 'utf8');
    const result = reconcileExtraction(uiStrings, source);
    assert.equal(result.ok, true, `${version}: ${result.reason}`);
    assert.equal(result.extractedCount, uiStrings.strings.length);
    return;
  }
  // 全版本快照完整性与词典覆盖由 verify 统一检查，单项测试不重复执行。
  const latestVersion = versions.at(-1);
  const uiStrings = JSON.parse(await readFile(join(root, 'ui-strings', `${latestVersion}.json`), 'utf8'));
  assert.equal(uiStrings.appVersion, latestVersion);
  assert.ok(Array.isArray(uiStrings.strings) && uiStrings.strings.length > 0);
  const seen = new Set();
  for (const row of uiStrings.strings) {
    assert.equal(typeof row.text, 'string');
    assert.ok(!seen.has(row.text), `发现重复原文：${row.text}`);
    seen.add(row.text);
  }
});

test('I02 provenance：字节不匹配、缺源、空 bundle、不存在的 --bundle 全部 fail-closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-prov-fail-'));
  try {
    const real = await tempFile(dir, 'main.js', FIXTURE);
    const other = await tempFile(dir, 'other.js', 'const x={label:"Different bundle"};');
    const empty = await tempFile(dir, 'empty.js', '');
    const missing = join(dir, 'missing.js');
    const uiStrings = extractionOf();
    const mismatch = await verifyBundleSource(uiStrings, { bundlePath: other, officialBundles: official });
    assert.equal(mismatch.verified, false);
    assert.match(mismatch.reason, /不一致/);
    const emptyResult = await verifyBundleSource(uiStrings, { bundlePath: empty, officialBundles: official });
    assert.equal(emptyResult.verified, false);
    assert.match(emptyResult.reason, /空文件/);
    const absent = await verifyBundleSource(uiStrings, { bundlePath: missing, officialBundles: official });
    assert.equal(absent.verified, false);
    assert.match(absent.reason, /无法读取/);
    const missingRecordedSource = await verifyBundleSource({ ...uiStrings, source: missing }, { officialBundles: official });
    assert.equal(missingRecordedSource.verified, false);
    assert.match(missingRecordedSource.reason, /无法读取|没有实际字节/);
    /* 记录 source 可读但不是官方字节：即使声明 hash 与自身一致也不通过官方指纹。 */
    const nonOfficial = await verifyBundleSource({ ...uiStrings, source: other }, { officialBundles: official });
    assert.equal(nonOfficial.verified, false);
    assert.match(nonOfficial.reason, /不一致|不是 2\.24\.0 的官方指纹/);
    const realOk = await verifyBundleSource({ ...uiStrings, source: real }, { officialBundles: official });
    assert.equal(realOk.verified, true, '记录 source 为真实官方字节时可通过（字节路径，而不是声明值）');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('I02 provenance CLI：官方哈希 + 缺源/字节不匹配不得假绿（gate exit 2）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-prov-cli-'));
  try {
    const { SUPPORTED_BUNDLES } = await import('../dist/bundle.js');
    const pinned = SUPPORTED_BUNDLES.get('2.24.0');
    const dictDir = join(dir, 'dict');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dictDir, { recursive: true });
    await writeFile(join(dictDir, 'base.json'), JSON.stringify({ 'Open a review': '打开审查', 'Synthetic tip': '合成提示', Cancel: '取消' }));
    const ui = { schema: 1, appVersion: '2.24.0', bundleSha256: pinned, source: join(dir, 'missing-main.js'), extractedAt: 'x', counts: { total: 3 }, strings: [{ text: 'Open a review', kinds: [] }, { text: 'Synthetic tip', kinds: [] }, { text: 'Cancel', kinds: [] }] };
    const uiPath = join(dir, 'ui.json');
    await writeFile(uiPath, JSON.stringify(ui));

    const missingSource = await runGate(['--strings', uiPath, '--dict', dictDir, '--out', join(dir, 'r1.json'), '--gate', '--expect-bundle-sha256', pinned]);
    assert.equal(missingSource.code, 2, `伪造 strings + 官方哈希 + 缺源必须 exit 2：${missingSource.stderr}`);
    const report = JSON.parse(await readFile(join(dir, 'r1.json'), 'utf8'));
    assert.equal(report.summary.sourceVerified, false);
    assert.equal(report.gate.pass, false);
    assert.equal(report.gate.checks[0].pass, false);

    /* 提供 --bundle 但字节不是官方包：即使 expect 官方哈希也不能通过。 */
    const fakeBundle = await tempFile(dir, 'fake-main.js', FIXTURE);
    const wrongBytes = await runGate(['--strings', uiPath, '--dict', dictDir, '--out', join(dir, 'r2.json'), '--gate', '--bundle', fakeBundle, '--expect-bundle-sha256', pinned]);
    assert.equal(wrongBytes.code, 2, `字节不匹配必须 exit 2：${wrongBytes.stderr}`);
    const report2 = JSON.parse(await readFile(join(dir, 'r2.json'), 'utf8'));
    assert.equal(report2.summary.sourceVerified, false);
    assert.match(report2.sourceVerification.reason, /不一致|不是 2\.24\.0 的官方指纹/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
