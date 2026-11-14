import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { selectTestFiles } from '../tools/run-tests.mjs';

const run = promisify(execFile);

test('默认测试范围完整分区：保留原生行为，浏览器与完整原生 UI 夹具独立执行', async () => {
  const entries = await readdir(new URL('./', import.meta.url));
  const all = selectTestFiles(entries);
  const fast = selectTestFiles(entries, 'fast');
  const native = selectTestFiles(entries, 'native');
  assert.ok(fast.length > 0 && native.length > 0);
  assert.equal(new Set([...fast, ...native]).size, fast.length + native.length);
  assert.deepEqual([...fast, ...native].sort(), all);
  assert.deepEqual(all, entries.filter(name => name.endsWith('.test.mjs')).sort().map(name => join('test', name)));
  assert.ok(!all.includes('test/browser.mjs'));
  assert.ok(entries.includes('native-ui.mjs'));
  assert.ok(!all.includes('test/native-ui.mjs'));
  assert.ok(native.includes('test/native-quota.test.mjs') && native.includes('test/native-repair.test.mjs') && native.includes('test/native-update.test.mjs'));
  assert.throws(() => selectTestFiles(entries, 'typo'), /未知测试范围/);
});

test('测试执行器失败关闭：空范围、参数冲突与子测试失败均返回非零', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gb-gate-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tools'));
  await mkdir(join(root, 'test'));
  const runner = join(root, 'tools/run-tests.mjs');
  await copyFile(new URL('../tools/run-tests.mjs', import.meta.url), runner);
  // The fixture starts an independent test runner, outside this test worker.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const cli = args => run(process.execPath, args, { env });
  for (const args of [[], ['--typo'], ['--fast', '--native']]) {
    await assert.rejects(cli([runner, ...args]), error => error.code === 1);
  }
  await writeFile(join(root, 'test/failure.test.mjs'), "import test from 'node:test'; test('fixture failure', () => { throw Error('expected failure'); });");
  await assert.rejects(cli([runner]), error => error.code === 1 && error.stdout.includes('expected failure'));
  // Optional UI failure must not run through the default glob, but must fail when explicitly selected.
  await writeFile(join(root, 'test/failure.test.mjs'), "import test from 'node:test'; test('core fixture', () => {});");
  const ui = join(root, 'test/native-ui.mjs');
  await writeFile(ui, "import test from 'node:test'; test('optional UI fixture', () => { throw Error('UI selected explicitly'); });");
  const defaults = await cli([runner]);
  assert.ok(defaults.stdout.includes('core fixture') && !defaults.stdout.includes('optional UI fixture'));
  await assert.rejects(cli(['--test', ui]), error => error.code === 1 && error.stdout.includes('UI selected explicitly'));
  const isolated = await cli(['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../tools/run-tests.mjs', import.meta.url).href)})`]);
  assert.equal(isolated.stdout, '');
});
