import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { TEST_CHROME_PATH } from '../tools/setup-test-browser.mjs';
import { CDP } from '../dist/cdp.js';
import { DEEP_STEPS } from '../dist/deep-scan.js';
import { DatabaseSync } from 'node:sqlite';
import { ProtobufWriter as HudWriter } from '../dist/protobuf.js';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const releaseVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const evidenceDir = join(root, '质检报告', `${releaseVersion}-改造验收`, '浏览器');
await mkdir(evidenceDir, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'gravitybox-browser-'));
const profile = join(temp, 'chrome'), state = join(temp, 'state');
const fixture = await readFile(new URL('./fixture.html', import.meta.url));
const server = createServer((req, res) => {
  if (req.url === '/fixture') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fixture); }
  else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<title>External page</title><button>Settings</button>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let chrome, backend, browserEndpoint, main, second;
let backendErrors = ''; let chromeErrors = '';
const checks = [];
async function until(fn, timeout = 6000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(`等待条件超时${last ? ': ' + last.message : ''}`);
}
async function command(command) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(state, 'control.sock'));
    let buffer = '';
    socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('命令超时')); });
    socket.on('connect', () => socket.write(JSON.stringify(typeof command==='object'?command:{command}) + '\n'));
    socket.on('error', reject);
    socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { socket.end(); resolve(JSON.parse(buffer.split('\n')[0])); } });
  });
}
async function text(cdp, selector) { return cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent`); }
async function status() { return JSON.parse(await readFile(join(state, 'status.json'), 'utf8')); }
async function override(entries, atomic = false) {
  const file = join(state, '词典', '个人覆盖.json');
  if (atomic) { await writeFile(file + '.tmp', JSON.stringify(entries)); await rename(file + '.tmp', file); }
  else await writeFile(file, JSON.stringify(entries));
}
async function check(name, fn) { await fn(); checks.push({ name, passed: true }); console.log('PASS', name); }
// A body can exist in the initial about:blank document before the requested navigation commits.
async function documentReady(cdp) {
  await until(async () => cdp.evaluate(`document.readyState === 'complete' && !!document.body && location.origin === ${JSON.stringify(origin)}`).catch(() => false));
}
// Keep browser-control transports scoped to one command, independent of page reloads and idle time.
async function browserCommand(method, params) {
  const control = new CDP(browserEndpoint);
  try { await control.connect(); return await control.send(method, params); }
  finally { control.close(); }
}
try {
  await mkdir(profile);
  const chromeBin = process.env.CHROME_BIN || process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || (existsSync(TEST_CHROME_PATH) ? TEST_CHROME_PATH : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  // These fixtures exercise DOM behavior with software rendering, not GPU behavior.
  chrome = spawn(chromeBin, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', `${origin}/fixture`], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', chunk => { chromeErrors = (chromeErrors + chunk.toString()).slice(-16000); });
  const port = await until(async () => { if (chrome.exitCode !== null) throw new Error(`测试浏览器提前退出 (${chrome.exitCode}): ${chromeErrors.slice(-600)}`); return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }, 20000);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  browserEndpoint = version.webSocketDebuggerUrl;
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.url === `${origin}/fixture`));
  main = new CDP(page.webSocketDebuggerUrl); await main.connect(); await main.send('Page.enable');
  const initialHeap = await main.send('Runtime.getHeapUsage');
  backend = spawn(process.execPath, ['--max-old-space-size=48', '--max-semi-space-size=2', join(root, 'dist/main.js'), '--state-dir', state, '--fixture-port', String(port), '--fixture-origin', origin,'--home-dir',temp,'--app-support-dir',temp,'--gemini-dir',join(temp,'gemini')], { stdio: ['ignore', 'ignore', 'pipe'],env:{...process.env,GRAVITYBOX_PROBE_LS:'false'} });
  backend.stderr.on('data', chunk => { backendErrors += chunk.toString(); });
  await until(async () => (await status()).mode === 'connected');
  const initialDictionaryVersion = (await status()).dictionaryVersion;
  await check('基础翻译与属性翻译', async () => {
    await until(async () => await text(main, '#settings') === '设置');
    assert.equal(await main.evaluate('document.querySelector("#settings").getAttribute("aria-label")'), '设置');
  });
  await check('深度扫描拒绝未发送草稿、只执行登记入口，并恢复页面和编辑区',async()=>{
    const tree=await main.send('Page.getFrameTree');const context=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.begin([])',context.executionContextId)).ok,false,'A generic non-empty input is an unsaved draft');
    await main.evaluate('document.querySelector("#input").readOnly=true');
    for(const html of ['<input id="generic-draft" value="private" />','<div data-testid="attachment-chip">file</div>','<div class="tab dirty">editor</div>','<button aria-label="Stop generating">Stop generating</button>']) {
      await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="preflight-test">${html}</div>')`);
      assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.begin([])',context.executionContextId)).ok,false,'Draft, attachment, dirty editor and generation must block navigation');
      await main.evaluate('document.querySelector("#preflight-test").remove()');
    }
    const plan=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.plan()',context.executionContextId);assert.deepEqual(plan.sort(),DEEP_STEPS.map(s=>s.id).sort());
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="deep-test"><textarea aria-label="Message input" id="deep-draft">Private draft</textarea><button data-gravitybox-deep-step="history" id="deep-history">Open list</button><div data-gravitybox-deep-catalog><div><div><div><div><a href="/customizations/plugins/sample-plugin">Sample</a></div></div></div><p>A public description</p><script>secret-script-must-not-leak</script></div></div></div>');document.querySelector('#deep-history').onclick=()=>history.pushState({},'', '?deep=history')`);
    assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.begin(["Settings"])',context.executionContextId)).ok,false);assert.equal(await main.evaluate('document.querySelector("#deep-draft").value'),'Private draft');
    await main.evaluate('document.querySelector("#deep-draft").value=""');assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.begin(["Settings"])',context.executionContextId)).ok,true);
    assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.step("delete")',context.executionContextId)).ok,false);assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.step("history")',context.executionContextId)).ok,true);
    const sample=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.sample()',context.executionContextId);assert.ok(sample.plugins.some(p=>p.description==='A public description'));assert.equal(JSON.stringify(sample).includes('secret-script'),false);
    const restored=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.finish()',context.executionContextId);assert.equal(restored.routeRestored,true);assert.equal(restored.editorsMatch,true);
    await main.evaluate('document.querySelector("#deep-test").remove()');
  });
  await check('目录说明异步加载时等待数据就绪，不把空壳页面误记为采集完成',async()=>{
    const tree=await main.send('Page.getFrameTree');const context=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="late-catalog-test"><button data-gravitybox-deep-step="marketplace" id="late-catalog-open">Open catalogue</button><div data-gravitybox-deep-catalog id="late-catalog-root"></div></div>');document.querySelector('#late-catalog-open').onclick=()=>setTimeout(()=>{document.querySelector('#late-catalog-root').innerHTML='<div><a href="/customizations/plugins/late-plugin">Late Plugin</a><p>A late public description</p></div>'},450)`);
    assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.begin([])',context.executionContextId)).ok,true);
    const started=Date.now();const step=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.step("marketplace")',context.executionContextId);assert.equal(step.ok,true);assert.equal(step.limited,false);assert.ok(Date.now()-started>=400);
    const sample=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.sample()',context.executionContextId);assert.ok(sample.plugins.some(p=>p.id==='late-plugin'));assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.finish()',context.executionContextId)).editorsMatch,true);
    await main.evaluate('document.querySelector("#late-catalog-test").remove()');
  });
  await check('快捷键避让输入框、重复按键与用户关闭；卸载只清本轮标记',async()=>{
    const tree=await main.send('Page.getFrameTree'),ctx=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    const before=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().languageMode',ctx.executionContextId);
    await main.evaluate('document.querySelector("#input").focus()');
    assert.equal(await main.evaluate(`document.querySelector('#input').dispatchEvent(new KeyboardEvent('keydown',{key:'l',code:'KeyL',metaKey:true,altKey:true,bubbles:true,cancelable:true}))`),true);
    assert.equal(await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().languageMode',ctx.executionContextId),before);
    await main.evaluate('document.activeElement.blur()');
    assert.equal(await main.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'l',code:'KeyL',metaKey:true,altKey:true,repeat:true,bubbles:true,cancelable:true}))`),true);
    assert.equal((await command({command:'shortcut_set',enabled:false})).ok,true);
    assert.equal(await main.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'l',code:'KeyL',metaKey:true,altKey:true,bubbles:true,cancelable:true}))`),true);
    assert.equal(await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().languageMode',ctx.executionContextId),before);
    await command({command:'shortcut_set',enabled:true});
    await command('pause');
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<button id="own-project" data-testid="project-header">My project</button><button id="external-project" class="gravitybox-project-name" data-testid="project-header">Other project</button>')`);
    await command('resume');
    await until(async()=>await main.evaluate('document.querySelector("#own-project").classList.contains("gravitybox-project-name")'));
    await command('pause');
    assert.equal(await main.evaluate('document.querySelector("#own-project").classList.contains("gravitybox-project-name")'),false);
    assert.equal(await main.evaluate('document.querySelector("#external-project").classList.contains("gravitybox-project-name")'),true);
    assert.equal(await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.getLanguageMode()',ctx.executionContextId),'en');
    await main.evaluate('document.querySelector("#own-project").remove();document.querySelector("#external-project").remove()');await command('resume');await until(async()=>await text(main,'#settings')==='设置');
  });
  await check('聊天、代码、输入框、终端、标题及未知区域保持英文', async () => {
    for (const selector of ['#chat', '#chat-button', '#code', '#terminal', '#title', '#unknown', '#planner-link', '#user-step', '#project-name', '#breadcrumb', '#conversation-title-link']) assert.equal(await text(main, selector), 'Settings');
    /* 真实包用 react-markdown 渲染回复，标题会命中引擎的 h1/h2/h3；正文标题必须保持原文 */
    assert.equal(await text(main, '#chat-heading'), 'Overview');
    assert.equal(await main.evaluate('document.querySelector("#input").value'), 'Settings');
    assert.equal(await main.evaluate('document.querySelector("#input").title'), 'Settings');
    assert.equal(await text(main, '#raw-email-protected'), 'user@example.com');
  });
  await check('实机会话列表结构受保护（标题是 span.truncate，不在 a[href^="/c/"] 内）', async () => {
    assert.equal(await text(main, '#conversation-title'), 'Settings');
  });
  await check('动态模板与插值规则（执行计时、相对时间、计数器与操作项）自动匹配翻译', async () => {
    assert.equal(await text(main, '#worked-for'), '已用时 49秒');
    assert.equal(await text(main, '#see-more'), '查看另外 6 项');
    assert.equal(await text(main, '#tools-enabled'), '已启用 29 个工具');
    assert.equal(await text(main, '#more-actions'), 'Google Drive 的更多操作');
    assert.equal(await text(main, '#time-badge'), '5天前');
    assert.equal(await text(main, '#feedback-sender'), '以 user@example.com 身份发送反馈');
    assert.equal(await text(main, '#browser-opt-title'), '内置浏览器');
    assert.equal(await text(main, '#browser-opt-desc'), '配置链接打开方式与内置浏览器偏好设置。');
    assert.equal(await text(main, '#open-links-in'), '链接打开方式');
    assert.equal(await text(main, '#ext-browser'), '外部浏览器');
  });
  await check('Shadow DOM 内已有界面控件汉化', async () => assert.equal(await main.evaluate('document.querySelector("#shadow").shadowRoot.querySelector("button").textContent'), '设置'));
  await check('用户命名（卡片标题/选项/列表项/技能名）不被翻译或采集，命令菜单与按钮仍翻译', async () => {
    const tree = await main.send('Page.getFrameTree');const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await until(async () => await text(main, '#real-ui-button') === '设置');
    /* 真控件继续翻译：命令菜单项与普通按钮 */
    assert.equal(await text(main, '#command-item'), '保存');
    /* 显式约定（data-gravitybox-user-content）与结构识别（实体卡片/选择器/列表行/实体详情链接）都保持英文 */
    assert.equal(await text(main, '#automation-title'), 'Settings');
    assert.equal(await text(main, '#automation-desc'), 'Synthetic private automation description');
    assert.equal(await text(main, '#automation-structural-title'), 'Settings');
    assert.equal(await text(main, '#project-option'), 'Settings');
    assert.equal(await text(main, '#skill-name'), 'History');
    assert.equal(await main.evaluate('document.querySelector("#skill-name").getAttribute("title")'), 'History');
    /* 采集侧复用同一判定：用户命名不进候选，普通界面文案仍被采集 */
    await main.evaluate('document.querySelector("#user-content-card").insertAdjacentHTML("beforeend",\'<button id="collect-probe">Inspect dynamic widget</button>\')');
    await main.evaluate('document.querySelector("#collect-probe").scrollIntoView({block:"center"})');
    await new Promise(resolve => setTimeout(resolve, 150));
    const rows = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.collectUntranslated()', context.executionContextId);
    assert.ok(rows.some(row => row.key === 'Inspect dynamic widget'), JSON.stringify(rows));
    for (const key of ['Synthetic Private Project Name', 'Synthetic private automation description', 'History']) assert.equal(rows.some(row => row.key === key), false, key);
    await main.evaluate('document.querySelector("#collect-probe").remove();window.scrollTo(0,0)');
  });
  await check('SPA 路由离开白名单立即停译并恢复英文，回到白名单后恢复汉化', async () => {
    await until(async () => await text(main, '#settings') === '设置');
    await main.evaluate('history.pushState({}, "", "/login")');
    await until(async () => await text(main, '#settings') === 'Settings');
    await main.evaluate('document.querySelector("[data-gravitybox-ui]").insertAdjacentHTML("beforeend", \'<button id="login-probe">Settings</button>\')');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await text(main, '#login-probe'), 'Settings');
    await main.evaluate('history.pushState({}, "", "/fixture")');
    await until(async () => await text(main, '#settings') === '设置');
    await until(async () => await text(main, '#login-probe') === '设置');
    await main.evaluate('document.querySelector("#login-probe").remove()');
  });
  await check('插件/第三方产品名不被汉化，插件卡片内真控件仍翻译', async () => {
    await until(async () => await text(main, '#plugin-install') === '安装');
    /* 插件名/品牌名保持原文（容器保护 + 品牌 allowlist），卡片内按钮等真控件继续翻译 */
    assert.equal(await text(main, '#plugin-card-title'), 'History');
    assert.equal(await text(main, '#brand-gemini'), 'Gemini');
    assert.equal(await text(main, '#brand-claude'), 'Claude');
  });
  await check('生产引擎按设置作用域解释同词，保留品牌与草稿原文', async () => {
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend', '<section id="term-contract"><button id="global-plan">Plan</button><div role="dialog" aria-label="Settings"><h3 id="settings-plan">Plan</h3><button id="font-brand">Inter</button><textarea id="term-draft">Plan</textarea></div></section>')`);
    try {
      await until(async () => await text(main, '#global-plan') === '规划' && await text(main, '#settings-plan') === '计划');
      assert.equal(await text(main, '#font-brand'), 'Inter');
      assert.equal(await main.evaluate('document.querySelector("#term-draft").value'), 'Plan');
    } finally { await main.evaluate('document.querySelector("#term-contract")?.remove()'); }
  });
  await main.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 840, deviceScaleFactor: 1, mobile: false });
  await check('下拉控件点击后英文内部键保持不变', async () => {
    await main.evaluate('document.querySelector("#dropdown").click();document.querySelector("[data-value]").click()');
    assert.equal(await text(main, '#result'), 'keep-english-key');
  });
  let updateDuration;
  await check('原子保存自动改译，已显示中文无需重启更新', async () => {
    const start = Date.now(); await override({ Settings: '偏好设置', 'Custom action': '自定义操作' }, true);
    await until(async () => await text(main, '#settings') === '偏好设置'); updateDuration = Date.now() - start;
    await until(async () => await text(main, '#custom') === '自定义操作');
    await until(async () => (await status()).dictionaryVersion !== initialDictionaryVersion);
  });
  await check('错误 JSON 保留上一有效词典，并显示错误', async () => {
    const before = (await status()).dictionaryVersion;
    await writeFile(join(state, '词典', '个人覆盖.json'), '{invalid');
    await until(async () => !!(await status()).dictionaryError);
    assert.equal(await text(main, '#settings'), '偏好设置'); assert.equal((await status()).dictionaryVersion, before);
  });
  await check('删除词条恢复原文；删除覆盖回退基础词典', async () => {
    await override({}); await until(async () => await text(main, '#settings') === '设置');
    assert.equal(await text(main, '#custom'), 'Custom action');
  });
  await check('应用动态改写节点被正确识别', async () => {
    await main.evaluate('document.querySelector("#settings").firstChild.nodeValue="Cancel"');
    await until(async () => await text(main, '#settings') === '取消');
  });
  await check('新增按钮自动翻译，移入聊天区后恢复原文', async () => {
    await main.evaluate('const b=document.createElement("button");b.id="late-button";b.textContent="Settings";document.querySelector("#late").append(b)');
    await until(async () => await text(main, '#late-button') === '设置');
    await main.evaluate('document.querySelector("[data-message-author-role]").append(document.querySelector("#late-button"))');
    await until(async () => await text(main, '#late-button') === 'Settings');
  });
  await check('第二窗口自动连接并接收词典更新', async () => {
    const target = await browserCommand('Target.createTarget', { url: `${origin}/fixture` });
    const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page => page.id === target.targetId));
    second = new CDP(page.webSocketDebuggerUrl); await second.connect();
    await until(async () => (await status()).windows === 2);
    await override({ Settings: '窗口同步设置' });
    await until(async () => await text(second, '#settings') === '窗口同步设置');
    await until(async () => await text(main, '#settings') === '取消');
  });
  await check('刷新后采用最新词典自动恢复汉化', async () => {
    await main.send('Page.reload'); await until(async () => await text(main, '#settings') === '窗口同步设置');
  });
  await check('连续热更新与重复应用不叠加引擎', async () => {
    for (let i = 0; i < 12; i++) { await override({ Settings: `设置第${i}版` }); await until(async () => await text(main, '#settings') === `设置第${i}版`); }
    const tree = await main.send('Page.getFrameTree');
    const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    const metrics = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state()', context.executionContextId);
    assert.equal(metrics.observedRoots, 2); assert.ok(metrics.translatedNodes < 100);
    await command('resume');
    const repeated = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state()', context.executionContextId);
    assert.equal(repeated.observedRoots, metrics.observedRoots);
  });
  await check('快速连续保存后两个窗口采用同一最终词典', async () => {
    for (let i = 0; i < 6; i++) { await override({ Settings: `快速保存${i}` }, true); await new Promise(resolve => setTimeout(resolve, 40)); }
    await until(async () => await text(main, '#settings') === '快速保存5' && await text(second, '#settings') === '快速保存5');
    assert.deepEqual((await status()).errors, []);
    await override({ Settings: '设置第11版' }); await until(async () => await text(main, '#settings') === '设置第11版');
  });
  await check('写坏词典后重启助手采用持久化的有效词典', async () => {
    await writeFile(join(state, '词典', '个人覆盖.json'), '{invalid');
    await until(async () => !!(await status()).dictionaryError);
    await command('stop'); await until(async () => backend.exitCode === 0);
    backend = spawn(process.execPath, ['--max-old-space-size=48', '--max-semi-space-size=2', join(root, 'dist/main.js'), '--state-dir', state, '--fixture-port', String(port), '--fixture-origin', origin, '--home-dir', temp, '--app-support-dir', temp, '--gemini-dir', join(temp, 'gemini')], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GRAVITYBOX_PROBE_LS: 'false' } });
    backend.stderr.on('data', chunk => { backendErrors += chunk.toString(); });
    await until(async () => (await status()).mode === 'connected' && !!(await status()).dictionaryError);
    await until(async () => await text(main, '#settings') === '设置第11版');
    await override({ Settings: '设置第11版' });
    await until(async () => !(await status()).dictionaryError);
  });
  await check('暂停恢复英文；恢复连接后重新汉化', async () => {
    assert.equal((await command('pause')).ok, true);
    assert.equal(await text(main, '#settings'), 'Settings');
    assert.equal(await text(second, '#settings'), 'Settings');
    await command('resume'); await until(async () => await text(main, '#settings') === '设置第11版');
  });
  await check('未知页面不注入，返回受支持页面后恢复', async () => {
    await main.send('Page.navigate', { url: `${origin}/external` });
    await until(async () => (await status()).windows === 1);
    assert.equal(await main.evaluate('document.querySelector("button").textContent'), 'Settings');
    await main.send('Page.navigate', { url: `${origin}/fixture` });
    await until(async () => await text(main, '#settings') === '设置第11版');
  });
  await check('一键中英双语热切换（Toggle）、CSS Micro-Patch 及 data-gravitybox-loc 生效验证', async () => {
    const hasStyle = await main.evaluate('!!document.getElementById("__gravitybox_micro_patch__")');
    assert.equal(hasStyle, true);
    const patchCss = await main.evaluate('document.getElementById("__gravitybox_micro_patch__")?.textContent ?? ""');
    assert.equal(patchCss.includes('font-family'), false, 'CSS Micro-Patch 不得覆盖宿主 font-family 继承链');
    assert.equal(patchCss.includes('-webkit-font-smoothing'), false, 'CSS Micro-Patch 不得覆盖宿主字体抗锯齿模式');

    // 验证翻译节点自动打标，切换语言时能正确撤销。
    const btnLoc = await main.evaluate('document.querySelector("#plain-btn")?.dataset?.gravityboxLoc');
    assert.equal(btnLoc, '1');

    const tree = await main.send('Page.getFrameTree');
    const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    const toggleToEn = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage("en")', context.executionContextId);
    assert.equal(toggleToEn.mode, 'en');
    assert.equal(await text(main, '#settings'), 'Settings');
    const btnLocEn = await main.evaluate('document.querySelector("#plain-btn")?.dataset?.gravityboxLoc');
    assert.equal(btnLocEn, undefined);

    const toggleToZh = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage("zh")', context.executionContextId);
    assert.equal(toggleToZh.mode, 'zh');
    assert.equal(await text(main, '#settings'), '设置第11版');
    const btnLocZh = await main.evaluate('document.querySelector("#plain-btn")?.dataset?.gravityboxLoc');
    assert.equal(btnLocZh, '1');
  });
  await check('复合内联元素整句重组翻译（Inline-Group Contextual Translation）与无损还原', async () => {
    // 验证句子被整句模板翻译，且保留了 code 与 a 等内联节点
    await until(async () => (await text(main, '#delete-prompt'))?.includes('您确定要删除'));
    assert.equal(await text(main, '#delete-prompt'), '您确定要删除 my-branch 吗？');
    const codeTag = await main.evaluate('document.querySelector("#delete-prompt code")?.textContent');
    assert.equal(codeTag, 'my-branch');

    assert.equal(await text(main, '#ai-credits-prompt'), 'AI 额度会在超出模型配额时使用。请在 设置第11版 中查看您当前的 AI 额度。');
    const linkHref = await main.evaluate('document.querySelector("#ai-credits-prompt a")?.getAttribute("href")');
    assert.equal(linkHref, '/settings');

    // 切换英文时复合内联节点无损还原
    const tree = await main.send('Page.getFrameTree');
    const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage("en")', context.executionContextId);
    assert.equal(await text(main, '#delete-prompt'), 'Are you sure you want to delete the my-branch?');
    assert.equal(await main.evaluate('document.querySelector("#delete-prompt code")?.textContent'), 'my-branch');

    await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage("zh")', context.executionContextId);
    assert.equal(await text(main, '#delete-prompt'), '您确定要删除 my-branch 吗？');
  });
  await check('内联模板：两占位符仅安全同序应用；重排/省略保留完整英文并标记 unsupported，整句采集', async () => {
    const tree = await main.send('Page.getFrameTree');const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    /* 伪词避免碎片被基础词典单独命中；<a> 用于验证不支持时链接文字/交互不被清空 */
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="j04-probe" data-gravitybox-ui><p id="j04-same">Snorfle <code>alpha</code> blim <code>beta</code>.</p><p id="j04-reorder">Blorp <a href="/help" id="j04-reorder-link">docs</a> zib <code>beta</code>.</p><p id="j04-omit">Glim <a href="/g" id="j04-omit-link">docs</a> zorp.</p></div>')`);
    await until(async () => await text(main, '#j04-same') === 'Snorfle alpha blim beta.');
    const original = await main.evaluate('globalThis.__GRAVITYBOX_BOOT__.dictionary', context.executionContextId);
    const probe = { ...original, version: 'j04-fix-' + Date.now(), entries: { ...original.entries,
      'Snorfle {0} blim {1}.': '斯诺福 {0} 布林 {1}。',
      'Blorp {0} zib {1}.': '先 {1}，再 {0}。',
      'Glim {0} zorp.': '格利姆。' } };
    await main.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__.update(${JSON.stringify(probe)})`, context.executionContextId);
    /* 两占位符、顺序一致且每个非空译文段都有现成文本槽：安全原地应用，顺序正确 */
    await until(async () => await text(main, '#j04-same') === '斯诺福 alpha 布林 beta。');
    assert.equal(await main.evaluate('document.querySelector("#j04-same code")?.textContent'), 'alpha');
    /* 重排（引擎不支持安全重排）与省略占位符：保留完整英文，不半译、不清空链接 */
    await until(async () => await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().unsupportedGroups >= 2', context.executionContextId));
    assert.equal(await text(main, '#j04-reorder'), 'Blorp docs zib beta.');
    assert.equal(await text(main, '#j04-omit'), 'Glim docs zorp.');
    assert.equal(await main.evaluate('document.querySelector("#j04-reorder-link")?.textContent'), 'docs');
    assert.equal(await main.evaluate('document.querySelector("#j04-reorder-link")?.getAttribute("href")'), '/help');
    assert.ok(await main.evaluate('document.querySelector("#j04-reorder-link").getClientRects().length > 0'));
    assert.equal(await main.evaluate('!!document.querySelector("#j04-reorder").dataset.gravityboxLoc || !!document.querySelector("#j04-omit").dataset.gravityboxLoc'), false);
    /* 仍整句采集：unsupported 也给出整句 key + layoutWarning，不产生碎片 */
    await main.evaluate('document.querySelector("#j04-probe").scrollIntoView({block:"center"})');
    await new Promise(resolve => setTimeout(resolve, 150));
    const rows = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.collectUntranslated()', context.executionContextId);
    for (const key of ['Blorp {0} zib {1}.', 'Glim {0} zorp.']) {
      const row = rows.find(item => item.key === key);
      assert.ok(row, key + ' missing: ' + JSON.stringify(rows).slice(0, 400));
      assert.ok(row.layoutWarning && row.layoutWarning.includes('内联'), key + ' layoutWarning');
    }
    for (const fragment of ['Blorp', 'zib', 'Glim', 'zorp']) assert.equal(rows.some(item => item.key === fragment), false, fragment);
    /* 恢复基础词典：同序译文恢复英文，unsupported 句也保持英文，链接仍可见 */
    await main.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__.update(${JSON.stringify(original)})`, context.executionContextId);
    await until(async () => await text(main, '#j04-same') === 'Snorfle alpha blim beta.');
    assert.equal(await text(main, '#j04-reorder'), 'Blorp docs zib beta.');
    assert.equal(await main.evaluate('document.querySelector("#j04-reorder-link")?.textContent'), 'docs');
    await main.evaluate('document.querySelector("#j04-probe").remove()');
  });
  await check('内联模板：合法同序但无尾 slot 的译文安全应用，<a> 文字可见可点，英文恢复无损', async () => {
    const tree = await main.send('Page.getFrameTree');const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="j04-notail-probe" data-gravitybox-ui><p id="j04-notail">Blorks <a href="/docs" id="j04-notail-link">quuxdocs</a></p><p id="j04-two">Glorp <code>alpha</code> blim <code>beta</code></p><p id="j04-tailmiss">Gronk <a href="/docs2" id="j04-tailmiss-link">quuxdocs</a></p></div>')`);
    await until(async () => await text(main, '#j04-notail') === 'Blorks quuxdocs');
    const original = await main.evaluate('globalThis.__GRAVITYBOX_BOOT__.dictionary', context.executionContextId);
    const probe = { ...original, version: 'j04-notail-' + Date.now(), entries: { ...original.entries,
      'Blorks {0}': '阅读{0}',
      'Glorp {0} blim {1}': '{0} 与 {1}',
      /* 合法同序，但译文在占位符之后追加文字：原句没有尾文本 run -> 必须保留完整英文 */
      'Gronk {0}': '{0}，请阅读' } };
    await main.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__.update(${JSON.stringify(probe)})`, context.executionContextId);
    /* 无尾 slot（英文以占位符结尾、译文不再追加文字）是合法同序：应用后链接文字保留在 <a> 内 */
    await until(async () => await text(main, '#j04-notail') === '阅读quuxdocs');
    await until(async () => await text(main, '#j04-two') === 'alpha 与 beta');
    assert.equal(await main.evaluate('document.querySelector("#j04-notail-link")?.textContent'), 'quuxdocs');
    assert.equal(await main.evaluate('document.querySelector("#j04-notail-link")?.getAttribute("href")'), '/docs');
    assert.ok(await main.evaluate('document.querySelector("#j04-notail-link").getClientRects().length > 0'));
    assert.notEqual(await main.evaluate('getComputedStyle(document.querySelector("#j04-notail-link")).pointerEvents'), 'none');
    /* 真正缺尾 slot：同序译文 '{0}，请阅读' 需要占位符后的文本 run，但原句没有 -> 完整英文 + unsupported */
    assert.equal(await text(main, '#j04-tailmiss'), 'Gronk quuxdocs');
    assert.ok(await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().unsupportedGroups >= 1', context.executionContextId));
    assert.equal(await main.evaluate('document.querySelector("#j04-tailmiss-link")?.textContent'), 'quuxdocs');
    assert.equal(await main.evaluate('document.querySelector("#j04-tailmiss-link")?.getAttribute("href")'), '/docs2');
    assert.ok(await main.evaluate('document.querySelector("#j04-tailmiss-link").getClientRects().length > 0'));
    assert.equal(await main.evaluate('!!document.querySelector("#j04-tailmiss").dataset.gravityboxLoc'), false);
    await main.evaluate('document.querySelector("#j04-notail-probe").scrollIntoView({block:"center"})');
    await new Promise(resolve => setTimeout(resolve, 150));
    const tailRows = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.collectUntranslated()', context.executionContextId);
    const tailRow = tailRows.find(item => item.key === 'Gronk {0}');
    assert.ok(tailRow, 'missing-tail whole key absent: ' + JSON.stringify(tailRows).slice(0, 400));
    assert.ok(tailRow.layoutWarning && tailRow.layoutWarning.includes('内联'), 'missing-tail layoutWarning');
    /* 恢复英文：内联结构与链接文字无损 */
    await main.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__.update(${JSON.stringify(original)})`, context.executionContextId);
    await until(async () => await text(main, '#j04-notail') === 'Blorks quuxdocs');
    await until(async () => await text(main, '#j04-two') === 'Glorp alpha blim beta');
    assert.equal(await text(main, '#j04-tailmiss'), 'Gronk quuxdocs');
    assert.equal(await main.evaluate('document.querySelector("#j04-tailmiss-link")?.textContent'), 'quuxdocs');
    assert.equal(await main.evaluate('document.querySelector("#j04-notail-link")?.textContent'), 'quuxdocs');
    await main.evaluate('document.querySelector("#j04-notail-probe").remove()');
  });
  await check('%s/ICU 占位符不支持时明确披露（能力清单与候选标记）', async () => {
    const tree = await main.send('Page.getFrameTree');const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    const caps = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.capabilities()', context.executionContextId);
    assert.ok(caps.unsupported.includes('%s'));
    assert.ok(caps.unsupported.includes('icu-plural'));
    assert.ok(/\{N\}/.test(caps.placeholders.supported.join()));
    assert.equal(await text(main, '#percent-placeholder'), '%s items selected');
    await main.evaluate('document.querySelector("#percent-placeholder").scrollIntoView({block:"center"})');
    await new Promise(resolve => setTimeout(resolve, 120));
    const rows = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.collectUntranslated()', context.executionContextId);
    const percent = rows.find(row => row.key === '%s items selected');
    assert.ok(percent, JSON.stringify(rows).slice(0, 400));
    assert.ok(percent.formatWarning && percent.formatWarning.includes('%s'));
    const icu = rows.find(row => /plural/.test(row.key));
    assert.ok(icu && icu.formatWarning, JSON.stringify(rows).slice(0, 400));
    assert.ok(await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().capabilities.unsupported.includes("icu-plural")', context.executionContextId));
  });
  await check('模型配额与动态时间子句及模型分组标题汉化', async () => {
    const quotaHtml = `
      <div id="quota-test" role="dialog">
        <h4 id="gemini-header">Gemini Models</h4>
        <h4 id="claude-header">Claude and GPT models</h4>
        <p id="quota-weekly">You have used some of your weekly limit, it will fully refresh in 20 hours, 52 minutes.</p>
        <p id="quota-5h">You have used some of your 5-hour limit, it will fully refresh in 54 minutes.</p>
      </div>
    `;
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(quotaHtml)})`);
    await until(async () => await text(main, '#gemini-header') === 'Gemini 系列模型');
    assert.equal(await text(main, '#claude-header'), 'Claude 与 GPT 系列模型');
    assert.equal(await text(main, '#quota-weekly'), '您已使用了部分每周限额，将在 20小时 52分钟 后完全刷新。');
    assert.equal(await text(main, '#quota-5h'), '您已使用了部分5小时限额，将在 54分钟 后完全刷新。');
  });
  await check('真实模型容器仅放行固定标签，动态重置时间和命令展示汉化，模型与正文保持原样', async () => {
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend', '<div id="actual-model-menu" role="menu"><div data-testid="model-selector-panel"><h4 id="actual-model-label">Model</h4><div data-testid="model-option"><span id="actual-model-name">Settings</span><span id="actual-new">New</span></div><div role="menuitem"><span id="actual-usage">View Usage</span></div><div><span id="actual-weekly">Weekly Limit Remaining</span><span id="actual-reset">Resets in 6d 17h</span></div><div data-gravitybox-protect><span id="protected-quota">Weekly Limit Remaining</span></div></div></div><div role="option"><span id="compact-name">compact</span><span id="compact-description">Compact the conversation now (summarize history to free up the context window).</span><span id="teamwork-name">teamwork-preview</span></div>')`);
    await until(async()=>await text(main,'#actual-usage')==='查看用量');
    assert.equal(await text(main,'#actual-model-name'),'Settings');assert.equal(await text(main,'#actual-weekly'),'每周剩余限额');assert.equal(await text(main,'#protected-quota'),'Weekly Limit Remaining');assert.equal(await text(main,'#actual-reset'),'6天 17小时后重置');assert.equal(await text(main,'#compact-name'),'压缩对话');assert.equal(await text(main,'#teamwork-name'),'智能体团队（预览）');
    assert.equal(await text(main,'#actual-new'),'新');
    await main.evaluate(`document.querySelector('#actual-model-menu [data-testid="model-selector-panel"]').insertAdjacentHTML('beforeend','<div role="presentation"><div role="menu"><div role="group"><div role="presentation" id="late-quota-heading">Gemini Models</div><div><span id="late-quota-reset">Resets in 2h 11m</span></div></div></div></div>')`);
    await until(async()=>await text(main,'#late-quota-reset')==='2小时 11分钟后重置');assert.equal(await text(main,'#late-quota-heading'),'Gemini 系列模型');
    const tree=await main.send('Page.getFrameTree');const context=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    const before=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().scanCount',context.executionContextId);await new Promise(resolve=>setTimeout(resolve,300));assert.equal(await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().scanCount',context.executionContextId),before);
    await main.evaluate('document.querySelector("#actual-model-menu").scrollIntoView({block:"start"})');
    const audit=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.auditUi(["View Usage","Settings","Weekly Limit Remaining"])',context.executionContextId);assert.ok(audit.observations.some(e=>e.key==='View Usage'&&e.state==='verified'));assert.ok(audit.observations.some(e=>e.key==='Resets in {duration}'&&e.state==='verified'));
  });
  await check('模型分组说明保留模型名，动态更新与秒级重置可翻译，受保护内容不变', async () => {
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="group-label-fixture" role="tooltip"><div data-testid="model-selector-panel"><span id="group-models">Models within this group: Gemini 3.8 Flash, Claude Sonnet 5.5, GPT-OSS 120B</span><span id="group-seconds">Resets in 3h 21m 9s</span><span id="group-soon">Resets in &lt;1m</span><div data-gravitybox-protect><span id="group-private">Models within this group: Gemini Private</span></div></div></div>')`);
    await until(async () => await text(main, '#group-models') === '此组包含的模型：Gemini 3.8 Flash, Claude Sonnet 5.5, GPT-OSS 120B');
    assert.equal(await text(main, '#group-seconds'), '3小时 21分钟 9秒后重置');
    assert.equal(await text(main, '#group-soon'), '将在 1 分钟内重置');
    assert.equal(await text(main, '#group-private'), 'Models within this group: Gemini Private');
    await main.evaluate(`document.querySelector('#group-models').textContent = 'Models within this group: Gemini 4 Argon (High)'`);
    await until(async () => await text(main, '#group-models') === '此组包含的模型：Gemini 4 Argon (High)');
    await main.evaluate(`document.querySelector('#group-label-fixture').remove()`);
  });
  await check('短暂菜单关闭后仍能保存已审核文案的巡检结果，停止后不再记录',async()=>{
    const tree=await main.send('Page.getFrameTree');const context=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.startAudit(["View Usage"])',context.executionContextId);
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="transient-audit-menu" role="menu"><div data-testid="model-selector-panel"><span id="transient-audit-label">View Usage</span></div></div>');document.querySelector('#transient-audit-menu').scrollIntoView({block:'start'})`);
    await until(async()=>await text(main,'#transient-audit-label')==='查看用量');await main.evaluate('document.querySelector("#transient-audit-menu").remove()');
    const audit=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.auditUi(["View Usage"])',context.executionContextId);assert.ok(audit.recent.some(e=>e.key==='View Usage'&&e.state==='verified'));assert.equal(JSON.stringify(audit.recent).includes('Settings'),false);
    await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.stopAudit()',context.executionContextId);assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.auditUi(["View Usage"])',context.executionContextId)).auditActive,false);
  });
  await check('页面扫描仅返回清单内的安全界面文案，未知文字和保护内容不出页面',async()=>{
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div data-gravitybox-ui><button id="unknown-ui-probe">Private unknown interface text</button></div><div class="prose"><button>Private protected content</button></div><button style="position:absolute;top:100000px" id="offscreen-audit">Offscreen interface label</button>')`);
    await main.evaluate('document.querySelector("#unknown-ui-probe").scrollIntoView({block:"start"})');
    const tree=await main.send('Page.getFrameTree');const context=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    const audit=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.auditUi(["View Usage","Private protected content","Offscreen interface label"])',context.executionContextId);assert.ok(audit.unmatchedCount>0);assert.ok(audit.protectedCount>0);assert.equal(JSON.stringify(audit).includes('Private'),false);assert.equal(JSON.stringify(audit).includes('Offscreen'),false);
    await main.evaluate('document.querySelector("#unknown-ui-probe").parentElement.remove()');
  });
  await check('会话操作按钮元信息汉化，标题和正文中的同名内容保持原样',async()=>{
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div data-testid="conversation-row-sidebar"><span class="truncate" id="action-same-title">Pin conversation</span><button id="pin-ui-probe" aria-label="Pin conversation"></button><div data-gravitybox-protect><button id="protected-pin-probe" aria-label="Pin conversation"></button></div></div>')`);
    await until(async()=>await main.evaluate('document.querySelector("#pin-ui-probe").getAttribute("aria-label")')==='置顶对话');assert.equal(await text(main,'#action-same-title'),'Pin conversation');assert.equal(await main.evaluate('document.querySelector("#protected-pin-probe").getAttribute("aria-label")'),'Pin conversation');
  });
  await check('自定义页独立搜索框与分组元信息可翻译，输入值及未知区域保持原样',async()=>{
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div><input id="standalone-custom-search" placeholder="Search customizations..." value="My private search"><div id="standalone-custom-group" role="group" aria-label="Customizations views"></div><button id="older-message-label">Load older messages, showing 10 of 1311</button></div><div class="prose"><input id="protected-custom-search" placeholder="Search customizations..."></div>')`);
    await until(async()=>await main.evaluate('document.querySelector("#standalone-custom-search").getAttribute("placeholder")')==='搜索自定义项...');assert.equal(await main.evaluate('document.querySelector("#standalone-custom-search").value'),'My private search');assert.equal(await main.evaluate('document.querySelector("#standalone-custom-group").getAttribute("aria-label")'),'自定义项视图');assert.equal(await main.evaluate('document.querySelector("#protected-custom-search").getAttribute("placeholder")'),'Search customizations...');assert.equal(await text(main,'#older-message-label'),'加载更早消息（已显示 10 / 1311 条）');
  });
  await check('⌥⌘L 窗口快捷键双语热切换与候选语境', async () => {
    const tree = await main.send('Page.getFrameTree');
    const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });

    // 1. 验证 collectUntranslated 返回包含 { key, kind }
    const uncollected = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.collectUntranslated()', context.executionContextId);
    assert.ok(Array.isArray(uncollected));
    if (uncollected.length > 0) {
      assert.ok('key' in uncollected[0]);
      assert.ok('kind' in uncollected[0]);
    }

    // 2. 模拟 ⌥⌘L 切换到英文
    await main.evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'l',
        code: 'KeyL',
        altKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true
      }))
    `, context.executionContextId);

    await until(async () => await text(main, '#settings') === 'Settings');

    // 3. 模拟 ⌥⌘L 再次切换回中文
    await main.evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'l',
        code: 'KeyL',
        altKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true
      }))
    `, context.executionContextId);

    await until(async () => await text(main, '#settings') === '设置第11版');
  });
  await check('真实侧边栏时间徽章在祖先变化后不循环，正文时间文本受保护', async () => {
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend', '<div data-testid="conversation-row-sidebar" id="badge-row"><div><span id="protected-badge">5d</span><span class="truncate" id="time-title">5d</span></div></div><div class="markdown"><span id="time-body">Before</span></div>')`);
    const tree = await main.send('Page.getFrameTree');
    const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await until(async () => await text(main, '#protected-badge') === '5天前');
    await main.evaluate('document.querySelector("#badge-row").className="focused";document.querySelector("#time-body").firstChild.nodeValue="5d"');
    await until(async () => (await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().pending', context.executionContextId)) === 0);
    assert.equal(await text(main, '#time-title'), '5d'); assert.equal(await text(main, '#time-body'), '5d');
    const before = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().scanCount', context.executionContextId);
    await new Promise(r => setTimeout(r, 1000));
    assert.equal(await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().scanCount', context.executionContextId), before);
  });
  await check('采集候选重新检查保护状态，排除句中的路径与邮箱', async () => {
    const tree = await main.send('Page.getFrameTree'); const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend', '<button id="candidate">Synthetic Private Project Name</button><button id="candidate-path">Open /Users/demo/Private.txt</button><button id="candidate-email">Email person@example.test</button>')`);
    await until(async () => (await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.collectUntranslated()', context.executionContextId)).some(e => e.key === 'Synthetic Private Project Name'));
    await main.evaluate('document.querySelector("#candidate").setAttribute("data-gravitybox-protect", "true")');
    const candidates = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.collectUntranslated()', context.executionContextId);
    for (const key of ['Synthetic Private Project Name', 'Open /Users/demo/Private.txt', 'Email person@example.test']) assert.equal(candidates.some(e => e.key === key), false);
    await main.evaluate('["candidate","candidate-path","candidate-email"].forEach(id=>document.getElementById(id).remove())');
  });
  await check('内联组部分动态更新还原旧片段，移除节点释放记录', async () => {
    const tree = await main.send('Page.getFrameTree'); const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await main.evaluate('document.querySelector("#delete-prompt").firstChild.nodeValue="Audit preserved "');
    await until(async () => await text(main, '#delete-prompt') === 'Audit preserved my-branch?');
    const baseline = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().translatedNodes', context.executionContextId);
    await main.evaluate(`const section=document.createElement('section'); section.id='remove-probe'; section.setAttribute('data-gravitybox-ui','');section.innerHTML=Array.from({length:200},()=>'<button>Save</button>').join('');document.body.append(section)`);
    await until(async () => (await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().translatedNodes', context.executionContextId)) >= baseline + 200);
    await main.evaluate('document.getElementById("remove-probe").remove()');
    await until(async () => (await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().translatedNodes', context.executionContextId)) <= baseline);
  });
  await new Promise(resolve => setTimeout(resolve, 3000));

  await check('场景词典按角色应用，界面候选包含语境而不收集隐藏或受保护内容',async()=>{
    const tree=await main.send('Page.getFrameTree'),ctx=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    await override({'@ui:/fixture|button|Open resource':'打开资源','@ui:/fixture|heading|Open resource':'资源开放状态'});
    await main.evaluate(`(()=>{const el=document.createElement('section');el.id='context-test';el.innerHTML='<button id="ctx-button">Open resource</button><h2 id="ctx-heading">Open resource</h2><button id="ctx-new">Inspect dynamic widget</button><button style="display:none">Hidden private widget</button><div data-message-id="private"><button>Private account content</button></div>';document.body.prepend(el)})()`);
    await until(async()=>await text(main,'#ctx-button')==='打开资源');await main.evaluate('window.scrollTo(0,0)');assert.equal(await text(main,'#ctx-heading'),'资源开放状态');
    const rows=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.collectUntranslated()',ctx.executionContextId);const row=rows.find(r=>r.key==='Inspect dynamic widget');assert.equal(row.kind,'button');assert.equal(row.route,'/fixture');assert.equal(row.source,'runtime-ui');assert.equal(JSON.stringify(rows).includes('Hidden private'),false);assert.equal(JSON.stringify(rows).includes('Private account'),false);
    await main.evaluate('document.querySelector("#context-test").remove()');await override({});
  });
  await check('动态规则和内联模板记录真实命中，英文对照不被报告为漏译',async()=>{
    const tree=await main.send('Page.getFrameTree'),ctx=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    await override({'Audit contextual reference {0}.':'审查{0}的上下文参考。'});
    await main.evaluate(`(()=>{const el=document.createElement('div');el.id='rule-test';el.innerHTML='<button id="rule-worked">Worked for 23s</button><div id="rule-inline" role="alert">Audit contextual reference <a href="#read-only">Public docs</a>.</div>';document.body.prepend(el)})()`);
    await until(async()=>/已用时/.test(await text(main,'#rule-worked')));await main.evaluate('window.scrollTo(0,0)');await until(async()=>(await text(main,'#rule-inline'))==='审查Public docs的上下文参考。');
    const rows=await until(async()=>{const r=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.auditUi(["Worked for {duration}","Audit contextual reference {0}."])',ctx.executionContextId);if(r?.observations?.some(item=>item.key==='Worked for {duration}'&&item.state==='verified'))return r;},6000);assert.ok(rows.observations.some(r=>r.key==='Worked for {duration}'&&r.state==='verified'));assert.ok(rows.observations.some(r=>r.key==='Audit contextual reference {0}.'&&r.state==='verified'),JSON.stringify(rows));
    await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage("en")',ctx.executionContextId);await until(async()=>['en','mixed'].includes((await status()).languageMode));const english=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.auditUi(["Worked for {duration}"])',ctx.executionContextId);assert.equal(english.intentionalEnglish,true);assert.equal(english.observations.length,0);
    await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage("zh")',ctx.executionContextId);await until(async()=>(await status()).languageMode==='zh');await main.evaluate('document.querySelector("#rule-test").remove()');await override({});
  });
  await check('兼容模式保留严格模板与控件译文，仍保护个人内容和复杂内联',async()=>{
    await command('pause');await until(async()=>(await status()).mode==='paused');
    const tree=await main.send('Page.getFrameTree'),ctx=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-conservative-test'});
    await main.evaluate(`(()=>{const el=document.createElement('div');el.id='conservative-test';el.innerHTML='<button id="conservative-known">Known action</button><button id="conservative-dynamic">Worked for 91s</button><div data-message-id="protected"><button id="conservative-private">Known action</button></div>';document.body.prepend(el)})()`);
    const engine=await readFile(join(root,'dist/engine.js'),'utf8');await main.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({origin,path:'/fixture',conservative:true,dictionary:{schema:1,version:'conservative',entries:{'Known action':'已知操作'}}})};
${engine}`,ctx.executionContextId);
    await until(async()=>await text(main,'#conservative-known')==='已知操作');assert.equal(await text(main,'#conservative-dynamic'),'已用时 91秒');assert.equal(await text(main,'#conservative-private'),'Known action');await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()',ctx.executionContextId);await main.evaluate('document.querySelector("#conservative-test").remove()');await command('resume');await until(async()=>(await status()).mode==='connected');
  });
  await check('插件说明仅在明确的目录卡片应用场景译文，不翻译同文普通段落',async()=>{
    const target=await browserCommand('Target.createTarget',{url:origin+'/customizations'});let cdp;
    try{
      const page=await until(async()=>(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.id===target.targetId));cdp=new CDP(page.webSocketDebuggerUrl);await cdp.connect();await documentReady(cdp);const tree=await cdp.send('Page.getFrameTree'),ctx=await cdp.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-plugin-test'});
      await cdp.evaluate(`document.body.innerHTML='<main><div><a href="/customizations/plugins/public-plugin">Public Plugin</a><p id="plugin-desc">Read and draft public documents.</p><button>Install</button></div><p id="outside-desc">Read and draft public documents.</p></main>'`);
      const engine=await readFile(join(root,'dist/engine.js'),'utf8');await cdp.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({origin,path:'/customizations',dictionary:{schema:1,version:'plugin',entries:{'@ui:/customizations|description|Read and draft public documents.':'阅读并起草公共文档。'}}})};
${engine}`,ctx.executionContextId);await until(async()=>await text(cdp,'#plugin-desc')==='阅读并起草公共文档。');assert.equal(await text(cdp,'#outside-desc'),'Read and draft public documents.');await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()',ctx.executionContextId);
      const gate=await cdp.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-gated-test'});
      await cdp.evaluate(`document.body.innerHTML='<button id="gate-known">Known gated action</button>'`);
      await cdp.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({origin,path:'/customizations',conservative:true,dictionary:{schema:1,version:'gate',entries:{'Known gated action':'已识别操作'}}})};
${engine}`,gate.executionContextId);assert.equal(await text(cdp,'#gate-known'),'Known gated action');
      await cdp.evaluate(`document.body.insertAdjacentHTML('beforeend','<nav aria-label="Sidebar"><a href="/history">History</a></nav>')`);await until(async()=>await text(cdp,'#gate-known')==='已识别操作');assert.equal(await cdp.evaluate('!!globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan',gate.executionContextId),true);assert.equal((await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.maintenanceState()',gate.executionContextId)).busy,false);await cdp.evaluate(`document.body.insertAdjacentHTML('beforeend','<textarea id=\"draft-guard\"></textarea>');document.querySelector('#draft-guard').value='Unsent draft'`);assert.equal((await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.maintenanceState()',gate.executionContextId)).busy,true);assert.equal(await cdp.evaluate(`document.querySelector('#draft-guard').value`),'Unsent draft');await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()',gate.executionContextId);assert.equal(await cdp.evaluate('!!globalThis.__GRAVITYBOX_ATTACH_DEEP_SCAN__',gate.executionContextId),false);
      await cdp.send('Page.navigate',{url:origin+'/login'});await until(async()=>await text(cdp,'button')==='Settings');const loginTree=await cdp.send('Page.getFrameTree'),login=await cdp.send('Page.createIsolatedWorld',{frameId:loginTree.frameTree.frame.id,worldName:'GRAVITYBOX-auth-guard-test'});
      await cdp.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({origin,path:'/login',dictionary:{schema:1,version:'guard',entries:{Settings:'设置'}}})};
${engine}`,login.executionContextId);assert.equal(await text(cdp,'button'),'Settings');assert.equal(await cdp.evaluate('!!globalThis.__GRAVITYBOX_ENGINE_V1__',login.executionContextId),false);

    }finally{cdp?.close();await browserCommand('Target.closeTarget',{targetId:target.targetId}).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; });}
  });
  await check('模型关闭使用受控事件序列，设置关闭只操作本轮容器',async()=>{
    const target=await browserCommand('Target.createTarget',{url:origin+'/customizations'});let isolated;
    try { const page=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.id===target.targetId));isolated=new CDP(page.webSocketDebuggerUrl);await isolated.connect();await documentReady(isolated);await isolated.evaluate("document.body.innerHTML=''");const tree=await isolated.send('Page.getFrameTree'),ctx=await isolated.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-close-guards-test'});
    const engine=await readFile(join(root,'dist/engine.js'),'utf8');
    await isolated.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({origin,path:'/customizations',dictionary:{schema:1,version:'close',entries:{}}})};
${engine}`,ctx.executionContextId);
    await isolated.evaluate(`(()=>{const host=document.createElement('section');host.id='close-guards';host.innerHTML='<nav aria-label="Sidebar"><button id="own-settings">Settings</button></nav><button data-testid="model-selector-trigger" id="own-model">Model</button>';document.body.prepend(host);const model=host.querySelector('#own-model');model.onclick=()=>{if(!host.querySelector('[data-testid="model-selector-panel"]')){const p=document.createElement('div');p.dataset.testid='model-selector-panel';p.textContent='Public quota';host.append(p)}};model.onpointerdown=()=>host.querySelector('[data-testid="model-selector-panel"]')?.remove();host.querySelector('#own-settings').onclick=()=>{const pane=document.createElement('section');pane.dataset.testid='settings-root';pane.innerHTML='<h1>Settings</h1><nav><button>General</button><button>Appearance</button></nav><button id="settings-done">Done</button>';host.append(pane);pane.querySelector('#settings-done').onclick=()=>pane.remove()}})()`);
    assert.equal((await isolated.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.begin([])',ctx.executionContextId)).ok,true);
    assert.equal((await isolated.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.step("model-open")',ctx.executionContextId)).ok,true);
    assert.equal((await isolated.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.step("model-close")',ctx.executionContextId)).ok,true);
    assert.equal(await isolated.evaluate('!!document.querySelector("[data-testid=model-selector-panel]")'),false);
    assert.equal((await isolated.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.step("settings-open")',ctx.executionContextId)).ok,true);
    assert.equal((await isolated.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.step("settings-close")',ctx.executionContextId)).ok,true);
    assert.equal((await isolated.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.finish()',ctx.executionContextId)).editorsMatch,true);
    await isolated.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()',ctx.executionContextId);await isolated.evaluate('document.querySelector("#close-guards").remove()');} finally { isolated?.close();await browserCommand('Target.closeTarget',{targetId:target.targetId}).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; });}
  });
  await check('插件说明多文本节点与场景译文粒度一致，普通段落仍受保护',async()=>{
    const target=await browserCommand('Target.createTarget',{url:origin+'/customizations'});let cdp;
    try{
      const page=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.id===target.targetId));cdp=new CDP(page.webSocketDebuggerUrl);await cdp.connect();await documentReady(cdp);
      await cdp.evaluate(`document.body.innerHTML='<div><a href="/customizations/plugins/chunks">Chunked Plugin</a><p id="block-one">Read public documents.</p><p id="block-two"><span>Draft public documents.</span> Review public documents.</p><button>Install</button></div><p id="not-card">Read public documents.</p>'`);
      const tree=await cdp.send('Page.getFrameTree'),ctx=await cdp.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-plugin-chunks'}),engine=await readFile(join(root,'dist/engine.js'),'utf8');
      const entries={'@ui:/customizations|description|Read public documents.':'阅读公共文档。','@ui:/customizations|description|Draft public documents.':'起草公共文档。','@ui:/customizations|description|Review public documents.':'审查公共文档。'};
      await cdp.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({origin,path:'/customizations',dictionary:{schema:1,version:'chunks',entries}})};
${engine}`,ctx.executionContextId);
      await until(async()=>await text(cdp,'#block-one')==='阅读公共文档。');assert.equal((await text(cdp,'#block-two')).replace(/\s/g,''),'起草公共文档。审查公共文档。');assert.equal(await text(cdp,'#not-card'),'Read public documents.');
      const catalogue=await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.pluginCatalog()',ctx.executionContextId);assert.deepEqual(catalogue.map(x=>x.description).sort(),['Read public documents.','Draft public documents.','Review public documents.'].sort());
      await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()',ctx.executionContextId);
    }finally{cdp?.close();await browserCommand('Target.closeTarget',{targetId:target.targetId}).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; });}
  });
  await check('独立设置壳可保守汉化提示与占位符，引导页仍拒绝注入',async()=>{
    const target=await browserCommand('Target.createTarget',{url:origin+'/settings-standalone'});let cdp;
    try{
      const page=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.id===target.targetId));cdp=new CDP(page.webSocketDebuggerUrl);await cdp.connect();await documentReady(cdp);const engine=await readFile(join(root,'dist/engine.js'),'utf8');
      await cdp.evaluate(`document.body.innerHTML='<section data-testid="settings-root"><nav role="tablist"><button>General</button></nav><input id="standalone-input" placeholder="Find settings" value="Private draft"><div role="tooltip" id="standalone-tooltip">Worked for 12s</div><div class="monaco-editor">Settings</div></section>'`);
      const tree=await cdp.send('Page.getFrameTree'),ctx=await cdp.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-standalone-test'});
      const boot={origin,path:'/settings-standalone',conservative:true,dictionary:{schema:1,version:'standalone',entries:{General:'通用','Find settings':'查找设置',Settings:'设置'}}};
      await cdp.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify(boot)};
${engine}`,ctx.executionContextId);
      await until(async()=>await cdp.evaluate('document.querySelector("#standalone-input").placeholder')==='查找设置');assert.equal(await cdp.evaluate('document.querySelector("#standalone-input").value'),'Private draft');assert.equal(await text(cdp,'.monaco-editor'),'Settings');assert.equal(await text(cdp,'#standalone-tooltip'),'已用时 12秒');await cdp.evaluate("history.pushState({},'', '/onboarding');document.querySelector('[data-testid=settings-root]').insertAdjacentHTML('beforeend','<button id=\"auth-sensitive\">Private onboarding heading</button>')");assert.equal((await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.collectUntranslated()',ctx.executionContextId)).length,0);await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()',ctx.executionContextId);
      await cdp.send('Page.navigate',{url:origin+'/onboarding'});await until(async()=>await text(cdp,'button')==='Settings');
      const authTree=await cdp.send('Page.getFrameTree'),auth=await cdp.send('Page.createIsolatedWorld',{frameId:authTree.frameTree.frame.id,worldName:'GRAVITYBOX-onboarding-test'});
      await cdp.evaluate(`document.body.innerHTML='<nav aria-label="Sidebar"><a href="/history">History</a></nav><button>Settings</button>'`);await cdp.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({...boot,path:'/onboarding'})};
${engine}`,auth.executionContextId);assert.equal(await cdp.evaluate('!!globalThis.__GRAVITYBOX_ENGINE_V1__',auth.executionContextId),false);assert.equal(await text(cdp,'button'),'Settings');
    }finally{cdp?.close();await browserCommand('Target.closeTarget',{targetId:target.targetId}).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; });}
  });
  await check('class 抖动不触发全量 reconcile/重建，保护状态变化仍能纠正', async () => {
    const tree = await main.send('Page.getFrameTree');const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await main.evaluate(`(()=>{const host=document.createElement('div');host.id='jitter-probe';let rows='';for(let i=0;i<120;i++)rows+='<button class="row" id="jrow'+i+'">Settings</button>';host.innerHTML=rows+'<div id="jitter-host"></div>';document.body.append(host);const jitter=document.querySelector('#jitter-host');for(let i=0;i<120;i++){const d=document.createElement('div');d.className='jitter';jitter.append(d)}})()`);
    await until(async () => await text(main, '#jrow119') === '设置');
    await new Promise(resolve => setTimeout(resolve, 300));
    const before = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state()', context.executionContextId);
    await main.evaluate(`(()=>{const rows=[...document.querySelectorAll('#jitter-host .jitter')];for(let round=0;round<4;round++)for(const row of rows)row.className='jitter round'+round})()`);
    await new Promise(resolve => setTimeout(resolve, 250));
    const after = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state()', context.executionContextId);
    assert.equal(after.reconcileChecks, before.reconcileChecks, 'class 抖动不应触发 reconcile');
    assert.ok(after.scanCount <= before.scanCount + 1, 'class 抖动不应重建整页');
    assert.ok(after.maxSliceMs <= 80, 'maxSliceMs=' + after.maxSliceMs);
    /* 保护状态真的变化时仍然纠正：已翻译节点被标记为 markdown 后恢复英文，移除后重新汉化 */
    await main.evaluate('document.querySelector("#jrow0").classList.add("markdown")');
    await until(async () => await text(main, '#jrow0') === 'Settings');
    await main.evaluate('document.querySelector("#jrow0").classList.remove("markdown")');
    await until(async () => await text(main, '#jrow0') === '设置');
    await main.evaluate('document.querySelector("#jitter-probe").remove()');
  });
  await check('词典同步提示只在版本改变后出现，重复应用及英文对照保持安静',async()=>{
    try { await main.send('Page.bringToFront'); } catch {
      main.close();const same=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.id===page.id));main=new CDP(same.webSocketDebuggerUrl);await main.connect();await main.send('Page.enable');await main.send('Page.bringToFront');
    }
    await new Promise(r=>setTimeout(r,3000));
    try { await main.send('Page.enable'); } catch {
      main.close();const same=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.id===page.id));main=new CDP(same.webSocketDebuggerUrl);await main.connect();await main.send('Page.enable');
    }
    const tree=await main.send('Page.getFrameTree'),ctx=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    await main.evaluate(`globalThis.__GB_TOAST_TEST__={...globalThis.__GRAVITYBOX_BOOT__.dictionary,version:'toast-test-'+Date.now()};globalThis.__GRAVITYBOX_ENGINE_V1__.update(globalThis.__GB_TOAST_TEST__)`,ctx.executionContextId);
    await until(async()=>await text(main,'#__gravitybox_toast__')==='GravityBox · 词典已同步更新');await until(async()=>await text(main,'#__gravitybox_toast__')===undefined,3000);
    await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.update(globalThis.__GB_TOAST_TEST__)',ctx.executionContextId);await new Promise(r=>setTimeout(r,200));assert.equal(await text(main,'#__gravitybox_toast__'),undefined);
    await main.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage('en')`,ctx.executionContextId);await main.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__.update({...globalThis.__GB_TOAST_TEST__,version:'toast-english'})`,ctx.executionContextId);await new Promise(r=>setTimeout(r,200));assert.equal(await text(main,'#__gravitybox_toast__'),undefined);await command('pause');await command('resume');await until(async()=>(await status()).mode==='connected');
  });
  await check('页面重载与暂停交错后不遗留引擎，连续恢复仍能正常退出',async()=>{
    for(let n=0;n<3;n++){
      await Promise.all([main.send('Page.reload'),command('pause')]);
      // Chrome may replace the renderer's inspection transport during reload. Rebind the test reader
      // to the same target; the backend and all restoration assertions remain unchanged.
      main.close();const same=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.id===page.id));main=new CDP(same.webSocketDebuggerUrl);await main.connect();await main.send('Page.enable');
      await until(async()=>await text(main,'#settings')==='Settings');await new Promise(r=>setTimeout(r,180));assert.equal(await text(main,'#settings'),'Settings');
      await command('resume');await until(async()=>await text(main,'#settings')==='设置');
    }
  });
  await check('真实设置结构：兼容模式翻译普通标签和说明、保留代码/链接/项目名，并可在设置已打开时启动',async()=>{
    const target=await browserCommand('Target.createTarget',{url:origin+'/?settingsOpen=true&settingsScreen=General'});let cdp;
    try {
      const page=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.id===target.targetId));cdp=new CDP(page.webSocketDebuggerUrl);await cdp.connect();await documentReady(cdp);
      const html='<div role="dialog" aria-label="Settings"><button aria-label="Close">Close</button><aside><h1>Settings</h1><button>General</button><button>App Settings</button><button>Appearance</button><h2>Project list</h2><button id="settings-project">Queued Messages</button><button id="settings-expand" class="text-xs mx-4 hover:underline">Show All</button><button id="settings-expand-sm" class="text-sm mx-4 hover:underline">Show All</button><button id="settings-expand-less" class="text-sm mx-4 hover:underline">Show Less</button><h2>Not in a project</h2><button>Chats</button></aside><main><h2>General</h2><div id="settings-description">Configure agent execution, queued message delivery, and permissions.</div><div><span id="settings-queued">Queued Messages</span><div>Configure when follow-up messages are sent.</div><span id="settings-policy">Permission Preset</span><p id="settings-inline">Type <code>/</code> and select <code>plan</code> to have the agent generate a plan.</p><div class="font-mono" style="white-space: pre"><div><span id="settings-code-name">Name</span></div></div><div data-gravitybox-user-content id="settings-private">Permission Preset</div><input value="Queued Messages"></div></main></div><div id="settings-outside">Permission Preset</div>';
      await cdp.evaluate('document.body.innerHTML='+JSON.stringify(html));
      const entries={Name:'名称','Show All':'显示全部','Show less':'收起',Settings:'设置',General:'通用','App Settings':'应用设置',Appearance:'外观','Queued Messages':'排队消息','Permission Preset':'权限预设','Configure when follow-up messages are sent.':'配置何时发送后续追问消息。','Configure agent execution, queued message delivery, and permissions.':'配置智能体执行、排队消息发送及权限。','Type {0} and select {1} to have the agent generate a plan.':'输入 {0} 并选择 {1}，让智能体生成规划。'};
      const engine=await readFile(join(root,'dist/engine.js'),'utf8');await cdp.evaluate('globalThis.__GRAVITYBOX_BOOT__='+JSON.stringify({origin,path:'/',dictionary:{schema:1,version:'real-settings-regression',entries},conservative:true})+';'+engine);
      await until(async()=>await text(cdp,'#settings-queued')==='排队消息');assert.equal(await text(cdp,'#settings-policy'),'权限预设');assert.equal(await text(cdp,'#settings-description'),'配置智能体执行、排队消息发送及权限。');
      assert.equal(await text(cdp,'#settings-inline'),'输入 / 并选择 plan，让智能体生成规划。');assert.equal(await cdp.evaluate('document.querySelector("input").value'),'Queued Messages');assert.equal(await text(cdp,'#settings-project'),'Queued Messages');assert.equal(await text(cdp,'#settings-expand'),'显示全部');assert.equal(await text(cdp,'#settings-expand-sm'),'显示全部');assert.equal(await text(cdp,'#settings-expand-less'),'收起');assert.equal(await text(cdp,'#settings-code-name'),'Name');assert.equal(await text(cdp,'#settings-private'),'Permission Preset');assert.equal(await text(cdp,'#settings-outside'),'Permission Preset');assert.equal(await text(cdp,'code'),' /'.trim());
      await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()');assert.equal(await text(cdp,'#settings-queued'),'Queued Messages');assert.equal(await text(cdp,'#settings-inline'),'Type / and select plan to have the agent generate a plan.');
    }finally{cdp?.close();await browserCommand('Target.closeTarget',{targetId:target.targetId}).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; });}
  });
  await check('2.31-2.32 适配：新交互卡片选择性保护、新版实体路由、长文案采集与新动态模板', async () => {
    const target=await browserCommand('Target.createTarget',{url:origin+'/'});let cdp;
    try {
      const page=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.id===target.targetId));cdp=new CDP(page.webSocketDebuggerUrl);await cdp.connect();await documentReady(cdp);
      const longCopy='Run a swarm: several agents working in parallel on one task, each in its own conversation, collaborating through a shared message board. Use when work splits cleanly.';
      const html=`<main><div data-testid="coordinator-worker-card" role="button"><span id="v232-worker-name" class="text-sm truncate">Settings</span><div id="v232-worker-latest" data-testid="coordinator-card-latest-line">Settings</div><button id="v232-worker-stop" title="Stop Subagent">Stop Subagent</button></div><button id="v232-side-popout" data-testid="side-question-popout" aria-label="Open in full conversation"></button><div id="v232-side-user" data-testid="side-question-followup-user">Settings</div><div id="v232-side-thinking" data-testid="side-question-followup-thinking">Thinking...</div><div id="v232-voice-summary" data-testid="voice-transcript-summary">Settings</div><nav aria-label="Sidebar"><a id="v232-link-skill" href="/customizations/marketplaces/official/skills/my-skill">Settings</a><a id="v232-link-bundle" href="/customizations/marketplaces/official/bundles/my-bundle">Settings</a><a id="v232-link-sidecar" href="/customizations/sidecars/my-sidecar">Settings</a><a id="v232-link-trigger" href="/sidecars/triggers/my-trigger">Settings</a><a id="v232-link-nav" href="/customizations">Customizations</a></nav><div role="menu"><div data-testid="model-selector-panel"><span id="v232-model-weekly">Gemini Flash Next Weekly Limit</span><span id="v232-model-daily">Gemini Flash Next Daily Limit</span></div></div><div role="tooltip" id="v232-cancel-q">Cancel Questionnaire and Stop the Agent (Esc)</div><button id="v232-long-btn">${longCopy}</button></main>`;
      await cdp.evaluate('document.body.innerHTML='+JSON.stringify(html));
      const entries={Settings:'设置','Stop Subagent':'停止子智能体','Open in full conversation':'在完整对话中打开','Thinking...':'思考中...',Customizations:'自定义项'};
      const engine=await readFile(join(root,'dist/engine.js'),'utf8');
      await cdp.evaluate('globalThis.__GRAVITYBOX_BOOT__='+JSON.stringify({origin,path:'/',dictionary:{schema:1,version:'v232-regression',entries}})+';'+engine);
      await until(async()=>await text(cdp,'#v232-worker-stop')==='停止子智能体');
      assert.equal(await cdp.evaluate('document.querySelector("#v232-worker-stop").getAttribute("title")'),'停止子智能体');
      assert.equal(await text(cdp,'#v232-worker-name'),'Settings');
      assert.equal(await text(cdp,'#v232-worker-latest'),'Settings');
      assert.equal(await cdp.evaluate('document.querySelector("#v232-side-popout").getAttribute("aria-label")'),'在完整对话中打开');
      assert.equal(await text(cdp,'#v232-side-user'),'Settings');
      assert.equal(await text(cdp,'#v232-side-thinking'),'思考中...');
      assert.equal(await text(cdp,'#v232-voice-summary'),'Settings');
      for(const id of ['#v232-link-skill','#v232-link-bundle','#v232-link-sidecar','#v232-link-trigger'])assert.equal(await text(cdp,id),'Settings');
      assert.equal(await text(cdp,'#v232-link-nav'),'自定义项');
      assert.equal(await text(cdp,'#v232-model-weekly'),'Gemini Flash Next 每周限额');
      assert.equal(await text(cdp,'#v232-model-daily'),'Gemini Flash Next 每日限额');
      assert.equal(await text(cdp,'#v232-cancel-q'),'取消问卷并停止智能体 (Esc)');
      const collected=await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.collectUntranslated()');
      assert.equal(collected.some(item=>item.key===longCopy),true,'超过 120 字符的安全界面文案应被 collectUntranslated 采集');
      await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()');
    }finally{cdp?.close();await browserCommand('Target.closeTarget',{targetId:target.targetId}).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; });}
  });
  await check('设置首帧、同词典刷新、热更新和退出动画保持译文，不跨帧回写英文', async () => {
    const target=await browserCommand('Target.createTarget',{url:origin+'/'});let cdp;
    try {
      const page=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.id===target.targetId));
      cdp=new CDP(page.webSocketDebuggerUrl);await cdp.connect();await cdp.send('Page.bringToFront');await documentReady(cdp);
      const rows=Array.from({length:320},(_,i)=>`<div data-testid="conversation-row-sidebar"><span class="truncate">Private conversation ${i}</span><span>1d</span></div>`).join('');
      const html='<div role="dialog" aria-label="Settings" id="flash-root"><button aria-label="Close">Close</button><aside><h1 id="flash-heading">Settings</h1><button id="flash-general">General</button><button id="flash-app">Application</button><button>Appearance</button><h2>Project list</h2><button id="flash-project">Application</button>'+rows+'</aside><main><h2>General</h2><span id="flash-label">Permission Preset</span><div id="flash-description">Configure agent execution, queued message delivery, and permissions.</div><p id="flash-inline">Type <code>/</code> and select <code>plan</code> to have the agent generate a plan.</p><input id="flash-input" value="Permission Preset"><div data-gravitybox-user-content id="flash-private">Permission Preset</div></main></div>';
      const entries={Settings:'设置',Close:'关闭',General:'通用',Application:'应用设置','App Settings':'应用设置',Appearance:'外观','Permission Preset':'权限预设','Configure agent execution, queued message delivery, and permissions.':'配置智能体执行、排队消息发送及权限。','Type {0} and select {1} to have the agent generate a plan.':'输入 {0} 并选择 {1}，让智能体生成规划。'};
      await cdp.evaluate(`document.body.innerHTML='<nav aria-label="Sidebar"><a href="/history">History</a></nav><div id="flash-mount"></div>';globalThis.__FLASH_HTML__=${JSON.stringify(html)};globalThis.__FLASH_DICT__=${JSON.stringify({schema:1,version:'settings-frames-1',entries})}`);
      const engine=await readFile(join(root,'dist/engine.js'),'utf8');
      await cdp.evaluate(`globalThis.__GRAVITYBOX_BOOT__={origin:${JSON.stringify(origin)},path:'/',dictionary:globalThis.__FLASH_DICT__,conservative:true};\n${engine}`);
      await cdp.evaluate(`globalThis.__flashFrames=async(count=6)=>{const frames=[];for(let i=0;i<count;i++){await new Promise(requestAnimationFrame);frames.push(document.querySelector('#flash-heading')?.textContent==='设置'&&document.querySelector('#flash-general')?.textContent==='通用'&&document.querySelector('#flash-app')?.textContent==='应用设置'&&document.querySelector('#flash-label')?.textContent==='权限预设'&&/^(输入|通过)/.test(document.querySelector('#flash-inline')?.textContent??''));}return frames;}`);
      const first=await cdp.evaluate(`(async()=>{document.querySelector('#flash-mount').innerHTML=globalThis.__FLASH_HTML__;setTimeout(()=>history.pushState({},'','/?settingsOpen=true&settingsScreen=General'),35);return await globalThis.__flashFrames();})()`);
      assert.ok(first.every(Boolean),'DOM-first settings mount exposed English at a paint: '+JSON.stringify(first));
      await until(async()=>await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().pending')===0);
      await cdp.evaluate(`globalThis.__flashEnglishWrites=[];globalThis.__flashObserver=new MutationObserver(records=>{for(const r of records)if(r.target.parentElement?.closest('#flash-inline'))for(const value of [r.oldValue,r.target.nodeValue])if(/Type |and select|to have the agent/.test(value??''))globalThis.__flashEnglishWrites.push(value);});globalThis.__flashObserver.observe(document.querySelector('#flash-inline'),{subtree:true,characterData:true,characterDataOldValue:true});`);
      const repeated=await cdp.evaluate(`(async()=>{for(let i=0;i<3;i++)globalThis.__GRAVITYBOX_ENGINE_V1__.update(globalThis.__FLASH_DICT__);return await globalThis.__flashFrames();})()`);
      assert.ok(repeated.every(Boolean),'Same dictionary refresh exposed English');
      assert.deepEqual(await cdp.evaluate('globalThis.__flashEnglishWrites'),[],'Same dictionary must not restore English text slots');
      const updated=await cdp.evaluate(`(async()=>{globalThis.__FLASH_DICT__={...globalThis.__FLASH_DICT__,version:'settings-frames-2',entries:{...globalThis.__FLASH_DICT__.entries,'Type {0} and select {1} to have the agent generate a plan.':'通过 {0} 与 {1} 生成规划。'}};globalThis.__GRAVITYBOX_ENGINE_V1__.update(globalThis.__FLASH_DICT__);return await globalThis.__flashFrames();})()`);
      assert.ok(updated.every(Boolean),'Dictionary hot reload exposed English');
      assert.deepEqual(await cdp.evaluate('globalThis.__flashEnglishWrites'),[],'Hot reload must commit new inline runs directly');
      assert.equal(await text(cdp,'#flash-inline'),'通过 / 与 plan 生成规划。');
      const closing=await cdp.evaluate(`(async()=>{history.pushState({},'','/');globalThis.__GRAVITYBOX_ENGINE_V1__.refresh();return await globalThis.__flashFrames();})()`);
      assert.ok(closing.every(Boolean),'URL-first exit animation restored English before dialog removal');
      assert.equal(await cdp.evaluate('document.querySelector("#flash-input").value'),'Permission Preset');
      assert.equal(await text(cdp,'#flash-private'),'Permission Preset');
      assert.equal(await text(cdp,'.truncate'),'Private conversation 0');
      assert.equal(await text(cdp,'#flash-project'),'Application','A project name matching the new navigation alias remains protected');
      assert.equal(await text(cdp,'code'),'/');
      await cdp.evaluate('globalThis.__flashObserver.disconnect();document.querySelector("#flash-mount").replaceChildren();globalThis.__GRAVITYBOX_ENGINE_V1__.refresh()');
      const reopened=await cdp.evaluate(`(async()=>{history.pushState({},'','/?settingsOpen=true&settingsScreen=General');document.querySelector('#flash-mount').innerHTML=globalThis.__FLASH_HTML__;return await globalThis.__flashFrames();})()`);
      assert.ok(reopened.every(Boolean),'Reopened settings reused a detached scope or exposed English');
      await cdp.evaluate("history.pushState({},'', '/?settingsOpen=true&settingsScreen=Unknown');globalThis.__GRAVITYBOX_ENGINE_V1__.refresh()");
      await until(async()=>await text(cdp,'#flash-label')==='Permission Preset');
      const returned=await cdp.evaluate(`(async()=>{history.pushState({},'','/?settingsOpen=true&settingsScreen=General');globalThis.__GRAVITYBOX_ENGINE_V1__.refresh();return await globalThis.__flashFrames();})()`);
      assert.ok(returned.every(Boolean),'Unsupported screen must invalidate the scope and revalidate on return');
      await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()');
      assert.equal(await text(cdp,'#flash-inline'),'Type / and select plan to have the agent generate a plan.');
    } finally { cdp?.close();await browserCommand('Target.closeTarget',{targetId:target.targetId}).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; }); }
  });
  await check('HUD 独立挂载不覆盖输入区、窄屏单行、向上弹出及输入框零焦点争夺', async () => {
    const tree = await main.send('Page.getFrameTree');
    const ctx = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await main.evaluate(`(() => {
      const convView = document.createElement('div');
      convView.id = 'hud-e2e-fixture';
      convView.setAttribute('data-testid', 'conversation-view');
      convView.setAttribute('data-cascade-id', 'cascade-e2e');
      convView.setAttribute('data-conversation-id', '4ec6348d-0f58-49db-8aed-6f67dbb78f5d');
      convView.style.cssText = 'position:relative;display:flex;flex-direction:column;width:640px;margin:20px auto;';
      convView.innerHTML = '<div id="hud-e2e-msg-wrap" style="position:relative;height:180px;"><button id="hud-e2e-scroll-btn" type="button" aria-label="滚动到底部" style="position:absolute;left:180px;bottom:24px;width:40px;height:40px;z-index:20;border-radius:20px;">↓</button><button id="hud-e2e-stop-prop-btn" type="button" style="position:absolute;right:10px;top:10px;">Outside</button></div><div style="position:relative;z-index:10;display:flex;flex-direction:column;width:100%;"><div data-testid="agent-input-box" id="hud-e2e-box" style="display:flex;flex-direction:column;width:100%;"><div class="surface-composer" id="hud-e2e-composer" style="height:82px;border-radius:21px;"><div id="hud-e2e-editor" contenteditable="true" aria-label="Message input">Draft text</div><button data-testid="model-selector-trigger" data-model-id="gemini-4-argon">Gemini 4 Argon</button></div></div></div>';
      document.body.appendChild(convView);
      document.querySelector('#hud-e2e-stop-prop-btn').addEventListener('pointerdown', (e) => e.stopPropagation());
    })()`);
    await main.evaluate('globalThis.__GRAVITYBOX_HUD_V1__?.reconcileMounts()', ctx.executionContextId);
    await until(async () => await main.evaluate('!!document.querySelector("#__gravitybox_hud_host__")'));

    // 1. 验证 HUD 紧随输入框并占据独立空间，避免覆盖输入区域。
    const layoutInfo = await main.evaluate(`(() => {
      const composer = document.querySelector('#hud-e2e-composer');
      const host = document.querySelector('#__gravitybox_hud_host__');
      const cRect = composer.getBoundingClientRect();
      const hRect = host.getBoundingClientRect();
      return {
        isSiblingAfter: composer.nextElementSibling === host,
        gapTop: Math.round(hRect.top - cRect.bottom),
        hostHeight: Math.round(hRect.height),
        elevation: Math.round(hRect.bottom - cRect.bottom),
        protectedAttr: host.getAttribute('data-gravitybox-protect')
      };
    })()`);
    assert.equal(layoutInfo.isSiblingAfter, true);
    assert.ok(layoutInfo.gapTop >= 0);
    assert.ok(layoutInfo.hostHeight > 0);
    assert.ok(layoutInfo.elevation >= layoutInfo.hostHeight);
    assert.equal(layoutInfo.protectedAttr, 'true');

    // 2. 注入实测基准指标并验证 3 胶囊与向上展开 Popover
    await until(async () => {
      await main.evaluate(`globalThis.__gravityboxUpdateHudMetrics({
        conversationId: '4ec6348d-0f58-49db-8aed-6f67dbb78f5d',
        sessionRevision: [...globalThis.__GRAVITYBOX_HUD_V1__.manager.instances.values()][0].getSessionRevision(),
        updatedAt: Date.now(),
        isStreaming: false,
        session: {
          turns: 1,
          steps: 142,
          modelDurationSeconds: 3959.126,
          modelDurationFormatted: '1小时5分59秒',
          modelDurationFormattedEn: '1h5m59s',
          toolDurationSeconds: 751,
          toolDurationFormatted: '12分31秒',
          toolDurationFormattedEn: '12m31s',
          averageTtftSeconds: 19.7,
          averageTtftFormatted: '19.7 秒',
          averageTtftFormattedEn: '19.7s',
          outputTps: 90.126,
          outputTpsFormatted: '90.13 tok/s',
          currentTurnDurationSeconds: 18.4,
          currentTurnDurationFormatted: '18秒',
          currentTurnDurationFormattedEn: '18s',
          currentTurnDurationCompactZh: '本轮 18s',
          currentTurnDurationCompactEn: 'Turn 18s',
          currentTurnModelDurationSeconds: 14.2,
          currentTurnToolDurationSeconds: 4.2
        },
        tokens: {
          totalTokens: 58593793,
          totalTokensCompact: '58.6M tok',
          totalTokensFormatted: '58,593,793 tok',
          cacheHitRate: 0.9665,
          cacheHitRateFormatted: '97%',
          uncachedInputTokens: 1961501,
          uncachedInputFormatted: '1,961,501 tok',
          cachedReadTokens: 56526799,
          cachedReadFormatted: '56,526,799 tok',
          outputTokens: 105493,
          outputFormatted: '105,493 tok'
        },
        context: {
          modelId: 'gemini-4-argon',
          modelDisplayName: 'Gemini 4 Argon',
          usedTokens: 672000,
          usedTokensCompact: '~672K',
          capacityTokens: 1048576,
          capacityTokensCompact: '1M',
          usedRatio: 0.6408,
          usedRatioFormatted: '64%',
          breakdown: {
            systemTokens: 1900,
            systemTokensCompact: '~1.9K',
            systemRatio: 0.181,
            toolTokens: 7600,
            toolTokensCompact: '~7.6K',
            toolRatio: 0.725,
            messageTokens: 662500,
            messageTokensCompact: '~662K',
            messageRatio: 63.181
          }
        }
      })`, ctx.executionContextId);
      const txt = await main.evaluate(`document.querySelector('#__gravitybox_hud_host__')?.shadowRoot?.querySelector('#hud-txt-session')?.textContent.replace(/\\s+/g, ' ').trim()`);
      return txt === '1 轮 · 本轮 18s · 90 tok/s';
    });

    const rendered = await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      const caps = [...sr.querySelectorAll('.capsule')];
      return {
        c1: sr.querySelector('#hud-txt-session').textContent.replace(/\\s+/g, ' ').trim(),
        c2: sr.querySelector('#hud-txt-tokens').textContent.replace(/\\s+/g, ' ').trim(),
        c3: sr.querySelector('#hud-txt-context').textContent.trim(),
        sameRow: caps.every(c => c.offsetTop === caps[0].offsetTop),
      };
    })()`);
    assert.equal(rendered.c1, '1 轮 · 本轮 18s · 90 tok/s');
    assert.equal(rendered.c2, '59M tok · 缓存命中 97%');
    assert.equal(rendered.c3, '64%');
    assert.equal(rendered.sameRow, true);
    const precision = await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      return {
        speed: sr.querySelector('#val-tps').textContent,
        turnDuration: sr.querySelector('#val-turn-dur').textContent,
        duration: sr.querySelector('#val-model-dur').textContent,
        toolDuration: sr.querySelector('#val-tool-dur').textContent,
        ttft: sr.querySelector('#val-ttft').textContent,
        cache: sr.querySelector('#val-cache-hit').textContent,
        tokensBadge: sr.querySelector('#pop-tokens-badge').textContent,
        cachedRead: sr.querySelector('#val-cached-read').textContent,
        outputTok: sr.querySelector('#val-output-tok').textContent,
        context: sr.querySelector('#pop-ctx-pct').textContent,
        ctxCapacity: sr.querySelector('#pop-ctx-capacity').textContent,
      };
    })()`);
    assert.equal(precision.speed, '90.13 tok/s');
    assert.equal(precision.turnDuration, '18秒');
    assert.equal(precision.duration, '1小时5分59秒');
    assert.equal(precision.toolDuration, '12分31秒');
    assert.equal(precision.ttft, '19.70 秒');
    assert.equal(precision.cache, '96.7%');
    assert.equal(precision.tokensBadge, '58.6M tok');
    assert.equal(precision.cachedRead, '56.5M tok');
    assert.equal(precision.outputTok, '105K tok');
    assert.equal(precision.context, '64.1%');
    assert.equal(precision.ctxCapacity, '672K / 1.05M');

    // 3. 验证输入框焦点零争夺与向上展开 Popover
    const focusAndPopover = await main.evaluate(`(() => {
      const editor = document.querySelector('#hud-e2e-editor');
      editor.focus();
      const host = document.querySelector('#__gravitybox_hud_host__');
      const sr = host.shadowRoot;
      const cap1 = sr.querySelector('.capsule-session');
      const capDot = cap1.querySelector('.hud-status-dot');
      const idleCollapsedDotColor = getComputedStyle(capDot).backgroundColor;
      const mdEvt = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      cap1.dispatchEvent(mdEvt);
      cap1.click();
      const pop1 = sr.querySelector('#hud-popover-session');
      const popDot = pop1.querySelector('.hud-status-dot');
      const idleActiveDotColor = getComputedStyle(capDot).backgroundColor;
      const idlePopoverDotColor = getComputedStyle(popDot).backgroundColor;
      const popRect = pop1.getBoundingClientRect();
      const capRect = cap1.getBoundingClientRect();
      const scrollBtn = document.querySelector('#hud-e2e-scroll-btn');
      const btnRect = scrollBtn.getBoundingClientRect();
      const overlapX = Math.max(popRect.left + 4, Math.min(popRect.right - 4, btnRect.left + btnRect.width / 2));
      const overlapY = Math.max(popRect.top + 4, Math.min(popRect.bottom - 4, btnRect.top + btnRect.height / 2));
      const topHit = document.elementFromPoint(overlapX, overlapY);
      return {
        defaultPrevented: mdEvt.defaultPrevented,
        editorStillFocused: document.activeElement === editor,
        popoverVisible: !pop1.hasAttribute('hidden'),
        isUpward: popRect.bottom <= capRect.top,
        outerOverflow: getComputedStyle(pop1).overflow,
        topLayerAboveZ20Button: topHit === host,
        idleCollapsedDotColor,
        idleActiveDotColor,
        idlePopoverDotColor
      };
    })()`);
    assert.equal(focusAndPopover.defaultPrevented, true, 'mousedown 必须阻止默认行为以防输入框失焦');
    assert.equal(focusAndPopover.editorStillFocused, true, '点击胶囊后输入框必须保持焦点');
    assert.equal(focusAndPopover.popoverVisible, true);
    assert.equal(focusAndPopover.isUpward, true, 'Popover 必须向上展开');
    assert.equal(focusAndPopover.outerOverflow, 'visible', 'Popover 外层必须为 overflow:visible 防止裁切底部小三角');
    assert.equal(focusAndPopover.topLayerAboveZ20Button, true, 'Popover 必须通过 Top Layer 位于 z-index:20 回到底部悬浮按钮之上，绝不被遮挡');
    assert.equal(focusAndPopover.idleActiveDotColor, focusAndPopover.idleCollapsedDotColor, '空闲时点击展开卡片小圆点必须保持灰色不变蓝');
    assert.equal(focusAndPopover.idlePopoverDotColor, focusAndPopover.idleCollapsedDotColor, '空闲时展开卡片内标题圆点也必须保持灰色');

    // 3a. 验证三态圆点：模型思考/输出常亮蓝色 -> 脚本执行蓝色呼吸 -> 两者停止灰色
    await main.evaluate(`(() => {
      const box = document.querySelector('#hud-e2e-composer');
      const cancelBtn = document.createElement('button');
      cancelBtn.id = 'hud-e2e-cancel-btn';
      cancelBtn.setAttribute('data-testid', 'input-cancel-button');
      cancelBtn.setAttribute('aria-label', 'Cancel (⌃C)');
      box.appendChild(cancelBtn);
    })()`);
    await until(async () => await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      return sr.querySelector('.capsule-session').classList.contains('is-generating') &&
        getComputedStyle(sr.querySelector('.capsule-session .hud-status-dot')).backgroundColor === 'rgb(49, 134, 255)';
    })()`));
    const generatingDotState = await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      const capStyle = getComputedStyle(sr.querySelector('.capsule-session .hud-status-dot'));
      const popStyle = getComputedStyle(sr.querySelector('#hud-popover-session .hud-status-dot'));
      return {
        capDot: capStyle.backgroundColor,
        popDot: popStyle.backgroundColor,
        capAnim: capStyle.animationName,
        popAnim: popStyle.animationName,
      };
    })()`);
    assert.equal(generatingDotState.capDot, 'rgb(49, 134, 255)', '模型思考/输出时胶囊圆点必须显示常亮蓝色');
    assert.equal(generatingDotState.popDot, 'rgb(49, 134, 255)', '模型思考/输出时展开卡片圆点同步为常亮蓝色');
    assert.equal(generatingDotState.capAnim, 'none', '模型本身思考/输出时圆点保持常亮不呼吸');
    assert.equal(generatingDotState.popAnim, 'none', '展开卡片圆点在模型思考/输出时保持常亮不呼吸');

    await main.evaluate(`(() => {
      const wrap = document.querySelector('#hud-e2e-msg-wrap');
      const scriptIndicator = document.createElement('span');
      scriptIndicator.id = 'hud-e2e-script-running';
      scriptIndicator.className = 'animate-shimmer-text';
      scriptIndicator.textContent = 'Running npm test';
      wrap.appendChild(scriptIndicator);
    })()`);
    await until(async () => await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      return sr.querySelector('.capsule-session').classList.contains('is-executing') &&
        getComputedStyle(sr.querySelector('.capsule-session .hud-status-dot')).animationName === 'hud-breathe-dot';
    })()`));
    const executingDotState = await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      const capStyle = getComputedStyle(sr.querySelector('.capsule-session .hud-status-dot'));
      const popStyle = getComputedStyle(sr.querySelector('#hud-popover-session .hud-status-dot'));
      return {
        capAnim: capStyle.animationName,
        popAnim: popStyle.animationName,
      };
    })()`);
    assert.equal(executingDotState.capAnim, 'hud-breathe-dot', '模型暂停且脚本执行时胶囊圆点必须呈蓝色呼吸');
    assert.equal(executingDotState.popAnim, 'hud-breathe-dot', '模型暂停且脚本执行时展开卡片圆点同步呈蓝色呼吸');

    // 移除 Cancel 按钮后即使工具 shimmer 与 .codicon-loading 仍存在，小圆点也必须立即回到灰色静止
    await main.evaluate(`(() => {
      document.querySelector('#hud-e2e-cancel-btn').remove();
      const wrap = document.querySelector('#hud-e2e-msg-wrap');
      const codicon = document.createElement('span');
      codicon.id = 'hud-e2e-stale-codicon';
      codicon.className = 'codicon-loading';
      wrap.appendChild(codicon);
    })()`);
    await until(async () => await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      return !sr.querySelector('.capsule-session').classList.contains('is-streaming') &&
        getComputedStyle(sr.querySelector('.capsule-session .hud-status-dot')).animationName === 'none' &&
        getComputedStyle(sr.querySelector('.capsule-session .hud-status-dot')).backgroundColor === 'rgb(113, 113, 122)';
    })()`));
    await main.evaluate(`(() => {
      document.querySelector('#hud-e2e-script-running')?.remove();
      document.querySelector('#hud-e2e-stale-codicon')?.remove();
    })()`);

    // 3b. 验证外部控件 stopPropagation() 的 pointerdown 仍能经捕获阶段自动关闭已固定 Popover
    const dismissedByStopPropOutside = await main.evaluate(`(() => {
      const outsideBtn = document.querySelector('#hud-e2e-stop-prop-btn');
      outsideBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
      const pop1 = document.querySelector('#__gravitybox_hud_host__').shadowRoot.querySelector('#hud-popover-session');
      return pop1.hasAttribute('hidden');
    })()`);
    assert.equal(dismissedByStopPropOutside, true, '外部调用 stopPropagation 的 pointerdown 仍须在捕获阶段关闭 Popover');

    // 4. 验证 < 360px 窄屏分栏自动切换 .is-ultra-compact 且保持单行
    await main.evaluate(`document.querySelector('#hud-e2e-fixture').style.width = '340px'`);
    await until(async () => await main.evaluate(`document.querySelector('#__gravitybox_hud_host__').shadowRoot.querySelector('.hud-container').classList.contains('is-ultra-compact')`));
    const ultraCompactInfo = await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      const caps = [...sr.querySelectorAll('.capsule')];
      return {
        turnsDisplay: getComputedStyle(sr.querySelector('.hud-turns')).display,
        turnDotDisplay: getComputedStyle(sr.querySelector('.hud-turn-dot')).display,
        speedDisplay: getComputedStyle(sr.querySelector('.hud-speed')).display,
        cacheDisplay: getComputedStyle(sr.querySelector('.hud-tok-cache')).display,
        sameRow: caps.every(c => c.offsetTop === caps[0].offsetTop)
      };
    })()`);
    assert.equal(ultraCompactInfo.turnsDisplay, 'none');
    assert.equal(ultraCompactInfo.turnDotDisplay, 'none');
    assert.equal(ultraCompactInfo.speedDisplay, 'none');
    assert.equal(ultraCompactInfo.cacheDisplay, 'none');
    assert.equal(ultraCompactInfo.sameRow, true);

    // 5. 验证单色渐深蓝进度条与 1 轻蓝 / 2 实心琥珀 / 3+ 实心正红压缩徽章渲染
    const pushTier = async (compactionCount, usedRatio) => {
      await main.evaluate(`(() => {
        const mgr = globalThis.__GRAVITYBOX_HUD_V1__?.manager;
        const inst = mgr ? [...mgr.instances.values()][0] : null;
        if (!inst || !inst.lastMetrics) return;
        mgr.dispatchMetrics({
          ...inst.lastMetrics,
          conversationId: inst.getCurrentConvId(),
          sessionRevision: inst.getSessionRevision(),
          metricsSequence: (inst.lastMetricsSequence || 0) + 1,
          updatedAt: Date.now(),
          availability: 'ready',
          session: { ...inst.lastMetrics.session, compactionCount: ${compactionCount} },
          context: {
            ...inst.lastMetrics.context,
            hasUsageData: true,
            usedTokens: Math.round(${usedRatio} * 1000000),
            usedRatio: ${usedRatio},
            isFallbackCapacity: false,
          },
        });
      })()`, ctx.executionContextId);
      return await main.evaluate(`(() => {
        const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
        const badge = sr.querySelector('#hud-compaction-badge');
        const fill = sr.querySelector('#hud-meter-fill');
        const bStyle = getComputedStyle(badge);
        return {
          hidden: badge.hasAttribute('hidden'),
          tier: badge.getAttribute('data-compaction-tier'),
          bgImage: bStyle.backgroundImage,
          bgColor: bStyle.backgroundColor,
          fgColor: bStyle.color,
          meterFill: fill.getAttribute('fill'),
        };
      })()`);
    };

    const tier1 = await pushTier(1, 0.15);
    const tier2 = await pushTier(2, 0.55);
    const tier3 = await pushTier(3, 0.92);
    assert.equal(tier1.hidden, false);
    assert.equal(tier1.tier, 'low');
    assert.equal(tier1.bgImage, 'none', '1 次压缩应使用轻蓝半透明胶囊而非实心高饱和渐变');
    assert.equal(tier2.tier, 'warn');
    assert.ok(tier2.bgImage.includes('linear-gradient'), '2 次压缩应使用实心琥珀渐变');
    assert.equal(tier3.tier, 'danger');
    assert.ok(tier3.bgImage.includes('linear-gradient'), '3+ 次压缩应使用实心正红渐变');
    assert.notEqual(tier2.bgImage, tier3.bgImage, '2 次琥珀与 3+ 次正红渐变样式必须清晰区分');
    assert.notEqual(tier1.meterFill, tier3.meterFill, '进度条颜色应随占比加深');
    assert.match(tier3.meterFill, /^rgb\(/, '92% 仍保持单色渐深蓝 rgb() 而非跳变红/黄');
    const [rLow] = tier1.meterFill.match(/\d+/g).map(Number);
    const [rHigh, , bHigh] = tier3.meterFill.match(/\d+/g).map(Number);
    assert.ok(rLow > rHigh && bHigh > rHigh, '92% 时蓝色分量占优且比 15% 更深沉');

    await main.evaluate('document.querySelector("#hud-e2e-fixture").remove()');
    await main.evaluate('globalThis.__GRAVITYBOX_HUD_V1__?.reconcileMounts()', ctx.executionContextId);
  });
  await check('真实 HUD binding→Worker SQLite→分栏投递；同会话双栏、A→B→A 与英文独立运行', async () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const directory = join(temp, 'gemini', 'antigravity', 'conversations'); await mkdir(directory, { recursive: true });
    const metadata = input => Buffer.concat([
      HudWriter.encodeLengthDelimited(1, HudWriter.encodeVarintField(1, 100)),
      HudWriter.encodeLengthDelimited(7, HudWriter.encodeVarintField(1, 102)),
      HudWriter.encodeLengthDelimited(9, Buffer.concat([HudWriter.encodeVarintField(2, input), HudWriter.encodeVarintField(3, 50)])),
    ]);
    for (let i=0;i<ids.length;i++) {
      const db = new DatabaseSync(join(directory, ids[i]+'.db'));
      db.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,metadata BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);');
      db.prepare('INSERT INTO steps VALUES(0,14,3,NULL)').run();
      db.prepare('INSERT INTO steps VALUES(1,15,3,?)').run(metadata(100+i*100)); db.close();
    }
    const tree = await main.send('Page.getFrameTree');
    const ctx = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(ids.map((id,i)=>`<div id="binding-pane-${i}" data-testid="conversation-view" data-cascade-id="${id}" style="position:fixed;top:30px;left:${i*470}px;width:450px;background:white"><div data-testid="agent-input-box"><div class="surface-composer" style="height:50px"><button data-testid="model-selector-trigger" aria-label="Select model, current: Gemini 3.8 Flash">Gemini 3.8 Flash</button></div></div></div>`).join(''))})`);
    const values = () => main.evaluate(`(() => [...globalThis.__GRAVITYBOX_HUD_V1__.manager.instances.values()].map(i => ({ slot:i.paneSlotId, revision:i.sessionRevision, conversation:i.currentConvId, tokens:i.lastMetrics.tokens.totalTokens, availability:i.lastMetrics.availability })))()`, ctx.executionContextId);
    await until(async()=> { const rows=await values(); return rows.length===2 && rows[0].tokens===150 && rows[1].tokens===250; });
    const original = await values(); assert.notEqual(original[0].slot, original[1].slot);
    await until(async()=>await main.evaluate(`document.querySelector('#binding-pane-0 [data-testid="model-selector-trigger"]').getAttribute('aria-label')`)==='选择模型，当前：Gemini 3.8 Flash');
    assert.equal(await text(main, '#binding-pane-0 [data-testid="model-selector-trigger"]'), 'Gemini 3.8 Flash');
    await main.evaluate(`document.querySelector('#binding-pane-0').setAttribute('data-cascade-id', '${ids[1]}')`);
    await until(async()=>{const rows=await values();return rows.length===2&&rows.every(r=>r.conversation===ids[1]&&r.tokens===250);});
    const db = new DatabaseSync(join(directory,ids[0]+'.db'));db.prepare('UPDATE steps SET metadata=? WHERE idx=1').run(metadata(101));db.close();
    await main.evaluate(`document.querySelector('#binding-pane-0').setAttribute('data-cascade-id', '${ids[0]}')`);
    await until(async()=>{const rows=await values();return rows[0]?.conversation===ids[0]&&rows[0].tokens===151;});
    const returned=await values();assert.equal(returned[0].slot,original[0].slot);assert.ok(returned[0].revision>original[0].revision);assert.equal(returned[1].tokens,250);
    await command('pause');
    await until(async()=>await main.evaluate(`globalThis.__GRAVITYBOX_HUD_V1__?.manager?.state().languageMode === 'en'`,ctx.executionContextId));
    await until(async()=>{const rows=await values();return rows.length===2&&rows[0].tokens===151;});
    assert.equal(await text(main,'#settings'),'Settings');
    assert.equal(await main.evaluate(`globalThis.__GRAVITYBOX_HUD_V1__.manager.languageMode`,ctx.executionContextId),'en');
    await main.evaluate(`document.querySelector('#binding-pane-0').remove();document.querySelector('#binding-pane-1').remove()`);await command('resume');
    await until(async()=>await text(main,'#settings')==='设置');
  });
  const resources = (await execute('/bin/ps', ['-p', String(backend.pid), '-o', 'rss=,%cpu=,time='])).stdout.trim();
  const finalStatus = await status();
  const finalHeap = await main.send('Runtime.getHeapUsage');
  await check('退出助手撤销翻译且不退出浏览器', async () => {
    await command('stop'); await until(async () => backend.exitCode === 0);
    const tree=await main.send('Page.getFrameTree');const ctx=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});const engineState=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__?.state()',ctx.executionContextId);assert.equal(await text(main, '#settings'), 'Settings',JSON.stringify({engineState,finalStatus}));
    assert.equal(chrome.exitCode, null);
  });
  await writeFile(join(evidenceDir, 'browser-results.json'), JSON.stringify({ date: new Date().toISOString(), scope: 'isolated headless Chrome fixture, not real Antigravity', browser: version.Browser, checks, updateDurationMs: updateDuration, backendResources: { ps: resources, statusRSSMB: finalStatus.rssMB }, rendererHeap: { initial: initialHeap, final: finalHeap, note: '整个测试页面的 JS 堆，包含测试操作，不能归因全部为翻译引擎；不是整个渲染进程 RSS' }, warnings: backendErrors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, updateDurationMs: updateDuration, backendResources: resources }));
} catch (error) {
  await writeFile(join(evidenceDir, 'browser-failure.json'), JSON.stringify({ checks, error: error.stack, backendErrors, chromeErrors, browserEndpoint, chromeExit: { code: chrome?.exitCode, signal: chrome?.signalCode } }, null, 2));
  throw error;
} finally {
  if (backend?.exitCode === null) { try { await command('stop'); } catch { backend.kill('SIGTERM'); } }
  main?.close(); second?.close(); chrome?.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => setTimeout(resolve, 500));
  await rm(temp, { recursive: true, force: true });
}
