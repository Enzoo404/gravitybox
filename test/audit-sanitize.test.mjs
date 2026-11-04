import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planDistCleanup, cleanDist } from '../tools/clean-dist.mjs';
import { GENERATED_DIST_FILES } from '../tools/copy-runtime.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));

// ---- I06 dist 孤儿清理（隔离临时目录，不触碰真实 dist）----

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'gb-clean-dist-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'dist', 'a.js'), 'export const a = 1;\n');
  await writeFile(join(root, 'dist', 'orphan.js'), '// 无 src 对应\n');
  await writeFile(join(root, 'dist', 'engine.js'), '// copy-runtime 生成物，必须保留\n');
  await writeFile(join(root, 'dist', 'notes.txt'), '资源文件不得删除\n');
  return root;
}

test('I06: planDistCleanup 只报告无 src 对应的 js，并保留白名单与资源', async () => {
  const root = await makeProject();
  try {
    const plan = await planDistCleanup({ projectRoot: root });
    assert.deepEqual(plan.orphans, ['orphan.js']);
    assert.ok(plan.whitelist.includes('engine.js'));
    assert.ok(plan.expected.includes('a.js'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('I06: cleanDist 只删孤儿，不删对应产物/白名单/资源文件', async () => {
  const root = await makeProject();
  try {
    const result = await cleanDist({ projectRoot: root });
    assert.deepEqual(result.removed, ['orphan.js']);
    assert.equal(existsSync(join(root, 'dist', 'orphan.js')), false);
    assert.equal(existsSync(join(root, 'dist', 'a.js')), true);
    assert.equal(existsSync(join(root, 'dist', 'engine.js')), true);
    assert.equal(existsSync(join(root, 'dist', 'notes.txt')), true);
    assert.equal(await readFile(join(root, 'dist', 'notes.txt'), 'utf8'), '资源文件不得删除\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('I06: 缺失 dist 目录时不报错（全新克隆可 build）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-clean-dist-empty-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    const plan = await planDistCleanup({ projectRoot: root });
    assert.deepEqual(plan.orphans, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('I06: 真实仓库 dry-run 只把无对应文件的 js 当孤儿（engine.js 白名单不误删）', async () => {
  const plan = await planDistCleanup({ projectRoot: repo });
  assert.ok(plan.expected.includes('main.js'));
  assert.ok(plan.expected.includes('ipc-idempotency.js'));
  assert.ok(!plan.orphans.includes('engine.js'), 'engine.js 是 copy-runtime 产物，不能当孤儿');
  assert.deepEqual(GENERATED_DIST_FILES, ['engine.js']);
  // 历史孤儿 client-sync.js：clean 之后应不再出现；仍存在时必须被识别。
  if (existsSync(join(repo, 'dist', 'client-sync.js'))) assert.deepEqual(plan.orphans, ['client-sync.js']);
  else assert.deepEqual(plan.orphans, []);
});
