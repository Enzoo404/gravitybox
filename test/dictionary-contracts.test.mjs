import test from "node:test";
import { describe as describeContractGroup } from "node:test";
import assert from "node:assert/strict";
import { dictionaryFromEntries, loadDictionaryLayers, migrateLegacyIncrementalDictionaries, DictionaryStore } from "../dist/dictionary.js";
import { coverageMetricSnapshot, coverageScopes, coverageTranslationLookup, createCoverage, extractCoverageStrings, isCoverageNoise, recordCoverageVisit, recountCoverage, resolveCoverageTranslation, shouldHideCoverageRow, filterCoverageEntries } from "../dist/coverage.js";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRoute, scopedKey, decodeScopedKey, previewItemId, selectedPreviewItems } from "../dist/candidates.js";
import { Controller } from "../dist/controller.js";
import { fileURLToPath } from "node:url";
import { validateTranslations } from "../tools/merge-translations.mjs";
import { loadDictLayers } from "../tools/coverage-report.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractUiStrings, extractedKind } from "../dist/bundle.js";

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · audit-p3-coverage", { concurrency: false }, async () => {
const scoped = (route, kind, text) => `@ui:${route}|${kind}|${text}`;
const dictOf = entries => dictionaryFromEntries(entries);
const sum = counts => Object.values(counts ?? {}).reduce((total, count) => total + count, 0);

/* ------------------------------------------------------------------ B16：@ui: 场景键参与资源扫描/补译判断 */

test('B16 资源扫描：只有 @ui: 场景译文的串判 translated，不再判 missing', () => {
  const dictionary = dictOf({ [scoped('/settings', 'button', 'Strong')]: '强', Open: '打开' });
  const report = createCoverage([{ id: '/main.js', scope: 'renderer', source: 'a({label:"Strong",description:"Open"});' }], dictionary, '2.24.0', 'sha');
  const strong = report.entries.find(e => e.key === 'Strong');
  assert.equal(strong.status, 'translated', '场景译文必须参与资源扫描查表');
  assert.equal(strong.translation, '强');
  assert.equal(strong.scoped, true);
  assert.equal(report.entries.some(e => e.key === 'Strong' && ['missing', 'review'].includes(e.status)), false);
  assert.equal(report.entries.find(e => e.key === 'Open').status, 'translated');
});

test('B16 场景解析：已知 route/kind 精确命中优先，未知场景退回普通键，多场景冲突判 review', () => {
  const lookup = coverageTranslationLookup(dictOf({
    [scoped('/settings', 'button', 'Open')]: '设置打开',
    [scoped('/', 'heading', 'Open')]: '主页打开',
    Open: '通用打开',
  }));
  assert.equal(resolveCoverageTranslation('Open', lookup, [{ route: '/settings', kind: 'button' }]).translation, '设置打开');
  assert.equal(resolveCoverageTranslation('Open', lookup, [{ route: '/history', kind: 'button' }]).translation, '通用打开');
  const ambiguousDictionary = dictOf({ [scoped('/settings', 'button', 'Dup')]: '甲', [scoped('/', 'button', 'Dup')]: '乙' });
  const report = createCoverage([{ id: '/main.js', scope: 'renderer', source: 'a({label:"Dup"});' }], ambiguousDictionary, '2.24.0', 'sha');
  const dup = report.entries.find(e => e.key === 'Dup');
  assert.equal(dup.status, 'review', '多个场景译文冲突时人工核对，不能算 missing');
  assert.equal(dup.translation, undefined);
});

test('B16 覆盖率场景解析只接受“可见界面 <route> <kind>”来源', () => {
  assert.deepEqual(coverageScopes({ sources: ['可见界面 /settings button', '/main.js'] }), [{ route: '/settings', kind: 'button' }]);
  assert.deepEqual(coverageScopes({ sources: ['/main.js'] }), []);
});

/* ------------------------------------------------------------------ B14/B15：counts 双计与总览口径 */

test('B14 counts 不再 status/observed 双计：每个词条恰好一个终态，sum === entries.length', () => {
  const dictionary = dictOf({ Translated: '已翻译' });
  const report = createCoverage([{ id: '/main.js', scope: 'renderer', source: 'a({label:"Translated",description:"Missing"});' }], dictionary, '2.24.0', 'sha');
  recordCoverageVisit(report, '/settings', { observations: [{ key: '  Translated  ', state: 'verified' }, { key: 'Missing', state: 'untranslated' }] });
  assert.equal(sum(report.counts), report.entries.length, '互斥终态计数合计必须等于词条数');
  assert.equal(sum(report.statusCounts), report.entries.length, '扫描状态轴同样覆盖全部词条');
  assert.equal(report.counts.verified, 1, 'observed=verified 单独成桶');
  assert.equal(report.counts.untranslated, 1, 'observed=untranslated 单独成桶');
  assert.equal(report.counts.translated ?? 0, 0, '被实机观察的词条不再重复计入 translated');
  assert.equal(report.statusCounts.translated, 1, '扫描状态轴仍保留原 translated');
  assert.equal(report.statusCounts.missing >= 1, true);
  assert.equal(report.observedCounts.verified, 1);
  assert.equal(report.observedCounts.untranslated, 1);
});

test('B14 旧报告（无 statusCounts/observedCounts）重算后可解释，不产生双计', () => {
  const report = createCoverage([{ id: '/main.js', scope: 'renderer', source: 'a({label:"Translated"});' }], dictOf({ Translated: '已翻译' }), '2.24.0', 'sha');
  report.entries[0].observed = 'verified';
  const legacy = { ...report, counts: { translated: 1, verified: 1 }, statusCounts: undefined, observedCounts: undefined };
  recountCoverage(legacy);
  assert.equal(sum(legacy.counts), legacy.entries.length);
  assert.equal(legacy.counts.verified, 1);
  assert.equal(legacy.observedCounts.verified, 1);
});

test('B15 总览口径与覆盖页同源：translated/extracted 且带应用版本、生成时间、词典版本', () => {
  const dictionary = dictOf({ Translated: '已翻译' });
  const report = createCoverage([{ id: '/main.js', scope: 'renderer', source: 'a({label:"Translated",description:"Missing"});' }], dictionary, '2.24.0', 'sha');
  const metric = coverageMetricSnapshot(report);
  assert.equal(metric.available, true);
  assert.equal(metric.extracted, report.entries.length, '分母是已抽取词条数');
  assert.equal(metric.translated, report.counts.translated ?? 0, '与覆盖页 counts.translated 同源');
  assert.equal(metric.covered, (report.counts.translated ?? 0) + (report.counts.verified ?? 0));
  assert.equal(metric.appVersion, '2.24.0');
  assert.equal(metric.generatedAt, report.generatedAt);
  assert.equal(metric.bundleSha256, 'sha');
  assert.equal(metric.dictionaryVersion, dictionary.version);
  assert.equal(metric.review, report.counts.review ?? 0);
  const empty = coverageMetricSnapshot(undefined);
  assert.equal(empty.available, false);
  assert.equal(empty.translated, 0);
  assert.equal(empty.extracted, 0);
});

/* ------------------------------------------------------------------ I07：覆盖率诊断噪声过滤 */

test('I07 噪声判定：先规范化，堆栈/日志/压缩 JS/纯标识符不算待译，正常文案不误伤', () => {
  const noise = [
    '\n\n  Error generating stack: boom',
    ';break;case -2:Wf=Xa?',
    '  at Object.<anonymous> (/app/main.js:1:2)',
    '[AutoUpdater] Checking for update…',
    '--wsl-distro=${distro}',
    'node_modules/react/index.js',
    'application/json',
    'data-testid',
    '!p-0 overflow-hidden',
    '!text-clip',
    '\u001b[33mConnection lost\u001b[0m',
    '[...long stack...]',
    'Local:       ${url}',
    '(display-mode: standalone)',
    'getFile()',
    '\\\\b(?:import|module)',
    '?csrfToken',
    "' here.",
  ];
  for (const key of noise) assert.equal(isCoverageNoise(key), true, `应判为噪声：${key}`);
  const legit = [
    '\n\n  Open a review  ',
    'Save changes',
    'Settings',
    'Resets in {duration}',
    'Open {name} in {count} steps',
    'Gemini 2.5 Flash Image',
    '(no file changes detected)',
    '(Optional)',
    'Show (2)',
    'git pull',
  ];
  for (const key of legit) assert.equal(isCoverageNoise(key), false, `不应判为噪声：${key}`);
});

test('I07 覆盖页行隐藏：只隐藏待译/待确认类噪声行，分类行保留以解释计数', () => {
  assert.equal(shouldHideCoverageRow({ key: 'Error generating stack: x', status: 'review' }), true);
  assert.equal(shouldHideCoverageRow({ key: ';break;case -2:Wf=Xa?', status: 'missing' }), true);
  assert.equal(shouldHideCoverageRow({ key: 'Open a review', status: 'missing' }), false);
  assert.equal(shouldHideCoverageRow({ key: 'Error generating stack: x', status: 'dynamic' }), false);
  assert.equal(shouldHideCoverageRow({ key: 'Error generating stack: x', status: 'translated' }), false);
});

test('I07 抽取：结构化与 literal 候选都先规范化并过滤噪声，键不再带前导空白', () => {
  const source = [
    'const a={label:"Open a review",description:"  Save changes  "};',
    'const b="Error generating stack: boom";',
    'const c=";break;case -2:Wf=Xa?";',
    'const d="  at Object.<anonymous> (/app/main.js:1:2)";',
    'const e="node_modules/react/index.js";',
    'const f="!p-0 overflow-hidden";',
    'const g="  Cancel  ";',
  ].join('');
  const keys = extractCoverageStrings(source).map(entry => entry.key);
  assert.deepEqual([...new Set(keys)].sort(), ['Cancel', 'Open a review', 'Save changes']);
  for (const key of keys) assert.equal(key, key.trim(), '键必须已规范化');
  const report = createCoverage([{ id: '/main.js', scope: 'renderer', source }], dictOf({}), '2.24.0', 'sha');
  const reportKeys = report.entries.map(entry => entry.key);
  for (const noisy of ['Error generating stack: boom', ';break;case -2:Wf=Xa?', 'node_modules/react/index.js', '!p-0 overflow-hidden']) {
    assert.equal(reportKeys.includes(noisy), false, `噪声不得进入覆盖率清单：${noisy}`);
  }
  assert.equal(sum(report.counts), report.entries.length);
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · evolution", { concurrency: false }, async () => {
test('场景键保留占位符、隔离角色和页面，并隐藏私有路径',()=>{
  assert.notEqual(scopedKey('Open {name}','button','/settings'),scopedKey('Open {name}','heading','/'));
  assert.deepEqual(decodeScopedKey(scopedKey('Open {name}','button','/settings')),{key:'Open {name}',kind:'button',route:'/settings'});
  assert.equal(safeRoute('/c/private-id?token=secret'),'/other');assert.equal(decodeScopedKey('@ui:/c/private|button|Open'),undefined);
});

test('版本词典选择最近可用层，不将未来版本覆盖带回旧版；个人覆盖仍最高',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'gravity-dict-version-'));const base=join(dir,'base'),user=join(dir,'user');try{await mkdir(base);await mkdir(user);await writeFile(join(base,'base.json'),'{"Version label":"基础"}');await writeFile(join(base,'2.23.0.json'),'{"Version label":"旧版"}');await writeFile(join(base,'2.24.0.json'),'{"Version label":"未来"}');assert.equal((await loadDictionaryLayers(base,user,'2.23.1')).dictionary.entries['Version label'],'旧版');assert.equal((await loadDictionaryLayers(base,user,'2.25.0')).dictionary.entries['Version label'],'未来');await writeFile(join(user,'个人覆盖.json'),'{"Version label":"个人"}');assert.equal((await loadDictionaryLayers(base,user,'2.23.1')).dictionary.entries['Version label'],'个人');}finally{await rm(dir,{recursive:true,force:true});}
});

test('个人全局覆盖高于 AI 场景补全；移除后恢复已有场景译文',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'gravity-context-personal-'));const base=join(dir,'base'),user=join(dir,'user');try{await mkdir(base);await mkdir(user);await writeFile(join(base,'base.json'),'{}');const context=scopedKey('Open','button','/settings');await writeFile(join(user,'增量补全-2.23.1.json'),JSON.stringify({[context]:'打开资源'}));await writeFile(join(user,'个人覆盖.json'),'{"Open":"我的译文"}');let layers=await loadDictionaryLayers(base,user);assert.equal(layers.dictionary.entries[context],undefined);assert.equal(layers.dictionary.entries.Open,'我的译文');await writeFile(join(user,'个人覆盖.json'),'{}');layers=await loadDictionaryLayers(base,user);assert.equal(layers.dictionary.entries[context],'打开资源');}finally{await rm(dir,{recursive:true,force:true});}
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · phase1-audit-verification", { concurrency: false }, async () => {
test('阶段1验证 - B01: 损坏旧词典不被删除，损坏统一词典不被覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-test-b01-'));
  const brokenContent = '{ broken json content';
  await writeFile(join(root, '增量补全-2.23.1.json'), brokenContent);
  await migrateLegacyIncrementalDictionaries(root);
  const filesAfter = await readdir(root);
  assert.ok(filesAfter.includes('增量补全-2.23.1.json'), '损坏的旧词典必须完整保留在原处');
  const content = await readFile(join(root, '增量补全-2.23.1.json'), 'utf8');
  assert.equal(content, brokenContent, '损坏的旧词典内容不能被修改');
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · polish", { concurrency: false }, async () => {
const dictionary=dictionaryFromEntries({});
const controller=()=>new Controller({appPath:'/unused',profile:'/unused',dictionary,onStatus(){}});
test('预览子集严格限定为批次成员，区别同词的场景，拒绝空/重复/注入 ID',()=>{
 const entries=[{key:'Open',translationKey:scopedKey('Open','button','/settings')},{key:'Open',translationKey:scopedKey('Open','heading','/')}];const ids=entries.map(previewItemId);assert.notEqual(ids[0],ids[1]);assert.deepEqual(selectedPreviewItems(entries,[ids[1]]),[entries[1]]);
 for(const selection of [[],[ids[0],ids[0]],['injected'],null,'all'])assert.throws(()=>selectedPreviewItems(entries,selection));
});
test('来源计数跟随合并后优先级及版本切换，错误重载保留上一份有效数据',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gb-counts-'));const base=join(root,'base'),user=join(root,'user');await mkdir(base);await mkdir(user);const store=new DictionaryStore(base,user);
 try{await writeFile(join(base,'base.json'),JSON.stringify({Save:'保存',Open:'打开'}));await writeFile(join(base,'2.23.2.json'),JSON.stringify({New:'新增'}));await writeFile(join(user,'增量补全-2.23.1.json'),JSON.stringify({Open:'开启'}));await writeFile(join(user,'个人覆盖.json'),JSON.stringify({Save:'存储'}));await store.start();assert.deepEqual(store.layerCounts,{builtin:1,incremental:1,personal:1});await store.selectVersion('2.23.1');assert.deepEqual(store.layerCounts,{builtin:0,incremental:1,personal:1});const version=store.current.version;
  await writeFile(join(user,'个人覆盖.json'),'{broken');await store.reload();assert.equal(store.current.version,version);assert.deepEqual(store.layerCounts,{builtin:0,incremental:1,personal:1});assert.ok(store.lastError);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('巡检编辑仅允许明确 UI，保留场景，修改后失效旧实机验证且不虚构新验证',async()=>{
 const c=controller();c.coverage={schema:1,dictionaryVersion:dictionary.version,entries:[{key:'Inspect view',status:'missing',confidence:'ui',sources:['可见界面 /settings button'],observed:'untranslated'},{key:'File',status:'native',confidence:'ui',sources:['native']},{key:'Updated {time}',status:'dynamic',confidence:'ui',sources:['内置动态规则']},{key:'Ambiguous label',status:'missing',confidence:'ui',sources:['可见界面 /settings button','可见界面 /history heading']}],counts:{}};
 const edit=await c.prepareCoverageEdit('Inspect view');assert.equal(edit.key,scopedKey('Inspect view','button','/settings'));assert.equal(edit.context,'设置 · 按钮');
 for(const key of ['File','Updated {time}','Ambiguous label','Unknown text'])await assert.rejects(c.prepareCoverageEdit(key));
 c.options.dictionary=dictionaryFromEntries({[edit.key]:'检查视图'});const report=await c.coverageReport();assert.equal(report.entries[0].translation,'检查视图');assert.equal(report.entries[0].status,'translated');assert.equal(report.entries[0].observed,undefined);assert.equal(report.counts.verified,undefined);
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · refactor", { concurrency: false }, async () => {
const root = new URL('../', import.meta.url);
async function state() { const directory = await mkdtemp('/tmp/gb-test-'); await mkdir(join(directory, '词典')); return directory; }

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
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · repair-20261023", { concurrency: false }, async () => {
const run=promisify(execFile);async function fixture(t){const d=await mkdtemp(join(tmpdir(),'gb-repair-'));t.after(async()=>{try{await rm(d,{recursive:true,force:true,maxRetries:10,retryDelay:50});}catch{}});return d;}
test('迁移旧词典只补缺，不回退统一层新译文；合并拒绝损坏及冲突层',async t=>{const d=await fixture(t);await writeFile(join(d,'增量补全.json'),JSON.stringify({Conflict:'新版'}));await writeFile(join(d,'增量补全-2.23.1.json'),JSON.stringify({Conflict:'旧版'}));await migrateLegacyIncrementalDictionaries(d);assert.equal(JSON.parse(await readFile(join(d,'增量补全.json'))).Conflict,'新版');const base=join(d,'base'),pending=join(d,'pending'),input=join(d,'input'),out=join(d,'output');await writeFile(base,'{}');await writeFile(pending,JSON.stringify({entries:[{key:'Synthetic action'}]}));await writeFile(input,JSON.stringify({'Synthetic action':'合成操作'}));for(const original of ['{bad',JSON.stringify({'Synthetic action':'旧译文'})]){await writeFile(out,original);await assert.rejects(run(process.execPath,['tools/merge-translations.mjs','--base',base,'--pending',pending,'--input',input,'--out',out]));assert.equal(await readFile(out,'utf8'),original);}});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · ui-evolution", { concurrency: false }, async () => {
test('静态提取保留首个有效组件语义，不把通用文字全部硬编码成 ui',()=>{
 const entries=extractUiStrings('({placeholder:"Find hidden settings",tooltip:"Inspect public status",confirmLabel:"Apply changes",heading:"Connection status"});React.createElement("button",{},"Review changes");');
 for(const [key,kind]of[['Find hidden settings','placeholder'],['Inspect public status','tooltip'],['Apply changes','button'],['Connection status','heading'],['Review changes','button']])assert.equal(extractedKind(entries.find(e=>e.text===key)?.kinds),kind,key);
 assert.equal(extractedKind(['template','prop']),undefined);
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · visual-audit-optimization", { concurrency: false }, async () => {
test('扫描类型与译文状态独立过滤，观察未生效仍计入待译且分页前筛选',()=>{const rows=[{key:'Save changes',status:'missing'},{key:'Cancel',translation:'取消',status:'translated',observed:'verified'},{key:'Existing translation',translation:'已有译文',status:'translated',observed:'untranslated'},{key:'${count} items',status:'dynamic'},{key:'Quit application',status:'native'},{key:'Main settings',translation:'界面设置',status:'visited',viewType:'route'}];const original=JSON.stringify(rows);assert.deepEqual(filterCoverageEntries(rows,'','missing','ui').map(r=>r.key),['Save changes','Existing translation']);assert.deepEqual(filterCoverageEntries(rows,'','all','dynamic').map(r=>r.key),['${count} items']);assert.deepEqual(filterCoverageEntries(rows,'','verified','ui').map(r=>r.key),['Cancel']);assert.deepEqual(filterCoverageEntries(rows,'界面','all','route').map(r=>r.key),['Main settings']);assert.deepEqual(filterCoverageEntries(rows,'','missing','native'),[]);assert.equal(JSON.stringify(rows),original);});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · ui-localization-supplement", { concurrency: false }, async () => {
test('版本登记幂等且术语校验共用同一策略源', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { registerSupportedBundle } = await import('../tools/extract-ui-strings.mjs');
  const { PROPER_NOUNS: coverageNouns, GLOSSARY_RULES: coverageGlossary } = await import('../dist/coverage.js');
  const { PROPER_NOUNS: reportNouns } = await import('../tools/coverage-report.mjs');
  const { PROPER_NOUNS: mergeNouns, GLOSSARY_RULES: mergeGlossary } = await import('../tools/merge-translations.mjs');

  // 1. 验证 PROPER_NOUNS 与 GLOSSARY_RULES 在 src/coverage.ts、coverage-report.mjs 与 merge-translations.mjs 指向同一事实源
  assert.strictEqual(reportNouns, coverageNouns);
  assert.strictEqual(mergeNouns, coverageNouns);
  assert.strictEqual(mergeGlossary, coverageGlossary);
  assert.ok(coverageNouns.includes('Aoede') && coverageNouns.includes('Project 4K'));

  // 2. 验证 registerSupportedBundle 能自动登记 2.29.0 等新版本指纹并保持版本升序且幂等
  const dir = await mkdtemp(join(tmpdir(), 'gb-reg-bundle-'));
  try {
    await mkdir(join(dir, 'src'), { recursive: true });
    const mockBundleTs = join(dir, 'src', 'bundle.ts');
    await writeFile(mockBundleTs, "export const SUPPORTED_BUNDLES = new Map([\n  ['2.28.0', '" + "a".repeat(64) + "'],\n]);\n", 'utf8');
    const sha229 = "b".repeat(64);
    const added = await registerSupportedBundle('2.29.0', sha229, dir);
    assert.equal(added, true, '首次登记 2.29.0 应返回 true');
    const duplicate = await registerSupportedBundle('2.29.0', sha229, dir);
    assert.equal(duplicate, false, '重复登记相同指纹应幂等返回 false');
    const updatedContent = await readFile(mockBundleTs, 'utf8');
    assert.ok(updatedContent.includes("['2.29.0', '" + sha229 + "']"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

});
});
