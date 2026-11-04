import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../dist/controller.js';
import { Tasks } from '../dist/tasks.js';
import { dictionaryFromEntries } from '../dist/dictionary.js';

// P1 状态契约（A03 / D05）的隔离回归测试：只使用临时 state 目录与本地 fetch 桩，
// 不触碰真实应用、用户数据或 socket 写命令。

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(20);
  }
  throw new Error('测试等待超时');
}

const CONFIG = { preset: 'openai', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'synthetic-model', apiKey: 'SYNTHETIC_NOT_A_SECRET' };
const AUTH = { authorized: true, preset: 'openai', host: 'https://api.openai.com:443' };

/** 按 main.ts 的接线方式把 Controller 与 Tasks 连起来，并把每次 status 快照写入临时 status.json。 */
function createHarness(stateDir) {
  const snapshots = [];
  let writeChain = Promise.resolve();
  let tasks;
  let controller;
  const onStatus = status => {
    const snapshot = {
      ...status,
      taskRevision: tasks?.revision ?? 0,
      runningTasks: tasks ? tasks.list().filter(task => task.state === 'running').length : 0,
    };
    snapshots.push(snapshot);
    writeChain = writeChain.catch(() => {}).then(() => writeFile(join(stateDir, 'status.json'), JSON.stringify(snapshot, null, 2)));
    writeChain.catch(() => {});
  };
  controller = new Controller({
    appPath: '/synthetic',
    profile: '/synthetic',
    dictionary: dictionaryFromEntries({}),
    stateDir,
    onStatus,
  });
  // 隔离测试不连接真实应用：扫描结果直接注入一条待补全候选。
  controller.scanCoverage = async () => {
    controller.trustedCandidates = [{ key: 'Open in Antigravity', source: 'static' }];
    return { ok: true, message: 'ok' };
  };
  tasks = new Tasks(stateDir, () => onStatus(controller.snapshot()));
  return { controller, tasks, snapshots, flush: () => writeChain };
}

test('D05: task_cancel 对不存在/已结束/id 不匹配任务返回 false，正常取消路径不变', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'gb-p1-tasks-cancel-'));
  let tasks;
  try {
    tasks = new Tasks(stateDir, () => {});
    await tasks.start();

    // 不存在与已结束（无运行任务）都不能假成功。
    assert.equal(tasks.cancel('no-such-task'), false);
    assert.equal(tasks.cancel(), false);

    let aborted = false;
    const taskId = tasks.begin('test', '取消路径测试', signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('已取消任务')); }, { once: true });
    }));
    await until(() => tasks.list().some(task => task.id === taskId && task.state === 'running'));

    assert.equal(tasks.cancel('another-task-id'), false, 'id 不匹配必须返回 false');
    assert.equal(tasks.cancel(taskId), true, '正常取消路径必须返回 true');

    await until(() => tasks.list().find(task => task.id === taskId)?.state === 'cancelled');
    assert.equal(aborted, true);
    assert.equal(tasks.cancel(taskId), false, '已结束任务不能假成功');
  } finally {
    await tasks.stop().catch(() => {});
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
