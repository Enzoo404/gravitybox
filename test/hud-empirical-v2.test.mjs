import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  computeCascadeContextBreakdown,
  computeTps,
  parseProtobufTimestamp,
  parseStepMetadataBlob,
  parseLatestGenMetadataBlob,
  ConversationMetricsEngine
} from '../dist/hud.js';

const { DatabaseSync } = await import('node:sqlite');

function encodeVarint(val) {
  const bytes = [];
  let v = BigInt(val);
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return bytes;
}

function encodeStringField(fieldNum, str) {
  const buf = Buffer.from(str, 'utf8');
  return [...encodeVarint((fieldNum << 3) | 2), ...encodeVarint(buf.length), ...buf];
}

function encodeTimestampField(fieldNum, seconds, nanos = 0) {
  const inner = [
    0x08, ...encodeVarint(seconds),
    0x10, ...encodeVarint(nanos)
  ];
  return [(fieldNum << 3) | 2, ...encodeVarint(inner.length), ...inner];
}

function encodeUsageField9({ rawInput = 0, outputTokens = 0, cacheWriteTokens = 0, cachedTokens = 0, reasoningTokens = 0, candidateTokens = 0 }) {
  const inner = [
    (2 << 3) | 0, ...encodeVarint(rawInput),
    (3 << 3) | 0, ...encodeVarint(outputTokens),
    (4 << 3) | 0, ...encodeVarint(cacheWriteTokens),
    (5 << 3) | 0, ...encodeVarint(cachedTokens),
    (9 << 3) | 0, ...encodeVarint(reasoningTokens),
    (10 << 3) | 0, ...encodeVarint(candidateTokens)
  ];
  return [(9 << 3) | 2, ...encodeVarint(inner.length), ...inner];
}

test('复验 1: 级联独立裁剪纯数学模型在各种极端边界下非负性与严格守恒性', () => {
  const testCapacities = [200000, 262144, 128000, 1048576];
  const testInputs = [
    0, 1, 500, 1900, 1901, 5000, 9500, 9501, 150000, 200000, 226000
  ];

  for (const cap of testCapacities) {
    for (const u of testInputs) {
      const res = computeCascadeContextBreakdown(u, cap);
      assert.ok(res.T_sys >= 0);
      assert.ok(res.T_tool >= 0);
      assert.ok(res.T_msg >= 0);
      assert.ok(res.W_sys >= 0);
      assert.ok(res.W_tool >= 0);
      assert.ok(res.W_msg >= 0);
      assert.equal(res.sumT, u, `Token 分配总和必须严格等于输入 U (u=${u}, cap=${cap})`);

      if (u <= cap) {
        assert.ok(Math.abs(res.sumW - res.Ratio_total) < 1e-9);
      }
    }
  }
});

test('复验 2: parseLatestGenMetadataBlob 真实解析 gen_metadata 模型标识、ContextWindowMetadata 与权威流式 Duration', () => {
  // 构造 ChatStartMetadata (field 9) -> ContextWindowMetadata (field 10: field 1 estimated=185000, field 4 max=200000)
  const cwMeta = [
    (1 << 3) | 0, ...encodeVarint(185000),
    (4 << 3) | 0, ...encodeVarint(200000),
  ];
  const chatStartMeta = [
    (10 << 3) | 2, ...encodeVarint(cwMeta.length), ...cwMeta,
  ];
  const chatModelMeta = [
    ...encodeStringField(19, 'gemini-3.8-flash-tiered'),
    ...encodeStringField(21, 'Gemini 3.8 Flash'),
    (9 << 3) | 2, ...encodeVarint(chatStartMeta.length), ...chatStartMeta,
    ...encodeTimestampField(11, 2, 500_000_000), // field 11: time_to_first_token = 2.5s
    ...encodeTimestampField(12, 8, 250_000_000), // field 12: streaming_duration = 8.25s
  ];
  const genBlob = new Uint8Array([
    (1 << 3) | 2, ...encodeVarint(chatModelMeta.length), ...chatModelMeta,
  ]);

  const parsed = parseLatestGenMetadataBlob(genBlob);
  assert.equal(parsed.responseModel, 'gemini-3.8-flash-tiered');
  assert.equal(parsed.modelDisplayName, 'Gemini 3.8 Flash');
  assert.equal(parsed.estimatedTokensUsed, 185000);
  assert.equal(parsed.maxContextTokens, 200000);
  assert.equal(parsed.timeToFirstTokenSeconds, 2.5);
  assert.equal(parsed.streamingDurationSeconds, 8.25);
});

test('复验 3: 有效输出速度保留原始精度、拒绝无效耗时且不设置人为速度上限', () => {
  assert.equal(computeTps(0, 100).status, 'pending_or_fallback');
  assert.equal(computeTps(NaN, 100).formatted, '—');
  assert.equal(computeTps(2, Infinity).formatted, '—');
  assert.equal(computeTps(0.05, 50).outputTps, 1000);
  assert.equal(computeTps(0.1, 100).formatted, '1000.00 tok/s');
  const normal = computeTps(3, 100);
  assert.equal(normal.outputTps, 100 / 3);
  assert.equal(normal.formatted, '33.33 tok/s');
});

test('复验 4: 64 位 BigInt 无符号 Varint 解码、未知 WireType 跳过与 Protobuf 完整解析', () => {
  const sec = 1794282255n;
  const nanos = 123456789n;
  const tsBytes = new Uint8Array([
    0x08, ...encodeVarint(sec),
    0x10, ...encodeVarint(nanos)
  ]);
  const parsedTs = parseProtobufTimestamp(tsBytes);
  const expectedTs = Number(sec) + Number(nanos) / 1e9;
  assert.ok(Math.abs(parsedTs - expectedTs) < 1e-6);

  const date = new Date(parsedTs * 1000);
  assert.equal(Number.isNaN(date.getTime()), false);
  assert.equal(date.getUTCFullYear(), 2026);

  // 验证完整 step metadata blob 解码 (含 field 1, 6, 8, 9 及夹杂 wireType 5 固定 32 位字段)
  const blob = new Uint8Array([
    ...encodeTimestampField(1, 1794282200, 0),
    (3 << 3) | 5, 0x01, 0x02, 0x03, 0x04, // wireType 5 未知字段应安全跳过
    ...encodeTimestampField(6, 1794282205, 500_000_000),
    ...encodeTimestampField(8, 1794282215, 500_000_000),
    ...encodeUsageField9({
      rawInput: 24000,
      outputTokens: 600,
      cacheWriteTokens: 0,
      cachedTokens: 48000,
      reasoningTokens: 200,
      candidateTokens: 400
    })
  ]);
  const step = parseStepMetadataBlob(10, 15, 2, blob);
  assert.equal(step.startTimeSeconds, 1794282200);
  assert.equal(step.firstTokenSeconds, 1794282205.5);
  assert.equal(step.endTimeSeconds, 1794282215.5);
  assert.equal(step.rawInputTokens, 24000);
  assert.equal(step.cachedReadTokens, 48000);
  assert.equal(step.outputTokens, 600);
  assert.equal(step.reasoningTokens + step.candidateTokens, step.outputTokens);
});

test('复验 5: ConversationMetricsEngine 两级 lstat 门控、子智能体会话聚合与 SQLite 单语句增量读取验证', async () => {
  const tmpDir = path.join(os.tmpdir(), `gravitybox-hud-engine-${Date.now()}`);
  const convDir = path.join(tmpDir, 'antigravity', 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  const convId = '4ec6348d-0f58-49db-8aed-6f67dbb78f5d';
  const childConvId = '99999999-1111-4444-8888-aaaaaaaaaaaa';
  const dbFile = path.join(convDir, `${convId}.db`);
  const childDbFile = path.join(convDir, `${childConvId}.db`);

  try {
    const db = new DatabaseSync(dbFile);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE steps (
        idx INTEGER PRIMARY KEY,
        step_type INTEGER NOT NULL,
        status INTEGER NOT NULL,
        metadata BLOB,
        data BLOB
      );
      CREATE TABLE gen_metadata (
        idx INTEGER PRIMARY KEY,
        data BLOB
      );
    `);

    const step1Blob = Buffer.from([
      ...encodeTimestampField(1, 1794282000, 0),
      ...encodeTimestampField(6, 1794282002, 0),
      ...encodeTimestampField(8, 1794282012, 0),
      ...encodeUsageField9({
        rawInput: 10000,
        cachedTokens: 90000,
        outputTokens: 500,
        reasoningTokens: 100,
        candidateTokens: 400
      })
    ]);

    db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(1, 14, 3, null);
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(2, 15, 3, step1Blob);

    const engine = new ConversationMetricsEngine({ geminiDir: tmpDir });
    const m1 = await engine.getConversationMetrics({
      conversationId: convId,
      sessionRevision: 1,
      modelId: 'gemini-3.8-flash',
      isStreaming: false
    });

    assert.equal(m1.session.turns, 1);
    assert.equal(m1.session.steps, 2);
    assert.equal(m1.tokens.totalTokens, 100500);
    assert.equal(m1.tokens.cacheHitRateFormatted, '90.00%');
    assert.equal(m1.session.outputTpsFormatted, '41.67 tok/s');
    assert.equal(m1.context.usedTokens, 100000);
    assert.equal(m1.context.capacityTokens, 200000);
    assert.equal(m1.context.usedRatioFormatted, '50.00%');
    assert.equal(m1.context.breakdown.cachedContextTokens, 90000);
    assert.equal(m1.context.breakdown.uncachedContextTokens, 10000);

    // 验证宿主执行 wal_checkpoint(TRUNCATE) 绝不被阻塞 (busy: 0)
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    assert.equal(checkpoint.busy, 0, 'ConversationMetricsEngine 单语句 Auto-Commit 绝不阻塞 wal_checkpoint');

    // 追加新步骤并模拟启动一个子智能体 (step_type = 127 INVOKE_SUBAGENT，引用 childConvId)
    const step2Blob = Buffer.from([
      ...encodeTimestampField(1, 1794282020, 0),
      ...encodeTimestampField(6, 1794282021, 0),
      ...encodeTimestampField(8, 1794282031, 0),
      ...encodeUsageField9({
        rawInput: 20000,
        cachedTokens: 180000,
        outputTokens: 1000,
        reasoningTokens: 300,
        candidateTokens: 700
      })
    ]);
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(3, 15, 3, step2Blob);

    // 建立子智能体会话数据库 childDbFile (正在运行 status = 2)
    const childDb = new DatabaseSync(childDbFile);
    childDb.exec(`
      CREATE TABLE steps (
        idx INTEGER PRIMARY KEY,
        step_type INTEGER NOT NULL,
        status INTEGER NOT NULL,
        metadata BLOB
      );
    `);
    const childStepBlob = Buffer.from([
      ...encodeTimestampField(1, 1794282032, 0),
      ...encodeTimestampField(6, 1794282033, 0),

      ...encodeUsageField9({
        rawInput: 5000,
        cachedTokens: 45000,
        outputTokens: 250,
        reasoningTokens: 50,
        candidateTokens: 200
      })
    ]);
    childDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(1, 14, 3, null);
    childDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(2, 15, 2, childStepBlob);

    const subagentDataBlob = Buffer.from(encodeStringField(5, childConvId));
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata, data) VALUES (?, ?, ?, ?, ?)').run(
      4,
      127,
      2,
      null,
      subagentDataBlob
    );

    const m2 = await engine.getConversationMetrics({
      conversationId: convId,
      sessionRevision: 2,
      modelId: 'gemini-3.8-flash',
      isStreaming: false
    });
    // 主会话 4 步 + 子会话 2 步 = 6 步；且子智能体正在运行，isSubagentRunning & isStreaming 自动为 true
    assert.equal(m2.session.steps, 6, '总步数应包含关联子智能体会话的步数');
    assert.equal(m2.session.subagentSteps, 2, 'subagentSteps 应精确报告子智能体完整步数而非残差');
    assert.equal(m2.isSubagentRunning, true, 'SQLite 中子智能体步骤未完成时应自动标记 isSubagentRunning=true');
    assert.equal(m2.isStreaming, true, '子智能体运行时 isStreaming 必须为 true');
    assert.equal(m2.tokens.totalTokens, 100500 + 201000 + 50250, '累计 Token 应自动汇总子智能体消耗');
    // 主会话当前单步上下文仍保持主会话最后一步的 200,000 tok (100%)，不被子智能体的 50,000 tok 覆盖
    assert.equal(m2.context.usedTokens, 200000);
    assert.equal(m2.context.usedRatioFormatted, '100.00%');

    // 验证 Antigravity 2.30.0 真实表结构 (无 data 列，使用 render_info + trajectory_metadata_blob) 与防无关 UUID 串号污染
    const realMainId = '11111111-2222-4333-8444-555555555555';
    const realChildId = '66666666-7777-4888-8999-000000000000';
    const unrelatedId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const realMainDb = new DatabaseSync(path.join(convDir, `${realMainId}.db`));
    realMainDb.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL, metadata BLOB, render_info BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0);
    `);
    realMainDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?)').run('ffffffff-1111-4222-8333-444444444444', realMainId, 1);
    realMainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(0, 14, 3, null);
    // 普通 run_command 工具参数中出现 unrelatedId，绝不能被误判为子智能体
    const runCmdToolCall = [
      ...encodeStringField(2, 'run_command'),
      ...encodeStringField(3, JSON.stringify({ cmd: `echo ${unrelatedId}` })),
    ];
    const runCmdMeta = Buffer.from([
      ...encodeTimestampField(1, 1794283000, 0),
      ...encodeTimestampField(8, 1794283001, 0),
      (4 << 3) | 2, ...encodeVarint(runCmdToolCall.length), ...runCmdToolCall,
    ]);
    realMainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(1, 132, 3, runCmdMeta);
    // 真实 invoke_subagent 步骤：子会话 ID 存放在 render_info 列
    const invokeToolCall = [
      ...encodeStringField(2, 'invoke_subagent'),
      ...encodeStringField(3, JSON.stringify({ role: 'Investigator' })),
    ];
    const invokeMeta = Buffer.from([
      ...encodeTimestampField(1, 1794283002, 0),
      ...encodeTimestampField(8, 1794283010, 0),
      (4 << 3) | 2, ...encodeVarint(invokeToolCall.length), ...invokeToolCall,
    ]);
    const invokeRenderInfo = Buffer.from(encodeStringField(1, realChildId));
    realMainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata, render_info) VALUES (?, ?, ?, ?, ?)').run(2, 132, 3, invokeMeta, invokeRenderInfo);

    // 创建无关会话数据库 (含 999,999 token，其 trajectory_metadata_blob 不指向 realMainId)
    const unrelatedDb = new DatabaseSync(path.join(convDir, `${unrelatedId}.db`));
    unrelatedDb.exec(`
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL, metadata BLOB);
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
    `);
    unrelatedDb.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', Buffer.from(encodeStringField(5, unrelatedId)));
    unrelatedDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(1, 15, 3, Buffer.from(encodeUsageField9({ rawInput: 999999, outputTokens: 1 })));

    // 创建真实子智能体数据库 (其 trajectory_metadata_blob 指向父会话 realMainId)
    const realChildDb = new DatabaseSync(path.join(convDir, `${realChildId}.db`));
    realChildDb.exec(`
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL, metadata BLOB);
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
    `);
    realChildDb.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', Buffer.from(encodeStringField(5, realMainId)));
    realChildDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(1, 15, 3, Buffer.from([
      ...encodeTimestampField(1, 1794283003, 0),
      ...encodeTimestampField(8, 1794283009, 0),
      ...encodeUsageField9({ rawInput: 4000, cachedTokens: 16000, outputTokens: 200, reasoningTokens: 50, candidateTokens: 150 })
    ]));

    const mReal = await engine.getConversationMetrics({
      conversationId: realMainId,
      sessionRevision: 1,
      modelId: 'gemini-3.8-flash',
    });
    assert.equal(mReal.session.subagentCount, 1, '仅归属核验通过的真实子智能体计入 subagentCount，run_command 中的无关 UUID 被拦截');
    assert.equal(mReal.session.subagentSteps, 1);
    assert.equal(mReal.session.steps, 4, '主会话 3 步 + 真实子智能体 1 步 = 4 步');
    assert.equal(mReal.tokens.totalTokens, 20200, '绝不混入 unrelatedDb 的 1,000,000 token');

    realChildDb.close();
    unrelatedDb.close();
    realMainDb.close();
    engine.clearCache();
    childDb.close();
    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
