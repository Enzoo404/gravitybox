import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('N05: 各核心页面文本、标题与网格约束彻底消除抗压缩撑宽隐患', async () => {
  const componentsSrc = await readFile(join(root, 'native/Components.swift'), 'utf8');
  const accountsSrc = await readFile(join(root, 'native/Accounts.swift'), 'utf8');
  const pagesSrc = await readFile(join(root, 'native/Pages.swift'), 'utf8');
  const usageSrc = await readFile(join(root, 'native/Usage.swift'), 'utf8');

  // 1. 通用换行文本抗压缩与 pageHeader 标题抗压缩约束
  assert.match(componentsSrc, /label\.maximumNumberOfLines\s*=\s*0[\s\S]*?label\.setContentCompressionResistancePriority\(\.defaultLow,\s*for:\s*\.horizontal\)/, '通用换行 label 必须设置水平抗压缩为 defaultLow');
  assert.match(componentsSrc, /titleLabel\.setContentCompressionResistancePriority\(\.required,\s*for:\s*\.horizontal\)/, 'pageHeader 标题必须设置水平抗压缩为 required');

  // 2. 账号页顶栏身份与邮箱分层，彻底移除可见模型快照模块
  assert.match(accountsSrc, /let nameAndEmail = vertical\(\[titleRow, subRow\], spacing: 3\)/, '身份与邮箱两行分层，杜绝拥挤截断');
  assert.doesNotMatch(accountsSrc, /root\.addArrangedSubview\(modelsSection\)/, '模型快照模块彻底从账号页可见层级移除');

  // 3. 总览页与用量页
  assert.match(pagesSrc, /activeAccountLabel\.setContentCompressionResistancePriority\(\.defaultLow,\s*for:\s*\.horizontal\)/, '总览页账号名具备水平低抗压缩与截断');
  assert.match(usageSrc, /ModelUsageRow\(name: name/, '模型明细使用真实指标卡片');
  assert.doesNotMatch(usageSrc, /modelScroll/, '不挂载空白表格');
});
