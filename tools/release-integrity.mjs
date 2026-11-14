import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';

/** Dictionary maintenance files are neither release inputs nor packaged resources. */
export function includeDictionaryPath(path) {
  const parts = path.split('/');
  return parts[0] !== 'dict' || !parts.slice(1).some(part => part.startsWith('.'));
}

/**
 * 源码摘要：发布门禁的唯一真源。
 * 注意：tools/ 与 test/ 也计入，修改发布脚本本身同样会让旧 .cache/verified-release.json 失效，
 * 必须重新执行 `npm run verify` 才能再次打包（失败关闭，而不是静默放行）。
 */
export async function sourceDigest(root) {
  const files = [];
  async function walk(relative) {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (!includeDictionaryPath(path)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  for (const directory of ['src','runtime','native','tools','test','dict','ui-strings','assets','licenses']) await walk(directory);
  if (await exists(join(root, 'vendor'))) await walk('vendor');
  files.push('package.json','package-lock.json','tsconfig.json','README.md','THIRD_PARTY_NOTICES.md');
  for (const doc of ['LICENSE', 'SECURITY.md']) {
    if (await exists(join(root, doc))) files.push(doc);
  }
  const hash = createHash('sha256'); for (const file of files.sort()) hash.update(file).update('\0').update(await readFile(join(root,file))).update('\0'); return hash.digest('hex');
}

async function exists(path) { try { await stat(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }

/** 流式计算文件 sha256，避免把 35MB DMG 整体读进内存。 */
export async function fileSha256(path) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 与 `shasum -a 256 <file>` 输出完全一致的 sidecar 文本（两个空格 + basename + 换行）。 */
export function formatSha256Sidecar(hash, fileName) {
  if (!/^[0-9a-f]{64}$/.test(String(hash))) throw new Error(`sha256 必须为 64 位小写十六进制：${hash}`);
  if (!fileName || String(fileName).includes('/')) throw new Error(`sha256 校验文件只记录文件名（不含路径）：${fileName}`);
  return `${hash}  ${fileName}\n`;
}

/** 解析 `shasum -a 256` 风格 sidecar；容忍 `*` 二进制标记，拒绝多行/坏格式/文件名不符。 */
export function parseSha256Sidecar(text, expectedFileName) {
  const lines = String(text).split(/\r?\n/).filter(line => line.trim());
  if (lines.length !== 1) throw new Error(`sha256 校验文件应只有一行，实际 ${lines.length} 行`);
  const match = lines[0].match(/^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/);
  if (!match) throw new Error('sha256 校验文件格式无效：应为 "<64位 sha256>  <文件名>"');
  const hash = match[1].toLowerCase(), fileName = match[2];
  if (expectedFileName && fileName !== expectedFileName) throw new Error(`sha256 校验文件记录的文件名不符：${fileName} ≠ ${expectedFileName}`);
  return { hash, fileName };
}

/** 计算并覆盖写入 `<file>.sha256`。用于打包后发布，旧 sidecar 必须被替换而不是追加。 */
export async function writeSha256Sidecar(filePath, { sidecarPath = `${filePath}.sha256` } = {}) {
  const hash = await fileSha256(filePath);
  const text = formatSha256Sidecar(hash, basename(filePath));
  await writeFile(sidecarPath, text, 'utf8');
  return { hash, sidecarPath, text };
}

/** 复核 sidecar 与实际文件：格式、文件名、哈希三项都必须一致，否则抛错中止。 */
export async function verifySha256Sidecar(filePath, { sidecarPath = `${filePath}.sha256` } = {}) {
  const parsed = parseSha256Sidecar(await readFile(sidecarPath, 'utf8'), basename(filePath));
  const actual = await fileSha256(filePath);
  if (parsed.hash !== actual) throw new Error(`sha256 校验失败：${basename(sidecarPath)} 记录 ${parsed.hash}，实际 ${actual}`);
  return { ok: true, hash: actual, sidecarPath, text: formatSha256Sidecar(actual, basename(filePath)) };
}

/**
 * 发布一致性检查（只读）：把“当前源码 / 已验证记录 / 成品 sidecar / 成品实际哈希 / 验收摘要 / 已安装 build-info”
 * 串起来核对。开发阶段默认只警告（避免历史产物阻断日常验证）；调用方传 strict=true（CLI --strict）时任何警告即失败。
 */
export async function checkReleaseConsistency({
  root,
  digest,
  strict = false,
  installedApp = '/Applications/GravityBox.app',
  stagingApp = join(root, 'build/dmg-stage/GravityBox.app'),
  summaryPath = join(root, '文档/当前版本验收摘要.json'),
  outputDir = join(root, '成品'),
} = {}) {
  if (!root) throw new Error('checkReleaseConsistency 需要 root');
  const warnings = [];
  const warn = (code, message) => warnings.push({ code, message });
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const currentDigest = digest ?? await sourceDigest(root);
  const dmg = join(outputDir, `GravityBox-${version}-arm64.dmg`);
  const sidecar = `${dmg}.sha256`;
  let dmgHash = null;
  if (await exists(dmg)) dmgHash = await fileSha256(dmg);
  else warn('DMG_MISSING', `未找到成品 DMG：${dmg.replace(root, '<root>/')}；开发阶段可忽略，发布前必须存在`);

  if (dmgHash) {
    if (await exists(sidecar)) {
      try {
        const parsed = parseSha256Sidecar(await readFile(sidecar, 'utf8'), basename(dmg));
        if (parsed.hash !== dmgHash) warn('SIDECAR_HASH_MISMATCH', `成品 sidecar 哈希与 DMG 实际哈希不一致：sidecar ${parsed.hash.slice(0, 12)}… ≠ 实际 ${dmgHash.slice(0, 12)}…（历史 sidecar 未更新？重新打包会自动覆盖）`);
      } catch (error) { warn('SIDECAR_INVALID', `成品 sidecar 不可用：${error.message}`); }
    } else warn('SIDECAR_MISSING', `缺少 ${basename(sidecar)}，用户无法校验发布包（打包时 package-mac 会自动生成）`);
  }

  const verifiedPath = join(root, '.cache/verified-release.json');
  let verified = null;
  try { verified = JSON.parse(await readFile(verifiedPath, 'utf8')); } catch { warn('VERIFIED_MISSING', '缺少 .cache/verified-release.json：请先执行 npm run verify 再打包'); }
  if (verified) {
    if (verified.version !== version) warn('VERIFIED_VERSION_MISMATCH', `已验证记录版本 ${verified.version} 与当前 package.json ${version} 不一致`);
    if (verified.digest !== currentDigest) warn('VERIFIED_STALE', `已验证记录 digest ${String(verified.digest).slice(0, 12)}… 与当前源码 digest ${currentDigest.slice(0, 12)}… 不一致：源码在验证后发生变化，需重新 npm run verify`);
  }

  let summary = null;
  try { summary = JSON.parse(await readFile(summaryPath, 'utf8')); } catch { warn('SUMMARY_MISSING', '未找到 文档/当前版本验收摘要.json，跳过摘要一致性检查'); }
  if (summary) {
    if (dmgHash && summary.dmgSHA256 && String(summary.dmgSHA256).toLowerCase() !== dmgHash) warn('SUMMARY_DMG_MISMATCH', `验收摘要 dmgSHA256 ${String(summary.dmgSHA256).slice(0, 12)}… 与成品 DMG 实际 ${dmgHash.slice(0, 12)}… 不一致（摘要为历史产物，最终发版前需更新）`);
    if (summary.sourceDigest && summary.sourceDigest !== currentDigest) warn('SUMMARY_SOURCE_STALE', `验收摘要 sourceDigest ${String(summary.sourceDigest).slice(0, 12)}… 与当前源码 digest ${currentDigest.slice(0, 12)}… 不一致（摘要为历史产物）`);
    if (summary.revision && summary.revision !== currentDigest.slice(0, 8)) warn('SUMMARY_REVISION_STALE', `验收摘要 revision ${summary.revision} 与当前源码 revision ${currentDigest.slice(0, 8)} 不一致（摘要为历史产物）`);
    if (summary.version && summary.version !== version) warn('SUMMARY_VERSION_MISMATCH', `验收摘要版本 ${summary.version} 与当前 package.json ${version} 不一致`);
  }

  for (const [label, app] of [['已安装应用', installedApp], ['暂存应用', stagingApp]]) {
    const buildInfoPath = join(app, 'Contents/Resources/build-info.json');
    if (!await exists(buildInfoPath)) { warn('BUILD_INFO_MISSING', `未找到${label} build-info.json：${buildInfoPath}；跳过 revision/sourceDigest 比对`); continue; }
    let info = null;
    try { info = JSON.parse(await readFile(buildInfoPath, 'utf8')); } catch (error) { warn('BUILD_INFO_INVALID', `${label} build-info.json 无法解析：${error.message}`); continue; }
    if (!verified) continue;
    if (info.sourceDigest !== verified.digest) warn('BUILD_INFO_DIGEST_MISMATCH', `${label} build-info.sourceDigest ${String(info.sourceDigest).slice(0, 12)}… 与 .cache/verified-release.json ${String(verified.digest).slice(0, 12)}… 不一致`);
    if (info.revision !== String(verified.digest).slice(0, 8)) warn('BUILD_INFO_REVISION_MISMATCH', `${label} build-info.revision ${info.revision} 与已验证记录 revision ${String(verified.digest).slice(0, 8)} 不一致`);
    if (info.version !== verified.version) warn('BUILD_INFO_VERSION_MISMATCH', `${label} build-info.version ${info.version} 与已验证记录版本 ${verified.version} 不一致`);
  }

  return { ok: strict ? warnings.length === 0 : true, strict, version, dmg, dmgHash, sidecar, warnings };
}

/** 把 checkReleaseConsistency 的结果渲染成可打印行；CLI 与测试共用同一份文案。 */
export function renderReleaseConsistency(result) {
  const lines = result.warnings.map(warning => `发布一致性警告：[${warning.code}] ${warning.message}`);
  if (!lines.length) lines.push('发布一致性检查通过：sidecar / DMG 实际哈希 / 验收摘要 / build-info / 已验证记录一致');
  else if (result.strict) lines.push(`发布一致性检查未通过（--strict，${result.warnings.length} 项警告）`);
  else lines.push(`发布一致性警告 ${result.warnings.length} 项（开发阶段不阻断；最终发版前修复后以 --strict 复核）`);
  return lines;
}

/** Bind every packaged script and the build runtime to the verified source snapshot. */
export async function listCompiledScripts(root) {
  const results = [];
  async function walk(relative = '') {
    for (const entry of await readdir(join(root, 'src', relative), { withFileTypes: true })) {
      const next = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile() && entry.name.endsWith('.ts')) results.push(next.replace(/\.ts$/, '.js').split('\\').join('/'));
    }
  }
  await walk();
  return results.concat('engine.js').sort();
}

export async function collectReleaseArtifacts(root) {
  const names = await listCompiledScripts(root);
  const scripts={};for(const name of names)scripts[name]=await fileSha256(join(root,'dist',name));
  return {scripts,nodeSha256:await fileSha256(process.execPath)};
}
export async function assertReleaseArtifacts(root,expected) {
  if(!expected?.scripts||!expected.nodeSha256)throw Error('缺少发行脚本清单，请重新验证');
  const actual=await collectReleaseArtifacts(root);
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('发行脚本或运行时已变化，请重新验证');
}
