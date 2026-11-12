import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePricingForTimestamp, UsageStatsManager, calculateEstimatedUsd } from '../dist/usage.js';
import { MODEL_PRICES } from '../dist/model-catalog.js';

test('时序费率解析：正确命中历史时段与当前时段', () => {
  const opus = MODEL_PRICES['claude-opus-5-5'];
  assert.ok(Array.isArray(opus) || (opus && Array.isArray(opus.intervals)), 'claude-opus-5-5 必须配置为时段区间');

  // 1. 2026年10月15日（调价前）：输入为 $5.00，输出为 $25.00
  const octStamp = Math.floor(Date.parse('2026-10-15T12:00:00Z') / 1000);
  const octPrice = resolvePricingForTimestamp(opus, octStamp, 'claude-opus-5-5');
  assert.ok(octPrice);
  assert.equal(octPrice.input, 5.0);
  assert.equal(octPrice.output, 25.0);
  assert.equal(octPrice.cached, 0.5);
  assert.equal(octPrice.cacheWrite, 6.25);

  // 2. 2026年11月02日（调价后最新）：输入为 $4.00，输出为 $20.00
  const novStamp = Math.floor(Date.parse('2026-11-02T12:00:00Z') / 1000);
  const novPrice = resolvePricingForTimestamp(opus, novStamp, 'claude-opus-5-5');
  assert.ok(novPrice);
  assert.equal(novPrice.input, 4.0);
  assert.equal(novPrice.output, 20.0);
  assert.equal(novPrice.cached, 0.2);
  assert.equal(novPrice.cacheWrite, 5.0);

  // 3. 2027年未来时段：Gemini 3.8 Flash 恢复标准单价
  const flash = MODEL_PRICES['gemini-3.8-flash'];
  const stamp2026 = Math.floor(Date.parse('2026-11-02T00:00:00Z') / 1000);
  const stamp2027 = Math.floor(Date.parse('2027-02-01T00:00:00Z') / 1000);
  const price2026 = resolvePricingForTimestamp(flash, stamp2026, 'gemini-3.8-flash');
  const price2027 = resolvePricingForTimestamp(flash, stamp2027, 'gemini-3.8-flash');
  assert.equal(price2026.input, 0.75);
  assert.equal(price2026.output, 3.75);
  assert.equal(price2027.input, 1.50);
  assert.equal(price2027.output, 7.50);
});

test('静态模型费率向后兼容：单对象格式全时段稳定生效', () => {
  const gpt4o = MODEL_PRICES['gpt-4o'];
  assert.ok(!Array.isArray(gpt4o) && !gpt4o.intervals, 'gpt-4o 保持单对象格式且无时段');
  const pastStamp = Math.floor(Date.parse('2025-01-01T00:00:00Z') / 1000);
  const futureStamp = Math.floor(Date.parse('2028-01-01T00:00:00Z') / 1000);
  assert.equal(resolvePricingForTimestamp(gpt4o, pastStamp).input, 2.5);
  assert.equal(resolvePricingForTimestamp(gpt4o, futureStamp).input, 2.5);
});

test('跨时段真实事件累计：历史事件金额永久冻结，不随调价回溯', () => {
  const opus = MODEL_PRICES['claude-opus-5-5'];
  const octStamp = Math.floor(Date.parse('2026-10-10T10:00:00Z') / 1000);
  const novStamp = Math.floor(Date.parse('2026-11-02T10:00:00Z') / 1000);

  const priceOct = resolvePricingForTimestamp(opus, octStamp, 'claude-opus-5-5');
  const priceNov = resolvePricingForTimestamp(opus, novStamp, 'claude-opus-5-5');

  // 10月消耗 1,000,000 Input Token (当时单价 $5.00)
  const costOct = calculateEstimatedUsd(1_000_000, 0, 0, priceOct);
  assert.equal(costOct, 5.0);

  // 11月消耗 1,000,000 Input Token (最新降价 $4.00)
  const costNov = calculateEstimatedUsd(1_000_000, 0, 0, priceNov);
  assert.equal(costNov, 4.0);

  // 两个月份累计总费用为精确的 $9.00（杜绝把10月份旧消耗按4元回溯折算为8元）
  const totalCost = costOct + costNov;
  assert.equal(totalCost, 9.0);
});

test('远程价格同步：优雅处理无网络或非法响应，绝不抛错阻断', async () => {
  const manager = new UsageStatsManager({ remotePricingUrl: 'http://127.0.0.1:9999/nonexistent.json' });
  const result = await manager.syncRemotePricing(undefined, true);
  assert.equal(result.synced, false);
  assert.ok(typeof result.error === 'string');
});

test('远程价格同步：请求头报告当前构建版本，测试缓存与日常数据隔离', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'gravitybox-pricing-version-'));
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  let capturedUserAgent = '';
  const server = createServer((req, res) => {
    capturedUserAgent = req.headers['user-agent'] ?? '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ prices: {} }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const manager = new UsageStatsManager({ stateDir: temp, geminiDir: join(temp, 'gemini'), remotePricingUrl: `http://127.0.0.1:${port}/feed.json` });
    const result = await manager.syncRemotePricing(undefined, true);
    assert.equal(result.synced, true);
    assert.equal(capturedUserAgent, `GravityBox/${version}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});

test('多源容灾：主源失败时自动无感故障切换至备用源，并完整沉淀元数据', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'gravitybox-pricing-fallback-'));
  let serverHits = 0;
  const mockServer = createServer((req, res) => {
    serverHits++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      version: '2026-11-12-test',
      prices: {
        'gemini-2.5-flash': {
          model: 'gemini-2.5-flash',
          input: 0.10,
          output: 0.40,
          cached: 0.025,
        }
      }
    }));
  });
  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;

  try {
    // 构造主源为一个不可达的死端口，备用源指向 mockServer
    const unreachableUrl = 'http://127.0.0.1:59999/bad-feed.json';
    const fallbackUrl = `http://127.0.0.1:${port}/cdn-feed.json`;

    const manager = new UsageStatsManager({
      stateDir: temp,
      geminiDir: join(temp, 'gemini'),
      remotePricingUrl: unreachableUrl, // 优先尝试的主源（模拟断网或阻断）
      fallbackPricingUrls: [fallbackUrl], // 备用 CDN 镜像源
    });

    const syncRes = await manager.syncRemotePricing(undefined, true);
    assert.equal(syncRes.synced, true, '主源失败后必须自动无感切换至备用源');
    assert.equal(syncRes.sourceUrl, fallbackUrl, '命中源必须为备用源');
    assert.equal(serverHits, 1, '备用 mockServer 必须被成功请求');

    // 验证 getPricingSyncStatus 状态可观测
    const status = await manager.getPricingSyncStatus();
    assert.ok(typeof status.autoSyncEnabled === 'boolean');
    assert.equal(status.lastSyncSuccess, true);
    assert.equal(status.sourceUrl, fallbackUrl);
    assert.ok(status.modelCount > 0);
  } finally {
    await new Promise(resolve => mockServer.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});

test('时序交替临界点 1 秒微小缝隙容错（Gap Tolerance）保护', () => {
  const flash = MODEL_PRICES['gemini-3.8-flash'];
  // 恰好落在 2026-12-31 23:59:59 最后一秒边界
  const boundaryStamp = Math.floor(Date.parse('2026-12-31T23:59:59Z') / 1000);
  const resolved = resolvePricingForTimestamp(flash, boundaryStamp, 'gemini-3.8-flash');
  assert.ok(resolved, '临界边界时间戳必须成功匹配');
  assert.equal(resolved.input, 0.75, '应正确继承 2026 年底有效费率');
});

test('安全防投毒校验：单价超过 $500/MTok 时严密拦截', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'gravitybox-pricing-poison-'));
  const manager = new UsageStatsManager({ stateDir: temp, geminiDir: join(temp, 'gemini') });
  await assert.rejects(
    manager.savePricingTable({
      'poisoned-model': { model: 'poisoned-model', input: 501.0, output: 1.0, cached: 0.1 }
    }),
    /超出合理范围/
  );
  await rm(temp, { recursive: true, force: true });
});

test('全自动智能补齐未计价（零按钮、用户无感）：仅补齐未计价历史，已锁定账本绝不动摇', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'gravitybox-autoheal-'));
  const manager = new UsageStatsManager({ stateDir: temp, geminiDir: join(temp, 'gemini') });
  manager.setAutoRemotePricingSync(true);

  // 1. 手动注入账本：1 条已锁定的正常计价记录 ($5.00) + 1 条历史未计价记录 ($0.00)
  const lockedKey = 'a'.repeat(64);
  const unpricedKey = 'b'.repeat(64);
  const now = Math.floor(Date.now() / 1000);
  
  // 模拟 rateLocks
  manager.rateLocks = {
    [lockedKey]: { usd: 5.0, price: { model: 'locked-model', input: 5, output: 5, cached: 1 } },
    [unpricedKey]: { usd: 0, price: { model: 'unpriced-model', input: 0, output: 0, cached: 0 } },
  };
  manager.rateLocksDirty = true;
  await manager.saveRateLocks();

  // 2. 模拟自动补齐自愈
  const healed = await manager.autoHealUnpricedHistory();
  assert.equal(healed, 1, '应精准识别并清理 1 条未计价条目');
  assert.equal(manager.rateLocks[lockedKey].usd, 5.0, '原本正常锁定的记录金额绝不受影响');
  assert.equal(manager.rateLocks[unpricedKey], undefined, '未计价记录旧锁已被释放以允许重新匹配新价');

  await rm(temp, { recursive: true, force: true });
});
