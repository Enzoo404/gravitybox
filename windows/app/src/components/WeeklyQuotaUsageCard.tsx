import { useMemo, useState } from 'react';
import { CalendarRange, Server } from 'lucide-react';
import { BrandIcons } from './ModelIcon';
import { TierBadge } from './TierBadge';
import {
  accountDisplayName,
  formatCompactTokens,
  formatInteger,
  formatShortDateTime,
  normalizeTier,
} from '../lib/format';
import { formatPctNumber } from '../lib/quota';
import type { ResolvedLocale } from '../lib/i18n';
import type {
  AccountWeeklyAttribution,
  WeeklyAttributionConfidence,
  WeeklyCycleHistoryEntry,
  WeeklyPoolAttribution,
} from '../lib/types';

export interface WeeklyQuotaUsageCardProps {
  accounts: AccountWeeklyAttribution[];
  selectedAccountId: string;
  selectedAccountEmail?: string;
  activeAccountId?: string;
  activeEmail?: string;
  locale: ResolvedLocale;
  isDark: boolean;
  t: (key: string, params?: Record<string, string | number>, fallback?: string) => string;
}

function confidencePillClass(confidence: WeeklyAttributionConfidence): string {
  switch (confidence) {
    case 'high':
      return 'gb-pill-success';
    case 'medium':
      return 'gb-pill-blue';
    case 'low':
    case 'calibrating':
      return 'gb-pill-warning';
    case 'none':
    default:
      return 'gb-pill-neutral';
  }
}

function accountStableKey(acc: AccountWeeklyAttribution): string {
  const id = (acc.accountId ?? '').trim();
  if (id) return `id:${id}`;
  return `email:${acc.email.trim().toLowerCase()}`;
}

function isMatchingAccount(
  acc: AccountWeeklyAttribution,
  targetId?: string,
  targetEmail?: string,
): boolean {
  const cleanId = (targetId ?? '').trim();
  const cleanEmail = (targetEmail ?? '').trim().toLowerCase();
  if (cleanId && acc.accountId && acc.accountId === cleanId) return true;
  if (cleanEmail && acc.email && acc.email.trim().toLowerCase() === cleanEmail) return true;
  return false;
}

function PoolBreakdownTile({
  pool,
  locale,
  isDark,
  t,
}: {
  pool: WeeklyPoolAttribution;
  locale: ResolvedLocale;
  isDark: boolean;
  t: (key: string, params?: Record<string, string | number>, fallback?: string) => string;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);

  const cycleStartText = formatShortDateTime(pool.cycleStartSec);
  const cycleEndText = formatShortDateTime(pool.resetTimeSec);
  const visibleHistory: WeeklyCycleHistoryEntry[] = (pool.recentCycles ?? []).slice(0, 4);

  const unusedLocally = pool.localRequests <= 0;
  const isCalibrating = !unusedLocally && pool.localEstimatedUsedPct === null;

  const totalUsedStr = `${formatPctNumber(pool.totalUsedPct)}%`;
  const remainingStr = t('weekly_attribution.pool.remaining', {
    pct: formatPctNumber(pool.remainingPct),
  });

  const localPctDisplay = unusedLocally
    ? '0%'
    : isCalibrating
    ? t('weekly_attribution.pool.calibrating_value')
    : `~${formatPctNumber(pool.localEstimatedUsedPct!)}%`;

  const resolvedOtherPct = unusedLocally
    ? pool.totalUsedPct
    : pool.otherEstimatedUsedPct ??
      (pool.localEstimatedUsedPct !== null
        ? Math.max(0, pool.totalUsedPct - pool.localEstimatedUsedPct)
        : null);

  const otherPctDisplay = isCalibrating
    ? t('weekly_attribution.pool.pending_calibration')
    : resolvedOtherPct === null
    ? '--'
    : unusedLocally
    ? `${formatPctNumber(resolvedOtherPct)}%`
    : `~${formatPctNumber(resolvedOtherPct)}%`;

  const shareOfUsedPct =
    !unusedLocally && !isCalibrating && pool.localEstimatedUsedPct !== null && pool.totalUsedPct > 0
      ? Math.max(0, Math.min(100, Math.round((pool.localEstimatedUsedPct / pool.totalUsedPct) * 100)))
      : null;

  const totalBarPct = Math.max(0, Math.min(100, pool.totalUsedPct));
  const localBarPct =
    !unusedLocally && !isCalibrating && pool.localEstimatedUsedPct !== null
      ? Math.max(0, Math.min(totalBarPct, pool.localEstimatedUsedPct))
      : 0;
  const otherBarPct = !isCalibrating
    ? Math.max(0, Math.min(totalBarPct - localBarPct, resolvedOtherPct ?? 0))
    : 0;
  const ambiguousBarPct = isCalibrating
    ? totalBarPct
    : Math.max(0, totalBarPct - localBarPct - otherBarPct);

  const brandFallback = pool.poolKey.toLowerCase() === 'claude' ? 'Claude/GPT' : pool.displayName || pool.poolKey;

  return (
    <div
      className="gb-subcard"
      style={{
        padding: '12px 13px',
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
        minWidth: 0,
      }}
    >
      {/* Pool Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, flex: 1 }}>
          <BrandIcons fallbackName={brandFallback} size={15} isDark={isDark} />
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {pool.displayName || pool.poolKey}
            </div>
            {cycleStartText && cycleEndText && (
              <div className="tabular" style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
                {t('weekly_attribution.card.cycle_window', { start: cycleStartText, end: cycleEndText })}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          {pool.sshRequests > 0 && (
            <span
              className="gb-pill gb-pill-blue"
              title={t('weekly_attribution.card.ssh_tooltip', {
                requests: formatInteger(pool.sshRequests, locale),
                tokens: formatCompactTokens(pool.sshTokens, locale, true),
              })}
            >
              <Server size={10} />
              <span>{t('weekly_attribution.card.ssh_badge')}</span>
            </span>
          )}
          <span className={`gb-pill ${confidencePillClass(pool.confidence)}`}>
            {t(`weekly_attribution.confidence.${pool.confidence}`)}
          </span>
        </div>
      </div>

      {/* Stacked Attribution Bar (This Client vs Other Clients vs Ambiguous/Calibrating vs Remaining) */}
      <div
        style={{
          height: 6,
          borderRadius: 999,
          background: 'var(--track)',
          overflow: 'hidden',
          display: 'flex',
        }}
      >
        {localBarPct > 0 && (
          <div
            style={{
              width: `${localBarPct}%`,
              height: '100%',
              background: 'var(--blue-bright)',
              transition: 'width 260ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          />
        )}
        {otherBarPct > 0 && (
          <div
            style={{
              width: `${otherBarPct}%`,
              height: '100%',
              background: 'var(--text-tertiary)',
              opacity: 0.45,
              transition: 'width 260ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          />
        )}
        {ambiguousBarPct > 0 && (
          <div
            style={{
              width: `${ambiguousBarPct}%`,
              height: '100%',
              background: 'var(--warning)',
              opacity: isCalibrating ? 0.72 : 0.65,
              transition: 'width 260ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          />
        )}
      </div>

      {/* 3 KPI Columns */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
            {t('weekly_attribution.pool.official_used')}
          </div>
          <div className="tabular" style={{ fontSize: 14, fontWeight: 700, marginTop: 1 }}>
            {totalUsedStr}
          </div>
          <div className="tabular" style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
            {remainingStr}
          </div>
        </div>

        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
            {t('weekly_attribution.pool.local_est')}
          </div>
          <div
            className="tabular"
            style={{
              fontSize: 14,
              fontWeight: 700,
              marginTop: 1,
              color: isCalibrating
                ? 'var(--warning)'
                : unusedLocally
                ? 'var(--text-secondary)'
                : 'var(--blue)',
            }}
          >
            {localPctDisplay}
          </div>
          <div className="tabular" style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
            {unusedLocally
              ? t('weekly_attribution.pool.unused_value')
              : isCalibrating
              ? t('weekly_attribution.pool.calibrating_snapshots', { snapshots: pool.snapshotCount })
              : shareOfUsedPct !== null
              ? t('weekly_attribution.pool.share_of_used_with_samples', {
                  pct: shareOfUsedPct,
                  samples: pool.calibrationSamples,
                })
              : t('weekly_attribution.pool.samples_meta', {
                  samples: pool.calibrationSamples,
                  snapshots: pool.snapshotCount,
                })}
          </div>
        </div>

        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
            {unusedLocally ? t('weekly_attribution.pool.others_exact') : t('weekly_attribution.pool.others_est')}
          </div>
          <div
            className="tabular"
            style={{
              fontSize: 14,
              fontWeight: isCalibrating ? 600 : 700,
              marginTop: 1,
              color: isCalibrating ? 'var(--text-secondary)' : undefined,
            }}
          >
            {otherPctDisplay}
          </div>
          <div className="tabular" style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
            {isCalibrating
              ? '\u00a0'
              : pool.hasPreSnapshotEstimate
              ? t('weekly_attribution.pool.pre_snapshot_note')
              : pool.ambiguousDropPct > 0
              ? t('weekly_attribution.pool.ambiguous_note', { pct: formatPctNumber(pool.ambiguousDropPct) })
              : '\u00a0'}
          </div>
        </div>
      </div>

      <div className="gb-divider" />

      {/* Exact Local Metrics */}
      <div
        className="tabular"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
          fontSize: 11,
          color: 'var(--text-secondary)',
        }}
      >
        <span>
          {t('weekly_attribution.pool.tokens_label')}:{' '}
          <strong style={{ color: 'var(--text)', fontWeight: 600 }}>
            {formatCompactTokens(pool.localTokens, locale, true)}
          </strong>
        </span>
        <span>
          {t('weekly_attribution.pool.requests_label')}:{' '}
          <strong style={{ color: 'var(--text)', fontWeight: 600 }}>
            {t('weekly_attribution.pool.requests_value', {
              count: formatInteger(pool.localRequests, locale),
            })}
          </strong>
        </span>
      </div>

      {pool.unpricedRequests > 0 && pool.ambiguousDropPct > 0 && (
        <div className="tabular" style={{ fontSize: 10.5, color: 'var(--warning)' }}>
          {t('weekly_attribution.pool.unpriced_note', {
            count: formatInteger(pool.unpricedRequests, locale),
          })}
        </div>
      )}

      {/* Collapsible Historical Weekly Cycles */}
      {visibleHistory.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button
            type="button"
            style={{
              alignSelf: 'flex-start',
              border: 'none',
              background: 'transparent',
              padding: 0,
              fontFamily: 'inherit',
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
            onClick={() => setHistoryOpen((prev) => !prev)}
          >
            {historyOpen
              ? t('weekly_attribution.history.toggle_expanded', { count: visibleHistory.length })
              : t('weekly_attribution.history.toggle_collapsed', { count: visibleHistory.length })}
          </button>

          {historyOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {visibleHistory.map((entry) => {
                const startStr = formatShortDateTime(entry.cycleStartSec);
                const endStr = formatShortDateTime(entry.resetTimeSec);
                const pctParts: string[] = [];
                if (entry.totalUsedPct !== null) {
                  pctParts.push(
                    t('weekly_attribution.history.total_used', { pct: formatPctNumber(entry.totalUsedPct) }),
                  );
                }
                if (entry.localEstimatedUsedPct !== null) {
                  pctParts.push(
                    t('weekly_attribution.history.local_used', {
                      pct: formatPctNumber(entry.localEstimatedUsedPct),
                    }),
                  );
                }
                if (entry.otherEstimatedUsedPct !== null) {
                  pctParts.push(
                    t('weekly_attribution.history.others_used', {
                      pct: formatPctNumber(entry.otherEstimatedUsedPct),
                    }),
                  );
                }
                return (
                  <div
                    key={`${entry.cycleStartSec}-${entry.resetTimeSec}`}
                    style={{
                      padding: '6px 8px',
                      borderRadius: 7,
                      background: 'var(--card)',
                      border: '0.5px solid var(--border)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 6,
                      }}
                    >
                      <span className="tabular" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>
                        {t('weekly_attribution.history.row_summary', { start: startStr, end: endStr })}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        {entry.sshRequests > 0 && (
                          <span className="gb-pill gb-pill-blue" style={{ height: 17, fontSize: 9.5, padding: '0 6px' }}>
                            {t('weekly_attribution.card.ssh_badge')}
                          </span>
                        )}
                        <span
                          className={`gb-pill ${confidencePillClass(entry.confidence)}`}
                          style={{ height: 17, fontSize: 9.5, padding: '0 6px' }}
                        >
                          {t(`weekly_attribution.confidence.${entry.confidence}`)}
                        </span>
                      </div>
                    </div>
                    <div
                      className="tabular"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        flexWrap: 'wrap',
                        fontSize: 10.5,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <span>{pctParts.join(' · ') || '--'}</span>
                      <span>
                        {t('weekly_attribution.history.metrics', {
                          tokens: formatCompactTokens(entry.localTokens, locale, true),
                          requests: formatInteger(entry.localRequests, locale),
                        })}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function WeeklyQuotaUsageCard({
  accounts,
  selectedAccountId,
  selectedAccountEmail,
  activeAccountId,
  activeEmail,
  locale,
  isDark,
  t,
}: WeeklyQuotaUsageCardProps) {
  const [chosenAccountKey, setChosenAccountKey] = useState<string | null>(null);

  const eligibleAccounts = useMemo(() => {
    if (selectedAccountId === 'unattributed') return [];
    const withWeekly = accounts.filter((acc) => Array.isArray(acc.pools) && acc.pools.length > 0);
    if (selectedAccountId && selectedAccountId !== 'all') {
      return withWeekly.filter((acc) => isMatchingAccount(acc, selectedAccountId, selectedAccountEmail));
    }
    return [...withWeekly].sort((a, b) => {
      const aActive = isMatchingAccount(a, activeAccountId, activeEmail) ? 1 : 0;
      const bActive = isMatchingAccount(b, activeAccountId, activeEmail) ? 1 : 0;
      return bActive - aActive;
    });
  }, [accounts, activeAccountId, activeEmail, selectedAccountEmail, selectedAccountId]);

  if (eligibleAccounts.length === 0) {
    return null;
  }

  const currentAccount =
    (selectedAccountId === 'all' && chosenAccountKey
      ? eligibleAccounts.find((acc) => accountStableKey(acc) === chosenAccountKey)
      : undefined) ?? eligibleAccounts[0];

  const currentName = accountDisplayName(currentAccount.name, currentAccount.email, locale);
  const currentEmail = (currentAccount.email ?? '').trim();
  const currentTier = normalizeTier(currentAccount.tier, locale);
  const currentIsActive = isMatchingAccount(currentAccount, activeAccountId, activeEmail);

  return (
    <div className="gb-card" style={{ padding: 15, display: 'flex', flexDirection: 'column', gap: 11 }}>
      {/* Header Row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <div
            className="gb-icon-badge gb-icon-badge-sm"
            style={{
              background: 'var(--blue-soft)',
              border: '0.5px solid var(--blue-border)',
              color: 'var(--blue)',
            }}
          >
            <CalendarRange size={12} />
          </div>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{t('weekly_attribution.card.title')}</span>
          <span className="gb-pill gb-pill-neutral">{t('weekly_attribution.card.passive_badge')}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{currentName}</span>
          <TierBadge tier={currentTier} />
          {currentIsActive && (
            <span className="gb-pill gb-pill-blue">{t('weekly_attribution.card.active_badge')}</span>
          )}
          {currentEmail && (
            <span className="selectable" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
              {currentEmail}
            </span>
          )}
        </div>
      </div>

      {/* Compact Account Switcher Pills (when viewing All and multiple accounts have weekly pools) */}
      {selectedAccountId === 'all' && eligibleAccounts.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {eligibleAccounts.map((acc) => {
            const key = accountStableKey(acc);
            const selected = key === accountStableKey(currentAccount);
            const displayName = accountDisplayName(acc.name, acc.email, locale);
            const isAccActive = isMatchingAccount(acc, activeAccountId, activeEmail);
            return (
              <button
                key={key}
                type="button"
                className="gb-btn gb-btn-sm gb-btn-pill"
                style={
                  selected
                    ? {
                        background: 'var(--blue-soft)',
                        color: 'var(--blue)',
                        borderColor: 'var(--blue-border)',
                        fontWeight: 600,
                      }
                    : undefined
                }
                onClick={() => setChosenAccountKey(key)}
              >
                <span>{displayName}</span>
                {isAccActive && <span style={{ opacity: 0.78 }}>· {t('weekly_attribution.card.active_badge')}</span>}
              </button>
            );
          })}
        </div>
      )}

      <div className="gb-divider" />

      {/* Weekly Pool Cards Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            currentAccount.pools.length > 1 ? 'repeat(auto-fit, minmax(300px, 1fr))' : '1fr',
          gap: 10,
        }}
      >
        {currentAccount.pools.map((pool) => (
          <PoolBreakdownTile
            key={`${accountStableKey(currentAccount)}::${pool.poolKey}`}
            pool={pool}
            locale={locale}
            isDark={isDark}
            t={t}
          />
        ))}
      </div>

      {/* Zero-risk Passive Observation Footer */}
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
        {t('weekly_attribution.card.footer_note')}
      </div>
    </div>
  );
}
