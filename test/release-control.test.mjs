import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileSha256, writeSha256Sidecar, sourceDigest } from '../tools/release-integrity.mjs';
import { validateVersion, releaseAssetNames, assertNewRelease, findReleaseByTag, validateDraft, requireAcceptance, githubClient, releaseContext, writeReleaseManifest, verifyAcceptedFiles, publishAcceptedDraft } from '../tools/release-control.mjs';

const version = '1.0.1', tag = 'v1.0.1', commit = 'a'.repeat(40);
const pkg = { version }, lock = { version, packages: { '': { version } } };

test('发版版本必须与标签及锁文件一致，拒绝预发布格式及 build 编号冲突', () => {
  assert.equal(validateVersion(tag, pkg, lock), version);
  for (const bad of ['1.0.1', 'v01.0.1', 'v1.0.1-beta.1', 'v1.0.1\n', 'v1.100.0', 'v1.0.100']) assert.throws(() => validateVersion(bad, pkg, lock));
  assert.throws(() => validateVersion(tag, { version: '1.0.0' }, lock), /不一致/);
  assert.throws(() => validateVersion(tag, pkg, { ...lock, packages: { '': { version: '1.0.0' } } }), /不一致/);
});

test('已有正式版或草稿均拒绝覆盖，网络/权限错误不能误判为不存在', async () => {
  assert.doesNotThrow(() => assertNewRelease(null));
  for (const draft of [false, true]) assert.throws(() => assertNewRelease({ draft }), /禁止/);
  const client = status => githubClient('owner/repo', 'test-token', async () => ({ status, ok: status === 200, json: async () => ({}) }));
  assert.equal(await client(404)('releases/tags/v1.0.1', { allowMissing: true }), null);
  for (const status of [401, 403, 429, 500]) await assert.rejects(client(status)('releases/tags/v1.0.1', { allowMissing: true }), new RegExp(String(status)));
  await assert.rejects(githubClient('owner/repo', 'test-token', async () => { throw Error('offline'); })('releases/tags/v1.0.1', { allowMissing: true }), /offline/);
});

test('公开发布必须显式确认且提供完整验收哈希', () => {
  assert.equal(requireAcceptance('true', 'A'.repeat(64)), 'a'.repeat(64));
  for (const [confirmed, hash] of [['false', 'a'.repeat(64)], ['true', 'abc'], [undefined, undefined]]) assert.throws(() => requireAcceptance(confirmed, hash), /实际验收/);
});

test('草稿通过分页列表查询，不能将只返回正式版本的 tag 接口 404 当作不存在', async () => {
  const calls = [], draft = { id: 123, tag_name: tag, draft: true };
  const api = async path => {
    calls.push(path);
    if (path === 'releases?per_page=100&page=1') return Array.from({ length: 100 }, (_, i) => ({ tag_name: `other-${i}` }));
    if (path === 'releases?per_page=100&page=2') return [draft];
    throw Error('不应调用按标签的正式发布接口');
  };
  assert.equal(await findReleaseByTag(api, tag), draft);
  assert.throws(() => assertNewRelease(draft), /禁止重复构建/);
  assert.deepEqual(calls, ['releases?per_page=100&page=1', 'releases?per_page=100&page=2']);
  assert.equal(await findReleaseByTag(async () => [], tag), null);
  await assert.rejects(findReleaseByTag(async () => [draft, draft], tag), /多个 Release/);
  await assert.rejects(findReleaseByTag(async () => { throw Error('permission denied'); }, tag), /permission denied/);
});

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'gravitybox-release-test-'));
  try {
    const names = releaseAssetNames(version), context = { version, tag, commit };
    await writeFile(join(directory, names[0]), 'synthetic DMG; not an installable image');
    const { hash } = await writeSha256Sidecar(join(directory, names[0]));
    const manifest = { schema: 1, tag, version, commit, sourceDigest: 'b'.repeat(64), dmg: { name: names[0], sha256: hash } };
    await writeFile(join(directory, names[2]), JSON.stringify(manifest));
    const assets = await Promise.all(names.map(async (name, i) => ({ id: i + 1, name, state: 'uploaded', size: (await readFile(join(directory, name))).length, digest: `sha256:${await fileSha256(join(directory, name))}`, updated_at: '2026-11-07T00:00:00Z' })));
    const release = { id: 123, tag_name: tag, draft: true, prerelease: false, assets };
    await fn({ directory, context, hash, manifest, release });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('草稿必须完整且只含该版本安装包、校验文件和清单', () => fixture(async ({ release }) => {
  assert.equal(validateDraft(release, tag), release);
  for (const bad of [{ ...release, draft: false }, { ...release, prerelease: true }, { ...release, tag_name: 'v1.0.0' }, { ...release, assets: release.assets.slice(1) }, { ...release, assets: [...release.assets, release.assets[0]] }, { ...release, assets: release.assets.map(a => ({ ...a, state: 'new' })) }]) assert.throws(() => validateDraft(bad, tag));
}));

test('验收文件绑定 DMG、sidecar、清单、标签、提交和人工验收哈希', () => fixture(async ({ directory, context, hash, manifest }) => {
  assert.equal(await verifyAcceptedFiles(directory, context, hash), hash);
  await assert.rejects(verifyAcceptedFiles(directory, context, '0'.repeat(64)), /不一致/);
  await writeFile(join(directory, 'release-manifest.json'), JSON.stringify({ ...manifest, commit: 'c'.repeat(40) }));
  await assert.rejects(verifyAcceptedFiles(directory, context, hash), /提交不一致/);
  await writeFile(join(directory, 'release-manifest.json'), JSON.stringify(manifest));
  await writeFile(join(directory, manifest.dmg.name), 'modified DMG');
  await assert.rejects(verifyAcceptedFiles(directory, context, hash), /SHA-256 不一致/);
}));

test('通过验收后仅修改草稿的发布状态，不上传或重新构建文件', () => fixture(async ({ directory, context, hash, release }) => {
  const calls = [];
  const api = async (path, options) => {
    calls.push({ path, options });
    if (path.startsWith('commits/')) return { sha: commit };
    if (path.startsWith('releases?')) return [release];
    if (options?.method === 'PATCH') return { ...release, draft: false, html_url: 'https://github.com/owner/repo/releases/tag/v1.0.1' };
    return release;
  };
  const result = await publishAcceptedDraft({ api, directory, context, expectedHash: hash });
  assert.equal(result.sha256, hash);
  assert.deepEqual(calls.filter(c => c.options), [{ path: 'releases/123', options: { method: 'PATCH', body: { draft: false, make_latest: 'true' } } }]);
}));

test('哈希不符、远端附件替换或标签移动均禁止发布', () => fixture(async ({ directory, context, hash, release }) => {
  for (const scenario of ['wrong-hash', 'remote-digest', 'changed-assets', 'moved-tag', 'already-published']) {
    let mutations = 0;
    const api = async (path, options) => {
      if (options?.method) { mutations++; throw Error('must not mutate'); }
      if (path.startsWith('commits/')) return { sha: scenario === 'moved-tag' ? 'd'.repeat(40) : commit };
      const response = value => path.startsWith('releases?') ? [value] : value;
      if (scenario === 'already-published') return response({ ...release, draft: false });
      if (scenario === 'remote-digest') return response({ ...release, assets: release.assets.map(a => ({ ...a, digest: 'sha256:' + '0'.repeat(64) })) });
      if (path === 'releases/123' && scenario === 'changed-assets') return { ...release, assets: release.assets.map(a => ({ ...a, id: a.id + 10 })) };
      return response(release);
    };
    await assert.rejects(publishAcceptedDraft({ api, directory, context, expectedHash: scenario === 'wrong-hash' ? '0'.repeat(64) : hash }), undefined, scenario);
    assert.equal(mutations, 0, scenario);
  }
}));

test('发布上下文读取标签对应的版本，拒绝脏工作区和远端标签漂移', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gravitybox-release-git-'));
  const git = async (...args) => (await promisify(execFile)('git', args, { cwd: root })).stdout.trim();
  try {
    await git('init', '-q');
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
    await git('add', 'package.json', 'package-lock.json');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    await git('tag', tag);
    const sha = await git('rev-parse', 'HEAD');
    const api = async () => ({ sha });
    assert.equal((await releaseContext(root, tag, api, { requireHead: true })).commit, sha);
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.1.0' }));
    await assert.rejects(releaseContext(root, tag, api, { requireHead: true }), /未提交修改/);
    assert.equal((await releaseContext(root, tag, api)).version, version, '发布控制器的 main 版本可以领先于待发布标签');
    await assert.rejects(releaseContext(root, tag, async () => ({ sha: '0'.repeat(40) })), /远端标签/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('生成清单要求包内版本、验证记录及实际源码一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gravitybox-release-manifest-'));
  try {
    for (const dir of ['src', 'runtime', 'native', 'tools', 'test', 'dict', 'ui-strings', 'assets', 'licenses', '.cache', '成品', 'build/dmg-stage/GravityBox.app/Contents/Resources']) await mkdir(join(root, dir), { recursive: true });
    for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'THIRD_PARTY_NOTICES.md']) await writeFile(join(root, name), '{}');
    const digest = await sourceDigest(root);
    await writeFile(join(root, '.cache/verified-release.json'), JSON.stringify({ version, digest }));
    const infoPath = join(root, 'build/dmg-stage/GravityBox.app/Contents/Resources/build-info.json');
    await writeFile(infoPath, JSON.stringify({ version, sourceDigest: digest }));
    const dmg = join(root, '成品', releaseAssetNames(version)[0]);
    await writeFile(dmg, 'synthetic image');
    const { hash } = await writeSha256Sidecar(dmg);
    const manifest = await writeReleaseManifest(root, { tag, version, commit });
    assert.equal(manifest.dmg.sha256, hash);
    assert.equal(manifest.commit, commit);
    await writeFile(infoPath, JSON.stringify({ version: '1.0.0', sourceDigest: digest }));
    await assert.rejects(writeReleaseManifest(root, { tag, version, commit }), /包内版本/);
    await writeFile(infoPath, JSON.stringify({ version, sourceDigest: digest }));
    await writeFile(join(root, 'src/changed.ts'), 'changed after verification');
    await assert.rejects(writeReleaseManifest(root, { tag, version, commit }), /源码摘要/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
