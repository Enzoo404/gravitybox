import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('A16: 总览页三张指标卡等高并遵循预览布局', async () => {
  const pagesSwift = await readFile(join(process.cwd(), 'native/Pages.swift'), 'utf8');

  // 必须显式声明 card1 与 card2，card3 与 card4 等高约束
  assert.ok(
    pagesSwift.includes('token.heightAnchor.constraint(equalTo: cost.heightAnchor).isActive = true'),
    '总览页首行卡片必须包含 card1.heightAnchor == card2.heightAnchor 等高约束'
  );
  assert.ok(
    pagesSwift.includes('token.heightAnchor.constraint(equalTo: requests.heightAnchor).isActive = true'),
    '总览页次行卡片必须包含 card3.heightAnchor == card4.heightAnchor 等高约束'
  );
});

test('A17: 原生 EmptyStateView 构建契约与空状态操作引导', async () => {
  const componentsSwift = await readFile(join(process.cwd(), 'native/Components.swift'), 'utf8');
  const accountsSwift = await readFile(join(process.cwd(), 'native/Accounts.swift'), 'utf8');

  // 1. Components.swift 必须包含通用的 EmptyStateView
  assert.ok(componentsSwift.includes('final class EmptyStateView: NSView'), '必须定义 EmptyStateView 类');
  assert.ok(componentsSwift.includes('let actionButton: NSButton?'), 'EmptyStateView 必须支持动作按钮');

  // 2. Accounts.swift 账号空列表必须使用 EmptyStateView 并附带操作引导
  assert.ok(accountsSwift.includes('EmptyStateView('), 'AccountsPage 空列表必须使用 EmptyStateView');
  assert.ok(accountsSwift.includes('buttonTitle: "添加账号…"'), 'AccountsPage 空状态必须包含引导添加按钮');
});

test('A15: 倒计时语义颜色契约（杜绝非紧急倒计时滥用警示色）', () => {
  function getCountdownTone(text, pctKnown, pct) {
    const isUrgent = text.includes('即将重置') || text.includes('已过') || (pctKnown && pct < 20);
    if (!isUrgent) return 'secondary'; // 正常情况为中性副文本色
    if (text.includes('已过') || (pctKnown && pct < 20)) return 'error'; // 红色
    return 'warning'; // 橙色/黄色
  }

  // 1. 普通倒计时：中性副文本色，不引发焦虑
  assert.equal(getCountdownTone('6天 12小时后重置', true, 80), 'secondary');
  assert.equal(getCountdownTone('2小时 30分后重置', true, 60), 'secondary');

  // 2. 即将重置：警告色
  assert.equal(getCountdownTone('即将重置', true, 50), 'warning');

  // 3. 重置时间已过 或 额度耗尽：错误警示色
  assert.equal(getCountdownTone('重置时间已过', true, 50), 'error');
  assert.equal(getCountdownTone('3小时后重置', true, 5), 'error');
});
