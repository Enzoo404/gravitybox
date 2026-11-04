import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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

test('远程价格同步：请求头包含规范 User-Agent (GravityBox/1.0.0)', async () => {
  let capturedUserAgent = '';
  const server = createServer((req, res) => {
    capturedUserAgent = req.headers['user-agent'] ?? '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ prices: {} }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const manager = new UsageStatsManager({ remotePricingUrl: `http://127.0.0.1:${port}/feed.json` });
    const result = await manager.syncRemotePricing(undefined, true);
    assert.equal(result.synced, true);
    assert.equal(capturedUserAgent, 'GravityBox/1.0.0');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
