import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_BUNDLES } from '../dist/bundle.js';
import { validateTranslations } from '../tools/merge-translations.mjs';
import { evaluateGate, verifyBundleSource } from '../tools/coverage-report.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const pinned = SUPPORTED_BUNDLES.get('2.24.0');
const SHA_ZERO = '0'.repeat(64);
assert.ok(/^[0-9a-f]{64}$/.test(pinned), '2.24.0 官方指纹应存在，否则门禁无法绑定来源');

async function runTool(script, args) {
  try {
    const result = await exec(process.execPath, [join(root, 'tools', script), ...args], { cwd: root, maxBuffer: 4e6, env: { ...process.env, GRAVITYBOX_NO_VENDOR: '0' } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}
async function tempDir(prefix) { return await mkdtemp(join(tmpdir(), prefix)); }
async function writeExtraction(dir, { appVersion = '2.24.0', bundleSha256 = pinned, strings = [{ text: 'Cancel', kinds: [] }], source = 'not-a-bundle', extra = {} } = {}) {
  const path = join(dir, 'ui.json');
  await writeFile(path, JSON.stringify({ schema: 1, appVersion, bundleSha256, extractedAt: new Date().toISOString(), source, counts: { total: strings.length }, strings, ...extra }));
  return path;
}
async function writeDict(dir, entries = { Cancel: '取消' }) {
  const dictDir = join(dir, 'dict');
  await mkdir(dictDir, { recursive: true });
  await writeFile(join(dictDir, 'base.json'), JSON.stringify(entries));
  return dictDir;
}

test('I01 门禁：界面包来源不可验证时 evaluateGate 必须失败', () => {
  const summary = { uiCoverage: 1, missing: 0, properNounViolations: 0, obsolete: 0, notExtracted: 0, templates: 0, fragments: 0 };
  assert.equal(evaluateGate(summary).pass, false, '未提供来源校验时默认失败');
  assert.equal(evaluateGate(summary, undefined, { verified: false, reason: '无法验证' }).pass, false);
  const verified = evaluateGate(summary, undefined, { verified: true, reason: '已验证' });
  assert.equal(verified.pass, true);
  assert.equal(verified.checks[0].name.includes('界面包来源'), true, '来源校验必须是第一条门禁检查');
});

test('I01 门禁：伪造 appVersion/bundleSha256 被 verifyBundleSource 拒绝，官方哈希单独不足以通过', async () => {
  const dir = await tempDir('gb-audit-src-');
  try {
    const base = { appVersion: '2.24.0', bundleSha256: pinned, source: 'x' };
    const rejected = [
      [{ ...base, appVersion: '9.9.9' }, {}, /不在受支持/],
      [{ ...base, bundleSha256: SHA_ZERO }, {}, /官方指纹|不一致|无法/],
      [{ appVersion: '2.24.0', source: 'x' }, {}, /bundleSha256/],
      [{ ...base, source: 'not-a-bundle' }, {}],
      [base, { expectSha256: pinned }, /不能替代字节证明|无法证明|无法读取/],
      [base, { expectSha256: SHA_ZERO }],
    ];
    for (const [record, options, reason] of rejected) {
      const result = await verifyBundleSource(record, options);
      assert.equal(result.verified, false, JSON.stringify({ record, options }));
      if (reason) assert.match(result.reason, reason);
    }
    const wrongBundle = await writeExtraction(dir);
    await writeFile(join(dir, 'main.js'), 'not the real bundle');
    const wrongFile = await verifyBundleSource(JSON.parse(await readFile(wrongBundle, 'utf8')), { bundlePath: join(dir, 'main.js') });
    assert.equal(wrongFile.verified, false);
    const emptyBundle = join(dir, 'empty.js');
    await writeFile(emptyBundle, '');
    const empty = await verifyBundleSource(JSON.parse(await readFile(wrongBundle, 'utf8')), { bundlePath: emptyBundle });
    assert.equal(empty.verified, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('I01 门禁 CLI：伪造 version/bundleSha 的提取文件 gate 必须非零退出', async () => {
  const dir = await tempDir('gb-audit-gate-');
  try {
    const dictDir = await writeDict(dir);
    const forgedVersion = await writeExtraction(dir, { appVersion: '9.9.9', bundleSha256: pinned });
    const forgedVersionRun = await runTool('coverage-report.mjs', ['--strings', forgedVersion, '--dict', dictDir, '--out', join(dir, 'r1.json'), '--gate']);
    assert.equal(forgedVersionRun.code, 2, `伪造 appVersion 必须 gate 失败：${forgedVersionRun.stderr}`);
    const forgedVersionReport = JSON.parse(await readFile(join(dir, 'r1.json'), 'utf8'));
    assert.equal(forgedVersionReport.gate.pass, false);
    assert.equal(forgedVersionReport.gate.checks[0].pass, false);
    assert.equal(forgedVersionReport.summary.sourceVerified, false);

    const forgedHash = await writeExtraction(dir, { appVersion: '2.24.0', bundleSha256: SHA_ZERO });
    const forgedHashRun = await runTool('coverage-report.mjs', ['--strings', forgedHash, '--dict', dictDir, '--out', join(dir, 'r2.json'), '--gate']);
    assert.equal(forgedHashRun.code, 2, `伪造 bundleSha256 必须 gate 失败：${forgedHashRun.stderr}`);

    const mismatchVersion = await runTool('coverage-report.mjs', ['--strings', forgedHash, '--version', '2.23.0', '--dict', dictDir, '--out', join(dir, 'r3.json'), '--gate']);
    assert.equal(mismatchVersion.code, 1, '--version 与提取结果 appVersion 不一致必须直接失败');

    /* 反例（本轮 P1）：伪造 strings JSON + 官方哈希 + 不存在的 source 必须拒绝，不能假绿。 */
    const fabricated = await writeExtraction(dir, { appVersion: '2.24.0', bundleSha256: pinned, source: join(dir, 'missing-main.js') });
    const fabricatedRun = await runTool('coverage-report.mjs', ['--strings', fabricated, '--dict', dictDir, '--out', join(dir, 'r4.json'), '--gate', '--expect-bundle-sha256', pinned]);
    assert.equal(fabricatedRun.code, 2, `伪造 strings + 官方哈希 + 缺源必须 fail-closed：${fabricatedRun.stderr}`);
    const fabricatedReport = JSON.parse(await readFile(join(dir, 'r4.json'), 'utf8'));
    assert.equal(fabricatedReport.gate.pass, false);
    assert.equal(fabricatedReport.summary.sourceVerified, false);
    assert.equal(fabricatedReport.gate.checks[0].pass, false);
    assert.match(fabricatedReport.sourceVerification.reason, /无法|不能替代字节证明/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('I02 merge-translations：拒绝英文原文、占位符缺失、空译文，接受真实中文译文', () => {
  const english = validateTranslations([{ key: 'Save changes', zh: 'Save changes' }, { key: 'Delete conversation', zh: 'Delete conversation' }], {});
  assert.equal(english.accepted.length, 0, '英文原文不能当译文');
  assert.equal(english.rejected.length, 2);
  assert.match(english.rejected[0].reason, /英文原文|中文/);

  const placeholder = validateTranslations([{ key: 'Open {name} in {count} steps', zh: '打开' }], {});
  assert.equal(placeholder.accepted.length, 0, '占位符缺失必须拒绝');
  assert.match(placeholder.rejected[0].reason, /占位符/);

  const empty = validateTranslations([{ key: 'Save', zh: '   ' }, { key: 'Save', zh: '' }], {});
  assert.equal(empty.accepted.length, 0, '空译文必须拒绝');

  const proper = validateTranslations([{ key: 'GravityBox settings', zh: '重力盒设置' }], {});
  assert.equal(proper.accepted.length, 0, '运行时专有名词表须生效（GravityBox 不能被译掉）');

  const ok = validateTranslations([{ key: 'Save changes', zh: '保存更改' }], {});
  assert.deepEqual(ok.accepted, [{ key: 'Save changes', zh: '保存更改' }]);
  assert.equal(ok.rejected.length, 0);

  const conflict = validateTranslations([{ key: 'Save changes', zh: '保存更改' }], { 'Save changes': '保存' });
  assert.equal(conflict.accepted.length, 0, '默认拒绝覆盖已有译文');
  const override = validateTranslations([{ key: 'Save changes', zh: '保存更改' }], { 'Save changes': '保存' }, { allowOverride: true });
  assert.equal(override.accepted.length, 1, '--force 才允许覆盖');
});

test('I02 merge-translations CLI：英文批次整批拒绝且不写目标词典', async () => {
  const dir = await tempDir('gb-audit-merge-');
  try {
    const pending = join(dir, 'pending.json');
    await writeFile(pending, JSON.stringify({ schema: 1, appVersion: '2.24.0', entries: [{ key: 'Save changes' }] }));
    const input = join(dir, 'translated.json');
    await writeFile(input, JSON.stringify({ schema: 1, appVersion: '2.24.0', entries: [{ key: 'Save changes', zh: 'Save changes' }] }));
    const out = join(dir, 'layer.json');
    const result = await runTool('merge-translations.mjs', ['--version', '2.24.0', '--input', input, '--pending', pending, '--out', out]);
    assert.equal(result.code, 1, '有拒绝项且未 --keep-partial 时必须失败');
    await assert.rejects(readFile(out, 'utf8'), { code: 'ENOENT' }, '校验失败不得写入半成品');
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.accepted, 0);
    assert.equal(parsed.rejected, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('I03 extract-ui-strings：缺失/空/非 UTF-8 明确失败，--bundle 记录绝对 source', async () => {
  const dir = await tempDir('gb-audit-extract-');
  try {
    const missing = await runTool('extract-ui-strings.mjs', ['--version', '2.24.0', '--bundle', join(dir, 'absent.js'), '--stdout']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /无法读取|不存在/);

    const emptyPath = join(dir, 'empty.js');
    await writeFile(emptyPath, '');
    const empty = await runTool('extract-ui-strings.mjs', ['--version', '2.24.0', '--bundle', emptyPath, '--stdout']);
    assert.equal(empty.code, 1);
    assert.match(empty.stderr, /为空/);

    const binaryPath = join(dir, 'binary.js');
    await writeFile(binaryPath, Buffer.from([0xff, 0xfe, 0x41, 0x42]));
    const binary = await runTool('extract-ui-strings.mjs', ['--version', '2.24.0', '--bundle', binaryPath, '--stdout']);
    assert.equal(binary.code, 1);
    assert.match(binary.stderr, /UTF-8/);

    const nulPath = join(dir, 'nul.js');
    await writeFile(nulPath, Buffer.from([0x63, 0x00, 0x6f, 0x6e]));
    const nul = await runTool('extract-ui-strings.mjs', ['--version', '2.24.0', '--bundle', nulPath, '--stdout']);
    assert.equal(nul.code, 1);
    assert.match(nul.stderr, /NUL/);

    const validPath = join(dir, 'main-2.24.0.js');
    await writeFile(validPath, 'const x={label:"Open a review",tooltip:"Synthetic tip"};');
    const valid = await runTool('extract-ui-strings.mjs', ['--version', '2.24.0', '--bundle', validPath, '--stdout']);
    assert.equal(valid.code, 0, valid.stderr);
    const value = JSON.parse(valid.stdout);
    assert.equal(value.schema, 1);
    assert.equal(value.appVersion, '2.24.0');
    assert.equal(value.source, resolve(validPath), '--bundle 的 source 必须是可回溯的绝对路径');
    assert.match(value.bundleSha256, /^[0-9a-f]{64}$/);
    assert.equal(value.bundleBytes > 0, true);
    assert.ok(value.strings.some(entry => entry.text === 'Open a review'), '正常提取 schema/内容保持兼容');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('I04 免 vendor 模式：verifyBundleSource 与 coverage-report CLI 门禁校验', async () => {
  const dir = await tempDir('gb-audit-novendor-');
  try {
    const dictDir = await writeDict(dir);

    // 1. 成功路径：官方支持版本 + 匹配官方指纹 + 有效 strings 数组
    const trusted = JSON.parse(await readFile(new URL('../ui-strings/2.24.0.json', import.meta.url), 'utf8'));
    const valid = await verifyBundleSource({ ...trusted, source: 'virtual-no-vendor' }, { noVendor: true });
    assert.equal(valid.verified, true);
    assert.equal(valid.byteVerified, false);
    assert.equal(valid.noVendor, true);
    assert.match(valid.reason, /免 vendor 校验模式/);

    // 2. 失败路径：伪造 appVersion
    const wrongVersion = await verifyBundleSource({
      appVersion: '9.9.9',
      bundleSha256: pinned,
      strings: [{ text: 'Cancel', kinds: [] }],
      source: 'virtual',
    }, { noVendor: true });
    assert.equal(wrongVersion.verified, false);
    assert.match(wrongVersion.reason, /不在受支持/);

    // 3. 失败路径：哈希不匹配官方指纹
    const wrongHash = await verifyBundleSource({
      appVersion: '2.24.0',
      bundleSha256: SHA_ZERO,
      strings: [{ text: 'Cancel', kinds: [] }],
      source: 'virtual',
    }, { noVendor: true });
    assert.equal(wrongHash.verified, false);
    assert.match(wrongHash.reason, /官方指纹/);

    // 4. 失败路径：strings 为空数组
    const emptyStrings = await verifyBundleSource({
      appVersion: '2.24.0',
      bundleSha256: pinned,
      strings: [],
      source: 'virtual',
    }, { noVendor: true });
    assert.equal(emptyStrings.verified, false);
    assert.match(emptyStrings.reason, /缺少有效的 strings 数组/);

    // 5. CLI 门禁验证：--no-vendor 模式在没有物理 bundle 时能够通过门禁
    const extractionPath = join(dir, 'trusted-extraction.json');
    await writeFile(extractionPath, JSON.stringify({ ...trusted, source: join(dir, 'non-existent-bundle.js') }));
    const runWithoutNoVendor = await runTool('coverage-report.mjs', [
      '--strings', extractionPath,
      '--dict', dictDir,
      '--out', join(dir, 'rep-fail.json'),
      '--gate',
    ]);
    assert.equal(runWithoutNoVendor.code, 2, '无物理 bundle 且未开启 --no-vendor 时必须 fail-closed');

    const runWithNoVendor = await runTool('coverage-report.mjs', [
      '--strings', extractionPath,
      '--dict', join(process.cwd(), 'dict'),
      '--out', join(dir, 'rep-pass.json'),
      '--gate',
      '--no-vendor',
    ]);
    assert.equal(runWithNoVendor.code, 0, `开启 --no-vendor 且指纹匹配时门禁应通过：${runWithNoVendor.stderr}`);
    const report = JSON.parse(await readFile(join(dir, 'rep-pass.json'), 'utf8'));
    assert.equal(report.gate.pass, true);
    assert.equal(report.summary.sourceVerified, true);
    assert.equal(report.sourceVerification.noVendor, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

