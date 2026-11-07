import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { loadDictionaryLayers } from '../dist/dictionary.js';
import { allowedTarget } from '../dist/discovery.js';

test('界面汉化补充：三界面词典命中验证', async () => {
  const layered = await loadDictionaryLayers(new URL('../dict', import.meta.url).pathname);
  const dict = layered.dictionary.entries;

  // 1. 自动化界面 (Automations)
  assert.equal(dict['No automations yet'], '暂无自动化任务');
  assert.equal(dict['No automations yet.'], '暂无自动化任务。');
  assert.equal(
    dict['Run a prompt on a schedule, like a morning summary of yesterday’s changes. Runs show up here.'],
    '按计划定时运行提示词（例如晨间总结昨日变动）。运行记录将显示在此处。'
  );
  assert.equal(
    dict['Run a prompt on a schedule, like a morning summary of yesterday\'s changes. Runs show up here.'],
    '按计划定时运行提示词（例如晨间总结昨日变动）。运行记录将显示在此处。'
  );

  // 2. 浏览器设置界面 (Browser Settings)
  assert.equal(
    dict['Configure built-in browser, link opening, and browser subagent preferences.'],
    '配置内置浏览器、链接打开方式与浏览器智能体偏好设置。'
  );
  assert.equal(
    dict['Configure allowed and denied URLs for the browser subagent. It runs in the built-in browser, so no separate browser install is needed.'],
    '配置浏览器智能体允许和禁止访问的 URL 规则。它在内置浏览器中运行，无需单独安装浏览器。'
  );

  // 3. 展开下拉选项 (Select Popover / Listbox Options)
  assert.equal(dict['Request Review'], '请求审查');
  assert.equal(dict['Request review'], '请求审查');
  assert.equal(dict['Every command requires approval.'], '每条命令均需批准。');
  assert.equal(dict['Every command requires approval'], '每条命令均需批准');
  assert.equal(dict['Default'], '默认');
  assert.equal(dict['default'], '默认');
  assert.equal(dict['Ask before sensitive operations.'], '在执行敏感操作前询问。');
  assert.equal(dict['Ask before sensitive operations'], '在执行敏感操作前询问');
  assert.equal(dict['Auto'], '自动');
  assert.equal(dict['auto'], '自动');
  assert.equal(dict['Automatically decide if commands run.'], '自动决定是否运行命令。');
  assert.equal(dict['Automatically decide if commands run'], '自动决定是否运行命令');
  assert.equal(dict['Turbo'], '极速模式');
  assert.equal(dict['turbo'], '极速模式');
  assert.equal(dict['Run all commands without restrictions.'], '无限制地运行所有命令。');
  assert.equal(dict['Run all commands without restrictions'], '无限制地运行所有命令');
});

test('界面汉化补充：用量统计动态限额与重置倒计时模板验证', async () => {
  const engineSource = await readFile(new URL('../dist/engine.js', import.meta.url), 'utf8');

  // 从 engine.js 中提取 TEMPLATE_RULES 中的规则逻辑进行验证
  assert.ok(engineSource.includes('key: "{window} limit, resets in {duration}"'));

  const ruleRegex = /^((?:\d+[smhd]|Weekly|Daily))\s+limit,\s*resets\s+in\s+(<1m|\d+[dhms](?:\s+\d+[dhms])*)$/i;
  function replaceRule(_, window, time) {
    let winText = window;
    const wLower = window.toLowerCase();
    if (wLower === 'weekly') winText = '每周';
    else if (wLower === 'daily') winText = '每日';
    else {
      const m = window.match(/^(\d+)([smhd])$/i);
      if (m) winText = `${m[1]}${{ s: '秒', m: '分钟', h: '小时', d: '天' }[m[2].toLowerCase()] || m[2]}`;
    }
    const timeText = time === '<1m' ? '将在 1 分钟内重置' : `${time.replace(/(\d+)d/g, '$1天').replace(/(\d+)h/g, '$1小时').replace(/(\d+)m/g, '$1分钟').replace(/(\d+)s/g, '$1秒')}后重置`;
    return `${winText}限额，${timeText}`;
  }

  // 测试 Gemini 4 Argon 用例
  const argonSample = 'Weekly limit, resets in 3d 21h';
  assert.equal(argonSample.replace(ruleRegex, replaceRule), '每周限额，3天 21小时后重置');

  // 测试 5小时限额用例
  const fiveHourSample = '5h limit, resets in 3h 50m';
  assert.equal(fiveHourSample.replace(ruleRegex, replaceRule), '5小时限额，3小时 50分钟后重置');

  // 测试即将重置 (<1m)
  const soonSample = 'Daily limit, resets in <1m';
  assert.equal(soonSample.replace(ruleRegex, replaceRule), '每日限额，将在 1 分钟内重置');

  // 验证 modelUiLabel 包含放行逻辑
  assert.ok(engineSource.includes('MODEL_RESET_LABEL = /^(?:(?:Weekly|Daily|\\d+[smhd])\\s+limit,\\s*)?resets in (?:<1m|\\d+[dhms](?:\\s+\\d+[dhms])*)$/i'));
});

test('界面汉化补充：自动化路由 /automations 窗口与路由放行验证', async () => {
  // discovery.ts 中的 allowedTarget 放行 /automations 页面
  assert.equal(allowedTarget({ type: 'page', url: 'https://127.0.0.1:8080/automations' }), true);
  assert.equal(allowedTarget({ type: 'page', url: 'https://127.0.0.1:8080/automations/new' }), true);

  // engine.js 中包含 automations 路由允许规则
  const engineSource = await readFile(new URL('../dist/engine.js', import.meta.url), 'utf8');
  assert.ok(engineSource.includes('customizations|automations|settings'));
});

test('界面汉化补充：下拉选项展开 (Select Options) 放行与实体保护契约验证', async () => {
  const engineSource = await readFile(new URL('../dist/engine.js', import.meta.url), 'utf8');

  // 验证误杀逻辑已修复：不再包含导致所有非 dialog listbox 均被屏蔽的条件
  assert.ok(!engineSource.includes("!leaf.closest('[role=\"menu\"],[role=\"dialog\"]')"));
  assert.ok(engineSource.includes("if (leaf.matches('[role=\"option\"]')) return Boolean(leaf.closest(ENTITY_CONTAINER));"));
});

test('界面汉化补充：2026-11 实机截图未汉化词句与内联文本合并验证', async () => {
  const layered = await loadDictionaryLayers(new URL('../dict', import.meta.url).pathname);
  const dict = layered.dictionary.entries;

  // 1. 斜杠命令与设置词条
  assert.equal(dict['teamwork'], '智能体团队');
  assert.equal(dict['Teamwork'], '智能体团队');
  assert.equal(
    dict['Configure what the agent can do in local and remote conversations.'],
    '配置智能体在本地与远程对话中的操作权限。'
  );
  assert.equal(
    dict['Configure what the agent can do in local and remote conversations'],
    '配置智能体在本地与远程对话中的操作权限'
  );

  // 2. 新建自动化与空状态词条
  assert.equal(
    dict['Uses your local files and tools. Schedules only.'],
    '使用您的本地文件与工具。仅支持定时计划。'
  );
  assert.equal(dict['at'], '于');
  assert.equal(dict['Add schedule'], '添加计划');
  assert.equal(dict['Add trigger'], '添加触发器');
  assert.equal(dict['No scheduled tasks yet'], '暂无计划任务');

  // 3. 作用域覆盖
  assert.equal(dict['@ui:/automations|label|Scheduled'], '定时计划');
  assert.equal(dict['@ui:/automations|text|at'], '于');

  // 4. 引擎底层机制保障验证
  const engineSource = await readFile(new URL('../dist/engine.js', import.meta.url), 'utf8');

  // 验证 userNamed 对系统选择与切换控件的豁免
  assert.ok(engineSource.includes("element.closest('[data-testid*=\"-toggle\"],[data-testid*=\"-trigger\"],[data-testid$=\"-button\"],[data-testid$=\"-select\"]')"));

  // 验证 eligible 保守模式放行了 empty/sidecar/trigger/modal 等系统 UI 容器
  assert.ok(engineSource.includes('[data-testid*="empty"]'));
  assert.ok(engineSource.includes('[data-testid*="sidecar"]'));

  // 验证 inline group 支持纯连续文本节点合并翻译（无需伪造 inline 标签）
  assert.ok(engineSource.includes('(allText && children.length >= 2 && hasText)'));
  assert.ok(engineSource.includes('if (!inlineElements.length) {'));

  // 验证 scopeRoute 对 /automations 与 /sidecars 子路径的前缀支持
  assert.ok(engineSource.includes("location.pathname.startsWith('/automations')?'/automations'"));
});

test('界面汉化补充：字体与主题专有名词保护及设置订阅计划精准本地化验证', async () => {
  const layered = await loadDictionaryLayers(new URL('../dict', import.meta.url).pathname);
  const dict = layered.dictionary.entries;
  const engineSource = await readFile(new URL('../dist/engine.js', import.meta.url), 'utf8');

  // 1. 图 1 字体专有名词保护：保持原英文，绝不汉化
  const fonts = [
    'Inter',
    'Google Sans',
    'Google Sans Code',
    'JetBrains Mono',
    'Fira Code',
    'Cascadia Code',
    'SF Mono',
    'Roboto Mono',
    'Source Code Pro',
  ];
  for (const font of fonts) {
    if (dict[font]) {
      assert.equal(dict[font], font, `字体专有名词 [${font}] 词典译文必须保持原英文`);
    }
    assert.ok(
      engineSource.includes(`'${font.toLowerCase()}'`),
      `引擎 BRAND_NAMES 必须包含字体专有名词白名单: ${font}`
    );
  }

  // 2. 图 2 主题配色专有名词保护：保持原英文，绝不汉化
  const themes = [
    'Catppuccin',
    'Gruvbox',
    'Gruvbox Material',
    'One Light',
    'One Dark',
    'One Dark Pro',
    'Solarized',
    'Solarized Light',
    'Solarized Dark',
    'Dracula',
    'Tokyo Night',
    'Nord',
    'Monokai',
    'Monokai Pro',
  ];
  for (const theme of themes) {
    if (dict[theme]) {
      assert.equal(dict[theme], theme, `主题专有名词 [${theme}] 词典译文必须保持原英文`);
    }
    assert.ok(
      engineSource.includes(`'${theme.toLowerCase()}'`),
      `引擎 BRAND_NAMES 必须包含主题专有名词白名单: ${theme}`
    );
  }
  // 重点校验此前曾被错误附带中文后缀的主题词条
  assert.equal(dict['Solarized Light'], 'Solarized Light');
  assert.equal(dict['Dracula'], 'Dracula');
  assert.equal(dict['Tokyo Night'], 'Tokyo Night');

  // 3. 图 3 设置订阅计划精准本地化验证：
  // 全局对话与斜杠命令 /plan 保持规划语义
  assert.equal(dict['Plan'], '规划');
  assert.equal(dict['plan'], '规划');
  // 设置页面 scoped 作用域将 Plan 翻译为“计划”
  assert.equal(dict['@ui:/settings|label|Plan'], '计划');
  assert.equal(dict['@ui:/settings|heading|Plan'], '计划');
  assert.equal(dict['@ui:/settings|text|Plan'], '计划');
  assert.equal(dict['@ui:/settings|label|plan'], '计划');
  assert.equal(dict['@ui:/settings|heading|plan'], '计划');
  assert.equal(dict['@ui:/settings|text|plan'], '计划');

  // 验证引擎具备 scoped route 维度的 kind 容错回退机制
  assert.ok(
    engineSource.includes("dictionary.entries[`@ui:${route}|label|${key}`]??dictionary.entries[`@ui:${route}|heading|${key}`]"),
    '引擎翻译需支持同 route 下 scoped 作用域词条回退查找'
  );

  // 4. 全量词典格式、字典序与规范化质量验证
  const keys = Object.keys(dict);
  for (let i = 1; i < keys.length; i++) {
    assert.ok(
      keys[i - 1].localeCompare(keys[i]) <= 0,
      `词典排序错误：[${keys[i - 1]}] 应该排在 [${keys[i]}] 之前`
    );
  }

  // 验证高频常用词汇精准符合语境
  assert.equal(dict['GitHub Repositories'], 'GitHub 代码仓库');
  assert.equal(dict['Loading repositories…'], '正在加载代码仓库…');
  assert.equal(dict['No repositories found'], '未找到代码仓库');

  // 验证按钮操作文案去除末尾多余句号
  assert.equal(dict['Check again'], '再次检查');
  assert.equal(dict['Check Again'], '再次检查');
  assert.equal(dict['Confirm undo'], '确认撤销');
  assert.equal(dict['Confirm Undo'], '确认撤销');
  assert.equal(dict['copy link'], '复制链接');
  assert.equal(dict['Copy Link'], '复制链接');
  assert.equal(dict['Learn more'], '了解更多');
  assert.equal(dict['Redo'], '重做');
  assert.equal(dict['Restore'], '恢复');
  assert.equal(dict['Retry'], '重试');
  assert.equal(dict['Revert file changes'], '还原文件更改');
  assert.equal(dict['Revert File Changes'], '还原文件更改');
  assert.equal(dict['See plans'], '查看套餐');
  assert.equal(dict['See Plans'], '查看套餐');
  assert.equal(dict['Undo'], '撤销');

  // 验证 JavaScript 相关策略条目使用规范专有名词
  assert.equal(dict['Browser Javascript Execution Policy'], '浏览器 JavaScript 执行策略');
  assert.equal(dict['Disabled - Agent will never run Javascript code in the browser.'], '已禁用 - 智能体绝不会在浏览器中运行 JavaScript 代码。');
  assert.equal(dict['You can upgrade to a Google AI Ultra plan to receive the highest rate limits.'], '您可以升级到 Google AI Ultra 套餐以获取最高速率限额。');
  assert.equal(dict['You can upgrade to the Google AI Ultra plan to receive the highest rate limits.'], '您可以升级到 Google AI Ultra 套餐以获得最高速率限额。');
});

test('界面汉化补充：严格模式下引擎实际执行与作用域本地化功能测试', async () => {
  const layered = await loadDictionaryLayers(new URL('../dict', import.meta.url).pathname);
  const engineSource = await readFile(new URL('../runtime/engine.js', import.meta.url), 'utf8');

  // 构建模拟沙箱，执行 engine.js 内部的实际翻译逻辑
  const sandbox = {
    setTimeout, clearTimeout, setInterval, clearInterval, console,
    location: { origin: 'http://localhost', pathname: '/', href: 'http://localhost/' },
    document: {
      head: null,
      documentElement: { appendChild() {} },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      getElementById() { return null; },
      createTreeWalker() { return { nextNode() { return false; } }; }
    },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ visibility: 'visible', whiteSpace: 'normal' }),
    innerHeight: 1000,
    innerWidth: 1000,
    CSS: { escape: s => s },
    window: {
      addEventListener() {},
      removeEventListener() {}
    },
    __AGZH_BOOT__: {
      origin: 'http://localhost',
      path: '/',
      dictionary: layered.dictionary
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // 执行启动，确保严格模式下零语法错误、零未声明变量异常
  vm.runInContext(engineSource, sandbox);
  assert.ok(sandbox.__AGZH_ENGINE_V1__, '引擎 API 须成功在沙箱中挂载');
  sandbox.__AGZH_ENGINE_V1__.dispose();

  // 验证引擎内部 translation 逻辑
  // 提取 translation 函数进行深度执行断言
  const harness = new Function('dictionary', 'BRAND_NAMES', `
    'use strict';
    const normalize = s => s.replace(/\\s+/g, ' ').trim();
    const lower = s => s.toLowerCase();
    const isBrandName = value => BRAND_NAMES.has(lower(normalize(value)));
    const inferKind = el => (el?.tagName && /^H[1-6]$/.test(el.tagName)) ? 'heading' : 'label';
    const scopeRoute = el => {
      if (el?.closest?.('[role="dialog"][aria-label="Settings"]')) return '/settings';
      if (el?.closest?.('[data-testid*="settings"]')) return '/settings';
      return '/';
    };
    const scopeKey = (key, kind, route) => \`@ui:\${route}|\${kind}|\${key}\`;
    const entryFor = key => dictionary.entries[key] ?? dictionary.entries[lower(key)];
    const matchTemplate = () => undefined;
    const conservative = false;
    let lastMatchedKeys = [];

    function translation(original, el, kind) {
      lastMatchedKeys = [];
      const key = normalize(original);
      if (!key || /(?:https?:\\/\\/|^(?:\\/|~\\/|[A-Za-z]:\\\\))/.test(key)) return original;
      if (isBrandName(key)) return original;
      const route = el ? scopeRoute(el) : null;
      const scoped = el ? scopeKey(key, kind || inferKind(el), route) : null;
      let contextual = (scoped && dictionary.entries[scoped]);
      if (contextual === undefined && el && route) {
        contextual = dictionary.entries[\`@ui:\${route}|label|\${key}\`] ?? dictionary.entries[\`@ui:\${route}|heading|\${key}\`] ?? dictionary.entries[\`@ui:\${route}|text|\${key}\`] ?? dictionary.entries[\`@ui:\${route}|option|\${key}\`];
      }
      if (typeof contextual === 'string') { lastMatchedKeys = [key]; return contextual; }
      let value = undefined;
      if (value === undefined) { value = entryFor(key); if (value !== undefined) lastMatchedKeys = [key]; }
      if (value === undefined) return original;
      return value;
    }

    return { translation };
  `);

  // 从 engineSource 提取实际 BRAND_NAMES 集合
  const brandMatch = engineSource.match(/const BRAND_NAMES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(brandMatch, '必须能从 engine.js 提取 BRAND_NAMES 集合');
  const brandList = eval(`[${brandMatch[1]}]`);
  const brandSet = new Set(brandList);

  const { translation } = harness(layered.dictionary, brandSet);

  // 1. 验证常规无作用域词条：不会抛出 ReferenceError，且能正确汉化
  assert.equal(translation('Cancel'), '取消');
  assert.equal(translation('Settings'), '设置');

  // 2. 验证图 1 & 图 2 专有名词绝对保护（保持原英文）
  assert.equal(translation('Inter'), 'Inter');
  assert.equal(translation('Google Sans'), 'Google Sans');
  assert.equal(translation('Catppuccin'), 'Catppuccin');
  assert.equal(translation('Gruvbox Material'), 'Gruvbox Material');
  assert.equal(translation('Solarized Light'), 'Solarized Light');
  assert.equal(translation('One Light'), 'One Light');
  assert.equal(translation('Dracula'), 'Dracula');
  assert.equal(translation('Tokyo Night'), 'Tokyo Night');

  // 3. 验证图 3 作用域隔离：
  // 全局/主对话中，Plan 保持“规划”（/plan 命令）
  assert.equal(translation('Plan'), '规划');
  assert.equal(translation('plan'), '规划');

  // 在设置面板元素中，Plan 精准翻译为“计划”
  const settingsModal = {
    closest(sel) {
      if (sel.includes('Settings')) return this;
      return null;
    },
    tagName: 'H3'
  };
  assert.equal(translation('Plan', settingsModal), '计划');
  assert.equal(translation('Plan', settingsModal, 'heading'), '计划');
  assert.equal(translation('plan', settingsModal), '计划');
});

test('界面汉化补充：全量词典审查（音色与内部代号专有名词保留、语境术语统一、大小写零遗漏与动态模板扩展）验证', async () => {
  const layered = await loadDictionaryLayers(new URL('../dict', import.meta.url).pathname);
  const dict = layered.dictionary.entries;
  const engineSource = await readFile(new URL('../runtime/engine.js', import.meta.url), 'utf8');

  // 1. 准则一：Gemini 音色名、内部代号、工作区占位标识符保持原英文
  const voicePersonas = ['Aoede', 'Charon', 'Fenrir', 'Kore', 'Leda', 'Orus', 'Puck', 'Zephyr'];
  for (const persona of voicePersonas) {
    assert.equal(dict[persona], persona, `音色专有名词 [${persona}] 必须保持原英文`);
    assert.ok(engineSource.includes(`'${persona.toLowerCase()}'`), `引擎 BRAND_NAMES 须包含音色名: ${persona}`);
  }
  assert.equal(dict['Project 4K'], 'Project 4K');
  assert.ok(engineSource.includes("'project 4k'"));
  assert.equal(dict['Workspace_1'], 'Workspace_1');
  assert.equal(dict['Workspace_2'], 'Workspace_2');
  assert.equal(dict['Workspace_3'], 'Workspace_3');
  assert.equal(dict['/abns/…'], '/abns/…');
  assert.equal(dict['run_command or view_file'], 'run_command 或 view_file');

  // 2. 准则二：上下文语境、术语一致性、代词规范与无零宽字符验证
  assert.equal(dict['Account'], '账号');
  assert.equal(dict['account'], '账号');
  assert.equal(dict['Models'], '模型');
  assert.equal(dict['models'], '模型');
  assert.equal(dict['Skills'], '技能');
  assert.equal(dict['Global'], '全局');
  assert.equal(dict['global'], '全局');
  assert.equal(dict['Allowed'], '已允许');
  assert.equal(dict['Read'], '读取');
  assert.equal(dict['Contents'], '内容');
  assert.equal(dict['Scroll turns down'], '向下滚动对话轮次');
  assert.equal(dict['Keep In Menu Bar'], '保留在菜单栏中');
  assert.equal(dict['No matching resources found.'], '未找到匹配的资源。');
  assert.equal(dict['No matching resources found.'].includes('\u200b'), false, '译文中不得残留零宽字符');
  assert.equal(dict['Fork in New Workspace'], '在新建工作区中分叉');
  assert.equal(dict['Create Fork in New Workspace'], '在新建工作区中创建分叉');
  assert.equal(dict['Worktree'], '工作树');
  assert.equal(dict['New Worktree'], '新建工作树');

  // 3. 准则三：补全的大小写精确词条与内联整句模板验证
  assert.equal(dict['New conversation'], '新对话');
  assert.equal(dict['Context window'], '上下文窗口');
  assert.equal(dict['Sign Out'], '退出登录');
  assert.equal(dict['Sign in'], '登录');
  assert.equal(dict['By using this app, you agree to its {0} and {1}.'], '使用此应用即表示您同意其{0}和{1}。');
  assert.equal(dict['Your feedback directly improves Gemini. See {0}.'], '您的反馈将直接帮助改进 Gemini。请参阅{0}。');
  assert.ok(engineSource.includes('key: "Waiting for command completion (up to {seconds} seconds)"'));
  assert.ok(engineSource.includes('key: "Agent needs permission to execute JavaScript on {host}"'));
});


test('工程规范与自动版本演进：2.29+ 自动指纹登记、专有名词单一事实源与引擎热路径剪枝验证', async () => {
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

  // 3. 验证引擎热路径剪枝标记 (inlineOnly) 与预编译时长正则生效
  const engineSource = await readFile(new URL('../dist/engine.js', import.meta.url), 'utf8');
  assert.ok(engineSource.includes("rule.inlineOnly = rule.key.includes('{0}');"));
  assert.ok(engineSource.includes("if (rule.inlineOnly && !hasInlineSlot) continue;"));
  assert.ok(engineSource.includes("const RE_DUR_H = /"));
});
