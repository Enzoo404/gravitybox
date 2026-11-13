import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildConversationHudMetrics,
  computeTps,
  formatTurnDurationCard,
  formatTurnDurationCompact,
  parseLatestGenMetadataBlob,
  ConversationMetricsEngine,
} from '../dist/hud.js';

const { DatabaseSync } = await import('node:sqlite');

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  return bytes;
}
const scalar = (field, value) => [...varint(field * 8), ...varint(value)];
const message = (field, bytes) => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
const string = (field, value) => message(field, Buffer.from(value));
function seconds(field, value) {
  const whole = Math.floor(value);
  return message(field, [...scalar(1, whole), ...scalar(2, Math.round((value - whole) * 1e9))]);
}

function usage(overrides = {}) {
  return {
    rawInputTokens: 100, cachedReadTokens: 200, cacheWriteTokens: 30,
    outputTokens: 120, reasoningTokens: 80, candidateTokens: 40,
    ...overrides,
  };
}
function usageBytes(value) {
  return [
    ...scalar(2, value.rawInputTokens), ...scalar(3, value.outputTokens),
    ...scalar(4, value.cacheWriteTokens), ...scalar(5, value.cachedReadTokens),
    ...scalar(9, value.reasoningTokens), ...scalar(10, value.candidateTokens),
  ];
}
function step(overrides = {}) {
  return {
    idx: 50, stepType: 15, status: 3, hasUsage: true,
    startTimeSeconds: 100, firstTokenSeconds: 109, endTimeSeconds: 110,
    ...usage(), ...overrides,
  };
}
const metrics = (steps, overrides = {}) => buildConversationHudMetrics({
  conversationId: 'precision', sessionRevision: 1, modelId: 'gemini-3.8-flash',
  steps, ...overrides,
});
function closeTo(actual, expected, label = '') {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
}

test('TPS uses total output / total full request duration, not a mean of step rates', () => {
  const result = metrics([
    step({ outputTokens: 100, generation: { timeToFirstTokenSeconds: 2, streamingDurationSeconds: 8 } }),
    step({ idx: 51, outputTokens: 900, generation: { timeToFirstTokenSeconds: 0.5, streamingDurationSeconds: 1.5 } }),
  ]);
  closeTo(result.session.outputTps, 1000 / 12, 'weighted TPS');
  assert.notEqual(result.session.outputTps, (100 / 10 + 900 / 2) / 2);
  assert.equal(result.session.modelDurationSeconds, 12);
  assert.equal(result.session.outputTpsFormatted, '83.33 tok/s');
});

test('authoritative generation durations beat timestamps and never infer thinking phases', () => {
  const result = metrics([step({
    outputTokens: 65352, reasoningTokens: 50329, candidateTokens: 15023,
    startTimeSeconds: 100, firstTokenSeconds: 1278.91, endTimeSeconds: 1463,
    generation: { timeToFirstTokenSeconds: 2.25, streamingDurationSeconds: 7.75 },
  })]);
  assert.equal(result.session.modelDurationSeconds, 10);
  assert.equal(result.session.outputTps, 6535.2);
  assert.equal(result.session.averageTtftSeconds, 2.25);
  const fallback = metrics([step({
    outputTokens: 65352, reasoningTokens: 50329, candidateTokens: 15023,
    startTimeSeconds: 100, firstTokenSeconds: 1278.91, endTimeSeconds: 1463,
  })]);
  closeTo(fallback.session.outputTps, 65352 / 1363);
  closeTo(fallback.session.averageTtftSeconds, 1178.91);
});

test('missing timing, active steps and missing usage never leak output into the timed numerator', () => {
  const result = metrics([
    step({ outputTokens: 120 }),
    step({ idx: 51, startTimeSeconds: null, endTimeSeconds: null, outputTokens: 9000 }),
    ...[1, 2, 8, 9].map((status, i) => step({
      idx: 52 + i, status, outputTokens: 1000,
      generation: { timeToFirstTokenSeconds: 1, streamingDurationSeconds: 1 },
    })),
    step({ idx: 56, hasUsage: false, outputTokens: 3000 }),
  ]);
  assert.equal(result.tokens.outputTokens, 16120, 'the cumulative ledger still includes reported output');
  assert.equal(result.session.outputTps, 12);
  assert.equal(result.session.modelDurationSeconds, 20, 'completed duration without usage remains observable');
  assert.equal(result.session.averageTtftSeconds, 9);
});

test('zero output with valid usage contributes its completed duration', () => {
  const result = metrics([step({ outputTokens: 100 }), step({ idx: 51, outputTokens: 0 })]);
  assert.equal(result.session.outputTps, 5);
});

test('raw TTFT zero survives protobuf parsing and participates in the average', () => {
  const raw = parseLatestGenMetadataBlob(Buffer.from(message(1, [
    ...message(11, []), ...seconds(12, 2),
  ])));
  assert.equal(raw.timeToFirstTokenSeconds, 0, 'an empty Duration is an explicit zero');
  const zero = metrics([step({ generation: raw })]);
  assert.equal(zero.session.averageTtftSeconds, 0);
  assert.equal(zero.session.averageTtftFormatted, '0.00 秒');
  assert.equal(zero.session.averageTtftFormattedEn, '0.00s');
  const average = metrics([
    step({ generation: raw }),
    step({ idx: 51, firstTokenSeconds: 104 }),
    step({ idx: 52, firstTokenSeconds: null }),
    step({ idx: 53, status: 2, generation: { timeToFirstTokenSeconds: 100 } }),
  ]);
  assert.equal(average.session.averageTtftSeconds, 2);
});

test('incomplete raw duration pairs fall back to step timestamps, while raw TTFT stays authoritative', () => {
  const result = metrics([step({ generation: { timeToFirstTokenSeconds: 0 } })]);
  assert.equal(result.session.outputTps, 12);
  assert.equal(result.session.modelDurationSeconds, 10);
  assert.equal(result.session.averageTtftSeconds, 0);
});

test('TPS has no 500 tok/s cap or artificial minimum duration', () => {
  const result = computeTps(0.001, 100);
  assert.equal(result.status, 'calculated');
  assert.equal(result.rawTps, 100000);
  assert.equal(result.outputTps, 100000);
  assert.equal(result.formatted, '100000.00 tok/s');
  assert.equal(metrics([step({
    outputTokens: 1000, generation: { timeToFirstTokenSeconds: 0, streamingDurationSeconds: 0.25 },
  })]).session.outputTps, 4000);
  for (const duration of [0, -1, NaN, Infinity]) {
    assert.equal(computeTps(duration, 100).status, 'pending_or_fallback');
  }
});

test('invalid token values and reversed intervals cannot create a TPS sample', () => {
  for (const outputTokens of [-1, 1.5, NaN, Infinity]) {
    const result = metrics([step({ outputTokens })]);
    assert.equal(result.session.outputTpsFormatted, '—');
    assert.equal(result.tokens.outputTokens, 0);
  }
  const reversed = metrics([step({ endTimeSeconds: 99 })]);
  assert.equal(reversed.session.modelDurationSeconds, 0);
  assert.equal(reversed.session.outputTpsFormatted, '—');
});

test('actual context is independent of generator estimates and output tokens', () => {
  for (const estimatedTokensUsed of [1, 190000]) {
    const result = metrics([step({ outputTokens: 99999 })], {
      genMetadata: { estimatedTokensUsed, systemTokens: 90000, maxContextTokens: 1000 },
    });
    assert.equal(result.context.hasUsageData, true);
    assert.equal(result.context.usedTokens, 330);
    assert.equal(result.context.breakdown.cachedContextTokens, 200);
    assert.equal(result.context.breakdown.uncachedContextTokens, 130);
    assert.equal(result.context.breakdown.latestOutputTokens, 99999);
    assert.equal(result.context.usedRatio, 0.33);
    assert.equal(result.context.usedRatioFormatted, '33.00%');
  }
});

test('missing context usage differs from an explicitly reported zero input', () => {
  const missing = metrics([], { genMetadata: { estimatedTokensUsed: 90000 } });
  assert.equal(missing.context.hasUsageData, false);
  assert.equal(missing.context.usedTokens, 0);
  const zero = metrics([step({ ...usage({ rawInputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0 }) })]);
  assert.equal(zero.context.hasUsageData, true);
  assert.equal(zero.context.usedTokens, 0);
});

test('an observed 226412-token context never guesses 256K or clamps the reported ratio', () => {
  const result = metrics([step({ rawInputTokens: 8312, cachedReadTokens: 218100, cacheWriteTokens: 0 })]);
  assert.equal(result.context.usedTokens, 226412);
  assert.equal(result.context.peakContextTokens, 226412);
  assert.equal(result.context.capacityTokens, 200000);
  assert.equal(result.context.capacityTokensCompact, '~200K');
  assert.equal(result.context.isFallbackCapacity, true);
  assert.equal(result.context.hasExplicitDbCapacity, false);
  closeTo(result.context.usedRatio, 1.13206);
  assert.equal(result.context.usedRatioFormatted, '113.21%');
  for (const overrides of [
    { modelCapacity: 262144 }, { genMetadata: { maxContextTokens: 262144 } },
  ]) {
    const explicit = metrics([step()], overrides);
    assert.equal(explicit.context.capacityTokens, 262144);
    assert.equal(explicit.context.isFallbackCapacity, false);
    assert.equal(explicit.context.hasExplicitDbCapacity, true);
  }
});

test('contextSteps isolates parent context, peak, compactions and turns from child accounting', () => {
  const main = [
    { stepType: 14, status: 3 },
    step({ rawInputTokens: 1000 }),
    { stepType: 23, status: 3 },
    { stepType: 23, status: 2 },
    step({ idx: 51 }),
    step({ idx: 52, hasUsage: false, rawInputTokens: 999999 }),
  ];
  const child = [
    { stepType: 14, status: 3 }, { stepType: 23, status: 3 },
    step({ rawInputTokens: 900000, modelMaxTokens: 1000000 }),
  ];
  const result = metrics([...main, ...child], { contextSteps: main });
  assert.equal(result.session.turns, 1);
  assert.equal(result.session.compactionCount, 1);
  assert.equal(result.session.modelSteps, 4);
  assert.equal(result.context.usedTokens, 330);
  assert.equal(result.context.peakContextTokens, 1230);
  assert.equal(result.context.capacityTokens, 200000);
  assert.equal(result.tokens.uncachedInputTokens, 1000 + 100 + 999999 + 900000);
});

function databaseFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gravitybox-hud-precision-'));
  const databases = [];
  t.after(() => {
    for (const db of databases) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function create(id, { parentBlob, legacy = false } = {}) {
    const db = new DatabaseSync(path.join(directory, `${id}.db`));
    databases.push(db);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL,
        status INTEGER NOT NULL, metadata BLOB, render_info BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0);
    `);
    if (!legacy) {
      db.exec(`
        CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER);
        CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      `);
      db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?)').run(id, id, 0);
      if (parentBlob) db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', parentBlob);
    }
    return db;
  }
  return { create, engine: new ConversationMetricsEngine({ conversationsDir: directory }) };
}
const ids = {
  main: '11111111-1111-4111-8111-111111111111',
  child: '22222222-2222-4222-8222-222222222222',
  grandchild: '33333333-3333-4333-8333-333333333333',
  leaf: '44444444-4444-4444-8444-444444444444',
  unrelated: '55555555-5555-4555-8555-555555555555',
  impostor: '66666666-6666-4666-8666-666666666666',
};
const parentMetadata = (parent, root = ids.main) => Buffer.from([
  ...string(5, parent), ...string(6, root),
]);
function insertStep(db, { idx = 50, value = usage(), execution = 'execution-a', timing = true, status = 3 } = {}) {
  const metadata = Buffer.from([
    ...(timing ? [...seconds(1, 100), ...seconds(6, 109), ...seconds(7, 110)] : []),
    ...message(9, usageBytes(value)), ...string(12, execution),
  ]);
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, 15, ?, ?)').run(idx, status, metadata);
}
function generationBlob({ indices = [50], packed = true, execution = 'execution-a', value = usage(), ttft = 0, streaming = 2 } = {}) {
  return Buffer.from([
    ...message(1, [
      ...message(4, usageBytes(value)), ...seconds(11, ttft), ...seconds(12, streaming),
      ...string(19, 'gemini-3.8-flash'),
    ]),
    ...(packed ? message(2, indices.flatMap(varint)) : indices.flatMap(index => scalar(2, index))),
    ...string(4, execution),
  ]);
}
function insertGeneration(db, options = {}, idx = 1) {
  const data = generationBlob(options);
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(idx, data, data.length);
}
function invoke(db, idx, children, { payload = false, name = 'invoke_subagent' } = {}) {
  const metadata = Buffer.from(message(4, string(2, name)));
  const references = Buffer.from(string(5, children.join(' ')));
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata, render_info, step_payload) VALUES (?, ?, 3, ?, ?, ?)')
    .run(idx, name === 'invoke_subagent' ? 127 : 21, metadata, payload ? null : references, payload ? references : null);
}

for (const packed of [true, false]) {
  test(`SQLite links gen idx=1 to step idx=50 using ${packed ? 'packed' : 'unpacked'} step_indices`, async t => {
    const { create, engine } = databaseFixture(t);
    const db = create(ids.main);
    insertStep(db);
    insertGeneration(db, { packed, indices: [49, 50] });
    const result = await engine.getConversationMetrics({ conversationId: ids.main });
    assert.equal(result.session.steps, 1);
    assert.equal(result.session.modelDurationSeconds, 2);
    assert.equal(result.session.outputTps, 60);
    assert.equal(result.session.averageTtftSeconds, 0);
  });
}

test('SQLite permits distinct steps sharing one execution ID without deduplicating their generations', async t => {
  const { create, engine } = databaseFixture(t);
  const db = create(ids.main);
  insertStep(db);
  const second = usage({ outputTokens: 900, reasoningTokens: 600, candidateTokens: 300 });
  insertStep(db, { idx: 51, value: second });
  insertGeneration(db, { ttft: 2, streaming: 8 });
  insertGeneration(db, { indices: [51], value: second, ttft: 0, streaming: 2 }, 2);
  const result = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(result.tokens.outputTokens, 1020);
  assert.equal(result.session.modelDurationSeconds, 12);
  assert.equal(result.session.outputTps, 85);
  assert.equal(result.session.averageTtftSeconds, 1);
});

for (const [label, options] of [
  ['execution mismatch', { execution: 'execution-b' }],
  ['usage mismatch', { value: usage({ cachedReadTokens: 201 }) }],
  ['unrelated step index', { indices: [999] }],
  ['ambiguous model steps', { indices: [50, 51] }],
]) {
  test(`SQLite rejects generation timing on ${label}`, async t => {
    const { create, engine } = databaseFixture(t);
    const db = create(ids.main);
    insertStep(db);
    if (label === 'ambiguous model steps') insertStep(db, { idx: 51 });
    insertGeneration(db, options);
    const result = await engine.getConversationMetrics({ conversationId: ids.main });
    assert.equal(result.session.outputTps, 12, 'use step timing, never borrow the unrelated 2-second gen');
    assert.equal(result.session.averageTtftSeconds, 9);
  });
}

test('SQLite concurrent repeated reads do not accumulate steps or output', async t => {
  const { create, engine } = databaseFixture(t);
  const db = create(ids.main);
  insertStep(db);
  insertGeneration(db);
  for (let batch = 0; batch < 3; batch++) {
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      engine.getConversationMetrics({ conversationId: ids.main })));
    for (const result of results) {
      assert.equal(result.session.steps, 1);
      assert.equal(result.tokens.totalTokens, 450);
      assert.equal(result.session.outputTps, 60);
      assert.equal(result.session.modelDurationSeconds, 2);
    }
  }
  assert.equal(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy, 0);
});

test('SQLite refreshes late generation timing written at the same gen idx', async t => {
  const { create, engine } = databaseFixture(t);
  const db = create(ids.main);
  insertStep(db);
  db.prepare('INSERT INTO gen_metadata VALUES (1, ?, 0)').run(Buffer.alloc(0));
  const before = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(before.session.outputTps, 12);
  const data = generationBlob({ ttft: 0.25, streaming: 1.75 });
  db.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 1').run(data, data.length);

  const after = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(after.session.outputTps, 60);
  assert.equal(after.session.averageTtftSeconds, 0.25);
  assert.equal(after.session.steps, 1);
  assert.equal(after.tokens.totalTokens, before.tokens.totalTokens);
});

test('SQLite reads adjacent protobuf parent field 5 and root field 6 without regex word boundaries', async t => {
  const { create, engine } = databaseFixture(t);
  const main = create(ids.main);
  const blob = parentMetadata(ids.main, ids.unrelated);
  assert.equal(blob[38], 0x32, 'field 6 tag immediately follows the 36-byte parent UUID');
  const child = create(ids.child, { parentBlob: blob });
  insertStep(main);
  insertStep(child, { value: usage({ outputTokens: 500 }) });
  invoke(main, 51, [ids.child]);
  const result = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(result.session.subagentCount, 1);
  assert.equal(result.session.subagentSteps, 1);
  assert.equal(result.tokens.outputTokens, 620);
});

test('SQLite recursively aggregates three descendant levels once, rejects cycles and unrelated UUIDs', async t => {
  const { create, engine } = databaseFixture(t);
  const main = create(ids.main);
  const child = create(ids.child, { parentBlob: parentMetadata(ids.main) });

  const grandchild = create(ids.grandchild, { parentBlob: parentMetadata(ids.main) });
  const leaf = create(ids.leaf, { parentBlob: parentMetadata(ids.grandchild) });
  const unrelated = create(ids.unrelated, { parentBlob: parentMetadata(ids.impostor, ids.impostor) });
  const impostor = create(ids.impostor, { parentBlob: Buffer.from([
    ...string(1, `body mentions ${ids.main}`),
    ...string(5, `${ids.main}suffix`), ...string(6, ids.unrelated),
  ]) });
  for (const [db, input, output] of [
    [main, 1000, 100], [child, 90000, 200], [grandchild, 150000, 300],
    [leaf, 500000, 400], [unrelated, 999999, 9000], [impostor, 999999, 9000],
  ]) {
    db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (1, 14, 3)').run();
    db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (2, 23, 3)').run();
    insertStep(db, { value: usage({ rawInputTokens: input, outputTokens: output }) });
  }
  invoke(main, 51, [ids.child, ids.impostor, ids.unrelated]);
  invoke(main, 52, [ids.unrelated], { name: 'run_command' });
  invoke(child, 51, [ids.grandchild], { payload: true });
  invoke(grandchild, 51, [ids.leaf]);
  invoke(leaf, 51, [ids.main, ids.child]);
  const result = await engine.getConversationMetrics({
    conversationId: ids.main, childConversationIds: [ids.unrelated],
  });
  assert.equal(result.session.subagentCount, 3);
  assert.equal(result.session.subagentSteps, 12);
  assert.equal(result.session.steps, 17);
  assert.equal(result.tokens.outputTokens, 1000);
  assert.equal(result.tokens.uncachedInputTokens, 741000);
  assert.equal(result.session.turns, 1);
  assert.equal(result.session.compactionCount, 1);
  assert.equal(result.context.usedTokens, 1230);
  assert.equal(result.context.peakContextTokens, 1230);
  assert.equal(result.context.capacityTokens, 200000);
});

test('SQLite ignores UUIDs in metadata body, nested fields and non-exact parent fields', async t => {
  const { create, engine } = databaseFixture(t);
  const main = create(ids.main);
  insertStep(main);
  const badBlobs = [
    Buffer.from(string(1, ids.main)),
    Buffer.from(message(1, string(5, ids.main))),
    Buffer.from(string(5, ` ${ids.main}`)),
    Buffer.from(string(6, `${ids.main}suffix`)),
  ];
  for (const [index, blob] of badBlobs.entries()) {
    const id = [ids.child, ids.grandchild, ids.leaf, ids.impostor][index];
    const child = create(id, { parentBlob: blob });
    insertStep(child);
    invoke(main, 51 + index, [id]);
  }
  const result = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(result.session.subagentCount, 0);
  assert.equal(result.session.subagentSteps, 0);
  assert.equal(result.tokens.outputTokens, 120);
});

test('SQLite legacy child without parent metadata tables needs an explicit tool reference, not a DOM hint', async t => {
  const { create, engine } = databaseFixture(t);
  const main = create(ids.main);
  const child = create(ids.child, { legacy: true });
  insertStep(main);
  insertStep(child);
  const hinted = await engine.getConversationMetrics({ conversationId: ids.main, childConversationIds: [ids.child] });
  assert.equal(hinted.session.subagentSteps, 0);
  invoke(main, 51, [ids.child]);
  const explicit = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(explicit.session.subagentCount, 1);
  assert.equal(explicit.session.subagentSteps, 1);
  assert.equal(explicit.tokens.outputTokens, 240);
});

test('SQLite refreshes a parent reference written after the first child lookup', async t => {
  const { create, engine } = databaseFixture(t);
  const main = create(ids.main);
  const child = create(ids.child);
  insertStep(main);
  insertStep(child);
  invoke(main, 51, [ids.child]);
  const before = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(before.session.subagentCount, 0);
  child.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', parentMetadata(ids.main));
  const after = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(after.session.subagentCount, 1);
  assert.equal(after.tokens.outputTokens, 240);
});

test('SQLite drops removed child references and replays generations after timeline shrink', async t => {
  const { create, engine } = databaseFixture(t);
  const main = create(ids.main);
  const child = create(ids.child, { parentBlob: parentMetadata(ids.main) });
  insertStep(main);
  insertStep(child);
  insertGeneration(main, { ttft: 1, streaming: 1 });
  invoke(main, 51, [ids.child]);
  const before = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(before.session.subagentCount, 1);
  main.exec('DELETE FROM steps WHERE idx = 51; DELETE FROM gen_metadata');
  insertGeneration(main, { ttft: 2, streaming: 2 }, 0);
  const after = await engine.getConversationMetrics({ conversationId: ids.main });
  assert.equal(after.session.subagentCount, 0);
  assert.equal(after.session.steps, 1);
  assert.equal(after.session.outputTps, 30);
});

test('activityPhase separates model generating (solid blue), script executing (breathing blue), and idle (gray)', () => {
  const idleResult = metrics([step({ idx: 1, stepType: 14 }), step({ idx: 2, stepType: 15, status: 3 })], {
    isStreaming: false,
    allowDbActiveStepInference: true,
  });
  assert.equal(idleResult.activityPhase, 'idle');

  const modelGenerating = metrics(
    [
      step({ idx: 1, stepType: 14 }),
      step({ idx: 2, stepType: 15, status: 8, endTimeSeconds: null }),
    ],
    { isStreaming: true, allowDbActiveStepInference: true }
  );
  assert.equal(modelGenerating.activityPhase, 'generating');

  const scriptExecuting = metrics(
    [
      step({ idx: 1, stepType: 14 }),
      step({ idx: 2, stepType: 15, status: 3 }),
      step({ idx: 3, stepType: 21, status: 2, endTimeSeconds: null }),
    ],
    { isStreaming: true, allowDbActiveStepInference: true }
  );
  assert.equal(scriptExecuting.activityPhase, 'executing');
});

test('本轮用时 (Current Turn Duration) 精准切分与模型/工具耗时分解', () => {
  // 第 1 轮：step 1 (USER_INPUT), step 2 (PLANNER_RESPONSE 耗时 10s)
  // 第 2 轮：step 3 (USER_INPUT), step 4 (PLANNER_RESPONSE 思考/生成耗时 14.2s), step 5 (工具执行耗时 4.2s)
  const result = metrics([
    step({ idx: 1, stepType: 14, startTimeSeconds: 100, endTimeSeconds: 100 }),
    step({ idx: 2, stepType: 15, status: 3, startTimeSeconds: 100, endTimeSeconds: 110, rawInputTokens: 50, outputTokens: 20 }),
    step({ idx: 3, stepType: 14, startTimeSeconds: 200, endTimeSeconds: 200 }),
    step({
      idx: 4,
      stepType: 15,
      status: 3,
      startTimeSeconds: 200,
      endTimeSeconds: 214.2,
      rawInputTokens: 100,
      outputTokens: 50,
      generation: { timeToFirstTokenSeconds: 2.2, streamingDurationSeconds: 12.0 },
    }),
    step({ idx: 5, stepType: 21, status: 3, startTimeSeconds: 214.2, endTimeSeconds: 218.4 }),
  ]);

  // 全会话累计
  assert.equal(result.session.turns, 2);
  assert.equal(Number(result.session.modelDurationSeconds.toFixed(1)), 24.2);
  assert.equal(Number(result.session.toolDurationSeconds.toFixed(1)), 4.2);

  // 本轮用时切分
  assert.equal(Number(result.session.currentTurnModelDurationSeconds.toFixed(1)), 14.2);
  assert.equal(Number(result.session.currentTurnToolDurationSeconds.toFixed(1)), 4.2);
  assert.equal(Number(result.session.currentTurnDurationSeconds.toFixed(1)), 18.4);
  assert.equal(result.session.currentTurnDurationFormatted, '18秒');
  assert.equal(result.session.currentTurnDurationFormattedEn, '18s');
  assert.equal(result.session.currentTurnDurationCompactZh, '本轮 18s');
  assert.equal(result.session.currentTurnDurationCompactEn, 'Turn 18s');
});

test('本轮用时常驻栏与展开卡片格式规则（s/m/h 与汉字时分秒，省略零分零秒，非活跃旧库不推算 now-start）', () => {
  assert.equal(formatTurnDurationCompact(0, 'zh'), '本轮 0s');
  assert.equal(formatTurnDurationCompact(1, 'zh'), '本轮 1s');
  assert.equal(formatTurnDurationCompact(59, 'zh'), '本轮 59s');
  assert.equal(formatTurnDurationCompact(60, 'zh'), '本轮 1m');
  assert.equal(formatTurnDurationCompact(637, 'zh'), '本轮 10m');
  assert.equal(formatTurnDurationCompact(3600, 'zh'), '本轮 1h');
  assert.equal(formatTurnDurationCompact(3661, 'zh'), '本轮 1h1m');
  assert.equal(formatTurnDurationCompact(3661, 'en'), 'Turn 1h1m');

  assert.equal(formatTurnDurationCard(0, 'zh'), '0秒');
  assert.equal(formatTurnDurationCard(18.4, 'zh'), '18秒');
  assert.equal(formatTurnDurationCard(59.96, 'zh'), '1分');
  assert.equal(formatTurnDurationCard(61, 'zh'), '1分1秒');
  assert.equal(formatTurnDurationCard(119.96, 'en'), '2m');
  assert.equal(formatTurnDurationCard(3600, 'zh'), '1小时');
  assert.equal(formatTurnDurationCard(3600, 'en'), '1h');
  assert.equal(formatTurnDurationCard(3601, 'zh'), '1小时1秒');
  assert.equal(formatTurnDurationCard(3660, 'zh'), '1小时1分');
  assert.equal(formatTurnDurationCard(3661.2, 'zh'), '1小时1分1秒');
  assert.equal(formatTurnDurationCard(3661.2, 'en'), '1h1m1s');

  const staleDbMetrics = metrics(
    [
      step({ idx: 1, stepType: 14 }),
      step({ idx: 2, stepType: 15, status: 1, startTimeSeconds: 1000, endTimeSeconds: null }),
    ],
    { isStreaming: false, allowDbActiveStepInference: false }
  );
  assert.equal(staleDbMetrics.session.currentTurnDurationSeconds, 0);
});

test('长耗时工具运行超5分钟且带占位end时间戳、即使DOM进入空闲也不得回退冻结本轮用时', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-hud-long-tool-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const convId = 'long-running-tool';
  const dbPath = path.join(tmp, `${convId}.db`);
  const nowSec = Date.now() / 1000;
  const toolStartSec = nowSec - 600; // 工具已持续运行 10 分钟 (>5 分钟)

  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,metadata BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);');
  db.prepare('INSERT INTO steps VALUES(0,14,3,NULL)').run();
  const modelMeta = Buffer.from([...seconds(1, toolStartSec - 188), ...seconds(7, toolStartSec)]);
  db.prepare('INSERT INTO steps VALUES(1,15,3,?)').run(modelMeta);
  const runningToolMeta = Buffer.from([...seconds(1, toolStartSec), ...seconds(7, toolStartSec + 0.002)]);
  db.prepare('INSERT INTO steps VALUES(2,132,2,?)').run(runningToolMeta);
  db.close();

  const tenMinAgo = new Date(Date.now() - 600_000);
  fs.utimesSync(dbPath, tenMinAgo, tenMinAgo);

  const engine = new ConversationMetricsEngine({ conversationsDir: tmp });
  const result = await engine.getConversationMetrics({
    conversationId: convId,
    isStreaming: false,
    activityPhase: 'idle',
  });
  assert.equal(result.isStreaming, true);
  assert.equal(result.activityPhase, 'executing');
  assert.ok(
    result.session.currentTurnDurationSeconds >= 780,
    `应持续累计 188s + 600s (>=780s)，不能回退冻结在 188s，实际 ${result.session.currentTurnDurationSeconds}`
  );
});

test('异步与并行子智能体期间本轮用时不暂停、不重复叠加且完成后不回退', () => {
  const nowSec = Date.now() / 1000;
  const turnStart = nowSec - 23;
  // 场景 1: 异步 invoke_subagent 本身仅耗时 0.02s，后台子智能体运行至当前时刻 (总墙钟 23s)
  const mainSteps = [
    step({ idx: 0, stepType: 14, startTimeSeconds: null, endTimeSeconds: null }),
    step({ idx: 1, stepType: 15, status: 3, startTimeSeconds: turnStart, endTimeSeconds: turnStart + 10, rawInputTokens: 50, outputTokens: 20 }),
    step({ idx: 2, stepType: 132, status: 3, isSubagentStep: true, toolCallName: 'invoke_subagent', startTimeSeconds: turnStart + 10, endTimeSeconds: turnStart + 10.02 }),
    step({ idx: 3, stepType: 15, status: 3, startTimeSeconds: turnStart + 10.02, endTimeSeconds: turnStart + 20, rawInputTokens: 60, outputTokens: 15 }),
  ];
  const childRunningSteps = [
    step({ idx: 0, stepType: 14 }),
    step({ idx: 1, stepType: 15, status: 2, startTimeSeconds: turnStart + 10.05, endTimeSeconds: null }),
  ];
  const activeSubagentMetrics = buildConversationHudMetrics({
    conversationId: 'subagent-active-wall',
    isStreaming: false,
    isSubagentRunning: true,
    runningSubagentCount: 1,
    contextSteps: mainSteps,
    steps: [...mainSteps, ...childRunningSteps],
  });
  assert.ok(
    activeSubagentMetrics.session.currentTurnDurationSeconds >= 22.8,
    `子智能体后台运行 23s 时不能冻结在 20s，实际 ${activeSubagentMetrics.session.currentTurnDurationSeconds}`
  );

  // 场景 2: 两个并行子智能体同时跑 20s，本轮用时应按墙钟区间合并为 20s，而非 40s
  const parallelSteps = [
    step({ idx: 0, stepType: 14, startTimeSeconds: 100, endTimeSeconds: 100 }),
    step({ idx: 1, stepType: 132, status: 3, isSubagentStep: true, startTimeSeconds: 100, endTimeSeconds: 120 }),
    step({ idx: 2, stepType: 132, status: 3, isSubagentStep: true, startTimeSeconds: 100, endTimeSeconds: 120 }),
  ];
  const parallelMetrics = buildConversationHudMetrics({
    conversationId: 'subagent-parallel-wall',
    isStreaming: false,
    isSubagentRunning: false,
    contextSteps: parallelSteps,
    steps: parallelSteps,
  });
  assert.equal(Number(parallelMetrics.session.currentTurnDurationSeconds.toFixed(1)), 20);
});
