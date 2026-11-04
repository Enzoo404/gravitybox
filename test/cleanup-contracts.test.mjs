import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountsManager } from '../dist/accounts.js';

test('a successful live quota refresh commits its final account exactly once', async t => {
  const state = await mkdtemp(join(tmpdir(), 'gb-refresh-commit-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const manager = new AccountsManager(state);
  const account = await manager.upsertAccount({
    email: 'fixture@example.invalid', refreshToken: 'synthetic-refresh',
    accessToken: 'synthetic-access', expiresIn: 3600,
  });
  const quota = manager.fuseQuota({ models: {
    'gemini-fixture': { quotaInfo: { remainingFraction: 0.7 } },
  } }, { groups: [{ displayName: 'Gemini', buckets: [
    { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.7 },
  ] }] });
  manager.probeLiveLanguageServer = async () => ({ email: account.email, tier: 'FREE', quota });
  let commits = 0;
  const save = manager.saveRefreshedAccount.bind(manager);
  manager.saveRefreshedAccount = async (...args) => { commits++; return save(...args); };
  await manager.refreshQuota(account.id, async () => { throw new Error('unexpected network request'); });
  assert.equal(commits, 1);
  const saved = await manager.getAccount(account.id);
  assert.equal(saved.token.refresh_token, 'synthetic-refresh');
  assert.equal(manager.getAccountQuotaOverview(saved).geminiWeeklyRemaining, 70);
});

test('stale bucket samples do not change the group-based staleHours contract', () => {
  const nowMs = Date.parse('2030-01-01T00:00:00Z');
  const now = nowMs / 1000;
  const manager = new AccountsManager('/nonexistent-gravitybox-fixture');
  const result = manager.getAccountQuotaOverview({ quota: {
    models: [], last_updated: now, quota_groups: [{
      display_name: 'Gemini', observed_at: now, buckets: [{
        bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.7,
        observed_at: now - 7200, reset_time: '2030-01-02T00:00:00Z',
      }],
    }],
  } }, { nowMs });
  assert.equal(result.isStale, true);
  assert.equal(result.staleHours, 0);
});
