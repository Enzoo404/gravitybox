import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationTarget } from '../dist/application-target.js';
import { groupToQuotaGroup, modelQuotaFromNormalized } from '../dist/account-quota.js';
import {
  clearLiveEndpointCache,
  collectLanguageServerCandidates,
  extractCsrfTokenFromCommand,
  extractCsrfTokenFromPsEnv,
  parseLoopbackListenPorts,
  probeLiveLanguageServerOnce,
} from '../dist/account-probe.js';

const LS_BIN = '/Applications/Antigravity.app/Contents/Resources/bin/language_server';
const INSIDERS_LS_BIN = '/Applications/Antigravity - Insiders.app/Contents/Resources/bin/language_server';
const testTarget = () => applicationTarget('stable', '/Users/test', { appPath: '/Applications/Antigravity.app' });
const testMappers = { modelQuotaFromNormalized, groupToQuotaGroup };

function makeFetchMock({
  expectedToken,
  expectedPort,
  email,
  failPorts = new Set(),
  onRequest,
}) {
  return async (url, init) => {
    const parsedUrl = new URL(url);
    const port = Number(parsedUrl.port);
    const token = init?.headers?.['x-codeium-csrf-token'];
    onRequest?.({ url, port, token });

    if (failPorts.has(port) || port !== expectedPort || token !== expectedToken) {
      return new Response('unauthorized', { status: 403 });
    }
    if (parsedUrl.pathname.endsWith('/GetUserStatus')) {
      return Response.json({
        userStatus: {
          email,
          name: 'Probe Test User',
          userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
          cascadeModelConfigData: {
            clientModelConfigs: [
              {
                modelId: 'gemini-3-pro',
                label: 'Gemini 3 Pro',
                quotaInfo: { remainingFraction: 0.85 },
              },
            ],
          },
        },
      });
    }
    if (parsedUrl.pathname.endsWith('/RetrieveUserQuotaSummary')) {
      return Response.json({
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.85 }],
          },
        ],
      });
    }
    return new Response('not found', { status: 404 });
  };
}

test('纯解析助手：收集全部官方 language_server 候选并正确抽取 CLI/环境变量 CSRF Token 与回环端口', () => {
  const target = testTarget();
  const cmdLegacy = `${LS_BIN} --app_data_dir antigravity --csrf_token=test-csrf-legacy --override_ide_version 2.33.0`;
  const cmdModern = `${LS_BIN} --app_data_dir antigravity --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com --subclient_type hub --override_ide_version 2.34.0 --read_host_bridge_token_from_stdin`;
  const psOut = [
    `101 /Applications/Antigravity.app/Contents/MacOS/Antigravity --type=renderer`,
    `102 ${INSIDERS_LS_BIN} --app_data_dir antigravity-insiders --csrf_token=wrong-insiders`,
    `103 ${LS_BIN} --app_data_dir antigravity-insiders --override_ide_version 2.34.0`,
    `201 ${cmdLegacy}`,
    `202 ${cmdModern}`,
    `bad-pid ${cmdModern}`,
    `0 ${cmdModern}`,
  ].join('\n');

  const candidates = collectLanguageServerCandidates(psOut, target);
  assert.deepEqual(candidates, [
    { pid: 201, cmd: cmdLegacy, appPath: '/Applications/Antigravity.app' },
    { pid: 202, cmd: cmdModern, appPath: '/Applications/Antigravity.app' },
  ]);

  assert.equal(extractCsrfTokenFromCommand(cmdLegacy), 'test-csrf-legacy');
  assert.equal(extractCsrfTokenFromCommand(`${LS_BIN} --csrf_token   test-csrf-spaced --app_data_dir antigravity`), 'test-csrf-spaced');
  assert.equal(extractCsrfTokenFromCommand(`${LS_BIN} --other_csrf_token=wrong --csrf_token= --app_data_dir antigravity`), null);
  assert.equal(extractCsrfTokenFromCommand(cmdModern), null);

  // 即使前面 PATH 包含空格，且存在 ANTIGRAVITY_CSRF_TOKEN 干扰变量或 CLI 伪造字符串，也必须精确提取环境变量中的 ANTIGRAVITY_SERVER_CSRF_TOKEN
  const cmdWithFakeArg = `${LS_BIN} --app_data_dir antigravity --note ANTIGRAVITY_SERVER_CSRF_TOKEN=fake-in-argv`;
  assert.equal(extractCsrfTokenFromPsEnv(`${cmdWithFakeArg}\n`, cmdWithFakeArg), null);

  const psEnvWithSpaces = `${cmdWithFakeArg} PATH=/Users/test/Application Support/Antigravity/bin:/usr/bin ANTIGRAVITY_CSRF_TOKEN=test-sidecar-wrong ANTIGRAVITY_SERVER_CSRF_TOKEN=test-csrf-2340-ok SHELL=/bin/zsh\n`;
  assert.equal(extractCsrfTokenFromPsEnv(psEnvWithSpaces, cmdWithFakeArg), 'test-csrf-2340-ok');
  assert.equal(extractCsrfTokenFromPsEnv(`${cmdModern} ANTIGRAVITY_CSRF_TOKEN=only-client-token\n`, cmdModern), null);
  assert.equal(extractCsrfTokenFromPsEnv(`${cmdModern} ANTIGRAVITY_SERVER_CSRF_TOKEN= PATH=/usr/bin\n`, cmdModern), null);

  const lsofOut = ['p202', 'n[::1]:55555', 'n127.0.0.1:41001', 'n127.0.0.1:41001', 'n127.0.0.1:41002'].join('\n');
  assert.deepEqual(parseLoopbackListenPorts(lsofOut), [41001, 41002]);
});

test('Antigravity <= 2.33.0：直接从 CLI --csrf_token 提取凭据并完成本地 RPC，不调用 ps -E', async () => {
  clearLiveEndpointCache();
  const target = testTarget();
  const legacyToken = 'test-csrf-legacy-2330';
  const legacyCmd = `${LS_BIN} --app_data_dir antigravity --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com --csrf_token ${legacyToken} --override_ide_version 2.33.0`;
  const execCalls = [];
  const rpcRequests = [];

  const execFileImpl = async (file, args) => {
    execCalls.push({ file, args: [...args] });
    if (file === '/bin/ps' && args[0] === '-ax') {
      return { stdout: `  3301 ${legacyCmd}\n` };
    }
    if (file.endsWith('/lsof') || file === 'lsof') {
      assert.ok(args.includes('3301'));
      return { stdout: 'p3301\nn127.0.0.1:43301\n' };
    }
    throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
  };

  const fetchImpl = makeFetchMock({
    expectedToken: legacyToken,
    expectedPort: 43301,
    email: 'legacy-probe@example.invalid',
    onRequest: req => rpcRequests.push(req),
  });

  const status = await probeLiveLanguageServerOnce(target, fetchImpl, { execFileImpl }, testMappers);
  assert.ok(status);
  assert.equal(status.email, 'legacy-probe@example.invalid');
  assert.equal(status.tier, 'PRO');
  assert.equal(status.quota.source, 'live');
  assert.equal(status.quota.models[0]?.percentage, 85);
  assert.equal(execCalls.some(c => c.file === '/bin/ps' && c.args.includes('-E')), false, 'CLI 已有 token 时不得调用 ps -E');
  assert.equal(rpcRequests.length, 2);
  assert.ok(!JSON.stringify(status).includes(legacyToken), '返回结构不得暴露 csrfToken');
});

test('Antigravity >= 2.34.0：回退仅针对已核验 PID 调用 ps -E -p <pid>，忽略含空格 PATH 与 sidecar ANTIGRAVITY_CSRF_TOKEN', async () => {
  clearLiveEndpointCache();
  const target = testTarget();
  const envToken = 'test-csrf-env-2340';
  const sidecarToken = 'test-sidecar-csrf-should-ignore';
  const modernCmd = `${LS_BIN} --app_data_dir antigravity --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com --subclient_type hub --override_ide_version 2.34.0 --read_host_bridge_token_from_stdin`;
  const execCalls = [];
  const leakedEnvMarker = 'PATH=/Users/test/Application Support/Antigravity/bin:/usr/bin';

  const execFileImpl = async (file, args) => {
    execCalls.push({ file, args: [...args] });
    if (file === '/bin/ps' && args[0] === '-ax') {
      return {
        stdout: [
          `  4001 /usr/local/bin/sidecar --mode=helper`,
          `  4002 ${INSIDERS_LS_BIN} --app_data_dir antigravity-insiders --override_ide_version 2.34.0`,
          `  4340 ${modernCmd}`,
        ].join('\n'),
      };
    }
    if (file === '/bin/ps' && args[0] === '-E') {
      assert.deepEqual(args, ['-E', '-p', '4340', '-ww', '-o', 'args='], '严禁对非目标 PID 或使用 -E -ax 扫描');
      return {
        stdout: `${modernCmd} ${leakedEnvMarker} HOME=/Users/test ANTIGRAVITY_CSRF_TOKEN=${sidecarToken} ANTIGRAVITY_SERVER_CSRF_TOKEN=${envToken} SHELL=/bin/zsh\n`,
      };
    }
    if (file.endsWith('/lsof') || file === 'lsof') {
      assert.ok(args.includes('4340'));
      return { stdout: 'p4340\nn127.0.0.1:43401\n' };
    }
    throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
  };

  const fetchImpl = makeFetchMock({
    expectedToken: envToken,
    expectedPort: 43401,
    email: 'modern-2340@example.invalid',
  });

  const status = await probeLiveLanguageServerOnce(target, fetchImpl, { execFileImpl }, testMappers);
  assert.ok(status);
  assert.equal(status.email, 'modern-2340@example.invalid');
  assert.equal(status.quota.models[0]?.percentage, 85);

  const psEnvCalls = execCalls.filter(c => c.file === '/bin/ps' && c.args.includes('-E'));
  assert.equal(psEnvCalls.length, 1);
  assert.equal(psEnvCalls[0].args.includes('-ax'), false);
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes(envToken), '返回结构不得包含 csrfToken');
  assert.ok(!serialized.includes(leakedEnvMarker), '返回结构不得暴露 ps -E 环境文本');
});

test('多候选回退：首个 language_server 无监听端口或 RPC 失败时，继续探测后续候选直至成功', async () => {
  clearLiveEndpointCache();
  const target = testTarget();
  const cmdNoPorts = `${LS_BIN} --app_data_dir antigravity --subclient_type worker --override_ide_version 2.34.0`;
  const cmdRpcFail = `${LS_BIN} --app_data_dir antigravity --subclient_type stale --override_ide_version 2.34.0`;
  const cmdHealthy = `${LS_BIN} --app_data_dir antigravity --subclient_type hub --override_ide_version 2.34.0`;
  const tokenFail = 'test-csrf-candidate-fail';
  const tokenHealthy = 'test-csrf-candidate-healthy';
  const probedPids = [];

  const execFileImpl = async (file, args) => {
    if (file === '/bin/ps' && args[0] === '-ax') {
      return {
        stdout: [
          `  5001 ${cmdNoPorts}`,
          `  5002 ${cmdRpcFail}`,
          `  5003 ${cmdHealthy}`,
        ].join('\n'),
      };
    }
    if (file === '/bin/ps' && args[0] === '-E') {
      const pid = args[2];
      probedPids.push(pid);
      if (pid === '5001') {
        return { stdout: `${cmdNoPorts} ANTIGRAVITY_SERVER_CSRF_TOKEN=test-csrf-no-ports\n` };
      }
      if (pid === '5002') {
        return { stdout: `${cmdRpcFail} ANTIGRAVITY_SERVER_CSRF_TOKEN=${tokenFail}\n` };
      }
      if (pid === '5003') {
        return { stdout: `${cmdHealthy} PATH=/Users/test/Application Support/Antigravity/bin ANTIGRAVITY_SERVER_CSRF_TOKEN=${tokenHealthy}\n` };
      }
    }
    if (file.endsWith('/lsof') || file === 'lsof') {
      const pid = args[3];
      if (pid === '5001') {
        // 模拟无监听端口时 lsof 返回非零退出码
        throw new Error('lsof exited with code 1');
      }
      if (pid === '5002') {
        return { stdout: 'p5002\nn127.0.0.1:45002\n' };
      }
      if (pid === '5003') {
        return { stdout: 'p5003\nn127.0.0.1:45003\n' };
      }
    }
    throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
  };

  const fetchImpl = makeFetchMock({
    expectedToken: tokenHealthy,
    expectedPort: 45003,
    failPorts: new Set([45002]),
    email: 'fallback-winner@example.invalid',
  });

  const status = await probeLiveLanguageServerOnce(target, fetchImpl, { execFileImpl }, testMappers);
  assert.ok(status);
  assert.equal(status.email, 'fallback-winner@example.invalid');
  assert.deepEqual(probedPids, ['5001', '5002', '5003']);

  // 全部候选均无法命中时应平稳返回 null
  const nullStatus = await probeLiveLanguageServerOnce(
    target,
    makeFetchMock({ expectedToken: 'never-match', expectedPort: 49999, email: 'none@example.invalid' }),
    { execFileImpl },
    testMappers
  );
  assert.equal(nullStatus, null);
});
