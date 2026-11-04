import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();

test('N01 · P1: 菜单栏主图标移除状态圆点 statusDot，保持纯净原生 Template 图标', async () => {
  const assistantSrc = await readFile(join(root, 'native/Assistant.swift'), 'utf8');

  // 1. 确认没有向 item.button 添加 statusDot 子视图
  assert.doesNotMatch(assistantSrc, /b\.addSubview\(statusDot\)/, 'item.button 不得添加 statusDot 子视图');
  assert.doesNotMatch(assistantSrc, /statusDot\.frame\s*=/, '不得在状态栏按钮设置 statusDot frame');

  // 2. 确认没有在 updateViews 中更新 statusDot.color
  assert.doesNotMatch(assistantSrc, /statusDot\.color\s*=/, 'updateViews 不得更新 statusDot.color');
  assert.doesNotMatch(assistantSrc, /var statusDotKey/, '不得维护 statusDotKey 缓存变量');

  // 3. 确认侧边栏状态栏保留（不要误伤侧边栏）
  assert.doesNotMatch(assistantSrc, /sidebarStatus|SidebarStatusView/, '侧边栏运行状态框已移除');
});

test('N02 · P1: 状态栏菜单升级为现代纵向卡片结构，切换账号内聚至卡片头部，移除用量统计…', async () => {
  const assistantSrc = await readFile(join(root, 'native/Assistant.swift'), 'utf8');
  const cardSrc = await readFile(join(root, 'native/MenuStatusCard.swift'), 'utf8');

  // 1. 确认顶层条目包含指定的纵向卡片与核心功能
  assert.match(assistantSrc, /let quotaView = MenuQuotaView\(target:\s*self/i, '第 1 类：现代纵向状态卡片');
  assert.doesNotMatch(assistantSrc, /add\(menu,\s*"用量统计…",\s*#selector\(showUsage\)/, '移除“用量统计…”菜单项');
  assert.match(assistantSrc, /add\(menu,\s*"界面汉化",\s*#selector\(toggleTranslation\)\)/, '界面汉化开关');
  assert.match(assistantSrc, /add\(menu,\s*"打开 \\\(targetApplication\.label\)",\s*#selector\(openAntigravity\)\)/, '打开 Antigravity');
  assert.match(assistantSrc, /add\(menu,\s*"打开 GravityBox",\s*#selector\(showPanel\)/, '打开 GravityBox');
  assert.match(assistantSrc, /add\(menu,\s*"退出 GravityBox",\s*#selector\(quit\)/, '退出 GravityBox');

  // 2. 确认切换账号已内聚到卡片头部账号身份选择器
  assert.match(cardSrc, /MenuAccountSwitcher/, '卡片头部承载账号身份切换器');
  assert.match(assistantSrc, /func popUpAccountSwitchMenu/, '支持从卡片头部弹出切换账号菜单');

  // 3. 确认通过统一 QuotaPresentation 契约呈现额度，杜绝 0% 伪造
  assert.match(assistantSrc, /QuotaPresentation\.menuQuotaText\(active \?\? \[:\]\)/, '配额采用统一 QuotaPresentation 契约呈现');
});
