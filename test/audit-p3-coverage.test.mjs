import test from 'node:test';
import assert from 'node:assert/strict';
import '../dist/controller.js';
import { dictionaryFromEntries } from '../dist/dictionary.js';
import {
  coverageMetricSnapshot,
  coverageScopes,
  coverageTranslationLookup,
  createCoverage,
  extractCoverageStrings,
  isCoverageNoise,
  recordCoverageVisit,
  recountCoverage,
  resolveCoverageTranslation,
  shouldHideCoverageRow,
} from '../dist/coverage.js';

const scoped = (route, kind, text) => `@ui:${route}|${kind}|${text}`;
const dictOf = entries => dictionaryFromEntries(entries);
const config = { provider: 'openai', apiKey: 'synthetic-audit-key', baseUrl: 'https://model.invalid/v1', model: 'synthetic' };
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
