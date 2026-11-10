import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildConversationHudMetrics,
  computeTps,
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
