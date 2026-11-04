import { mkdir, cp, copyFile, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { sourceDigest, includeDictionaryPath, assertReleaseArtifacts, writeSha256Sidecar, verifySha256Sidecar } from './release-integrity.mjs';
import { buildInfoPayload, describeValidationScope, resolvePackagingScope } from './release-scope.mjs';
const run = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));

/**
 * 打包。默认要求 `.cache/verified-release.json` 是**全量**验证记录；若记录为定向（targeted）范围，
 * 必须显式传 `--target-app-version <x.y.z>` 且与记录一致，否则拒绝打包——
 * 不能把单版本验证 stamp 当全版本通过。build-info.json 始终写入 validationScope 供发布一致性核对。
 */
async function main() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'))), version = pkg.version;
  const verification = JSON.parse(await readFile(join(root, '.cache/verified-release.json')));
  if (verification.digest !== await sourceDigest(root) || verification.version !== version) throw new Error('源码已变化或未通过检查，请先运行 npm run verify');
  await assertReleaseArtifacts(root,verification.artifacts);
  const { SUPPORTED_BUNDLES } = await import(pathToFileURL(join(root, 'dist', 'bundle.js')).href);
  const supportedVersions = [...SUPPORTED_BUNDLES.keys()];
  const scope = resolvePackagingScope({ verification, argv: process.argv.slice(2), supportedVersions });
  process.stdout.write(`[package-mac] ${describeValidationScope(scope)}\n`);
  if (!process.versions.node.startsWith('22.') || process.arch !== 'arm64') throw new Error('请使用 Apple Silicon 的 Node 22 构建自包含包');
  const output = join(root, '成品'), stage = join(root, 'build', 'dmg-stage'), app = join(stage, 'GravityBox.app'), resources = join(app, 'Contents/Resources');
  await rm(stage, { recursive: true, force: true }); await mkdir(join(app, 'Contents/MacOS'), { recursive: true }); await mkdir(join(resources, 'runtime'), { recursive: true }); await mkdir(output, { recursive: true }); await writeFile(join(stage, '.metadata_never_index'), '');
  await copyFile(process.execPath, join(resources, 'runtime/node'));
  await run('/usr/bin/strip', ['-x', join(resources, 'runtime/node')]);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', join(resources, 'runtime/node')]);
  await copyFile(join(root, 'licenses/NODE-LICENSE'), join(resources, 'runtime/LICENSE'));
  await mkdir(join(resources, 'core/dist'), { recursive: true });
  await mkdir(join(resources, 'icons'), { recursive: true }); await copyFile(join(root, 'assets/icons/menu-connected.png'), join(resources, 'icons/menu-connected.png'));
  await cp(join(root, 'assets/model-icons'), join(resources, 'model-icons'), { recursive: true });
  // Copy only build outputs derived from the current source list; stale experimental scripts stay out.
  for (const name of (await readdir(join(root, 'src'))).filter(n => n.endsWith('.ts')).map(n => n.replace(/\.ts$/, '.js')).concat('engine.js')) await copyFile(join(root, 'dist', name), join(resources, 'core/dist', name));
  await mkdir(join(resources,'core/assets'),{recursive:true});
  await copyFile(join(root,'assets/model-catalog.json'),join(resources,'core/assets/model-catalog.json'));
  await copyFile(join(root,'assets/model-catalog.json'),join(resources,'model-catalog.json'));
  await cp(join(root, 'dict'), join(resources, 'core/dict'), { recursive: true, filter: source => includeDictionaryPath(join('dict', relative(join(root, 'dict'), source))) }); await writeFile(join(resources, 'core/package.json'), '{"type":"module"}\n');
  for (const [from, to] of [['README.md', '使用说明.md'], ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'], ['assets/AppIcon.icns', 'AppIcon.icns']]) await copyFile(join(root, from), join(resources, to));
  const build = version.split('.').map(Number).reduce((a, n) => a * 100 + n, 0);
  await writeFile(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>GravityBox</string><key>CFBundleIdentifier</key><string>local.gravitybox.app</string><key>CFBundleName</key><string>GravityBox</string><key>CFBundleDisplayName</key><string>GravityBox</string><key>CFBundleIconFile</key><string>AppIcon</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${build}</string><key>LSMinimumSystemVersion</key><string>14.0</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/></dict></plist>`);
  const nativeBinary = join(root, '.cache/GravityBox-native-verified');
  if (!verification.nativeBinarySha256 || createHash('sha256').update(await readFile(nativeBinary)).digest('hex') !== verification.nativeBinarySha256) throw new Error('发行编译产物未通过校验，请先运行完整验证');
  await copyFile(nativeBinary, join(app, 'Contents/MacOS/GravityBox'));
  await writeFile(join(resources, 'build-info.json'), JSON.stringify(buildInfoPayload({ version, build, verification, scope, node: process.versions.node }), null, 2));
  await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app]); await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  await run('/bin/ln', ['-s', '/Applications', join(stage, 'Applications')]); await copyFile(join(root, 'README.md'), join(stage, '安装与使用说明.md'));
  const dmg = join(output, `GravityBox-${version}-arm64.dmg`); await run('/usr/bin/hdiutil', ['create', '-ov', '-volname', 'GravityBox', '-srcfolder', stage, '-format', 'ULFO', dmg], { maxBuffer: 2e6 }); await run('/usr/bin/hdiutil', ['verify', dmg], { maxBuffer: 2e6 });
  // hdiutil 校验通过后生成并复核 sidecar（与 `shasum -a 256` 完全一致，覆盖旧文件）；复核失败立即中止，避免发布不可校验的包。
  const sidecar = await writeSha256Sidecar(dmg); const sidecarCheck = await verifySha256Sidecar(dmg); if (sidecarCheck.hash !== sidecar.hash) throw new Error('DMG sha256 校验文件写入后复核不一致，已中止发布');
  // Keep one staging app for final installed-app acceptance, not a duplicate release app.
  console.log(JSON.stringify({ app, dmg, sha256: sidecarCheck.hash, sha256File: sidecar.sidecarPath, signing: 'local ad-hoc; not notarized', stagingOnly: true, validationScope: { scope: scope.mode, targetAppVersions: scope.targetAppVersions, historicalUnverified: scope.historicalUnverified } }));
}

const invokedDirectly = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(error => { console.error(`[package-mac] ${error?.message ?? error}`); process.exitCode = 1; });
}
