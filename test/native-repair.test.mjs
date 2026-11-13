import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';

const run = promisify(execFile);
const timeout = process.env.CI ? 180000 : 60000;
let buildDir, binary;

// Both probes exercise the same executable; keep fixture state isolated per test.
before(async () => {
  buildDir = await mkdtemp(join(tmpdir(), 'gb-native-repair-build-'));
  binary = join(buildDir, 'probe');
  await run('/usr/bin/swiftc', [
    '-parse-as-library', '-target', 'arm64-apple-macosx14.0',
    '-framework', 'Cocoa', '-framework', 'Security',
    'native/Backend.swift', 'native/Configuration.swift', 'test/native-repair.swift', '-o', binary,
  ]);
}, { timeout });
after(async () => { if (buildDir) await rm(buildDir, { recursive: true, force: true }); });

async function fixture(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('原生配置局部损坏保全、未来版本拒绝覆盖、长读取不阻塞取消通道', { timeout }, async t => {
  const dir = await fixture(t, 'gb-native-repair-');
  assert.match((await run(binary, ['config', dir])).stdout, /preservation passed/);
  const arrivals = [];
  const server = createServer(client => {
    let input = '';
    client.on('data', buffer => {
      input += buffer;
      if (!input.includes('\n')) return;
      const cmd = JSON.parse(input).command;
      arrivals.push({ cmd, at: performance.now() });
      setTimeout(() => client.end('{"ok":true}\n'), cmd === 'usage_summary' ? 800 : 0);
    });
    client.on('error', () => {});
  });
  await new Promise(resolve => server.listen(join(dir, 'control.sock'), resolve));
  try {
    await run(binary, ['bridge', dir]);
    assert.equal(arrivals.length, 2);
    assert.equal(arrivals[0].cmd, 'usage_summary');
    assert.equal(arrivals[1].cmd, 'usage_cancel');
    assert.ok(arrivals[1].at - arrivals[0].at < 300, JSON.stringify(arrivals));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Gatekeeper隔离属性剥除：内嵌 Node 与资源目录 quarantine 清理及子进程正常启动', { timeout }, async t => {
  const dir = await fixture(t, 'gb-native-quarantine-');
  assert.match((await run(binary, ['quarantine', dir])).stdout, /quarantine clearance passed/);
  assert.match((await run(binary, ['launch_quarantine', dir])).stdout, /quarantine launch passed/);
});
