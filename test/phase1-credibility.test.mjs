import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  AccountsManager,
  formatResetCountdown,
} from '../dist/accounts.js';
import { UsageStatsManager, ProtobufWriter } from '../dist/usage.js';

const execFileAsync = promisify(execFile);

test('A01: formatResetCountdown 与过期时效判定 (杜绝过期时间误报即将重置)', async () => {
  // 1. 过去的时间戳必须返回 '重置时间已过'
  assert.equal(formatResetCountdown(Date.now() - 1000), '重置时间已过');
  assert.equal(formatResetCountdown(Date.now() - 3600 * 1000), '重置时间已过');
  assert.equal(formatResetCountdown(Date.now() - 24 * 3600 * 1000), '重置时间已过');

  // 2. 将来 30 秒内返回 '即将重置'
  assert.equal(formatResetCountdown(Date.now() + 30000), '即将重置');

  // 3. 将来 2 小时后返回小时倒计时
  const twoHoursLater = new Date(Date.now() + 2 * 3600 * 1000 + 10 * 60 * 1000).toISOString();
  assert.match(formatResetCountdown(twoHoursLater), /小时.*分后重置/);

  // 4. getAccountQuotaOverview 判定过期快照
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-a01-'));
  try {
    const mgr = new AccountsManager(sandbox);
    const staleAccount = {
      id: 'acc-stale',
      email: 'stale@example.com',
      quota: {
        last_updated: Math.floor(Date.now() / 1000) - 13 * 3600, // 13 小时前
        quota_groups: [
          {
            display_name: 'Gemini',
            buckets: [{ bucket_id: 'gemini-5h', remaining_fraction: 0.8, reset_time: twoHoursLater }],
          },
        ],
      },
    };
    const overview = mgr.getAccountQuotaOverview(staleAccount);
    assert.equal(overview.isStale, true);
    assert.ok(overview.staleHours >= 13);

    const freshAccount = {
      id: 'acc-fresh',
      email: 'fresh@example.com',
      quota: {
        last_updated: Math.floor(Date.now() / 1000) - 300, // 5 分钟前
      },
    };
    const freshOverview = mgr.getAccountQuotaOverview(freshAccount);
    assert.equal(freshOverview.isStale, false);
    assert.equal(freshOverview.staleHours, 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
});

test('A03: 未知模型禁止套用默认价计费，统计未计价覆盖率', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-a03-'));
  try {
    const geminiDir = join(sandbox, '.gemini');
    const convDir = join(geminiDir, 'antigravity', 'conversations');
    await mkdir(convDir, { recursive: true });

    // 构造测试 SQLite 数据库，包含一个未知模型和一个已知模型
    const dbPath = join(convDir, 'test_unknown_pricing.db');
    await execFileAsync('/usr/bin/sqlite3', [
      dbPath,
      `CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);
       CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);`,
    ]);

    // 构造已知模型 gemini-3.8-flash: 1000 in, 500 out, 100 cached
    const knownUsage = Buffer.concat([
      ProtobufWriter.encodeField(1, 0, ProtobufWriter.encodeVarint(0)),
      ProtobufWriter.encodeField(2, 0, ProtobufWriter.encodeVarint(1000)),
      ProtobufWriter.encodeField(3, 0, ProtobufWriter.encodeVarint(500)),
      ProtobufWriter.encodeField(5, 0, ProtobufWriter.encodeVarint(100)),
    ]);
    const knownWrapped = Buffer.concat([
      ProtobufWriter.encodeField(4, 2, knownUsage),
      ProtobufWriter.encodeString(19, 'gemini-3.8-flash'),
    ]);
    const knownBlob = ProtobufWriter.encodeField(1, 2, knownWrapped);

    // 构造未知模型 audit-unknown-model: 1,000,000 in, 500,000 out
    const unknownUsage = Buffer.concat([
      ProtobufWriter.encodeField(1, 0, ProtobufWriter.encodeVarint(0)),
      ProtobufWriter.encodeField(2, 0, ProtobufWriter.encodeVarint(1000000)),
      ProtobufWriter.encodeField(3, 0, ProtobufWriter.encodeVarint(500000)),
    ]);
    const unknownWrapped = Buffer.concat([
      ProtobufWriter.encodeField(4, 2, unknownUsage),
      ProtobufWriter.encodeString(19, 'audit-unknown-model'),
    ]);
    const unknownBlob = ProtobufWriter.encodeField(1, 2, unknownWrapped);

    await execFileAsync('/usr/bin/sqlite3', [
      dbPath,
      `INSERT INTO gen_metadata (idx, data) VALUES (1, x'${knownBlob.toString('hex')}');
       INSERT INTO gen_metadata (idx, data) VALUES (2, x'${unknownBlob.toString('hex')}');`,
    ]);

    const mgr = new UsageStatsManager({ geminiDir });
    const summary = await mgr.getUsageSummary(true);

    const unknownModelEntry = summary.all_time.by_model.find(m => m.model === 'audit-unknown-model');
    assert.ok(unknownModelEntry, '必须包含未知模型记录');
    assert.equal(unknownModelEntry.total_tokens, 1500000);
    // 关键断言：未知模型费用严禁套用 Flash 价格 ($0.75+$1.875=$2.625)，必须为 0
    assert.equal(unknownModelEntry.estimated_usd, 0, '未匹配价格的模型费用必须为 0');

    // 关键断言：统计已计价与未计价模型数量
    assert.equal(summary.all_time.priced_models, 1);
    assert.equal(summary.all_time.unpriced_models, 1);
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
});

test('A04: 准确披露扫描范围与抽样上限 (杜绝隐藏 30 库上限自称全量)', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-a04-'));
  try {
    const geminiDir = join(sandbox, '.gemini');
    const convDir = join(geminiDir, 'antigravity', 'conversations');
    await mkdir(convDir, { recursive: true });

    // 创建 35 个合法的空 SQLite 数据库
    for (let i = 1; i <= 35; i++) {
      const p = join(convDir, `conv_${String(i).padStart(3, '0')}.db`);
      await execFileAsync('/usr/bin/sqlite3', [p, 'CREATE TABLE dummy (id INT);']);
    }

    const mgr = new UsageStatsManager({ geminiDir });
    const discoveredPaths = await mgr.discoverDatabaseFiles(30);
    assert.equal(discoveredPaths.length, 30, '显式范围参数可限制为30库');
    assert.equal(mgr.lastDiscoveredDatabaseCount, 35, '必须记录发现的真实总数 35');

    const summary = await mgr.getUsageSummary(true);
    assert.equal(summary.databases_scanned, 35);
    assert.equal(summary.databases_discovered, 35);
    assert.ok(summary.scan_scope_description.includes('全部 35 个会话数据库'));
    assert.ok(summary.scan_scope_description.includes('35 个'));
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
});

test('A05: 缺失时间戳保持为 0，不污染今日消耗与每小时分布', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-test-a05-'));
  try {
    const geminiDir = join(sandbox, '.gemini');
    const convDir = join(geminiDir, 'antigravity', 'conversations');
    await mkdir(convDir, { recursive: true });

    const dbPath = join(convDir, 'zero_timestamp.db');
    await execFileAsync('/usr/bin/sqlite3', [
      dbPath,
      `CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);
       CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);`,
    ]);

    // 构造一个完全没有 timing 且 steps 无对应时间戳的记录 (100,000 tokens)
    const usage = Buffer.concat([
      ProtobufWriter.encodeField(2, 0, ProtobufWriter.encodeVarint(80000)),
      ProtobufWriter.encodeField(3, 0, ProtobufWriter.encodeVarint(20000)),
    ]);
    const wrapped = Buffer.concat([
      ProtobufWriter.encodeField(4, 2, usage),
      ProtobufWriter.encodeString(19, 'gemini-3.8-flash'),
    ]);
    const blob = ProtobufWriter.encodeField(1, 2, wrapped);

    await execFileAsync('/usr/bin/sqlite3', [
      dbPath,
      `INSERT INTO gen_metadata (idx, data) VALUES (1, x'${blob.toString('hex')}');`,
    ]);

    const mgr = new UsageStatsManager({ geminiDir });
    const scanResult = await mgr.scanDatabaseEvents(dbPath);
    assert.equal(scanResult.events.length, 1);
    // 关键断言 1：事件时间戳必须为 0，不能被赋为当前时间戳 Date.now()
    assert.equal(scanResult.events[0].timestamp_seconds, 0, '缺失时间戳必须保持为 0');

    const summary = await mgr.getUsageSummary(true);
    // 关键断言 2：今日消耗不能包含该 100,000 tokens
    assert.equal(summary.today.totals.total_tokens, 0, '无时间戳历史事件不能算入今日消耗');
    // 关键断言 3：每小时分布中不应出现该记录
    assert.equal(summary.today_hourly.length, 0, '每小时分布不能包含无时间戳事件');
    // 关键断言 4：全量历史统计必须如实包含
    assert.equal(summary.all_time.totals.total_tokens, 100000, '全量统计应包含该事件');
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
});

test('A06: 账号渲染指纹覆盖周限额、错误、禁用与模型变化，确保触发重绘', () => {
  function computeFingerprint(activeId, accounts) {
    return `${activeId}:` + accounts.map(acc => {
      const id = acc.id || '';
      const g5h = acc.geminiFiveHourRemaining ?? -1;
      const gWk = acc.geminiWeeklyRemaining ?? -1;
      const c5h = acc.claudeFiveHourRemaining ?? -1;
      const cWk = acc.claudeWeeklyRemaining ?? -1;
      const aWk = acc.argonWeeklyRemaining ?? -1;
      const label = acc.custom_label || '';
      const tier = acc.subscription_tier || '';
      const dis = acc.disabled ? '1' : '0';
      const err = acc.quota_refresh_error || '';
      const lastUp = acc.quota_last_updated ?? 0;
      const modelsCount = acc.models ? acc.models.length : 0;
      return `${id}:${g5h}:${gWk}:${c5h}:${cWk}:${aWk}:${label}:${tier}:${dis}:${err}:${lastUp}:${modelsCount}`;
    }).join('|');
  }

  const baseAccount = {
    id: 'acc-1',
    geminiFiveHourRemaining: 80,
    geminiWeeklyRemaining: 90,
    claudeFiveHourRemaining: 100,
    claudeWeeklyRemaining: 70,
    argonWeeklyRemaining: 100,
    custom_label: '工作号',
    subscription_tier: 'PRO',
    disabled: false,
    quota_refresh_error: '',
    quota_last_updated: 1000,
    models: [{ name: 'gemini-3.8-flash' }],
  };

  const initialFp = computeFingerprint('acc-1', [baseAccount]);

  // 1. 改变 geminiWeeklyRemaining 必须触发指纹变化
  const fp1 = computeFingerprint('acc-1', [{ ...baseAccount, geminiWeeklyRemaining: 85 }]);
  assert.notEqual(fp1, initialFp);

  // 2. 改变 claudeFiveHourRemaining 必须触发指纹变化
  const fp2 = computeFingerprint('acc-1', [{ ...baseAccount, claudeFiveHourRemaining: 50 }]);
  assert.notEqual(fp2, initialFp);

  // 3. 改变 argonWeeklyRemaining 必须触发指纹变化
  const fp3 = computeFingerprint('acc-1', [{ ...baseAccount, argonWeeklyRemaining: 60 }]);
  assert.notEqual(fp3, initialFp);

  // 4. 账号禁用 必须触发指纹变化
  const fp4 = computeFingerprint('acc-1', [{ ...baseAccount, disabled: true }]);
  assert.notEqual(fp4, initialFp);

  // 5. 刷新产生 error 必须触发指纹变化
  const fp5 = computeFingerprint('acc-1', [{ ...baseAccount, quota_refresh_error: '网络超时' }]);
  assert.notEqual(fp5, initialFp);

  // 6. 时间戳更新 必须触发指纹变化
  const fp6 = computeFingerprint('acc-1', [{ ...baseAccount, quota_last_updated: 2000 }]);
  assert.notEqual(fp6, initialFp);

  // 7. 模型数量改变 必须触发指纹变化
  const fp7 = computeFingerprint('acc-1', [{ ...baseAccount, models: [{ name: 'm1' }, { name: 'm2' }] }]);
  assert.notEqual(fp7, initialFp);
});
