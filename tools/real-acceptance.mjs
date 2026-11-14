// Read-only probes of a verified real application. No page content is returned or saved as plaintext.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CDP } from '../dist/cdp.js';
import { discover, allowedTarget, verifyPageService } from '../dist/discovery.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const phase = process.argv[2] ?? 'sample'; if (!/^[A-Za-z0-9-]+$/.test(phase)) throw new Error('Invalid phase');
const sampleCount = Math.min(11, Math.max(1, Number(process.argv[3]) || 1));
const baselineIndex=process.argv.indexOf('--baseline');
if(baselineIndex>=0&&!process.argv[baselineIndex+1])throw Error('--baseline 需要前次采样文件');
const baseline=baselineIndex<0?null:JSON.parse(await readFile(process.argv[baselineIndex+1],'utf8'));
const app = '/Applications/Antigravity.app', profile = join(homedir(), 'Library/Application Support/Antigravity');
const endpoint = await discover(app, profile); if (!endpoint) throw new Error('应用未运行');
const targets = await (await fetch(`http://127.0.0.1:${endpoint.port}/json/list`)).json();
const clients = [];
try {
  for (const target of targets.filter(t => allowedTarget(t))) {
    if (!await verifyPageService(target.url, app)) continue;
    const cdp = new CDP(target.webSocketDebuggerUrl); await cdp.connect();
    const tree = await cdp.send('Page.getFrameTree'); const context = await cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    clients.push({ cdp, id: target.id, contextId: context.executionContextId });
  }
  if(!clients.length)throw new Error('无可验证页面，实机采样未完成；不能将空采样视为通过');
  const snapshots = [];
  for (let sample = 0; sample < sampleCount; sample++) {
    const pages = [];
    for (const { cdp, id, contextId } of clients) {
      const values = await cdp.evaluate(`(async () => {
        const selectors = { editable: 'input,textarea,[contenteditable="true"]', titles:'[data-testid="conversation-row-sidebar"] span.truncate', content:'.markdown,.prose,[data-testid="planner-response-text"],[data-testid="user-input-step"]', codePreview:'.font-mono[style*="white-space"]' };
        const hashes = {};
        for (const [name, selector] of Object.entries(selectors)) {
          const values = Array.from(document.querySelectorAll(selector)).map(e => e.matches('input,textarea') ? e.value : e.textContent);
          const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(values)));
          hashes[name] = { count: values.length, sha256: Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2,'0')).join('') };
        }
        const labels = Array.from(document.querySelectorAll('button,[role="button"],input')).flatMap(e => [e.textContent?.trim(),e.getAttribute('title'),e.getAttribute('aria-label')]);
        const settings=document.querySelector('[role="dialog"][aria-label="Settings"],[role="dialog"][aria-label="设置"]');
        const checkKeys=['Queued Messages','Permission Preset','Tool Permissions','Network Access Rules','Plan Review Policy','Configure agent execution, queued message delivery, and permissions.'];
        const visibleUntranslatedKeys=settings?[...settings.querySelectorAll('div,span,h2')].filter(e=>!e.childElementCount&&e.getClientRects().length&&checkKeys.includes(e.textContent.trim())).length:null;
        return { protectedHashes: hashes, visibleSettings:!!settings, visibleUntranslatedKeys, validationLabels: labels.filter(v => v === '设置（验收）').length, chineseButtons: Array.from(document.querySelectorAll('button')).filter(e => /[\\u3400-\\u9fff]/.test(e.textContent)).length, style: !!document.getElementById('__gravitybox_micro_patch__') };
      })()`);
      const engine = await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__?.state() ?? null', contextId);
      pages.push({ id, ...values, engine });
    }
    snapshots.push({ at: new Date().toISOString(), pages });
    if (sample + 1 < sampleCount) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const version=JSON.parse(await readFile(join(root,'package.json'))).version;
  const out = join(root, `质检报告/${version}-改造验收/实机`); await mkdir(out, { recursive: true });
  const comparison=baseline?(()=>{
    const previous=baseline.snapshots?.at(-1)?.pages??[],current=snapshots.at(-1)?.pages??[];
    const sameTargets=previous.length>0&&previous.length===current.length&&previous.every(p=>current.some(c=>c.id===p.id));
    const changed=sameTargets?current.flatMap(page=>Object.keys(page.protectedHashes).filter(key=>JSON.stringify(previous.find(p=>p.id===page.id)?.protectedHashes?.[key])!==JSON.stringify(page.protectedHashes[key])).map(key=>({id:page.id,category:key}))):[];
    return{sameTargets,protectedUnchanged:sameTargets&&changed.length===0,changed,note:'仅比较相同页面与相同界面状态；用户操作造成的变化需人工判读，不覆盖或恢复输入。'};
  })():null;
  const result={phase,scope:'current_visible_pages_only',appVersion:endpoint.appVersion,legacyPatch:endpoint.legacyPatch,verifiedLoopback:true,comparison,snapshots};
  await writeFile(join(out,`${phase}.json`),JSON.stringify(result,null,2));
  console.log(JSON.stringify({phase,samples:snapshots.length,pages:snapshots.at(-1)?.pages,comparison}));
  if(comparison&&!comparison.protectedUnchanged)process.exitCode=1;
} finally { for (const {cdp} of clients) cdp.close(); }
