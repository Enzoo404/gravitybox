import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { sourceDigest, collectReleaseArtifacts, checkReleaseConsistency, renderReleaseConsistency } from './release-integrity.mjs';
import { describeValidationScope, parseTargetAppVersionArg, recordedScopeFields, resolveValidationScope, VALIDATION_SCOPE_TARGETED } from './release-scope.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), run = promisify(execFile);
const argv = process.argv.slice(2);

/**
 * 发布验证。默认（无 --target-app-version）仍对**全部受支持版本**做严格门禁，缺源即失败；
 * 只有显式 `--target-app-version <x.y.z>` 才进入定向范围：目标版本作为发布通过条件，其余受支持版本
 * 在输出与 verified-release 中明确记为“本轮未验证”，绝不冒充通过或降低门禁。
 */
async function main() {
  /* 先做参数格式/重复校验，避免跑完构建才发现 CLI 写错。 */
  const earlyTarget = parseTargetAppVersionArg(argv);
  const initialDigest = await sourceDigest(root);
  const version = JSON.parse(await readFile(join(root, 'package.json'))).version;
  const out = join(root, '质检报告', `${version}-改造验收`); await mkdir(out, { recursive: true });
  async function step(name, binary, args) {
    process.stdout.write(`检查：${name}\n`);
    try {
      const result = await run(binary, args, { cwd: root, maxBuffer: 4e6 });
      await writeFile(join(out, `${name}.log`), result.stdout + result.stderr);
    } catch (error) {
      const detail = String(error.stdout ?? '') + String(error.stderr ?? '');
      await writeFile(join(out, `${name}.log`), detail);
      if (detail.trim()) process.stderr.write(`\n--- [${name} 错误详情] ---\n${detail}\n------------------------\n`);
      throw new Error(`${name} 未通过，见质检报告`);
    }
  }
  await step('构建', process.execPath, [join(root, 'node_modules/typescript/bin/tsc')]);
  await step('运行时', process.execPath, [join(root, 'tools/copy-runtime.mjs')]);
  const tests = (await readdir(join(root, 'test'))).filter(name => name.endsWith('.test.mjs')).map(name => join(root, 'test', name));
  await step('单元与集成', process.execPath, ['--test', ...tests]);
  await step('浏览器回归', process.execPath, [join(root, 'test/browser.mjs')]);
  await mkdir(join(root, '.cache'), { recursive: true });
  await step('Swift检查', '/usr/bin/swiftc', ['-O', '-parse-as-library', '-target', 'arm64-apple-macosx14.0', '-framework', 'Cocoa', '-framework', 'ServiceManagement', '-framework', 'Security', '-framework', 'ApplicationServices', ...(await readdir(join(root, 'native'))).filter(name => name.endsWith('.swift')).map(name => join(root, 'native', name)), '-o', join(root, '.cache/GravityBox-native-verified')]);

  const { SUPPORTED_BUNDLES } = await import(pathToFileURL(join(root, 'dist', 'bundle.js')).href);
  const supportedVersions = [...SUPPORTED_BUNDLES.keys()];
  const scope = resolveValidationScope(argv, supportedVersions);
  if (earlyTarget !== undefined && !scope.targetAppVersions.includes(earlyTarget)) throw new Error(`内部错误：目标版本 ${earlyTarget} 未进入验证范围`);
  process.stdout.write(`[verify] ${describeValidationScope(scope)}\n`);

  /* 只有本次发布范围内（定向=目标版本；默认=全部受支持版本）的提取结果与门禁才是通过条件。 */
  const extracted = new Set((await readdir(join(root, 'ui-strings'))).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)));
  const uncovered = scope.targetAppVersions.filter(targetVersion => !extracted.has(targetVersion));
  if (uncovered.length) throw new Error(`词典门禁缺少界面串提取：${uncovered.join('、')}；请先运行 node tools/extract-ui-strings.mjs --version <版本>`);
  for (const targetVersion of scope.targetAppVersions) {
    const file = `${targetVersion}.json`, expected = SUPPORTED_BUNDLES.get(targetVersion);
    const gateArgs = [join(root, 'tools/coverage-report.mjs'), '--strings', join(root, 'ui-strings', file), '--gate', '--out', join(out, `coverage-${file}`)];
    if (expected) gateArgs.push('--expect-bundle-sha256', expected);
    const noVendor = argv.includes('--no-vendor') || process.env.GRAVITYBOX_NO_VENDOR === '1';
    const cachedBundle = join(root, 'vendor', 'antigravity', targetVersion, 'main.js');
    if (!noVendor && existsSync(cachedBundle)) {
      gateArgs.push('--bundle', cachedBundle);
    } else {
      gateArgs.push('--no-vendor');
      process.stdout.write(`[verify] ${targetVersion} 启用免 vendor 校验模式（基于 ui-strings/${file} 验证词典）\n`);
    }
    await step(`词典门禁-${targetVersion}`, process.execPath, gateArgs);
  }
  for (const historical of scope.historicalUnverified) {
    process.stdout.write(`[verify] 词典门禁-${historical}：本轮未验证（定向发布 ${scope.targetAppVersions.join('、')}），不视为通过\n`);
  }

  const digest = await sourceDigest(root); if (digest !== initialDigest) throw new Error('验证期间源码发生变化，请重新检查');
  await mkdir(join(root, '.cache'), { recursive: true });
  await writeFile(join(root, '.cache/verified-release.json'), JSON.stringify({
    digest,
    artifacts: await collectReleaseArtifacts(root),
    nativeBinarySha256: createHash('sha256').update(await readFile(join(root, '.cache/GravityBox-native-verified'))).digest('hex'),
    at: new Date().toISOString(),
    version,
    ...recordedScopeFields(scope),
  }));

  /* 发布一致性：当前源码 / 已验证记录 / 成品 DMG sidecar 与实际哈希 / 验收摘要 / 已安装 build-info。
     开发阶段默认只警告（历史摘要与旧 sidecar 不应阻断日常验证）；最终发版加 --strict 让任何不一致失败。 */
  const strict = argv.includes('--strict');
  const release = await checkReleaseConsistency({ root, digest, strict });
  for (const line of renderReleaseConsistency(release)) process.stdout.write(line + '\n');
  if (strict && release.warnings.length) throw new Error(`发布一致性检查未通过（--strict，${release.warnings.length} 项警告），见上方明细`);
  if (scope.mode === VALIDATION_SCOPE_TARGETED) process.stdout.write(`[verify] 发布通过仅覆盖 ${scope.targetAppVersions.join('、')}；${scope.historicalUnverified.join('、') || '无历史版本'} 本轮未验证，不得宣称通过。\n`);
  process.stdout.write('全部自动检查通过\n');
}

const invokedDirectly = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(error => { console.error(`[verify] ${error?.message ?? error}`); process.exitCode = 1; });
}
