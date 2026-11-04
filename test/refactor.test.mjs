import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import 'node:http';
import { join } from 'node:path';
import { Controller } from '../dist/controller.js';
import { dictionaryFromEntries, loadDictionaryLayers } from '../dist/dictionary.js';
import { validateTranslations } from '../tools/merge-translations.mjs';
import { loadDictLayers } from '../tools/coverage-report.mjs';
import { atomicJson } from '../dist/files.js';
import { Tasks } from '../dist/tasks.js';
const configuration = { provider: 'openai', apiKey: 'synthetic-audit-key', baseUrl: 'https://model.invalid/v1', model: 'synthetic' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = new URL('../', import.meta.url);
async function state() { const directory = await mkdtemp('/tmp/gb-test-'); await mkdir(join(directory, '词典')); return directory; }
function controller(directory) { return new Controller({ appPath: '/nonexistent', profile: '/nonexistent', stateDir: directory, dictionary: dictionaryFromEntries({ Save: '保存' }), onStatus: () => {} }); }
async function prepared(c, directory, count) { const path = join(directory, 'pending.json'); await writeFile(path, JSON.stringify({ entries: Array.from({ length: count }, (_, i) => ({ key: `Audit feature number ${i}` })) })); return c.previewPending(configuration, path); }

test('运行时与发布门禁采用相同词典优先级', async () => {
  const runtime = await loadDictionaryLayers(fileURLToPath(new URL('dict/', root))); const gate = await loadDictLayers(fileURLToPath(new URL('dict/', root)));
  for (const [key, value] of Object.entries(runtime.dictionary.entries)) assert.equal(gate.entries.get(key).value, value, key);
});
test('个人覆盖优先于增量文件；来源可见', async () => {
  const directory = await state(); const base = join(directory, 'base'); await mkdir(base);
  try { await writeFile(join(base, 'base.json'), '{"Save":"保存"}'); await writeFile(join(directory, '词典', '增量补全-2.23.1.json'), '{"Save":"增量译文"}'); await writeFile(join(directory, '词典', '个人覆盖.json'), '{"Save":"个人译文"}'); const result = await loadDictionaryLayers(base, join(directory, '词典')); assert.equal(result.dictionary.entries.Save, '个人译文'); assert.match(result.sources.Save, /个人覆盖/); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
test('占位符错误不进入 accepted，不能经部分合并绕过', () => { const result = validateTranslations([{ key: 'Save {name}', zh: '保存' }], {}); assert.equal(result.accepted.length, 0); assert.equal(result.rejected.length, 1); });
test('原子写入在提交前取消时保留原文件', async () => {
  const directory = await state(); try { const path = join(directory, 'personal.json'); await atomicJson(path, { Save: '原译文' }); const abort = new AbortController(); abort.abort(); await assert.rejects(atomicJson(path, { Save: '新译文' }, abort.signal)); assert.deepEqual(JSON.parse(await readFile(path)), { Save: '原译文' }); } finally { await rm(directory, { recursive: true, force: true }); }
});
test('异步任务立即返回 ID，可取消并保留结果记录', async () => {
  const directory = await state(); const tasks = new Tasks(directory, () => {}); await tasks.start();
  try { const id = tasks.begin('synthetic', '模拟任务', signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))); assert.equal(typeof id, 'string'); assert.equal(tasks.list()[0].state, 'running'); tasks.cancel(id); await tasks.stop(); assert.equal(tasks.list()[0].state, 'cancelled'); const saved = JSON.parse(await readFile(join(directory, 'activity.json'))); assert.equal(saved[0].state, 'cancelled'); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
