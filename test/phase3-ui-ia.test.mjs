import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('A14: 导航模块语义清晰，快捷键与设置偏好入口闭环', async () => {
  const assistantSrc = await readFile(join(root, 'native/Assistant.swift'), 'utf8');

  // 1. 导航结构完备性
  assert.match(assistantSrc, /let names = \["总览", "账号", "用量", "设置"\]/, '侧边栏收敛为清晰的 4 大核心功能导航');

  // 2. 偏好设置入口 (Cmd+,) 闭环
  assert.match(assistantSrc, /add\(app, "设置…", #selector\(showSettings\), ","\)/, '应用菜单必须提供 Cmd+, 设置入口');
  assert.match(assistantSrc, /func showSettings\(\) \{ selectPage\(3\) \}/, '设置入口统一进入第四页（索引 3）');
});

test('A15: QuotaBarView 优化倒计时语义颜色与呼吸感高度，杜绝普通倒计时滥用橙色', async () => {
  const compSrc = await readFile(join(root, 'native/Components.swift'), 'utf8');

  // 1. 验证高度满足舒适呼吸感约束（U04: >= 38pt / 新规范 >= 64pt）
  assert.match(compSrc, /heightAnchor\.constraint\(greaterThanOrEqualToConstant:\s*52\)/, 'QuotaBarView 高度必须具备充足呼吸感');

  // 2. 验证倒计时语义化上色逻辑
  assert.match(compSrc, /let isUrgent = text\.contains\("即将重置"\) \|\| text\.contains\("已过"\)/, '紧急倒计时判断条件');
  assert.match(compSrc, /guard isUrgent else \{\s*return (Design\.secondary|\.secondaryLabelColor)\s*\}/, '普通倒计时必须使用低干扰的次要色（Design.secondary 或 secondaryLabelColor）');
});

test('A16: 用量 KPI 卡片严格等高约束，账号卡片顶栏分层清晰实现呼吸感布局', async () => {
  const usageSrc = await readFile(join(root, 'native/Usage.swift'), 'utf8');
  const accountsSrc = await readFile(join(root, 'native/Accounts.swift'), 'utf8');

  // Approved preview uses one trend hero and a balanced two-column summary.
  assert.match(usageSrc, /costCard\.heightAnchor\.constraint\(equalTo: requestCard\.heightAnchor\)/);
  assert.match(usageSrc, /trendHeader, trendChart/);
  assert.match(usageSrc, /modelsBreakdownStack\], spacing: 16/);
  assert.doesNotMatch(usageSrc, /documentView = table/);

  // 2. 账号卡片顶栏身份与邮箱分层 (U04)
  assert.match(accountsSrc, /let nameAndEmail = vertical\(\[titleRow, subRow\], spacing: 3\)/, '身份与邮箱两行分层，杜绝拥挤截断');
  assert.match(accountsSrc, /identityHeader\(identity: nameAndEmail, actions: actionStack\)/, '账号操作固定右对齐，身份填满剩余空间');
});
