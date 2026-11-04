import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DictionaryStore,
  loadDictionaryLayers,
  migrateLegacyIncrementalDictionaries,
  readIncrementalEntries,
  removeIncrementalEntries,
  removeIncrementalBatch,
  restoreIncrementalSnapshot,
} from '../dist/dictionary.js';

const INCREMENTAL = '增量补全.json';
async function workspace(prefix, base = { Save: '保存', Open: '打开' }) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const baseDir = join(dir, 'base');
  const userDir = join(dir, 'user');
  await mkdir(baseDir);
  await mkdir(userDir);
  await writeFile(join(baseDir, 'base.json'), JSON.stringify(base));
  return { dir, baseDir, userDir };
}
async function cleanup(...dirs) { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); }
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

/* ------------------------------------------------------------------ B19：版本切换/重载失败必须显式 */

test('B19 selectVersion 成功切换：目标版本过滤生效且 lastError 清空', async () => {
  const { baseDir, userDir } = await workspace('gb-p2-select-ok-');
  const store = new DictionaryStore(baseDir, userDir);
  try {
    await writeFile(join(baseDir, '2.24.0.json'), JSON.stringify({ 'Future layer': '未来层' }));
    await store.start();
    assert.equal(store.current.entries['Future layer'], '未来层', 'start 未指定目标版本时会加载全部层');
    const dictionary = await store.selectVersion('2.23.1');
    assert.equal(store.targetVersion, '2.23.1');
    assert.equal(dictionary.entries['Future layer'], undefined, '2.24.0 层不能出现在 2.23.1 的目标词典里');
    assert.equal(store.lastError, undefined);
    const again = await store.selectVersionResult('2.23.1');
    assert.equal(again.ok, true);
    assert.equal(again.dictionary.version, dictionary.version);
  } finally { store.close(); await cleanup(baseDir, userDir); }
});

test('B19 selectVersion 重载失败：抛错、回滚目标版本、保留上一份有效词典且状态不出现“已切换”', async () => {
  const { baseDir, userDir } = await workspace('gb-p2-select-fail-');
  const store = new DictionaryStore(baseDir, userDir);
  try {
    await store.start();
    await store.selectVersion('2.23.1');
    const beforeVersion = store.current.version;
    const beforeTarget = store.targetVersion;
    const beforeCounts = store.layerCounts;
    const beforeEntries = Object.keys(store.current.entries).length;

    await writeFile(join(baseDir, 'base.json'), '{ broken json');
    await assert.rejects(store.selectVersion('2.24.0'), /无法加载 2\.24\.0 对应的词典/);
    assert.equal(store.targetVersion, beforeTarget, '失败后目标版本必须回滚，不能停在未加载成功的版本');
    assert.equal(store.current.version, beforeVersion, '必须保留上一份有效词典');
    assert.equal(Object.keys(store.current.entries).length, beforeEntries);
    assert.deepEqual(store.layerCounts, beforeCounts, '计数缓存必须与生效词典同时保持旧值');
    assert.match(store.lastError ?? '', /JSON/);

    // 降级状态下请求同一版本不重载：不伪造“已切换”，但降级原因必须仍可显式读到（不静默）
    const same = await store.selectVersionResult('2.23.1');
    assert.equal(same.ok, true);
    assert.equal(same.dictionary.version, beforeVersion);
    assert.match(same.degraded ?? '', /JSON/, '降级状态必须通过 degraded 原因显式暴露');
    await assert.rejects(store.reloadStrict(), /词典重载失败/);

    const result = await store.selectVersionResult('2.24.0');
    assert.equal(result.ok, false, 'selectVersionResult 必须显式返回失败');
    assert.match(result.error, /无法加载|重载失败/);
    assert.equal(result.dictionary.version, beforeVersion, 'ok:false 同时给出仍可用的上一份有效词典');
    assert.equal(store.targetVersion, beforeTarget);
  } finally { store.close(); await cleanup(baseDir, userDir); }
});

test('B19 启动降级（last-valid 词典）不因同一版本选择而抛错，失败状态仍可显式读到', async () => {
  const { baseDir, userDir } = await workspace('gb-p2-select-fallback-');
  const store = new DictionaryStore(baseDir, userDir);
  try {
    await writeFile(join(userDir, '个人覆盖.json'), '{ invalid json');
    const fallback = { schema: 1, version: 'cached-valid-version', entries: { Save: '缓存保存' } };
    await store.start(fallback);
    assert.equal(store.current.entries.Save, '缓存保存', '启动失败时必须使用 last-valid 词典内容');
    assert.match(store.lastError ?? '', /个人覆盖|JSON|格式/, '降级原因必须记录');
    // 同一目标版本（启动时就是 undefined）不应抛错，否则会打断“损坏词典仍保持连接”的恢复路径
    const dictionary = await store.selectVersion('fixture');
    assert.equal(dictionary.entries.Save, '缓存保存');
    const result = await store.selectVersionResult('fixture');
    assert.equal(result.ok, true);
    assert.match(result.degraded ?? '', /个人覆盖|JSON|格式/);
  } finally { store.close(); await cleanup(baseDir, userDir); }
});

/* ------------------------------------------------------------------ B18：增量层按 key/按批次删除与撤销 */

test('B18 按 key 删除增量词条：原子写、快照、按批次撤销', async () => {
  const { dir, userDir } = await workspace('gb-p2-remove-');
  try {
    await writeFile(join(userDir, INCREMENTAL), JSON.stringify({ A: '甲', B: '乙', C: '丙' }));
    const snapshotPath = join(dir, 'undo-batch-1.json');
    const before = await readIncrementalEntries(userDir);
    assert.equal(before.exists, true);
    const result = await removeIncrementalEntries(userDir, ['A', 'C'], { snapshotPath, batchId: 'batch-1', expectedDigest: before.digest });
    assert.deepEqual(result.removed, ['A', 'C']);
    assert.deepEqual(result.missing, []);
    assert.equal(result.remaining, 1);
    assert.equal(result.snapshot?.batchId, 'batch-1');
    assert.deepEqual(await readJson(join(userDir, INCREMENTAL)), { B: '乙' });
    assert.notEqual((await readIncrementalEntries(userDir)).digest, before.digest);

    const snapshot = await readJson(snapshotPath);
    assert.equal(snapshot.schema, 1);
    assert.equal(snapshot.batchId, 'batch-1');
    assert.deepEqual(snapshot.removed, { A: '甲', C: '丙' });

    const restore = await restoreIncrementalSnapshot(userDir, snapshotPath);
    assert.deepEqual(restore.restored, ['A', 'C']);
    assert.deepEqual(await readJson(join(userDir, INCREMENTAL)), { A: '甲', B: '乙', C: '丙' });
  } finally { await cleanup(dir); }
});

test('B18 按批次删除、幂等 miss 与 dryRun 不写盘', async () => {
  const { dir, userDir } = await workspace('gb-p2-batch-');
  try {
    await writeFile(join(userDir, INCREMENTAL), JSON.stringify({ A: '甲', B: '乙' }));
    const dry = await removeIncrementalEntries(userDir, ['B'], { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.removed, ['B']);
    assert.deepEqual(await readJson(join(userDir, INCREMENTAL)), { A: '甲', B: '乙' }, 'dryRun 不得写盘');

    const snapshotPath = join(dir, 'undo-b2.json');
    const batch = await removeIncrementalBatch(userDir, { id: 'batch-2', keys: ['B'] }, { snapshotPath });
    assert.equal(batch.remaining, 1);
    assert.equal((await readJson(snapshotPath)).batchId, 'batch-2');

    const missing = await removeIncrementalEntries(userDir, ['B', '不存在']);
    assert.deepEqual(missing.removed, []);
    assert.deepEqual(missing.missing, ['B', '不存在']);
    assert.equal(missing.remaining, 1, '删除不存在的键是幂等的，不报错也不改文件');
  } finally { await cleanup(dir); }
});

test('B18 并发保护：expectedDigest 过期与损坏增量层都拒绝删除且保留原文件', async () => {
  const { userDir } = await workspace('gb-p2-cas-');
  try {
    await writeFile(join(userDir, INCREMENTAL), JSON.stringify({ A: '甲' }));
    const stale = (await readIncrementalEntries(userDir)).digest;
    await writeFile(join(userDir, INCREMENTAL), JSON.stringify({ A: '甲', B: '乙' }));
    await assert.rejects(removeIncrementalEntries(userDir, ['A'], { expectedDigest: stale }), /增量词典已在其他位置修改/);
    assert.deepEqual(await readJson(join(userDir, INCREMENTAL)), { A: '甲', B: '乙' });

    const broken = '{ broken json';
    await writeFile(join(userDir, INCREMENTAL), broken);
    await assert.rejects(removeIncrementalEntries(userDir, ['A']), /无法解析，已保留原文件/);
    assert.equal(await readFile(join(userDir, INCREMENTAL), 'utf8'), broken, '损坏文件必须原样保留');

    await assert.rejects(removeIncrementalEntries(userDir, []), /至少一个/);
    await assert.rejects(removeIncrementalEntries(userDir, ['   ']), /非空文本/);
  } finally { await cleanup(userDir); }
});

test('B18 撤销冲突保护与场景键删除', async () => {
  const { dir, userDir } = await workspace('gb-p2-restore-');
  try {
    await writeFile(join(userDir, INCREMENTAL), JSON.stringify({ A: '甲', '@ui:/settings|button|Strong': '强' }));
    const snapshotPath = join(dir, 'undo.json');
    const removed = await removeIncrementalEntries(userDir, ['A', '@ui:/settings|button|Strong'], { snapshotPath });
    assert.deepEqual(removed.removed.sort(), ['@ui:/settings|button|Strong', 'A'], 'scoped 场景键同样可按 key 删除');
    assert.deepEqual(await readJson(join(userDir, INCREMENTAL)), {});

    await writeFile(join(userDir, INCREMENTAL), JSON.stringify({ A: '新甲' }));
    const keep = await restoreIncrementalSnapshot(userDir, snapshotPath, { overwriteExisting: false });
    assert.deepEqual(keep.skipped, ['A']);
    assert.equal(keep.restored.includes('@ui:/settings|button|Strong'), true);
    assert.equal((await readJson(join(userDir, INCREMENTAL))).A, '新甲', 'overwriteExisting:false 不得覆盖现值');

    const overwrite = await restoreIncrementalSnapshot(userDir, snapshotPath);
    assert.equal((await readJson(join(userDir, INCREMENTAL))).A, '甲', '默认撤销可恢复被删除的原文');
    assert.equal(overwrite.remaining, 2);
  } finally { await cleanup(dir); }
});

/* ------------------------------------------------------------------ B17：迁移只压平受支持版本 */

test('B17 迁移只压平受支持版本的碎片层，未来版本文件保留且不生效', async () => {
  const { baseDir, userDir } = await workspace('gb-p2-migrate-');
  try {
    await writeFile(join(userDir, '增量补全-2.23.1.json'), JSON.stringify({ Supported: '支持版译文' }));
    await writeFile(join(userDir, '增量补全-9.9.9.json'), JSON.stringify({ Future: '未来版译文' }));
    await migrateLegacyIncrementalDictionaries(userDir);
    assert.deepEqual(await readJson(join(userDir, INCREMENTAL)), { Supported: '支持版译文' }, '只合并受支持版本');
    const files = await readdir(userDir);
    assert.ok(files.includes('增量补全-2.23.1.json.migrated'), '受支持版本迁移后仍保留可恢复备份');
    assert.ok(files.includes('增量补全-9.9.9.json'), '未知/未来版本必须原样保留，不能被压平');
    assert.equal(files.includes('增量补全-9.9.9.json.migrated'), false);

    const layers = await loadDictionaryLayers(baseDir, userDir, '2.24.0');
    assert.equal(layers.dictionary.entries.Supported, '支持版译文');
    assert.equal(layers.dictionary.entries.Future, undefined, '未来版本层不得在 2.24.0 目标词典中生效');
  } finally { await cleanup(baseDir, userDir); }
});

test('B17 supportedVersions 可显式覆盖，用于迁移工具/测试', async () => {
  const { userDir } = await workspace('gb-p2-migrate-opt-');
  try {
    await writeFile(join(userDir, '增量补全-9.9.9.json'), JSON.stringify({ Future: '未来版译文' }));
    await migrateLegacyIncrementalDictionaries(userDir, { supportedVersions: ['9.9.9'] });
    assert.deepEqual(await readJson(join(userDir, INCREMENTAL)), { Future: '未来版译文' });
  } finally { await cleanup(userDir); }
});
