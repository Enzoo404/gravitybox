import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_VERSION } from '../dist/version.js';

test('开发运行时版本与项目元数据一致', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(APP_VERSION, pkg.version);
});

test('打包后的 core/dist 从相邻 core/package.json 读取真实版本，缺失版本时拒绝伪报', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'gravitybox-packaged-version-'));
  try {
    for (const version of ['1.0.1', '1.1.0', null]) {
      const core = join(temp, version ?? 'missing', 'core');
      await mkdir(join(core, 'dist'), { recursive: true });
      await writeFile(join(core, 'package.json'), JSON.stringify({ type: 'module', ...(version ? { version } : {}) }));
      await copyFile(new URL('../dist/version.js', import.meta.url), join(core, 'dist/version.js'));
      const result = import(pathToFileURL(join(core, 'dist/version.js')).href);
      if (version) assert.equal((await result).APP_VERSION, version);
      else await assert.rejects(result, /缺少有效的构建版本/);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
