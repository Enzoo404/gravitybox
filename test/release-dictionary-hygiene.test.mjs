import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { includeDictionaryPath, sourceDigest } from '../tools/release-integrity.mjs';

test('dictionary backups never enter release inputs or packaged resources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gb-dictionary-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['src', 'runtime', 'native', 'tools', 'test', 'dict', 'ui-strings', 'assets', 'licenses', 'vendor']) {
    await mkdir(join(root, directory));
  }
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'THIRD_PARTY_NOTICES.md']) {
    await writeFile(join(root, file), '{}');
  }
  await writeFile(join(root, 'dict/base.json'), '{}');
  const before = await sourceDigest(root);
  for (const name of ['.backups', '.imports']) {
    await mkdir(join(root, 'dict', name));
    await writeFile(join(root, 'dict', name, 'old.json'), 'historical');
  }
  await writeFile(join(root, 'dict/.DS_Store'), 'metadata');
  assert.equal(await sourceDigest(root), before);
  await cp(join(root, 'dict'), join(root, 'packaged'), {
    recursive: true,
    filter: source => includeDictionaryPath(join('dict', relative(join(root, 'dict'), source))),
  });
  assert.deepEqual(await readdir(join(root, 'packaged')), ['base.json']);
  await writeFile(join(root, 'dict/base.json'), '{"Save":"保存"}');
  assert.notEqual(await sourceDigest(root), before);
  const dictionaryChanged = await sourceDigest(root);
  await writeFile(join(root, 'vendor/main.js'), 'official evidence');
  assert.notEqual(await sourceDigest(root), dictionaryChanged);
});
