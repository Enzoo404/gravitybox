/* Original runtime engine for AGZH. Runs in an isolated CDP world; no application code is patched. */
(function bootstrapRuntime() {
  'use strict';
  const options = globalThis.__AGZH_BOOT__;
  if (!options || location.origin !== options.origin) return;
  if (options.path === '/fixture' && location.pathname !== '/fixture') return;
  const allowedPath=location.pathname==='/'||/^\/(?:history|sidecars|customizations|settings|settings-standalone|terminal-standalone|new-project|onboarding|multi|artifact|s)(?:\/.*)?$/i.test(location.pathname)||/^\/c\/[0-9a-f-]{36}$/i.test(location.pathname)||/^\/(?:forked|view|battle)\/.*$/i.test(location.pathname)||(options.path==='/fixture'&&location.pathname==='/fixture');
  if(!allowedPath)return;
  if(options.conservative&&/^\/(?:onboarding|oauth|auth|login|sign-in)(?:\/|$)/i.test(location.pathname))return;
  // Recognize the actual system-settings shell, then admit only its content pane.
  // Project navigation, editable values, chat and code keep their existing protection.
  let settingsPaneCache = null;
  function systemSettingsPane() {
    const query=new URL(location.href).searchParams;
    const screen=query.get('settingsScreen');
    if(screen&&!/^(General|App|AppSettings|Application|Appearance|Account|Notifications|Models|KeyboardShortcuts|Shortcuts|Customizations|Editor|Tab|Browser|Developer|Project 4K|Jetski Chat|Provide Feedback|Project General|Project Folders|Project Agent|Permissions)$/i.test(screen)){settingsPaneCache=null;return null;}
    const cached = settingsPaneCache;
    // React can mount before updating the URL, and retain the dialog during its exit animation.
    // A validated, connected pane remains the same scope until it is replaced or detached.
    if(cached&&cached.path===location.pathname&&(!screen||screen===cached.screen)
      &&cached.root.isConnected&&cached.pane.isConnected&&cached.heading.isConnected
      &&cached.root.contains(cached.header)&&cached.pane.contains(cached.heading)&&!cached.pane.contains(cached.header))return cached.pane;
    settingsPaneCache=null;
    const clean=e=>(e?.textContent||'').replace(/\s+/g,' ').trim();
    const labels=['Settings','设置',options.dictionary?.entries?.Settings].filter(Boolean);
    const navigation=['General','通用','Application','App Settings','应用设置','Appearance','外观','Notifications','通知','Models','模型','Keyboard Shortcuts','Shortcuts','快捷键','键盘快捷方式','Account','账户','账号','Customizations','自定义','Editor','Editor Settings','编辑器','编辑器设置','Tab','Browser','浏览器','Developer','开发者','Provide Feedback','提供反馈'];
    const selectors=labels.map(label=>'[role="dialog"][aria-label="'+CSS.escape(label)+'"]').concat('[data-testid="settings-root"]','[data-testid="settings-dialog"]');
    for(const root of document.querySelectorAll(selectors.join(','))) {
      const header=[...root.querySelectorAll('h1')].find(e=>labels.includes(clean(e)));
      if(!header)continue;
      const navigationButtons=[...root.querySelectorAll('button')].filter(e=>navigation.includes(clean(e))||(e.getAttribute('data-testid')||'').startsWith('settings-nav-item-'));
      const names=new Set(navigationButtons.map(clean));
      if(names.size<3)continue;
      const headings=[...root.querySelectorAll('h2')].filter(e=>navigation.includes(clean(e)));
      const heading=headings.find(e=>e.closest('[style*="display: block"]'))||headings[0];
      if(!heading)continue;
      let pane=heading;
      while(pane.parentElement&&root.contains(pane.parentElement)&&!pane.parentElement.contains(header))pane=pane.parentElement;
      if(pane!==root&&pane.contains(heading)&&!pane.contains(header)){
        const close=root.querySelector('button[aria-label="Close"],button[aria-label="关闭"]');
        const sidebarChrome=[...root.querySelectorAll('h1,h2,button')].filter(e=>!pane.contains(e));
        settingsPaneCache={root,pane,header,heading,chrome:[...new Set([header,...navigationButtons,...sidebarChrome,...(close?[close]:[])])],path:location.pathname,screen};
        return pane;
      }
    }
    return null;
  }
  if(options.conservative&&options.path!=='/fixture'&&!options.shellValidated){
    const ready=()=>!!document.body&&(!!systemSettingsPane()||(!!document.querySelector('[aria-label="Sidebar"],[aria-label="侧边栏"]')&&!!document.querySelector('[data-testid="model-selector-trigger"],a[href="/history"],a[href="/customizations"]'))||(/^\/(?:settings(?:\/[^?#]*)?|settings-standalone)$/.test(location.pathname)&&!!document.querySelector('[data-testid="settings-root"],[data-testid="settings-dialog"]')&&!!document.querySelector('[role="tablist"],nav,[role="navigation"]'))||(location.pathname==='/terminal-standalone'&&!!document.querySelector('[data-testid="terminal-toolbar"]')&&!!document.querySelector('.xterm,.monaco-editor')));
    if(!ready()){
      globalThis.__AGZH_PENDING_BOOT__?.cancel();let stopped=false;const watcher=new MutationObserver(()=>{if(!stopped&&ready()){cancel();options.shellValidated=true;bootstrapRuntime();}});const timeout=setTimeout(()=>cancel(),5000);
      function cancel(){stopped=true;watcher.disconnect();clearTimeout(timeout);delete globalThis.__AGZH_PENDING_BOOT__;}
      globalThis.__AGZH_PENDING_BOOT__={cancel};watcher.observe(document,{childList:true,subtree:true});return;
    }options.shellValidated=true;
  }

  const KEY = '__AGZH_ENGINE_V1__';
  if (globalThis[KEY]) { globalThis[KEY].setShortcutEnabled?.(options.shortcutEnabled !== false); globalThis[KEY].update(options.dictionary); return; }
  let shortcutEnabled = options.path === '/fixture' && options.shortcutEnabled !== false;
  const ownedProjectMarkers = new Set();
  const UI = '[data-agzh-ui],button,a[href],h1,h2,h3,h4,[role="navigation"],[role="button"],[role="menuitem"],[role="tab"],[role="option"],[role="tooltip"],[role="dialog"],[role="status"],[role="alert"],[role="banner"],label,th,td,summary,figcaption,.monaco-menu-item,[data-sonner-toast],[role="listitem"],[role="region"],[data-testid*="settings"],[data-testid*="preferences"],[data-testid*="empty"],[data-testid*="notice"],[data-testid*="banner"],[data-testid*="card"],[data-testid*="header"],[data-testid*="sidecar"],[data-testid*="trigger"],[data-testid="agent-input-box"],[contenteditable="true"][role="combobox"]+p,[data-testid="cascade-system-message-toolbar"],[data-testid="turn-cards-container"],[data-select-popup],[role="menu"],[role="listbox"]';
  const UI_SELECTOR = 'button, [role="button"], [role="tab"], [role="menuitem"], [role="tooltip"], [role="option"], label, option, th, td, summary, figcaption, .monaco-menu-item, [data-sonner-toast], [role="listitem"], [role="region"], h1, h2, h3, h4, [data-select-popup], [role="menu"], [role="listbox"]';
  /* PROTECTED keeps user content, code and editors in English. `[data-testid="conversation-row-sidebar"]`
     is the container the app really uses for the conversation list: its title <span> is NOT inside
     `a[href^="/c/"]`, so relying on the anchor alone left conversation titles translatable. */
  const PROTECTED = 'script,style,code,pre,input,textarea,svg,canvas,.file-tree,[data-message-id],[contenteditable]:not([contenteditable="false"]),[data-agzh-protect],[data-message-author-role],[data-testid*="message"]:not([data-testid="cascade-system-message-toolbar"]),[data-testid*="conversation-title"],[data-testid="conversation-row-sidebar"],[data-testid*="conversation-row"],[data-testid*="model"],[data-testid*="artifact"],[data-testid="planner-response-text"],[data-testid="user-input-step"],[data-testid="breadcrumb-segment"],[data-testid="project-header"],[data-testid="project-selector-trigger"],a[href^="/c/"],a[href*="/c/"],.monaco-editor,.xterm,.markdown,.markdown-frontmatter,.markdown-alert-title,.notebook-markdown-cell,.prose,[role="log"],.chat-message,.message-content,.conversation-title,.terminal,.output-view,.debug-console,.code-view,.artifact-container,.model-item,.agzh-project-name,[data-testid*="attachment"],[data-testid*="file-chip"],[data-testid*="context-chip"]';
  /* J01 positive user-content contract. A container marked `data-agzh-user-content` or an element
     marked `data-agzh-user-name` is user-authored text: never translated, never collected. On top
     of the explicit contract (usable by adapters and tests) entity surfaces are recognised
     structurally so user names stay English even on unmarked builds: links to a plugin/skill/
     session/automation detail page carry the entity name, and a heading / name field / list row /
     option row that belongs to an entity card is a name, not interface copy. Genuine controls
     (buttons, tabs, command menus) remain translatable: a `[role="menuitem"]` only counts as a name
     inside an entity container or a row with per-item actions. */
  const USER_CONTENT = '[data-agzh-user-content],[data-agzh-user-name]';
  const ENTITY_HREF = /^\/(?:c\/[0-9a-f-]{36}|customizations\/(?:plugins|skills|automations)\/[\w.-]+|marketplaces\/[\w.-]+\/plugins\/[\w.-]+|automations\/[\w.-]+|projects\/[\w.-]+|sidecars\/[\w.-]+)$/i;
  const ENTITY_CONTAINER = '[data-agzh-user-content],[data-testid*="automation"],[data-testid*="workspace"],[data-testid*="project"],[data-testid*="skill"],[data-testid*="plugin"],[data-testid*="marketplace"],[data-testid*="session"]';
  const ENTITY_ROW = '[data-testid*="card"],[data-testid*="row"],li,[role="listitem"],[role="option"],[role="menuitem"],tr';
  const ROW_ACTIONS = '[data-testid*="actions"],[data-testid*="menu-trigger"],[aria-label*="More actions" i],[aria-label*="更多操作"],[aria-label="More options" i]';
  const USER_NAME_ROW = 'h1,h2,h3,h4,[data-testid*="name"],[data-testid*="title"]';
  const USER_NAME_LEAF = '[role="listitem"],[role="option"]';
  function entityAnchorPath(anchor) {
    try { const url = new URL(anchor.getAttribute('href') || '', location.href); return url.origin === location.origin ? url.pathname : ''; } catch { return ''; }
  }
  function userNamed(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (element.closest(USER_CONTENT)) return true;
    const anchor = element.closest('a[href]');
    if (anchor && ENTITY_HREF.test(entityAnchorPath(anchor))) return true;
    if (element.closest('[data-testid^="conversation-copy-"]')) return false;
    if (element.matches(USER_NAME_ROW)) {
      const row = element.closest(ENTITY_ROW);
      if (row && !row.matches('[data-testid^="conversation-copy-"]') && (row.querySelector(ROW_ACTIONS) || (matches(row, ENTITY_CONTAINER) && !row.closest('[role="menu"]')) || row.closest(ENTITY_CONTAINER))) return true;
    }
    const leaf = element.closest(USER_NAME_LEAF);
    if (leaf && !element.closest('button,[role="button"],a[href],label,[role="menuitem"]')) {
      /* A list row is data (user name); an option row is only a name inside an entity picker or a
         plain listbox. Options of a command menu (model picker, slash commands) are interface
         labels and stay translatable, which is what keeps real menus from being frozen. */
      if (leaf.matches('[role="option"]')) return Boolean(leaf.closest(ENTITY_CONTAINER)) || Boolean(leaf.closest('[role="listbox"]') && !leaf.closest('[role="menu"],[role="dialog"]'));
      return true;
    }
    return false;
  }
  /* J03: third-party/product names are not interface copy. Entity links/cards are protected
     structurally (J01); this allowlist covers brand-only labels rendered as plain text/buttons so a
     dictionary hit can never turn "Gemini"/"GitHub" into Chinese. */
  const BRAND_NAMES = new Set(['antigravity', 'gemini', 'claude', 'gpt', 'chatgpt', 'google', 'github', 'github copilot', 'copilot', 'chrome', 'chromium', 'firefox', 'safari', 'webkit', 'node.js', 'nodejs', 'npm', 'pnpm', 'yarn', 'deno', 'bun', 'electron', 'typescript', 'javascript', 'python', 'rust', 'golang', 'java', 'kotlin', 'swift', 'xcode', 'vscode', 'vs code', 'visual studio code', 'intellij idea', 'pycharm', 'webstorm', 'jetbrains', 'docker', 'kubernetes', 'postgresql', 'postgres', 'mysql', 'sqlite', 'redis', 'mongodb', 'react', 'vue', 'svelte', 'angular', 'next.js', 'vite', 'webpack', 'esbuild', 'tailwind', 'tailwind css', 'openai', 'anthropic', 'deepseek', 'mistral', 'llama', 'perplexity', 'notion', 'slack', 'linear', 'jira', 'figma', 'gitlab', 'bitbucket', 'vercel', 'cloudflare', 'firebase', 'supabase', 'prisma', 'playwright', 'xterm', 'monaco', 'markdown']);
  function isBrandName(value) { return BRAND_NAMES.has(lower(normalize(value))); }
  /* J04 disclosure: templates only understand {0}/{1}… placeholders. printf-style (%s/%d/…) and
     ICU plural/select messages are not recognised (the runtime substitutes the number before the
     engine can match), so callers/UI can state that explicitly instead of silently missing them. */
  const TEMPLATE_CAPABILITIES = {
    schema: 1,
    placeholders: {
      supported: ['{N}'],
      inlineGroup: {
        supported: 'same placeholder order, every non-empty translated run has an existing text slot (safe in-place mapping; links keep their visible text and interaction)',
        unsupported: 'placeholder reorder, placeholder set mismatch, or a non-empty run without a DOM text slot: the complete English sentence is kept (never partially translated, links/buttons are never cleared) and reported as unsupported/review for an in-order dictionary translation',
        collection: 'unsupported/ungrouped inline sentences are still collected as one whole-sentence key'
      }
    },
    unsupported: ['%s', '%d', '%i', '%u', 'icu-plural', 'inline-group-placeholder-reorder', 'inline-group-missing-slot'],
    note: '仅识别 {0}/{1}… 内联占位符。%s/%d 等 printf 占位与 ICU plural/select 文案不会被模板翻译（运行时数字无法匹配）；内联句只应用“顺序一致且每个非空译文段都有现成文本槽”的译文，重排/缺槽/占位符不一致时保留完整英文并标记 unsupported，需在词典中按原占位顺序提供译文。'
  };
  const FORMAT_WARNING = '占位符仅支持 {N}；%s/%d 与 ICU plural 不会被模板翻译';
  function formatWarningFor(text) {
    return (/%[sdifu]/.test(text) || /\{[A-Za-z_][\w]*\s*,\s*(?:plural|select|selectordinal|number|date|time)\s*,/.test(text)) ? FORMAT_WARNING : undefined;
  }
  const TRANSLATABLE_ATTRS = ['title', 'aria-label', 'data-tooltip', 'placeholder'];
  const QUEUE_LIMIT = 50000;
  const nodeSlots = new WeakMap();
  const activeNodes = new Set();
  const observed = new Set();
  const inlineGroups = new WeakMap();
  const inlineGroupContainers = new Set();
  /* J04 conservative correction: templates whose translation cannot be laid out losslessly keep the
     complete English sentence and are reported (one whole-sentence candidate + layoutWarning). */
  const unsupportedInlineGroupReasons = new WeakMap();
  const unsupportedInlineGroupSet = new Set();
  const INLINE_LAYOUT_WARNING = '内联占位符无法安全映射（语序重排/缺少对应文本槽/占位符集合不一致）：已保留完整英文，请在词典中按原占位顺序提供译文';
  const normalize = s => s.replace(/\s+/g, ' ').trim();
  const lower = s => s.toLowerCase();
  let auditKeys = null, auditExpires = 0;
  const auditTrail = new Map();
  function visibleUi(el) {
    if (!el?.getClientRects().length) return false;
    const rect=el.getBoundingClientRect();
    return rect.bottom>0 && rect.right>0 && rect.top<innerHeight && rect.left<innerWidth && getComputedStyle(el).visibility!=='hidden';
  }
  function auditRecord(original, current, el, kind, matches=[]) {
    if (!auditKeys || Date.now() > auditExpires) { auditKeys = null; return; }
    if(auditTrail.size>=5000||!visibleUi(el))return;
    const candidates=matches.length?matches:[original];
    const route=scopeRoute(el);
    for(const item of candidates){const key=auditKeys.get(normalize(item));if(!key)continue;const state=languageMode==='zh'&&normalize(current)!==normalize(original)?'verified':'untranslated';auditTrail.set(route+'\n'+key,{route,key,state,kind});}
  }

  function inferKind(el) {
    if (!el || typeof el.closest !== 'function') return 'label';
    if (el.closest('button, [role="button"]')) return 'button';
    if (el.closest('[role="tab"]')) return 'tab';
    if (el.closest('[role="menuitem"], .monaco-menu-item')) return 'menuitem';
    if (el.closest('[role="tooltip"], [data-tooltip], [title]')) return 'tooltip';
    if (el.closest('h1, h2, h3, h4, h5, h6')) return 'heading';
    if (el.closest('label')) return 'label';
    if (el.closest('[role="option"], option')) return 'option';
    if (el.closest('[data-sonner-toast], [role="alert"], [role="status"]')) return 'toast';
    return 'label';
  }

  function isValidUiText(raw) {
    if (!raw || typeof raw !== 'string') return false;
    const text = normalize(raw);
    if (text.length < 2 || text.length > 120) return false;
    if (!/[a-zA-Z]{2,}/.test(text)) return false;
    if (/[\u3400-\u9fff]/.test(text)) return false;
    if (/(?:https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:^|\s)(?:\/|~\/|[A-Za-z]:\\)|\b(?:sk-|AIza)[A-Za-z0-9_-]{12,})/.test(text)) return false;
    if (/^\d+[\w\s.-]*$/.test(text)) return false;
    if (/\[(?:calc|\d+|min|max|var|rgba?)[^\]]*\]/.test(text)) return false;
    if (/^\d+px\s+solid/i.test(text) || /^rgba?\(/i.test(text) || /cubic-bezier/i.test(text)) return false;
    if (/^system-ui,|^ui-monospace,/.test(text) || /^translate[XY]\(/.test(text)) return false;
    if (/^(?:grid-rows-|opacity-|scale-|max-h-|max-w-|min-w-|h-|w-|p-|bg-|border)/.test(text) && /-|:/.test(text)) return false;
    if (/^EDITION_\d+_TEST_ONLY$/.test(text) || /^Optional(?:Double|Int)?\.empty\(\)$/.test(text)) return false;
    if (/^(?:Alt|Ctrl|Cmd|Shift)\+[\w.]+$/i.test(text)) return false;
    if (/^[a-z-]+(?::[a-z-]+)*\s+[a-z-]+/.test(text) && /-|:/.test(text)) return false;
    return true;
  }
  /* J04: whole-sentence keys from inline groups are longer than a label and legitimately contain
     {N} placeholders; they still must not carry URLs/emails/paths/secrets or Chinese. */
  function isValidTemplateText(raw) {
    if (!raw || typeof raw !== 'string') return false;
    const text = normalize(raw);
    if (text.length < 4 || text.length > 400) return false;
    if (!/[a-zA-Z]{2,}/.test(text)) return false;
    if (/[\u3400-\u9fff]/.test(text)) return false;
    if (/(?:https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:^|\s)(?:\/|~\/|[A-Za-z]:\\)|\b(?:sk-|AIza)[A-Za-z0-9_-]{12,})/.test(text)) return false;
    return true;
  }

  let dictionary = options.dictionary;
  let foldedMap = new Map();
  let languageMode = 'zh'; // 'zh' | 'en'
  let active = true;
  let observer;
  let timer = null;
  let scanning = false;

  let lastMatchedKeys=[];
  const conservative=!!options.conservative;
  const restrictedAdaptiveRoute=()=>conservative&&/^\/(?:onboarding|oauth|auth|login|sign-in)(?:\/|$)/i.test(location.pathname);
  const scopeRoute=(el)=>{const panel=el?.closest('[role="dialog"],[data-testid*="settings"],[data-testid*="preferences"]');if(panel&&((panel.getAttribute('data-testid')||'').match(/settings|preferences/)||/^(Settings|设置)$/.test(panel.querySelector('h1,[role="heading"]')?.textContent?.trim()??'')))return '/settings';return location.pathname==='/fixture'?'/fixture':/^\/customizations(?:\/installed)?$/.test(location.pathname)?location.pathname:location.pathname.startsWith('/settings')?'/settings':['/','/history','/sidecars','/automations'].includes(location.pathname)?location.pathname:'/other';};
  const scopeKey=(key,kind,route=scopeRoute())=>`@ui:${route}|${kind}|${key}`;
  /* J02 SPA route guard. The bootstrap allow-list above is evaluated once per document, but the app
     is a SPA: in-app navigation keeps the same document and the same injected engine, so an
     out-of-list route (onboarding/oauth/login/unknown) used to keep receiving translations. The
     guard re-checks the same allow-list on popstate/hashchange, before every flush, on update()
     (the controller calls it after navigatedWithinDocument) and by a light poll. Outside the list
     the engine suspends, restores every translation it owns to English and drops its queue; when
     the route comes back the document is rescanned and Chinese is re-applied. */
  const ALLOWED_ROUTE = /^(?:\/|\/(?:history|sidecars|customizations|settings|settings-standalone|terminal-standalone|new-project|onboarding|multi|artifact|s)(?:\/.*)?|\/c\/[0-9a-f-]{36}|\/(?:forked|view|battle)\/.*)$/i;
  const RESTRICTED_ROUTE = /^\/(?:onboarding|oauth|auth|login|sign-in)(?:\/|$)/i;
  let routeExcluded = false;
  let routeTimer = null;
  function routeAllowedNow() {
    if (options.path === '/fixture') return location.pathname === '/fixture';
    if (RESTRICTED_ROUTE.test(location.pathname)) return false;
    return ALLOWED_ROUTE.test(location.pathname);
  }
  function restoreAllSlots() {
    /* A fresh scan token invalidates the per-scan eligible/blocked caches; reusing the current
       scanCount would read a stale "eligible" entry and leave the Chinese text in place. */
    const scan = ++scanCount;
    for (const node of activeNodes) {
      if (!node.isConnected) { activeNodes.delete(node); continue; }
      const slots = nodeSlots.get(node);
      if (!slots?.size) { activeNodes.delete(node); continue; }
      for (const attr of [...slots.keys()]) updateValue(node, attr, scan);
    }
  }
  function applyRouteGuard(force = false) {
    const excluded = !routeAllowedNow();
    if (excluded === routeExcluded && !force) return routeExcluded;
    routeExcluded = excluded;
    if (excluded) {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      pending.clear(); waiting.clear(); settingsWaiting.clear(); requeueDocument = false; reconcileRequested = false; reconcileQueue = null;
      /* updateValue() is the single place that knows how to put a slot back to English and drop it;
         reusing it here keeps suspension and restoration in agreement (no stale slot afterwards). */
      restoreAllSlots();
    } else {
      requeueDocument = true;
      schedule(document);
    }
    return routeExcluded;
  }
  function checkRoute() { if (active) applyRouteGuard(false); }
  routeExcluded = !routeAllowedNow();
  let pluginCardsAt=-1,pluginCards=[];
  function pluginCardRoots(){
    if(!/^\/customizations(?:\/installed)?$/.test(location.pathname))return [];
    if(pluginCardsAt===scanCount)return pluginCards;pluginCardsAt=scanCount;pluginCards=[];
    const pluginLink=a=>{try{const u=new URL(a.href,location.href);return u.origin===location.origin&&/^\/customizations\/(?:plugins\/[\w.-]+|marketplaces\/[\w.-]+\/plugins\/[\w.-]+)$/.test(u.pathname);}catch{return false;}};
    for(const anchor of [...document.querySelectorAll('a[href]')].filter(pluginLink)){
      let card=anchor.parentElement;
      for(let i=0;i<7&&card;i++,card=card.parentElement){
        if(['BODY','HTML','MAIN'].includes(card.tagName))break;
        const links=[...card.querySelectorAll('a[href]')].filter(pluginLink);if(links.length!==1)break;
        if(card.querySelector('input,textarea,[contenteditable="true"],pre,code'))break;
        if(!card.querySelector('button,[role="button"]'))continue;
        const walker=document.createTreeWalker(card,NodeFilter.SHOW_TEXT);let description=false,count=0;
        while(walker.nextNode()&&++count<300){const n=walker.currentNode;if(n.parentElement.closest('a,button,[role="button"],svg,script,style'))continue;const text=normalize(n.nodeValue);if(text&&!['Official','官方','Installed','已安装','New','新','Notice','说明','Preview','预览','Beta'].includes(text)){description=true;break;}}
        if(description){pluginCards.push({card,anchor});break;}
      }
    }return pluginCards;
  }
  function pluginDescription(el){return !!el&&!el.closest('a,button,[role="button"]')&&pluginCardRoots().some(({card})=>card.contains(el));}
  /* Entity names are never translated, but a build that translated them before this guard existed
     can still hold Chinese slots; report the recorded original so plugin metadata stays stable. */
  function originalText(element) {
    let out = '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) { const node = walker.currentNode; out += nodeSlots.get(node)?.get('')?.original ?? node.nodeValue ?? ''; }
    return out;
  }
  function pluginCatalog(){
    if(routeExcluded||restrictedAdaptiveRoute())return [];
    const entries=[];
    for(const {card,anchor} of pluginCardRoots()){
      if(blocked(card,scanCount))continue;const parts=[],walker=document.createTreeWalker(card,NodeFilter.SHOW_TEXT);let count=0;
      while(walker.nextNode()&&++count<300){const n=walker.currentNode;if(n.parentElement.closest('a,button,[role="button"],svg,script,style')||blocked(n.parentElement,scanCount))continue;const text=normalize(nodeSlots.get(n)?.get('')?.original??n.nodeValue);if(text&&!['Official','官方','Installed','已安装','New','新','Notice','说明','Preview','预览','Beta'].includes(text))parts.push(text);}
      const u=new URL(anchor.href,location.href);
      const labelAttr=anchor.getAttribute('aria-label');
      const labelOriginal=normalize(nodeSlots.get(anchor)?.get('aria-label')?.original ?? labelAttr ?? originalText(anchor));
      for(const description of new Set(parts)){entries.push({id:u.pathname.split('/').at(-1),name:labelOriginal.slice(0,160),description:description.slice(0,2000),truncated:description.length>2000,source:location.pathname.endsWith('/installed')?'installed-view':'marketplace-view'});if(entries.length>=250)break;}
      if(entries.length>=250)break;
    }return entries;
  }
  function rebuildIndex(dict) {
    dictionary = dict;
    foldedMap = new Map();
    if (!dict?.entries) return;
    for (const [k, v] of Object.entries(dict.entries)) {
      if(k.startsWith('@ui:'))continue;
      const f = lower(k);
      if (!foldedMap.has(f)) foldedMap.set(f, v);
    }
  }
  rebuildIndex(options.dictionary);

  function injectMicroPatch() {
    try {
      if (typeof document === 'undefined' || document.getElementById('__agzh_micro_patch__')) return;
      const target = document.head || document.documentElement;
      if (!target) return;
      const style = document.createElement('style');
      style.id = '__agzh_micro_patch__';
      style.textContent = `
        [data-agzh-loc="1"], [data-agzh-ui] {
          -webkit-font-smoothing: antialiased;
          font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        }
        button[data-agzh-loc="1"], [role="button"][data-agzh-loc="1"], [role="tab"][data-agzh-loc="1"],
        button[data-agzh-ui], [role="button"][data-agzh-ui], [role="tab"][data-agzh-ui] {
          white-space: nowrap;
        }
        p[data-agzh-loc="1"], .description[data-agzh-loc="1"],
        p[data-agzh-ui], .description[data-agzh-ui] {
          line-height: 1.5;
        }
      `;
      target.appendChild(style);
    } catch {}
  }
  injectMicroPatch();
  /* A Set keeps one entry per node, so repeated notifications for the same element (or an
     element already queued through an ancestor) are free. An array let the same subtree be
     re-expanded once per duplicate, which grew without bound under sustained mutations. */
  const waiting = new Set();
  const settingsWaiting = new Set();
  let requeueDocument = false;
  let dictionaryToastPending = false;
  let dictionaryToastLastAt = -Infinity;
  let reconcileRequested = false;
  let queueTrimmed = false;
  let droppedBatches = 0;
  let skippedRestores = 0;
  let scanCount = 0;
  let maxSliceMs = 0;
  let lastCollectionTruncated = false;
  const pending = new Set();
  let projectNames = new Set();
  let projectSnapshotAt = -1;
  let projectQueryAt = -Infinity;
  let projectSearchDirty = true;

  function ancestors(element) {
    const result = [];
    while (element) {
      result.push(element);
      element = element.parentElement || (element.getRootNode()?.host ?? null);
    }
    return result;
  }
  function matches(element, selector) { try { return element.matches(selector); } catch { return false; } }
  /* J08: protection-state fingerprint per element. Presentational class churn (hover/active/
     animation utilities) keeps the token unchanged, so the observer can drop those mutations
     entirely instead of scheduling a subtree rescan and a recorded-node reconcile. Only state that
     can flip "translatable <-> protected" (protection-relevant classes, role, contenteditable,
     protection markers, data-testid) invalidates the element, and therefore its recorded subtree. */
  const protectionTokens = new WeakMap();
  const PROTECTIVE_CLASSES = new Set(['chat-message', 'message-content', 'conversation-title', 'terminal', 'output-view', 'debug-console', 'code-view', 'artifact-container', 'model-item', 'markdown', 'markdown-frontmatter', 'markdown-alert-title', 'notebook-markdown-cell', 'prose', 'file-tree', 'agzh-project-name']);
  const PROTECTION_ATTRS = ['class', 'role', 'contenteditable', 'data-testid', 'data-agzh-protect', 'data-agzh-user-content', 'data-agzh-user-name'];
  function protectionToken(el) {
    const raw = typeof el.className === 'string' ? el.className : '';
    let protective = '';
    for (const token of raw.split(/\s+/)) if (token && PROTECTIVE_CLASSES.has(token)) protective += token + ' ';
    return protective + '|' + (el.getAttribute('role') || '') + '|' + (el.getAttribute('contenteditable') || '') +
      '|' + (el.hasAttribute('data-agzh-protect') ? 'p' : '') + (el.hasAttribute('data-agzh-user-content') ? 'u' : '') + (el.hasAttribute('data-agzh-user-name') ? 'n' : '') +
      '|' + (el.getAttribute('data-testid') || '');
  }
  function protectionChanged(el) {
    const token = protectionToken(el);
    const previous = protectionTokens.get(el);
    protectionTokens.set(el, token);
    return previous !== token;
  }
  /* Project names are not fixed at load time: projects can be created, renamed or rendered
     after the engine starts. Re-snapshot whenever the DOM changed since the last evaluation. */
  function refreshProjectNames(scan) {
    if (projectSnapshotAt === scan) return;
    const now = performance.now();
    /* The header lookup is a whole-document query and project names only gate dialog-button
       protection. Refresh when the header subtree actually changed, at most once per 750ms, plus a
       slow heartbeat so renames are still observed without querying on every streamed token. */
    if (projectSearchDirty) { if (now - projectQueryAt < 750) return; }
    else if (now - projectQueryAt < 5000) { projectSnapshotAt = scan; return; }
    projectSnapshotAt = scan; projectQueryAt = now; projectSearchDirty = false;
    const next = new Set();
    for (const node of document.querySelectorAll('[data-testid="project-header"]')) {
      const name = normalize(node.textContent || '');
      if (!name) continue;
      next.add(name);
      /* Tag the button that carries a project name so later mutation/removal is noticed even
         after the header itself is gone; the class is also part of PROTECTED. Guard the write:
         classList.add on an element that already has the class is a no-op, but an unconditional
         write produced a mutation on every scan and drove the flush timer into a busy loop. */
      if (matches(node, 'button,[role="button"]') && !node.classList.contains('agzh-project-name')) { node.classList.add('agzh-project-name'); ownedProjectMarkers.add(new WeakRef(node)); }
    }
    projectNames = next;
  }
  const blockedCache = new WeakMap();
  const eligibleCache = new WeakMap();

  const MODEL_LABELS = new Set(['Model', 'Usage', 'View Usage', 'Weekly limit', 'Daily limit', 'Weekly Limit Remaining', 'Five Hour Limit Remaining', 'Gemini Models', 'Claude and GPT models', 'Gemini 4 Argon', 'Gemini 4 Argon Weekly Limit', 'New', 'Notice', 'Unavailable', 'Refreshing...', 'No quota information available.', '% left']);
  const MODEL_GROUP_LABEL = /^Models within this group:\s*((?:(?:Gemini|Claude|GPT)[\w .,+()/-]{0,399})?)$/i;
  const MODEL_LIMIT_LABEL = /^\d+[smhd]\s+limit$/i;
  const MODEL_PERCENT_LEFT = /^(?:\d+%\s+)?left$/i;
  function modelUiLabel(element) {
    if (!element || element.childElementCount || !element.closest('[role="menu"],[role="tooltip"],[data-testid="model-selector-panel"],[data-select-popup]')) return false;
    const original = nodeSlots.get(element.firstChild)?.get('')?.original ?? element.textContent ?? '';
    const value = normalize(original);
    if (!MODEL_LABELS.has(value) && !MODEL_LIMIT_LABEL.test(value) && !MODEL_PERCENT_LEFT.test(value) && !MODEL_GROUP_LABEL.test(value) && !/^Resets in (?:<1m|\d+[dhms](?:\s+\d+[dhms])*)$/.test(value)) return false;
    // Only fixed interface labels may cross model containers. Content, names and editors stay protected.
    return ancestors(element).every(el => !matches(el, PROTECTED) || (el.hasAttribute('data-testid') && /model/.test(el.getAttribute('data-testid')) && !matches(el, '[data-agzh-protect],[contenteditable],.model-item')));
  }

  function isRelativeTimeBadge(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || element.childElementCount) return false;
    // A time-shaped user title/body is still user content. Only a leaf badge inside a known row
    // can bypass the row's protection; use its saved original so Chinese does not change eligibility.
    const row = element.closest('[data-testid="conversation-row-sidebar"]');
    if (!row || element.matches('.truncate,[data-testid*="title"]') || element.closest('.truncate,[data-agzh-protect],.markdown,.prose,[data-message-author-role]')) return false;
    if (ancestors(element).some(el => el !== row && el.matches(PROTECTED))) return false;
    const text = element.firstChild;
    const original = nodeSlots.get(text)?.get('')?.original ?? element.textContent ?? '';
    return /^\d+(?:s|m|h|d|w|mo|y)$/.test(normalize(original));
  }
  function settingsProjectName(element,scan) {
    const button=element?.closest?.('button');
    if(!button||inSystemSettings(button,scan))return false;
    const pane=settingsScope;
    const root=pane?.closest('[role="dialog"],[data-testid="settings-root"],[data-testid="settings-dialog"]');
    if(!root?.contains(button))return false;
    // The small standalone expansion control is built-in navigation, unlike project rows.
    const original=nodeSlots.get(button.firstChild)?.get('')?.original??button.textContent??'';
    if(button.matches('.text-xs.mx-4.hover\\:underline')&&['Show All','Show all','显示全部','Collapse','收起'].includes(normalize(original)))return false;
    const headings=[...root.querySelectorAll('h2')].filter(e=>!pane.contains(e));
    const label=e=>(e.textContent||'').replace(/\s+/g,' ').trim();
    const start=headings.find(e=>['Projects','Project list','项目列表','项目'].includes(label(e)));
    if(!start||!(start.compareDocumentPosition(button)&Node.DOCUMENT_POSITION_FOLLOWING))return false;
    const next=headings.find(e=>e!==start&&(start.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING));
    return !next||!!(button.compareDocumentPosition(next)&Node.DOCUMENT_POSITION_FOLLOWING);
  }
  function blocked(element, scan = 0) {
    if(routeExcluded||restrictedAdaptiveRoute())return true;
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return true;
    // Appearance uses a styled DIV for its static code preview, without code/pre markup.
    if(inSystemSettings(element,scan)&&ancestors(element).some(el=>el.classList?.contains('font-mono')&&/^(pre|pre-wrap|break-spaces)$/.test(el.style.whiteSpace)))return true;
    if (isRelativeTimeBadge(element)) return false;
    if (modelUiLabel(element)) return false;
    if (userNamed(element) || settingsProjectName(element,scan)) return true;
    const cached = blockedCache.get(element);
    if (cached !== undefined && cached.scan === scan) return cached.val;
    const isProt = ancestors(element).some(el => matches(el, PROTECTED)) || (element.tagName === 'BUTTON' && Boolean(element.closest('[role="dialog"]')) && projectNames.has(normalize(element.textContent || '')));
    blockedCache.set(element, { scan, val: isProt });
    return isProt;
  }
  let settingsScope=null,settingsScopeScan=-1;
  function inSystemSettings(element,scan) {
    if(scan!==settingsScopeScan||settingsScope&&!settingsScope.isConnected){settingsScopeScan=scan;settingsScope=systemSettingsPane();}
    return !!element&&!!settingsScope&&settingsScope.contains(element);
  }
  function isDialogPromptParagraph(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const p = element.closest('p');
    if (!p) return false;
    const dialog = p.closest('[role="dialog"],[role="alertdialog"]');
    if (!dialog) return false;
    if (dialog.getAttribute('aria-label') === 'Settings' || dialog.querySelector('aside,[data-testid*="settings"]')) return false;
    return Boolean(dialog.querySelector('[data-testid*="confirm"],button'));
  }
  function eligible(element, scan = 0) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (isRelativeTimeBadge(element)) return true;
    if (modelUiLabel(element)) return true;
    if (isDialogPromptParagraph(element)) return !blocked(element, scan);
    if(conservative&&(!element||!element.closest('button,[role="button"],[role="tab"],[role="menuitem"],[role="tooltip"],label,h1,h2,h3,h4,a[href],[role="navigation"],[data-testid*="card"],[data-testid="cascade-system-message-toolbar"],[contenteditable="true"][role="combobox"]+p,[data-select-popup],[role="menu"],[role="listbox"],[role="option"]'))&&!pluginDescription(element)&&!inSystemSettings(element,scan))return false;
    const cached = eligibleCache.get(element);
    if (cached !== undefined && cached.scan === scan) return cached.val;
    const isElig = !blocked(element, scan) && (Boolean(element.closest(UI)) || pluginDescription(element) || inSystemSettings(element,scan));
    eligibleCache.set(element, { scan, val: isElig });
    return isElig;
  }
  /* Dictionary keys are matched case-insensitively via pre-compiled foldedMap in O(1) time. */
  function entryFor(key) {
    const entries = dictionary.entries;
    if (Object.hasOwn(entries, key)) return entries[key];
    const folded = lower(key);
    if (Object.hasOwn(entries, folded)) return entries[folded];
    return foldedMap.get(folded);
  }

  function formatDuration(d) {
    return d
      .replace(/(\d+)\s*h\b/gi, '$1小时')
      .replace(/(\d+)\s*m\b/gi, '$1分')
      .replace(/(\d+)\s*s\b/gi, '$1秒')
      .replace(/(\d+)\s*ms\b/gi, '$1毫秒')
      .replace(/\s+/g, '');
  }

  const TEMPLATE_RULES = [
    { key: "Models within this group: {models}", pattern: MODEL_GROUP_LABEL, replace: (_, models) => `此组包含的模型：${models}` },
    { key: "Load older messages, showing {shown} of {total}", pattern: /^Load older messages, showing (\d+) of (\d+)$/i, replace: (_,shown,total) => `加载更早消息（已显示 ${shown} / ${total} 条）` },
    {
      key: "Resets in {duration}", pattern: /^Resets in (<1m|\d+[dhms](?:\s+\d+[dhms])*)$/i,
      replace: (_, time) => time === '<1m' ? '将在 1 分钟内重置' : `${time.replace(/(\d+)d/g, '$1天').replace(/(\d+)h/g, '$1小时').replace(/(\d+)m/g, '$1分钟').replace(/(\d+)s/g, '$1秒')}后重置`
    },
    {
      key: "{window} limit",
      pattern: /^(\d+)([smhd])\s+limit$/i,
      replace: (_, count, unit) => `${count}${{ s: '秒', m: '分钟', h: '小时', d: '天' }[unit.toLowerCase()] || unit}限额`
    },
    {
      key: "{percent}% left",
      pattern: /^(\d+)%\s+left$/i,
      replace: (_, p) => `${p}% 剩余`
    },
    {
      key: "Send feedback as {email}",
      pattern: /^Send feedback as\s+(.+)$/i,
      replace: (_, email) => `以 ${email} 身份发送反馈`
    },
    // 1. Agent 执行时长与阶段状态 (如 Worked for 49s / Stopped after 12s)
    {
      key: "Worked for {duration}", pattern: /^Worked for\s+(\d+.*)$/i,
      replace: (_, d) => `已用时 ${formatDuration(d)}`
    },
    {
      key: "Stopped after {duration}", pattern: /^Stopped after\s+(\d+.*)$/i,
      replace: (_, d) => `在 ${formatDuration(d)} 后停止`
    },
    {
      key: "Thinking duration: {duration}", pattern: /^Thinking duration:\s*(\d+.*)$/i,
      replace: (_, d) => `思考时长：${formatDuration(d)}`
    },
    {
      key: "Thinking for {duration}", pattern: /^(?:Thought|Thinking)\s+for\s+(\d+.*)$/i,
      replace: (_, d) => `已思考 ${formatDuration(d)}`
    },

    // 2. 列表折叠展开与分页 (如 See 6 more / See 5 more plugins)
    {
      key: "See {count} more {category}", pattern: /^See\s+(\d+)\s+more\s+(.+)$/i,
      replace: (_, n, type) => {
        const typeMap = {
          plugins: '个插件',
          skills: '个技能',
          bundles: '个扩展包',
          items: '项',
          widgets: '个小部件',
          tools: '个工具',
          models: '个模型',
          options: '个选项'
        };
        const mapped = typeMap[type.toLowerCase().trim()];
        return mapped ? `查看另外 ${n} ${mapped}` : `查看另外 ${n} 个${type}`;
      }
    },
    {
      key: "See {count} more", pattern: /^See\s+(\d+)\s+more$/i,
      replace: (_, n) => `查看另外 ${n} 项`
    },
    {
      key: "Show {count} more", pattern: /^Show\s+(\d+)\s+more$/i,
      replace: (_, n) => `显示另外 ${n} 项`
    },
    {
      key: "Page {page} of {total}", pattern: /^Page\s+(\d+)\s+of\s+(\d+)$/i,
      replace: (_, p, total) => `第 ${p} 页，共 ${total} 页`
    },
    {
      key: "Showing {count} of {total}", pattern: /^Showing\s+(\d+)\s+of\s+(\d+)(?:\s+(.+))?$/i,
      replace: (_, a, b, rest) => {
        if (!rest) return `显示第 ${a} / ${b} 项`;
        const restLower = rest.toLowerCase().trim();
        if (restLower === 'results') return `显示第 ${a} / ${b} 个结果`;
        if (restLower === 'messages') return `显示第 ${a} / ${b} 条消息`;
        if (restLower === 'items') return `显示第 ${a} / ${b} 项`;
        return `显示第 ${a} / ${b} 项（${rest}）`;
      }
    },
    {
      key: "No more older messages, showing {count} of {total}", pattern: /^No more older messages,\s*showing\s+(\d+)\s+of\s+(\d+)$/i,
      replace: (_, a, b) => `没有更早的消息了，当前显示第 ${a} / ${b} 条`
    },

    // 3. 针对特定目标的动态操作 (如 More actions for Google Drive)
    {
      key: "More actions for {name}", pattern: /^More actions for\s+(.+)$/i,
      replace: (_, name) => `${name} 的更多操作`
    },

    // 4. 计数类动态标签 (tools / plugins / steps / comments / results)
    {
      key: "{count} tools enabled", pattern: /^(\d+)\s+tools?\s+enabled$/i,
      replace: (_, n) => `已启用 ${n} 个工具`
    },
    {
      key: "{count} plugins enabled", pattern: /^(\d+)\s+plugins?\s+enabled$/i,
      replace: (_, n) => `已启用 ${n} 个插件`
    },
    {
      key: "{count} skills enabled", pattern: /^(\d+)\s+skills?\s+enabled$/i,
      replace: (_, n) => `已启用 ${n} 个技能`
    },
    {
      key: "{count} rules enabled", pattern: /^(\d+)\s+rules?\s+enabled$/i,
      replace: (_, n) => `已启用 ${n} 条规则`
    },
    {
      key: "{count} hooks enabled", pattern: /^(\d+)\s+hooks?\s+enabled$/i,
      replace: (_, n) => `已启用 ${n} 个钩子`
    },
    {
      key: "({count} steps)", pattern: /^\((\d+)\s+steps?\)$/i,
      replace: (_, n) => `(${n} 步)`
    },
    {
      key: "({count} comments)", pattern: /^\((\d+)\s+comments?\)$/i,
      replace: (_, n) => `(${n} 条评论)`
    },
    {
      key: "{count} results", pattern: /^(\d+)\s+results?$/i,
      replace: (_, n) => `${n} 个结果`
    },
    {
      key: "{count} files", pattern: /^(\d+)\s+files?$/i,
      replace: (_, n) => `${n} 个文件`
    },
    {
      key: "{count} conversations", pattern: /^(\d+)\s+conversations?$/i,
      replace: (_, n) => `${n} 个对话`
    },
    {
      key: "{count} changes", pattern: /^(\d+)\s+changes?$/i,
      replace: (_, n) => `${n} 处更改`
    },
    {
      key: "{count} errors", pattern: /^(\d+)\s+errors?$/i,
      replace: (_, n) => `${n} 个错误`
    },
    {
      key: "{count} warnings", pattern: /^(\d+)\s+warnings?$/i,
      replace: (_, n) => `${n} 个警告`
    },
    {
      key: "{count} items", pattern: /^(\d+)\s+items?$/i,
      replace: (_, n) => `${n} 项`
    },
    {
      key: "{count} selected", pattern: /^(\d+)\s+selected$/i,
      replace: (_, n) => `已选择 ${n} 项`
    },
    {
      key: "Retry ({count})", pattern: /^Retry\s+\((\d+)\)$/i,
      replace: (_, n) => `重试 (${n})`
    },
    {
      key: "{count} files changed", pattern: /^(\d+)\s+files?\s+changed$/i,
      replace: (_, n) => `已更改 ${n} 个文件`
    },
    {
      key: "Select model, current: {model}", pattern: /^Select model,\s*current:\s*(.+)$/i,
      replace: (_, m) => `选择模型，当前：${m}`
    },

    // 5. 权限预设动态选择器 (如 Agent permissions preset selector, current: Turbo)
    {
      key: "Agent permissions preset selector, current: {preset}", pattern: /^Agent permissions preset selector,\s*current:\s*(.+)$/i,
      replace: (_, preset) => {
        const pMap = { Turbo: '极速模式 (Turbo)', Autonomous: '自主模式', Default: '默认模式' };
        return `智能体权限预设选择器，当前：${pMap[preset.trim()] || preset}`;
      }
    },

    // 6. 侧边栏相对时间徽章 (如 13m、5d、1mo、13m ago)
    {
      key: "{count}{timeUnit} ago", pattern: /^(\d+)\s*(s|m|h|d|w|mo|y)\s+ago$/i,
      replace: (_, n, u) => {
        const uMap = { s: '秒前', m: '分钟前', h: '小时前', d: '天前', w: '周前', mo: '个月前', y: '年前' };
        return `${n}${uMap[u.toLowerCase()] || u}`;
      }
    },
    {
      key: "Running {count} tasks", pattern: /^Running\s+(\d+)\s+tasks?$/i,
      replace: (_, n) => `正在运行 ${n} 个任务`
    },
    {
      key: "Completed {count} tasks", pattern: /^Completed\s+(\d+)\s+tasks?$/i,
      replace: (_, n) => `已完成 ${n} 个任务`
    },
    {
      key: "{count}{timeUnit}", pattern: /^(\d+)(s|m|h|d|w|mo|y)$/,
      replace: (_, n, u) => {
        const uMap = { s: '秒前', m: '分钟前', h: '小时前', d: '天前', w: '周前', mo: '个月前', y: '年前' };
        return `${n}${uMap[u] || u}`;
      }
    },

    // 7. 过滤项与全局安装路径
    {
      key: "Filter {category}: All", pattern: /^Filter\s+(.+):\s+All$/i,
      replace: (_, cat) => `筛选 ${entryFor(cat) || cat}：全部`
    },
    {
      key: "Global: Installed in {path}", pattern: /^Global:\s+Installed in\s+(.+)$/i,
      replace: (_, p) => `全局：已安装于 ${p}`
    },

    // 8. 模型配额与刷新限额动态提示 (如 You have used some of your weekly limit, it will fully refresh in 20 hours, 52 minutes.)
    {
      key: "You have used some of your {period} limit, it will fully refresh in {duration}.", pattern: /^You have (used some of|hit) your (weekly|5-hour|\w+) limit, it will fully refresh in (.+?)\.?$/i,
      replace: (_, action, period, time) => {
        const actZh = /hit/i.test(action) ? '已达到' : '已使用了部分';
        const pMap = { weekly: '每周', '5-hour': '5小时' };
        const pZh = pMap[period.toLowerCase()] || period;
        const timeZh = time
          .replace(/(\d+)\s*days?/gi, '$1天')
          .replace(/(\d+)\s*hours?/gi, '$1小时')
          .replace(/(\d+)\s*minutes?/gi, '$1分钟')
          .replace(/(\d+)\s*seconds?/gi, '$1秒')
          .replace(/,\s*/g, ' ')
          .trim();
        return `您${actZh}${pZh}限额，将在 ${timeZh} 后完全刷新。`;
      }
    },
    {
      key: "It will fully refresh in {duration}.", pattern: /^It will fully refresh in (.+?)\.?$/i,
      replace: (_, time) => {
        const timeZh = time
          .replace(/(\d+)\s*days?/gi, '$1天')
          .replace(/(\d+)\s*hours?/gi, '$1小时')
          .replace(/(\d+)\s*minutes?/gi, '$1分钟')
          .replace(/(\d+)\s*seconds?/gi, '$1秒')
          .replace(/,\s*/g, ' ')
          .trim();
        return `将在 ${timeZh} 后完全刷新。`;
      }
    },
    {
      key: "{provider} models", pattern: /^(Gemini|Claude and GPT)\s+models$/i,
      replace: (_, brand) => `${brand === 'Claude and GPT' ? 'Claude 与 GPT' : brand} 系列模型`
    },

    // 9. 界面复合前缀与截断片段 (消除拼接断裂感)
    {
      key: "{category} (", pattern: /^(Child Subagents|Generation Steps|Tools|Subagents|Workspaces|Plugins|Skills|Rules|Hooks|Mcp|Sessions)\s*\($/i,
      replace: (_, name) => {
        const nMap = {
          'child subagents': '子级智能体',
          'generation steps': '生成步骤',
          'tools': '工具',
          'subagents': '子智能体',
          'workspaces': '工作区',
          'plugins': '插件',
          'skills': '技能',
          'rules': '规则',
          'hooks': '钩子',
          'mcp': 'MCP',
          'sessions': '会话'
        };
        const zh = nMap[name.toLowerCase().trim()] || name;
        return `${zh} (`;
      }
    },
    // 10. 复合内联容器整句模板 (Inline-Group Contextual Translation)
    {
      key: "Are you sure you want to delete {0}?", pattern: /^Are you sure you want to delete\s+(?:the\s+)?\{(\d+)\}\??$/i,
      replace: (_, idx) => `您确定要删除 {${idx}} 吗？`
    },
    {
      key: "AI Credits are used when you've exceeded your model quota. Keep track of your current AI Credits in the {0}.", pattern: /^AI Credits are used when you've exceeded your model quota\. Keep track of your current AI Credits in the \{(\d+)\}\.?$/i,
      replace: (_, idx) => `AI 额度会在超出模型配额时使用。请在 {${idx}} 中查看您当前的 AI 额度。`
    },
    {
      key: "ABFS is required to create ABFS workspaces. Please visit {0}.", pattern: /^ABFS is required to create ABFS workspaces\.\s*Please visit \{(\d+)\}\.?$/i,
      replace: (_, idx) => `创建 ABFS 工作区需要 ABFS。请访问 {${idx}}。`
    },
    {
      key: "Please verify your account, then sign in again to continue. Learn more by visiting our {0}.", pattern: /^Please verify your account,\s*then sign in again to continue\.\s*Learn more by visiting our \{(\d+)\}\.?$/i,
      replace: (_, idx) => `请验证您的账号后重新登录以继续。访问我们的 {${idx}} 了解更多信息。`
    },
    {
      key: "For a full list of available locations and deployment endpoints, please refer to the {0}.", pattern: /^For a full list of available locations and deployment endpoints,\s*please refer to the \{(\d+)\}\.?$/i,
      replace: (_, idx) => `如需查看可用区域与部署端点的完整列表，请参阅{${idx}}。`
    },
    {
      key: "Remote Control isn't active on this instance. Enable it in {0}.", pattern: /^Remote Control isn't active on this instance\.\s*Enable it in \{(\d+)\}\.?$/i,
      replace: (_, idx) => `当前实例未启用远程控制，请在{${idx}}中开启。`
    },
    {
      key: "Need help? Reach out in the {0}.", pattern: /^Need help\?\s*Reach out in the \{(\d+)\}\.?$/i,
      replace: (_, idx) => `需要帮助？前往 {${idx}} 联系我们。`
    },
    {
      key: "Sharing is a preview feature. It exports this conversation's history to your {0}.", pattern: /^Sharing is a preview feature\.\s*It exports this conversation's history to your \{(\d+)\}\.?$/i,
      replace: (_, idx) => `共享为预览功能，会将当前对话历史导出至您的 {${idx}}。`
    },
    {
      key: "This will permanently delete {0}.", pattern: /^This will permanently delete \{(\d+)\}\.?$/i,
      replace: (_, idx) => `这将永久删除 {${idx}}。`
    },
    {
      key: "Your existing conversations in CitC are grouped under a {0}.", pattern: /^Your existing conversations in CitC are grouped under a \{(\d+)\}\.?$/i,
      replace: (_, idx) => `您在 CitC 中的现有对话已归组至 {${idx}} 下。`
    },
    {
      key: "This project was created for {0}.", pattern: /^This project was created for \{(\d+)\}\.?$/i,
      replace: (_, idx) => `此项目专为 {${idx}} 创建。`
    },
    {
      key: "You can opt-out temporarily using {0}.", pattern: /^You can opt-out temporarily using \{(\d+)\}\.?$/i,
      replace: (_, idx) => `您可以使用 {${idx}} 暂时停用此功能。`
    },
    {
      key: "cogfsd and cidermux are required to create Cog workspaces. Please visit {0}.", pattern: /^cogfsd and cidermux are required to create Cog workspaces\.\s*Please visit \{(\d+)\}\.?$/i,
      replace: (_, idx) => `创建 Cog 工作区需要 cogfsd 和 cidermux。请访问 {${idx}}。`
    },
    {
      key: "Validated with GitHub and stored in {0}.", pattern: /^Validated with GitHub and stored in \{(\d+)\}\.?$/i,
      replace: (_, idx) => `已通过 GitHub 验证并存储于 {${idx}}。`
    },
    {
      key: "View archived conversations in {0}.", pattern: /^View archived conversations in \{(\d+)\}\.?$/i,
      replace: (_, idx) => `请在 {${idx}} 中查看已归档对话。`
    },
    {
      key: "Please verify your account to continue using {0}.", pattern: /^Please verify your account to continue using \{(\d+)\}\.?$/i,
      replace: (_, idx) => `请验证您的账号以继续使用 {${idx}}。`
    },
    {
      key: "Are you sure you want to delete the", pattern: /^Are you sure you want to delete the\s*$/i,
      replace: () => '您确定要删除该'
    },
    {
      key: "Are you sure you want to delete {name}?", pattern: /^Are you sure you want to delete\s+(?:the\s+)?(.+?)\??$/i,
      replace: (_, target) => `您确定要删除 ${target} 吗？`
    },
    {
      key: "ABFS is required to create ABFS workspaces. Please visit", pattern: /^ABFS is required to create ABFS workspaces\.\s*Please visit\s*$/i,
      replace: () => '创建 ABFS 工作区需要 ABFS，请访问'
    }
  ];

  function matchTemplate(key) {
    for (const rule of TEMPLATE_RULES) {
      if (rule.pattern.test(key)) { lastMatchedKeys=[rule.key]; return key.replace(rule.pattern, rule.replace); }
    }
    return undefined;
  }

  function translation(original,el,kind) {
    lastMatchedKeys=[];
    const key = normalize(original);
    if (!key || /(?:https?:\/\/|^(?:\/|~\/|[A-Za-z]:\\))/.test(key)) return original;
    if (/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(key)) {
      const templated = matchTemplate(key);
      if (templated !== undefined) return original.match(/^\s*/)[0] + templated + original.match(/\s*$/)[0];
      return original;
    }
    if (isBrandName(key)) return original;
    let value = undefined;
    const scoped=el?scopeKey(key,kind||inferKind(el),scopeRoute(el)):null;
    const pluginScoped=el&&pluginDescription(el)?scopeKey(key,'description','/customizations'):null;
    const contextual=(scoped&&dictionary.entries[scoped])??(pluginScoped&&dictionary.entries[pluginScoped]);
    if(typeof contextual==='string'){lastMatchedKeys=[key];return original.match(/^\s*/)[0]+contextual+original.match(/\s*$/)[0];}
    if(conservative){value=entryFor(key);if(value!==undefined)lastMatchedKeys=[key];else value=matchTemplate(key);return value===undefined?original:original.match(/^\s*/)[0]+value+original.match(/\s*$/)[0];}

    // P1-2: 含数字的文案优先匹配模板，避免词典中的硬编码覆盖通用模板
    if (/\d/.test(key)) {
      value = matchTemplate(key);
    }
    if (value === undefined) { value = entryFor(key); if(value!==undefined)lastMatchedKeys=[key]; }
    if (value === undefined) value = matchTemplate(key);
    if (value === undefined) return original;
    const lead = original.match(/^\s*/)[0];
    const tail = original.match(/\s*$/)[0];
    return lead + value + tail;
  }
  function getValue(node, attr) { return attr ? node.getAttribute(attr) : node.nodeValue; }
  function setValue(node, attr, value) {
    /* Writing a value that is already there still produces a MutationObserver record for an
       observed attribute, which re-schedules this node indefinitely. */
    if (getValue(node, attr) === value) return;
    if (attr) node.setAttribute(attr, value); else node.nodeValue = value;
  }
  /* Single source of truth for "may this node/attribute currently hold a translation?". Having one
     predicate is what keeps translation and restoration in agreement: when they disagreed, a value
     flip-flopped between English and Chinese on every scan. */
  function translatable(node, attr, scan) {
    if (attr) return attributeAllowed(node, attr, scan);
    return eligible(node.parentElement, scan);
  }
  function updateValue(node, attr = '', scan = 0) {
    let slots = nodeSlots.get(node);
    const old = slots?.get(attr);
    const current = getValue(node, attr);
    const el = attr ? node : node.parentElement;
    if (current === null) {
      if (slots) { slots.delete(attr); if (!slots.size) activeNodes.delete(node); }
      if (el && el.nodeType === Node.ELEMENT_NODE && !slots?.size) delete el.dataset.agzhLoc;
      return;
    }
    if (!translatable(node, attr, scan)) {
      /* No longer allowed: put the original back (only if we are the ones who changed it), then
         drop the slot so a later re-entry starts from the real text instead of a stale value. */
      if (old && current === old.last) setValue(node, attr, old.original);
      if (slots) { slots.delete(attr); if (!slots.size) activeNodes.delete(node); }
      if (el && el.nodeType === Node.ELEMENT_NODE && !slots?.size) delete el.dataset.agzhLoc;
      return;
    }
    if (old?.group) {
      if (current !== old.last && current !== old.original) {
        invalidateInlineGroup(old.group);
        if (node.parentElement && tryTranslateInlineGroup(node.parentElement, scan)) return;
      } else return;
    }
    const retained = nodeSlots.get(node)?.get(attr);
    const original = retained && current === retained.last ? retained.original : current;
    lastMatchedKeys=[];
    const next = modelUiLabel(el) && normalize(original)==='New' ? (lastMatchedKeys=['New'],'新') : translation(original,el,attr==='placeholder'?'placeholder':inferKind(el));
    if (next !== original) {
      if (!slots) { slots = new Map(); nodeSlots.set(node, slots); }
      slots.set(attr, { original, last: next, matchedKeys:[...lastMatchedKeys], dictionaryVersion:dictionary.version });
      activeNodes.add(node);
    } else {
      if (slots) {
        slots.delete(attr);
        if (!slots.size) activeNodes.delete(node);
      }

    }
    const targetVal = languageMode === 'en' ? original : next;
    if (current !== targetVal) setValue(node, attr, targetVal);
    auditRecord(original,targetVal,el,attr ? 'attribute' : inferKind(el),nodeSlots.get(node)?.get(attr)?.matchedKeys??[]);

    if (el && el.nodeType === Node.ELEMENT_NODE) {
      if (languageMode === 'zh' && next !== original) {
        el.dataset.agzhLoc = '1';
      } else if (languageMode === 'en' || next === original) {
        delete el.dataset.agzhLoc;
      }
    }
  }
  /* `input` / `textarea` are PROTECTED so their typed value is never touched, but their
     translated metadata (placeholder / title / aria-label / data-tooltip) is not user content:
     the app renders Chinese UI labels there, so those attributes are handled before the block. */
  /* Decides whether a translatable attribute (placeholder / title / aria-label / data-tooltip) may
     be translated. The attribute must sit in the same UI context a text node would need, but form
     fields are walked through instead of blocking: they are PROTECTED for their typed value, which
     is never touched, whereas a standalone <input placeholder="Search"> is a real UI string.
     An input that lives inside a conversation row or a code block still has no UI context, so it
     correctly stays English. */
  function attributeAllowed(element, attribute, scan) {
    if(routeExcluded||restrictedAdaptiveRoute())return false;
    if (!TRANSLATABLE_ATTRS.includes(attribute)) return false;
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const original = nodeSlots.get(element)?.get(attribute)?.original ?? element.getAttribute(attribute) ?? '';
    const row = element.closest('[data-testid="conversation-row-sidebar"]');
    if (row && element.matches('button,[role="button"]') && ['More options','Pin conversation','Unpin conversation','Archive conversation','Unarchive conversation','Delete conversation'].includes(normalize(original))) {
      return ancestors(element).every(el=>!matches(el,PROTECTED)||el===row);
    }
    if (userNamed(element)) return false;
    const protectedParents = ancestors(element).filter(el => matches(el, PROTECTED));
    if (protectedParents.some(el => el !== element || !['INPUT', 'TEXTAREA'].includes(el.tagName))) return false;
    // These first-party controls have no UI ancestor. Keep the exception exact so arbitrary
    // form metadata outside known UI (including the unknown-area fixture) remains untouched.
    if (attribute==='placeholder' && element.matches('input') && normalize(original)==='Search customizations...') return true;
    if (attribute==='aria-label' && normalize(original)==='Customizations views') return true;
    return Boolean(element.closest(UI));
  }
  const INLINE_TAGS = new Set(['CODE', 'STRONG', 'EM', 'A', 'KBD', 'B', 'I', 'SPAN', 'MARK', 'SMALL']);

  function isInlineGroupContainer(el, scan = 0) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (!eligible(el, scan) || blocked(el, scan)) return false;
    const children = el.childNodes;
    if (children.length < 2 || children.length > 20) return false;
    let hasText = false;
    let hasInline = false;
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c.nodeType === Node.TEXT_NODE) {
        if (normalize(c.nodeValue || '')) hasText = true;
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        if (!INLINE_TAGS.has(c.tagName)) return false;
        if (c.querySelector('div, p, ul, ol, li, table, form, section, article')) return false;
        hasInline = true;
      } else {
        return false;
      }
    }
    return hasText && hasInline;
  }

  function invalidateInlineGroup(el) {
    const nodes = inlineGroups.get(el);
    inlineGroupContainers.delete(el);
    clearInlineGroupUnsupported(el);
    if (!nodes) return;
    inlineGroups.delete(el);
    for (const node of nodes) {
      const slots = nodeSlots.get(node);
      const slot = slots?.get('');
      if (slot?.group !== el) continue;
      if (getValue(node, '') === slot.last) setValue(node, '', slot.original);
      slots.delete('');
      if (!slots.size) activeNodes.delete(node);
    }
    delete el.dataset.agzhLoc;
  }

  /* J04 (conservative): the template is the element's direct children rendered as text runs plus
     {N} placeholders. Only a translation that can be laid out losslessly in place is applied:
     same placeholder multiset, identical placeholder order, and an existing text run for every
     non-empty translated segment. Reordered/missing/extra placeholders or a needed run without a
     DOM slot keep the COMPLETE English sentence (no partial translation, no plain-text fallback,
     links/buttons are never cleared and React-owned inline nodes are never moved); those groups are
     marked unsupported for review and are still collected as one whole-sentence key. */
  function groupTemplate(el) {
    const children = el.childNodes;
    let rawTemplate = '';
    const inlineElements = [];
    const slotsMap = new Map();
    let currentSlot = 0;
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c.nodeType === Node.TEXT_NODE) {
        const slot = nodeSlots.get(c)?.get('');
        const origText = (slot && slot.original !== undefined) ? slot.original : (c.nodeValue || '');
        rawTemplate += origText;
        if (!slotsMap.has(currentSlot)) slotsMap.set(currentSlot, []);
        slotsMap.get(currentSlot).push({ node: c, original: origText });
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        const idx = inlineElements.length;
        inlineElements.push(c);
        rawTemplate += `{${idx}}`;
        currentSlot = idx + 1;
      }
    }
    return { rawTemplate, inlineElements, slotsMap };
  }
  function groupDisplayedTemplate(el) {
    let raw = '';
    let index = 0;
    for (const c of el.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) raw += c.nodeValue || '';
      else if (c.nodeType === Node.ELEMENT_NODE) { raw += `{${index}}`; index++; }
    }
    return raw;
  }
  function placeholderTokens(text) { return text.match(/\{\d+\}/g) ?? []; }
  function samePlaceholderSet(left, right) {
    if (left.length !== right.length) return false;
    const a = left.map(token => token.replace(/\D/g, '')).sort().join(',');
    const b = right.map(token => token.replace(/\D/g, '')).sort().join(',');
    return a === b;
  }
  function writeGroupSlot(node, el, zhVal, original, groupKeys) {
    let slots = nodeSlots.get(node);
    if (!slots) { slots = new Map(); nodeSlots.set(node, slots); }
    const prevOriginal = slots.get('')?.original;
    const finalOriginal = prevOriginal !== undefined ? prevOriginal : original;
    slots.set('', { original: finalOriginal, last: zhVal, group: el, groupParent: node.parentElement, matchedKeys: groupKeys, dictionaryVersion: dictionary.version });
    activeNodes.add(node);
    const targetVal = languageMode === 'en' ? finalOriginal : zhVal;
    if (node.nodeValue !== targetVal) setValue(node, '', targetVal);
  }
  function applyGroupSegments(el, segments, slotsMap, inlineElements, groupKeys, norm, zh, queue = waiting) {
    clearInlineGroupUnsupported(el);
    inlineGroups.set(el, [...slotsMap.values()].flat().map(item => item.node));
    inlineGroupContainers.add(el);
    for (let s = 0; s <= inlineElements.length; s++) {
      const items = slotsMap.get(s) || [];
      const part = segments[s] !== undefined ? segments[s] : '';
      for (let k = 0; k < items.length; k++) writeGroupSlot(items[k].node, el, k === 0 ? part : '', items[k].original, groupKeys);
    }
    auditRecord(norm, zh, el, 'template', groupKeys);
    if (languageMode === 'zh') el.dataset.agzhLoc = '1';
    else delete el.dataset.agzhLoc;
    for (let i = inlineElements.length - 1; i >= 0; i--) queue.add(inlineElements[i]);
    return true;
  }
  function inlineGroupFor(node, scan) {
    const parent = node.parentElement;
    if (!parent) return null;
    if (INLINE_TAGS.has(parent.tagName)) {
      const outer = parent.parentElement;
      if (outer && isInlineGroupContainer(outer, scan)) return outer;
    }
    return isInlineGroupContainer(parent, scan) ? parent : null;
  }
  function markInlineGroupUnsupported(el, reason) {
    unsupportedInlineGroupReasons.set(el, reason || INLINE_LAYOUT_WARNING);
    unsupportedInlineGroupSet.add(el);
    return true; /* handled: keep the complete English sentence, do not translate descendants */
  }
  function clearInlineGroupUnsupported(el) {
    unsupportedInlineGroupReasons.delete(el);
    unsupportedInlineGroupSet.delete(el);
  }
  function tryTranslateInlineGroup(el, scan = 0, queue = waiting) {
    if(conservative&&!inSystemSettings(el,scan))return false;
    if (!isInlineGroupContainer(el, scan)) { clearInlineGroupUnsupported(el); return false; }
    const recorded = inlineGroups.get(el);
    if (recorded?.some(node => {
      const slot = nodeSlots.get(node)?.get('');
      return !slot || slot.group !== el || slot.groupParent !== node.parentElement || (getValue(node, '') !== slot.last && getValue(node, '') !== slot.original);
    })) invalidateInlineGroup(el);
    const { rawTemplate, inlineElements, slotsMap } = groupTemplate(el);
    if (!inlineElements.length) return false;
    const norm = normalize(rawTemplate);
    if (!norm) return false;
    const zh = translation(norm, el);
    const groupKeys = [...lastMatchedKeys];
    if (zh === norm || !/[\u3400-\u9fff]/.test(zh)) { clearInlineGroupUnsupported(el); return false; }
    const normPlaceholders = placeholderTokens(norm), zhPlaceholders = placeholderTokens(zh);
    /* Conservative J04 correction: never rearrange React-owned inline nodes and never move inline
       text into a plain-text run. Only a same-order translation whose non-empty runs all own an
       existing text slot is applied in place; everything else keeps the complete English sentence
       (no fragment half-translation, links/buttons untouched) and is marked unsupported/review. */
    if (!samePlaceholderSet(zhPlaceholders, normPlaceholders)) return markInlineGroupUnsupported(el);
    if (zhPlaceholders.join() !== normPlaceholders.join()) return markInlineGroupUnsupported(el);
    const segments = zh.split(/\{\d+\}/);
    if (segments.some((part, index) => part && (slotsMap.get(index)?.length ?? 0) === 0)) return markInlineGroupUnsupported(el);
    return applyGroupSegments(el, segments, slotsMap, inlineElements, groupKeys, norm, zh, queue);
  }

  function refreshInlineGroup(el, scan) {
    const translated = el.isConnected && tryTranslateInlineGroup(el, scan);
    const reason = unsupportedInlineGroupReasons.get(el);
    // Keep a valid old translation until the new runs can be committed in this same task.
    // Removed/unsafe translations still restore complete English and retain their review marker.
    if (!translated || reason) {
      invalidateInlineGroup(el);
      if (reason) markInlineGroupUnsupported(el, reason);
    }
  }

  function pushTree(node, scan = 0, queue = waiting) {
    if (!node?.isConnected) return;
    if (node.nodeType === Node.TEXT_NODE) { updateValue(node, '', scan); return; }
    if (![Node.ELEMENT_NODE, Node.DOCUMENT_NODE, Node.DOCUMENT_FRAGMENT_NODE].includes(node.nodeType)) return;
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (queue === settingsWaiting && node.style?.display === 'none') {
        waiting.add(node);
        return;
      }
      protectionTokens.set(node, protectionToken(node));
      for (const attr of TRANSLATABLE_ATTRS)
        if (node.hasAttribute(attr)) updateValue(node, attr, scan);
      const isConvoRow = matches(node, '[data-testid="conversation-row-sidebar"],[data-testid*="conversation-row"],a[href^="/c/"],a[href*="/c/"]');
      if (blocked(node, scan)) {
        if (isConvoRow) for (const badge of node.querySelectorAll('span,time')) if (isRelativeTimeBadge(badge)) queue.add(badge);
        if (isConvoRow) for (const control of node.querySelectorAll('button,[role="button"]')) queue.add(control);
        if (node.closest('[data-testid*="model"]')) for (const label of node.querySelectorAll('span,p,h1,h2,h3,h4,div')) if (modelUiLabel(label)) queue.add(label);
        return;
      }
      if (node.shadowRoot) { observe(node.shadowRoot); queue.add(node.shadowRoot); }
      if (tryTranslateInlineGroup(node, scan, queue)) return;
    }
    for (let i = node.childNodes.length - 1; i >= 0; i--) queue.add(node.childNodes[i]);
  }
  /* When a node stops being translatable (moved into protected content, or a protection-state
     fingerprint changed) the slot may be stale. The sweep is budgeted and incremental: a slice
     spends at most RECONCILE_BUDGET_MS, the remaining nodes stay queued for the next flush, and a
     fresh scan token per slice keeps the per-scan blocked/eligible caches useful. */
  const RECONCILE_BUDGET_MS = 4;
  let reconcileQueue = null;
  let reconcileChecks = 0;
  let reconcilePasses = 0;
  let lastPruneAt = 0;
  function reconcileRecords() {
    if (!reconcileQueue) { reconcilePasses++; reconcileQueue = { nodes: [...activeNodes], index: 0 }; }
    const queue = reconcileQueue;
    const scan = ++scanCount;
    const started = performance.now();
    while (queue.index < queue.nodes.length && performance.now() - started < RECONCILE_BUDGET_MS) {
      const node = queue.nodes[queue.index++];
      reconcileChecks++;
      if (!node.isConnected) { activeNodes.delete(node); continue; }
      const slots = nodeSlots.get(node);
      if (!slots?.size) { activeNodes.delete(node); continue; }
      for (const attr of [...slots.keys()]) if (!translatable(node, attr, scan)) updateValue(node, attr, scan);
    }
    if (queue.index >= queue.nodes.length) reconcileQueue = null;
    else if (timer === null) timer = setTimeout(flush, 0);
  }
  function pruneActiveNodes() {
    lastPruneAt = performance.now();
    for (const ref of ownedProjectMarkers) if (!ref.deref()) ownedProjectMarkers.delete(ref);
    for (const node of activeNodes) if (!node.isConnected) activeNodes.delete(node);
    for (const el of inlineGroupContainers) if (!el.isConnected) inlineGroupContainers.delete(el);
    for (const el of unsupportedInlineGroupSet) if (!el.isConnected) { unsupportedInlineGroupSet.delete(el); unsupportedInlineGroupReasons.delete(el); }
  }
  function cleanup() {
    let reset = false;
    for (const root of observed) if (root !== document && !root.host?.isConnected) { observed.delete(root); reset = true; }
    if (reset) { observer.disconnect(); for (const root of observed) observer.observe(root, observerOptions); }
  }
  function schedule(node) {
    if (!active) return;
    pending.add(node);
    if (timer === null && !scanning) timer = setTimeout(flush, 0);
  }
  function flush() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (!active) return;
    checkRoute();
    if (routeExcluded) { pending.clear(); waiting.clear(); settingsWaiting.clear(); requeueDocument = false; scanning = false; return; }
    scanning = true;
    const flushStarted = performance.now();
    const scan = ++scanCount;
    refreshProjectNames(scan);
    const settingsPane = systemSettingsPane();
    const settingsRoot = settingsPane ? settingsPaneCache?.root : null;
    for (const node of pending) {
      if (settingsPane?.contains(node) || (settingsRoot?.contains(node) && node !== settingsRoot)) settingsWaiting.add(node);
      else {
        waiting.add(node);
        if (settingsPane && node.contains?.(settingsPane)) {
          for (const element of settingsPaneCache.chrome) settingsWaiting.add(element);
          settingsWaiting.add(settingsPane);
        }
      }
    }
    pending.clear();
    let work = 0;
    /* Drain by insertion order with an explicit cursor: re-adding a node during the sweep used
       to be revisited in the same slice, which is how a single mutation could be re-expanded
       many times over. Nodes appended by this sweep are picked up by the next one. */
    // The validated settings content pane runs before background/sidebar work within the same
    // 8ms budget; hidden inactive settings tabs are deferred to `waiting` so visible settings paint in Chinese on frame 1.
    while ((settingsWaiting.size || waiting.size) && work < 5000 && performance.now() - flushStarted < 8) {
      const queue = settingsWaiting.size ? settingsWaiting : waiting;
      const node = queue.values().next().value;
      queue.delete(node);
      pushTree(node, scan, queue);
      work++;
    }
    scanning = false;
    if (waiting.size + settingsWaiting.size > QUEUE_LIMIT) {
      waiting.clear(); settingsWaiting.clear();
      requeueDocument = true;
      queueTrimmed = true;
      droppedBatches++;
    }
    if (waiting.size || settingsWaiting.size || pending.size || requeueDocument) {
      if (requeueDocument && !waiting.size && !settingsWaiting.size && !pending.size) { requeueDocument = false; schedule(document); }
      if (timer === null) timer = setTimeout(flush, 0);
    } else {
      requeueDocument = false;
      /* A reconcile pass writes nothing when every recorded node is already in its correct
         state, so it cannot re-arm itself; when it does write, the resulting mutations bring us
         back here once more and the second pass is a no-op. */
      if (reconcileQueue || reconcileRequested) { reconcileRequested = false; reconcileRecords(); }
      else {
        cleanup();
        if (performance.now() - lastPruneAt > 2000) pruneActiveNodes();
      }
      if(dictionaryToastPending){
        dictionaryToastPending=false;
        if(languageMode==='zh'&&document.visibilityState==='visible'&&performance.now()-dictionaryToastLastAt>2500){dictionaryToastLastAt=performance.now();showToast('GravityBox · 词典已同步更新',1000);}
      }
    }
    maxSliceMs = Math.max(maxSliceMs, performance.now() - flushStarted);
  }
  const observerOptions = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'data-tooltip', 'placeholder', 'class', 'role', 'contenteditable', 'data-testid', 'data-agzh-protect', 'data-agzh-user-content', 'data-agzh-user-name'] };
  function observe(root) { if (!observed.has(root)) { observed.add(root); observer.observe(root, observerOptions); } }
  /* Any mutation of class / role / contenteditable / data-agzh-protect can switch a node between
     "translatable" and "protected", so a reconcile pass is requested; the reconcile walks only the
     recorded nodes instead of re-scanning the changed node's whole subtree. */
  observer = new MutationObserver(mutations => {
    if (!scanning) checkRoute();
    let hasAdded = false;
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          pending.add(node);
          hasAdded = true;
        }
        if (mutation.removedNodes.length) reconcileRequested = true;
        if (inlineGroups.has(mutation.target)) refreshInlineGroup(mutation.target, ++scanCount);
        if (!projectSearchDirty && mutation.target.nodeType === Node.ELEMENT_NODE && (matches(mutation.target, '[data-testid="project-header"],[data-testid*="project-selector"]') || mutation.target.closest('[data-testid="project-header"],[data-testid*="project-selector"]'))) projectSearchDirty = true;
      } else if (mutation.type === 'characterData') {
        /* Ignore the engine's own text mutations to avoid self-feedback churn. */
        const slot = nodeSlots.get(mutation.target)?.get('');
        if (slot && getValue(mutation.target, '') === slot.last) continue;
        /* Text updates only need this node re-evaluated; reconcile is reserved for protection
           changes, so streamed tokens no longer trigger a recorded-node sweep. */
        pending.add(mutation.target);
      } else {
        /* Ignore the engine's own attribute mutations. */
        const attr = mutation.attributeName || '';
        const slot = nodeSlots.get(mutation.target)?.get(attr);
        if (slot && getValue(mutation.target, attr) === slot.last) continue;
        if (PROTECTION_ATTRS.includes(attr)) {
          if (!protectionChanged(mutation.target)) continue;
          reconcileRequested = true;
        }
        pending.add(mutation.target);
      }
    }
    // Mounts and React text updates in settings are handled before paint. The normal page queue
    // retains its existing incremental scheduling and every queue still obeys flush's budget.
    const settingsPane = systemSettingsPane();
    const settingsRoot = settingsPane ? settingsPaneCache?.root : null;
    const settingsChanged = (settingsRoot || settingsPane) && [...pending].some(node => (settingsRoot || settingsPane).contains(node));
    if ((hasAdded || settingsChanged || (pending.size > 0 && pending.size <= 32 && !reconcileRequested)) && !scanning) {
      flush();
    } else if ((pending.size || reconcileRequested) && timer === null && !scanning) {
      timer = setTimeout(flush, 0);
    }
  });
  const api = {
    refresh() {
      if (!active) return api.state();
      checkRoute();
      const pane = systemSettingsPane();
      if (pane) {
        pending.add(settingsPaneCache?.root || pane);
        if (!scanning) flush();
      } else {
        schedule(document);
      }
      return api.state();
    },
    update(next) {
      if (!active || !next || next.schema !== 1 || typeof next.version !== 'string' || !next.entries) throw new Error('Invalid dictionary');
      checkRoute();
      const changed = next.version !== dictionary.version;
      if (!changed) return api.refresh();
      rebuildIndex(next);
      dictionaryToastPending = true;
      const groups = [...inlineGroupContainers], nodes = [...activeNodes];
      let groupIndex = 0, nodeIndex = 0;
      const updateSlice = () => {
        if (!active) return;
        const started = performance.now();
        const scan = ++scanCount;
        while (groupIndex < groups.length && performance.now()-started < 4) refreshInlineGroup(groups[groupIndex++], scan);
        while (nodeIndex < nodes.length && performance.now()-started < 4) {
          const node = nodes[nodeIndex++];
          if (!node.isConnected) { activeNodes.delete(node); continue; }
          const slots = nodeSlots.get(node); if (!slots) { activeNodes.delete(node); continue; }
          for (const attr of [...slots.keys()]) updateValue(node,attr,scan);
        }
        maxSliceMs = Math.max(maxSliceMs,performance.now()-started);
        if(groupIndex<groups.length||nodeIndex<nodes.length)setTimeout(updateSlice,0);
        else {requeueDocument=true;schedule(document);}
      };
      updateSlice();
      requeueDocument = true;
      schedule(document);
      return api.state();
    },
    toggleLanguage(mode) {
      const next = mode || (languageMode === 'zh' ? 'en' : 'zh');
      languageMode = next;
      for (const node of activeNodes) {
        if (!node.isConnected) { activeNodes.delete(node); continue; }
        const slots = nodeSlots.get(node);
        if (!slots) continue;
        for (const [attr, slot] of slots) {
          const targetVal = languageMode === 'en' ? slot.original : slot.last;
          setValue(node, attr, targetVal);
          const el = attr ? node : node.parentElement;
          if (el && el.nodeType === Node.ELEMENT_NODE) {
            if (languageMode === 'en') delete el.dataset.agzhLoc;
            else el.dataset.agzhLoc = '1';
          }
        }
      }
      try{globalThis.__agzhLanguageChanged?.(languageMode);}catch{}
      return { mode: languageMode, activeNodes: activeNodes.size, groups: 0 };
    },
    getLanguageMode() { return languageMode; },
    setShortcutEnabled(enabled){shortcutEnabled=options.path==='/fixture'&&enabled===true;return{enabled:shortcutEnabled};},
    draftState(){
      const rendered=e=>!!e?.getClientRects().length&&getComputedStyle(e).visibility!=="hidden";
      const draft=[...document.querySelectorAll('input,textarea,[contenteditable]:not([contenteditable="false"])')].some(e=>rendered(e)&&!e.readOnly&&!e.disabled&&!['button','submit','reset','checkbox','radio','range','hidden','file'].includes(e.type)&&(e.value??e.textContent??'').trim());
      const attachments=[...document.querySelectorAll('input[type="file"]')].some(e=>e.files?.length>0)||[...document.querySelectorAll('[data-testid*="attachment"],[data-testid*="file-chip"]')].some(rendered);
      const unsaved=[...document.querySelectorAll('.tab.dirty,[data-dirty="true"],[role="tab"][aria-label*="unsaved" i]')].some(rendered);
      const generating=[...document.querySelectorAll('button,[role="button"]')].some(e=>rendered(e)&&/^(Stop generating|Stop|停止生成|停止)$/.test(e.getAttribute('aria-label')||e.textContent.trim()));
      return {busy:draft||attachments||unsaved||generating,draft,attachments,unsaved,generating};
    },
    maintenanceState(){const state=api.draftState();return{...state,busy:state.busy||[...document.querySelectorAll('[role="dialog"],[role="menu"]')].some(visibleUi)};},
    collectUntranslated() {
      if(languageMode==='en'||routeExcluded||restrictedAdaptiveRoute())return [];
      const collectStarted=performance.now();lastCollectionTruncated=false;
      const rows=new Map(),scan=++scanCount;refreshProjectNames(scan);
      const add=(raw,el,kind,attribute,template=false,layoutWarning)=>{
        if(template&&conservative&&!inSystemSettings(el,scan))return;
        if(conservative&&!attribute&&!template&&!isDialogPromptParagraph(el)&&!el?.closest('button,[role="button"],[role="tab"],[role="menuitem"],[role="tooltip"],label,h1,h2,h3,h4,[data-select-popup],[role="menu"],[role="listbox"],[role="option"]')&&!inSystemSettings(el,scan))return;
        const valid=template?isValidTemplateText(raw):isValidUiText(raw);
        if(rows.size>=500||!visibleUi(el)||userNamed(el)||(attribute ? !attributeAllowed(el,attribute,scan) : blocked(el,scan)||(!template&&!el.closest(UI_SELECTOR)&&!inSystemSettings(el,scan)&&!isDialogPromptParagraph(el)))||pluginDescription(el)||!valid)return;
        const key=normalize(raw),route=scopeRoute(el);
        if(isBrandName(key))return;
        /* An unsupported inline layout is still a candidate even when the dictionary holds an
           unusable translation: the user needs it listed to supply an in-order one. */
        if(!layoutWarning&&(entryFor(key)!==undefined||dictionary.entries[scopeKey(key,kind,route)]!==undefined))return;
        const warning=formatWarningFor(raw);
        rows.set(scopeKey(key,kind,route),{key,kind,route,source:'runtime-ui',
          ...(warning?{formatWarning:warning}:{}),
          ...(layoutWarning?{layoutWarning}:{})});
      };
      collectRoots: for(const root of observed){
        if(performance.now()-collectStarted>12){lastCollectionTruncated=true;break;}
        if(root!==document&&!root.host?.isConnected)continue;
        const walker=document.createTreeWalker(root===document?(document.body||document.documentElement):root,NodeFilter.SHOW_TEXT);
        let visited=0;const handledGroups=new Set();
        while(walker.nextNode()&&rows.size<500&&++visited<15000){
          if(performance.now()-collectStarted>12){lastCollectionTruncated=true;break collectRoots;}
          const n=walker.currentNode;
          /* J04: report one whole-sentence key for an inline group instead of its fragments. */
          const group=inlineGroupFor(n,scan);
          if(group){
            if(!handledGroups.has(group)){
              handledGroups.add(group);
              const displayed=groupDisplayedTemplate(group);
              const hasChinese=/[\u3400-\u9fff]/.test(displayed), hasEnglish=/[a-zA-Z]{2,}/.test(displayed);
              /* Fully translated groups are not candidates. A mixed group (some fragments already
                 translated individually by the dictionary) is offered as its whole English template
                 so one re-translation can replace the fragment mix. */
              const layoutWarning=unsupportedInlineGroupReasons.get(group);
              if(hasChinese&&hasEnglish)add(groupTemplate(group).rawTemplate,group,inferKind(group),undefined,true,layoutWarning);
              else if(!hasChinese)add(displayed,group,inferKind(group),undefined,true,layoutWarning);
            }
            continue;
          }
          add(n.textContent,n.parentElement,inferKind(n.parentElement));
        }
        for(const el of root.querySelectorAll('[title],[aria-label],[placeholder],[data-tooltip]')){
          if(performance.now()-collectStarted>12){lastCollectionTruncated=true;break collectRoots;}
          for(const attr of TRANSLATABLE_ATTRS)if(el.hasAttribute(attr)&&attributeAllowed(el,attr,scan))add(el.getAttribute(attr),el,attr==='placeholder'?'placeholder':inferKind(el),attr);
        }
      }maxSliceMs=Math.max(maxSliceMs,performance.now()-collectStarted);return [...rows.values()];
    },
    pluginCatalog(){return pluginCatalog();},
    ruleCatalog(){return TEMPLATE_RULES.map(r=>r.key);},
    capabilities(){return TEMPLATE_CAPABILITIES;},
    startAudit(knownKeys = []) {
      auditKeys = new Map([...knownKeys,...TEMPLATE_RULES.map(r=>r.key)].filter(k => typeof k === 'string').map(k => [normalize(k),k]));
      auditExpires = Date.now() + 15 * 60 * 1000; auditTrail.clear();
      return { expiresAt: new Date(auditExpires).toISOString() };
    },
    stopAudit() { auditKeys = null; auditTrail.clear();return { active:false }; },
    auditUi(knownKeys = []) {
      if(languageMode==='en'||routeExcluded)return{observations:[],unmatchedCount:0,protectedCount:0,languageMode:'en',intentionalEnglish:languageMode==='en',routeExcluded};
      // Only return catalogued UI strings. Unknown text is counted, never copied out of the page.
      const auditStarted=performance.now();
      const known = new Map([...knownKeys,...TEMPLATE_RULES.map(r=>r.key)].filter(k => typeof k === 'string').map(k => [normalize(k), k]));
      const observations = new Map(); let unmatchedCount = 0; let protectedCount = 0; let visited = 0; let truncated = false;
      const scan = ++scanCount;
      refreshProjectNames(scan);
      const record = (key, state, kind) => { if (observations.get(key)?.state !== 'untranslated') observations.set(key, { key, state, kind }); };
      auditRoots: for (const root of observed) {
        if (performance.now()-auditStarted>12) {truncated=true;break;}
        if (root !== document && !root.host?.isConnected) continue;
        const walker = document.createTreeWalker(root === document ? (document.body || document.documentElement) : root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (++visited > 50000 || performance.now()-auditStarted>12) { truncated = true; break auditRoots; }
          const node = walker.currentNode, el = node.parentElement;
          if (!el || !node.textContent?.trim()) continue;
          if (blocked(el, scan)) { protectedCount++; continue; }
          if (!eligible(el, scan) || !visibleUi(el)) continue;
          const slot = nodeSlots.get(node)?.get('');
          const original = normalize(slot?.original ?? node.textContent), current = normalize(node.textContent);
          const matches=slot?.dictionaryVersion===dictionary.version?slot.matchedKeys??[]:[];
          if(matches.length){
            const groupOk=!slot.group||inlineGroups.get(slot.group)?.every(n=>n.nodeValue===nodeSlots.get(n)?.get('')?.last);
            for(const match of matches)if(known.has(normalize(match)))record(known.get(normalize(match)),languageMode==='zh'&&current===normalize(slot.last)&&groupOk?'verified':'untranslated',slot.group?'template':inferKind(el));
            continue;
          }
          const key = known.get(original);
          if (key) record(key, current !== original && /[\u3400-\u9fff]/.test(current) ? 'verified' : 'untranslated', inferKind(el));
          else if (/^Resets in (?:<1m|\d+[dhms](?:\s+\d+[dhms])*)$/.test(original)) record('Resets in {duration}', current !== original ? 'verified' : 'untranslated', 'template');
          else if (isValidUiText(current)) unmatchedCount++;
        }
        for (const el of root.querySelectorAll('[title],[aria-label],[placeholder],[data-tooltip]')) {
          if (++visited > 50000 || performance.now()-auditStarted>12) { truncated = true; break auditRoots; }
          if (!visibleUi(el)) continue;
          for (const attr of TRANSLATABLE_ATTRS) {
            if (!el.hasAttribute(attr) || !attributeAllowed(el,attr,scan)) continue;
            const current = normalize(el.getAttribute(attr));
            const attributeSlot=nodeSlots.get(el)?.get(attr);
            const original = normalize(attributeSlot?.original ?? current), key = known.get(original);
            if(attributeSlot?.dictionaryVersion===dictionary.version&&attributeSlot.matchedKeys?.length){for(const match of attributeSlot.matchedKeys)if(known.has(normalize(match)))record(known.get(normalize(match)),languageMode==='zh'&&current===normalize(attributeSlot.last)?'verified':'untranslated','attribute');continue;}
            if (key) record(key,current !== original && /[\u3400-\u9fff]/.test(current) ? 'verified' : 'untranslated','attribute');
          }
        }
        if (truncated) break;
      }
      const recent=[...auditTrail.values()];auditTrail.clear();
      maxSliceMs=Math.max(maxSliceMs,performance.now()-auditStarted);
      return { observations: [...observations.values()], recent, unmatchedCount, protectedCount, truncated, auditActive: !!auditKeys && Date.now() < auditExpires };
    },
    state() {
      return {
        active, version: dictionary.version, translatedNodes: activeNodes.size,
        groups: 0,
        observedRoots: observed.size, pending: waiting.size + settingsWaiting.size + pending.size,
        scanCount, maxSliceMs, lastCollectionTruncated, languageMode,routeExcluded,runtimeId:options.runtimeId,
        reconcileChecks, reconcilePasses, reconcilePending: reconcileQueue ? reconcileQueue.nodes.length - reconcileQueue.index : 0,
        capabilities: TEMPLATE_CAPABILITIES,
        unsupportedGroups: unsupportedInlineGroupSet.size,
        skippedRestores, queueTrimmed, droppedBatches
      };
    },
    dispose() {
      auditKeys = null; auditTrail.clear();
      active = false; observer.disconnect(); clearTimeout(timer); timer = null; reconcileQueue = null;
      if (routeTimer) { clearInterval(routeTimer); routeTimer = null; }
      try { window.removeEventListener('popstate', checkRoute); window.removeEventListener('hashchange', checkRoute); } catch {}
      pending.clear(); waiting.clear(); settingsWaiting.clear();
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', handleKeydown, true);
      }
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      const toast = document.getElementById('__agzh_toast__');
      if (toast) toast.remove();

      const style = document.getElementById('__agzh_micro_patch__');
      if (style) style.remove();
      let restored = 0; let skipped = 0;
      for (const node of activeNodes) {
        if (node.isConnected) {
          const slots = nodeSlots.get(node);
          if (slots) for (const [attr, slot] of slots) {
            if (getValue(node, attr) === slot.last) { setValue(node, attr, slot.original); restored++; } else skipped++;
            const el = attr ? node : node.parentElement;
            if (el && el.nodeType === Node.ELEMENT_NODE) delete el.dataset.agzhLoc;
          }
        }
      }
      skippedRestores = skipped;
      for (const ref of ownedProjectMarkers) ref.deref()?.classList.remove('agzh-project-name'); ownedProjectMarkers.clear();
      if (globalThis.__AGZH_BOOT__ === options) delete globalThis.__AGZH_BOOT__;
      activeNodes.clear(); observed.clear(); inlineGroupContainers.clear(); unsupportedInlineGroupSet.clear(); delete globalThis[KEY];
      return { restored, skipped, active: false };
    }
  };

  let toastTimer = null;
  function showToast(message, duration=1200) {
    try {
      if (typeof document === 'undefined') return;
      let toast = document.getElementById('__agzh_toast__');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = '__agzh_toast__';
        toast.setAttribute('data-agzh-protect', 'true');
        Object.assign(toast.style, {
          position: 'fixed',
          top: '16px',
          right: '16px',
          zIndex: '2147483647',
          pointerEvents: 'none',
          padding: '8px 16px',
          borderRadius: '20px',
          fontSize: '12px',
          fontWeight: '500',
          lineHeight: '1.4',
          fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
          color: '#ffffff',
          background: 'rgba(30, 30, 35, 0.78)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(255, 255, 255, 0.18)',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.36)',
          transition: 'opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1), transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
          transform: 'translateY(-4px)',
          opacity: '0',
        });
        (document.body || document.documentElement).appendChild(toast);
      }
      const reduceMotion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      toast.style.transition=reduceMotion?'none':'opacity 0.25s ease, transform 0.25s ease';
      toast.textContent = message;
      requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
      });
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-4px)';
        toastTimer = setTimeout(() => {
          if (toast && toast.parentNode) toast.remove();
          toastTimer = null;
        }, 300);
      }, duration);
    } catch {}
  }

  function handleKeydown(event) {
    const target = event.composedPath?.()[0];
    const focused = target?.nodeType === Node.ELEMENT_NODE ? target : document.activeElement;
    if (!shortcutEnabled || event.repeat || event.defaultPrevented || routeExcluded || focused?.closest?.('input,textarea,[contenteditable]:not([contenteditable="false"]),.monaco-editor,.xterm,[role="textbox"],[role="combobox"]')) return;
    if (event.metaKey && event.altKey && (event.code === 'KeyL' || event.key === 'l' || event.key === 'L')) {
      event.preventDefault();
      event.stopPropagation();
      const res = api.toggleLanguage();
      const msg = res.mode === 'zh'
        ? 'GravityBox · 已切换为简体中文 (⌥⌘L)'
        : 'GravityBox · Switched to English (⌥⌘L)';
      showToast(msg);
    }
  }

  if (typeof window !== 'undefined' && options.path === '/fixture') {
    window.addEventListener('keydown', handleKeydown, true);
  }

  globalThis[KEY] = api;
  globalThis.__AGZH_ATTACH_DEEP_SCAN__?.();
  try {
    window.addEventListener('popstate', checkRoute);
    window.addEventListener('hashchange', checkRoute);
    /* pushState() fires no event of its own; a light poll plus the flush/observer checks above catch
       in-app navigation even when the router swaps the URL before it renders the new view. */
    routeTimer = setInterval(checkRoute, 500);
  } catch {}
  observe(document); schedule(document);
})();
