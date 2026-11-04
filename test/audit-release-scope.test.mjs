import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildInfoPayload,
  describeValidationScope,
  parseTargetAppVersionArg,
  readRecordedScope,
  recordedScopeFields,
  resolvePackagingScope,
  resolveValidationScope,
  VALIDATION_SCOPE_ALL,
  VALIDATION_SCOPE_TARGETED,
} from '../tools/release-scope.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const SUPPORTED = ['2.23.0', '2.23.1', '2.24.0'];
const TARGETED_RECORD = {
  digest: 'a'.repeat(64),
  version: '0.9.0',
  at: '2026-10-21T13:00:00.000Z',
  nativeBinarySha256: 'b'.repeat(64),
  validationScope: VALIDATION_SCOPE_TARGETED,
  targetAppVersions: ['2.24.0'],
  historicalUnverified: ['2.23.0', '2.23.1'],
};
const FULL_RECORD = {
  digest: 'c'.repeat(64),
  version: '0.9.0',
  at: '2026-10-21T13:00:00.000Z',
  validationScope: VALIDATION_SCOPE_ALL,
  targetAppVersions: [...SUPPORTED],
  historicalUnverified: [],
};

test('release scope：默认 verify 仍是全部受支持版本（不默认降门槛）', () => {
  const scope = resolveValidationScope([], SUPPORTED);
  assert.equal(scope.mode, VALIDATION_SCOPE_ALL);
  assert.deepEqual(scope.targetAppVersions, [...SUPPORTED].sort());
  assert.deepEqual(scope.historicalUnverified, []);
  assert.match(describeValidationScope(scope), /全部受支持版本/);
  assert.deepEqual(recordedScopeFields(scope), { validationScope: VALIDATION_SCOPE_ALL, targetAppVersions: [...SUPPORTED].sort(), historicalUnverified: [] });
});

test('release scope：显式 --target-app-version 2.24.0 只把目标作为通过条件，历史版本列为本轮未验证', () => {
  for (const argv of [['--target-app-version', '2.24.0'], ['--target-app-version=2.24.0']]) {
    const scope = resolveValidationScope(argv, SUPPORTED);
    assert.equal(scope.mode, VALIDATION_SCOPE_TARGETED);
    assert.deepEqual(scope.targetAppVersions, ['2.24.0']);
    assert.deepEqual(scope.historicalUnverified, ['2.23.0', '2.23.1']);
    const text = describeValidationScope(scope);
    assert.match(text, /定向 2\.24\.0/);
    assert.match(text, /本轮未验证历史版本：2\.23\.0、2\.23\.1/);
    assert.equal(text.includes('全部受支持版本'), false, '定向范围不得表述成全部版本通过');
    assert.deepEqual(recordedScopeFields(scope), { validationScope: VALIDATION_SCOPE_TARGETED, targetAppVersions: ['2.24.0'], historicalUnverified: ['2.23.0', '2.23.1'] });
  }
});

test('release scope：未知目标、缺值、重复声明、非法格式全部拒绝', () => {
  assert.throws(() => resolveValidationScope(['--target-app-version', '9.9.9'], SUPPORTED), /未知目标应用版本 9\.9\.9/);
  assert.throws(() => parseTargetAppVersionArg(['--target-app-version']), /需要一个明确的应用版本/);
  assert.throws(() => parseTargetAppVersionArg(['--target-app-version', '--strict']), /需要一个明确的应用版本/);
  assert.throws(() => parseTargetAppVersionArg(['--target-app-version', '2.24.0', '--target-app-version=2.24.0']), /只能指定一次/);
  assert.throws(() => parseTargetAppVersionArg(['--target-app-version', 'v2.24']), /版本格式无效/);
  assert.throws(() => resolveValidationScope([], []), /受支持应用版本清单|受支持版本清单/);
});

test('release scope：verified-release 范围读取（full/targeted/legacy/损坏）', () => {
  const full = readRecordedScope(FULL_RECORD, SUPPORTED);
  assert.equal(full.mode, VALIDATION_SCOPE_ALL);
  assert.equal(full.legacy, false);
  const targeted = readRecordedScope(TARGETED_RECORD, SUPPORTED);
  assert.equal(targeted.mode, VALIDATION_SCOPE_TARGETED);
  assert.deepEqual(targeted.targetAppVersions, ['2.24.0']);
  assert.deepEqual(targeted.historicalUnverified, ['2.23.0', '2.23.1']);
  const legacy = readRecordedScope({ digest: 'd'.repeat(64), version: '0.9.0' }, SUPPORTED);
  assert.equal(legacy.mode, VALIDATION_SCOPE_ALL);
  assert.equal(legacy.legacy, true);
  assert.throws(() => readRecordedScope({ validationScope: 'partial', targetAppVersions: ['2.24.0'] }, SUPPORTED), /validationScope 无效/);
  assert.throws(() => readRecordedScope({ validationScope: VALIDATION_SCOPE_TARGETED, targetAppVersions: [] }, SUPPORTED), /targetAppVersions/);
  assert.throws(() => readRecordedScope({ validationScope: VALIDATION_SCOPE_TARGETED, targetAppVersions: ['9.9.9'] }, SUPPORTED), /未知版本/);
  assert.throws(() => readRecordedScope({ validationScope: VALIDATION_SCOPE_ALL, targetAppVersions: ['2.24.0'] }, SUPPORTED), /未覆盖全部受支持版本/);
  assert.throws(() => readRecordedScope(undefined, SUPPORTED), /验证记录/);
});

test('release scope：定向 stamp 不能再当全版本打包；必须显式匹配 target', () => {
  // 不带 --target-app-version：拒绝
  assert.throws(() => resolvePackagingScope({ verification: TARGETED_RECORD, argv: [], supportedVersions: SUPPORTED }), /必须显式传 --target-app-version/);
  // 不匹配：拒绝
  assert.throws(() => resolvePackagingScope({ verification: TARGETED_RECORD, argv: ['--target-app-version', '2.23.0'], supportedVersions: SUPPORTED }), /不匹配/);
  // 未知：拒绝
  assert.throws(() => resolvePackagingScope({ verification: TARGETED_RECORD, argv: ['--target-app-version', '9.9.9'], supportedVersions: SUPPORTED }), /未知目标应用版本/);
  // 匹配：允许，且范围保持 targeted（不会被放大成全版本）
  const allowed = resolvePackagingScope({ verification: TARGETED_RECORD, argv: ['--target-app-version', '2.24.0'], supportedVersions: SUPPORTED });
  assert.equal(allowed.mode, VALIDATION_SCOPE_TARGETED);
  assert.equal(allowed.packagingTarget, '2.24.0');
  assert.deepEqual(allowed.targetAppVersions, ['2.24.0']);
  assert.deepEqual(allowed.historicalUnverified, ['2.23.0', '2.23.1']);
  assert.notEqual(allowed.mode, VALIDATION_SCOPE_ALL, '定向验证不能被当成全版本通过');
  const viaEquals = resolvePackagingScope({ verification: TARGETED_RECORD, argv: ['--target-app-version=2.24.0'], supportedVersions: SUPPORTED });
  assert.equal(viaEquals.mode, VALIDATION_SCOPE_TARGETED);
});

test('release scope：全量/旧式记录默认允许全版本打包，显式 target 也不缩小声明', () => {
  const fullNoFlag = resolvePackagingScope({ verification: FULL_RECORD, argv: [], supportedVersions: SUPPORTED });
  assert.equal(fullNoFlag.mode, VALIDATION_SCOPE_ALL);
  assert.equal(fullNoFlag.packagingTarget, undefined);
  const fullWithFlag = resolvePackagingScope({ verification: FULL_RECORD, argv: ['--target-app-version', '2.24.0'], supportedVersions: SUPPORTED });
  assert.equal(fullWithFlag.mode, VALIDATION_SCOPE_ALL, '全量验证记录不因 CLI target 而缩小为全版本声明');
  assert.deepEqual(fullWithFlag.targetAppVersions, [...SUPPORTED].sort());
  const legacy = resolvePackagingScope({ verification: { digest: 'e'.repeat(64), version: '0.9.0' }, argv: [], supportedVersions: SUPPORTED });
  assert.equal(legacy.mode, VALIDATION_SCOPE_ALL);
  assert.equal(legacy.legacy, true);
  assert.throws(() => resolvePackagingScope({ verification: FULL_RECORD, argv: ['--target-app-version', '9.9.9'], supportedVersions: SUPPORTED }), /未知目标应用版本/);
});

test('release scope：build-info.validationScope 如实记录范围与未验证历史版本', () => {
  const targetedScope = resolvePackagingScope({ verification: TARGETED_RECORD, argv: ['--target-app-version', '2.24.0'], supportedVersions: SUPPORTED });
  const payload = buildInfoPayload({ version: '0.9.0', build: 900, verification: TARGETED_RECORD, scope: targetedScope, node: '22.23.2' });
  assert.equal(payload.version, '0.9.0');
  assert.equal(payload.build, 900);
  assert.equal(payload.revision, 'a'.repeat(8));
  assert.equal(payload.sourceDigest, TARGETED_RECORD.digest);
  assert.equal(payload.verifiedAt, TARGETED_RECORD.at);
  assert.equal(payload.signing, 'local ad-hoc; not notarized');
  assert.deepEqual(payload.validationScope, {
    scope: VALIDATION_SCOPE_TARGETED,
    targetAppVersions: ['2.24.0'],
    historicalUnverified: ['2.23.0', '2.23.1'],
    packagingTarget: '2.24.0',
  });
  const fullPayload = buildInfoPayload({ version: '0.9.0', build: 900, verification: FULL_RECORD, scope: resolvePackagingScope({ verification: FULL_RECORD, argv: [], supportedVersions: SUPPORTED }) });
  assert.equal(fullPayload.validationScope.scope, VALIDATION_SCOPE_ALL);
  assert.deepEqual(fullPayload.validationScope.historicalUnverified, []);
  assert.equal('packagingTarget' in fullPayload.validationScope, false);
  assert.throws(() => buildInfoPayload({ build: 1, verification: FULL_RECORD, scope: targetedScope }), /需要 version/);
  assert.throws(() => buildInfoPayload({ version: '0.9.0', verification: {}, scope: targetedScope }), /需要已验证记录/);
  assert.throws(() => buildInfoPayload({ version: '0.9.0', verification: FULL_RECORD }), /需要发布范围/);
});

test('release scope：verify/package-mac 顶层不执行，可安全 import（脚本只在直接运行时生效）', async () => {
  const verifyModule = await import('../tools/verify.mjs');
  const packageModule = await import('../tools/package-mac.mjs');
  assert.equal(typeof verifyModule, 'object');
  assert.equal(typeof packageModule, 'object');
});

test('release scope：npm scripts 保留全版本默认，并新增明确的 2.24.0 脚本', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['package:mac'], 'npm run verify && node tools/package-mac.mjs', '默认打包仍必须走全版本 verify');
  assert.equal(pkg.scripts['package:mac:full'], 'npm run verify && node tools/package-mac.mjs');
  assert.equal(pkg.scripts['verify:2.24.0'], 'node tools/verify.mjs --target-app-version 2.24.0');
  assert.equal(pkg.scripts['package:mac:2.24.0'], 'npm run verify:2.24.0 && node tools/package-mac.mjs --target-app-version 2.24.0');
  assert.equal(pkg.scripts['verify'], 'node tools/verify.mjs', '未带参数的 verify 仍默认全版本');
});
