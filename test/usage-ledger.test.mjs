import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStatsManager, matchPricingKeys } from '../dist/usage.js';
import { normalizeModelId } from '../dist/model-identity.js';

test('Vertex AI 模型路径清洗与价格归一化', () => {
  // 1. 规范化函数剥离 Vertex AI / GCP 前缀与 RPC 后缀
  assert.equal(
    normalizeModelId('publishers/google/models/gemini-4-carbon-preview'),
    'gemini-4-carbon-preview'
  );
  assert.equal(
    normalizeModelId('projects/my-enterprise-proj/locations/us-central1/publishers/google/models/gemini-2.5-flash:predict'),
    'gemini-2.5-flash'
  );
  assert.equal(
    normalizeModelId('publishers/google/models/gemini-4-carbon@001'),
    'gemini-4-carbon-001'
  );

  // 2. Pricing key 匹配
  assert.equal(matchPricingKeys('gemini-4-carbon-preview'), 'gemini-4-carbon');
  assert.equal(matchPricingKeys('gemini-4-carbon-001'), 'gemini-4-carbon');
  assert.equal(matchPricingKeys('gemini-2.5-flash'), 'gemini-2.5-flash');
});

test('追加型总账：即使底层数据库被官方清除，历史事件与 Token 依然完好留存', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'gb-ledger-test-'));
  try {
    const manager = new UsageStatsManager({ stateDir: tempDir, geminiDir: '/synthetic/gemini' });

    // 模拟初次读取：包含一个普通数据库和一个即将被删除的企业会话数据库
    const liveDb1 = '/synthetic/gemini/conversations/user-session-1.db';
    const enterpriseDb = '/synthetic/gemini/conversations/enterprise-session-carbon.db';

    manager.discoverDatabaseFiles = async () => [liveDb1, enterpriseDb];
    manager.scanDatabaseEvents = async (dbPath) => {
      if (dbPath === enterpriseDb) {
        return {
          events: [
            {
              event_key: '1111111111111111111111111111111111111111111111111111111111111111',
              model: 'gemini-4-carbon',
              input_tokens: 1000,
              output_tokens: 200,
              cached_tokens: 500,
              total_tokens: 1700,
              timestamp_seconds: 1731400000,
              account_id: 'acc-zhangli-1',
              account_email: 'abeyond404@gmail.com',
            },
          ],
          generationsScanned: 1,
          skippedLargeRecords: 0,
          cacheHit: false,
          hasError: false,
        };
      }
      return {
        events: [
          {
            event_key: '2222222222222222222222222222222222222222222222222222222222222222',
            model: 'gemini-2.5-flash',
            input_tokens: 500,
            output_tokens: 100,
            cached_tokens: 0,
            total_tokens: 600,
            timestamp_seconds: 1731400010,
            account_type: 'consumer',
            account_id: 'acc-personal-1',
            account_email: 'dev@gmail.com',
          },
        ],
        generationsScanned: 1,
        skippedLargeRecords: 0,
        cacheHit: false,
        hasError: false,
      };
    };

    const firstSummary = await manager.getUsageSummary(true);
    assert.equal(firstSummary.all_time.totals.total_tokens, 2300);
    assert.equal(firstSummary.all_time.totals.request_count, 2);

    // 检查账本文件是否已经持久化
    const ledgerRaw = await readFile(join(tempDir, 'usage-ledger.json'), 'utf8');
    const ledger = JSON.parse(ledgerRaw);
    assert.equal(ledger.version, 1);
    assert.ok(Array.isArray(ledger.events));
    assert.ok(ledger.events.some((e) => e.event_key === '1111111111111111111111111111111111111111111111111111111111111111'));
    assert.ok(ledger.events.some((e) => e.event_key === '2222222222222222222222222222222222222222222222222222222222222222'));

    // 模拟场景：用户退出企业账号，Antigravity 官方物理删除了 enterpriseSession 数据库！
    const secondManager = new UsageStatsManager({ stateDir: tempDir, geminiDir: '/synthetic/gemini' });
    // 此时磁盘上仅剩 liveDb1，enterpriseDb 已经彻底消失
    secondManager.discoverDatabaseFiles = async () => [liveDb1];
    secondManager.scanDatabaseEvents = async () => ({
      events: [
        {
          event_key: '2222222222222222222222222222222222222222222222222222222222222222',
          model: 'gemini-2.5-flash',
          input_tokens: 500,
          output_tokens: 100,
          cached_tokens: 0,
          total_tokens: 600,
          timestamp_seconds: 1731400010,
          account_type: 'consumer',
          account_id: 'acc-personal-1',
          account_email: 'dev@gmail.com',
        },
      ],
      generationsScanned: 1,
      skippedLargeRecords: 0,
      cacheHit: false,
      hasError: false,
    });

    const secondSummary = await secondManager.getUsageSummary(true);
    // 即使 enterpriseDb 物理不存在，总账自动合并并保留了 carbon-event-1！
    assert.equal(secondSummary.all_time.totals.total_tokens, 2300);
    assert.equal(secondSummary.all_time.totals.request_count, 2);
    const carbonModel = secondSummary.all_time.by_model.find((m) => m.model === 'gemini-4-carbon');
    assert.ok(carbonModel);
    assert.equal(carbonModel.total_tokens, 1700);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('自动灾难自愈：从历史 rate-locks 逆推恢复已被官方删除的会话事件', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'gb-heal-test-'));
  try {
    // 构造场景：磁盘上没有任何 .db 文件，也没有 usage-ledger.json
    // 但 usage-rate-locks.json 中保留了 86 条 carbon 锁定记录
    const rateLocks = {
      version: 1,
      profiles: [
        {
          model: 'gemini-4-carbon',
          input: 2.0,
          output: 10.0,
          cached: 0.1,
          provenance: { platform: 'Google Cloud Vertex AI' },
        },
      ],
      entries: {
        '3333333333333333333333333333333333333333333333333333333333333333': {
          usd: 0.05,
          p: 0,
        },
      },
    };
    await writeFile(join(tempDir, 'usage-rate-locks.json'), JSON.stringify(rateLocks));

    const manager = new UsageStatsManager({ stateDir: tempDir, geminiDir: '/synthetic/empty' });
    manager.discoverDatabaseFiles = async () => [];

    const summary = await manager.getUsageSummary(true);
    // 自愈机制成功恢复出 sample-1 事件
    assert.equal(summary.all_time.totals.request_count, 1);
    assert.ok(summary.all_time.estimated_usd > 0);
    const model = summary.all_time.by_model[0];
    assert.equal(model.model, 'gemini-4-carbon');
    assert.equal(model.priced, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('账号下钻筛选器：首项全部账号，后续依次排列真实账号（按邮箱），杜绝虚假分类', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'gb-filter-test-'));
  try {
    const manager = new UsageStatsManager({ stateDir: tempDir, geminiDir: '/synthetic/gemini' });
    // 注入当前保存的已知真实账号列表（例如当前账号、第二个账号、第三个账号）
    manager.setKnownAccounts([
      { id: 'acc_siensen', email: 'siensen1896@gmail.com', name: '无限' },
      { id: 'acc_zhangli', email: 'abeyond404@gmail.com', name: '张礼' },
      { id: 'acc_wenqi', email: 'zanenx404@gmail.com', name: 'Wen Qi Zhang' },
    ]);

    manager.discoverDatabaseFiles = async () => ['synthetic'];
    manager.scanDatabaseEvents = async () => ({
      events: [
        {
          event_key: 'ev-carbon-1',
          model: 'gemini-4-carbon',
          input_tokens: 1000,
          output_tokens: 200,
          cached_tokens: 0,
          total_tokens: 1200,
          timestamp_seconds: 1731420000,
          account_id: 'acc_zhangli',
          account_email: 'abeyond404@gmail.com',
        },
        {
          event_key: 'ev-flash-1',
          model: 'gemini-2.5-flash',
          input_tokens: 300,
          output_tokens: 100,
          cached_tokens: 0,
          total_tokens: 400,
          timestamp_seconds: 1731420100,
          account_id: 'acc_siensen',
          account_email: 'siensen1896@gmail.com',
        },
      ],
      generationsScanned: 2,
      skippedLargeRecords: 0,
      cacheHit: false,
      hasError: false,
    });

    // 1. 全部账号模式 (all)
    const allSummary = await manager.getUsageSummary(true, 'all');
    assert.equal(allSummary.all_time.totals.total_tokens, 1600);
    assert.equal(allSummary.all_time.totals.request_count, 2);
    // 依次为：全部账号、siensen1896@gmail.com、abeyond404@gmail.com、zanenx404@gmail.com
    assert.equal(allSummary.available_accounts?.length, 4);
    assert.equal(allSummary.available_accounts[0].id, 'all');
    assert.equal(allSummary.available_accounts[0].label, '全部账号');
    assert.equal(allSummary.available_accounts[1].label, 'siensen1896@gmail.com');
    assert.equal(allSummary.available_accounts[2].label, 'abeyond404@gmail.com');
    assert.equal(allSummary.available_accounts[3].label, 'zanenx404@gmail.com');
    assert.equal(allSummary.selected_account_id, 'all');

    // 2. 筛选张礼（abeyond404@gmail.com）— 包含其 Vertex 项目的 Gemini 4 Carbon
    const zhangliSummary = await manager.getUsageSummary(true, 'acc_zhangli');
    assert.equal(zhangliSummary.all_time.totals.total_tokens, 1200);
    assert.equal(zhangliSummary.all_time.totals.request_count, 1);
    assert.equal(zhangliSummary.all_time.by_model.length, 1);
    assert.equal(zhangliSummary.all_time.by_model[0].model, 'gemini-4-carbon');
    assert.equal(zhangliSummary.selected_account_id, 'acc_zhangli');

    // 3. 筛选当前账号无限（siensen1896@gmail.com）
    const siensenSummary = await manager.getUsageSummary(true, 'acc_siensen');
    assert.equal(siensenSummary.all_time.totals.total_tokens, 400);
    assert.equal(siensenSummary.all_time.totals.request_count, 1);
    assert.equal(siensenSummary.all_time.by_model.length, 1);
    assert.equal(siensenSummary.all_time.by_model[0].model, 'gemini-2.5-flash');
    assert.equal(siensenSummary.selected_account_id, 'acc_siensen');

    // 4. 事件分页明细筛选测试
    const zhangliEvents = await manager.getUsageEvents('all', '', 0, 10, undefined, false, false, 'acc_zhangli');
    assert.equal(zhangliEvents.total, 1);
    assert.equal(zhangliEvents.rows[0].model, 'gemini-4-carbon');

    const siensenEvents = await manager.getUsageEvents('all', '', 0, 10, undefined, false, false, 'acc_siensen');
    assert.equal(siensenEvents.total, 1);
    assert.equal(siensenEvents.rows[0].model, 'gemini-2.5-flash');

    // 5. 并发请求不同账号时必须各自返回对应账号统计，不得串号
    const [allRes, zhangliRes, siensenRes] = await Promise.all([
      manager.getUsageSummary(false, 'all'),
      manager.getUsageSummary(false, 'acc_zhangli'),
      manager.getUsageSummary(false, 'acc_siensen'),
    ]);
    assert.equal(allRes.all_time.totals.total_tokens, 1600);
    assert.equal(zhangliRes.all_time.totals.total_tokens, 1200);
    assert.equal(siensenRes.all_time.totals.total_tokens, 400);
    assert.notEqual(zhangliRes.snapshot_id, siensenRes.snapshot_id);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
