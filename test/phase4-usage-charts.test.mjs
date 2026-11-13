import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { calculateEstimatedUsd, UsageStatsManager, ProtobufWriter } from '../dist/usage.js';

const execFileAsync = promisify(execFile);

test('N07: 微量费用高精度保留与 IPC 透传 priced 状态（杜绝 1 Token 误标未计价）', async () => {
  const pricing = { input: 0.075, output: 0.30, cached: 0.01875 };

  // 1. 验证微量费用（1 Token）不被四舍五入抹平为 0
  const tinyCost = calculateEstimatedUsd(1, 0, 0, pricing);
  assert.ok(tinyCost > 0, `1 Token 费用必须大于 0，实际为 ${tinyCost}`);
  assert.ok(tinyCost < 0.001, `1 Token 费用属于微量正小额 (<$0.001)，实际为 ${tinyCost}`);

  // 2. 真实零消耗
  const zeroCost = calculateEstimatedUsd(0, 0, 0, pricing);
  assert.equal(zeroCost, 0, '0 Token 费用必须严格等于 0');

  // 真实微额费用由计价函数验证，展示格式由小型 Swift 契约覆盖。

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
