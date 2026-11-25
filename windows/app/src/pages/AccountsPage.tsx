import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Gauge,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Server,
  SlidersHorizontal,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { QuotaGroupsGrid } from '../components/QuotaBar';
import { TierBadge } from '../components/TierBadge';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { useApp } from '../context/AppContext';
import {
  accountDisplayName,
  formatDetachedDaemonKinds,
  formatShortDateTime,
  normalizeTier,
} from '../lib/format';
import {
  formatCollapsedQuotaSummary,
  indexWeeklyAttributionByPool,
  monitoredModelDisplayName,
  parseQuotaContract,
  resolveWeeklyAttributionForAccount,
} from '../lib/quota';
import {
  normalizeSshEnvironment,
  sshStateI18nKey,
  sshStatePillClass,
  sshStateSortOrder,
} from '../lib/ssh';
import { backendRequest, getAntigravityRunning, launchAntigravity } from '../lib/tauri';
import type { AccountRecord, AccountWeeklyAttribution, SwitchPreflightReply } from '../lib/types';
import { AccountPolicyModal } from '../sheets/AccountPolicyModal';
import { AddAccountModal } from '../sheets/AddAccountModal';
import { RenameAccountModal } from '../sheets/RenameAccountModal';

export function AccountsPage() {
  const {
    t,
    locale,
    isDark,
    config,
    updateConfig,
    reachable,
    accounts,
    activeAccountId,
    weeklyAttributionList,
    hasPendingSwitch,
    autoSwitchConfig,
    autoSwitchPreview,
    quotaRefreshing,
    refreshingAccountIds,
    switchingAccount,
    sshEnvironments,
    remoteSyncing,
    fetchAccounts,
    fetchAutoSwitch,
    refreshAllQuotas,
    refreshSingleAccountQuota,
    refreshRemoteEnvironments,
    closeAntigravitySafely,
    interactiveSwitchAccount,
    showToast,
    askConfirm,
  } = useApp();

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; email: string; name?: string } | null>(null);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (config.accountsCollapsed && accounts.length > 0) {
      setCollapsedIds(new Set(accounts.map((a) => a.id)));
    }
  }, [config.accountsCollapsed, accounts.length]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const allCollapsed = accounts.length > 0 && accounts.every((a) => collapsedIds.has(a.id));

  const toggleAllCollapse = () => {
    const nextCollapsed = !allCollapsed;
    setCollapsedIds(nextCollapsed ? new Set(accounts.map((a) => a.id)) : new Set());
    void updateConfig({ accountsCollapsed: nextCollapsed });
  };

  const toggleSingleCollapse = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleToggleAutoSwitch = async (enabled: boolean) => {
    setPolicyBusy(true);
    try {
      await backendRequest({ command: 'auto_switch_set', config: { enabled } });
      await fetchAutoSwitch();
      showToast(enabled ? t('accounts.smart_switch.enabled_msg') : t('accounts.smart_switch.disabled_msg'));
    } catch (err) {
      showToast(
        t('accounts.smart_switch.save_failed', { error: err instanceof Error ? err.message : String(err) }),
        true,
      );
    } finally {
      setPolicyBusy(false);
    }
  };

  const handleRollback = async () => {
    let preflight: SwitchPreflightReply | null = null;
    try {
      preflight = await backendRequest<SwitchPreflightReply>({ command: 'account_switch_preflight' });
    } catch {
      preflight = null;
    }
    if (preflight?.insidersRunning) {
      showToast(t('assistant_account.insiders_running'), true);
      return;
    }

    let hasUiRunning = Boolean(
      preflight?.uiRunning ?? preflight?.stableRunning ?? preflight?.appRunning,
    );
    const detachedCount = Number(preflight?.detachedDaemonCount ?? 0);
    const detachedKinds = preflight?.detachedDaemonKinds ?? [];
    const detachedPids = preflight?.detachedDaemonPids ?? [];
    if (!preflight || (!hasUiRunning && detachedCount === 0)) {
      if (await getAntigravityRunning().catch(() => false)) {
        hasUiRunning = true;
      }
    }
    const needClose = hasUiRunning || detachedCount > 0;
    const detachedOnly = !hasUiRunning && detachedCount > 0;
    const kindsLabel = formatDetachedDaemonKinds(detachedKinds, t, locale);

    const confirmed = await askConfirm({
      title: t('accounts.rollback.confirm_title'),
      body: detachedOnly
        ? t('accounts.rollback.detached_confirm_body', { count: detachedCount, kinds: kindsLabel })
        : t('accounts.rollback.confirm_body'),
      confirmLabel: detachedOnly
        ? t('accounts.rollback.detached_confirm_action')
        : t('accounts.rollback.confirm_action'),
      danger: true,
    });
    if (!confirmed) return;

    if (needClose) {
      const outcome = await closeAntigravitySafely(18_000, 'switch').catch(() => ({
        closed: false,
        reason: 'error',
      }));
      if (!outcome.closed) {
        showToast(
          detachedOnly
            ? t('assistant_account.detached_daemons_remaining', {
                kinds: kindsLabel,
                pids: detachedPids.join(', ') || '-',
              })
            : outcome.reason === 'visible_window_open'
            ? locale === 'en'
              ? 'Visible Antigravity windows are still open. Save and close them before rolling back.'
              : '检测到 Antigravity 仍有未关闭的可见窗口，请先保存并关闭后再撤销切换。'
            : t('assistant_account.quit_first'),
          true,
        );
        return;
      }
    }

    try {
      try {
        const res = await backendRequest<{ message?: string }>({ command: 'account_switch_rollback' });
        showToast(res?.message || t('accounts.rollback.restored'));
      } finally {
        if (hasUiRunning) {
          await launchAntigravity().catch((e) => {
            showToast(
              t('assistant.relaunch_failed', { detail: e instanceof Error ? e.message : String(e) }),
              true,
            );
          });
        }
      }
      await fetchAccounts();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleReorder = async (ids: string[]) => {
    try {
      await backendRequest({ command: 'account_reorder', ids });
      await fetchAccounts();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    }
  };

  const handleMove = async (id: string, delta: number) => {
    const idx = accounts.findIndex((a) => a.id === id);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= accounts.length) return;
    if (id === activeAccountId || accounts[targetIdx].id === activeAccountId) return;
    const ids = accounts.map((a) => a.id);
    [ids[idx], ids[targetIdx]] = [ids[targetIdx], ids[idx]];
    setOpenMenuId(null);
    await handleReorder(ids);
  };

  const handleDropReorder = async (sourceId: string, targetId: string) => {
    setDragId(null);
    setDragOverId(null);
    if (!sourceId || !targetId || sourceId === targetId) return;
    if (sourceId === activeAccountId || targetId === activeAccountId) return;
    const ids = accounts.map((a) => a.id);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    await handleReorder(ids);
  };

  const handleDelete = async (acc: AccountRecord) => {
    setOpenMenuId(null);
    if (acc.id === activeAccountId) {
      showToast(t('accounts.delete.cannot_active'), true);
      return;
    }
    const confirmed = await askConfirm({
      title: t('accounts.delete.confirm_title'),
      body: t('accounts.delete.confirm_body', { email: acc.email }),
      confirmLabel: t('accounts.delete.confirm_action'),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await backendRequest({ command: 'account_delete', id: acc.id });
      showToast(t('accounts.delete.success'));
      await fetchAccounts();
    } catch (err) {
      showToast(
        t('accounts.delete.failed', { error: err instanceof Error ? err.message : String(err) }),
        true,
      );
    }
  };

  const recommendedId =
    autoSwitchConfig.enabled && autoSwitchPreview?.shouldSwitch
      ? (autoSwitchPreview.account?.id ?? autoSwitchPreview.bestCandidate?.id ?? null)
      : null;

  const monitoredLabel = monitoredModelDisplayName(autoSwitchConfig.monitored_model, locale);

  const normalizedSshHosts = useMemo(() => {
    const fallback = t('ssh.remote_fallback');
    return sshEnvironments
      .map((env) => normalizeSshEnvironment(env, fallback))
      .sort((a, b) => sshStateSortOrder(b.state) - sshStateSortOrder(a.state) || a.hostLabel.localeCompare(b.hostLabel));
  }, [sshEnvironments, t]);

  return (
    <div className="gb-page-inner gb-fade-in">
      {/* Page Header */}
      <div className="gb-page-header">
        <h1 className="gb-page-title">{t('accounts.title')}</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {accounts.length > 0 && (
            <button type="button" className="gb-btn gb-btn-sm" onClick={toggleAllCollapse}>
              {allCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
              <span>{allCollapsed ? t('accounts.expand_all') : t('accounts.collapse_all')}</span>
            </button>
          )}
          <button
            type="button"
            className="gb-btn gb-btn-sm"
            disabled={!reachable || quotaRefreshing}
            onClick={() => void refreshAllQuotas()}
          >
            <RotateCw size={12} className={quotaRefreshing ? 'gb-spin' : undefined} />
            <span>{t('common.refresh_quota')}</span>
          </button>
          <button type="button" className="gb-btn gb-btn-primary gb-btn-sm" onClick={() => setAddOpen(true)}>
            <span>{t('accounts.manage_btn')}</span>
          </button>
        </div>
      </div>

      {/* Pending Switch Recovery Banner */}
      {hasPendingSwitch && (
        <div
          className="gb-card"
          style={{
            padding: '10px 14px',
            border: '1px solid var(--blue-border)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <RotateCcw size={16} style={{ color: 'var(--blue)', flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 12.5 }}>{t('accounts.pending_recovery')}</span>
          <button type="button" className="gb-btn gb-btn-primary gb-btn-sm" onClick={handleRollback}>
            {t('accounts.rollback_btn')}
          </button>
        </div>
      )}

      {/* Standby Advisor Policy Card */}
      <div
        className="gb-card"
        style={{
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          borderColor: autoSwitchConfig.enabled ? 'var(--blue-border)' : undefined,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <div
            className="gb-icon-badge"
            style={
              autoSwitchConfig.enabled
                ? { background: 'var(--blue-soft)', border: '0.5px solid var(--blue-border)', color: 'var(--blue)' }
                : {
                    background: 'var(--pill-neutral-bg)',
                    border: '0.5px solid var(--pill-neutral-border)',
                    color: 'var(--pill-neutral-text)',
                  }
            }
          >
            <RefreshCw size={14} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{t('accounts.smart_switch.title')}</span>
              <span className={`gb-pill ${autoSwitchConfig.enabled ? 'gb-pill-blue' : 'gb-pill-neutral'}`}>
                {autoSwitchConfig.enabled
                  ? t('accounts.smart_switch.enabled_badge', { threshold: autoSwitchConfig.reserve_percentage })
                  : t('accounts.smart_switch.disabled')}
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
              {t('accounts.smart_switch.subtitle', {
                monitored: monitoredLabel,
                threshold: autoSwitchConfig.reserve_percentage,
                min: autoSwitchConfig.candidate_min_percentage,
              })}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <button type="button" className="gb-btn gb-btn-sm" onClick={() => setPolicyOpen(true)}>
              <SlidersHorizontal size={12} />
              <span>{t('accounts.smart_switch.config_btn')}</span>
            </button>
            <ToggleSwitch
              checked={autoSwitchConfig.enabled}
              disabled={!reachable || policyBusy}
              onChange={(next) => void handleToggleAutoSwitch(next)}
              ariaLabel={t('accounts.smart_switch.a11y')}
            />
          </div>
        </div>

        {autoSwitchConfig.enabled && autoSwitchPreview && (
          <>
            <div className="gb-divider" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <Gauge size={14} style={{ color: 'var(--blue)', flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)' }}>
                {autoSwitchPreview.reason || t('accounts.smart_switch.best_current')}
              </span>
              {autoSwitchPreview.shouldSwitch && recommendedId && recommendedId !== activeAccountId && (
                <button
                  type="button"
                  className="gb-btn gb-btn-primary gb-btn-sm"
                  disabled={switchingAccount}
                  onClick={() => {
                    const target = accounts.find((a) => a.id === recommendedId);
                    if (target) void interactiveSwitchAccount(target);
                  }}
                >
                  {t('accounts.switch_recommended_btn')}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* SSH Local-Only Scope Notice (v1.2.0) */}
      {normalizedSshHosts.length > 0 && (
        <div
          className="gb-subcard"
          style={{
            padding: '8px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11.5,
            color: 'var(--text-secondary)',
          }}
        >
          <Server size={13} style={{ color: 'var(--blue)', flexShrink: 0 }} />
          <span>{t('accounts.ssh.local_only_banner')}</span>
        </div>
      )}

      {/* Accounts List */}
      {accounts.length === 0 ? (
        <div
          className="gb-card"
          style={{
            padding: '44px 20px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            gap: 8,
          }}
        >
          <UserPlus size={32} style={{ color: 'var(--text-secondary)', opacity: 0.7 }} />
          <div style={{ fontSize: 15, fontWeight: 600 }}>{t('accounts.empty.title')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('accounts.empty.subtitle')}</div>
          <button
            type="button"
            className="gb-btn gb-btn-primary"
            style={{ marginTop: 8 }}
            onClick={() => setAddOpen(true)}
          >
            {t('accounts.add_btn')}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {accounts.map((acc, index) => {
            const isActive = acc.id === activeAccountId;
            const isCollapsed = collapsedIds.has(acc.id);
            const isRecommended = acc.id === recommendedId && !isActive;
            const isRefreshing = refreshingAccountIds.has(acc.id);
            const canSwitch = !isActive && !acc.disabled && !acc.validation_blocked;
            const displayName = accountDisplayName(acc.name, acc.email, locale);
            const tier = normalizeTier(acc.subscription_tier, locale);
            const contract = parseQuotaContract(acc as Record<string, unknown>, locale);
            const updatedTs = Number(
              acc.quota_last_updated ??
                acc.quotaLastUpdated ??
                (acc.quota as { last_updated?: number } | null)?.last_updated ??
                0,
            );
            const needsAuth = acc.credentialReadiness?.state === 'needs_authorization';

            return (
              <div
                key={acc.id}
                draggable={!isActive}
                onDragStart={() => !isActive && setDragId(acc.id)}
                onDragOver={(e) => {
                  if (!isActive && dragId && dragId !== acc.id) {
                    e.preventDefault();
                    setDragOverId(acc.id);
                  }
                }}
                onDragLeave={() => setDragOverId((cur) => (cur === acc.id ? null : cur))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId) void handleDropReorder(dragId, acc.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDragOverId(null);
                }}
                className={`gb-card gb-card-interactive ${isActive ? 'gb-card-active' : ''}`}
                style={{
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 11,
                  outline: dragOverId === acc.id ? '2px dashed var(--blue)' : undefined,
                  opacity: dragId === acc.id ? 0.6 : 1,
                }}
              >
                {/* Header Row */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: 15,
                          fontWeight: 700,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {displayName}
                      </span>
                      <TierBadge tier={tier} />
                      {isRecommended && (
                        <span className="gb-pill gb-pill-success">{t('accounts.badge.recommended')}</span>
                      )}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        marginTop: 2,
                        fontSize: 11.5,
                        color: 'var(--text-secondary)',
                        overflow: 'hidden',
                      }}
                    >
                      <span className="selectable" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {acc.email}
                      </span>
                      {isCollapsed && (
                        <span className="tabular" style={{ color: 'var(--pill-neutral-text)', fontWeight: 500, flexShrink: 0 }}>
                          {formatCollapsedQuotaSummary(contract, locale)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Card Actions */}
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, position: 'relative' }}
                    ref={openMenuId === acc.id ? menuContainerRef : undefined}
                  >
                    {canSwitch && (
                      <button
                        type="button"
                        className="gb-btn gb-btn-sm"
                        disabled={!reachable || switchingAccount}
                        onClick={() => void interactiveSwitchAccount(acc)}
                      >
                        {t('accounts.switch_btn')}
                      </button>
                    )}

                    {isRefreshing && (
                      <span className="gb-pill gb-pill-blue">
                        <RotateCw size={10} className="gb-spin" />
                      </span>
                    )}

                    <button
                      type="button"
                      className="gb-btn gb-btn-ghost gb-icon-btn"
                      onClick={() => setOpenMenuId((cur) => (cur === acc.id ? null : acc.id))}
                      aria-label={t('accounts.a11y.actions', { account: acc.email })}
                    >
                      <MoreHorizontal size={15} />
                    </button>

                    <button
                      type="button"
                      className="gb-btn gb-btn-ghost gb-icon-btn"
                      onClick={() => toggleSingleCollapse(acc.id)}
                      aria-label={
                        isCollapsed
                          ? t('accounts.a11y.expand_details', { account: acc.email })
                          : t('accounts.a11y.collapse_details', { account: acc.email })
                      }
                    >
                      {isCollapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
                    </button>

                    {/* Actions Dropdown */}
                    {openMenuId === acc.id && (
                      <div className="gb-dropdown">
                        <button
                          type="button"
                          className="gb-dropdown-item"
                          disabled={!reachable || quotaRefreshing || isRefreshing}
                          onClick={() => {
                            setOpenMenuId(null);
                            void refreshSingleAccountQuota(acc.id);
                          }}
                        >
                          <RotateCw size={13} />
                          <span>{isRefreshing ? t('accounts.menu.refreshing') : t('common.refresh_quota')}</span>
                        </button>
                        <div className="gb-dropdown-sep" />
                        <button
                          type="button"
                          className="gb-dropdown-item"
                          onClick={() => {
                            setOpenMenuId(null);
                            setRenameTarget({ id: acc.id, email: acc.email, name: acc.name });
                          }}
                        >
                          <Pencil size={13} />
                          <span>{t('accounts.menu.rename')}</span>
                        </button>
                        <button
                          type="button"
                          className="gb-dropdown-item"
                          disabled={
                            isActive ||
                            index <= (accounts.some((a) => a.id === activeAccountId) ? 1 : 0)
                          }
                          onClick={() => void handleMove(acc.id, -1)}
                        >
                          <ArrowUp size={13} />
                          <span>{t('accounts.menu.move_up')}</span>
                        </button>
                        <button
                          type="button"
                          className="gb-dropdown-item"
                          disabled={isActive || index >= accounts.length - 1}
                          onClick={() => void handleMove(acc.id, 1)}
                        >
                          <ArrowDown size={13} />
                          <span>{t('accounts.menu.move_down')}</span>
                        </button>
                        <div className="gb-dropdown-sep" />
                        <button
                          type="button"
                          className="gb-dropdown-item danger"
                          disabled={isActive}
                          onClick={() => void handleDelete(acc)}
                        >
                          <Trash2 size={13} />
                          <span>{t('accounts.menu.remove')}</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Expanded Quota Details */}
                {!isCollapsed && (
                  <>
                    <div className="gb-divider" />
                    {contract.displayGroups.length > 0 ? (
                      <QuotaGroupsGrid
                        coreGroups={contract.coreGroups}
                        standaloneGroups={contract.standaloneGroups}
                        locale={locale}
                        isDark={isDark}
                        weeklyAttributionByPool={indexWeeklyAttributionByPool(
                          resolveWeeklyAttributionForAccount(acc.weeklyAttribution, weeklyAttributionList, {
                            accountId: acc.id,
                            email: acc.email,
                          }),
                        )}
                      />
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {t('menu_panel.quota.no_record')}
                      </div>
                    )}

                    {needsAuth && (
                      <div style={{ fontSize: 11.5, color: 'var(--warning)' }}>
                        {t('accounts.auth_warning')}
                      </div>
                    )}

                    {acc.quota_refresh_error && (
                      <div style={{ fontSize: 11.5, color: 'var(--warning)' }}>
                        {acc.quota_refresh_error}
                      </div>
                    )}

                    {updatedTs > 0 && (
                      <div className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                        {contract.standbyMode === 'snapshot_cooldown_elapsed'
                          ? t('accounts.standby.reset_passed')
                          : contract.standbyMode === 'snapshot_cooling'
                          ? t('accounts.standby.recorded_at', { time: formatShortDateTime(updatedTs) })
                          : t('accounts.updated_at', { time: formatShortDateTime(updatedTs) })}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Remote SSH Active Accounts (Read-Only, v1.2.0) */}
      {normalizedSshHosts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ fontSize: 13.5, fontWeight: 700 }}>{t('accounts.ssh.remote_section_title')}</span>
                <span className="gb-pill gb-pill-neutral">
                  {t('accounts.ssh.remote_section_count', { count: normalizedSshHosts.length })}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {t('accounts.ssh.remote_section_subtitle')}
              </div>
            </div>
            <button
              type="button"
              className="gb-btn gb-btn-sm"
              disabled={!reachable || remoteSyncing}
              onClick={() => void refreshRemoteEnvironments()}
            >
              <RotateCw size={12} className={remoteSyncing ? 'gb-spin' : undefined} />
              <span>{t('common.refresh')}</span>
            </button>
          </div>

          {normalizedSshHosts.map((host) => {
            const remoteContract = parseQuotaContract(host.raw as Record<string, unknown>, locale, { compact: true });
            const remoteTier = normalizeTier(host.tier, locale);
            return (
              <div
                key={host.id || host.hostLabel}
                className="gb-card"
                style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 9 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 14, fontWeight: 700 }}>
                        {host.email
                          ? accountDisplayName(host.name, host.email, locale)
                          : host.hostLabel}
                      </span>
                      {host.tier && <TierBadge tier={remoteTier} />}
                      <span className={`gb-pill ${sshStatePillClass(host.state)}`}>
                        {t('accounts.ssh.used_on_host', { host: host.hostLabel })} · {t(sshStateI18nKey(host.state))}
                      </span>
                      <span className="gb-pill gb-pill-neutral">{t('accounts.ssh.remote_section_readonly_note')}</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                      {[
                        host.email,
                        host.windowCount > 0 ? t('accounts.ssh.remote_window_count', { count: host.windowCount }) : '',
                        t('accounts.ssh.remote_readonly_hint'),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="gb-btn gb-btn-sm"
                    disabled={!reachable || remoteSyncing}
                    onClick={() => void refreshRemoteEnvironments(host.id)}
                  >
                    <RotateCw size={11.5} className={remoteSyncing ? 'gb-spin' : undefined} />
                    <span>{t('common.refresh')}</span>
                  </button>
                </div>

                {remoteContract.displayGroups.length > 0 && (
                  <>
                    <div className="gb-divider" />
                    <QuotaGroupsGrid
                      coreGroups={remoteContract.coreGroups}
                      standaloneGroups={remoteContract.standaloneGroups}
                      locale={locale}
                      isDark={isDark}
                      compact
                      weeklyAttributionByPool={indexWeeklyAttributionByPool(
                        resolveWeeklyAttributionForAccount(
                          host.raw.weeklyAttribution as AccountWeeklyAttribution | null | undefined,
                          weeklyAttributionList,
                          {
                            accountId: host.matchedLocalAccountId,
                            email: host.email,
                          },
                        ),
                      )}
                    />
                  </>
                )}

                {host.lastError && (
                  <div style={{ fontSize: 11, color: 'var(--warning)' }}>{host.lastError}</div>
                )}

                {host.quotaLastUpdated > 0 && (
                  <div className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {t('accounts.ssh.quota_from_remote', { host: host.hostLabel })} ·{' '}
                    {t('accounts.updated_at', { time: formatShortDateTime(host.quotaLastUpdated) })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AddAccountModal open={addOpen} onClose={() => setAddOpen(false)} />
      <AccountPolicyModal open={policyOpen} onClose={() => setPolicyOpen(false)} />
      <RenameAccountModal account={renameTarget} onClose={() => setRenameTarget(null)} />
    </div>
  );
}
