import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { calculateEstimatedUsd, UsageStatsManager, ProtobufWriter } from '../dist/usage.js';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('N07: 微量费用高精度保留与 IPC 透传 priced 状态（杜绝 1 Token 误标未计价）', async () => {
  const pricing = { input: 0.075, output: 0.30, cached: 0.01875 };

  // 1. 验证微量费用（1 Token）不被四舍五入抹平为 0
  const tinyCost = calculateEstimatedUsd(1, 0, 0, pricing);
  assert.ok(tinyCost > 0, `1 Token 费用必须大于 0，实际为 ${tinyCost}`);
  assert.ok(tinyCost < 0.001, `1 Token 费用属于微量正小额 (<$0.001)，实际为 ${tinyCost}`);

  // 2. 真实零消耗
  const zeroCost = calculateEstimatedUsd(0, 0, 0, pricing);
  assert.equal(zeroCost, 0, '0 Token 费用必须严格等于 0');

  // 3. 源码契约验证：main.ts 必须在 byModel 中透传 priced 状态
  const mainSrc = await readFile(join(root, 'src/main.ts'), 'utf8');
  assert.match(mainSrc, /priced:\s*m\.priced\s*===\s*true/, 'main.ts 必须在 byModel 中明确透传 priced 状态');

  // 4. Swift 源码契约验证：微量费用展示 <$0.001，未计价展示「未计价」
  const usageSrc = await readFile(join(root, 'native/Usage.swift'), 'utf8');
  assert.match(usageSrc, /if\s*mUsd\s*>\s*0\s*&&\s*mUsd\s*<\s*0\.001\s*\{\s*usdStr\s*=\s*"<\$0\.001"/, 'Swift 明细必须将微量正金额展示为 <$0.001');
  assert.match(usageSrc, /usdStr\s*=\s*mTokens\s*>\s*0\s*\?\s*"未计价"\s*:\s*"\$0\.00"/, 'Swift 明细中未计价模型必须明确展示为 未计价');
});

test('N08: 趋势日期采用本地时区、连续 30 天自然日补齐并与 KPI 严格对账', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-p4-usage-'));
  const geminiDir = join(sandbox, 'gemini');
  const convDir = join(geminiDir, 'antigravity', 'conversations');
  const dbPath = join(convDir, 'session1.db');

  try {
    await execFileAsync('/bin/mkdir', ['-p', convDir]);
    await execFileAsync('/usr/bin/sqlite3', [
      dbPath,
      `CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);
       CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);`,
    ]);

    const now = new Date();
    const todaySec = Math.floor(now.getTime() / 1000);

    // 构造测试事件：包含今日、3天前、8天前
    function buildEventBlob(tokens, timestampSec, model = 'gemini-3.8-flash') {
      const innerTiming = ProtobufWriter.encodeField(1, 0, ProtobufWriter.encodeVarint(timestampSec));
      const timingBuf = ProtobufWriter.encodeField(4, 2, innerTiming);
      const usage = Buffer.concat([
        ProtobufWriter.encodeField(2, 0, ProtobufWriter.encodeVarint(tokens)),
        ProtobufWriter.encodeField(3, 0, ProtobufWriter.encodeVarint(0)),
      ]);
      const wrapped = Buffer.concat([
        ProtobufWriter.encodeField(4, 2, usage),
        ProtobufWriter.encodeString(19, model),
        ProtobufWriter.encodeField(9, 2, timingBuf),
      ]);
      return ProtobufWriter.encodeField(1, 2, wrapped);
    }

    const blob1 = buildEventBlob(500, todaySec); // 今日
    const blob2 = buildEventBlob(300, todaySec - 3 * 86400); // 3 天前
    const blob3 = buildEventBlob(200, todaySec - 8 * 86400); // 8 天前

    await execFileAsync('/usr/bin/sqlite3', [
      dbPath,
      `INSERT INTO gen_metadata (idx, data) VALUES 
       (1, x'${blob1.toString('hex')}'), 
       (2, x'${blob2.toString('hex')}'),
       (3, x'${blob3.toString('hex')}');`,
    ]);

    const uMgr = new UsageStatsManager({ stateDir: sandbox, geminiDir });
    const summary = await uMgr.getUsageSummary(true);

    // 1. 验证 daily_trends 严格补齐 30 天连续自然日（零消耗日不断档）
    assert.equal(summary.daily_trends.length, 30, '近 30 天每日趋势必须完整补齐 30 天');
    for (let i = 1; i < summary.daily_trends.length; i++) {
      const prev = new Date(summary.daily_trends[i - 1].date);
      const curr = new Date(summary.daily_trends[i].date);
      const diffDays = Math.round((curr - prev) / (1000 * 86400));
      assert.equal(diffDays, 1, `日期序列必须连续无断档: ${summary.daily_trends[i - 1].date} -> ${summary.daily_trends[i].date}`);
    }

    // 2. 验证 today_hourly 包含今日产生消耗的小时，且其总和与 KPI 严格对账
    assert.ok(summary.today_hourly.length > 0, '今日每小时趋势应包含今日发生消耗的小时');

    // 3. 验证柱形总和与对应 KPI 严格对账
    const hourlyTokensSum = summary.today_hourly.reduce((acc, h) => acc + h.total_tokens, 0);
    assert.equal(hourlyTokensSum, summary.today.totals.total_tokens, '今日 24 小时柱状图之和必须与今日 totals KPI 100% 对账');

    const last7DaysSlice = summary.daily_trends.slice(-7);
    const last7DaysTokensSum = last7DaysSlice.reduce((acc, d) => acc + d.total_tokens, 0);
    assert.equal(last7DaysTokensSum, summary.last_7_days.totals.total_tokens, '近 7 天每日趋势柱状图之和必须与 7天 totals KPI 100% 对账');

    const last30DaysTokensSum = summary.daily_trends.reduce((acc, d) => acc + d.total_tokens, 0);
    assert.equal(last30DaysTokensSum, summary.last_30_days.totals.total_tokens, '近 30 天每日趋势柱状图之和必须与 30天 totals KPI 100% 对账');
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('N09: 环图与图例归一化，超出项合并为「其他」，角度、图例与中心金额完全一致', async () => {
  const usageSrc = await readFile(join(root, 'native/Usage.swift'), 'utf8');

  // 1. 验证按费用降序排序与 Top 4 + 其他合并
  assert.match(usageSrc, /let pricedModels = modelRows\.filter[\s\S]*?\.sorted\s*\{/, '必须筛选有费用的模型并按金额降序排序');
  assert.match(usageSrc, /topSlices\.append\(\(name: "其他模型[\s\S]*?usd: otherUsd/, '超出前 4 项的模型必须合并为「其他模型」');

  // 2. 验证环图与图例共用同一归一化总额
  assert.match(usageSrc, /let totalPricedUsd\s*=\s*pricedModels\.reduce\(0\.0\)/, '计算全部已计价模型的真实总额');
  assert.match(usageSrc, /let effectiveTotalUsd\s*=\s*max\(totalUsd,\s*totalPricedUsd\)/, '统一归一化基准');
  assert.match(usageSrc, /let pct\s*=\s*effectiveTotalUsd\s*>\s*0\s*\?\s*Int\(round\(\(slice\.usd\s*\/\s*effectiveTotalUsd\)\s*\*\s*100\)\)\s*:\s*0/, '图例百分比严格使用已对齐的归一化总额');

  // 3. 验证 ModelDonutChartView 中心微量费用展示
  const compSrc = await readFile(join(root, 'native/Components.swift'), 'utf8');
  assert.match(compSrc, /if\s*totalUsd\s*>\s*0\s*&&\s*totalUsd\s*<\s*0\.001\s*\{\s*usdText\s*=\s*"<\$0\.001"/, '环图中心金额在微小正金额时展示 <$0.001');
});
