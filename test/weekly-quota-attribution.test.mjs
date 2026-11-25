import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WeeklyQuotaSnapshotStore,
  computeAccountWeeklyAttribution,
  computeWeeklyEventQueryRange,
  mapModelToWeeklyPool,
} from '../dist/weekly-quota-attribution.js';
import { UsageLedger } from '../dist/usage-ledger.js';
import { UsageStatsManager } from '../dist/usage.js';
import { AccountsManager } from '../dist/accounts.js';
import { sendBackendRpc, stopBackendChild } from './test-ipc.mjs';

const WEEK_SEC = 7 * 86400;

async function withTempDir(t, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gb-weekly-attr-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return fn(dir);
}

async function withNoNetworkFetch(fn) {
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('Unexpected network fetch during offline weekly attribution');
  };
  try {
    const result = await fn();
    assert.equal(fetchCalls, 0, '不得发起任何网络请求');
    return result;
  } finally {
    globalThis.fetch = origFetch;
  }
}

function makeWeeklyQuota({
  observedAtSec,
  tier = 'PRO',
  source = 'cloud',
  isForbidden = false,
  geminiWeekly,
  claudeWeekly,
  argonWeekly,
  carbonWeekly,
  extraGroups = [],
  extraModels = [],
}) {
  const quotaGroups = [];
  const models = [];

  const addGroup = ({
    groupId,
    displayName,
    family,
    modelId,
    modelDisplay,
    spec,
    isArgon,
    isCarbon,
  }) => {
    if (!spec) return;
    const resetIso = typeof spec.resetTime === 'string'
      ? spec.resetTime
      : new Date(spec.resetTimeSec * 1000).toISOString();
    const bucketSource = spec.source ?? source;
    const bucketObs = spec.observedAtSec ?? observedAtSec;
    quotaGroups.push({
      group_id: groupId,
      display_name: displayName,
      family,
      observed_at: bucketObs,
      stale: spec.stale === true,
      source: bucketSource,
      buckets: [
        {
          bucket_id: `${family}-${spec.window ?? 'weekly'}`,
          window: spec.window ?? 'weekly',
          remaining_fraction: spec.remaining,
          remaining_fraction_known: spec.known ?? true,
          reset_time: resetIso,
          observed_at: bucketObs,
          stale: spec.stale === true,
          disabled: spec.disabled === true,
          source: bucketSource,
        },
      ],
    });
    models.push({
      name: modelId,
      model_id: modelId,
      display_name: modelDisplay,
      family,
      ...(isArgon ? { is_argon: true } : {}),
      ...(isCarbon ? { is_carbon: true } : {}),
      disabled: spec.disabled === true ? true : false,
      percentage: Math.round(spec.remaining * 100),
      percentage_known: spec.known ?? true,
      reset_time: resetIso,
      quota_source: bucketSource,
      stale: spec.stale === true,
    });
  };

  addGroup({
    groupId: 'gemini-group',
    displayName: 'Gemini',
    family: 'gemini',
    modelId: 'gemini-3.8-flash',
    modelDisplay: 'Gemini 3.8 Flash',
    spec: geminiWeekly,
  });
  addGroup({
    groupId: 'claude-group',
    displayName: 'Claude/GPT',
    family: 'claude',
    modelId: 'claude-opus-5-5',
    modelDisplay: 'Claude Opus 5.5',
    spec: claudeWeekly,
  });
  addGroup({
    groupId: 'argon-group',
    displayName: 'Gemini 4 Argon',
    family: 'argon',
    modelId: 'gemini-4-argon',
    modelDisplay: 'Gemini 4 Argon',
    spec: argonWeekly,
    isArgon: true,
  });
  addGroup({
    groupId: 'carbon-group',
    displayName: 'Gemini 4 Carbon',
    family: 'carbon',
    modelId: 'gemini-4-carbon',
    modelDisplay: 'Gemini 4 Carbon',
    spec: carbonWeekly,
    isCarbon: true,
  });

  quotaGroups.push(...extraGroups);
  models.push(...extraModels);

  return {
    models,
    quota_groups: quotaGroups,
    last_updated: observedAtSec,
    is_forbidden: isForbidden,
    subscription_tier: tier,
    model_forwarding_rules: {},
    source,
  };
}

let seqCounter = 0;
function makeEvent({
  model = 'gemini-3.8-flash',
  timestampSec,
  inputTokens = 1000,
  outputTokens = 200,
  cachedTokens = 0,
  totalTokens,
  estimatedUsd = 0.5,
  priced,
  accountId = 'acc-1',
  accountEmail = 'user@example.invalid',
  environmentKind = 'local',
  environmentId = 'local',
  dbFile,
}) {
  seqCounter += 1;
  const eventKey = createHash('sha256').update(`weekly-ev-${seqCounter}-${model}-${timestampSec}`).digest('hex');
  return {
    event_key: eventKey,
    source_id: `src-${seqCounter}`,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_tokens: cachedTokens,
    total_tokens: totalTokens ?? (inputTokens + outputTokens + cachedTokens),
    timestamp_seconds: timestampSec,
    account_id: accountId ?? undefined,
    account_email: accountEmail ?? undefined,
    account_confidence: 'observed',
    environment_kind: environmentKind,
    environment_id: environmentId,
    ...(dbFile ? { db_file: dbFile } : {}),
    estimated_usd: estimatedUsd,
    priced: priced ?? (estimatedUsd !== null && estimatedUsd !== undefined),
  };
}

test('WeeklyQuotaSnapshotStore：零网络请求、节流去重、8周期裁剪、坏文件容错与异常桶过滤', async t => {
  await withTempDir(t, async stateDir => {
    await withNoNetworkFetch(async () => {
      const store = new WeeklyQuotaSnapshotStore(stateDir);
      await store.load();
      assert.deepEqual(store.listEmails(), []);
      assert.equal(store.getAccountRecord('missing@example.invalid'), null);

      const baseNow = 1_795_000_000;
      const reset1 = baseNow + 5 * 86400;

      // 1. 首次记录保留原始小数精度，仅记录 weekly 桶
      const q1 = makeWeeklyQuota({
        observedAtSec: baseNow,
        geminiWeekly: { remaining: 0.85123, resetTimeSec: reset1 },
        extraGroups: [{
          group_id: 'gemini-5h-only',
          display_name: 'Gemini 5h',
          family: 'gemini',
          observed_at: baseNow,
          source: 'cloud',
          buckets: [{
            bucket_id: 'gemini-5h',
            window: '5h',
            remaining_fraction: 0.4,
            remaining_fraction_known: true,
            reset_time: new Date((baseNow + 3600) * 1000).toISOString(),
            observed_at: baseNow,
            stale: false,
            source: 'cloud',
          }],
        }],
      });
      assert.equal(store.recordQuotaSnapshot({ email: 'Alice@Example.Invalid', quota: q1, observedAtSec: baseNow }), true);

      // 2. 相同 remaining 仅推进 lastSeenAt，不追加新节点
      const t2 = baseNow + 120;
      const qSame = makeWeeklyQuota({
        observedAtSec: t2,
        geminiWeekly: { remaining: 0.85123, resetTimeSec: reset1 },
      });
      assert.equal(store.recordQuotaSnapshot({ email: 'alice@example.invalid', quota: qSame, observedAtSec: t2 }), true);
      // 同一时间戳重复调用返回 false
      assert.equal(store.recordQuotaSnapshot({ email: 'alice@example.invalid', quota: qSame, observedAtSec: t2 }), false);

      // 3. 微小抖动 (< 0.0001) 不追加新节点，仅推进 lastSeenAt
      const t3 = baseNow + 240;
      const qMicro = makeWeeklyQuota({
        observedAtSec: t3,
        geminiWeekly: { remaining: 0.85128, resetTimeSec: reset1 },
      });
      assert.equal(store.recordQuotaSnapshot({ email: 'alice@example.invalid', quota: qMicro, observedAtSec: t3 }), true);

      let rec = store.getAccountRecord('alice@example.invalid');
      assert.ok(rec);
      assert.equal(rec.pools.gemini.cycles.length, 1);
      assert.equal(rec.pools.gemini.cycles[0].points.length, 1);
      assert.equal(rec.pools.gemini.cycles[0].points[0].at, baseNow);
      assert.equal(rec.pools.gemini.cycles[0].points[0].lastSeenAt, t3);
      assert.equal(rec.pools.gemini.cycles[0].points[0].remaining, 0.85123);

      // 4. 变化 >= 0.0001 追加新节点（含精确边界 0.5 -> 0.4999；而 0.5 -> 0.49991 差值 0.00009 应被节流）
      const t4 = baseNow + 360;
      const qDrop = makeWeeklyQuota({
        observedAtSec: t4,
        geminiWeekly: { remaining: 0.5, resetTimeSec: reset1 },
      });
      assert.equal(store.recordQuotaSnapshot({ email: 'alice@example.invalid', quota: qDrop, observedAtSec: t4 }), true);

      const t4b = baseNow + 420;
      const qSubThreshold = makeWeeklyQuota({
        observedAtSec: t4b,
        geminiWeekly: { remaining: 0.49991, resetTimeSec: reset1 },
      });
      assert.equal(store.recordQuotaSnapshot({ email: 'alice@example.invalid', quota: qSubThreshold, observedAtSec: t4b }), true);
      assert.equal(store.getAccountRecord('alice@example.invalid').pools.gemini.cycles[0].points.length, 2);

      const t5 = baseNow + 480;
      const qBoundary = makeWeeklyQuota({
        observedAtSec: t5,
        geminiWeekly: { remaining: 0.4999, resetTimeSec: reset1 },
      });
      assert.equal(store.recordQuotaSnapshot({ email: 'alice@example.invalid', quota: qBoundary, observedAtSec: t5 }), true);

      rec = store.getAccountRecord('alice@example.invalid');
      assert.equal(rec.pools.gemini.cycles[0].points.length, 3);
      assert.equal(rec.pools.gemini.cycles[0].points[1].remaining, 0.5);
      assert.equal(rec.pools.gemini.cycles[0].points[2].remaining, 0.4999);

      // 5. 过滤 stale / disabled / carried / 过期 reset_time / is_forbidden / 非周窗口
      const badCases = [
        makeWeeklyQuota({ observedAtSec: t5 + 60, geminiWeekly: { remaining: 0.3, resetTimeSec: reset1, stale: true } }),
        makeWeeklyQuota({ observedAtSec: t5 + 60, geminiWeekly: { remaining: 0.3, resetTimeSec: reset1, disabled: true } }),
        makeWeeklyQuota({ observedAtSec: t5 + 60, geminiWeekly: { remaining: 0.3, resetTimeSec: reset1, source: 'carried' } }),
        makeWeeklyQuota({ observedAtSec: t5 + 60, geminiWeekly: { remaining: 0.3, resetTimeSec: t5 + 30 } }), // reset_time 已过期
        makeWeeklyQuota({ observedAtSec: t5 + 60, isForbidden: true, geminiWeekly: { remaining: 0.3, resetTimeSec: reset1 } }),
        makeWeeklyQuota({ observedAtSec: t5 + 60, geminiWeekly: { remaining: 0.3, resetTimeSec: reset1, window: '5h' } }),
      ];
      for (const badQuota of badCases) {
        assert.equal(
          store.recordQuotaSnapshot({ email: 'alice@example.invalid', quota: badQuota, observedAtSec: t5 + 60 }),
          false,
          '异常/陈旧/禁用/非周窗口不得写入快照'
        );
      }

      // 6. 写入 10 个周周期，自动裁剪为最近 8 个并持久化重加载验证
      for (let i = 1; i <= 9; i += 1) {
        const cycleReset = reset1 + i * WEEK_SEC;
        const obs = cycleReset - 3600;
        const qCycle = makeWeeklyQuota({
          observedAtSec: obs,
          geminiWeekly: { remaining: 0.9 - i * 0.01, resetTimeSec: cycleReset },
        });
        assert.equal(store.recordQuotaSnapshot({ email: 'alice@example.invalid', quota: qCycle, observedAtSec: obs }), true);
      }

      await store.flush();
      assert.equal(existsSync(store.filePath), true);

      const reloaded = new WeeklyQuotaSnapshotStore(stateDir);
      await reloaded.load();
      const reloadedRec = reloaded.getAccountRecord('alice@example.invalid');
      assert.ok(reloadedRec);
      assert.equal(reloadedRec.pools.gemini.cycles.length, 8);
      assert.equal(reloadedRec.pools.gemini.cycles[0].resetTimeSec, reset1 + 2 * WEEK_SEC);
      assert.equal(reloadedRec.pools.gemini.cycles[7].resetTimeSec, reset1 + 9 * WEEK_SEC);

      // 7. 损坏或非法 JSON 文件容错加载（异步 load 与同步 ensureLoadedSync）
      const corruptDir = join(stateDir, 'corrupt');
      await mkdir(corruptDir, { recursive: true });
      await writeFile(join(corruptDir, 'weekly-quota-snapshots.json'), '{broken json!!!', 'utf8');
      const corruptStoreAsync = new WeeklyQuotaSnapshotStore(corruptDir);
      await corruptStoreAsync.load();
      assert.deepEqual(corruptStoreAsync.listEmails(), []);

      const corruptStoreSync = new WeeklyQuotaSnapshotStore(corruptDir);
      assert.equal(corruptStoreSync.getAccountRecord('alice@example.invalid'), null);

      const badSchemaDir = join(stateDir, 'bad-schema');
      await mkdir(badSchemaDir, { recursive: true });
      await writeFile(join(badSchemaDir, 'weekly-quota-snapshots.json'), JSON.stringify({ version: 99, accounts: [] }), 'utf8');
      const badSchemaStore = new WeeklyQuotaSnapshotStore(badSchemaDir);
      await badSchemaStore.load();
      assert.deepEqual(badSchemaStore.listEmails(), []);
    });
  });
});

test('纯他端消耗归因：0 本地事件与 lastSeenAt 收紧掉额间隔均 100% 归他端且 confidence === high', async () => {
  await withNoNetworkFetch(async () => {
    const cycleStart = 1_795_000_000;
    const resetSec = cycleStart + WEEK_SEC;

    // 场景 A：整周期本端 0 事件，仅由他端消耗 28%
    const pureOtherStored = {
      email: 'other-client@example.invalid',
      tier: 'PRO',
      pools: {
        gemini: {
          poolKey: 'gemini',
          displayName: 'Gemini',
          tier: 'PRO',
          cycles: [{
            cycleStartSec: cycleStart,
            resetTimeSec: resetSec,
            resetTimeIso: new Date(resetSec * 1000).toISOString(),
            tier: 'PRO',
            points: [
              { at: cycleStart + 100, lastSeenAt: cycleStart + 3600, remaining: 1.0, source: 'cloud' },
              { at: cycleStart + 3700, lastSeenAt: cycleStart + 3700, remaining: 0.72, source: 'cloud' },
            ],
          }],
        },
      },
    };
    const resPure = computeAccountWeeklyAttribution({
      accountId: 'acc-pure',
      email: 'other-client@example.invalid',
      tier: 'PRO',
      storedAccount: pureOtherStored,
      events: [],
      nowSec: cycleStart + 3800,
    });
    assert.equal(resPure.pools.length, 1);
    const pA = resPure.pools[0];
    assert.equal(pA.totalUsedPct, 28);
    assert.equal(pA.localEstimatedUsedPct, 0);
    assert.equal(pA.otherEstimatedUsedPct, 28);
    assert.equal(pA.confidence, 'high');
    assert.equal(pA.ambiguousDropPct, 0);

    // 场景 B：早期曾有 1 次本地调用掉额 2%，随后相同额度连续观测推进 lastSeenAt 至 10 小时后，
    // 再发生 20% 掉额时因 lastSeenAt 收紧窗口，不会把 10 小时前的本地调用误算入本次掉额
    const tightenedStored = {
      email: 'tightened@example.invalid',
      tier: 'PRO',
      pools: {
        gemini: {
          poolKey: 'gemini',
          displayName: 'Gemini',
          tier: 'PRO',
          cycles: [{
            cycleStartSec: cycleStart,
            resetTimeSec: resetSec,
            resetTimeIso: new Date(resetSec * 1000).toISOString(),
            tier: 'PRO',
            points: [
              { at: cycleStart + 100, lastSeenAt: cycleStart + 100, remaining: 1.0, source: 'cloud' },
              { at: cycleStart + 200, lastSeenAt: cycleStart + 36_000, remaining: 0.98, source: 'cloud' },
              { at: cycleStart + 36_100, lastSeenAt: cycleStart + 36_100, remaining: 0.78, source: 'cloud' },
            ],
          }],
        },
      },
    };
    const resTightened = computeAccountWeeklyAttribution({
      accountId: 'acc-tight',
      email: 'tightened@example.invalid',
      tier: 'PRO',
      storedAccount: tightenedStored,
      events: [
        makeEvent({
          accountId: 'acc-tight',
          accountEmail: 'tightened@example.invalid',
          timestampSec: cycleStart + 150,
          estimatedUsd: 1.0,
        }),
      ],
      nowSec: cycleStart + 36_200,
    });
    const pB = resTightened.pools[0];
    assert.equal(pB.totalUsedPct, 22);
    assert.equal(pB.localEstimatedUsedPct, 2);
    assert.equal(pB.otherEstimatedUsedPct, 20);
  });
});

test('阶梯跳变累积：多轮本地调用滞后掉档通过 carryEvents 合并归因且不漏算', async () => {
  await withNoNetworkFetch(async () => {
    const cycleStart = 1_795_000_000;
    const resetSec = cycleStart + WEEK_SEC;

    // 场景 A：前 2 轮调用时配额仍停留在 1.0（推进 lastSeenAt 至 +700），第 3 轮后才跳变降至 0.94
    const steppedStored = {
      email: 'stepped@example.invalid',
      tier: 'PRO',
      pools: {
        gemini: {
          poolKey: 'gemini',
          displayName: 'Gemini',
          tier: 'PRO',
          cycles: [{
            cycleStartSec: cycleStart,
            resetTimeSec: resetSec,
            resetTimeIso: new Date(resetSec * 1000).toISOString(),
            tier: 'PRO',
            points: [
              { at: cycleStart + 50, lastSeenAt: cycleStart + 700, remaining: 1.0, source: 'cloud' },
              { at: cycleStart + 760, lastSeenAt: cycleStart + 760, remaining: 0.94, source: 'cloud' },
            ],
          }],
        },
      },
    };
    const eventsA = [
      makeEvent({ accountId: 'acc-step', accountEmail: 'stepped@example.invalid', timestampSec: cycleStart + 100, estimatedUsd: 1.0 }),
      makeEvent({ accountId: 'acc-step', accountEmail: 'stepped@example.invalid', timestampSec: cycleStart + 300, estimatedUsd: 1.0 }),
      makeEvent({ accountId: 'acc-step', accountEmail: 'stepped@example.invalid', timestampSec: cycleStart + 720, estimatedUsd: 1.0 }),
    ];
    const resA = computeAccountWeeklyAttribution({
      accountId: 'acc-step',
      email: 'stepped@example.invalid',
      tier: 'PRO',
      storedAccount: steppedStored,
      events: eventsA,
      nowSec: cycleStart + 800,
    });
    const poolA = resA.pools[0];
    assert.equal(poolA.totalUsedPct, 6);
    assert.equal(poolA.localEstimatedUsedPct, 6);
    assert.equal(poolA.otherEstimatedUsedPct, 0);
    assert.equal(poolA.localRequests, 3);
    assert.equal(poolA.localUsd, 3);
    // 合并 carryEvents ($2) + recentEvents ($1) = $3 / 6% = $0.50 / 1%
    assert.equal(poolA.usdPer1Pct, 0.5);

    // 场景 B：已校准 ($0.50 / 1%) 后，本地连续调用 ($1.00) 落入 carry 窗口且随后静默滞后掉档 2%
    const delayedStored = {
      email: 'delayed@example.invalid',
      tier: 'PRO',
      pools: {
        gemini: {
          poolKey: 'gemini',
          displayName: 'Gemini',
          tier: 'PRO',
          cycles: [{
            cycleStartSec: cycleStart,
            resetTimeSec: resetSec,
            resetTimeIso: new Date(resetSec * 1000).toISOString(),
            tier: 'PRO',
            points: [
              { at: cycleStart + 100, lastSeenAt: cycleStart + 100, remaining: 1.0, source: 'cloud' },
              { at: cycleStart + 200, lastSeenAt: cycleStart + 200, remaining: 0.95, source: 'cloud' },
              { at: cycleStart + 300, lastSeenAt: cycleStart + 300, remaining: 0.90, source: 'cloud' },
              // 第 3 次本地调用发生在 +400 和 +500，但 +900 时仍显示 0.90，直到 +1000 才滞后掉档 2%
              { at: cycleStart + 1000, lastSeenAt: cycleStart + 1000, remaining: 0.88, source: 'cloud' },
            ],
          }],
        },
      },
    };
    const delayedEvents = [
      makeEvent({ accountId: 'acc-del', accountEmail: 'delayed@example.invalid', timestampSec: cycleStart + 150, estimatedUsd: 2.5 }),
      makeEvent({ accountId: 'acc-del', accountEmail: 'delayed@example.invalid', timestampSec: cycleStart + 250, estimatedUsd: 2.5 }),
      makeEvent({ accountId: 'acc-del', accountEmail: 'delayed@example.invalid', timestampSec: cycleStart + 400, estimatedUsd: 0.5 }),
      makeEvent({ accountId: 'acc-del', accountEmail: 'delayed@example.invalid', timestampSec: cycleStart + 500, estimatedUsd: 0.5 }),
    ];
    // 修改第 3 个点 lastSeenAt 为 +900 以触发 > 180s 静默滞后
    delayedStored.pools.gemini.cycles[0].points[2].lastSeenAt = cycleStart + 900;

    const resB = computeAccountWeeklyAttribution({
      accountId: 'acc-del',
      email: 'delayed@example.invalid',
      tier: 'PRO',
      storedAccount: delayedStored,
      events: delayedEvents,
      nowSec: cycleStart + 1100,
    });
    const poolB = resB.pools[0];
    assert.equal(poolB.totalUsedPct, 12);
    assert.equal(poolB.localEstimatedUsedPct, 12);
    assert.equal(poolB.otherEstimatedUsedPct, 0);
  });
});

test('家庭组并发防高估裁剪：已校准 usdPer1Pct 后短区间总降 10% 本端仅 ~2% 自动裁剪为 ~2% 本端 / ~8% 他端', async () => {
  await withNoNetworkFetch(async () => {
    const w1Start = 1_794_000_000;
    const w1Reset = w1Start + WEEK_SEC;
    const w2Start = w1Reset;
    const w2Reset = w2Start + WEEK_SEC;

    // Week 1 建立 4 个干净校准样本：$2.50 -> 5%，usdPer1Pct = 0.50
    const w1Points = [
      { at: w1Start + 100, lastSeenAt: w1Start + 100, remaining: 1.0, source: 'cloud' },
      { at: w1Start + 220, lastSeenAt: w1Start + 220, remaining: 0.95, source: 'cloud' },
      { at: w1Start + 340, lastSeenAt: w1Start + 340, remaining: 0.90, source: 'cloud' },
      { at: w1Start + 460, lastSeenAt: w1Start + 460, remaining: 0.85, source: 'cloud' },
      { at: w1Start + 580, lastSeenAt: w1Start + 580, remaining: 0.80, source: 'cloud' },
    ];
    const w1Events = [
      makeEvent({ accountId: 'acc-fam', accountEmail: 'family@example.invalid', timestampSec: w1Start + 160, estimatedUsd: 2.5 }),
      makeEvent({ accountId: 'acc-fam', accountEmail: 'family@example.invalid', timestampSec: w1Start + 280, estimatedUsd: 2.5 }),
      makeEvent({ accountId: 'acc-fam', accountEmail: 'family@example.invalid', timestampSec: w1Start + 400, estimatedUsd: 2.5 }),
      makeEvent({ accountId: 'acc-fam', accountEmail: 'family@example.invalid', timestampSec: w1Start + 520, estimatedUsd: 2.5 }),
    ];

    // Week 2 短区间 (120s) 总降 10% (1.0 -> 0.90)，但本端等效 USD 仅 $1.00 (~2%，远低于 10% / 1.8)
    const w2Points = [
      { at: w2Start + 100, lastSeenAt: w2Start + 100, remaining: 1.0, source: 'cloud' },
      { at: w2Start + 220, lastSeenAt: w2Start + 220, remaining: 0.90, source: 'cloud' },
    ];
    const w2Events = [
      makeEvent({ accountId: 'acc-fam', accountEmail: 'family@example.invalid', timestampSec: w2Start + 160, estimatedUsd: 1.0 }),
    ];

    const stored = {
      email: 'family@example.invalid',
      tier: 'PRO',
      pools: {
        gemini: {
          poolKey: 'gemini',
          displayName: 'Gemini',
          tier: 'PRO',
          cycles: [
            {
              cycleStartSec: w1Start,
              resetTimeSec: w1Reset,
              resetTimeIso: new Date(w1Reset * 1000).toISOString(),
              tier: 'PRO',
              points: w1Points,
            },
            {
              cycleStartSec: w2Start,
              resetTimeSec: w2Reset,
              resetTimeIso: new Date(w2Reset * 1000).toISOString(),
              tier: 'PRO',
              points: w2Points,
            },
          ],
        },
      },
    };

    const res = computeAccountWeeklyAttribution({
      accountId: 'acc-fam',
      email: 'family@example.invalid',
      tier: 'PRO',
      storedAccount: stored,
      events: [...w1Events, ...w2Events],
      nowSec: w2Start + 300,
    });
    const pool = res.pools[0];
    assert.equal(pool.usdPer1Pct, 0.5);
    assert.equal(pool.totalUsedPct, 10);
    assert.equal(pool.localEstimatedUsedPct, 2);
    assert.equal(pool.otherEstimatedUsedPct, 8);
  });
});

test('加权 P70 抗并发偏移与跨周复用（含同套餐复用与跨套餐隔离）', async () => {
  await withNoNetworkFetch(async () => {
    const w1Start = 1_794_000_000;
    const w1Reset = w1Start + WEEK_SEC;
    const w2Start = w1Reset;
    const w2Reset = w2Start + WEEK_SEC;

    // Week 1 含 2 个被他端并发拉低的异常低样本 (0.08, 0.10) + 3 个干净样本 (0.50, 0.52, 0.54)
    // 权重均为 0.05，总权重 0.25，70% 分位 (0.175) 落在 0.52，抗并发拉低
    const w1Points = [
      { at: w1Start + 100, lastSeenAt: w1Start + 100, remaining: 1.00, source: 'cloud' },
      { at: w1Start + 200, lastSeenAt: w1Start + 200, remaining: 0.95, source: 'cloud' },
      { at: w1Start + 300, lastSeenAt: w1Start + 300, remaining: 0.90, source: 'cloud' },
      { at: w1Start + 400, lastSeenAt: w1Start + 400, remaining: 0.85, source: 'cloud' },
      { at: w1Start + 500, lastSeenAt: w1Start + 500, remaining: 0.80, source: 'cloud' },
      { at: w1Start + 600, lastSeenAt: w1Start + 600, remaining: 0.75, source: 'cloud' },
    ];
    const w1Events = [
      makeEvent({ accountId: 'acc-p70', accountEmail: 'p70@example.invalid', timestampSec: w1Start + 150, estimatedUsd: 0.40 }), // 0.08
      makeEvent({ accountId: 'acc-p70', accountEmail: 'p70@example.invalid', timestampSec: w1Start + 250, estimatedUsd: 0.50 }), // 0.10
      makeEvent({ accountId: 'acc-p70', accountEmail: 'p70@example.invalid', timestampSec: w1Start + 350, estimatedUsd: 2.50 }), // 0.50
      makeEvent({ accountId: 'acc-p70', accountEmail: 'p70@example.invalid', timestampSec: w1Start + 450, estimatedUsd: 2.60 }), // 0.52
      makeEvent({ accountId: 'acc-p70', accountEmail: 'p70@example.invalid', timestampSec: w1Start + 550, estimatedUsd: 2.70 }), // 0.54
    ];

    // Week 2 首日仅 1 个首点 remaining=0.90（preDrop=10%），本端在首点前消费 $1.04 (~2%)
    const w2PointsSameTier = [
      { at: w2Start + 5000, lastSeenAt: w2Start + 5000, remaining: 0.90, source: 'cloud' },
    ];
    const w2Events = [
      makeEvent({ accountId: 'acc-p70', accountEmail: 'p70@example.invalid', timestampSec: w2Start + 1000, estimatedUsd: 1.04 }),
    ];

    const storedSameTier = {
      email: 'p70@example.invalid',
      tier: 'PRO',
      pools: {
        gemini: {
          poolKey: 'gemini',
          displayName: 'Gemini',
          tier: 'PRO',
          cycles: [
            {
              cycleStartSec: w1Start,
              resetTimeSec: w1Reset,
              resetTimeIso: new Date(w1Reset * 1000).toISOString(),
              tier: 'PRO',
              points: w1Points,
            },
            {
              cycleStartSec: w2Start,
              resetTimeSec: w2Reset,
              resetTimeIso: new Date(w2Reset * 1000).toISOString(),
              tier: 'PRO',
              points: w2PointsSameTier,
            },
          ],
        },
      },
    };

    const resSameTier = computeAccountWeeklyAttribution({
      accountId: 'acc-p70',
      email: 'p70@example.invalid',
      tier: 'PRO',
      storedAccount: storedSameTier,
      events: [...w1Events, ...w2Events],
      nowSec: w2Start + 5100,
    });
    const pSame = resSameTier.pools[0];
    assert.equal(pSame.usdPer1Pct, 0.52);
    assert.equal(pSame.calibrationSamples, 5);
    assert.equal(pSame.hasPreSnapshotEstimate, true);
    assert.equal(pSame.totalUsedPct, 10);
    assert.equal(pSame.localEstimatedUsedPct, 2);
    assert.equal(pSame.otherEstimatedUsedPct, 8);
    assert.notEqual(pSame.confidence, 'calibrating');

    // 套餐升级/变化后（PRO -> ULTRA）不复用旧套餐校准样本
    const storedDiffTier = structuredClone(storedSameTier);
    storedDiffTier.tier = 'ULTRA';
    storedDiffTier.pools.gemini.tier = 'ULTRA';
    storedDiffTier.pools.gemini.cycles[1].tier = 'ULTRA';

    const resDiffTier = computeAccountWeeklyAttribution({
      accountId: 'acc-p70',
      email: 'p70@example.invalid',
      tier: 'ULTRA',
      storedAccount: storedDiffTier,
      events: [...w1Events, ...w2Events],
      nowSec: w2Start + 5100,
    });
    const pDiff = resDiffTier.pools[0];
    assert.equal(pDiff.usdPer1Pct, null);
    assert.equal(pDiff.calibrationSamples, 0);
    assert.equal(pDiff.localEstimatedUsedPct, null);
    assert.equal(pDiff.confidence, 'calibrating');
  });
});

test('SSH 同邮箱合并与异邮箱隔离，以及 mapModelToWeeklyPool 核心/独立周池映射', async () => {
  await withNoNetworkFetch(async () => {
    const cycleStart = 1_795_000_000;
    const resetSec = cycleStart + WEEK_SEC;

    const stored = {
      email: 'Primary@Example.Invalid',
      tier: 'PRO',
      pools: {
        gemini: {
          poolKey: 'gemini',
          displayName: 'Gemini',
          tier: 'PRO',
          cycles: [{
            cycleStartSec: cycleStart,
            resetTimeSec: resetSec,
            resetTimeIso: new Date(resetSec * 1000).toISOString(),
            tier: 'PRO',
            points: [
              { at: cycleStart + 100, lastSeenAt: cycleStart + 100, remaining: 1.0, source: 'cloud' },
              { at: cycleStart + 200, lastSeenAt: cycleStart + 200, remaining: 0.95, source: 'cloud' },
              { at: cycleStart + 300, lastSeenAt: cycleStart + 300, remaining: 0.90, source: 'ssh' },
            ],
          }],
        },
        argon: {
          poolKey: 'argon',
          displayName: 'Gemini 4 Argon',
          tier: 'PRO',
          cycles: [{
            cycleStartSec: cycleStart,
            resetTimeSec: resetSec,
            resetTimeIso: new Date(resetSec * 1000).toISOString(),
            tier: 'PRO',
            points: [
              { at: cycleStart + 100, lastSeenAt: cycleStart + 100, remaining: 1.0, source: 'cloud' },
              { at: cycleStart + 300, lastSeenAt: cycleStart + 300, remaining: 0.80, source: 'cloud' },
            ],
          }],
        },
      },
    };

    const events = [
      // 本端桌面事件
      makeEvent({
        accountId: 'acc-main',
        accountEmail: 'primary@example.invalid',
        model: 'gemini-3.8-flash',
        timestampSec: cycleStart + 150,
        inputTokens: 1000,
        outputTokens: 500,
        estimatedUsd: 2.0,
        environmentKind: 'local',
      }),
      // 同邮箱 SSH 事件（即使无 account_id 也按大小写无关 email 合并计入）
      makeEvent({
        accountId: null,
        accountEmail: 'PRIMARY@example.invalid',
        model: 'gemini-3.8-flash',
        timestampSec: cycleStart + 250,
        inputTokens: 2000,
        outputTokens: 1000,
        estimatedUsd: 2.0,
        environmentKind: 'ssh',
        environmentId: 'ssh:gpu-box',
      }),
      // 同邮箱 Argon SSH 事件应落入 argon 独立池
      makeEvent({
        accountId: null,
        accountEmail: 'primary@example.invalid',
        model: 'gemini-4-argon',
        timestampSec: cycleStart + 260,
        inputTokens: 400,
        outputTokens: 100,
        estimatedUsd: 1.0,
        environmentKind: 'ssh',
        environmentId: 'ssh:gpu-box',
      }),
      // 异邮箱 SSH 事件：绝不混入
      makeEvent({
        accountId: 'acc-stranger',
        accountEmail: 'stranger@example.invalid',
        model: 'gemini-3.8-flash',
        timestampSec: cycleStart + 240,
        inputTokens: 9000,
        outputTokens: 1000,
        estimatedUsd: 99.0,
        environmentKind: 'ssh',
        environmentId: 'ssh:gpu-box',
      }),
      // 未归因事件：绝不混入
      makeEvent({
        accountId: null,
        accountEmail: null,
        model: 'gemini-3.8-flash',
        timestampSec: cycleStart + 245,
        inputTokens: 5000,
        outputTokens: 500,
        estimatedUsd: 50.0,
        environmentKind: 'ssh',
      }),
      // synthetic 恢复库事件：绝不混入
      makeEvent({
        accountId: 'acc-main',
        accountEmail: 'primary@example.invalid',
        model: 'gemini-3.8-flash',
        timestampSec: cycleStart + 246,
        inputTokens: 7000,
        outputTokens: 700,
        estimatedUsd: 70.0,
        dbFile: 'recovered_session.db',
      }),
    ];

    const res = computeAccountWeeklyAttribution({
      accountId: 'acc-main',
      email: 'Primary@Example.Invalid',
      tier: 'PRO',
      storedAccount: stored,
      events,
      nowSec: cycleStart + 400,
    });

    const geminiPool = res.pools.find(p => p.poolKey === 'gemini');
    const argonPool = res.pools.find(p => p.poolKey === 'argon');
    assert.ok(geminiPool);
    assert.ok(argonPool);

    assert.equal(geminiPool.localRequests, 2);
    assert.equal(geminiPool.localTokens, 4500);
    assert.equal(geminiPool.localUsd, 4);
    assert.equal(geminiPool.sshRequests, 1);
    assert.equal(geminiPool.sshTokens, 3000);

    assert.equal(argonPool.localRequests, 1);
    assert.equal(argonPool.localTokens, 500);
    assert.equal(argonPool.sshRequests, 1);
    assert.equal(argonPool.sshTokens, 500);

    // 验证池路由函数
    assert.equal(mapModelToWeeklyPool({ model: 'gemini-3.8-flash' }), 'gemini');
    assert.equal(mapModelToWeeklyPool({ model: 'claude-opus-5-5' }), 'claude');
    assert.equal(mapModelToWeeklyPool({ model: 'gpt-4o' }), 'claude');
    assert.equal(
      mapModelToWeeklyPool({ model: 'gemini-4-argon', standaloneWeeklyPoolKeys: new Set(['argon']) }),
      'argon'
    );
    assert.equal(
      mapModelToWeeklyPool({ model: 'gemini-4-argon', standaloneWeeklyPoolKeys: new Set() }),
      'gemini'
    );
    assert.equal(
      mapModelToWeeklyPool({ model: 'gemini-4-carbon', standaloneWeeklyPoolKeys: new Set(['carbon']) }),
      'carbon'
    );
  });
});

test('冷启动、未定价模型降级、recentCycles 历史周输出与数学守恒不变量', async () => {
  await withNoNetworkFetch(async () => {
    const baseStart = 1_790_000_000;

    // 1. 冷启动（首点已掉额 + 本地调用，无历史样本）-> calibrating / null
    const coldStored = {
      email: 'cold@example.invalid',
      tier: 'PRO',
      pools: {
        claude: {
          poolKey: 'claude',
          displayName: 'Claude/GPT',
          tier: 'PRO',
          cycles: [{
            cycleStartSec: baseStart,
            resetTimeSec: baseStart + WEEK_SEC,
            resetTimeIso: new Date((baseStart + WEEK_SEC) * 1000).toISOString(),
            tier: 'PRO',
            points: [{ at: baseStart + 2000, lastSeenAt: baseStart + 2000, remaining: 0.85, source: 'cloud' }],
          }],
        },
      },
    };
    const coldRes = computeAccountWeeklyAttribution({
      accountId: 'acc-cold',
      email: 'cold@example.invalid',
      tier: 'PRO',
      storedAccount: coldStored,
      events: [
        makeEvent({
          accountId: 'acc-cold',
          accountEmail: 'cold@example.invalid',
          model: 'claude-opus-5-5',
          timestampSec: baseStart + 1000,
          estimatedUsd: 1.5,
        }),
      ],
      nowSec: baseStart + 2100,
    });
    assert.equal(coldRes.pools[0].localEstimatedUsedPct, null);
    assert.equal(coldRes.pools[0].otherEstimatedUsedPct, null);
    assert.equal(coldRes.pools[0].confidence, 'calibrating');
    assert.equal(coldRes.pools[0].ambiguousDropPct, 15);

    // 2. 未定价模型降级不崩溃且 unpricedRequests > 0
    const unpricedStored = {
      email: 'unpriced@example.invalid',
      tier: 'PRO',
      pools: {
        gemini: {
          poolKey: 'gemini',
          displayName: 'Gemini',
          tier: 'PRO',
          cycles: [{
            cycleStartSec: baseStart,
            resetTimeSec: baseStart + WEEK_SEC,
            resetTimeIso: new Date((baseStart + WEEK_SEC) * 1000).toISOString(),
            tier: 'PRO',
            points: [
              { at: baseStart + 100, lastSeenAt: baseStart + 100, remaining: 1.0, source: 'cloud' },
              { at: baseStart + 250, lastSeenAt: baseStart + 250, remaining: 0.92, source: 'cloud' },
            ],
          }],
        },
      },
    };
    const unpricedRes = computeAccountWeeklyAttribution({
      accountId: 'acc-unpriced',
      email: 'unpriced@example.invalid',
      tier: 'PRO',
      storedAccount: unpricedStored,
      events: [
        makeEvent({
          accountId: 'acc-unpriced',
          accountEmail: 'unpriced@example.invalid',
          model: 'custom-unpriced-gemini-exp',
          timestampSec: baseStart + 180,
          inputTokens: 1200,
          outputTokens: 300,
          estimatedUsd: null,
          priced: false,
        }),
      ],
      nowSec: baseStart + 300,
    });
    const upPool = unpricedRes.pools[0];
    assert.equal(upPool.unpricedRequests, 1);
    assert.equal(upPool.localRequests, 1);
    assert.equal(upPool.localTokens, 1500);
    assert.equal(upPool.localUsd, 0);
    assert.notEqual(upPool.confidence, 'high');
    assert.ok(upPool.localEstimatedUsedPct !== null);
    assert.ok(upPool.localEstimatedUsedPct >= 0 && upPool.localEstimatedUsedPct <= upPool.totalUsedPct);

    // 3. 6 个周周期 -> recentCycles 输出最近 4 个历史周（按 resetTimeSec 倒序）+ 数学守恒验证
    const cycles = [];
    const multiEvents = [];
    for (let c = 0; c < 6; c += 1) {
      const cStart = baseStart + c * WEEK_SEC;
      const cReset = cStart + WEEK_SEC;
      cycles.push({
        cycleStartSec: cStart,
        resetTimeSec: cReset,
        resetTimeIso: new Date(cReset * 1000).toISOString(),
        tier: 'PRO',
        points: [
          { at: cStart + 100, lastSeenAt: cStart + 100, remaining: 1.0, source: 'cloud' },
          { at: cStart + 200, lastSeenAt: cStart + 200, remaining: 0.95 - c * 0.01, source: 'cloud' },
          { at: cStart + 300, lastSeenAt: cStart + 300, remaining: 0.85 - c * 0.02, source: 'cloud' },
        ],
      });
      multiEvents.push(
        makeEvent({
          accountId: 'acc-hist',
          accountEmail: 'history@example.invalid',
          timestampSec: cStart + 150,
          estimatedUsd: 2.5,
        }),
        makeEvent({
          accountId: 'acc-hist',
          accountEmail: 'history@example.invalid',
          timestampSec: cStart + 250,
          estimatedUsd: 2.5,
        }),
      );
    }

    const histRes = computeAccountWeeklyAttribution({
      accountId: 'acc-hist',
      email: 'history@example.invalid',
      tier: 'PRO',
      storedAccount: {
        email: 'history@example.invalid',
        tier: 'PRO',
        pools: { gemini: { poolKey: 'gemini', displayName: 'Gemini', tier: 'PRO', cycles } },
      },
      events: multiEvents,
      nowSec: baseStart + 5 * WEEK_SEC + 400,
    });
    const histPool = histRes.pools[0];
    assert.equal(histPool.recentCycles.length, 4);
    assert.equal(histPool.recentCycles[0].resetTimeSec, baseStart + 5 * WEEK_SEC);
    assert.equal(histPool.recentCycles[3].resetTimeSec, baseStart + 2 * WEEK_SEC);

    const checkConservation = (entry) => {
      if (entry.totalUsedPct !== null && entry.localEstimatedUsedPct !== null && entry.otherEstimatedUsedPct !== null) {
        assert.ok(entry.localEstimatedUsedPct >= 0);
        assert.ok(entry.localEstimatedUsedPct <= entry.totalUsedPct);
        assert.ok(entry.totalUsedPct <= 100);
        assert.ok(Math.abs(entry.localEstimatedUsedPct + entry.otherEstimatedUsedPct - entry.totalUsedPct) <= 0.11);
      }
    };
    checkConservation(histPool);
    for (const past of histPool.recentCycles) {
      checkConservation(past);
      assert.equal(past.localRequests, 2);
      assert.equal(past.localUsd, 5);
    }
  });
});

test('UsageLedger.range 与 UsageStatsManager.getEventsWithCostsInRange：大小账本、只读不写脏 rateLocksDirty', async t => {
  await withTempDir(t, async stateDir => {
    const tBase = 1_795_000_000;
    const geminiDir = join(stateDir, 'empty-gemini');
    await mkdir(geminiDir, { recursive: true });

    // 1. 先验证无 SQLite 仅 legacy usage-ledger.json 时 UsageLedger.range 容错降级
    const legacyOnlyDir = join(stateDir, 'legacy-only');
    await mkdir(legacyOnlyDir, { recursive: true });
    await writeFile(join(legacyOnlyDir, 'usage-ledger.json'), JSON.stringify({
      version: 2,
      events: [
        {
          event_key: 'a'.repeat(64),
          model: 'gemini-3.8-flash',
          input_tokens: 1000,
          output_tokens: 200,
          cached_tokens: 0,
          total_tokens: 1200,
          timestamp_seconds: tBase + 50,
        },
        {
          event_key: 'b'.repeat(64),
          model: 'gemini-3.8-flash',
          input_tokens: 1000,
          output_tokens: 200,
          cached_tokens: 0,
          total_tokens: 1200,
          timestamp_seconds: tBase + 5000, // 区间外
        },
      ],
    }));
    const legacyRange = await new UsageLedger(legacyOnlyDir).range({ startSec: tBase, endSec: tBase + 1000 });
    assert.equal(legacyRange.length, 1);
    assert.equal(legacyRange[0].event.event_key, 'a'.repeat(64));

    // 2. 真实 UsageStatsManager + UsageLedger.range 区间查询与只读费率锁检查
    const mgr = new UsageStatsManager({ stateDir, geminiDir });
    const evInRange = {
      event_key: createHash('sha256').update('range-in-1').digest('hex'),
      source_id: 'src-range-1',
      source_observed_at: tBase + 100,
      generation_index: 0,
      account_confidence: 'observed',
      account_id: 'acc-range',
      account_email: 'range@example.invalid',
      model: 'gemini-3.8-flash',
      input_tokens: 1_000_000,
      output_tokens: 0,
      cached_tokens: 0,
      total_tokens: 1_000_000,
      timestamp_seconds: tBase + 100,
      environment_kind: 'ssh',
      environment_id: 'ssh:lab',
      environment_label: 'lab',
    };
    const evUnpriced = {
      event_key: createHash('sha256').update('range-unpriced-1').digest('hex'),
      source_id: 'src-range-2',
      source_observed_at: tBase + 200,
      generation_index: 0,
      account_confidence: 'observed',
      account_id: 'acc-range',
      account_email: 'range@example.invalid',
      model: 'mystery-unpriced-v9',
      input_tokens: 500,
      output_tokens: 100,
      cached_tokens: 0,
      total_tokens: 600,
      timestamp_seconds: tBase + 200,
      environment_kind: 'local',
      environment_id: 'local',
    };
    const evOutOfRange = {
      event_key: createHash('sha256').update('range-out-1').digest('hex'),
      source_id: 'src-range-3',
      source_observed_at: tBase - 5000,
      generation_index: 0,
      account_confidence: 'observed',
      account_id: 'acc-range',
      account_email: 'range@example.invalid',
      model: 'gemini-3.8-flash',
      input_tokens: 1000,
      output_tokens: 200,
      cached_tokens: 0,
      total_tokens: 1200,
      timestamp_seconds: tBase - 5000,
      environment_kind: 'local',
      environment_id: 'local',
    };

    await mgr.ingestRemoteUsageBatch([evInRange, evUnpriced, evOutOfRange]);

    const rateLocksPath = join(stateDir, 'usage-rate-locks.json');
    const rateLocksBefore = existsSync(rateLocksPath) ? await readFile(rateLocksPath, 'utf8') : null;
    assert.equal(mgr.rateLocksDirty, false);

    // 直接校验 UsageLedger.range
    const rawLedgerRows = await mgr.ledger.range({ startSec: tBase, endSec: tBase + 500 });
    assert.equal(rawLedgerRows.length, 2);
    assert.equal(rawLedgerRows[0].event.event_key, evInRange.event_key);
    assert.ok(rawLedgerRows[0].unitPrice && rawLedgerRows[0].unitPrice.input > 0);
    assert.equal(rawLedgerRows[1].event.event_key, evUnpriced.event_key);
    assert.equal(rawLedgerRows[1].unitPrice, null);

    // 校验小账本模式下 getEventsWithCostsInRange（无 side-effect 不写脏 rateLocksDirty，不改动费率锁文件）
    const smallEvents = await mgr.getEventsWithCostsInRange(tBase, tBase + 500);
    assert.equal(smallEvents.length, 2);
    assert.equal(smallEvents[0].priced, true);
    assert.ok(typeof smallEvents[0].estimated_usd === 'number' && smallEvents[0].estimated_usd > 0);
    assert.equal(smallEvents[0].environment_kind, 'ssh');
    assert.equal(smallEvents[1].priced, false);
    assert.equal(smallEvents[1].estimated_usd, null);
    assert.equal(mgr.rateLocksDirty, false, 'getEventsWithCostsInRange 不得写脏 rateLocksDirty');
    assert.equal(
      existsSync(rateLocksPath) ? await readFile(rateLocksPath, 'utf8') : null,
      rateLocksBefore,
      'getEventsWithCostsInRange 不得修改 usage-rate-locks.json'
    );

    // 校验无费率锁 + 含 pendingLedgerEvents 时，getEventsWithCostsInRange 仍只读估算金额且绝不写脏/创建锁文件
    const roDir = join(stateDir, 'readonly-range');
    await mkdir(roDir, { recursive: true });
    const roMgr = new UsageStatsManager({ stateDir: roDir, geminiDir });
    const roSavedEv = { ...evInRange, event_key: createHash('sha256').update('ro-saved').digest('hex'), timestamp_seconds: tBase + 120 };
    const roPendingEv = { ...evInRange, event_key: createHash('sha256').update('ro-pending').digest('hex'), timestamp_seconds: tBase + 160 };
    await roMgr.ledger.save([roSavedEv]);
    roMgr.pendingLedgerEvents.set(roPendingEv.event_key, roPendingEv);
    const roEvents = await roMgr.getEventsWithCostsInRange(tBase, tBase + 500);
    assert.equal(roEvents.length, 2);
    assert.ok(roEvents.every(e => e.priced && typeof e.estimated_usd === 'number' && e.estimated_usd > 0));
    assert.equal(roMgr.rateLocksDirty, false);
    assert.equal(existsSync(join(roDir, 'usage-rate-locks.json')), false);

    // 校验大账本模式 (largeLedger = true) 走 SQLite range 查询依然返回精确事件与费用
    mgr.largeLedger = true;
    mgr.usageLedgerEvents.clear();
    const largeEvents = await mgr.getEventsWithCostsInRange(tBase, tBase + 500);
    assert.equal(largeEvents.length, 2);
    assert.equal(largeEvents[0].priced, true);
    assert.equal(largeEvents[0].estimated_usd, smallEvents[0].estimated_usd);
    assert.equal(largeEvents[1].priced, false);
    assert.equal(mgr.rateLocksDirty, false);
  });
});

test('dist/main.js IPC 集成：weekly_quota_usage / dashboard_summary / account_list 返回结构与账号筛选', async t => {
  await withTempDir(t, async dir => {
    const mockGeminiDir = join(dir, 'gemini');
    const mockHomeDir = join(dir, 'home');
    const mockAppSupportDir = join(dir, 'app-support');
    await mkdir(join(dir, '词典'), { recursive: true });
    await mkdir(join(mockGeminiDir, 'antigravity', 'conversations'), { recursive: true });
    await mkdir(mockHomeDir, { recursive: true });
    await mkdir(mockAppSupportDir, { recursive: true });

    const nowSec = Math.floor(Date.now() / 1000);
    const resetSec = nowSec + 5 * 86400;

    // 1. 写入两个真实账号（活跃账号与备用账号）
    const accMgr = new AccountsManager(dir);
    accMgr.probeLiveLanguageServer = async () => null;
    const activeAcc = await accMgr.upsertAccount({
      email: 'active-weekly@example.invalid',
      name: 'Active Weekly',
      refreshToken: 'synthetic-active-refresh',
      accessToken: 'synthetic-active-access',
      expiresIn: 3600,
    });
    activeAcc.quota = makeWeeklyQuota({
      observedAtSec: nowSec - 60,
      tier: 'PRO',
      geminiWeekly: { remaining: 0.84, resetTimeSec: resetSec },
      claudeWeekly: { remaining: 0.95, resetTimeSec: resetSec },
    });
    await accMgr.saveAccount(activeAcc);

    const standbyAcc = await accMgr.upsertAccount({
      email: 'standby-weekly@example.invalid',
      name: 'Standby Weekly',
      refreshToken: 'synthetic-standby-refresh',
      accessToken: 'synthetic-standby-access',
      expiresIn: 3600,
    });
    standbyAcc.quota = makeWeeklyQuota({
      observedAtSec: nowSec - 60,
      tier: 'PRO',
      geminiWeekly: { remaining: 0.60, resetTimeSec: resetSec },
    });
    await accMgr.saveAccount(standbyAcc);

    // 2. 写入历史快照（activeAcc 4 点递减，standbyAcc 2 点递减）
    const snapStore = new WeeklyQuotaSnapshotStore(dir);
    for (const [offset, rem] of [[1800, 1.00], [1400, 0.96], [1000, 0.92], [600, 0.88]]) {
      snapStore.recordQuotaSnapshot({
        email: activeAcc.email,
        observedAtSec: nowSec - offset,
        quota: makeWeeklyQuota({
          observedAtSec: nowSec - offset,
          tier: 'PRO',
          geminiWeekly: { remaining: rem, resetTimeSec: resetSec },
        }),
      });
    }
    snapStore.recordQuotaSnapshot({
      email: standbyAcc.email,
      observedAtSec: nowSec - 2000,
      quota: makeWeeklyQuota({
        observedAtSec: nowSec - 2000,
        tier: 'PRO',
        geminiWeekly: { remaining: 1.0, resetTimeSec: resetSec },
      }),
    });
    await snapStore.flush();

    // 3. 写入 activeAcc 的本地与 SSH 计费事件到 UsageLedger（standbyAcc 保持 0 事件）
    const usageMgr = new UsageStatsManager({ stateDir: dir, geminiDir: mockGeminiDir });
    const makePricedEvent = (label, ts, envKind) => ({
      event_key: createHash('sha256').update(label).digest('hex'),
      source_id: `src-${label}`,
      source_observed_at: ts,
      generation_index: 0,
      account_confidence: 'observed',
      account_id: activeAcc.id,
      account_email: activeAcc.email,
      model: 'gemini-3.8-flash',
      input_tokens: 1_000_000, // 0.75 / 1M
      output_tokens: 200_000,  // 3.75 / 1M => 0.75 + 0.75 = $1.50
      cached_tokens: 0,
      total_tokens: 1_200_000,
      timestamp_seconds: ts,
      environment_kind: envKind,
      environment_id: envKind === 'ssh' ? 'ssh:remote-box' : 'local',
      environment_label: envKind === 'ssh' ? 'remote-box' : 'local',
    });
    await usageMgr.ingestRemoteUsageBatch([
      makePricedEvent('ipc-w-1', nowSec - 1600, 'local'),
      makePricedEvent('ipc-w-2', nowSec - 1200, 'local'),
      makePricedEvent('ipc-w-3', nowSec - 800, 'ssh'),
    ]);

    // 4. 启动真实后台进程并通过 sendBackendRpc 校验 IPC
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../dist/main.js', import.meta.url)),
        '--state-dir', dir,
        '--app', '/nonexistent',
        '--profile', join(dir, 'profile'),
        '--gemini-dir', mockGeminiDir,
        '--home-dir', mockHomeDir,
        '--app-support-dir', mockAppSupportDir,
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          GRAVITYBOX_PROBE_LS: 'false',
          GRAVITYBOX_DISABLE_AUTO_PRICING_NETWORK: '1',
          GRAVITYBOX_DISABLE_AUTO_QUOTA_REFRESH: '1',
        },
      }
    );
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    t.after(() => stopBackendChild(child));

    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      try {
        const st = await sendBackendRpc(dir, { command: 'status' }, { timeoutMs: 2000 });
        if (st?.ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 40));
    }

    // 校验 weekly_quota_usage（全部账号）
    const allWeekly = await sendBackendRpc(dir, { command: 'weekly_quota_usage' });
    assert.equal(allWeekly.ok, true);
    assert.equal(typeof allWeekly.generatedAtSec, 'number');
    assert.equal(Array.isArray(allWeekly.accounts), true);
    assert.equal(allWeekly.accounts.length, 2);

    const activeWeekly = allWeekly.accounts[0];
    assert.equal(activeWeekly.email, activeAcc.email);
    const activeGemini = activeWeekly.pools.find(p => p.poolKey === 'gemini');
    assert.ok(activeGemini);
    assert.equal(activeGemini.totalUsedPct, 16);
    assert.equal(activeGemini.localRequests, 3);
    assert.equal(activeGemini.localTokens, 3_600_000);
    assert.ok(activeGemini.localUsd > 0);
    assert.equal(activeGemini.sshRequests, 1);
    assert.equal(activeGemini.sshTokens, 1_200_000);
    assert.ok(activeGemini.localEstimatedUsedPct !== null && activeGemini.localEstimatedUsedPct > 0);
    assert.equal(Array.isArray(activeGemini.recentCycles), true);

    const standbyWeekly = allWeekly.accounts[1];
    assert.equal(standbyWeekly.email, standbyAcc.email);
    assert.equal(standbyWeekly.pools[0].totalUsedPct, 40);
    assert.equal(standbyWeekly.pools[0].localEstimatedUsedPct, 0);
    assert.equal(standbyWeekly.pools[0].otherEstimatedUsedPct, 40);
    assert.equal(standbyWeekly.pools[0].confidence, 'high');

    // 校验按 accountId 筛选与不存在账号
    const singleWeekly = await sendBackendRpc(dir, { command: 'weekly_quota_usage', accountId: standbyAcc.id });
    assert.equal(singleWeekly.ok, true);
    assert.equal(singleWeekly.accounts.length, 1);
    assert.equal(singleWeekly.accounts[0].email, standbyAcc.email);

    const missingWeekly = await sendBackendRpc(dir, { command: 'weekly_quota_usage', accountId: 'nonexistent-id' });
    assert.equal(missingWeekly.ok, true);
    assert.deepEqual(missingWeekly.accounts, []);

    // 校验 dashboard_summary 附加活跃账号 weeklyAttribution
    const dash = await sendBackendRpc(dir, { command: 'dashboard_summary' });
    assert.equal(dash.ok, true);
    assert.ok(dash.accounts?.weeklyAttribution);
    assert.equal(dash.accounts.weeklyAttribution.email, activeAcc.email);
    assert.ok(dash.accounts.weeklyAttribution.pools.some(p => p.poolKey === 'gemini'));

    // 校验 account_list 附加各账号 weeklyAttribution
    const list = await sendBackendRpc(dir, { command: 'account_list' });
    assert.equal(list.ok, true);
    assert.equal(list.accounts.length, 2);
    assert.equal(list.accounts[0].weeklyAttribution?.email, activeAcc.email);
    assert.equal(list.accounts[1].weeklyAttribution?.email, standbyAcc.email);

    await sendBackendRpc(dir, { command: 'stop' });
    await stopBackendChild(child);
    assert.equal(stderr, '');
  });
});

test('ULTRA 冷启动 0.2%~0.5% 细粒度快速校准并回溯安装前历史消耗', async () => {
  await withNoNetworkFetch(async () => {
    const cycleStart = 1_795_000_000;
    const resetSec = cycleStart + WEEK_SEC;

    // 首个快照前已消耗 9.9%（remaining=0.901），随后 5 分钟短窗口仅再掉落 0.4%（0.901 -> 0.897）
    const stored = {
      email: 'ultra-cold-backfill@example.invalid',
      tier: 'ULTRA',
      pools: {
        gemini: {
          poolKey: 'gemini',
          displayName: 'Gemini',
          tier: 'ULTRA',
          cycles: [{
            cycleStartSec: cycleStart,
            resetTimeSec: resetSec,
            resetTimeIso: new Date(resetSec * 1000).toISOString(),
            tier: 'ULTRA',
            points: [
              { at: cycleStart + 3600, lastSeenAt: cycleStart + 3600, remaining: 0.901, source: 'cloud' },
              { at: cycleStart + 3900, lastSeenAt: cycleStart + 3900, remaining: 0.897, source: 'cloud' },
            ],
          }],
        },
      },
    };

    const events = [
      // 首个快照前周期初本地已累计高额用量 ($20.0)
      makeEvent({
        accountId: 'acc-ultra-1',
        accountEmail: 'ultra-cold-backfill@example.invalid',
        timestampSec: cycleStart + 1200,
        inputTokens: 10_000,
        outputTokens: 2_000,
        estimatedUsd: 10.0,
      }),
      makeEvent({
        accountId: 'acc-ultra-1',
        accountEmail: 'ultra-cold-backfill@example.invalid',
        timestampSec: cycleStart + 2400,
        inputTokens: 10_000,
        outputTokens: 2_000,
        estimatedUsd: 10.0,
      }),
      // 短窗口内本地调用 $2.00 触发 0.4% 掉额 -> usdPer1Pct = 2.0 / 0.4 = 5.0
      makeEvent({
        accountId: 'acc-ultra-1',
        accountEmail: 'ultra-cold-backfill@example.invalid',
        timestampSec: cycleStart + 3750,
        inputTokens: 2_000,
        outputTokens: 500,
        estimatedUsd: 2.0,
      }),
    ];

    const res = computeAccountWeeklyAttribution({
      accountId: 'acc-ultra-1',
      email: 'ultra-cold-backfill@example.invalid',
      tier: 'ULTRA',
      storedAccount: stored,
      events,
      nowSec: cycleStart + 4000,
    });

    assert.equal(res.pools.length, 1);
    const pool = res.pools[0];
    assert.equal(pool.totalUsedPct, 10.3);
    assert.equal(pool.calibrationSamples, 1);
    assert.equal(pool.usdPer1Pct, 5);
    assert.equal(pool.hasPreSnapshotEstimate, true);
    assert.equal(pool.ambiguousDropPct, 0);
    assert.notEqual(pool.localEstimatedUsedPct, null);
    assert.notEqual(pool.otherEstimatedUsedPct, null);
    assert.equal(pool.localEstimatedUsedPct, 4.4);
    assert.equal(pool.otherEstimatedUsedPct, 5.9);
    assert.equal(pool.confidence, 'low');
  });
});

test('冷启动微幅抖动（< 0.2%）未形成校准样本时保持 calibrating，绝不误报给其他端', async () => {
  await withNoNetworkFetch(async () => {
    const cycleStart = 1_795_000_000;
    const resetSec = cycleStart + WEEK_SEC;

    // 首个快照前已有 9.9% 消耗（remaining=0.901），后续短窗口仅掉落 0.1%（0.901 -> 0.900 < 0.2%）
    const stored = {
      email: 'cold-micro-jitter@example.invalid',
      tier: 'ULTRA',
      pools: {
        gemini: {
          poolKey: 'gemini',
          displayName: 'Gemini',
          tier: 'ULTRA',
          cycles: [{
            cycleStartSec: cycleStart,
            resetTimeSec: resetSec,
            resetTimeIso: new Date(resetSec * 1000).toISOString(),
            tier: 'ULTRA',
            points: [
              { at: cycleStart + 3600, lastSeenAt: cycleStart + 3600, remaining: 0.901, source: 'cloud' },
              { at: cycleStart + 3900, lastSeenAt: cycleStart + 3900, remaining: 0.900, source: 'cloud' },
            ],
          }],
        },
      },
    };

    const events = [
      makeEvent({
        accountId: 'acc-jitter',
        accountEmail: 'cold-micro-jitter@example.invalid',
        timestampSec: cycleStart + 1500,
        inputTokens: 10_000,
        outputTokens: 2_000,
        estimatedUsd: 20.0,
      }),
      makeEvent({
        accountId: 'acc-jitter',
        accountEmail: 'cold-micro-jitter@example.invalid',
        timestampSec: cycleStart + 3750,
        inputTokens: 1_000,
        outputTokens: 200,
        estimatedUsd: 0.5,
      }),
    ];

    const res = computeAccountWeeklyAttribution({
      accountId: 'acc-jitter',
      email: 'cold-micro-jitter@example.invalid',
      tier: 'ULTRA',
      storedAccount: stored,
      events,
      nowSec: cycleStart + 4000,
    });

    const pool = res.pools[0];
    assert.equal(pool.totalUsedPct, 10);
    assert.equal(pool.calibrationSamples, 0);
    assert.equal(pool.usdPer1Pct, null);
    assert.equal(pool.hasPreSnapshotEstimate, false);
    assert.equal(pool.confidence, 'calibrating');
    assert.equal(pool.localEstimatedUsedPct, null);
    assert.equal(pool.otherEstimatedUsedPct, null);
    assert.equal(pool.ambiguousDropPct, 9.9);
  });
});

test('未定价模型 Token 速率兜底（tokensPer1Pct）：冷启动回溯、长区间估算、数学守恒与置信度降级', async () => {
  await withNoNetworkFetch(async () => {
    const cycleStart = 1_795_000_000;
    const resetSec = cycleStart + WEEK_SEC;

    // 场景 A：全未定价模型，先通过两个短区间建立 tokensPer1Pct = 1000 tokens/1%，再估算冷启动前与长混杂区间
    const stored = {
      email: 'token-fallback@example.invalid',
      tier: 'PRO',
      pools: {
        gemini: {
          poolKey: 'gemini',
          displayName: 'Gemini',
          tier: 'PRO',
          cycles: [{
            cycleStartSec: cycleStart,
            resetTimeSec: resetSec,
            resetTimeIso: new Date(resetSec * 1000).toISOString(),
            tier: 'PRO',
            points: [
              // 冷启动前掉落 4%
              { at: cycleStart + 3600, lastSeenAt: cycleStart + 3600, remaining: 0.96, source: 'cloud' },
              // 短区间 1（300s）掉落 2%
              { at: cycleStart + 3900, lastSeenAt: cycleStart + 3900, remaining: 0.94, source: 'cloud' },
              // 短区间 2（300s）掉落 2%
              { at: cycleStart + 4200, lastSeenAt: cycleStart + 4200, remaining: 0.92, source: 'cloud' },
              // 长混杂区间（3600s > 15min）掉落 10%
              { at: cycleStart + 7800, lastSeenAt: cycleStart + 7800, remaining: 0.82, source: 'cloud' },
            ],
          }],
        },
      },
    };

    const events = [
      // 冷启动前：2000 tokens -> 2% 本地 / 2% 他端
      makeEvent({
        accountId: 'acc-tok',
        accountEmail: 'token-fallback@example.invalid',
        model: 'custom-unpriced-gemini-exp',
        timestampSec: cycleStart + 1000,
        inputTokens: 1600,
        outputTokens: 400,
        estimatedUsd: null,
        priced: false,
      }),
      // 短区间 1：2000 tokens / 2% = 1000 tokens/1%
      makeEvent({
        accountId: 'acc-tok',
        accountEmail: 'token-fallback@example.invalid',
        model: 'custom-unpriced-gemini-exp',
        timestampSec: cycleStart + 3750,
        inputTokens: 1600,
        outputTokens: 400,
        estimatedUsd: null,
        priced: false,
      }),
      // 短区间 2：2000 tokens / 2% = 1000 tokens/1%
      makeEvent({
        accountId: 'acc-tok',
        accountEmail: 'token-fallback@example.invalid',
        model: 'custom-unpriced-gemini-exp',
        timestampSec: cycleStart + 4050,
        inputTokens: 1600,
        outputTokens: 400,
        estimatedUsd: null,
        priced: false,
      }),
      // 长混杂区间：3000 tokens -> 3% 本地 / 7% 他端
      makeEvent({
        accountId: 'acc-tok',
        accountEmail: 'token-fallback@example.invalid',
        model: 'custom-unpriced-gemini-exp',
        timestampSec: cycleStart + 5000,
        inputTokens: 2400,
        outputTokens: 600,
        estimatedUsd: null,
        priced: false,
      }),
    ];

    const res = computeAccountWeeklyAttribution({
      accountId: 'acc-tok',
      email: 'token-fallback@example.invalid',
      tier: 'PRO',
      storedAccount: stored,
      events,
      nowSec: cycleStart + 8000,
    });

    const pool = res.pools[0];
    assert.equal(pool.totalUsedPct, 18);
    assert.equal(pool.usdPer1Pct, null);
    assert.equal(pool.calibrationSamples, 2);
    assert.equal(pool.unpricedRequests, 4);
    assert.equal(pool.hasPreSnapshotEstimate, true);
    assert.equal(pool.ambiguousDropPct, 0);
    assert.equal(pool.localEstimatedUsedPct, 9);
    assert.equal(pool.otherEstimatedUsedPct, 9);
    assert.notEqual(pool.confidence, 'high');
    assert.equal(pool.confidence, 'low');
    assert.ok(pool.localEstimatedUsedPct >= 0 && pool.localEstimatedUsedPct <= pool.totalUsedPct);
    assert.ok(Math.abs(pool.localEstimatedUsedPct + pool.otherEstimatedUsedPct - pool.totalUsedPct) <= 0.11);

    // 场景 B：仅存在 USD 样本（无 token 样本），未归因的未定价冷启动前掉额不计入 otherEstimatedUsedPct
    const partialStored = {
      email: 'ambiguous-isolation@example.invalid',
      tier: 'PRO',
      pools: {
        gemini: {
          poolKey: 'gemini',
          displayName: 'Gemini',
          tier: 'PRO',
          cycles: [{
            cycleStartSec: cycleStart,
            resetTimeSec: resetSec,
            resetTimeIso: new Date(resetSec * 1000).toISOString(),
            tier: 'PRO',
            points: [
              // 冷启动前掉落 5%（内含 1 条未定价事件且无 token 速率 -> ambiguousDrop = 5%）
              { at: cycleStart + 3600, lastSeenAt: cycleStart + 3600, remaining: 0.95, source: 'cloud' },
              // 短区间（300s）掉落 2%，已定价 $1.0 但 tokens < 100（不产生 token 样本）
              { at: cycleStart + 3900, lastSeenAt: cycleStart + 3900, remaining: 0.93, source: 'cloud' },
            ],
          }],
        },
      },
    };
    const partialRes = computeAccountWeeklyAttribution({
      accountId: 'acc-partial',
      email: 'ambiguous-isolation@example.invalid',
      tier: 'PRO',
      storedAccount: partialStored,
      events: [
        makeEvent({
          accountId: 'acc-partial',
          accountEmail: 'ambiguous-isolation@example.invalid',
          model: 'custom-unpriced-gemini-exp',
          timestampSec: cycleStart + 1000,
          inputTokens: 400,
          outputTokens: 100,
          estimatedUsd: null,
          priced: false,
        }),
        makeEvent({
          accountId: 'acc-partial',
          accountEmail: 'ambiguous-isolation@example.invalid',
          model: 'gemini-3.8-flash',
          timestampSec: cycleStart + 3750,
          inputTokens: 40,
          outputTokens: 10,
          estimatedUsd: 1.0,
        }),
      ],
      nowSec: cycleStart + 4000,
    });
    const partialPool = partialRes.pools[0];
    assert.equal(partialPool.totalUsedPct, 7);
    assert.equal(partialPool.localEstimatedUsedPct, 2);
    assert.equal(partialPool.otherEstimatedUsedPct, 0);
    assert.equal(partialPool.ambiguousDropPct, 5);
    assert.equal(partialPool.confidence, 'low');
  });
});
