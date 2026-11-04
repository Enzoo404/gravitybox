import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection, createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(30);
  }
  throw new Error('测试等待超时');
}

/** 测试用 IPC 客户端：整包累积 Buffer 后一次性 UTF-8 解码，与生产 CLI 的流式解码相互独立。 */
function rpc(directory, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(directory, 'control.sock'));
    const chunks = [];
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('IPC 超时')); });
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('error', reject);
    socket.on('data', chunk => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (!buffer.includes(0x0a)) return;
      socket.end();
      try { resolve(JSON.parse(buffer.toString('utf8').split('\n')[0])); } catch { reject(new Error('响应格式错误')); }
    });
  });
}

// I04: CLI --command 必须按 UTF-8 流解码。以下用本地 socket mock 把“导”字（3 字节）从字节中间切开，
// 旧实现逐 chunk toString() 会产生 U+FFFD 并损坏 coverage_report / dictionary_export 的 JSON。
test('I04: CLI --command 在多字节 chunk 边界不产生 U+FFFD', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gb-p2-cli-'));
  const socketPath = join(directory, 'control.sock');
  const payload = {
    ok: true,
    report: {
      generatedAt: new Date().toISOString(),
      rows: [{ key: '导出词典', value: '设置 · 模型用量', context: '按钮 · 设置页' }],
      message: '界面覆盖清单：模型与设置已完成；未发送任何对话内容。',
    },
  };
  const bytes = Buffer.from(JSON.stringify(payload) + '\n', 'utf8');
  const firstChinese = bytes.indexOf(Buffer.from('导', 'utf8'));
  assert.ok(firstChinese > 0, '测试载荷必须包含多字节中文');
  const splits = [firstChinese + 1, firstChinese + 2];
  try {
    for (const split of splits) {
      const server = createServer(socket => {
        socket.on('error', () => {});
        socket.resume(); // 消费客户端命令字节，确保 FIN 后服务端连接能被关闭。
        socket.write(bytes.subarray(0, split));
        setTimeout(() => { socket.write(bytes.subarray(split)); socket.end(); }, 30);
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
      try {
        const { stdout } = await exec(process.execPath, [join(root, 'dist/main.js'), '--state-dir', directory, '--command', 'coverage_report'], { timeout: 20000, maxBuffer: 4_000_000 });
        assert.equal(stdout.includes('\uFFFD'), false, `切分点 ${split}：CLI 输出不得包含替换符`);
        assert.deepEqual(JSON.parse(stdout.trim()), payload);
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// B07/R08: 原生 watchState 不得用仅含 controller 字段的 status.json 清空账号字段。
test('B07: status.json 快照合并保留 socket 账号字段', async () => {
  const assistant = await readFile(join(root, 'native/Assistant.swift'), 'utf8');
  const main = await readFile(join(root, 'src/main.ts'), 'utf8');
  assert.match(assistant, /private func mergeStatusSnapshot\(_ raw: \[String: Any\], previous: LiveStatus\) -> LiveStatus/, 'watchState 必须先合并再重建 LiveStatus');
  for (const field of ['activeAccountEmail', 'activeFiveHourQuota', 'activeSubscriptionTier', 'accountsRevision', 'liveAccountEmail']) {
    assert.match(assistant, new RegExp(`if raw\\["${field}"\\] == nil \\{ merged\\.${field} = previous\\.${field} \\}`), `缺失账号字段 ${field} 必须沿用上一次 socket 数据`);
  }
  assert.doesNotMatch(assistant, /self\.statusValue = LiveStatus\(raw\)/, 'watchState 不得再用 status.json 直接整体重建');
  // status.json 只写 controller 快照；socket status 才注入账号字段与任务计数。
  assert.match(main, /const snapshot = \{ \.\.\.status, applicationChannel: channel, applicationLabel: target\.label, accountSwitchSupported: target\.supportsAccountSwitch, bothApplicationsInstalled: installState\.bothInstalled, availableChannels: installState\.channels, taskRevision:statusTasks\?\.revision\?\?0,runningTasks:statusTasks\?\.list\(\)\.filter\(t=>t\.state==='running'\)\.length\?\?0 \}/);
  assert.match(main, /activeAccountEmail/);
});

// E02: 用量页 update() 必须带 metricsKey + 15s 节流，不能每个 3s tick 都 fetch。
test('E02: 用量页 update 使用 metricsKey 与 15s 节流', async () => {
  const usage = await readFile(join(root, 'native/Usage.swift'), 'utf8');
  assert.match(usage, /var metricsKey = ""/);
  assert.match(usage, /var lastFetchTime: Date = \.distantPast/);
  assert.match(usage, /func update\(force: Bool = false\)/);
  assert.match(usage, /timeIntervalSince\(lastFetchTime\) >= 15\.0/);
  assert.match(usage, /if !force && !timeExpired && key == metricsKey \{ return \}/);
  assert.match(usage, /func metricsKeyForCurrentPeriod\(\) -> String/);
  assert.doesNotMatch(usage, /func update\(\) \{\s*fetch\(\)/, 'update() 不得无条件 fetch');
  assert.match(usage, /self\.metricsKey = requestKey/, '成功与失败都需记录指纹以进入节流');
});

// B09: usage_summary 返回失败库/跳过记录/最后扫描时间，原生用量页展示数量（不含库名路径）。
test('B09: usage_summary 披露失败库与跳过记录明细', async () => {
  const main = await readFile(join(root, 'src/main.ts'), 'utf8');
  const usage = await readFile(join(root, 'native/Usage.swift'), 'utf8');
  assert.match(main, /failedDatabasesCount: usage\.failed_databases_count \?\? 0/);
  assert.match(main, /skippedLargeRecords: usage\.skipped_large_records \?\? 0/);
  assert.match(main, /lastScannedAt: usage\.generated_at \?\? 0/);
  assert.match(usage, /失败库 \\\(failedCount\) 个/);
  assert.match(usage, /跳过 \\\(skippedRecords\) 条超大记录/);
  assert.match(usage, /扫描时间 \\\(formatter\.string/);
});

test('B07/B09: 真实后台 status.json 与 socket status 契约、usage_summary 明细', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gb-p2-contract-'));
  const child = spawn(process.execPath, [
    join(root, 'dist/main.js'),
    '--state-dir', directory,
    '--app', '/nonexistent',
    '--profile', join(directory, 'nonexistent-profile'),
    '--gemini-dir', join(directory, 'gemini'),
    '--home-dir', directory,
    '--app-support-dir', directory,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', bytes => { errors += bytes; });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    await until(async () => { try { return (await rpc(directory, { command: 'status' })).ok; } catch { return false; } });
    const status = await rpc(directory, { command: 'status' });
    assert.equal(status.ok, true);
    assert.ok(Object.hasOwn(status.status, 'activeAccountEmail'), 'socket status 必须提供账号字段');
    assert.equal(typeof status.taskRevision, 'number');
    assert.equal(typeof status.runningTasks, 'number');

    const persisted = await until(async () => {
      try { const value = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8')); return value.pid ? value : false; } catch { return false; }
    });
    assert.equal(typeof persisted.pid, 'number');
    assert.equal(typeof persisted.taskRevision, 'number');
    assert.equal(typeof persisted.runningTasks, 'number');
    assert.equal(Object.hasOwn(persisted, 'activeAccountEmail'), false, 'status.json 不承载账号字段，需由原生合并保留');

    const usage = await rpc(directory, { command: 'usage_summary', period: 'today' });
    assert.equal(usage.ok, true);
    assert.equal(usage.summary.failedDatabasesCount, 0);
    assert.equal(usage.summary.skippedLargeRecords, 0);
    assert.equal(typeof usage.summary.lastScannedAt, 'number');
    assert.ok(usage.summary.lastScannedAt > 0, '必须返回最后扫描时间');
    assert.equal(usage.summary.hasError, false);

    assert.equal((await rpc(directory, { command: 'stop' })).ok, true);
    await closed;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
  assert.doesNotMatch(errors, /\[GravityBox\]/, '后台进程不得输出异常日志');
});
