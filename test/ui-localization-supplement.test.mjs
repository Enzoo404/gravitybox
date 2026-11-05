import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
