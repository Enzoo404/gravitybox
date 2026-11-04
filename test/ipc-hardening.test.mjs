import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Raw socket round-trip: the caller decides how the request is sliced. */
function exchange(directory, chunks, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(directory, 'control.sock'));
    let value = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('IPC 超时')); }, timeout);
    const finish = error => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    socket.on('connect', async () => {
      for (const chunk of chunks) { socket.write(chunk); await sleep(60); }
    });
    socket.on('data', chunk => {
      value += chunk;
      if (value.includes('\n')) finish();
    });
    socket.on('error', finish);
    socket.on('close', () => { if (value.includes('\n')) finish(); });
  });
}

async function startBackend() {
  const directory = await mkdtemp('/tmp/gb-ipc-hard-');
  await mkdir(join(directory, '词典'));
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('../dist/main.js', import.meta.url)),
    '--state-dir', directory, '--app', '/nonexistent', '--profile', '/tmp/gb-nonexistent-profile',
    '--gemini-dir', join(directory, 'gemini'),
    '--home-dir',directory,'--app-support-dir',directory,
  ], { stdio: ['ignore', 'ignore', 'pipe'],env:{...process.env,GRAVITYBOX_PROBE_LS:'false'} });
  let errors = '';
  child.stderr.on('data', bytes => { errors += bytes; });
  return { directory, child, errors: () => errors };
}

async function waitForStatus(directory) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const reply = JSON.parse((await exchange(directory, [JSON.stringify({ command: 'status', includeTasks: false }) + '\n'])).split('\n')[0]);
      if (reply.ok) return reply;
    } catch {}
    await sleep(60);
  }
  throw new Error('后台未在时限内启动');
}

test('IPC：半包分片仍只产生一条回复，且不重复应答', async () => {
  const backend = await startBackend();
  try {
    await waitForStatus(backend.directory);
    const payload = JSON.stringify({ command: 'status', includeTasks: false }) + '\n';
    const raw = await exchange(backend.directory, [payload.slice(0, 9), payload.slice(9)]);
    const line = raw.split('\n')[0];
    assert.equal(JSON.parse(line).ok, true);
    // 一条请求只允许一条回复：分片不应造成两次应答。
    assert.equal(raw.split('\n').filter(Boolean).length, 1);
  } finally { backend.child.kill(); }
});

test('IPC：超过 4MB 的请求收到明确拒绝而不是静默断连', async () => {
  const backend = await startBackend();
  try {
    await waitForStatus(backend.directory);
    // 无换行的超限请求体：旧实现直接 destroy()，客户端只能等到超时。
    const raw = await exchange(backend.directory, [Buffer.alloc(4_200_000, 0x61)], { timeout: 10_000 });
    const reply = JSON.parse(raw.split('\n')[0]);
    assert.equal(reply.ok, false);
    assert.match(reply.error, /请求过大/);
  } finally { backend.child.kill(); }
});

test('IPC：并发请求各自收到自己的回复', async () => {
  const backend = await startBackend();
  try {
    await waitForStatus(backend.directory);
    const [a, b] = await Promise.all([
      exchange(backend.directory, [JSON.stringify({ command: 'status', includeTasks: false }) + '\n']),
      exchange(backend.directory, [JSON.stringify({ command: 'task_list' }) + '\n']),
    ]);
    assert.equal(JSON.parse(a.split('\n')[0]).ok, true);
    const second = JSON.parse(b.split('\n')[0]);
    assert.equal(second.ok, true);
    assert.ok(Array.isArray(second.tasks));
  } finally { backend.child.kill(); }
});

test('IPC v2：requestId与幂等业务载荷分离，响应透传且重放一致', async () => {
  const backend = await startBackend();
  try {
    await waitForStatus(backend.directory);
    const req1 = { requestId: 'test-req-001', idempotencyKey: 'idem-key-abc', command: 'status', includeTasks: false };
    const raw1 = await exchange(backend.directory, [JSON.stringify(req1) + '\n']);
    const rep1 = JSON.parse(raw1.split('\n')[0]);
    assert.equal(rep1.ok, true);
    assert.equal(rep1.requestId, 'test-req-001', '必须在响应中原样透传请求 id');

    // 发起带有相同幂等键的第二次请求
    const req2 = { requestId: 'test-req-002', idempotencyKey: 'idem-key-abc', command: 'status', includeTasks: false };
    const raw2 = await exchange(backend.directory, [JSON.stringify(req2) + '\n']);
    const rep2 = JSON.parse(raw2.split('\n')[0]);
    assert.equal(rep2.ok, true);
    assert.equal(rep2.taskRevision, rep1.taskRevision, '幂等请求必须返回一致的响应数据');
  } finally { backend.child.kill(); }
});

test('IPC v2：只读命令 dashboard_summary 支持立即应答且异常信息脱敏', async () => {
  const backend = await startBackend();
  try {
    await waitForStatus(backend.directory);
    const raw = await exchange(backend.directory, [JSON.stringify({ id: 'dash-01', command: 'dashboard_summary' }) + '\n']);
    const rep = JSON.parse(raw.split('\n')[0]);
    assert.equal(rep.ok, true);
    assert.equal(rep.id, 'dash-01');
    assert.ok(rep.dictionary);

    // 测试错误脱敏：请求未知命令或非法参数时，返回信息不得包含敏感物理路径
    const badRaw = await exchange(backend.directory, [JSON.stringify({ command: 'account_upsert', data: { id: '/Users/private/bad' } }) + '\n']);
    const badRep = JSON.parse(badRaw.split('\n')[0]);
    assert.equal(badRep.ok, false);
    assert.ok(!badRep.error.includes('/Users/private'), '异常文案中不得泄漏系统物理路径');
  } finally { backend.child.kill(); }
});

test('幂等键绑定业务账号，传输 requestId 不参与业务指纹', async()=>{
 const backend=await startBackend(); try {
  await waitForStatus(backend.directory);
  const payload={command:'account_upsert',data:{email:'idempotent@example.invalid',refreshToken:'synthetic-refresh',accessToken:'synthetic-access',expiresIn:3600},idempotencyKey:'write-once'};
  const replies=await Promise.all(['one','two'].map(requestId=>exchange(backend.directory,[JSON.stringify({...payload,requestId})+'\n'])));
  const values=replies.map(JSON.parse); for(const value of values)assert.equal(value.ok,true);
  assert.equal(values[0].account.id,values[1].account.id);assert.notEqual(values[0].requestId,values[1].requestId);
  const conflict=JSON.parse(await exchange(backend.directory,[JSON.stringify({...payload,data:{...payload.data,email:'different@example.invalid'}})+'\n']));
  assert.equal(conflict.ok,false);assert.match(conflict.error,/其他请求/);
 }finally{backend.child.kill();}
});
