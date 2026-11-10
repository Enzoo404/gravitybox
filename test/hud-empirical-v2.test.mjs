import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  computeCascadeContextBreakdown,
  computeTps,
  parseProtobufTimestamp,
  parseStepMetadataBlob,
  ConversationMetricsEngine
} from '../dist/hud.js';

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

test('复验 1: 级联独立裁剪模型在各种极端边界下非负性与严格守恒性', () => {
  const testCapacities = [1048576, 2097152, 200000, 128000];
  const testInputs = [
    0, 1, 500, 1900, 1901, 5000, 9500, 9501, 426000, 662500, 672000, 1048576, 1500000
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

  const caseC = computeCascadeContextBreakdown(500, 1048576);
  assert.equal(caseC.T_sys, 500);
  assert.equal(caseC.T_tool, 0);
  assert.equal(caseC.T_msg, 0);
  assert.equal(caseC.W_msg, 0, 'Case C 下 W_msg 必须精确为 0%，绝不能为负数！');
});

test('复验 2: 截图 4 数学严密守恒对账与图例明细验证', () => {
  const U = 672000;
  const C = 1048576;
  const res = computeCascadeContextBreakdown(U, C);

  assert.equal(res.T_sys, 1900);
  assert.equal(res.T_tool, 7600);
  assert.equal(res.T_msg, 662500);
  assert.equal(res.T_sys + res.T_tool + res.T_msg, 672000);

  const totalRounded = Math.round(res.Ratio_total);
  assert.equal(totalRounded, 64, '截图 4 顶部显示 64% 严格匹配');
  assert.equal(res.W_msg.toFixed(2), '63.18');
});

test('复验 3: TPS 瞬时时间窗口截断与 500 tok/s 上限拦截', () => {
  const instant = computeTps(0.001, 100);
  assert.equal(instant.status, 'pending_or_fallback');
  assert.equal(instant.formatted, '—');

  const shortT = computeTps(0.05, 50);
  assert.equal(shortT.status, 'pending_or_fallback');

  const capped = computeTps(0.1, 100);
  assert.equal(capped.status, 'calculated');
  assert.equal(capped.outputTps, 500, '超过 500 tok/s 时必须被拦截在物理上限 500');
  assert.equal(capped.formatted, '500 tok/s');

  const normal = computeTps(2.0, 180);
  assert.equal(normal.status, 'calculated');
  assert.equal(normal.outputTps, 90);
  assert.equal(normal.formatted, '90 tok/s');
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

test('复验 5: ConversationMetricsEngine 两级 lstat 门控与 SQLite 单语句增量读取验证', async () => {
  const tmpDir = path.join(os.tmpdir(), `gravitybox-hud-engine-${Date.now()}`);
  const convDir = path.join(tmpDir, 'antigravity', 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  const convId = '4ec6348d-0f58-49db-8aed-6f67dbb78f5d';
  const dbFile = path.join(convDir, `${convId}.db`);

  try {
    const db = new DatabaseSync(dbFile);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE steps (
        idx INTEGER PRIMARY KEY,
        step_type INTEGER NOT NULL,
        status INTEGER NOT NULL,
        metadata BLOB
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

    db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(1, 101, 2, null);
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(2, 15, 2, step1Blob);

    const engine = new ConversationMetricsEngine({ geminiDir: tmpDir });
    const m1 = await engine.getConversationMetrics({
      conversationId: convId,
      sessionRevision: 1,
      modelId: 'gemini-4-argon',
      isStreaming: false
    });

    assert.equal(m1.session.turns, 1);
    assert.equal(m1.session.steps, 2);
    assert.equal(m1.tokens.totalTokens, 100500);
    assert.equal(m1.tokens.cacheHitRateFormatted, '90%');
    assert.equal(m1.session.outputTpsFormatted, '50 tok/s');

    // 验证宿主执行 wal_checkpoint(TRUNCATE) 绝不被阻塞 (busy: 0)
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    assert.equal(checkpoint.busy, 0, 'ConversationMetricsEngine 单语句 Auto-Commit 绝不阻塞 wal_checkpoint');

    // 追加新步骤并验证增量读取
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
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(3, 15, 2, step2Blob);

    const m2 = await engine.getConversationMetrics({
      conversationId: convId,
      sessionRevision: 2,
      modelId: 'gemini-4-argon',
      isStreaming: false
    });
    assert.equal(m2.session.steps, 3);
    assert.equal(m2.tokens.totalTokens, 100500 + 201000);
    assert.equal(m2.context.usedTokens, 200000);

    engine.clearCache();
    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
