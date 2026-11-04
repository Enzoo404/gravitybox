import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../dist/tasks.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('N12: 总览页数据时效闭环（修订契约、停留时效刷新、数据时间与失败降级）', async () => {
  const mainSrc = await readFile(join(root, 'src/main.ts'), 'utf8');
  const pagesSrc = await readFile(join(root, 'native/Pages.swift'), 'utf8');
  const compSrc = await readFile(join(root, 'native/Components.swift'), 'utf8');

  // 1. main.ts 必须在 status 与 dashboard_summary 中返回 accountsRevision 和时间戳
  assert.match(mainSrc, /accountsRevision/, 'main.ts status 接口必须包含 accountsRevision');
  assert.match(mainSrc, /generatedAt:\s*new Date\(\)\.toISOString\(\)/, 'dashboard_summary 必须返回生成时间戳 generatedAt');

  // 2. Components.swift LiveStatus 契约中必须包含 accountsRevision
  assert.match(compSrc, /var accountsRevision/, 'LiveStatus 必须声明 accountsRevision 字段');

  // 3. Pages.swift metricsKey 必须包含 accountsRevision 等全量动态指纹
  assert.match(
    pagesSrc,
    /currentKey\s*=\s*"\\\(status\.taskRevision\)_\\\(status\.working\)_\\\(status\.enabled\)_\\\(status\.mode\)_\\\(app\.activeAccountId\)_\\\(status\.accountsRevision\)_\\\(status\.activeAccountEmail\)_\\\(status\.activeFiveHourQuota \?\? -1\)_\\\(status\.liveAccountEmail\)"/,
    'metricsKey 必须将账号修订指纹与运行身份纳入更新检测'
  );

  // 4. Pages.swift 必须具备停留时效（timeExpired）刷新机制
  assert.match(pagesSrc, /let timeExpired\s*=\s*interval\s*>=\s*15\.0/, '总览页必须具备停留超过 15 秒自动拉取更新的机制');

  // 5. Pages.swift 必须呈现数据时间，且在拉取失败时保留旧数据并明确标记历史快照
  assert.match(pagesSrc, /dataTimestampLabel\.toolTip\s*=\s*"数据时间：/, '总览页必须明确展示数据时间');
  assert.match(pagesSrc, /数据未更新/, '数据获取失败时必须保留旧快照并清楚提示');
});
