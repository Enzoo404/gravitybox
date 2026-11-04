import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

test('阶段4验证 - B23: 总览统计卡支持键盘导航 (Tab/Return/Space) 并声明 Button 角色', async () => {
  const content = await readFile(join(root, 'native/Design.swift'), 'utf8');
  assert.ok(content.includes('class MetricCardBox: NSBox'), '必须定义 MetricCardBox 专用容器');
  assert.ok(content.includes('acceptsFirstResponder'), 'MetricCardBox 必须允许接收第一响应者 (Tab 键聚焦)');
  assert.ok(content.includes('event.keyCode == 36 || event.keyCode == 49'), '必须支持 Return/Space 触发激活');
  assert.ok(content.includes('card.setAccessibilityRole(.button)'), '必须向辅助功能暴露 .button 角色');
  assert.ok(content.includes('drawFocusRingMask'), '必须绘制系统原生外置焦点环');
});

test('阶段4验证 - U09: 关于面板 Build 与 Revision 规范化排重', async () => {
  const content = await readFile(join(root, 'native/Assistant.swift'), 'utf8');
  assert.ok(content.includes('buildStr.lowercased().hasPrefix("build ")'), '必须排重自带的 build 前缀');
  assert.ok(content.includes('buildStr != rev'), '必须检测 buildStr 与 rev 相同的情况');
});

test('阶段4验证 - U02: Argon 未知配额统一展示为「未取得」而非资格判断', async () => {
  const pagesContent = await readFile(join(root, 'native/Pages.swift'), 'utf8');
  const accountsContent = await readFile(join(root, 'native/Accounts.swift'), 'utf8');
  // B03/B04：未知数据不能写成「不可用/仅 Ultra/Pro 可用」（会被误读为无资格）。
  const presentation = await readFile(join(root, 'native/QuotaPresentation.swift'), 'utf8');
  assert.ok(pagesContent.includes('QuotaPresentation.contract(acc)'));
  assert.ok(accountsContent.includes('QuotaPresentation.contract(item)'));
  assert.ok(presentation.includes('default: return "配额未知"'));
  assert.ok(presentation.includes('default: return "Gemini 4 Argon · 配额未知"'), '未知不映射为权限拒绝');
  assert.ok(presentation.includes('case "disabled": return "不可用"'));
  assert.ok(!pagesContent.includes('仅 Ultra/Pro 可用'), '总览页不得再用资格判断文案');
  assert.ok(!accountsContent.includes('仅 Ultra/Pro 可用'), '账号页不得再用资格判断文案');
});
