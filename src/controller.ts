import { BundleCache } from './bundle-cache.js';
import { CdpHudBridge, HUD_BRIDGE_BINDING_NAME } from './hud.js';
import { safeRoute, scopedKey, describeContext, uniqueCandidates, UI_KINDS, type PendingItem } from './candidates.js';
import { readFile, mkdir } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicJson, atomicText } from './files.js';
import { rendererSources, nativeSources, createCoverage, recordCoverageVisit, coverageMarkdown, classifyCoverage, recountCoverage, coverageScopes, coverageTranslationLookup, resolveCoverageTranslation, isCoverageNoise, type CoverageReport } from './coverage.js';
import { readPluginCatalog, appendPluginViews } from './plugin-catalog.js';
import { DEEP_STEPS, traverseDeep, sanitizeNativeMenus, deepMarkdown, type DeepReport } from './deep-scan.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CDP, assertLoopback } from './cdp.js';
import { allApplicationTargets } from './application-target.js';
import { allowedTarget, discover, verifyPageService, type Endpoint } from './discovery.js';
import { compareLayers, type Dictionary } from './dictionary.js';
import {
  isEnglishSource, SUPPORTED_BUNDLES,
  fetchBundleFromOrigin,
  computeBundleSha256,
  extractUiStrings, extractedKind,
  findMissingStrings,
  createPendingList,
} from './bundle.js';

export type AssistantStatus = {
  schema: 1; mode: string; message: string; appVersion?: string; windows: number;
  dictionaryVersion: string; entries: number; dictionaryError?: string; errors: string[];
  rssMB: number; updatedAt: string; pid: number;
  translationEnabled?: boolean;
  hudEnabled?: boolean;
  unverifiedVersion?: boolean;
  newStringsCount?: number;
  pendingListPath?: string;
  bundleSha256?: string;
  menuHooked?: boolean;
  healing?: boolean;
  lastHealedCount?: number;
  dictionaryBaseVersion?: string;
  onlineTranslation?: boolean;
  languageMode?: string;
  bundleCacheHit?: boolean;
  taskRevision?: number;
  bundleReads?:number;bundleBytes?:number;
};
type PageSession = { cdp: CDP; targetId: string; contextId?: number; registration?: string; updateChain: Promise<void>; url: string;languageMode?:string;detaching?:boolean };
function isSafeCandidate(key: unknown): key is string {
  return typeof key === 'string' && isEnglishSource(key) && key.length <= 400 && !/(?:https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:^|\s)(?:\/|~\/|[A-Za-z]:\\)|\b(?:sk-|AIza)[A-Za-z0-9_-]{12,})/.test(key);
}
const WORLD = 'AGZH-localization-v1';

export class Controller {
  private endpoint?: Endpoint;
  private browser?: CDP;
  private pages = new Map<string, PageSession>();
  private reconnection?: NodeJS.Timeout;
  private targetTimer?: NodeJS.Timeout;
  private stopped = false;
  private paused = false;
  private get dormant() { return this.paused && !this.hudEnabled; }
  private hudEnabled = true;
  private reconnectionDelay = 1000;
  private syncing = false;
  private syncAgain = false;
  private engine = '';
  private runtimeId='';
  private bootCache = new Map<string, string>();
  private dictionaryChain: Promise<void> = Promise.resolve();
  private profileWatchers: FSWatcher[] = [];
  private connecting?: Promise<void>;
  private syncWaiters: (() => void)[] = [];
  private lastInspectedSha?: string;
  private lastInspectedAppVersion?: string;
  private inspectingBundle = false;
  private unverifiedWindowRetries = 0;
  private trustedCandidates: PendingItem[] = [];
  private runtimeCandidates: PendingItem[] = [];
  private bundleCache = new BundleCache();
  private hudBridge: CdpHudBridge;
  private initialBundle?: string;
  private coverage?: CoverageReport;
  private coverageMissingForKey?: string;
  status: AssistantStatus;
  constructor(private options: {
    appPath: string;
    profile: string;
    fixture?: { port: number; origin: string };
    dictionary: Dictionary;
    stateDir?: string;
    geminiDir?: string;
    inspectPort?: number; // Deprecated: never opens a main-process inspector.
    shortcutEnabled?: boolean;
    hudEnabled?: boolean;
    initiallyPaused?: boolean;
    reloadDictionary?: () => Promise<void>;
    selectDictionary?: (version: string) => Promise<Dictionary>;
    onStatus: (status: AssistantStatus) => void;
  }) {
    this.paused = options.initiallyPaused === true;
    this.hudEnabled = options.hudEnabled !== false;
    this.hudBridge = new CdpHudBridge({ geminiDir: options.geminiDir || process.env.GRAVITYBOX_GEMINI_DIR || process.env.GEMINI_DIR });
    this.status = { schema: 1, mode: 'starting', message: '正在初始化', windows: 0, dictionaryVersion: options.dictionary.version, entries: Object.keys(options.dictionary.entries).length, errors: [], rssMB: 0, updatedAt: '', pid: process.pid, menuHooked: false, translationEnabled: !this.paused, hudEnabled: this.hudEnabled };
  }
  private publish(mode?: string, message?: string) {
    if (mode) this.status.mode = mode;
    if (message) this.status.message = message;
    this.status.translationEnabled = !this.paused;
    this.status.hudEnabled = this.hudEnabled;
    this.status.windows = this.pages.size;
    this.status.bundleReads=this.bundleCache.downloads;this.status.bundleBytes=this.bundleCache.downloadedBytes;
    const modes=new Set([...this.pages.values()].map(p=>p.languageMode??'zh'));this.status.languageMode=modes.size>1?'mixed':([...modes][0]??'zh');
    this.status.rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
    this.status.updatedAt = new Date().toISOString();
    this.options.onStatus({ ...this.status });
  }
  private activeAppPath(): string {
    return this.endpoint?.appPath ?? this.options.appPath;
  }
  private closeProfileWatchers() {
    for (const w of this.profileWatchers.splice(0)) {
      try { w.close(); } catch {}
    }
  }
  private watchProfiles() {
    this.closeProfileWatchers();
    if (this.options.fixture) return;
    const knownTargets = allApplicationTargets();
    const profiles = knownTargets.some(t => t.profile === this.options.profile)
      ? [...new Set(knownTargets.map(t => t.profile))]
      : [this.options.profile];
    for (const profileDir of profiles) {
      try {
        const watcher = watch(profileDir, (_event, name) => {
          if (String(name) === 'DevToolsActivePort' && !this.stopped && !this.dormant) {
            clearTimeout(this.reconnection);
            void this.tryConnect().catch(() => this.retry());
          }
        });
        watcher.on('error', () => { try { watcher.close(); } catch {} });
        this.profileWatchers.push(watcher);
      } catch { /* A missing profile uses bounded discovery retries. */ }
    }
  }
  async start() {
    this.engine = await readFile(new URL('./engine.js', import.meta.url), 'utf8');this.runtimeId=createHash('sha256').update(this.engine).digest('hex');
    this.watchProfiles();
    if(this.dormant) {
      if(!this.options.fixture) { this.endpoint=await discover(this.options.appPath,this.options.profile);this.status.appVersion=this.endpoint?.appVersion; }
      this.publish('paused','已按上次选择保持暂停；开启后连接目标窗口');return;
    }
    await this.tryConnect();
  }
  private tryConnect(): Promise<void> {
    if (this.connecting) return this.connecting;
    const attempt = this.connectOnce();
    this.connecting = attempt;
    return attempt.finally(() => { this.connecting = undefined; });
  }
  private async connectOnce() {
    if (this.stopped) return;
    try {
      if (this.browser) { await this.sync(); return; }
      if (this.options.fixture) {
        const port = this.options.fixture.port;
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
        const version = await response.json() as { webSocketDebuggerUrl: string };
        const url = assertLoopback(version.webSocketDebuggerUrl);
        if (Number(url.port) !== port) throw new Error('测试调试端口不匹配');
        this.endpoint = { port, browserURL: url.href, pid: 0, appVersion: 'fixture', legacyPatch: false };
      } else this.endpoint = await discover(this.options.appPath, this.options.profile);
      if (this.stopped) return;
      if (!this.endpoint) { this.publish('waiting', '等待 Antigravity 打开'); this.retry(); return; }
      this.status.appVersion = this.endpoint.appVersion;
      if(this.options.selectDictionary){const dictionary=await this.options.selectDictionary(this.endpoint.appVersion);this.options.dictionary=dictionary;this.status.dictionaryVersion=dictionary.version;this.status.entries=Object.keys(dictionary.entries).length;this.bootCache.clear();}
      if (this.endpoint.legacyPatch) { this.publish('legacy-blocked', '检测到旧汉化，已阻止重复注入；需先完成迁移'); this.retry(30000); return; }
      this.status.dictionaryBaseVersion = [...SUPPORTED_BUNDLES.keys()].filter(v=>compareLayers(v+'.json',this.endpoint!.appVersion+'.json')<=0).sort((a,b)=>compareLayers(a+'.json',b+'.json')).at(-1)??'base';
      if (!this.options.fixture) {
        const activeApp = this.activeAppPath();
        const targets = await (await fetch(`http://127.0.0.1:${this.endpoint.port}/json/list`, { signal: AbortSignal.timeout(2000), redirect: 'error' })).json() as {type: string; url: string}[];
        const target = targets.find(t => allowedTarget(t));
        if (!target || !await verifyPageService(target.url, activeApp)) { this.publish('waiting-window', '等待已确认身份的应用窗口'); this.retry(); return; }
        const bundle=await this.bundleCache.read(activeApp,this.endpoint.pid,this.endpoint.appVersion,new URL(target.url).origin);
        if(this.status.bundleSha256!==bundle.hash){this.runtimeCandidates=[];this.trustedCandidates=[];}this.status.bundleSha256=bundle.hash;this.status.bundleCacheHit=bundle.cacheHit;this.initialBundle=bundle.source;
      }
      this.status.unverifiedVersion=!this.verifiedBundle();
      const browser = this.browser = new CDP(this.endpoint.browserURL);
      await browser.connect();
      if (this.stopped) { browser.close(); this.browser = undefined; return; }
      browser.on('Target.targetCreated', () => this.scheduleSync());
      browser.on('Target.targetInfoChanged', () => this.scheduleSync());
      browser.on('Target.targetDestroyed', () => this.scheduleSync());
      browser.on('disconnected', () => { void this.disconnectPages(); this.browser = undefined; if (!this.stopped) { this.publish('waiting', '连接中断，等待应用恢复'); this.retry(); } });
      await browser.send('Target.setDiscoverTargets', { discover: true });
      this.reconnectionDelay = 1000;
      await this.sync();
    } catch (error) {
      this.browser?.close(); this.browser = undefined;
      this.publish('error', (error as Error).message); this.retry();
    }
  }
  private verifiedBundle(){const expected=SUPPORTED_BUNDLES.get(this.status.appVersion??'');return !!this.options.fixture||!!expected&&expected===this.status.bundleSha256;}
  private retry(delay?: number) {
    clearTimeout(this.reconnection);
    if (this.stopped) return;
    /* 显式传入延迟时（例如"版本未适配，30 秒后再试"）不要再去倍增基数，
       否则会把共享的 reconnectionDelay 顶到上限，污染断线重连路径。 */
    const wait = delay ?? this.reconnectionDelay;
    this.reconnection = setTimeout(() => {
        void this.tryConnect();
    }, wait);
    if (delay === undefined) this.reconnectionDelay = Math.min(30000, this.reconnectionDelay * 2);
  }
  private scheduleSync(delayMs = 100) {
    if (this.stopped) return;
    clearTimeout(this.targetTimer);
    this.targetTimer = setTimeout(() => void this.sync().catch(() => this.publish('error', '窗口探测失败')), delayMs);
  }
  private boot(url: string) {
    const page = new URL(url);
    const key = `${page.origin}${page.pathname}:${this.options.dictionary.version}:${this.verifiedBundle()}:${this.hudEnabled}:${this.paused}`;
    const cached = this.bootCache.get(key);
    if (cached) return cached;
    const source = `delete globalThis.__AGZH_ATTACH_DEEP_SCAN__;delete globalThis.__GRAVITYBOX_ATTACH_HUD__;globalThis.__AGZH_BOOT__=${JSON.stringify({ origin: page.origin, path: page.pathname, dictionary: this.options.dictionary, conservative:!this.verifiedBundle(),runtimeId:this.runtimeId,shortcutEnabled:this.options.shortcutEnabled!==false,hudEnabled:this.hudEnabled,translationEnabled:!this.paused,languageMode:this.paused?'en':'zh',shellValidated:true })};\n${this.engine}`;
    if (this.bootCache.size < 4) this.bootCache.set(key, source);
    return source;
  }
  async sync() {
    if (this.syncing) { this.syncAgain = true; return; }
    if (!this.endpoint || !this.browser || this.stopped) return;
    this.syncing = true;
    try {
      const response = await fetch(`http://127.0.0.1:${this.endpoint.port}/json/list`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      const targets = await response.json() as { id: string; type: string; url: string; webSocketDebuggerUrl: string }[];
      const permitted = targets.filter(target => allowedTarget(target, this.options.fixture?.origin));
      for (const [id, session] of this.pages) {
        const target = permitted.find(target => target.id === id);
        if (!target || this.dormant) { await this.detach(session); this.pages.delete(id); }
        else if (target.url !== session.url) {
          session.url = target.url;
          await this.refreshRegistration(session);
          await this.queueBootstrap(session, false);
        }
      }
      this.status.errors = [];
      if (!this.dormant) for (const target of permitted) if (!this.pages.has(target.id)) {
        if (this.dormant || this.stopped) break;
        try {
          if (!this.options.fixture && !await verifyPageService(target.url, this.activeAppPath())) {
            this.status.errors.push('一个窗口的本地服务身份未确认，已跳过');
            continue;
          }
          if (this.dormant || this.stopped) break;
          const socketURL = assertLoopback(target.webSocketDebuggerUrl);
          if (Number(socketURL.port) !== this.endpoint.port) throw new Error('窗口调试端口不匹配');
          const cdp = new CDP(socketURL.href);
          const session: PageSession = { cdp, targetId: target.id, url: target.url, updateChain: Promise.resolve() };
          await cdp.connect();
          if (this.dormant || this.stopped) { cdp.close(); break; }
          this.pages.set(target.id, session);
          cdp.on('disconnected', () => {this.hudBridge.detachTarget(target.id);if(!session.detaching&&this.pages.get(target.id)===session){this.pages.delete(target.id);this.scheduleSync();}});
          cdp.on('Page.frameNavigated', (event) => { if (!event.frame?.parentId) { this.hudBridge.detachTargetPanes(target.id); session.contextId = undefined; void this.queueBootstrap(session); } });
          cdp.on('Page.navigatedWithinDocument', () => this.scheduleSync());
          cdp.on('Runtime.executionContextsCleared', () => { this.hudBridge.detachTargetPanes(target.id); session.contextId = undefined; });
          await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
          await cdp.send('Runtime.addBinding',{name:'__agzhLanguageChanged',executionContextName:WORLD});
          await this.hudBridge.attachToTarget(target.id, cdp, () => session.contextId, WORLD);
          cdp.on('Runtime.bindingCalled',(event)=>{if(event.name==='__agzhLanguageChanged'&&event.executionContextId===session.contextId&&['zh','en'].includes(event.payload)){session.languageMode=event.payload;this.publish();}else if(event.name===HUD_BRIDGE_BINDING_NAME&&this.hudEnabled&&event.executionContextId===session.contextId){this.hudBridge.handleRawBindingPayload(target.id,event.payload);}});
          await this.refreshRegistration(session);
          await this.queueBootstrap(session, false);
        } catch(error) {
          const failed = this.pages.get(target.id); if (failed) { await this.detach(failed); this.pages.delete(target.id); }
          this.status.errors.push((error as Error).message==='新版页面结构尚未识别，已跳过该窗口'?(error as Error).message:'一个窗口注入失败');
        }
      }
      if (!this.dormant && !this.stopped && permitted.length > 0 && this.pages.size < permitted.length) {
        if (this.unverifiedWindowRetries < 6) {
          this.unverifiedWindowRetries++;
          this.scheduleSync(1500);
        }
      } else {
        this.unverifiedWindowRetries = 0;
      }
      const isVerified = this.verifiedBundle();
      const defaultMode = this.paused
        ? 'paused'
        : this.pages.size
          ? (isVerified ? 'connected' : 'adaptive')
          : 'waiting-window';
      const defaultMsg = this.paused
        ? '已暂停，界面恢复英文'
        : this.pages.size
          ? (isVerified
              ? '已连接；词典修改后自动更新'
              : (this.status.newStringsCount
                  ? `已连接（兼容模式：版本 ${this.endpoint?.appVersion} 发现 ${this.status.newStringsCount} 条新词）`
                  : `已连接（兼容模式：版本 ${this.endpoint?.appVersion} 适配中，使用现有词典）`))
          : '等待受支持窗口；未向未知页面注入';
      this.publish(defaultMode, defaultMsg);

      if (!this.options.fixture && this.endpoint && permitted.length > 0 && !this.inspectingBundle && (this.lastInspectedAppVersion !== this.endpoint.appVersion || this.lastInspectedSha!==this.status.bundleSha256)) {
        const pageTarget = permitted[0];
        if (pageTarget) {
          try {
            const origin = new URL(pageTarget.url).origin;
            void this.inspectBundleInBackground(origin, this.endpoint.appVersion,this.initialBundle);this.initialBundle=undefined;
          } catch {}
        }
      }
      } finally {
      this.initialBundle=undefined;
      this.syncing = false;
      for (const resolve of this.syncWaiters.splice(0)) resolve();
      if (this.syncAgain) { this.syncAgain = false; this.scheduleSync(); }
    }
  }
  private queueBootstrap(session: PageSession, reportUnhandledError = true): Promise<void> {
    if(session.detaching)return Promise.resolve();
    session.updateChain = session.updateChain.catch(() => {}).then(async () => {
      if (this.dormant || this.stopped || session.detaching || this.pages.get(session.targetId)!==session) return;
      const tree = await session.cdp.send('Page.getFrameTree');
      const frame = tree.frameTree.frame;
      if (!allowedTarget({ type: 'page', url: frame.url }, this.options.fixture?.origin)) return;
      if(!this.options.fixture&&this.endpoint){
        const activeApp = this.activeAppPath();
        if(!await verifyPageService(frame.url,activeApp))throw new Error('页面服务身份尚未确认');
        const bundle=await this.bundleCache.read(activeApp,this.endpoint.pid,this.endpoint.appVersion,new URL(frame.url).origin);
        this.status.bundleSha256=bundle.hash;this.status.bundleCacheHit=bundle.cacheHit;this.status.unverifiedVersion=!this.verifiedBundle();
        if(bundle.source)this.initialBundle=bundle.source;
      }

      session.url = frame.url;
      let previous: any;
      if (session.contextId !== undefined) {
        try {
          previous = await session.cdp.evaluate('globalThis.__AGZH_ENGINE_V1__?.state()', session.contextId);
        } catch {
          session.contextId = undefined;
        }
      }
      if (session.contextId === undefined || !previous?.active) {
        const context = await session.cdp.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: WORLD });
        session.contextId = context.executionContextId;
      }
      if(!this.verifiedBundle()){
        if(/^\/(?:onboarding|oauth|auth|login|sign-in)(?:\/|$)/i.test(new URL(frame.url).pathname))throw new Error('未验证的登录或引导页面已跳过');
        const contract=await session.cdp.evaluate(`(async()=>{for(let i=0;i<30;i++){if(!!document.body&&((!!document.querySelector('[aria-label*="Sidebar" i],[aria-label*="侧边栏"],[data-testid*="sidebar" i],[data-testid="agent-input-box"]')&&!!document.querySelector('[data-testid="model-selector-trigger"],a[href="/history"],a[href="/customizations"],[data-testid="agent-input-box"],textarea,input'))||(/^\\/(?:settings(?:\\/[^?#]*)?|settings-standalone)$/.test(location.pathname)&&!!document.querySelector('[role="dialog"][aria-label="Settings"],[role="dialog"][aria-label="设置"],[data-testid*="settings"]')&&!!document.querySelector('[role="tablist"],nav,[role="navigation"]'))||(location.pathname==='/terminal-standalone'&&!!document.querySelector('.xterm,.monaco-editor,[data-testid*="terminal"]'))))return true;await new Promise(r=>setTimeout(r,100));}return false;})()`,session.contextId);
        if(!contract)throw new Error('新版页面结构尚未识别，已跳过该窗口');
      }
      if(this.dormant||this.stopped||session.detaching)return;
      if (!previous?.active) previous = await session.cdp.evaluate('globalThis.__AGZH_ENGINE_V1__?.state()', session.contextId);
      if(this.dormant||this.stopped||session.detaching)return;
      if (previous?.active&&previous.runtimeId===this.runtimeId) {
        if (previous.version === this.options.dictionary.version) await session.cdp.evaluate('globalThis.__AGZH_ENGINE_V1__.refresh()', session.contextId);
        else await session.cdp.evaluate(`globalThis.__AGZH_ENGINE_V1__.update(${JSON.stringify(this.options.dictionary)})`, session.contextId);
      }
      else{if(previous?.active)await session.cdp.evaluate('globalThis.__AGZH_ENGINE_V1__.dispose()',session.contextId);await session.cdp.evaluate(this.boot(session.url),session.contextId);if(this.options.fixture&&previous?.active&&previous.languageMode==='en')await session.cdp.evaluate('globalThis.__AGZH_ENGINE_V1__.toggleLanguage("en")',session.contextId);}
      let state: any;
      for (let i = 0; i < 10; i++) {
        state = await session.cdp.evaluate('globalThis.__AGZH_ENGINE_V1__?.state()', session.contextId);
        if (state?.version === this.options.dictionary.version) break;
        await new Promise(r => setTimeout(r, 100));
      }
      if (state?.version !== this.options.dictionary.version) throw new Error('窗口词典版本未确认');
      session.languageMode=state.languageMode??'zh';
      if (this.hudEnabled) {
        await session.cdp.evaluate('(globalThis.__GRAVITYBOX_ATTACH_HUD__?.(), globalThis.__GRAVITYBOX_HUD_V1__?.setEnabled?.(true), globalThis.__GRAVITYBOX_HUD_V1__?.syncAllSessions?.())', session.contextId).catch(() => {});
      } else {
        await session.cdp.evaluate('globalThis.__GRAVITYBOX_HUD_V1__?.setEnabled?.(false)', session.contextId).catch(() => {});
      }
    });
    if (reportUnhandledError) {
      session.updateChain.catch(() => {
        if (!this.status.errors.includes('一个窗口连接或恢复失败')) this.status.errors.push('一个窗口连接或恢复失败');
        this.publish();
      });
    }
    return session.updateChain;
  }
  private refreshRegistration(session: PageSession):Promise<void> {
    if(session.detaching)return Promise.resolve();
    session.updateChain=session.updateChain.catch(()=>{}).then(async()=>{
      if(session.detaching||this.dormant||this.stopped)return;
      if(session.registration){await session.cdp.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:session.registration});session.registration=undefined;}
      if(session.detaching||this.dormant||this.stopped)return;
      const registered=await session.cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:this.boot(session.url),worldName:WORLD});
      if(session.detaching||this.dormant||this.stopped){await session.cdp.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:registered.identifier});return;}
      session.registration=registered.identifier;
    });return session.updateChain;
  }
  /** 后台异步对比界面包指纹，提取界面串并检测未译新词，不阻塞前台窗口注入与翻译。 */
  private async inspectBundleInBackground(origin: string, appVersion: string,initialSource?:string): Promise<void> {
    if (this.inspectingBundle || this.stopped) return;
    this.inspectingBundle = true;
    try {
      const source = initialSource??await fetchBundleFromOrigin(origin, 8000);
      const sha = computeBundleSha256(source);
      this.status.bundleSha256 = sha;
      this.lastInspectedAppVersion = appVersion;
      if (this.lastInspectedSha === sha) return;
      this.lastInspectedSha = sha;

      const extracted = extractUiStrings(source);
      const missing = findMissingStrings(extracted, this.options.dictionary);
      this.trustedCandidates = missing.filter(isSafeCandidate).map(key=>({key,kind:extractedKind(extracted.find(e=>e.text===key)?.kinds),source:'static'}));
      this.status.newStringsCount = this.trustedCandidates.length;

      if (this.options.stateDir) {
        const reportsDir = join(this.options.stateDir, 'reports');
        await mkdir(reportsDir, { recursive: true });
        if (!this.verifiedBundle()) {
          const byKind: Record<string, number> = {};
          for (const entry of extracted) for (const kind of entry.kinds) byKind[kind] = (byKind[kind] ?? 0) + 1;
          await atomicJson(join(reportsDir, `ui-strings-${appVersion}.json`), {
            schema: 1,
            appVersion,
            source: 'runtime-loopback',
            bundleSha256: sha,
            bundleBytes: Buffer.byteLength(source),
            extractedAt: new Date().toISOString(),
            counts: { total: extracted.length, ...byKind },
            strings: extracted,
          }).catch(() => {});
        }
        if (missing.length > 0) {
          const pendingPath = join(reportsDir, `pending-${appVersion}.json`);
          const pendingPayload = createPendingList(appVersion, sha, this.trustedCandidates.map(e=>e.key));
          await atomicJson(pendingPath, pendingPayload);
          this.status.pendingListPath = pendingPath;
        }
      }

      if (this.stopped || this.paused) return;
      const isVerified = this.verifiedBundle();
      if (!isVerified) {
        const msg = missing.length > 0
          ? `已连接（兼容模式：版本 ${appVersion} 发现 ${missing.length} 条待译新词，已生成清单）`
          : `已连接（兼容模式：版本 ${appVersion} 词典匹配良好）`;
        this.publish('adaptive', msg);
      } else if (missing.length > 0) {
        this.publish('connected', `已连接；发现 ${missing.length} 条新词，已生成待译清单`);
      }
    } catch {
      // 后台探测异常不影响前台窗口注入与翻译
    } finally {
      this.inspectingBundle = false;
    }
  }
  update(dictionary: Dictionary): Promise<void> {
    this.dictionaryChain = this.dictionaryChain.catch(() => {}).then(() => this.applyDictionary(dictionary));
    return this.dictionaryChain;
  }
  private async applyDictionary(dictionary: Dictionary) {
    this.options.dictionary = dictionary;
    this.bootCache.clear();
    this.status.dictionaryVersion = dictionary.version; this.status.entries = Object.keys(dictionary.entries).length;
    this.status.errors = [];
    const results = await Promise.allSettled([...this.pages.values()].map(async session => {
      await this.refreshRegistration(session);
      await this.queueBootstrap(session);
    }));
    if (results.some(result => result.status === 'rejected')) this.status.errors.push('部分窗口未确认词典更新');
    this.publish();
  }
  dictionaryError(message?: string) { this.status.dictionaryError = message; this.publish(); }
  private async detach(session: PageSession) {
    session.detaching=true;
    this.hudBridge.detachTarget(session.targetId);
    let restorationFailed = false;
    try {
      await session.updateChain.catch(() => {});
      if (session.registration) await session.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.registration });
      let ctxId = session.contextId;
      if (ctxId === undefined) {
        const tree = await session.cdp.send('Page.getFrameTree');
        const world = await session.cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: WORLD });
        ctxId = world.executionContextId;
      }
      await session.cdp.evaluate('(globalThis.__AGZH_PENDING_BOOT__?.cancel(),globalThis.__AGZH_ENGINE_V1__?.dispose(),globalThis.__GRAVITYBOX_HUD_V1__?.dispose())', ctxId);
    } catch { restorationFailed = true; }
    session.cdp.close();
    if (restorationFailed) this.status.errors.push('窗口已失联，无法确认恢复英文');
  }
  private async disconnectPages() { for (const session of this.pages.values()) await this.detach(session); this.pages.clear(); }
  async pause() {
    this.paused = true;
    this.bootCache.clear();
    await this.connecting?.catch(()=>{});
    if(this.syncing)await new Promise<void>(resolve=>this.syncWaiters.push(resolve));
    await this.dictionaryChain.catch(() => {});
    await this.disconnectPages();
    if (this.hudEnabled) await this.resumeHudOnly();
    this.publish('paused', this.status.errors.length ? '已暂停，部分窗口恢复情况待确认' : '已暂停，界面恢复英文');
  }
  private async resumeHudOnly() {
    if (this.browser) await this.sync(); else await this.tryConnect();
  }
  async resume() {
    // Recreate the isolated runtime so translation starts from the chosen mode.
    if (this.paused && this.pages.size) await this.disconnectPages();
    this.paused = false;
    this.bootCache.clear();
    try {
      if (this.browser) await this.sync();
      else { clearTimeout(this.reconnection); await this.tryConnect(); }
    } catch {
      this.browser?.close();
      this.browser = undefined;
      clearTimeout(this.reconnection);
      await this.tryConnect();
    }
  }
  async configureShortcut(enabled: boolean) {
    this.options.shortcutEnabled=enabled; this.bootCache.clear();
    for(const session of this.pages.values()) {
      await session.cdp.evaluate(`globalThis.__AGZH_ENGINE_V1__?.setShortcutEnabled(${enabled})`,session.contextId);
      if(session.registration) await session.cdp.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:session.registration});
      const result=await session.cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:this.boot(session.url),worldName:WORLD});session.registration=result.identifier;
    }
  }
  async configureHud(enabled: boolean) {
    this.hudEnabled = enabled;
    this.options.hudEnabled = enabled;
    this.bootCache.clear();
    if (this.paused) {
      await this.disconnectPages();
      if (enabled) await this.resumeHudOnly();
      this.publish(); return;
    }
    if (!enabled) {
      this.hudBridge.clearActivePanes();
    }
    await Promise.allSettled([...this.pages.values()].map(async session => {
      await this.refreshRegistration(session);
      if (session.contextId !== undefined && !session.detaching) {
        if (enabled) {
          await session.cdp.evaluate('((globalThis.__AGZH_BOOT__&&(globalThis.__AGZH_BOOT__.hudEnabled=true)),globalThis.__GRAVITYBOX_ATTACH_HUD__?.(),globalThis.__GRAVITYBOX_HUD_V1__?.setEnabled?.(true),globalThis.__GRAVITYBOX_HUD_V1__?.syncAllSessions?.())', session.contextId);
        } else {
          await session.cdp.evaluate('((globalThis.__AGZH_BOOT__&&(globalThis.__AGZH_BOOT__.hudEnabled=false)),globalThis.__GRAVITYBOX_HUD_V1__?.setEnabled?.(false))', session.contextId);
        }
      }
    }));
    this.publish();
  }
  async toggleLanguage(mode?: 'zh' | 'en'): Promise<void> {
    if (this.paused) return;
    if (!this.pages.size) return;
    await Promise.allSettled([...this.pages.values()].map(async session => {
      if (session.contextId !== undefined) {
        await session.cdp.evaluate(`globalThis.__AGZH_ENGINE_V1__?.toggleLanguage(${mode ? JSON.stringify(mode) : ''})`, session.contextId);
      }
    }));
  }
  snapshot(): AssistantStatus {
    this.status.rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
    this.status.updatedAt = new Date().toISOString();
    return { ...this.status, errors: [...this.status.errors] };
  }
  async coverageReport(): Promise<CoverageReport | undefined> {
    if (this.coverage && (this.coverage.appVersion !== this.status.appVersion || this.coverage.bundleSha256 !== this.status.bundleSha256)) {
      this.coverage = undefined;
    }
    const versionKey = `${this.status.appVersion ?? ''}:${this.status.bundleSha256 ?? ''}`;
    if (!this.coverage && this.options.stateDir && this.coverageMissingForKey !== versionKey) {
      try {
        const saved = JSON.parse(await readFile(join(this.options.stateDir,'reports/coverage.json'),'utf8'));
        if(saved.schema===1 && saved.appVersion===this.status.appVersion && saved.bundleSha256===this.status.bundleSha256) {
          this.coverage=saved;
          this.coverageMissingForKey=undefined;
        } else {
          this.coverageMissingForKey=versionKey;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') this.coverageMissingForKey = versionKey;
      }
    }
    if (this.coverage && (!this.coverage.statusCounts || !this.coverage.observedCounts)) recountCoverage(this.coverage);
    if(this.coverage && this.coverage.dictionaryVersion!==this.options.dictionary.version){
      const lookup=coverageTranslationLookup(this.options.dictionary);
      for(const entry of this.coverage.entries){
        if(entry.status==='native')continue;
        /* B16：先按已知场景精确命中 @ui:<route>|<kind>|<原文>，再退回普通键/任意场景译文。 */
        const resolved=resolveCoverageTranslation(entry.key,lookup,coverageScopes(entry));
        const next=resolved.translation;
        if(next!==entry.translation){delete entry.observed;delete entry.observations;}
        entry.translation=next;entry.scoped=resolved.scoped;
        entry.status=resolved.ambiguous?'review':classifyCoverage(entry.key,next,entry.status==='dynamic');
        if(entry.confidence==='literal'&&entry.status==='missing')entry.status='review';
      }
      this.coverage.dictionaryVersion=this.options.dictionary.version;recountCoverage(this.coverage);
    }
    return this.coverage;
  }
  coverageEditable(entry:CoverageReport['entries'][number]){return entry.confidence==='ui'&&!['native','review','dynamic'].includes(entry.status)&&coverageScopes(entry).length<=1;}
  async prepareCoverageEdit(key:unknown){
    if(typeof key!=='string')throw new Error('请选择界面词条');
    const report=await this.coverageReport(), entry=report?.entries.find(e=>e.key===key);
    if(!entry||!this.coverageEditable(entry))throw new Error('此行不是可直接编辑的确定界面词条；菜单、动态模板或多个场景请单独核对');
    const scope=coverageScopes(entry)[0], normalized=key.replace(/\s+/g,' ').trim(), target=scope?scopedKey(normalized,scope.kind,scope.route):normalized;
    return{key:target,displayKey:key,context:scope?describeContext(scope):'通用界面',value:this.options.dictionary.entries[target]??entry.translation??'',version:this.options.dictionary.version};
  }
  async hasRunningAgentTask(): Promise<{ busy: boolean; reason?: string }> {
    for (const page of this.pages.values()) {
      if (page.contextId === undefined) continue;
      try {
        const res = await Promise.race([
          page.cdp.evaluate(
            `(() => {
              const engineState = globalThis.__AGZH_ENGINE_V1__?.draftState?.();
              if (engineState?.generating) return { busy: true, reason: '检测到活跃的模型流式推理任务' };
              const rendered = e => !!e?.getClientRects?.().length && getComputedStyle(e).visibility !== 'hidden';
              const stopBtn = [...document.querySelectorAll('button,[role="button"],[data-testid*="stop"],[data-testid*="cancel"]')].some(e => {
                if (!rendered(e)) return false;
                const label = (e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('data-tooltip-id') || e.textContent || '').trim();
                if (/^(Stop generating|Stop|Cancel generation|Cancel|Abort|Interrupt|停止生成|停止|取消生成|终止生成|中断)$/i.test(label)) return true;
                if (/(?:stop|cancel)\s*(?:generation|generating|streaming|agent|response|task)/i.test(label)) return true;
                if (e.querySelector?.('.codicon-debug-stop, .codicon-stop-circle')) return true;
                return false;
              });
              if (stopBtn) return { busy: true, reason: '检测到正在执行的 Agent 会话或模型推理任务' };
              const streaming = [...document.querySelectorAll('[data-state="streaming"],[data-streaming="true"],.codicon-loading')].some(rendered);
              if (streaming) return { busy: true, reason: '检测到正在执行的 Agent 会话或模型推理任务' };
              return { busy: false };
            })()`,
            page.contextId
          ),
          new Promise<{ busy: boolean }>(resolve => setTimeout(() => resolve({ busy: false }), 600)),
        ]);
        if (res?.busy) return res;
      } catch {}
    }
    return { busy: false };
  }
  async maintenancePreflight(){
    if(!this.endpoint||!this.pages.size)return{ok:true,pid:0};
    const endpoint=await discover(this.options.appPath,this.options.profile);if(!endpoint||endpoint.pid!==this.endpoint.pid)return{ok:true,pid:endpoint?.pid??0};
    for(const page of this.pages.values()){
      if(page.contextId===undefined)continue;
      const state=await page.cdp.evaluate('globalThis.__AGZH_ENGINE_V1__?.maintenanceState?.()',page.contextId);
      if(state?.busy)throw new Error('请先保存所有窗口的未发送草稿、关闭弹窗并等待任务结束');
    }
    return{ok:true,pid:endpoint.pid};
  }
  async prepareDeepScan() {
    if(this.options.fixture)throw new Error('测试模式不读取系统菜单');
    const endpoint=await discover(this.options.appPath,this.options.profile);
    if(!endpoint||endpoint.pid!==this.endpoint?.pid||endpoint.appVersion!==this.status.appVersion)throw new Error('请先连接已适配的官方应用');
    const sources=await nativeSources(endpoint.appPath ?? this.activeAppPath());
    const report=createCoverage(sources,this.options.dictionary,endpoint.appVersion,this.status.bundleSha256??'');
    const defaults=['Antigravity','File','Edit','View','Window','Help','Services','Hide Antigravity','Hide Others','Show All','Quit Antigravity','About Antigravity','Undo','Redo','Cut','Copy','Paste','Paste and Match Style','Delete','Select All','Minimize','Zoom','Bring All to Front','Open Recent','Clear Menu'];
    const names=[...defaults,...report.entries.map(e=>e.key)];
    return {pid:endpoint.pid,nativeKeys:[...new Set([...names,...names.map(k=>this.options.dictionary.entries[k]).filter((v):v is string=>typeof v==='string')])].filter(k=>k.length<=200).slice(0,1200)};
  }
  async metadataScan(signal:AbortSignal,nativeInput?:unknown,onCommit?:()=>void){
    const prepared=await this.prepareDeepScan();signal.throwIfAborted();
    const report=await this.coverageReport()??createCoverage([],this.options.dictionary,this.status.appVersion??'unknown',this.status.bundleSha256??'',[]);
    const deep:DeepReport={schema:1,scope:'metadata',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),state:'partial',steps:[],plugins:await readPluginCatalog(join(homedir(),'.gemini/config/plugins'),signal),nativeMenus:sanitizeNativeMenus(nativeInput,new Set(prepared.nativeKeys)),notes:['本轮仅采集插件展示说明与原生菜单，未自动切换页面。','插件说明补译需单独勾选、预览并确认，原生菜单不发送到模型。']};
    deep.state=deep.nativeMenus.state==='read'&&!deep.plugins.limited?'complete':'partial';report.deep=deep;signal.throwIfAborted();onCommit?.();const directory=join(this.options.stateDir!,'reports');await atomicJson(join(directory,'coverage.json'),report,signal);await atomicJson(join(directory,'deep-scan.json'),deep,signal);await atomicText(join(directory,'界面深度扫描报告.md'),deepMarkdown(deep),signal);this.coverage=report;this.publish();return{ok:deep.state==='complete',partial:true,message:`已读取 ${deep.plugins.entries.length} 条插件说明；${deep.nativeMenus.message}。未切换应用页面。`};
  }
  async deepScan(signal:AbortSignal, progress:(done:number,total:number)=>void, nativeInput?:unknown,onCommit?:()=>void) {
    if(!this.pages.size)throw new Error('请先连接可识别的应用窗口');
    if(this.pages.size!==1)throw new Error('深度扫描需要一个已连接的窗口；多窗口请分别巡检。');
    // Preflight precedes scanning or navigation; no draft text leaves the page.
    const initial=[...this.pages.values()][0]!;
    if(initial.contextId===undefined)throw new Error('页面尚未就绪');
    const ready=await initial.cdp.evaluate('({available:!!globalThis.__AGZH_ENGINE_V1__?.deepScan})',initial.contextId);
    if(!ready?.available)throw new Error('当前引擎尚未支持深度扫描，请重新连接新版助手');
    progress(0,DEEP_STEPS.length+2);await this.scanCoverage(signal,()=>{},false);signal.throwIfAborted();
    const report=this.coverage!;const allowed=new Set((await this.prepareDeepScan().catch(()=>({nativeKeys:[]}))).nativeKeys);
    const deep:DeepReport={schema:1,scope:'navigation',startedAt:new Date().toISOString(),state:'running',steps:[],plugins:await readPluginCatalog(this.options.fixture?join(this.options.stateDir!,'fixture-plugins'):join(homedir(),'.gemini/config/plugins'),signal),nativeMenus:sanitizeNativeMenus(nativeInput,allowed),notes:['仅遍历已适配的常规入口，不执行插件、安装、账号、删除或发送操作。','用户接管时停止自动操作；恢复未确认会明确记录。','插件说明与实时菜单只存本机，不自动进入在线补译。','资源扫描和界面采样不等于所有账号条件与所有插件界面已覆盖。']};
    report.deep=deep;progress(1,DEEP_STEPS.length+2);let failure:unknown;
    const page={invoke:async(method:string,...args:unknown[])=>{
      if(!['begin','step','sample','scroll','finish'].includes(method))throw new Error('不支持的巡检操作');
      const value=await initial.cdp.evaluate(`globalThis.__AGZH_ENGINE_V1__?.deepScan?.[${JSON.stringify(method)}](...${JSON.stringify(method==='begin'?[report.entries.filter(e=>e.status!=='native').map(e=>e.key)]:args)})`,initial.contextId);
      if(value===undefined)throw new Error("页面上下文已失联，无法继续自动遍历");return value;
    }};
    try {
      const outcome=await traverseDeep(page,signal,async view=>{this.absorbRuntimeCandidates(view?.candidates,report);if(view?.audit)recordCoverageVisit(report,view.route??'/other',view.audit);appendPluginViews(deep.plugins,view?.plugins);},(step,index)=>{deep.steps.push(step);progress(index+1,DEEP_STEPS.length+2);},restored=>{deep.restoration=restored;});
      deep.steps=outcome.steps;deep.restoration=outcome.restoration;
      deep.state=deep.nativeMenus.state==='read'&&deep.steps.every(s=>s.state==='visited')&&deep.restoration?.routeRestored&&deep.restoration?.editorsMatch?'complete':'partial';
    }catch(error){failure=error;const takeover=/用户已接管/.test((error as Error).message);if(takeover)(failure as Error).name='UserIntervention';deep.state=signal.aborted||takeover?'cancelled':'failed';}
    finally {
      deep.finishedAt=new Date().toISOString();
      await initial.cdp.evaluate('globalThis.__AGZH_ENGINE_V1__?.stopAudit()',initial.contextId).catch(()=>{});report.auditExpiresAt=undefined;
      if(!signal.aborted)onCommit?.();
      const directory=join(this.options.stateDir!,'reports');
      await atomicJson(join(directory,'coverage.json'),report);await atomicText(join(directory,'界面覆盖清单.md'),coverageMarkdown(report));
      await atomicJson(join(directory,'deep-scan.json'),deep);await atomicText(join(directory,'界面深度扫描报告.md'),deepMarkdown(deep));this.publish();
    }
    if(failure)throw failure;
    progress(DEEP_STEPS.length+2,DEEP_STEPS.length+2);
    return{ok:deep.state==='complete',partial:true,message:`深度扫描已记录：插件说明 ${deep.plugins.entries.length} 条，界面 ${deep.steps.filter(s=>s.state==='visited').length} 项；${deep.nativeMenus.message}。${deep.restoration?.message??'恢复待确认'}`};
  }
  async scanCoverage(signal: AbortSignal, progress: (done:number,total:number)=>void, captureOnly = false, onCommit?:()=>void, stopAfter = false) {
    if (this.paused || !this.pages.size || !this.endpoint || (!this.status.bundleSha256&&!this.options.fixture)) throw new Error('请先连接已适配的 Antigravity 并开启界面汉化');
    let report = captureOnly ? await this.coverageReport() : undefined;
    if (captureOnly && !report) throw new Error('请先扫描应用资源');
    if (!captureOnly) {
      const page = [...this.pages.values()][0]!; const origin = new URL(page.url).origin;
      if (!this.options.fixture) {
        const endpoint = await discover(this.options.appPath,this.options.profile);
        if (!endpoint || endpoint.pid!==this.endpoint.pid || endpoint.appVersion!==this.status.appVersion || !await verifyPageService(page.url,endpoint.appPath ?? this.activeAppPath())) throw new Error('应用或页面身份已变化，请重新连接');
      }
      const source = await fetchBundleFromOrigin(origin,8000); signal.throwIfAborted(); const hash = computeBundleSha256(source);
      if(this.options.fixture)this.status.bundleSha256=hash;
      if (!this.options.fixture && this.status.bundleSha256!==hash) throw new Error('界面包在扫描期间变化，请重新连接');
      const resources=await rendererSources(origin,source,signal,progress);signal.throwIfAborted();
      if (!this.options.fixture) resources.resources.push(...await nativeSources(this.activeAppPath()));
      signal.throwIfAborted();report=createCoverage(resources.resources,this.options.dictionary,this.status.appVersion!,hash,resources.skipped);
      this.trustedCandidates=uniqueCandidates(report.entries.filter(e=>e.status!=='native'&&e.sources.some(s=>!s.startsWith('可见界面'))&&e.confidence==='ui'&&['missing','unchanged'].includes(e.status)&&!isCoverageNoise(e.key)&&isSafeCandidate(e.key)).map(e=>({key:e.key,kind:e.kind&&UI_KINDS.has(e.kind)?e.kind:undefined,source:'static' as const})));
      this.status.newStringsCount=this.trustedCandidates.length+this.runtimeCandidates.length;
    }
    if(report!.dictionaryVersion!==this.options.dictionary.version) for(const entry of report!.entries){delete entry.observed;delete entry.observations;}
    const lookup = coverageTranslationLookup(this.options.dictionary);
    for (const entry of report!.entries) { const resolved=resolveCoverageTranslation(entry.key,lookup,coverageScopes(entry)); entry.translation=resolved.translation; entry.scoped=resolved.scoped; if(entry.status!=='native') { entry.status=resolved.ambiguous?'review':classifyCoverage(entry.key,entry.translation,entry.status==='dynamic');if(entry.confidence==='literal'&&entry.status==='missing')entry.status='review'; } }
    report!.dictionaryVersion=this.options.dictionary.version;
    const first=[...this.pages.values()][0];
    if(first?.contextId!==undefined){
      const rules=await first.cdp.evaluate('globalThis.__AGZH_ENGINE_V1__?.ruleCatalog?.()??[]',first.contextId);
      for(const key of Array.isArray(rules)?rules:[])if(typeof key==='string'&&key.length<=400&&!report!.entries.some(e=>e.key===key))report!.entries.push({key,status:'dynamic',sources:['内置动态规则'],confidence:'ui'});
    }
    const pluginCatalog = await readPluginCatalog(this.options.fixture ? join(this.options.stateDir ?? '', 'fixture-plugins') : join(homedir(), '.gemini/config/plugins'), signal);
    for (const session of this.pages.values()) if (session.contextId !== undefined) {
      signal.throwIfAborted(); appendPluginViews(pluginCatalog, await session.cdp.evaluate('globalThis.__AGZH_ENGINE_V1__?.pluginCatalog?.()??[]', session.contextId));
    }
    if (captureOnly && report!.deep) appendPluginViews(pluginCatalog, report!.deep.plugins.entries);
    if (report!.deep) report!.deep.plugins = pluginCatalog;
    else report!.deep = {schema:1,scope:'metadata',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),state:'partial',steps:[],plugins:pluginCatalog,nativeMenus:{state:'unavailable',labels:[],unmatched:0,message:'本次资源扫描未读取原生菜单'},notes:['只扫描资源及插件展示说明，未自动遍历页面。']};
    const keys=report!.entries.filter(e=>e.status!=='native').map(e=>e.key);
    for(const session of this.pages.values()) {
      signal.throwIfAborted();if(session.contextId===undefined)continue;
      const dynamic=await session.cdp.evaluate('globalThis.__AGZH_ENGINE_V1__?.collectUntranslated()??[]',session.contextId);
      this.absorbRuntimeCandidates(dynamic,report!,keys);
      const collectionState=await session.cdp.evaluate('globalThis.__AGZH_ENGINE_V1__?.state()',session.contextId);
      const timeLimit='可见文案采集达到时间上限；本次候选不代表该页全部文字。';
      if(collectionState?.lastCollectionTruncated&&!report!.limits.includes(timeLimit))report!.limits.push(timeLimit);
      if(!captureOnly){const started=await session.cdp.evaluate(`globalThis.__AGZH_ENGINE_V1__?.startAudit(${JSON.stringify(keys)})`,session.contextId);report!.auditExpiresAt=started?.expiresAt;}
      const audit=await session.cdp.evaluate(`globalThis.__AGZH_ENGINE_V1__?.auditUi(${JSON.stringify(keys)})`,session.contextId);
      if(!audit)throw new Error('当前引擎不支持页面采样，请更新并重新连接助手');
      const recent=new Map<string,any[]>();
      for(const row of Array.isArray(audit.recent)?audit.recent:[]) {if(typeof row?.route!=='string')continue;const rows=recent.get(row.route)??[];rows.push(row);recent.set(row.route,rows);}
      for(const [route,observations]of recent)recordCoverageVisit(report!,route,{observations});
      recordCoverageVisit(report!,new URL(session.url).pathname,audit);
      if(stopAfter)await session.cdp.evaluate('globalThis.__AGZH_ENGINE_V1__?.stopAudit()',session.contextId);
    }
    if(stopAfter)report!.auditExpiresAt=undefined;
    this.trustedCandidates=uniqueCandidates(report!.entries.filter(e=>e.status!=='native'&&e.sources.some(s=>!s.startsWith('可见界面'))&&e.confidence==='ui'&&['missing','unchanged'].includes(e.status)&&!isCoverageNoise(e.key)&&isSafeCandidate(e.key)).map(e=>({key:e.key,kind:e.kind&&UI_KINDS.has(e.kind)?e.kind:undefined,source:'static' as const})));
    this.status.newStringsCount=this.trustedCandidates.length+this.runtimeCandidates.length;
    signal.throwIfAborted();
    if(!this.options.stateDir)throw new Error('缺少报告目录');
    const directory=join(this.options.stateDir,'reports');await mkdir(directory,{recursive:true,mode:0o700});
    signal.throwIfAborted();onCommit?.();
    await atomicJson(join(directory,'coverage.json'),report!,signal);await atomicText(join(directory,'界面覆盖清单.md'),coverageMarkdown(report!),signal);
    this.coverage=report;this.publish();
    return {ok:true,message:`${captureOnly?'已记录当前界面':'扫描完成'}：${report!.resources.length} 个资源，${report!.entries.length} 条候选；实机已验证 ${report!.counts.verified??0} 条。其他页面仍待检查。`};
  }
  private absorbRuntimeCandidates(rows:unknown,report:CoverageReport,keys?:string[],lookup=coverageTranslationLookup(this.options.dictionary)){
    for(const item of Array.isArray(rows)?rows:[]){
      if(!isSafeCandidate(item?.key)||!UI_KINDS.has(item?.kind)||item.source!=='runtime-ui')continue;
      const route=safeRoute(item.route),kind=item.kind;
      /* B16：已有普通键或 @ui:<route>|<kind>| 场景译文的串，不再判 missing、也不进补译候选。 */
      const resolved=resolveCoverageTranslation(item.key,lookup,[{route,kind}]);
      const asText=(value:string)=>value.replace(/\s+/g,' ').trim().toLowerCase();
      const translated=!!resolved.translation&&asText(resolved.translation)!==asText(item.key);
      if(!report.entries.some(e=>e.key===item.key)){report.entries.push({key:item.key,status:resolved.ambiguous?'review':classifyCoverage(item.key,resolved.translation),confidence:'ui',sources:[`可见界面 ${route} ${kind}`],...(resolved.scoped?{scoped:true}:{})});if(!translated&&!resolved.ambiguous)keys?.push(item.key);}
      if(translated||resolved.ambiguous)continue;
      this.runtimeCandidates.push({key:item.key,kind,route,source:'runtime-ui',translationKey:scopedKey(item.key,kind,route)});
    }
    this.runtimeCandidates=uniqueCandidates(this.runtimeCandidates).slice(-1000);this.status.newStringsCount=this.trustedCandidates.length+this.runtimeCandidates.length;
  }
  async switchTarget(appPath: string, profile: string, stateDir: string) {
    this.closeProfileWatchers();
    clearTimeout(this.reconnection);
    clearTimeout(this.targetTimer);
    await this.connecting?.catch(() => {});
    if (this.syncing) await new Promise<void>(resolve => this.syncWaiters.push(resolve));
    await this.dictionaryChain.catch(() => {});
    await this.disconnectPages();
    this.browser?.close();
    this.browser = undefined;
    this.endpoint = undefined;
    this.options.appPath = appPath;
    this.options.profile = profile;
    this.options.stateDir = stateDir;
    this.coverage = undefined;
    this.coverageMissingForKey = undefined;
    this.lastInspectedSha = undefined;
    this.lastInspectedAppVersion = undefined;
    this.runtimeCandidates = [];
    this.trustedCandidates = [];
    this.status.appVersion = undefined;
    this.status.bundleSha256 = undefined;
    this.status.newStringsCount = undefined;
    this.status.pendingListPath = undefined;
    this.status.errors = [];
    this.reconnectionDelay = 1000;
    this.watchProfiles();
    if (this.dormant) {
      if (!this.options.fixture) {
        this.endpoint = await discover(this.options.appPath, this.options.profile);
        this.status.appVersion = this.endpoint?.appVersion;
      }
      this.publish('paused', '已按上次选择保持暂停；开启后连接目标窗口');
      return;
    }
    await this.tryConnect();
  }
  async stop() {
    this.stopped = true; this.closeProfileWatchers(); clearTimeout(this.reconnection); clearTimeout(this.targetTimer);
    this.hudBridge.dispose();
    await this.connecting?.catch(() => {});
    if (this.syncing) await new Promise<void>(resolve => this.syncWaiters.push(resolve));
    await this.dictionaryChain.catch(() => {});
    await this.disconnectPages(); this.browser?.close();
    this.publish('stopped', this.status.errors.length ? '助手已停止，部分窗口恢复情况待确认' : '助手已停止');
  }
}

