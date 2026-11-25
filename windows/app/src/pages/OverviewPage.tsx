import { useMemo, useState } from 'react';
import {
  BarChart3,
  DollarSign,
  HardDrive,
  Languages,
  Layers,
  LayoutDashboard,
  RotateCw,
  Send,
  Server,
  Sparkles,
  WifiOff,
} from 'lucide-react';
import { DebugPortBanner } from '../components/DebugPortBanner';
import { BrandIcons } from '../components/ModelIcon';
import { QuotaGroupsGrid } from '../components/QuotaBar';
import { TierBadge } from '../components/TierBadge';
import { TrendChart, type TrendBarPoint } from '../components/TrendChart';
import { useApp } from '../context/AppContext';
import {
  accountDisplayName,
  foldThinkingVariants,
  formatBytes,
  formatCompactTokens,
  formatInteger,
  formatShortDateTime,
  formatUsd,
  localizedModelLabel,
  normalizeTier,
  parseHourIndex,
  sortModelsByUsage,
} from '../lib/format';
import {
  indexWeeklyAttributionByPool,
  parseQuotaContract,
  resolveWeeklyAttributionForAccount,
} from '../lib/quota';
import {
  normalizeSshEnvironment,
  sshStateI18nKey,
  sshStatePillClass,
  sshStateSortOrder,
} from '../lib/ssh';
import { MaintenanceModal } from '../sheets/MaintenanceModal';

export function OverviewPage() {
  const {
    t,
    locale,
    isDark,
    reachable,
    status,
    dashboard,
    activeAccountId,
    weeklyAttributionList,
    usageByPeriod,
    maintenanceScan,
    sshEnvironments,
    remoteSyncing,
    quotaRefreshing,
    relaunching,
    refreshAllQuotas,
    refreshRemoteEnvironments,
    toggleLocalization,
    toggleHud,
    triggerSafeRelaunch,
    reconnectBackend,
    setActivePage,
  } = useApp();

  const [hoveredPt, setHoveredPt] = useState<TrendBarPoint | null>(null);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);

  const normalizedSshHosts = useMemo(() => {
    const fallback = t('ssh.remote_fallback');
    return sshEnvironments
      .map((env) => normalizeSshEnvironment(env, fallback))
      .sort((a, b) => sshStateSortOrder(b.state) - sshStateSortOrder(a.state) || a.hostLabel.localeCompare(b.hostLabel));
  }, [sshEnvironments, t]);
  const onlineSshHosts = useMemo(
    () => normalizedSshHosts.filter((h) => h.state === 'online' || h.state === 'auth_expired'),
    [normalizedSshHosts],
  );
  const offlineSshCount = normalizedSshHosts.length - onlineSshHosts.length;

  const dashAccounts = dashboard?.accounts ?? null;
  const dashUsage = dashboard?.usage ?? null;
  const todayReport = usageByPeriod.today;

  const activeName = dashAccounts
    ? accountDisplayName(dashAccounts.activeName, dashAccounts.activeEmail, locale)
    : reachable
    ? t('overview.account.no_saved')
    : t('overview.loading_account');
  const activeEmail = dashAccounts?.activeEmail ?? status.activeAccountEmail ?? '';
  const activeTier = normalizeTier(dashAccounts?.activeTier ?? status.activeSubscriptionTier, locale);

  const contract = useMemo(
    () => parseQuotaContract(dashAccounts as Record<string, unknown> | null, locale, { compact: true }),
    [dashAccounts, locale],
  );

  const activeWeeklyAttributionByPool = useMemo(() => {
    const attr = resolveWeeklyAttributionForAccount(
      dashAccounts?.weeklyAttribution,
      weeklyAttributionList,
      {
        accountId: dashAccounts?.currentAccountId ?? dashAccounts?.id ?? activeAccountId,
        email: dashAccounts?.activeEmail ?? dashAccounts?.email ?? status.activeAccountEmail,
      },
    );
    return indexWeeklyAttributionByPool(attr);
  }, [
    activeAccountId,
    dashAccounts?.activeEmail,
    dashAccounts?.currentAccountId,
    dashAccounts?.email,
    dashAccounts?.id,
    dashAccounts?.weeklyAttribution,
    status.activeAccountEmail,
    weeklyAttributionList,
  ]);

  const quotaUpdatedTs = Number(dashAccounts?.quotaLastUpdated ?? dashAccounts?.lastUpdated ?? 0);

  // Build 24h hourly points
  const hourlyPoints = useMemo<TrendBarPoint[]>(() => {
    const rawHourly = dashUsage?.todayHourly ?? todayReport?.todayHourly ?? [];
    const byHour = new Map<number, number>();
    for (const item of rawHourly) {
      const h = parseHourIndex(item);
      if (h !== null) {
        byHour.set(h, (byHour.get(h) ?? 0) + (Number(item.totalTokens ?? item.total_tokens ?? 0) || 0));
      }
    }
    const nowHour = new Date().getHours();
    return Array.from({ length: 24 }, (_, hour) => {
      const hh = String(hour).padStart(2, '0');
      const label = locale === 'en' ? `${hh}h` : `${hh}时`;
      const tooltipLabel = t('menu_panel.trend.today_key', { time: `${hh}:00` });
      const val = byHour.get(hour) ?? 0;
      return {
        label,
        tooltipLabel,
        value: val,
        isFuture: val === 0 && hour > nowHour,
      };
    });
  }, [dashUsage, todayReport, locale, t]);

  const peakPoint = useMemo(() => {
    let best: TrendBarPoint | null = null;
    for (const p of hourlyPoints) {
      if (p.value > 0 && (!best || p.value > best.value)) best = p;
    }
    return best;
  }, [hourlyPoints]);

  const currentHourPt = hourlyPoints[new Date().getHours()] ?? hourlyPoints[hourlyPoints.length - 1];
  const activeTrendPoint = hoveredPt ?? currentHourPt;

  const activeModels = useMemo(() => {
    const raw = dashUsage?.todayByModel ?? todayReport?.byModel ?? todayReport?.models ?? [];
    return sortModelsByUsage(foldThinkingVariants(raw)).filter(
      (m) => m.totalTokens > 0 || m.requestCount > 0,
    );
  }, [dashUsage, todayReport]);

  const totalModelTokens = activeModels.reduce((s, m) => s + m.totalTokens, 0);

  const todayTokens = dashUsage?.todayTokens ?? todayReport?.summary?.totalTokens ?? 0;
  const totalTokens = dashUsage?.totalTokens ?? 0;
  const todayCost = dashUsage?.estimatedUsd ?? todayReport?.summary?.estimatedUsd ?? 0;
  const totalCost = dashUsage?.allTimeEstimatedUsd ?? 0;
  const todayReqs = dashUsage?.requestCount ?? todayReport?.summary?.requestCount ?? 0;
  const totalReqs = dashUsage?.totalRequestCount ?? 0;

  const translationOn = status.translationEnabled !== false && status.mode !== 'paused';
  const hudOn = status.hudEnabled !== false;

  const reclaimableBytes =
    (maintenanceScan?.buckets?.runtimeCache?.clearableBytes ?? maintenanceScan?.safeBytes ?? 0);

  const statusPill = (() => {
    if (!reachable) return { label: t('status.disconnected'), cls: 'gb-pill-danger' };
    switch (status.mode) {
      case 'connected':
      case 'adaptive':
        return {
          label: translationOn ? t('status.connected') : t('status.connected_english'),
          cls: 'gb-pill-success',
        };
      case 'debug-port-missing':
        return { label: t('status.debug_port_missing'), cls: 'gb-pill-warning' };
      case 'unsupported':
        return { label: t('status.unsupported'), cls: 'gb-pill-warning' };
      case 'legacy-blocked':
        return { label: t('status.legacy_blocked'), cls: 'gb-pill-danger' };
      case 'paused':
        return { label: t('status.paused'), cls: 'gb-pill-neutral' };
      case 'waiting':
      case 'waiting-window':
      case 'waiting-app':
        return { label: t('status.waiting_app'), cls: 'gb-pill-neutral' };
      default:
        return { label: status.message || t('status.waiting'), cls: 'gb-pill-neutral' };
    }
  })();

  return (
    <div className="gb-page-inner gb-fade-in">
      {/* Page Header + Compact Status & Quick Controls */}
      <div className="gb-page-header" style={{ flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 className="gb-page-title">{t('overview.title')}</h1>
          <span className={`gb-pill ${statusPill.cls}`}>{statusPill.label}</span>
          {!reachable && (
            <button type="button" className="gb-btn gb-btn-sm" onClick={() => void reconnectBackend()}>
              <WifiOff size={12} />
              <span>{locale === 'en' ? 'Reconnect' : '重新连接'}</span>
            </button>
          )}
        </div>

        {/* Compact Quick Toggles: Bilingual Hot-Injection / HUD / Quick Cache Maintenance */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="gb-btn gb-btn-sm"
            disabled={!reachable}
            style={
              translationOn
                ? { background: 'var(--blue-soft)', color: 'var(--blue)', borderColor: 'var(--blue-border)' }
                : undefined
            }
            onClick={() => void toggleLocalization(!translationOn)}
            title={t('settings.language.subtitle')}
          >
            <Languages size={12} />
            <span>{locale === 'en' ? (translationOn ? 'CN On' : 'CN Off') : translationOn ? '汉化已开' : '汉化已关'}</span>
          </button>

          <button
            type="button"
            className="gb-btn gb-btn-sm"
            disabled={!reachable}
            style={
              hudOn
                ? { background: 'var(--blue-soft)', color: 'var(--blue)', borderColor: 'var(--blue-border)' }
                : undefined
            }
            onClick={() => void toggleHud(!hudOn)}
            title={t('settings.hud.subtitle')}
          >
            <LayoutDashboard size={12} />
            <span>{t('settings.hud.title')}</span>
          </button>

          <button
            type="button"
            className="gb-btn gb-btn-sm"
            disabled={!reachable}
            onClick={() => setMaintenanceOpen(true)}
            title={t('settings.storage.default_subtitle')}
          >
            <HardDrive size={12} />
            <span>
              {reclaimableBytes >= 10 * 1024 * 1024
                ? t('settings.storage.reclaimable', { size: formatBytes(reclaimableBytes) })
                : t('settings.storage.title')}
            </span>
          </button>
        </div>
      </div>

      {/* Debug Port Missing Guidance Banner */}
      {status.mode === 'debug-port-missing' && (
        <DebugPortBanner
          title={t('status.debug_port_missing')}
          body={t('debug_port_missing.banner_body')}
          buttonLabel={t('assistant.safe_relaunch_btn')}
          busy={relaunching}
          onRelaunch={() => void triggerSafeRelaunch()}
        />
      )}

      {/* SSH Remote Companion Strip (v1.2.0) */}
      {normalizedSshHosts.length > 0 && (
        <div
          className="gb-card"
          style={{
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0, flex: 1 }}>
            <div
              className="gb-icon-badge gb-icon-badge-sm"
              style={{
                background: onlineSshHosts.length > 0 ? 'var(--success-soft)' : 'var(--subcard)',
                border: `0.5px solid ${onlineSshHosts.length > 0 ? 'var(--success-border)' : 'var(--border-strong)'}`,
                color: onlineSshHosts.length > 0 ? 'var(--success)' : 'var(--text-secondary)',
              }}
            >
              <Server size={11.5} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 600 }}>
              {onlineSshHosts.length > 0
                ? t('overview.ssh.companion_summary', { online: onlineSshHosts.length })
                : t('overview.ssh.local_only_summary')}
              {offlineSshCount > 0 ? t('overview.ssh.companion_offline_suffix', { count: offlineSshCount }) : ''}
            </span>
            {normalizedSshHosts.slice(0, 3).map((host) => (
              <span key={host.id || host.hostLabel} className={`gb-pill ${sshStatePillClass(host.state)}`}>
                {host.hostLabel} · {t(sshStateI18nKey(host.state))}
              </span>
            ))}
            {normalizedSshHosts.length > 3 && (
              <span className="gb-pill gb-pill-neutral">
                {t('overview.ssh.more_hosts', { count: normalizedSshHosts.length - 3 })}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              className="gb-btn gb-btn-sm"
              disabled={!reachable || remoteSyncing}
              onClick={() => void refreshRemoteEnvironments()}
            >
              <RotateCw size={11.5} className={remoteSyncing ? 'gb-spin' : undefined} />
              <span>{t('common.refresh')}</span>
            </button>
            <button
              type="button"
              className="gb-btn gb-btn-ghost gb-btn-sm"
              onClick={() => setActivePage('usage')}
            >
              <span>{t('overview.ssh.view_btn')}</span>
            </button>
          </div>
        </div>
      )}

      {/* Hero Account & Quota Card */}
      <div className="gb-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
              <span
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {activeName}
              </span>
              <TierBadge tier={activeTier} />
            </div>
            <div
              className="selectable"
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                marginTop: 2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {activeEmail || t('overview.account.add_hint')}
            </div>
          </div>
          <button
            type="button"
            className="gb-btn gb-btn-sm"
            disabled={!reachable || quotaRefreshing}
            onClick={() => void refreshAllQuotas()}
          >
            <RotateCw size={12} className={quotaRefreshing ? 'gb-spin' : undefined} />
            <span>{t('common.refresh_quota')}</span>
          </button>
        </div>

        <div className="gb-divider" />

        {contract.displayGroups.length > 0 ? (
          <QuotaGroupsGrid
            coreGroups={contract.coreGroups}
            standaloneGroups={contract.standaloneGroups}
            locale={locale}
            isDark={isDark}
            compact
            weeklyAttributionByPool={activeWeeklyAttributionByPool}
          />
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '6px 0' }}>
            {dashboard?.accountsError ||
              (!reachable
                ? t('overview.status.offline')
                : t('overview.account.add_hint'))}
          </div>
        )}

        {quotaUpdatedTs > 0 && (
          <div className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {t('common.updated_at', { time: formatShortDateTime(quotaUpdatedTs) })}
          </div>
        )}
      </div>

      {/* 3 KPI Metric Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 12,
        }}
      >
        <div
          className="gb-card gb-card-interactive"
          style={{ padding: '14px 16px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6 }}
          onClick={() => setActivePage('usage')}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <div
              className="gb-icon-badge gb-icon-badge-sm"
              style={{ background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)' }}
            >
              <Sparkles size={11.5} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>
              {t('overview.metric.today_tokens')}
            </span>
          </div>
          <div className="tabular" style={{ fontSize: 27, fontWeight: 700, lineHeight: 1.15 }}>
            {formatCompactTokens(todayTokens, locale, true)}
          </div>
          <div className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {totalTokens > 0
              ? t('overview.metric.total_tokens', { tokens: formatCompactTokens(totalTokens, locale) })
              : t('overview.metric.total_tokens_placeholder')}
          </div>
        </div>

        <div
          className="gb-card gb-card-interactive"
          style={{ padding: '14px 16px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6 }}
          onClick={() => setActivePage('usage')}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <div
              className="gb-icon-badge gb-icon-badge-sm"
              style={{ background: 'rgba(13, 148, 136, 0.12)', border: '0.5px solid rgba(13, 148, 136, 0.25)', color: '#0d9488' }}
            >
              <DollarSign size={11.5} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>
              {t('overview.metric.today_cost')}
            </span>
          </div>
          <div className="tabular" style={{ fontSize: 27, fontWeight: 700, lineHeight: 1.15 }}>
            {formatUsd(todayCost)}
          </div>
          <div className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {totalCost > 0
              ? t('overview.metric.total_cost', { cost: formatUsd(totalCost) })
              : t('overview.metric.total_cost_placeholder')}
          </div>
        </div>

        <div
          className="gb-card gb-card-interactive"
          style={{ padding: '14px 16px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6 }}
          onClick={() => setActivePage('usage')}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <div
              className="gb-icon-badge gb-icon-badge-sm"
              style={{ background: 'rgba(99, 102, 241, 0.13)', border: '0.5px solid rgba(99, 102, 241, 0.26)', color: '#6366f1' }}
            >
              <Send size={11} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>
              {t('overview.metric.today_requests')}
            </span>
          </div>
          <div className="tabular" style={{ fontSize: 27, fontWeight: 700, lineHeight: 1.15 }}>
            {formatInteger(todayReqs, locale)}
          </div>
          <div className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {totalReqs > 0
              ? t('overview.metric.total_requests', { count: formatInteger(totalReqs, locale) })
              : t('overview.metric.total_requests_placeholder')}
          </div>
        </div>
      </div>

      {/* 2-Column Bento Row: Hourly Trend + Active Models */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 12,
        }}
      >
        {/* Left: Today's Hourly Usage */}
        <div className="gb-card" style={{ padding: 15, display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <div
                className="gb-icon-badge gb-icon-badge-sm"
                style={{ background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)' }}
              >
                <BarChart3 size={12} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t('overview.trend.title')}</span>
            </div>
            <span className={`gb-pill ${peakPoint ? 'gb-pill-blue' : 'gb-pill-neutral'}`}>
              {peakPoint
                ? t('overview.trend.peak_badge', {
                    label: peakPoint.label,
                    peak: formatCompactTokens(peakPoint.value, locale),
                  })
                : t('overview.trend.24h_badge')}
            </span>
          </div>

          <div className="gb-divider" />

          <div className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)', minHeight: 16 }}>
            {activeTrendPoint
              ? activeTrendPoint.isFuture
                ? t('menu_panel.hover.future', { label: activeTrendPoint.tooltipLabel })
                : t('menu_panel.hover.tokens', {
                    label: activeTrendPoint.tooltipLabel,
                    tokens: formatCompactTokens(activeTrendPoint.value, locale, true),
                  })
              : ''}
          </div>

          <TrendChart
            points={hourlyPoints}
            metric="tokens"
            locale={locale}
            height={118}
            onHover={setHoveredPt}
          />
        </div>

        {/* Right: Today's Active Models */}
        <div className="gb-card" style={{ padding: 15, display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <div
                className="gb-icon-badge gb-icon-badge-sm"
                style={{ background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)' }}
              >
                <Layers size={12} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t('overview.bento.active_models')}</span>
            </div>
            <span className={`gb-pill ${activeModels.length > 0 ? 'gb-pill-blue' : 'gb-pill-neutral'}`}>
              {activeModels.length === 0
                ? t('overview.bento.no_calls_badge')
                : activeModels.length > 2
                ? t('overview.bento.top2_of_n', { count: activeModels.length })
                : t('overview.bento.n_models', { count: activeModels.length })}
            </span>
          </div>

          <div className="gb-divider" />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, justifyContent: 'center' }}>
            {activeModels.length === 0 ? (
              <>
                <div className="gb-subcard" style={{ padding: '11px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t('overview.bento.empty_title')}</span>
                    <span className="gb-pill gb-pill-neutral">{t('overview.bento.empty_badge')}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                    {t('overview.bento.empty_sub')}
                  </div>
                </div>
                <div
                  className="gb-subcard"
                  style={{ padding: '11px 12px', cursor: 'pointer' }}
                  onClick={() => setActivePage('usage')}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t('overview.bento.detail_title')}</span>
                    <span className="gb-pill gb-pill-neutral">{t('overview.bento.detail_badge')}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                    {t('overview.bento.detail_sub')}
                  </div>
                </div>
              </>
            ) : (
              activeModels.slice(0, 2).map((item) => {
                const share = totalModelTokens > 0 ? item.totalTokens / totalModelTokens : 1;
                const sharePct = Math.round(share * 100);
                const costStr = item.estimatedUsd > 0 ? ` · ${formatUsd(item.estimatedUsd)}` : '';
                return (
                  <div
                    key={item.model}
                    className="gb-subcard"
                    style={{
                      padding: '10px 12px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 5,
                      cursor: 'pointer',
                    }}
                    onClick={() => setActivePage('usage')}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <BrandIcons fallbackName={localizedModelLabel(item.model, locale)} size={14} isDark={isDark} />
                        <span
                          style={{
                            fontSize: 12.5,
                            fontWeight: 600,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {localizedModelLabel(item.model, locale)}
                        </span>
                      </div>
                      <span className="tabular" style={{ fontSize: 11.5, fontWeight: 600, flexShrink: 0 }}>
                        {t('overview.bento.tokens_trailing', {
                          tokens: formatCompactTokens(item.totalTokens, locale),
                        })}
                      </span>
                    </div>
                    <div style={{ height: 4.5, borderRadius: 999, background: 'var(--track)', overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${Math.max(4, Math.min(100, share * 100))}%`,
                          height: '100%',
                          borderRadius: 999,
                          background: 'var(--blue-bright)',
                        }}
                      />
                    </div>
                    <div className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      {activeModels.length === 1
                        ? t('overview.bento.model_sub_single', {
                            reqs: formatInteger(item.requestCount, locale),
                            cost: costStr,
                          })
                        : t('overview.bento.model_sub_multi', {
                            reqs: formatInteger(item.requestCount, locale),
                            share: sharePct > 0 ? t('overview.bento.share_pct', { pct: sharePct }) : '',
                            cost: costStr,
                          })}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      <MaintenanceModal open={maintenanceOpen} onClose={() => setMaintenanceOpen(false)} />
    </div>
  );
}
