import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DictionaryStore, loadDictionary, loadDictionaryLayers, validateEntries } from '../dist/dictionary.js';
import { allowedTarget, parseListeners, verifyPageService } from '../dist/discovery.js';
import { assertLoopback } from '../dist/cdp.js';
import { isVerifiedVersion, extractUiStrings, findMissingStrings, createPendingList, computeBundleSha256 } from '../dist/bundle.js';
import { Controller } from '../dist/controller.js';

test('词典校验拒绝错误类型、重复规范化键和占位符丢失', () => {
  assert.throws(() => validateEntries([]));
  assert.throws(() => validateEntries({ Settings: 1 }));
  assert.throws(() => validateEntries({ Settings: '设置', ' Settings ': '配置' }));
  assert.throws(() => validateEntries({ 'Worked for {time}': '已工作' }));
  assert.deepEqual({ ...validateEntries({ 'Worked for {time}': '已工作 {time}' }) }, { 'Worked for {time}': '已工作 {time}' });
});
test('仅本机且无凭据的调试接口、同一个监听进程', () => {
  assertLoopback('ws://127.0.0.1:1234/devtools/browser/id');
  assert.throws(() => assertLoopback('ws://localhost:1234/'));
  assert.throws(() => assertLoopback('ws://127.0.0.1.example.com:1234/'));
  assert.throws(() => assertLoopback('ws://user:password@127.0.0.1:1234/'));
  assert.deepEqual(parseListeners('p100\nf30\nn127.0.0.1:1234\n', 1234), [{ pid: 100, names: ['127.0.0.1:1234'] }]);
  assert.throws(() => parseListeners('p100\nn*:1234', 1234));
});
test('未知网页、OAuth 页面与非应用标签不允许注入', () => {
  assert.equal(allowedTarget({ type: 'page', url: 'https://127.0.0.1:4321/' }), true);
  for (const path of ['/history','/sidecars','/sidecars/123','/customizations','/customizations/installed','/c/00000000-0000-0000-0000-000000000000','/customizations/plugins/gdrive','/customizations/marketplaces/official/plugins/gdocs']) assert.equal(allowedTarget({ type: 'page', url: 'https://127.0.0.1:4321'+path }), true);
  for (const url of ['https://accounts.google.com/', 'https://evil.example/', 'https://127.0.0.1.evil:4321/', 'https://127.0.0.1:4321/login', 'https://127.0.0.1/', 'file:///tmp/index.html']) assert.equal(allowedTarget({ type: 'page', url }), false);
  assert.equal(allowedTarget({ type: 'iframe', url: 'https://127.0.0.1:4321/' }), false);
  for (const path of ['/c/not-a-conversation','/api/stream','/browser','/preview','/oauth/callback']) assert.equal(allowedTarget({ type: 'page', url: 'https://127.0.0.1:4321'+path }), false);
});
test('其他本机服务不能冒充 Antigravity 页面服务', async () => {
  const server = createServer((_req, res) => res.end('test'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    assert.equal(await verifyPageService(`https://127.0.0.1:${port}/`, '/Applications/Antigravity.app'), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('原子保存触发热更新；无效 JSON 保留有效词典；删除覆盖恢复基础译文', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agzh-dict-'));
  const base = join(dir, 'base'), user = join(dir, 'user');
  await mkdir(base); await mkdir(user);
  await writeFile(join(base, 'base.json'), JSON.stringify({ Settings: '设置' }));
  await writeFile(join(user, 'override.json'), '{}');
  const store = new DictionaryStore(base, user);
  let invalid;
  store.on('invalid', error => { invalid = error; });
  try {
    await store.start();
    const update = new Promise(resolve => store.once('updated', resolve));
    await writeFile(join(user, 'next.tmp'), JSON.stringify({ Settings: '偏好设置' }));
    await rename(join(user, 'next.tmp'), join(user, 'override.json'));
    const result = await Promise.race([update, new Promise((_, reject) => setTimeout(() => reject(new Error('文件热更新超时')), 5000))]);
    assert.equal(result.entries.Settings, '偏好设置');
    const version = store.current.version;
    await writeFile(join(user, 'override.json'), '{invalid'); await store.reload();
    assert.ok(invalid); assert.equal(store.current.version, version);
    const restarted = new DictionaryStore(base, user);
    try { await restarted.start(store.current); assert.equal(restarted.current.version, version); assert.ok(restarted.lastError); }
    finally { restarted.close(); }
    await writeFile(join(user, 'override.json'), '{}'); await store.reload();
    assert.equal(store.current.entries.Settings, '设置');
    await writeFile(join(user, 'override.json'), '{"Settings":"设置一","Settings":"设置二"}');
    await assert.rejects(() => loadDictionary(base, user), /重复 JSON 键/);
    await writeFile(join(user, 'override.json'), '{}');
    /* 跨文件重复键是**分层覆盖**（新版本词典要能覆盖 base），不是错误：
       同层内后加载的文件胜出，用户目录再覆盖同层。旧实现直接抛错，
       导致"新版本词典撞一个键 => 整份词典加载失败、新词一条都不生效"。 */
    await writeFile(join(base, 'duplicate.json'), JSON.stringify({ Settings: '设置2' }));
    const layered = await loadDictionaryLayers(base, user);
    assert.equal(layered.dictionary.entries.Settings, '设置2');
    assert.deepEqual(layered.overrode, [{ key: 'Settings', from: 'base.json', to: 'duplicate.json' }]);
    await writeFile(join(user, 'override.json'), JSON.stringify({ Settings: '用户覆盖' }));
    const userWins = await loadDictionaryLayers(base, user);
    assert.equal(userWins.dictionary.entries.Settings, '用户覆盖');
    assert.ok(userWins.overrode.some(entry => entry.to === 'override.json'));
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('同层新增版本词典层可以覆盖 base，且不会让整份词典加载失败', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agzh-layer-'));
  const base = join(dir, 'base');
  await mkdir(base);
  await writeFile(join(base, 'base.json'), JSON.stringify({ Settings: '设置', History: '历史记录' }));
  await writeFile(join(base, '2.24.0.json'), JSON.stringify({ Settings: '偏好设置', 'New label': '新标签' }));
  try {
    const { dictionary, overrode } = await loadDictionaryLayers(base);
    assert.equal(dictionary.entries.Settings, '偏好设置', '版本层应覆盖 base');
    assert.equal(dictionary.entries.History, '历史记录', 'base 独有词条应保留');
    assert.equal(dictionary.entries['New label'], '新标签', '版本层新增词条应生效');
    assert.deepEqual(overrode, [{ key: 'Settings', from: 'base.json', to: '2.24.0.json' }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('版本弹性适配模式：版本校验与新词探测逻辑', () => {
  assert.equal(isVerifiedVersion('2.23.0'), true);
  assert.equal(isVerifiedVersion('2.24.0'), true);
  assert.equal(isVerifiedVersion('2.23.1'), true);
  assert.equal(isVerifiedVersion('2.99.0'), false);
  assert.equal(isVerifiedVersion(undefined), false);

  const fakeBundle = `
    A.createElement("h1", null, "New Feature Heading");
    A.createElement(B, { label: "Existing Label", description: "Brand New Description" });
  `;
  const extracted = extractUiStrings(fakeBundle);
  assert.ok(extracted.some(s => s.text === 'New Feature Heading'));
  assert.ok(extracted.some(s => s.text === 'Existing Label'));
  assert.ok(extracted.some(s => s.text === 'Brand New Description'));

  const dict = { schema: 1, version: 'test', entries: { 'Existing Label': '既有标签' } };
  const missing = findMissingStrings(extracted, dict);
  assert.deepEqual(missing, ['Brand New Description', 'New Feature Heading']);

  const pending = createPendingList('2.24.0', computeBundleSha256(fakeBundle), missing);
  assert.equal(pending.appVersion, '2.24.0');
  assert.equal(pending.missingCount, 2);
  assert.deepEqual(pending.entries.map(e => e.key), ['Brand New Description', 'New Feature Heading']);
});

test('新词抽取净化规则：准确过滤 LaTeX 宏、HTML 残片与语法碎片，确保 100% 真实 UI', () => {
  const dirtyBundle = `
    A.createElement("h1", null, "// Greet a user by name");
    A.createElement(T, { label: "/ 1M tokens" });
    A.createElement("span", null, "\\\\\\\\cdleftarrow");
    A.createElement("span", null, "\\\\\\\\cdlongequal");
    A.createElement("div", null, "</span><span style='");
    A.createElement("div", null, "Invalid delimiter type '");
  `;
  const extracted = extractUiStrings(dirtyBundle);
  const texts = extracted.map(e => e.text);
  assert.ok(texts.includes('// Greet a user by name'), '真实注释/提示必须保留');
  assert.ok(texts.includes('/ 1M tokens'), '计费/用量单位必须保留');
  assert.equal(texts.some(t => t.includes('cdleftarrow')), false, '必须过滤 LaTeX 宏');
  assert.equal(texts.some(t => t.includes('cdlongequal')), false, '必须过滤 LaTeX 宏');
  assert.equal(texts.some(t => t.includes('span style')), false, '必须过滤 HTML 标签残片');
  assert.equal(texts.some(t => t.includes('delimiter')), false, '必须过滤代码语法碎片');
});

test('当前支持明确版本，未来版本必须等待适配', () => {
  assert.equal(isVerifiedVersion('2.23.1'), true);
  assert.equal(isVerifiedVersion('2.99.0'), false);
});

test('Controller 弹性模式：后台异步比对界面包指纹，发现新词自动生成待译清单', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end('A.createElement("h1", null, "Brand New Unseen Feature"); A.createElement(t, { label: "Unknown Tool Item" });');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const stateDir = await mkdtemp(join(tmpdir(), 'agzh-test-state-'));

  try {
    let latestStatus;
    const controller = new Controller({
      appPath: '/nonexistent',
      profile: '/nonexistent',
      dictionary: { schema: 1, version: 'test', entries: { Settings: '设置' } },
      stateDir,
      onStatus: s => { latestStatus = s; }
    });
    controller.status.appVersion = '2.25.0';
    await controller['inspectBundleInBackground'](origin, '2.25.0');

    assert.equal(latestStatus.mode, 'adaptive');
    assert.equal(latestStatus.newStringsCount, 2);
    assert.ok(latestStatus.bundleSha256);
    assert.ok(latestStatus.pendingListPath);

    const pending = JSON.parse(await readFile(latestStatus.pendingListPath, 'utf8'));
    assert.equal(pending.missingCount, 2);
    assert.deepEqual(pending.entries.map(e => e.key), ['Brand New Unseen Feature', 'Unknown Tool Item']);
  } finally {
    server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('Controller 重启恢复：sync 清理无法恢复的未就绪会话，resume 重置退避计数器', async () => {
  const targetUrl = 'https://127.0.0.1:43210/';
  let detachClosed = false;
  let targetsPayload = [{
    id: 'page-1',
    type: 'page',
    url: targetUrl,
    webSocketDebuggerUrl: 'ws://127.0.0.1:43210/devtools/page/page-1',
  }];
  const server = createServer((req, res) => {
    res.setHeader('Connection', 'close');
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(targetsPayload));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const controller = new Controller({
    appPath: '/Applications/Antigravity.app',
    profile: '/nonexistent',
    dictionary: { schema: 1, version: 'test', entries: { Settings: '设置' } },
    fixture: { port, origin: 'https://127.0.0.1:43210' },
    geminiDir: '/nonexistent',
    hudEnabled: false,
    onStatus: () => {},
  });

  try {
    controller['browser'] = { close() {} };
    controller['endpoint'] = { port, browserURL: `ws://127.0.0.1:${port}/devtools/browser/1`, pid: 1, appVersion: '2.25.0', legacyPatch: false };
    controller['paused'] = false;
    controller['pages'].set('page-1', {
      targetId: 'page-1',
      url: targetUrl,
      contextId: undefined,
      detaching: false,
      updateChain: Promise.resolve(),
      cdp: {
        send: async (method) => {
          if (method === 'Page.getFrameTree') throw new Error('stale-session');
          return {};
        },
        evaluate: async () => undefined,
        close() { detachClosed = true; },
      },
    });

    await controller.sync();

    assert.equal(detachClosed, true);
    assert.equal(controller['pages'].size, 0);

    targetsPayload = [];
    controller['reconnectionDelay'] = 30000;
    controller['unverifiedWindowRetries'] = 12;
    controller['paused'] = true;
    await controller.resume();

    assert.equal(controller['reconnectionDelay'], 1000);
    assert.equal(controller['unverifiedWindowRetries'], 0);
  } finally {
    await controller.stop();
    server.closeAllConnections?.();
    server.close();
  }
});
