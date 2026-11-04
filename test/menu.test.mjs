import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Controller } from '../dist/controller.js';

test('生产控制器不探测或挂载主进程 Inspector', async () => {
  let requests = 0;
  const server = createServer((request, response) => { requests++; response.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new Controller({ appPath: '/nonexistent', profile: '/tmp/nonexistent-gravitybox-profile', inspectPort: server.address().port,
    dictionary: { schema: 1, version: 'test', entries: {} }, onStatus: () => {} });
  try { await controller.start(); assert.equal(requests, 0); assert.equal(controller.status.menuHooked, false); }
  finally { await controller.stop(); await new Promise(resolve => server.close(resolve)); }
});
