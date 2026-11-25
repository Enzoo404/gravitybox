import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  formatDetachedDaemonKinds,
} from '../lib/format';
import {
  getSystemLocales,
  normalizeLanguageSetting,
  resolveLocale,
  translate,
  type ResolvedLocale,
} from '../lib/i18n';
import {
  backendRequest,
  getAppInfo,
  getAntigravityRunning,
  launchAntigravity,
  listenEvent,
  loadUiConfig,
  quitAntigravityAndWait,
  restartBackend,
  safeRelaunchAntigravity,
  saveUiConfig,
  setWindowDarkMode,
  syncTrayLanguage,
} from '../lib/tauri';
import type {
  AccountRecord,
  AccountsListReply,
  AccountWeeklyAttribution,
  AppInfo,
  AutoSwitchConfig,
  AutoSwitchPreview,
  DashboardSummaryReply,
  EnvironmentNode,
  LanguageSetting,
  LiveStatus,
  MaintenanceScanReply,
  PageKey,
  ProxyInfo,
  ProxyMode,
  SwitchPreflightReply,
  ThemeMode,
  UiConfig,
  UsagePeriodKey,
  UsageSummaryReply,
  WeeklyQuotaUsageReply,
} from '../lib/types';
import type { ToastMessage } from '../components/Toast';

export interface ConfirmDialogState {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  resolve: (confirmed: boolean) => void;
}

const DEFAULT_CONFIG: UiConfig = {
  schema: 2,
  lastPage: 0,
  quotaRefreshMinutes: 0,
  hudEnabled: true,
  autoPricingSyncEnabled: false,
  launchAntigravityOnStart: false,
  syncAntigravityLifecycle: false,
  autoUpdateEnabled: false,
  accountsCollapsed: false,
  menuSelectedTab: 0,
  menuUsagePeriod: 0,
  menuUsageEnvironmentId: 'all',
  menuTrendMetric: 'tokens',
  applicationChannel: 'stable',
  appLanguage: 'system',
  themeMode: 'system',
  antigravityProxyMode: 'off',
  antigravityProxyManualUrl: '',
};

const PAGE_INDEX_MAP: PageKey[] = ['overview', 'accounts', 'usage', 'settings', 'about'];

interface AppContextValue {
  windowRole: 'main' | 'tray';
  config: UiConfig;
  updateConfig: (patch: Partial<UiConfig>) => Promise<void>;
  locale: ResolvedLocale;
  languageSetting: LanguageSetting;
  setLanguage: (lang: LanguageSetting) => Promise<void>;
  themeMode: ThemeMode;
  isDark: boolean;
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  t: (key: string, params?: Record<string, string | number>, fallback?: string) => string;

  activePage: PageKey;
  setActivePage: (page: PageKey) => void;

  appInfo: AppInfo | null;
  reachable: boolean;
  status: LiveStatus;
  dashboard: DashboardSummaryReply | null;
  accountsPayload: AccountsListReply | null;
  accounts: AccountRecord[];
  activeAccountId: string;
  hasPendingSwitch: boolean;
  autoSwitchConfig: AutoSwitchConfig;
  autoSwitchPreview: AutoSwitchPreview | null;
  usageByPeriod: Partial<Record<UsagePeriodKey, UsageSummaryReply>>;
  usageLoading: Partial<Record<UsagePeriodKey, boolean>>;
  usageErrors: Partial<Record<UsagePeriodKey, string>>;
  weeklyAttributionList: AccountWeeklyAttribution[];
  weeklyAttributionLoading: boolean;
  maintenanceScan: MaintenanceScanReply | null;
  proxyInfo: ProxyInfo | null;
  environments: EnvironmentNode[];
  sshEnvironments: EnvironmentNode[];
  sshWindowsCount: number;
  activeSshHosts: string[];
  remoteSyncing: boolean;

  quotaRefreshing: boolean;
  refreshingAccountIds: Set<string>;
  relaunching: boolean;
  switchingAccount: boolean;

  refreshAll: (force?: boolean) => Promise<void>;
  fetchDashboard: (force?: boolean, environmentId?: string) => Promise<void>;
  fetchAccounts: () => Promise<void>;
  fetchAutoSwitch: () => Promise<void>;
  fetchUsage: (period: UsagePeriodKey, force?: boolean, environmentId?: string, accountId?: string) => Promise<UsageSummaryReply | null>;
  fetchWeeklyAttribution: (accountId?: string) => Promise<AccountWeeklyAttribution[]>;
  fetchMaintenanceScan: (retentionDays?: number, force?: boolean) => Promise<MaintenanceScanReply | null>;
  fetchProxy: (force?: boolean) => Promise<ProxyInfo | null>;
  applyProxy: (mode: ProxyMode, manualUrl?: string) => Promise<ProxyInfo>;
  refreshRemoteEnvironments: (environmentId?: string) => Promise<void>;
  refreshAllQuotas: () => Promise<void>;
  refreshSingleAccountQuota: (id: string) => Promise<void>;
  toggleLocalization: (enable: boolean) => Promise<void>;
  toggleHud: (enable: boolean) => Promise<void>;
  openAntigravity: () => Promise<void>;
  triggerSafeRelaunch: () => Promise<void>;
  closeAntigravitySafely: (
    timeoutMs?: number,
    purpose?: 'switch' | 'maintenance',
  ) => Promise<{ closed: boolean; reason?: string }>;
  interactiveSwitchAccount: (acc: { id: string; email: string; name?: string }) => Promise<void>;
  reconnectBackend: () => Promise<void>;

  toast: ToastMessage | null;
  showToast: (message: string, error?: boolean) => void;
  clearToast: () => void;
  confirmDialog: ConfirmDialogState | null;
  askConfirm: (opts: Omit<ConfirmDialogState, 'resolve'>) => Promise<boolean>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  windowRole,
  children,
}: {
  windowRole: 'main' | 'tray';
  children: ReactNode;
}) {
  const [config, setConfig] = useState<UiConfig>(DEFAULT_CONFIG);
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)').matches : false,
  );
  const [activePage, setActivePageState] = useState<PageKey>('overview');
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [reachable, setReachable] = useState<boolean>(false);
  const [status, setStatus] = useState<LiveStatus>({ mode: 'starting' });
  const [dashboard, setDashboard] = useState<DashboardSummaryReply | null>(null);
  const [accountsPayload, setAccountsPayload] = useState<AccountsListReply | null>(null);
  const [autoSwitchConfig, setAutoSwitchConfig] = useState<AutoSwitchConfig>({
    enabled: false,
    strategy: 'priority',
    monitored_model: 'all',
    reserve_percentage: 10,
    candidate_min_percentage: 30,
  });
  const [autoSwitchPreview, setAutoSwitchPreview] = useState<AutoSwitchPreview | null>(null);
  const [usageByPeriod, setUsageByPeriod] = useState<Partial<Record<UsagePeriodKey, UsageSummaryReply>>>({});
  const [usageLoading, setUsageLoading] = useState<Partial<Record<UsagePeriodKey, boolean>>>({});
  const [usageErrors, setUsageErrors] = useState<Partial<Record<UsagePeriodKey, string>>>({});
  const [weeklyAttributionList, setWeeklyAttributionList] = useState<AccountWeeklyAttribution[]>([]);
  const [weeklyAttributionLoading, setWeeklyAttributionLoading] = useState<boolean>(false);
  const weeklyAttrFetchSeqRef = useRef(0);
  const [maintenanceScan, setMaintenanceScan] = useState<MaintenanceScanReply | null>(null);
  const [proxyInfo, setProxyInfo] = useState<ProxyInfo | null>(null);
  const [remoteSyncing, setRemoteSyncing] = useState(false);

  const [quotaRefreshing, setQuotaRefreshing] = useState(false);
  const [refreshingAccountIds, setRefreshingAccountIds] = useState<Set<string>>(new Set());
  const [relaunching, setRelaunching] = useState(false);
  const [switchingAccount, setSwitchingAccount] = useState(false);

  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const timersRef = useRef<Set<number>>(new Set());
  const configRef = useRef<UiConfig>(DEFAULT_CONFIG);

  const scheduleTimer = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timersRef.current.delete(id);
      fn();
    }, ms);
    timersRef.current.add(id);
    return id;
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
      for (const id of timersRef.current) {
        window.clearTimeout(id);
      }
      timersRef.current.clear();
    };
  }, []);

  const languageSetting = normalizeLanguageSetting(config.appLanguage);
  const locale: ResolvedLocale = useMemo(() => resolveLocale(languageSetting), [languageSetting]);
  const themeMode: ThemeMode = config.themeMode ?? 'system';
  const isDark = themeMode === 'dark' || (themeMode === 'system' && systemDark);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>, fallback?: string) =>
      translate(locale, key, params, fallback),
    [locale],
  );

  const showToast = useCallback((message: string, error = false) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), message, error });
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, error ? 5500 : 3400);
  }, []);

  const clearToast = useCallback(() => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(null);
  }, []);

  const askConfirm = useCallback((opts: Omit<ConfirmDialogState, 'resolve'>) => {
    return new Promise<boolean>((resolve) => {
      setConfirmDialog({
        ...opts,
        resolve: (confirmed: boolean) => {
          setConfirmDialog(null);
          resolve(confirmed);
        },
      });
    });
  }, []);

  // Apply theme to DOM and native Windows 11 DWM titlebar
  useEffect(() => {
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
    void setWindowDarkMode(isDark);
  }, [isDark]);

  // Listen to OS color scheme changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Keep native tray menu language synced
  useEffect(() => {
    void syncTrayLanguage(locale === 'en');
  }, [locale]);

  const updateConfig = useCallback(async (patch: Partial<UiConfig>) => {
    const next: UiConfig = { ...configRef.current, ...patch };
    configRef.current = next;
    setConfig(next);
    try {
      await saveUiConfig(next);
    } catch {
      // Ignore transient disk write failure
    }
  }, []);

  const setActivePage = useCallback(
    (page: PageKey) => {
      setActivePageState(page);
      const idx = PAGE_INDEX_MAP.indexOf(page);
      if (idx >= 0 && windowRole === 'main') {
        void updateConfig({ lastPage: idx });
      }
    },
    [updateConfig, windowRole],
  );

  const fetchStatus = useCallback(async (): Promise<boolean> => {
    try {
      const res = await backendRequest<{ ok?: boolean; status?: LiveStatus }>({
        command: 'status',
        includeTasks: false,
      });
      setReachable(true);
      if (res?.status) {
        setStatus(res.status);
      }
      return true;
    } catch {
      setReachable(false);
      return false;
    }
  }, []);

  const fetchDashboard = useCallback(async (_force = false, environmentId?: string) => {
    try {
      const payload: Record<string, unknown> = { command: 'dashboard_summary' };
      if (environmentId && environmentId !== 'all') {
        payload.environmentId = environmentId;
      }
      const res = await backendRequest<DashboardSummaryReply>(payload);
      setReachable(true);
      setDashboard(res);
      if (res?.usage?.periods && (!environmentId || environmentId === 'all')) {
        setUsageByPeriod((prev) => ({ ...prev, ...res.usage!.periods }));
      }
    } catch {
      // Retain previous dashboard snapshot on transient failure
    }
  }, []);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await backendRequest<AccountsListReply>({ command: 'account_list' });
      setReachable(true);
      setAccountsPayload(res);
    } catch {
      // Keep last known list
    }
  }, []);

  const fetchAutoSwitch = useCallback(async () => {
    try {
      const res = await backendRequest<{ config?: AutoSwitchConfig }>({ command: 'auto_switch_get' });
      if (res?.config) {
        setAutoSwitchConfig(res.config);
        if (res.config.enabled) {
          const preview = await backendRequest<AutoSwitchPreview>({
            command: 'auto_switch_best',
            preview: true,
          }).catch(() => null);
          setAutoSwitchPreview(preview);
        } else {
          setAutoSwitchPreview(null);
        }
      }
    } catch {
      // Ignore
    }
  }, []);

  const fetchUsage = useCallback(
    async (
      period: UsagePeriodKey,
      force = false,
      environmentId?: string,
      accountId?: string,
    ): Promise<UsageSummaryReply | null> => {
      setUsageLoading((prev) => ({ ...prev, [period]: true }));
      try {
        const isAllEnv = !environmentId || environmentId === 'all';
        const isAllAcc = !accountId || accountId === 'all';
        const res = await backendRequest<UsageSummaryReply>({
          command: 'usage_summary',
          period,
          ...(force ? { force: true } : {}),
          ...(!isAllEnv ? { environmentId } : {}),
          ...(!isAllAcc ? { accountId } : {}),
        });
        setReachable(true);
        setUsageErrors((prev) => ({ ...prev, [period]: undefined }));
        if (isAllEnv && isAllAcc) {
          if (res?.periods) {
            setUsageByPeriod((prev) => ({ ...prev, ...res.periods, [period]: res }));
          } else if (res) {
            setUsageByPeriod((prev) => ({ ...prev, [period]: res }));
          }
        }
        return res;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setUsageErrors((prev) => ({ ...prev, [period]: msg }));
        return null;
      } finally {
        setUsageLoading((prev) => ({ ...prev, [period]: false }));
      }
    },
    [],
  );

  const fetchWeeklyAttribution = useCallback(
    async (accountId?: string): Promise<AccountWeeklyAttribution[]> => {
      const seq = ++weeklyAttrFetchSeqRef.current;
      const scopedId = accountId && accountId !== 'all' ? accountId : undefined;
      setWeeklyAttributionLoading(true);
      try {
        const res = await backendRequest<WeeklyQuotaUsageReply>({
          command: 'weekly_quota_usage',
          ...(scopedId ? { accountId: scopedId } : {}),
        });
        const list = Array.isArray(res?.accounts) ? res.accounts : [];
        if (weeklyAttrFetchSeqRef.current === seq) {
          if (!scopedId) {
            setWeeklyAttributionList(list);
          } else {
            setWeeklyAttributionList((prev) => {
              const remaining = prev.filter((item) => item.accountId !== scopedId);
              const merged = [...remaining];
              for (const nextItem of list) {
                const idx = merged.findIndex(
                  (cur) =>
                    (nextItem.accountId && cur.accountId === nextItem.accountId) ||
                    (nextItem.email && cur.email.toLowerCase() === nextItem.email.toLowerCase()),
                );
                if (idx >= 0) merged[idx] = nextItem;
                else merged.push(nextItem);
              }
              return merged;
            });
          }
        }
        return list;
      } catch {
        // Silently degrade if backend command is unavailable or fails transiently
        return [];
      } finally {
        if (weeklyAttrFetchSeqRef.current === seq) {
          setWeeklyAttributionLoading(false);
        }
      }
    },
    [],
  );

  const fetchMaintenanceScan = useCallback(
    async (retentionDays = 7, _force = false): Promise<MaintenanceScanReply | null> => {
      try {
        const res = await backendRequest<MaintenanceScanReply>({
          command: 'maintenance_scan',
          retentionDays,
        });
        setMaintenanceScan(res);
        return res;
      } catch {
        return null;
      }
    },
    [],
  );

  const fetchProxy = useCallback(async (force = false): Promise<ProxyInfo | null> => {
    try {
      const res = await backendRequest<{ proxy?: ProxyInfo }>({
        command: 'proxy_get',
        ...(force ? { force: true } : {}),
      });
      if (res?.proxy) {
        setProxyInfo(res.proxy);
        return res.proxy;
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  const applyProxy = useCallback(
    async (mode: ProxyMode, manualUrl?: string): Promise<ProxyInfo> => {
      const payload: Record<string, unknown> = { command: 'proxy_set', mode };
      if (manualUrl !== undefined) {
        payload.manualUrl = manualUrl;
      }
      const res = await backendRequest<{ proxy?: ProxyInfo }>(payload);
      const nextProxy: ProxyInfo = res?.proxy ?? {
        mode,
        manualUrl: manualUrl ?? configRef.current.antigravityProxyManualUrl,
        effectiveUrl: null,
        source: mode,
      };
      setProxyInfo(nextProxy);
      await updateConfig({
        antigravityProxyMode: nextProxy.mode,
        ...(manualUrl !== undefined ? { antigravityProxyManualUrl: manualUrl.trim() } : {}),
      });
      return nextProxy;
    },
    [updateConfig],
  );

  const refreshAll = useCallback(
    async (force = false) => {
      const ok = await fetchStatus();
      if (!ok) return;
      await Promise.all([
        fetchDashboard(force),
        fetchAccounts(),
        fetchAutoSwitch(),
        fetchProxy(force),
      ]);
      void getAppInfo().then(setAppInfo).catch(() => {});
    },
    [fetchAccounts, fetchAutoSwitch, fetchDashboard, fetchProxy, fetchStatus],
  );

  const refreshRemoteEnvironments = useCallback(
    async (environmentId?: string) => {
      if (remoteSyncing || !reachable) return;
      setRemoteSyncing(true);
      try {
        await backendRequest({
          command: 'remote_quota_refresh',
          ...(environmentId && environmentId !== 'all' && environmentId !== 'local'
            ? { environmentId }
            : {}),
        });
        await Promise.all([fetchStatus(), fetchDashboard(true), fetchAccounts()]);
        showToast(locale === 'en' ? 'Remote SSH environments synced' : '已同步 SSH 远端配额与用量');
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), true);
      } finally {
        setRemoteSyncing(false);
      }
    },
    [fetchAccounts, fetchDashboard, fetchStatus, locale, reachable, remoteSyncing, showToast],
  );

  const setLanguage = useCallback(
    async (lang: LanguageSetting) => {
      await updateConfig({ appLanguage: lang });
      try {
        const res = await backendRequest<{ status?: LiveStatus }>({
          command: 'language_set',
          language: lang,
          systemLocales: getSystemLocales(),
        });
        if (res?.status) setStatus(res.status);
        void fetchDashboard(true);
        void fetchAccounts();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), true);
      }
    },
    [fetchAccounts, fetchDashboard, showToast, updateConfig],
  );

  const setThemeMode = useCallback(
    async (mode: ThemeMode) => {
      await updateConfig({ themeMode: mode });
    },
    [updateConfig],
  );

  const toggleLocalization = useCallback(
    async (enable: boolean) => {
      setStatus((prev) => ({ ...prev, translationEnabled: enable }));
      try {
        const res = await backendRequest<{ status?: LiveStatus }>({
          command: enable ? 'resume' : 'pause',
        });
        if (res?.status) setStatus(res.status);
        void fetchStatus();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), true);
        void fetchStatus();
      }
    },
    [fetchStatus, showToast],
  );

  const toggleHud = useCallback(
    async (enable: boolean) => {
      setStatus((prev) => ({ ...prev, hudEnabled: enable }));
      await updateConfig({ hudEnabled: enable });
      try {
        const res = await backendRequest<{ status?: LiveStatus }>({
          command: 'hud_set',
          enabled: enable,
        });
        if (res?.status) setStatus(res.status);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), true);
        void fetchStatus();
      }
    },
    [fetchStatus, showToast, updateConfig],
  );

  const environments = useMemo<EnvironmentNode[]>(() => {
    const raw =
      dashboard?.environments ??
      status.environments ??
      dashboard?.remoteSessions ??
      status.remoteSessions ??
      [];
    return Array.isArray(raw) ? raw : [];
  }, [dashboard?.environments, dashboard?.remoteSessions, status.environments, status.remoteSessions]);

  const sshEnvironments = useMemo<EnvironmentNode[]>(() => {
    return environments.filter((env) => {
      const id = String(env.environmentId ?? env.id ?? '').trim();
      const kind = String(env.kind ?? '').trim().toLowerCase();
      return kind === 'ssh' || id.startsWith('ssh:') || id.startsWith('host:');
    });
  }, [environments]);

  const sshWindowsCount = dashboard?.sshWindowsCount ?? status.sshWindowsCount ?? 0;
  const activeSshHosts = useMemo<string[]>(() => {
    const list = dashboard?.activeSshHosts ?? status.activeSshHosts;
    if (Array.isArray(list) && list.length > 0) return list;
    return sshEnvironments
      .filter((e) => (e.lifecycleState ?? e.state) === 'online' || e.online === true)
      .map((e) => String(e.hostLabel ?? e.host_label ?? e.label ?? e.environmentId ?? '').trim())
      .filter(Boolean);
  }, [dashboard?.activeSshHosts, sshEnvironments, status.activeSshHosts]);

  const askBackgroundExitConfirmation = useCallback(
    async (message: string, purpose: 'relaunch' | 'switch' | 'maintenance' = 'relaunch'): Promise<boolean> => {
      const confirmLabel =
        locale === 'en'
          ? purpose === 'switch'
            ? 'End Background & Switch'
            : purpose === 'maintenance'
            ? 'End Background & Continue'
            : 'End Background & Relaunch'
          : purpose === 'switch'
          ? '确认结束并切号'
          : purpose === 'maintenance'
          ? '确认结束并继续'
          : '确认结束并重启';
      return askConfirm({
        title:
          locale === 'en'
            ? 'Close Windowless Background Processes?'
            : '确认结束无界面后台进程？',
        body:
          message ||
          (locale === 'en'
            ? 'All visible Antigravity windows are closed, but windowless background/tray processes are still running. End them to continue, or click Cancel to quit manually from the system tray.'
            : 'Antigravity 的可见窗口已全部关闭，但仍有无界面后台/托盘进程驻留。是否确认结束这些无界面后台进程以继续？（也可点「取消」自行从系统托盘退出）'),
        confirmLabel,
        cancelLabel: t('common.cancel'),
        danger: true,
      });
    },
    [askConfirm, locale, t],
  );

  const closeAntigravitySafely = useCallback(
    async (
      timeoutMs = 15_000,
      purpose: 'switch' | 'maintenance' = 'maintenance',
    ): Promise<{ closed: boolean; reason?: string }> => {
      let outcome = await quitAntigravityAndWait(timeoutMs, false);
      if (!outcome.closed && outcome.reason === 'background_resident') {
        const confirmed = await askBackgroundExitConfirmation('', purpose);
        if (!confirmed) {
          return { closed: false, reason: 'user_cancelled' };
        }
        outcome = await quitAntigravityAndWait(timeoutMs, true);
      }
      return { closed: outcome.closed, reason: outcome.reason };
    },
    [askBackgroundExitConfirmation],
  );

  const triggerSafeRelaunch = useCallback(async () => {
    if (relaunching) return;
    const hasSsh = sshWindowsCount > 0;
    const confirmed = await askConfirm({
      title: hasSsh ? t('ssh.relaunch.confirm_title') : t('assistant.safe_relaunch_title'),
      body: hasSsh
        ? `${t('assistant.safe_relaunch_body')}\n\n${t('ssh.relaunch.active_windows_warning', {
            count: sshWindowsCount,
            hosts: activeSshHosts.join(', ') || 'SSH',
          })}`
        : t('assistant.safe_relaunch_body'),
      confirmLabel: hasSsh ? t('ssh.relaunch.confirm_btn') : t('assistant.safe_relaunch_confirm'),
    });
    if (!confirmed) return;
    setRelaunching(true);
    try {
      // Step 1: Pure graceful close ONLY (never silently force-kills background processes).
      const first = await safeRelaunchAntigravity(false);
      if (first.needsBackgroundExitConfirmation) {
        const bgConfirmed = await askBackgroundExitConfirmation(first.message, 'relaunch');
        if (!bgConfirmed) {
          showToast(
            locale === 'en'
              ? 'Cancelled. You can quit Antigravity manually from the system tray.'
              : '已取消。您可自行从系统托盘退出 Antigravity 后重试。',
          );
          return;
        }
        const second = await safeRelaunchAntigravity(true);
        showToast(second.message, !second.ok);
      } else {
        showToast(first.message, !first.ok);
      }
      scheduleTimer(() => void refreshAll(true), 1200);
    } catch (err) {
      showToast(
        t('assistant.safe_relaunch_failed', {
          detail: err instanceof Error ? err.message : String(err),
        }),
        true,
      );
    } finally {
      setRelaunching(false);
    }
  }, [
    activeSshHosts,
    askBackgroundExitConfirmation,
    askConfirm,
    locale,
    refreshAll,
    relaunching,
    scheduleTimer,
    showToast,
    sshWindowsCount,
    t,
  ]);

  const openAntigravity = useCallback(async () => {
    if (status.mode === 'debug-port-missing') {
      await triggerSafeRelaunch();
      return;
    }
    try {
      await launchAntigravity();
      scheduleTimer(() => void fetchStatus(), 1500);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    }
  }, [fetchStatus, scheduleTimer, showToast, status.mode, triggerSafeRelaunch]);

  const refreshAllQuotas = useCallback(async () => {
    if (quotaRefreshing || !reachable) return;
    setQuotaRefreshing(true);
    try {
      const start = await backendRequest<{ taskId?: string }>({ command: 'quota_refresh_start' });
      const taskId = start?.taskId;
      if (taskId) {
        // Poll task completion up to 60s
        let completed = false;
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 450));
          const list = await backendRequest<{ tasks?: Array<{ id: string; state: string; message?: string; error?: string }> }>({
            command: 'task_list',
          }).catch(() => null);
          if (!list) continue;
          const task = list.tasks?.find((item) => item.id === taskId);
          if (!task || task.state !== 'running') {
            if (task?.state === 'failed' || task?.state === 'cancelled' || task?.state === 'error') {
              showToast(task.error || task.message || t('assistant.quota_refresh_incomplete'), true);
            } else if (task?.message) {
              showToast(task.message);
            }
            completed = true;
            break;
          }
        }
        if (!completed) {
          showToast(t('assistant.quota_refresh_timeout'), true);
        }
      } else {
        await backendRequest({ command: 'quota_refresh_all' });
      }
      await Promise.all([fetchDashboard(true), fetchAccounts(), fetchAutoSwitch()]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      setQuotaRefreshing(false);
    }
  }, [fetchAccounts, fetchAutoSwitch, fetchDashboard, quotaRefreshing, reachable, showToast, t]);

  const refreshSingleAccountQuota = useCallback(
    async (id: string) => {
      if (!id || !reachable) return;
      setRefreshingAccountIds((prev) => new Set(prev).add(id));
      try {
        const res = await backendRequest<{ message?: string; notice?: string; standbyDeferred?: boolean }>({
          command: 'quota_refresh',
          id,
        });
        const msg = res?.standbyDeferred ? (res.notice || res.message) : res?.message;
        if (msg) showToast(msg);
        await Promise.all([fetchDashboard(true), fetchAccounts()]);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), true);
      } finally {
        setRefreshingAccountIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [fetchAccounts, fetchDashboard, reachable, showToast],
  );

  const interactiveSwitchAccount = useCallback(
    async (acc: { id: string; email: string; name?: string }) => {
      if (!acc.id || switchingAccount || !reachable) return;
      setSwitchingAccount(true);
      try {
        const preflight = await backendRequest<SwitchPreflightReply>({
          command: 'account_switch_preflight',
          id: acc.id,
        });

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
        if (!hasUiRunning && detachedCount === 0 && (await getAntigravityRunning())) {
          hasUiRunning = true;
        }
        const needClose = hasUiRunning || detachedCount > 0;
        const detachedOnly = !hasUiRunning && detachedCount > 0;
        const kindsLabel = formatDetachedDaemonKinds(detachedKinds, t, locale);
        const busy = preflight?.hasRunningTask === true || preflight?.safe === false;
        const display =
          acc.name && acc.name.toLowerCase() !== acc.email.toLowerCase()
            ? locale === 'en'
              ? `${acc.name} (${acc.email})`
              : `${acc.name}（${acc.email}）`
            : acc.email || acc.name || t('assistant_account.target_fallback');

        const baseBody = detachedOnly
          ? busy
            ? t('assistant_account.switch_detached_busy_body', {
                count: detachedCount,
                kinds: kindsLabel,
              })
            : t('assistant_account.switch_detached_body', {
                count: detachedCount,
                kinds: kindsLabel,
              })
          : busy
          ? t('assistant_account.switch_busy_body')
          : hasUiRunning
          ? t('assistant_account.switch_ready_body')
          : t('assistant_account.switch_stopped_body');
        const bodyWithSsh =
          sshWindowsCount > 0
            ? `${baseBody}\n\n${t('ssh.preflight.active_windows_warning', {
                count: sshWindowsCount,
                hosts: activeSshHosts.join(', ') || 'SSH',
              })}`
            : baseBody;

        const confirmed = await askConfirm({
          title: t('assistant_account.switch_prompt_title', { display }),
          body: bodyWithSsh,
          confirmLabel: detachedOnly
            ? t('assistant_account.switch_detached_confirm')
            : busy
            ? t('assistant_account.switch_busy_confirm')
            : t('assistant_account.switch_confirm'),
          danger: busy || detachedOnly,
        });
        if (!confirmed) return;

        if (needClose) {
          const outcome = await closeAntigravitySafely(18_000, 'switch');
          if (!outcome.closed) {
            showToast(
              detachedOnly
                ? t('assistant_account.detached_daemons_remaining', {
                    kinds: kindsLabel,
                    pids: detachedPids.join(', ') || '-',
                  })
                : outcome.reason === 'visible_window_open'
                ? locale === 'en'
                  ? 'Visible Antigravity windows are still open. Save and close them before switching accounts.'
                  : '检测到 Antigravity 仍有未关闭的可见窗口，请先保存并关闭后再切换账号。'
                : outcome.reason === 'uipi_access_denied'
                ? locale === 'en'
                  ? 'Antigravity is running elevated (administrator). Close it manually before switching accounts.'
                  : '检测到 Antigravity 以管理员权限运行，无法直接关闭。请先手动退出后再切换账号。'
                : t('assistant_account.quit_first'),
              true,
            );
            return;
          }
        }

        try {
          const switchRes = await backendRequest<{ message?: string }>({
            command: 'account_switch',
            id: acc.id,
            target: 'all',
            autoRefreshToken: true,
          });
          showToast(switchRes?.message || t('assistant_account.switched_to', { email: acc.email }));
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

        await refreshAll(true);
      } catch (err) {
        showToast(
          t('assistant_account.switch_failed', {
            error: err instanceof Error ? err.message : String(err),
          }),
          true,
        );
      } finally {
        setSwitchingAccount(false);
      }
    },
    [activeSshHosts, askConfirm, closeAntigravitySafely, locale, reachable, refreshAll, showToast, sshWindowsCount, switchingAccount, t],
  );

  const reconnectBackend = useCallback(async () => {
    try {
      await restartBackend();
      await refreshAll(true);
      showToast(t('status.connected'));
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    }
  }, [refreshAll, showToast, t]);

  const refreshAllRef = useRef(refreshAll);
  const fetchUsageRef = useRef(fetchUsage);
  const fetchMaintenanceScanRef = useRef(fetchMaintenanceScan);
  const showToastRef = useRef(showToast);
  const askBackgroundExitConfirmationRef = useRef(askBackgroundExitConfirmation);
  const scheduleTimerRef = useRef(scheduleTimer);
  const tRef = useRef(t);

  refreshAllRef.current = refreshAll;
  fetchUsageRef.current = fetchUsage;
  fetchMaintenanceScanRef.current = fetchMaintenanceScan;
  showToastRef.current = showToast;
  askBackgroundExitConfirmationRef.current = askBackgroundExitConfirmation;
  scheduleTimerRef.current = scheduleTimer;
  tRef.current = t;

  // Initial load
  useEffect(() => {
    let mounted = true;
    (async () => {
      const [cfg, info] = await Promise.all([loadUiConfig(), getAppInfo()]);
      if (!mounted) return;
      configRef.current = cfg;
      setConfig(cfg);
      setAppInfo(info);
      if (windowRole === 'main' && cfg.lastPage >= 0 && cfg.lastPage < PAGE_INDEX_MAP.length) {
        setActivePageState(PAGE_INDEX_MAP[cfg.lastPage]);
      }
      await refreshAllRef.current(false);
      if (mounted) {
        void fetchUsageRef.current('today', false);
        void fetchMaintenanceScanRef.current(7, false);
      }
    })();

    const unlisteners: Array<Promise<() => void>> = [
      listenEvent<UiConfig>('ui-config-changed', (nextCfg) => {
        if (!nextCfg || typeof nextCfg !== 'object' || typeof nextCfg.schema !== 'number') {
          return;
        }
        configRef.current = nextCfg;
        setConfig(nextCfg);
      }),
      listenEvent<string>('navigate-page', (page) => {
        if (PAGE_INDEX_MAP.includes(page as PageKey)) {
          setActivePageState(page as PageKey);
        }
      }),
      listenEvent<string>('backend-data-changed', () => {
        void refreshAllRef.current(false);
      }),
      listenEvent<{ message: string; error?: boolean }>('toast-message', (msg) => {
        showToastRef.current(msg.message, Boolean(msg.error));
      }),
      listenEvent<{ message?: string }>('confirm-background-relaunch', (payload) => {
        if (windowRole !== 'main') return;
        void (async () => {
          const ok = await askBackgroundExitConfirmationRef.current(payload?.message ?? '', 'relaunch');
          if (!ok) return;
          setRelaunching(true);
          try {
            const res = await safeRelaunchAntigravity(true);
            showToastRef.current(res.message, !res.ok);
            scheduleTimerRef.current(() => void refreshAllRef.current(true), 1200);
          } catch (err) {
            showToastRef.current(
              tRef.current('assistant.safe_relaunch_failed', {
                detail: err instanceof Error ? err.message : String(err),
              }),
              true,
            );
          } finally {
            setRelaunching(false);
          }
        })();
      }),
      listenEvent<void>('tray-opened', () => {
        if (windowRole === 'tray') {
          void refreshAllRef.current(false);
          void fetchUsageRef.current('today', false);
        }
      }),
    ];

    return () => {
      mounted = false;
      for (const p of unlisteners) {
        void p.then((fn) => fn());
      }
    };
  }, [windowRole]);

  // Periodic background status & data refresh
  useEffect(() => {
    const statusInterval = window.setInterval(() => {
      void fetchStatus();
    }, 4000);
    const dataInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchDashboard(false);
        void fetchAccounts();
      }
    }, 20_000);
    return () => {
      window.clearInterval(statusInterval);
      window.clearInterval(dataInterval);
    };
  }, [fetchAccounts, fetchDashboard, fetchStatus]);

  // Scheduled periodic quota refresh per user config
  useEffect(() => {
    const mins = config.quotaRefreshMinutes;
    if (!mins || mins <= 0 || windowRole !== 'main') return;
    const id = window.setInterval(() => {
      void refreshAllQuotas();
    }, mins * 60 * 1000);
    return () => window.clearInterval(id);
  }, [config.quotaRefreshMinutes, refreshAllQuotas, windowRole]);

  const accounts = useMemo(() => accountsPayload?.accounts ?? [], [accountsPayload]);
  const activeAccountId = useMemo(() => {
    const liveEmail = (status.liveAccountEmail ?? '').trim().toLowerCase();
    if (liveEmail) {
      const matched = accounts.find((a) => a.email.toLowerCase() === liveEmail);
      if (matched) return matched.id;
    }
    return accountsPayload?.activeId ?? accountsPayload?.currentAccountId ?? '';
  }, [accounts, accountsPayload, status.liveAccountEmail]);

  const hasPendingSwitch = useMemo(() => {
    const p = accountsPayload?.pendingSwitch;
    if (typeof p === 'boolean') return p;
    return Boolean(p?.isPending);
  }, [accountsPayload]);

  const value: AppContextValue = {
    windowRole,
    config,
    updateConfig,
    locale,
    languageSetting,
    setLanguage,
    themeMode,
    isDark,
    setThemeMode,
    t,
    activePage,
    setActivePage,
    appInfo,
    reachable,
    status,
    dashboard,
    accountsPayload,
    accounts,
    activeAccountId,
    hasPendingSwitch,
    autoSwitchConfig,
    autoSwitchPreview,
    usageByPeriod,
    usageLoading,
    usageErrors,
    weeklyAttributionList,
    weeklyAttributionLoading,
    maintenanceScan,
    proxyInfo,
    environments,
    sshEnvironments,
    sshWindowsCount,
    activeSshHosts,
    remoteSyncing,
    quotaRefreshing,
    refreshingAccountIds,
    relaunching,
    switchingAccount,
    refreshAll,
    fetchDashboard,
    fetchAccounts,
    fetchAutoSwitch,
    fetchUsage,
    fetchWeeklyAttribution,
    fetchMaintenanceScan,
    fetchProxy,
    applyProxy,
    refreshRemoteEnvironments,
    refreshAllQuotas,
    refreshSingleAccountQuota,
    toggleLocalization,
    toggleHud,
    openAntigravity,
    triggerSafeRelaunch,
    closeAntigravitySafely,
    interactiveSwitchAccount,
    reconnectBackend,
    toast,
    showToast,
    clearToast,
    confirmDialog,
    askConfirm,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
