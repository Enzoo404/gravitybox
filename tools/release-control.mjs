import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fileSha256, parseSha256Sidecar, sourceDigest, verifySha256Sidecar } from './release-integrity.mjs';

const run = promisify(execFile);

export function validateVersion(tag, pkg, lock) {
  if (tag !== tag.trim() || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw Error('需要 vX.Y.Z 正式版本标签');
  const version = tag.slice(1), parts = version.split('.').map(Number);
  if (parts.some(n => !Number.isSafeInteger(n)) || parts[1] > 99 || parts[2] > 99 || !Number.isSafeInteger(parts[0] * 10000 + parts[1] * 100 + parts[2])) throw Error('版本超出当前 macOS build 编号支持范围');
  if (pkg.version !== version || lock.version !== version || lock.packages?.['']?.version !== version) throw Error('标签、package.json 与 package-lock.json 版本不一致');
  return version;
}

export function releaseAssetNames(version) {
  const dmg = `GravityBox-${version}-arm64.dmg`;
  return [dmg, `${dmg}.sha256`, 'release-manifest.json'];
}

export function assertNewRelease(release) {
  if (release) throw Error('该版本已有 Release（含草稿），禁止重复构建或覆盖附件；请先核对已有草稿或使用新版本号');
}

export function validateDraft(release, tag) {
  if (!release || release.draft !== true || release.prerelease || release.tag_name !== tag || !Number.isSafeInteger(release.id)) throw Error('只允许发布指定标签的正式版本草稿；已公开版本不可重发');
  const expected = releaseAssetNames(tag.slice(1)).sort();
  const assets = release.assets ?? [];
  if (JSON.stringify(assets.map(a => a.name).sort()) !== JSON.stringify(expected) || assets.some(a => a.state !== 'uploaded' || !(a.size > 0))) throw Error('草稿附件不完整、重复或包含非预期文件');
  return release;
}

export function requireAcceptance(confirmed, expectedHash) {
  if (confirmed !== 'true' || expectedHash?.length !== 64 || !/^[0-9a-f]{64}$/i.test(expectedHash)) throw Error('需要明确确认实际验收，并提供所验收 DMG 的完整 SHA-256');
  return expectedHash.toLowerCase();
}

// Only GitHub's API receives the token. HTTP/network/authentication failures never mean "no release".
export function githubClient(repository, token, fetchImpl = fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) throw Error('缺少 GitHub 仓库或授权令牌');
  return async (path, { method = 'GET', body, allowMissing = false } = {}) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok) throw Error(`GitHub API ${method} ${path} 失败 (${response.status})`);
    return response.json();
  };
}

async function git(root, ...args) { return (await run('git', args, { cwd: root })).stdout.trim(); }

export async function releaseContext(root, tag, api, { requireHead = false } = {}) {
  // Validate the ref before using it in git or API calls.
  validateVersion(tag, { version: tag.slice(1) }, { version: tag.slice(1), packages: { '': { version: tag.slice(1) } } });
  const commit = await git(root, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
  if (requireHead && commit !== await git(root, 'rev-parse', 'HEAD')) throw Error('当前工作区不是标签对应的提交');
  if (requireHead && await git(root, 'status', '--porcelain')) throw Error('发布工作区存在未提交修改，已中止');
  const remote = await api(`commits/${encodeURIComponent(tag)}`);
  if (remote.sha !== commit) throw Error('远端标签提交发生变化，已中止');
  const pkg = JSON.parse(await git(root, 'show', `${commit}:package.json`));
  const lock = JSON.parse(await git(root, 'show', `${commit}:package-lock.json`));
  const version = validateVersion(tag, pkg, lock);
  if (requireHead) validateVersion(tag, JSON.parse(await readFile(join(root, 'package.json'))), JSON.parse(await readFile(join(root, 'package-lock.json'))));
  return { tag, commit, version };
}

export async function writeReleaseManifest(root, context) {
  const { version, commit, tag } = context;
  const stamp = JSON.parse(await readFile(join(root, '.cache/verified-release.json')));
  const buildInfo = JSON.parse(await readFile(join(root, 'build/dmg-stage/GravityBox.app/Contents/Resources/build-info.json')));
  const digest = await sourceDigest(root);
  if (stamp.version !== version || stamp.digest !== digest || buildInfo.version !== version || buildInfo.sourceDigest !== digest) throw Error('包内版本、验证记录或源码摘要不一致，禁止生成发布清单');
  const dmgName = releaseAssetNames(version)[0];
  const { hash } = await verifySha256Sidecar(join(root, '成品', dmgName));
  const manifest = { schema: 1, tag, version, commit, sourceDigest: digest, dmg: { name: dmgName, sha256: hash }, signing: buildInfo.signing };
  await writeFile(join(root, '成品/release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export async function verifyAcceptedFiles(directory, context, expectedHash) {
  const [dmgName, sidecarName, manifestName] = releaseAssetNames(context.version);
  const manifest = JSON.parse(await readFile(join(directory, manifestName)));
  if (manifest.schema !== 1 || manifest.tag !== context.tag || manifest.version !== context.version || manifest.commit !== context.commit || !/^[0-9a-f]{64}$/.test(manifest.sourceDigest ?? '') || manifest.dmg?.name !== dmgName) throw Error('发布清单与版本标签或提交不一致');
  const sidecar = parseSha256Sidecar(await readFile(join(directory, sidecarName), 'utf8'), dmgName);
  const actual = await fileSha256(join(directory, dmgName));
  if (actual !== expectedHash || actual !== manifest.dmg.sha256 || actual !== sidecar.hash) throw Error('实际 DMG、校验文件、发布清单或人工验收的 SHA-256 不一致');
  return actual;
}

function assetSnapshot(release) {
  return JSON.stringify({ id: release.id, tag: release.tag_name, assets: release.assets.map(a => ({ id: a.id, name: a.name, size: a.size, digest: a.digest, updated_at: a.updated_at })).sort((a, b) => a.name.localeCompare(b.name)) });
}

export async function publishAcceptedDraft({ api, directory, context, expectedHash }) {
  const path = `releases/tags/${encodeURIComponent(context.tag)}`;
  const draft = validateDraft(await api(path), context.tag);
  const hash = await verifyAcceptedFiles(directory, context, expectedHash);
  for (const asset of draft.assets) {
    if (asset.digest !== `sha256:${await fileSha256(join(directory, asset.name))}`) throw Error('GitHub 草稿附件与下载验收文件的摘要不一致或缺失');
  }
  // Detect replacement/removal while the downloaded files were being verified.
  const current = validateDraft(await api(`releases/${draft.id}`), context.tag);
  if (assetSnapshot(current) !== assetSnapshot(draft)) throw Error('草稿附件在验收校验期间发生变化，已中止发布');
  const remote = await api(`commits/${encodeURIComponent(context.tag)}`);
  if (remote.sha !== context.commit) throw Error('远端标签提交发生变化，已中止');
  const published = await api(`releases/${draft.id}`, { method: 'PATCH', body: { draft: false, make_latest: 'true' } });
  if (published.draft !== false || published.tag_name !== context.tag) throw Error('发布响应不符合预期，请检查 Release 状态');
  return { url: published.html_url, sha256: hash };
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const mode = process.argv[2], tag = process.env.RELEASE_TAG ?? '';
  const api = githubClient(process.env.GITHUB_REPOSITORY ?? '', process.env.GH_TOKEN);
  if (!['preflight', 'manifest', 'prepublish', 'publish'].includes(mode)) throw Error('使用 preflight / manifest / prepublish / publish');
  const expectedHash = ['prepublish', 'publish'].includes(mode) ? requireAcceptance(process.env.ACCEPTANCE_CONFIRMED, process.env.EXPECTED_DMG_SHA256) : undefined;
  const context = await releaseContext(root, tag, api, { requireHead: ['preflight', 'manifest'].includes(mode) });
  if (mode === 'preflight') {
    assertNewRelease(await api(`releases/tags/${encodeURIComponent(tag)}`, { allowMissing: true }));
    console.log(`检查通过：${tag} / ${context.commit}；仅允许创建新的草稿`);
  } else if (mode === 'manifest') {
    console.log(JSON.stringify(await writeReleaseManifest(root, context)));
  } else if (mode === 'prepublish') {
    validateDraft(await api(`releases/tags/${encodeURIComponent(tag)}`), tag);
    console.log(`草稿检查通过：${tag}；仍需校验实际下载的附件`);
  } else {
    if (!process.env.RELEASE_DOWNLOAD_DIR) throw Error('缺少草稿附件下载目录');
    console.log(JSON.stringify(await publishAcceptedDraft({ api, directory: resolve(process.env.RELEASE_DOWNLOAD_DIR), context, expectedHash })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(`[release-control] ${error.message}`); process.exitCode = 1; });
