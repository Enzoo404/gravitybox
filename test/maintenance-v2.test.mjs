import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, utimes, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CacheMaintenance } from '../dist/maintenance.js';
import {
  UsageStatsManager,
  ProtobufWriter,
  calculateEstimatedUsd,
  DEFAULT_API_PRICES,
} from '../dist/usage.js';

const execFileAsync = promisify(execFile);

async function setAgeDays(targetPath, daysAgo) {
  const sec = (Date.now() - daysAgo * 86_400_000) / 1000;
  await utimes(targetPath, sec, sec);
}

async function createUsageDb(dbPath, { model = 'gemini-3.8-flash', input = 1500, output = 1000, cached = 4000, tsSec }) {
  const field19 = ProtobufWriter.encodeString(19, model);
  const usageMsg = Buffer.concat([
    ProtobufWriter.encodeVarintField(1, 1318),
    ProtobufWriter.encodeVarintField(2, input),
    ProtobufWriter.encodeVarintField(3, output),
    ProtobufWriter.encodeVarintField(5, cached),
  ]);
  const field4 = ProtobufWriter.encodeLengthDelimited(4, usageMsg);
  const timingInner = ProtobufWriter.encodeLengthDelimited(4, ProtobufWriter.encodeVarintField(1, tsSec));
  const field9 = ProtobufWriter.encodeLengthDelimited(9, timingInner);
  const wrapped = Buffer.concat([field19, field4, field9]);
  const hexBlob = ProtobufWriter.encodeLengthDelimited(1, wrapped).toString('hex');

  const sql = `
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, status INTEGER, step_payload BLOB);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    INSERT INTO gen_metadata (idx, data) VALUES (1, X'${hexBlob}');
  `;
  await execFileAsync('/usr/bin/sqlite3', [dbPath, sql]);
}

async function createSummariesDb(dbPath, summaries, archivedIds = []) {
  const lines = [
    'CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, summary TEXT, updated_at INTEGER, parent_conversation_id TEXT, status TEXT);',
    'CREATE TABLE conversations_fts (conversation_id TEXT, title TEXT, archived INTEGER);',
  ];
  for (const s of summaries) {
    lines.push(
      `INSERT INTO conversation_summaries (conversation_id, summary, updated_at, parent_conversation_id, status) VALUES ('${s.id}', 'sum', ${s.updatedAt ?? 1760000000}, '${s.parentId ?? ''}', '${s.status ?? 'CASCADE_RUN_STATUS_IDLE'}');`
    );
  }
  for (const cid of archivedIds) {
    lines.push(`INSERT INTO conversations_fts (conversation_id, title, archived) VALUES ('${cid}', 'archived chat', 1);`);
  }
  await execFileAsync('/usr/bin/sqlite3', [dbPath, lines.join('\n')]);
}

test('v2 存储治理: PartitionsCache 与 AgentBrowserCache 精确剥离无状态缓存，保护登录态且绝不触碰 Insiders', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'gb-maint-v2-browser-')));
  const profile = join(temp, 'profile');
  const geminiDir = join(temp, 'gemini');
  const trash = join(temp, 'trash');
  const stateDir = join(temp, 'state');
  await Promise.all([mkdir(profile), mkdir(geminiDir), mkdir(trash), mkdir(stateDir)]);

  try {
    // 1. Partitions 下同时包含无状态缓存与有状态凭据
    await mkdir(join(profile, 'Partitions', 'webview-a', 'Cache'), { recursive: true });
    await writeFile(join(profile, 'Partitions', 'webview-a', 'Cache', 'chunk.bin'), 'part-cache-a');
    await mkdir(join(profile, 'Partitions', 'webview-a', 'Local Storage'), { recursive: true });
    await writeFile(join(profile, 'Partitions', 'webview-a', 'Local Storage', 'leveldb.ldb'), 'keep-part-ls');
    await writeFile(join(profile, 'Partitions', 'webview-a', 'Cookies'), 'keep-part-cookie');

    // 2. 正式版 antigravity/browser_profile 同时包含无状态缓存与站点会话
    const bp = join(geminiDir, 'antigravity', 'browser_profile');
    await mkdir(join(bp, 'GraphiteDawnCache'), { recursive: true });
    await writeFile(join(bp, 'GraphiteDawnCache', 'shader.bin'), 'top-graphite');
    await mkdir(join(bp, 'Default', 'Cache'), { recursive: true });
    await writeFile(join(bp, 'Default', 'Cache', 'http.bin'), 'default-cache');
    await mkdir(join(bp, 'Default', 'Service Worker', 'CacheStorage'), { recursive: true });
    await writeFile(join(bp, 'Default', 'Service Worker', 'CacheStorage', 'sw.bin'), 'sw-cache');
    await writeFile(join(bp, 'Default', 'Service Worker', 'Database'), 'keep-sw-db');
    await writeFile(join(bp, 'Default', 'Cookies'), 'keep-browser-cookies');
    await mkdir(join(bp, 'Default', 'Sessions'), { recursive: true });
    await writeFile(join(bp, 'Default', 'Sessions', 'Tabs_1'), 'keep-tabs');
    await mkdir(join(bp, 'Profile 1', 'Code Cache'), { recursive: true });
    await writeFile(join(bp, 'Profile 1', 'Code Cache', 'wasm.bin'), 'p1-code-cache');

    // 3. Insiders 目录必须完全不受影响（AGENTS.md §2）
    const insidersBp = join(geminiDir, 'antigravity-insiders', 'browser_profile', 'Default', 'Cache');
    await mkdir(insidersBp, { recursive: true });
    await writeFile(join(insidersBp, 'insiders.bin'), 'never-touch-insiders');

    const m = new CacheMaintenance(profile, trash, async () => false, {
      geminiDir,
      stateDir,
      browserRunning: async () => false,
    });

    const scan = await m.scan();
    const partItem = scan.entries.find(e => e.name === 'PartitionsCache');
    const browserItem = scan.entries.find(e => e.name === 'AgentBrowserCache');
    assert.ok(partItem && partItem.bytes > 0 && partItem.category === 'safe' && partItem.defaultSelected === true);
    assert.ok(browserItem && browserItem.bytes > 0 && browserItem.category === 'safe' && browserItem.defaultSelected === true);

    const cleared = await m.clear(scan.token, ['PartitionsCache', 'AgentBrowserCache']);
    assert.equal(cleared.moved, 2);

    // 验证无状态缓存已移出原路径，有状态凭据与 Insiders 完好无损
    await assert.rejects(lstat(join(profile, 'Partitions', 'webview-a', 'Cache')));
    await assert.rejects(lstat(join(bp, 'Default', 'Cache')));
    await assert.rejects(lstat(join(bp, 'Default', 'Service Worker', 'CacheStorage')));
    await assert.rejects(lstat(join(bp, 'Profile 1', 'Code Cache')));
    assert.equal(await readFile(join(profile, 'Partitions', 'webview-a', 'Cookies'), 'utf8'), 'keep-part-cookie');
    assert.equal(await readFile(join(profile, 'Partitions', 'webview-a', 'Local Storage', 'leveldb.ldb'), 'utf8'), 'keep-part-ls');
    assert.equal(await readFile(join(bp, 'Default', 'Cookies'), 'utf8'), 'keep-browser-cookies');
    assert.equal(await readFile(join(bp, 'Default', 'Sessions', 'Tabs_1'), 'utf8'), 'keep-tabs');
    assert.equal(await readFile(join(bp, 'Default', 'Service Worker', 'Database'), 'utf8'), 'keep-sw-db');
    assert.equal(await readFile(join(insidersBp, 'insiders.bin'), 'utf8'), 'never-touch-insiders');

    // 验证 schema: 2 多路径快照一键原位还原（包含期间重新生成的冲突目录安全归档至 displaced/）
    await mkdir(join(bp, 'Default', 'Cache'), { recursive: true });
    await writeFile(join(bp, 'Default', 'Cache', 'fresh.bin'), 'regenerated');

    const history = await m.history();
    assert.equal(history.length, 1);
    assert.equal(history[0].restorable, true);
    const restored = await m.restore(history[0].id);
    assert.equal(restored.restored, 2);
    assert.equal(restored.displacedCount, 1);
    assert.equal(await readFile(join(bp, 'Default', 'Cache', 'http.bin'), 'utf8'), 'default-cache');
    assert.equal(await readFile(join(bp, 'Profile 1', 'Code Cache', 'wasm.bin'), 'utf8'), 'p1-code-cache');
    assert.equal(await readFile(join(profile, 'Partitions', 'webview-a', 'Cache', 'chunk.bin'), 'utf8'), 'part-cache-a');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v2 存储治理: 严格保护主对话、已归档对话树(archived=1)与运行中树(RUNNING)，精准识别孤儿残留并遵循 7/30/0 天保留窗口', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'gb-maint-v2-conv-')));
  const profile = join(temp, 'profile');
  const geminiDir = join(temp, 'gemini');
  const trash = join(temp, 'trash');
  await Promise.all([mkdir(profile), mkdir(geminiDir), mkdir(trash)]);

  const agentDir = join(geminiDir, 'antigravity');
  const convDir = join(agentDir, 'conversations');
  const brainDir = join(agentDir, 'brain');
  await mkdir(convDir, { recursive: true });
  await mkdir(brainDir, { recursive: true });

  const rootOld = '11111111-1111-4111-8111-111111111111';     // 12 天前非活跃主对话
  const subOld = '22222222-2222-4222-8222-222222222222';      // 12 天前非活跃 Subagent
  const subRecent = '33333333-3333-4333-8333-333333333333';   // 2 天前非活跃 Subagent
  const rootArchived = '44444444-4444-4444-8444-444444444444';// 20 天前已归档主对话
  const subArchived = '55555555-5555-4555-8555-555555555555'; // 20 天前已归档主对话下的 Subagent
  const rootRunning = '66666666-6666-4666-8666-666666666666'; // 运行中主对话
  const subRunning = '77777777-7777-4777-8777-777777777777';  // 运行中主对话下的 Subagent
  const subOrphan = '88888888-8888-4888-8888-888888888888';   // 父对话已删的孤儿 Subagent（仅 1 天前）
  const deletedParent = '99999999-9999-4999-8999-999999999999';

  try {
    await createSummariesDb(
      join(agentDir, 'conversation_summaries.db'),
      [
        { id: rootOld, parentId: '', status: 'CASCADE_RUN_STATUS_IDLE' },
        { id: subOld, parentId: rootOld, status: 'CASCADE_RUN_STATUS_IDLE' },
        { id: subRecent, parentId: rootOld, status: 'CASCADE_RUN_STATUS_IDLE' },
        { id: rootArchived, parentId: '', status: 'CASCADE_RUN_STATUS_IDLE' },
        { id: subArchived, parentId: rootArchived, status: 'CASCADE_RUN_STATUS_IDLE' },
        { id: rootRunning, parentId: '', status: 'CASCADE_RUN_STATUS_RUNNING' },
        { id: subRunning, parentId: rootRunning, status: 'CASCADE_RUN_STATUS_IDLE' },
        { id: subOrphan, parentId: deletedParent, status: 'CASCADE_RUN_STATUS_IDLE' },
      ],
      [rootArchived]
    );

    const seedConvFiles = async (cid, daysAgo) => {
      const dbPath = join(convDir, `${cid}.db`);
      await writeFile(dbPath, `db-${cid}`);
      const bPath = join(brainDir, cid);
      await mkdir(join(bPath, '.system_generated', 'tasks'), { recursive: true });
      await mkdir(join(bPath, '.system_generated', 'steps'), { recursive: true });
      await mkdir(join(bPath, '.system_generated', 'logs', 'chunks'), { recursive: true });
      await mkdir(join(bPath, 'scratch'), { recursive: true });
      await writeFile(join(bPath, 'design_plan.md'), `artifact-${cid}`);
      await writeFile(join(bPath, '.system_generated', 'tasks', 't1.log'), `tasklog-${cid}`);
      await writeFile(join(bPath, '.system_generated', 'steps', 's1.txt'), `step-${cid}`);
      await writeFile(join(bPath, 'scratch', 'tmp.py'), `scratch-${cid}`);
      await writeFile(join(bPath, '.system_generated', 'logs', 'transcript.jsonl'), `compact-${cid}`);
      await writeFile(join(bPath, '.system_generated', 'logs', 'transcript_full.jsonl'), `full-${cid}`);
      await writeFile(join(bPath, '.system_generated', 'logs', 'chunks', '001.jsonl'), `chunk-${cid}`);

      await setAgeDays(dbPath, daysAgo);
      await setAgeDays(join(bPath, '.system_generated', 'logs', 'transcript.jsonl'), daysAgo);
      await setAgeDays(bPath, daysAgo);
    };

    await seedConvFiles(rootOld, 12);
    await seedConvFiles(subOld, 12);
    await seedConvFiles(subRecent, 2);
    await seedConvFiles(rootArchived, 20);
    await seedConvFiles(subArchived, 20);
    await seedConvFiles(rootRunning, 0.0005); // 约 43 秒前（近 3 分钟内活跃）
    await seedConvFiles(subRunning, 20);      // 即使子任务旧，因整棵树处于 RUNNING 仍受保护
    await seedConvFiles(subOrphan, 1);        // 孤儿残留仅 1 天前，不受 7 天窗口限制

    const m = new CacheMaintenance(profile, trash, async () => false, {
      geminiDir,
      browserRunning: async () => false,
    });

    // 活跃 RUNNING 会话在 3 分钟内有写入，hasRunningConversation 应返回 true
    assert.equal(await m.hasRunningConversation(), true);

    // 1. 测试保留近 30 天窗口：仅孤儿项进入清单，12 天前的历史瘦身项不出现
    const scan30 = await m.scan({ retentionDays: 30 });
    assert.equal(scan30.retentionDays, 30);
    assert.ok(scan30.entries.some(e => e.name === 'OrphanAgentData' && e.defaultSelected === true));
    assert.ok(!scan30.entries.some(e => e.name === 'AgentSubagentDatabases'));
    assert.ok(!scan30.entries.some(e => e.name === 'AgentTaskStepLogs'));

    // 2. 测试默认保留近 7 天窗口：subOld(12d) 进入 AgentSubagentDatabases，subRecent(2d)/subArchived(20d)/subRunning(20d)/rootOld(12d) 不进入
    const scan7 = await m.scan({ retentionDays: 7 });
    const subDb7 = scan7.entries.find(e => e.name === 'AgentSubagentDatabases');
    assert.ok(subDb7 && subDb7.category === 'stateful' && subDb7.defaultSelected === false);
    assert.equal(subDb7.itemCount, 1); // 严格只有 subOld 1 个！

    // 3. 测试全部非活跃（retentionDays = 0）：subOld(12d) 与 subRecent(2d) 均进入，共 2 个；归档树与运行树依然受保护
    const scan0 = await m.scan({ retentionDays: 0 });
    const subDb0 = scan0.entries.find(e => e.name === 'AgentSubagentDatabases');
    assert.ok(subDb0);
    assert.equal(subDb0.itemCount, 2);

    // 执行 7 天窗口全项清理（含无损孤儿 + 3 项历史深度瘦身）
    const scanExec = await m.scan({ retentionDays: 7 });
    await m.clear(scanExec.token, [
      'OrphanAgentData',
      'AgentTaskStepLogs',
      'AgentVerboseTranscripts',
      'AgentSubagentDatabases',
    ]);

    // 验证孤儿数据与 subOld.db 已被移入废纸篓
    await assert.rejects(lstat(join(convDir, `${subOrphan}.db`)));
    await assert.rejects(lstat(join(brainDir, subOrphan)));
    await assert.rejects(lstat(join(convDir, `${subOld}.db`)));

    // 验证主对话 rootOld.db、正式产物 design_plan.md 与紧凑版 transcript.jsonl 100% 完好保留！
    assert.equal(await readFile(join(convDir, `${rootOld}.db`), 'utf8'), `db-${rootOld}`);
    assert.equal(await readFile(join(brainDir, rootOld, 'design_plan.md'), 'utf8'), `artifact-${rootOld}`);
    assert.equal(
      await readFile(join(brainDir, rootOld, '.system_generated', 'logs', 'transcript.jsonl'), 'utf8'),
      `compact-${rootOld}`
    );
    await assert.rejects(lstat(join(brainDir, rootOld, '.system_generated', 'logs', 'transcript_full.jsonl')));
    await assert.rejects(lstat(join(brainDir, rootOld, '.system_generated', 'tasks')));

    // 验证 2 天内会话、已归档会话树与运行中会话树毫发无损
    assert.equal(await readFile(join(convDir, `${subRecent}.db`), 'utf8'), `db-${subRecent}`);
    assert.equal(await readFile(join(convDir, `${rootArchived}.db`), 'utf8'), `db-${rootArchived}`);
    assert.equal(await readFile(join(convDir, `${subArchived}.db`), 'utf8'), `db-${subArchived}`);
    assert.equal(await readFile(join(convDir, `${rootRunning}.db`), 'utf8'), `db-${rootRunning}`);
    assert.equal(await readFile(join(convDir, `${subRunning}.db`), 'utf8'), `db-${subRunning}`);
    assert.equal(
      await readFile(join(brainDir, rootRunning, '.system_generated', 'logs', 'transcript_full.jsonl'), 'utf8'),
      `full-${rootRunning}`
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v2 存储治理: 清理孤儿与历史 Subagent .db 前自动固化本地 Token 账本，清理后统计零丢失、恢复后幂等零双计', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'gb-maint-v2-ledger-')));
  const profile = join(temp, 'profile');
  const geminiDir = join(temp, 'gemini');
  const trash = join(temp, 'trash');
  const stateDir = join(temp, 'state');
  await Promise.all([mkdir(profile), mkdir(geminiDir), mkdir(trash), mkdir(stateDir)]);

  const agentDir = join(geminiDir, 'antigravity');
  const convDir = join(agentDir, 'conversations');
  await mkdir(convDir, { recursive: true });

  const rootId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const subId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const orphanId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const missingParent = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  try {
    await createSummariesDb(join(agentDir, 'conversation_summaries.db'), [
      { id: rootId, parentId: '', status: 'CASCADE_RUN_STATUS_IDLE' },
      { id: subId, parentId: rootId, status: 'CASCADE_RUN_STATUS_IDLE' },
      { id: orphanId, parentId: missingParent, status: 'CASCADE_RUN_STATUS_IDLE' },
    ]);

    const tenDaysAgoSec = Math.floor((Date.now() - 10 * 86_400_000) / 1000);
    const rootDb = join(convDir, `${rootId}.db`);
    const subDb = join(convDir, `${subId}.db`);
    const orphanDb = join(convDir, `${orphanId}.db`);

    await createUsageDb(rootDb, { input: 1500, output: 1000, cached: 4000, tsSec: tenDaysAgoSec });
    await createUsageDb(subDb, { input: 3000, output: 2000, cached: 8000, tsSec: tenDaysAgoSec + 10 });
    await createUsageDb(orphanDb, { input: 500, output: 500, cached: 1000, tsSec: tenDaysAgoSec + 20 });

    await setAgeDays(rootDb, 10);
    await setAgeDays(subDb, 10);
    await setAgeDays(orphanDb, 10);

    const usageMgr = new UsageStatsManager({ geminiDir, stateDir });
    const m = new CacheMaintenance(profile, trash, async () => false, {
      geminiDir,
      stateDir,
      browserRunning: async () => false,
      archiveDatabases: paths => usageMgr.archiveDatabasesBeforeClear(paths),
      onMutated: () => usageMgr.invalidateCache(),
    });

    // 1. 清理前基准账单
    const before = await usageMgr.getUsageSummary(true);
    assert.equal(before.all_time.totals.input_tokens, 5000);
    assert.equal(before.all_time.totals.output_tokens, 3500);
    assert.equal(before.all_time.totals.cached_tokens, 13000);
    assert.equal(before.all_time.totals.total_tokens, 21500);
    assert.equal(before.all_time.totals.request_count, 3);
    assert.ok(before.all_time.estimated_usd > 0);
    const baselineUsd = before.all_time.estimated_usd;

    // 2. 清理孤儿与历史 Subagent 数据库
    const scan = await m.scan({ retentionDays: 7 });
    const cleared = await m.clear(scan.token, ['OrphanAgentData', 'AgentSubagentDatabases']);
    assert.equal(cleared.moved, 2);
    await assert.rejects(lstat(subDb));
    await assert.rejects(lstat(orphanDb));

    // 验证归档账本文件已生成，且清理后统计数据与历史事件明细 100% 零损一致
    const archiveRaw = JSON.parse(await readFile(join(stateDir, 'usage-archived-events.json'), 'utf8'));
    assert.equal(Object.keys(archiveRaw.databases).length, 2);

    const afterClear = await usageMgr.getUsageSummary(true);
    assert.equal(afterClear.all_time.totals.input_tokens, 5000);
    assert.equal(afterClear.all_time.totals.output_tokens, 3500);
    assert.equal(afterClear.all_time.totals.cached_tokens, 13000);
    assert.equal(afterClear.all_time.totals.total_tokens, 21500);
    assert.equal(afterClear.all_time.totals.request_count, 3);
    assert.equal(afterClear.all_time.estimated_usd, baselineUsd);

    const eventsAfterClear = await usageMgr.getUsageEvents('all', '', 0, 20, undefined, false, true);
    assert.equal(eventsAfterClear.total, 3);

    // 验证历史重估功能对已归档事件同样兼容无误
    const revalued = await usageMgr.revalueHistory(true);
    assert.equal(revalued.before, baselineUsd);
    assert.equal(revalued.after, baselineUsd);

    // 3. 从废纸篓一键原位还原两个 .db 后，验证 event_key 幂等去重，绝不重复双倍计费
    const restored = await m.restore(basename(cleared.restorePath));
    assert.equal(restored.restored, 2);
    assert.ok(await lstat(subDb));
    assert.ok(await lstat(orphanDb));

    const afterRestore = await usageMgr.getUsageSummary(true);
    assert.equal(afterRestore.all_time.totals.input_tokens, 5000);
    assert.equal(afterRestore.all_time.totals.output_tokens, 3500);
    assert.equal(afterRestore.all_time.totals.cached_tokens, 13000);
    assert.equal(afterRestore.all_time.totals.total_tokens, 21500);
    assert.equal(afterRestore.all_time.totals.request_count, 3);
    assert.equal(afterRestore.all_time.estimated_usd, baselineUsd);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('v2 存储治理: 独立浏览器沙箱占用时局部跳过 AgentBrowserCache，不回滚其余清理项', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'gb-maint-v2-busy-bp-')));
  const profile = join(temp, 'profile');
  const geminiDir = join(temp, 'gemini');
  const trash = join(temp, 'trash');
  await Promise.all([mkdir(profile), mkdir(geminiDir), mkdir(trash)]);

  try {
    await mkdir(join(profile, 'Cache'), { recursive: true });
    await writeFile(join(profile, 'Cache', 'main.bin'), 'app-cache');
    const bpCache = join(geminiDir, 'antigravity', 'browser_profile', 'Default', 'Cache');
    await mkdir(bpCache, { recursive: true });
    await writeFile(join(bpCache, 'web.bin'), 'busy-browser-cache');

    const m = new CacheMaintenance(profile, trash, async () => false, {
      geminiDir,
      browserRunning: async () => true,
    });

    const scan = await m.scan();
    assert.equal(scan.browserBusy, true);

    // 同时勾选 Cache 与 AgentBrowserCache：Cache 正常清理，AgentBrowserCache 安全跳过
    const res = await m.clear(scan.token, ['Cache', 'AgentBrowserCache']);
    assert.equal(res.moved, 1);
    assert.deepEqual(res.skipped, ['AgentBrowserCache']);
    assert.match(res.message, /浏览器沙箱正在使用中/);
    await assert.rejects(lstat(join(profile, 'Cache')));
    assert.equal(await readFile(join(bpCache, 'web.bin'), 'utf8'), 'busy-browser-cache');

    // 单独仅清理 AgentBrowserCache 且浏览器占用时，给出友好阻断提示
    const scanOnlyBp = await m.scan();
    await assert.rejects(
      m.clear(scanOnlyBp.token, ['AgentBrowserCache']),
      /独立浏览器沙箱正在使用中/
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
