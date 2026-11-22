from __future__ import annotations

import json
import platform
import urllib.request
from pathlib import Path
from typing import Any, Callable

from PyQt5.QtCore import Qt
from PyQt5.QtGui import QPixmap
from PyQt5.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from .antigravity_ctl import (
    find_antigravity_install,
    is_antigravity_running,
    is_autostart_enabled,
    launch_antigravity,
    open_path_or_url,
    safe_relaunch_antigravity,
    set_autostart_enabled,
    stop_antigravity_gracefully,
)
from .backend import BackendBridge
from .dialogs import (
    AutoSwitchPolicyDialog,
    MaintenanceDialog,
    ManageAccountsDialog,
    PricingSyncDialog,
)
from .l10n import L10n
from .paths import (
    default_cache_dir,
    default_log_dir,
    read_app_version,
    read_build_info,
    resolve_app_icon_path,
)
from .theme import ThemeColors
from .widgets import (
    BarTrendChart,
    Card,
    MetricTile,
    ModelIconProvider,
    PillBadge,
    ProgressBarWidget,
    QuotaBarRow,
    format_tokens,
    format_usd,
)


def _clear_layout(lay: QVBoxLayout) -> None:
    while lay.count():
        item = lay.takeAt(0)
        w = item.widget()
        if w is not None:
            w.deleteLater()
        elif item.layout() is not None:
            sub = item.layout()
            while sub.count():
                si = sub.takeAt(0)
                if si.widget():
                    si.widget().deleteLater()


def _scroll_page() -> tuple[QScrollArea, QVBoxLayout]:
    scroll = QScrollArea()
    scroll.setWidgetResizable(True)
    scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
    inner = QWidget()
    inner.setObjectName("PageBody")
    lay = QVBoxLayout(inner)
    lay.setContentsMargins(20, 18, 20, 22)
    lay.setSpacing(14)
    scroll.setWidget(inner)
    return scroll, lay


class OverviewPage(QWidget):
    def __init__(
        self,
        bridge: BackendBridge,
        l10n: L10n,
        theme: ThemeColors,
        icons: ModelIconProvider,
        on_refresh_all: Callable[[], None],
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.bridge = bridge
        self.l10n = l10n
        self.theme = theme
        self.icons = icons
        self.on_refresh_all = on_refresh_all

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        scroll, lay = _scroll_page()
        outer.addWidget(scroll)

        # Header
        hdr = QHBoxLayout()
        self.title_lbl = QLabel(l10n.bi("总览", "Overview"))
        self.title_lbl.setObjectName("PageTitle")
        hdr.addWidget(self.title_lbl)
        hdr.addStretch(1)
        self.conn_badge = PillBadge(l10n.bi("连接中…", "Connecting…"), "neutral", theme)
        hdr.addWidget(self.conn_badge)
        self.btn_refresh = QPushButton(l10n.bi("刷新配额", "Refresh Quota"))
        self.btn_refresh.clicked.connect(self._refresh_quota)
        hdr.addWidget(self.btn_refresh)
        lay.addLayout(hdr)

        # Debug port missing banner
        self.debug_banner = Card("WarnBanner")
        db_lay = QHBoxLayout(self.debug_banner)
        db_lay.setContentsMargins(14, 10, 14, 10)
        db_txt = QVBoxLayout()
        self.debug_title = QLabel(l10n.bi("未开启调试端口", "Debug port not enabled"))
        self.debug_title.setStyleSheet("font-weight: 700;")
        self.debug_body = QLabel(
            l10n.bi(
                "Antigravity 未带 --remote-debugging-port=0 运行，请先保存工作后安全重启以连接。",
                "Antigravity is running without --remote-debugging-port=0. Save your work and safely relaunch to connect.",
            )
        )
        self.debug_body.setObjectName("Secondary")
        self.debug_body.setWordWrap(True)
        db_txt.addWidget(self.debug_title)
        db_txt.addWidget(self.debug_body)
        db_lay.addLayout(db_txt, 1)
        self.btn_relaunch = QPushButton(l10n.bi("安全重启以连接", "Safe Relaunch"))
        self.btn_relaunch.setObjectName("PrimaryBtn")
        self.btn_relaunch.clicked.connect(self._safe_relaunch)
        db_lay.addWidget(self.btn_relaunch)
        self.debug_banner.setVisible(False)
        lay.addWidget(self.debug_banner)

        # Hero Active Account + Quota Card
        hero = Card()
        hlay = QVBoxLayout(hero)
        hlay.setContentsMargins(16, 14, 16, 14)
        hlay.setSpacing(10)
        top_row = QHBoxLayout()
        acc_col = QVBoxLayout()
        acc_col.setSpacing(2)
        name_row = QHBoxLayout()
        self.acc_name_lbl = QLabel(l10n.bi("正在读取当前账号…", "Loading active account…"))
        self.acc_name_lbl.setStyleSheet("font-size: 16px; font-weight: 700;")
        self.tier_badge = PillBadge("--", "purple", theme)
        self.live_badge = PillBadge("", "green", theme)
        self.live_badge.setVisible(False)
        name_row.addWidget(self.acc_name_lbl)
        name_row.addWidget(self.tier_badge)
        name_row.addWidget(self.live_badge)
        name_row.addStretch(1)
        self.acc_email_lbl = QLabel("")
        self.acc_email_lbl.setObjectName("Secondary")
        self.acc_warn_lbl = QLabel("")
        self.acc_warn_lbl.setObjectName("Secondary")
        self.acc_warn_lbl.setWordWrap(True)
        self.acc_warn_lbl.setVisible(False)
        acc_col.addLayout(name_row)
        acc_col.addWidget(self.acc_email_lbl)
        acc_col.addWidget(self.acc_warn_lbl)
        top_row.addLayout(acc_col, 1)

        # Quick IDE toggles
        toggles = QHBoxLayout()
        self.btn_i18n = QPushButton(l10n.bi("界面汉化：开启", "IDE i18n: On"))
        self.btn_i18n.clicked.connect(self._toggle_i18n)
        self.btn_hud = QPushButton(l10n.bi("会话 HUD：开启", "Session HUD: On"))
        self.btn_hud.clicked.connect(self._toggle_hud)
        toggles.addWidget(self.btn_i18n)
        toggles.addWidget(self.btn_hud)
        top_row.addLayout(toggles)
        hlay.addLayout(top_row)

        self.quota_bars_container = QVBoxLayout()
        self.quota_bars_container.setSpacing(8)
        hlay.addLayout(self.quota_bars_container)
        lay.addWidget(hero)

        # 3 Bento KPI Tiles
        kpi_row = QHBoxLayout()
        kpi_row.setSpacing(12)
        self.tile_tokens = MetricTile(l10n.bi("今日消耗 Token", "Today Tokens"), "--", "")
        self.tile_requests = MetricTile(l10n.bi("今日调用次数", "Today Requests"), "--", "")
        self.tile_cost = MetricTile(l10n.bi("今日估算费用", "Today Est. Cost"), "--", "")
        kpi_row.addWidget(self.tile_tokens, 1)
        kpi_row.addWidget(self.tile_requests, 1)
        kpi_row.addWidget(self.tile_cost, 1)
        lay.addLayout(kpi_row)

        # Dual Bento Row: 24h Trend + Active Models
        bento = QHBoxLayout()
        bento.setSpacing(12)

        trend_card = Card()
        tl = QVBoxLayout(trend_card)
        tl.setContentsMargins(14, 12, 14, 12)
        tl.setSpacing(8)
        self.trend_title = QLabel(l10n.bi("今日 24 小时用量趋势", "Today 24h Usage Trend"))
        self.trend_title.setObjectName("SectionTitle")
        tl.addWidget(self.trend_title)
        self.trend_chart = BarTrendChart(theme)
        tl.addWidget(self.trend_chart)
        bento.addWidget(trend_card, 3)

        models_card = Card()
        ml = QVBoxLayout(models_card)
        ml.setContentsMargins(14, 12, 14, 12)
        ml.setSpacing(8)
        self.models_title = QLabel(l10n.bi("今日活跃模型", "Active Models Today"))
        self.models_title.setObjectName("SectionTitle")
        ml.addWidget(self.models_title)
        self.models_list_lay = QVBoxLayout()
        self.models_list_lay.setSpacing(6)
        ml.addLayout(self.models_list_lay)
        ml.addStretch(1)
        bento.addWidget(models_card, 2)

        lay.addLayout(bento)
        lay.addStretch(1)

        self._last_translation_enabled = True
        self._last_hud_enabled = True

    def retranslate(self) -> None:
        self.title_lbl.setText(self.l10n.bi("总览", "Overview"))
        self.btn_refresh.setText(self.l10n.bi("刷新配额", "Refresh Quota"))
        self.debug_title.setText(self.l10n.bi("未开启调试端口", "Debug port not enabled"))
        self.debug_body.setText(
            self.l10n.bi(
                "Antigravity 未带 --remote-debugging-port=0 运行，请先保存工作后安全重启以连接。",
                "Antigravity is running without --remote-debugging-port=0. Save your work and safely relaunch to connect.",
            )
        )
        self.btn_relaunch.setText(self.l10n.bi("安全重启以连接", "Safe Relaunch"))
        self.trend_title.setText(self.l10n.bi("今日 24 小时用量趋势", "Today 24h Usage Trend"))
        self.models_title.setText(self.l10n.bi("今日活跃模型", "Active Models Today"))

    def update_status(self, st: dict[str, Any]) -> None:
        mode = str(st.get("mode") or "")
        app_ver = str(st.get("appVersion") or "")
        windows = int(st.get("windows") or 0)
        self._last_translation_enabled = bool(st.get("translationEnabled", True))
        self._last_hud_enabled = bool(st.get("hudEnabled", True))

        if mode == "connected":
            txt = self.l10n.bi(f"已连接 · v{app_ver} ({windows} 窗口)", f"Connected · v{app_ver} ({windows} win)")
            self.conn_badge.setText(txt)
            self.conn_badge.apply_tone("green", self.theme)
            self.debug_banner.setVisible(False)
        elif mode == "paused":
            self.conn_badge.setText(self.l10n.bi("已暂停汉化", "Localization Paused"))
            self.conn_badge.apply_tone("amber", self.theme)
            self.debug_banner.setVisible(False)
        else:
            running = is_antigravity_running()
            if running and mode in ("waiting", "debug_port_missing", "disconnected", ""):
                self.conn_badge.setText(self.l10n.bi("未开启调试端口", "Debug Port Missing"))
                self.conn_badge.apply_tone("amber", self.theme)
                self.debug_banner.setVisible(True)
            else:
                self.conn_badge.setText(self.l10n.bi("等待 Antigravity 启动", "Waiting for Antigravity"))
                self.conn_badge.apply_tone("neutral", self.theme)
                self.debug_banner.setVisible(False)

        self.btn_i18n.setText(
            self.l10n.bi(
                f"界面汉化：{'开启' if self._last_translation_enabled else '已暂停'}",
                f"IDE i18n: {'On' if self._last_translation_enabled else 'Paused'}",
            )
        )
        self.btn_hud.setText(
            self.l10n.bi(
                f"会话 HUD：{'开启' if self._last_hud_enabled else '关闭'}",
                f"Session HUD: {'On' if self._last_hud_enabled else 'Off'}",
            )
        )

    def update_dashboard(self, data: dict[str, Any]) -> None:
        acc = data.get("accounts") or {}
        usage = data.get("usage") or {}

        email = str(acc.get("activeEmail") or acc.get("currentEmail") or acc.get("liveAccountEmail") or "")
        name = str(acc.get("activeName") or email or self.l10n.bi("未检测到活跃账号", "No active account"))
        tier = str(acc.get("activeTier") or "FREE").upper()
        self.acc_name_lbl.setText(name)
        self.acc_email_lbl.setText(email if email and email != name else "")
        self.tier_badge.setText(tier)
        self.tier_badge.apply_tone("purple" if tier in ("PRO", "ULTRA") else "neutral", self.theme)

        is_live = bool(acc.get("isLiveVerified"))
        self.live_badge.setVisible(is_live)
        if is_live:
            self.live_badge.setText(self.l10n.bi("实时通道", "Live RPC"))

        warnings = acc.get("quotaWarnings") or []
        if warnings:
            self.acc_warn_lbl.setText(" · ".join(str(w) for w in warnings))
            self.acc_warn_lbl.setVisible(True)
        else:
            self.acc_warn_lbl.setVisible(False)

        # Render quota bars
        _clear_layout(self.quota_bars_container)
        bars: list[tuple[str, float | None, str]] = []
        if acc.get("geminiFiveHourRemaining") is not None:
            bars.append((
                self.l10n.bi("Gemini 5小时剩余配额", "Gemini 5h Remaining"),
                float(acc["geminiFiveHourRemaining"]),
                str(acc.get("geminiFiveHourResetCountdown") or ""),
            ))
        if acc.get("geminiWeeklyRemaining") is not None:
            bars.append((
                self.l10n.bi("Gemini 周剩余配额", "Gemini Weekly Remaining"),
                float(acc["geminiWeeklyRemaining"]),
                str(acc.get("geminiWeeklyResetCountdown") or ""),
            ))
        if acc.get("claudeFiveHourRemaining") is not None:
            bars.append((
                self.l10n.bi("Claude / GPT 5小时剩余", "Claude / GPT 5h Remaining"),
                float(acc["claudeFiveHourRemaining"]),
                str(acc.get("claudeFiveHourResetCountdown") or ""),
            ))
        if acc.get("claudeWeeklyRemaining") is not None:
            bars.append((
                self.l10n.bi("Claude / GPT 周剩余", "Claude / GPT Weekly Remaining"),
                float(acc["claudeWeeklyRemaining"]),
                str(acc.get("claudeWeeklyResetCountdown") or ""),
            ))
        if acc.get("argonWeeklyRemaining") is not None:
            bars.append((
                "Argon Weekly",
                float(acc["argonWeeklyRemaining"]),
                str(acc.get("argonWeeklyResetCountdown") or ""),
            ))
        if acc.get("carbonWeeklyRemaining") is not None:
            bars.append((
                "Carbon Weekly",
                float(acc["carbonWeeklyRemaining"]),
                str(acc.get("carbonWeeklyResetCountdown") or ""),
            ))

        if not bars:
            # Fallback to quotaGroups if present
            for grp in (acc.get("quotaGroups") or [])[:4]:
                gname = str(grp.get("display_name") or grp.get("name") or "Quota")
                for b in (grp.get("buckets") or [])[:2]:
                    rem = b.get("remaining_fraction")
                    pct = float(rem) * 100.0 if isinstance(rem, (int, float)) else None
                    bars.append((f"{gname} ({b.get('window', '')})", pct, str(b.get("reset_countdown") or "")))

        if not bars:
            empty_lbl = QLabel(self.l10n.bi("暂无配额数据，点击右上角“刷新配额”获取。", "No quota data yet. Click Refresh Quota."))
            empty_lbl.setObjectName("Secondary")
            self.quota_bars_container.addWidget(empty_lbl)
        else:
            for title, pct, reset_txt in bars:
                self.quota_bars_container.addWidget(QuotaBarRow(title, pct, reset_txt, self.theme))

        # KPI Tiles
        self.tile_tokens.set_data(
            self.l10n.bi("今日消耗 Token", "Today Tokens"),
            format_tokens(usage.get("todayTokens")),
            self.l10n.bi(
                f"累计 {format_tokens(usage.get('totalTokens'))}",
                f"All-time {format_tokens(usage.get('totalTokens'))}",
            ),
        )
        self.tile_requests.set_data(
            self.l10n.bi("今日调用次数", "Today Requests"),
            str(int(usage.get("requestCount") or 0)),
            self.l10n.bi(
                f"累计 {int(usage.get('totalRequestCount') or 0)} 次",
                f"All-time {int(usage.get('totalRequestCount') or 0)} calls",
            ),
        )
        self.tile_cost.set_data(
            self.l10n.bi("今日估算费用", "Today Est. Cost"),
            format_usd(usage.get("estimatedUsd")),
            self.l10n.bi(
                f"累计 {format_usd(usage.get('allTimeEstimatedUsd'))}",
                f"All-time {format_usd(usage.get('allTimeEstimatedUsd'))}",
            ),
        )

        # 24h Trend Chart
        hourly = usage.get("todayHourly") or []
        points: list[tuple[str, float, str]] = []
        for h in hourly:
            hr = str(h.get("hour") or h.get("label") or "")
            tok = float(h.get("total_tokens") or h.get("totalTokens") or h.get("tokens") or 0)
            reqs = int(h.get("request_count") or h.get("requestCount") or 0)
            points.append((hr, tok, f"{format_tokens(tok)} tokens · {reqs} calls"))
        self.trend_chart.set_points(points, self.theme)

        # Active Models Today
        _clear_layout(self.models_list_lay)
        by_model = usage.get("todayByModel") or []
        if not by_model:
            lbl = QLabel(self.l10n.bi("今日暂无模型调用记录", "No model calls recorded today"))
            lbl.setObjectName("Secondary")
            self.models_list_lay.addWidget(lbl)
        else:
            total_tok = sum(float(m.get("totalTokens") or m.get("total_tokens") or 0) for m in by_model) or 1.0
            for m in by_model[:6]:
                mname = str(m.get("displayName") or m.get("model") or m.get("name") or "Model")
                mtok = float(m.get("totalTokens") or m.get("total_tokens") or 0)
                mcost = float(m.get("estimatedUsd") or m.get("estimated_usd") or 0)
                row = QWidget()
                rl = QVBoxLayout(row)
                rl.setContentsMargins(0, 2, 0, 2)
                rl.setSpacing(3)
                top = QHBoxLayout()
                top.setContentsMargins(0, 0, 0, 0)
                pm = self.icons.pixmap_for(mname, 16)
                if pm:
                    il = QLabel()
                    il.setPixmap(pm)
                    top.addWidget(il)
                nl = QLabel(mname)
                nl.setStyleSheet("font-size: 12px; font-weight: 600;")
                top.addWidget(nl, 1)
                vl = QLabel(f"{format_tokens(mtok)} · {format_usd(mcost)}")
                vl.setObjectName("Secondary")
                top.addWidget(vl)
                rl.addLayout(top)
                rl.addWidget(ProgressBarWidget(mtok / total_tok, self.theme))
                self.models_list_lay.addWidget(row)

    def _refresh_quota(self) -> None:
        self.btn_refresh.setEnabled(False)

        def _done(_res: dict[str, Any] | None, _err: Exception | None) -> None:
            self.btn_refresh.setEnabled(True)
            self.on_refresh_all()

        self.bridge.call_async({"command": "quota_refresh"}, _done, timeout=30.0)

    def _toggle_i18n(self) -> None:
        cmd = "pause" if self._last_translation_enabled else "resume"
        self.bridge.call_async({"command": cmd}, lambda *_: self.on_refresh_all())

    def _toggle_hud(self) -> None:
        self.bridge.call_async({"command": "hud_set", "enabled": not self._last_hud_enabled}, lambda *_: self.on_refresh_all())

    def _safe_relaunch(self) -> None:
        ok, err = safe_relaunch_antigravity()
        if not ok:
            QMessageBox.warning(self, "GravityBox", err)
        else:
            self.on_refresh_all()


class AccountsPage(QWidget):
    def __init__(
        self,
        bridge: BackendBridge,
        l10n: L10n,
        theme: ThemeColors,
        on_refresh_all: Callable[[], None],
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.bridge = bridge
        self.l10n = l10n
        self.theme = theme
        self.on_refresh_all = on_refresh_all
        self._oauth_configured = False
        self._recovery_digest = ""
        self._accounts: list[dict[str, Any]] = []

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        scroll, lay = _scroll_page()
        outer.addWidget(scroll)

        hdr = QHBoxLayout()
        self.title_lbl = QLabel(l10n.bi("账号管理", "Accounts"))
        self.title_lbl.setObjectName("PageTitle")
        hdr.addWidget(self.title_lbl)
        hdr.addStretch(1)
        self.btn_policy = QPushButton(l10n.bi("智能策略…", "Auto-Switch…"))
        self.btn_policy.clicked.connect(self._open_policy)
        self.btn_refresh_all = QPushButton(l10n.bi("全部刷新", "Refresh All"))
        self.btn_refresh_all.clicked.connect(self._refresh_all_quotas)
        self.btn_manage = QPushButton(l10n.bi("管理账号…", "Manage Accounts…"))
        self.btn_manage.setObjectName("PrimaryBtn")
        self.btn_manage.clicked.connect(self._open_manage)
        hdr.addWidget(self.btn_policy)
        hdr.addWidget(self.btn_refresh_all)
        hdr.addWidget(self.btn_manage)
        lay.addLayout(hdr)

        # Rollback / Recovery banner
        self.recovery_banner = Card("WarnBanner")
        rb_lay = QHBoxLayout(self.recovery_banner)
        rb_lay.setContentsMargins(14, 10, 14, 10)
        self.recovery_lbl = QLabel("")
        self.recovery_lbl.setWordWrap(True)
        rb_lay.addWidget(self.recovery_lbl, 1)
        self.btn_rollback = QPushButton(l10n.bi("撤销上次切号", "Rollback Switch"))
        self.btn_rollback.clicked.connect(self._rollback_switch)
        self.btn_clear_rec = QPushButton(l10n.bi("清除恢复记录", "Clear Recovery"))
        self.btn_clear_rec.clicked.connect(self._clear_recovery)
        rb_lay.addWidget(self.btn_rollback)
        rb_lay.addWidget(self.btn_clear_rec)
        self.recovery_banner.setVisible(False)
        lay.addWidget(self.recovery_banner)

        self.status_lbl = QLabel("")
        self.status_lbl.setObjectName("Secondary")
        self.status_lbl.setWordWrap(True)
        lay.addWidget(self.status_lbl)

        self.list_lay = QVBoxLayout()
        self.list_lay.setSpacing(10)
        lay.addLayout(self.list_lay)
        lay.addStretch(1)

    def retranslate(self) -> None:
        self.title_lbl.setText(self.l10n.bi("账号管理", "Accounts"))
        self.btn_policy.setText(self.l10n.bi("智能策略…", "Auto-Switch…"))
        self.btn_refresh_all.setText(self.l10n.bi("全部刷新", "Refresh All"))
        self.btn_manage.setText(self.l10n.bi("管理账号…", "Manage Accounts…"))
        self.btn_rollback.setText(self.l10n.bi("撤销上次切号", "Rollback Switch"))
        self.btn_clear_rec.setText(self.l10n.bi("清除恢复记录", "Clear Recovery"))

    def set_oauth_configured(self, configured: bool) -> None:
        self._oauth_configured = configured

    def reload(self) -> None:
        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            if err or not res or not res.get("ok"):
                self.status_lbl.setText(str(err or (res or {}).get("error") or ""))
                return
            self._render_accounts(res)

        self.bridge.call_async({"command": "account_list"}, _done, timeout=20.0)

    def _render_accounts(self, res: dict[str, Any]) -> None:
        active_id = res.get("activeId") or res.get("currentAccountId")
        accounts = res.get("accounts") or []
        self._accounts = accounts

        rec = res.get("recovery") or {}
        if rec.get("available") and rec.get("status") not in ("cleared", "rolled-back"):
            self._recovery_digest = str(rec.get("digest") or "")
            self.recovery_lbl.setText(
                self.l10n.bi(
                    f"检测到可回滚的切号快照（状态：{rec.get('status')}），可一键撤销恢复至原账号。",
                    f"Rollback recovery snapshot available (status: {rec.get('status')}).",
                )
            )
            self.recovery_banner.setVisible(True)
        else:
            self.recovery_banner.setVisible(False)

        _clear_layout(self.list_lay)
        if not accounts:
            empty = Card()
            el = QVBoxLayout(empty)
            el.setContentsMargins(18, 22, 18, 22)
            lbl = QLabel(
                self.l10n.bi(
                    "尚未保存任何账号。点击右上角「管理账号…」可保存当前登录账号或从 JSON 批量导入。",
                    "No saved accounts yet. Click 'Manage Accounts…' to save the current login or batch import JSON.",
                )
            )
            lbl.setObjectName("Secondary")
            lbl.setWordWrap(True)
            el.addWidget(lbl)
            self.list_lay.addWidget(empty)
            return

        for idx, acc in enumerate(accounts):
            acc_id = str(acc.get("id") or "")
            email = str(acc.get("email") or "")
            name = str(acc.get("name") or email)
            tier = str(acc.get("subscription_tier") or "FREE").upper()
            is_active = acc_id == active_id or bool(acc.get("isActive"))

            card = Card()
            cl = QVBoxLayout(card)
            cl.setContentsMargins(14, 12, 14, 12)
            cl.setSpacing(8)

            top = QHBoxLayout()
            title = QLabel(name)
            title.setStyleSheet("font-size: 14.5px; font-weight: 700;")
            top.addWidget(title)
            if is_active:
                top.addWidget(PillBadge(self.l10n.bi("当前使用中", "Active"), "blue", self.theme))
            top.addWidget(PillBadge(tier, "purple" if tier in ("PRO", "ULTRA") else "neutral", self.theme))

            standby = acc.get("standbyRefreshStatus") or {}
            if not is_active and standby.get("state") == "expired_standby":
                top.addWidget(PillBadge(self.l10n.bi("备用静默", "Standby"), "neutral", self.theme))
            top.addStretch(1)

            if not is_active:
                btn_sw = QPushButton(self.l10n.bi("切换账号", "Switch"))
                btn_sw.setObjectName("PrimaryBtn")
                btn_sw.clicked.connect(lambda _c=False, _id=acc_id, _em=email: self._switch_account(_id, _em))
                top.addWidget(btn_sw)
            btn_ref = QPushButton(self.l10n.bi("刷新", "Refresh"))
            btn_ref.clicked.connect(lambda _c=False, _id=acc_id: self._refresh_one(_id))
            btn_ren = QPushButton(self.l10n.bi("备注", "Rename"))
            btn_ren.clicked.connect(lambda _c=False, _id=acc_id, _nm=name: self._rename_one(_id, _nm))
            btn_del = QPushButton(self.l10n.bi("删除", "Delete"))
            btn_del.setObjectName("DangerBtn")
            btn_del.clicked.connect(lambda _c=False, _id=acc_id, _em=email: self._delete_one(_id, _em))
            top.addWidget(btn_ref)
            top.addWidget(btn_ren)
            if idx > 0 and not is_active:
                btn_up = QPushButton("↑")
                btn_up.setFixedWidth(30)
                btn_up.clicked.connect(lambda _c=False, _i=idx: self._move_account(_i, -1))
                top.addWidget(btn_up)
            top.addWidget(btn_del)
            cl.addLayout(top)

            if email and email != name:
                el = QLabel(email)
                el.setObjectName("Secondary")
                cl.addWidget(el)

            # Quota bars for account
            g5 = acc.get("geminiFiveHourRemaining")
            gw = acc.get("geminiWeeklyRemaining")
            c5 = acc.get("claudeFiveHourRemaining")
            cw = acc.get("claudeWeeklyRemaining")
            if g5 is not None:
                cl.addWidget(QuotaBarRow("Gemini 5h", float(g5), str(acc.get("geminiFiveHourResetCountdown") or ""), self.theme))
            if gw is not None:
                cl.addWidget(QuotaBarRow("Gemini Weekly", float(gw), str(acc.get("geminiWeeklyResetCountdown") or ""), self.theme))
            if c5 is not None:
                cl.addWidget(QuotaBarRow("Claude 5h", float(c5), str(acc.get("claudeFiveHourResetCountdown") or ""), self.theme))
            if cw is not None:
                cl.addWidget(QuotaBarRow("Claude Weekly", float(cw), str(acc.get("claudeWeeklyResetCountdown") or ""), self.theme))

            err_msg = acc.get("quota_refresh_error")
            if err_msg:
                err_lbl = QLabel(str(err_msg))
                err_lbl.setObjectName("Secondary")
                err_lbl.setWordWrap(True)
                cl.addWidget(err_lbl)

            self.list_lay.addWidget(card)

    def _open_manage(self) -> None:
        dlg = ManageAccountsDialog(self.bridge, self.l10n, self.theme, self._oauth_configured, self)
        dlg.exec_()
        if dlg.changed:
            self.reload()
            self.on_refresh_all()

    def _open_policy(self) -> None:
        dlg = AutoSwitchPolicyDialog(self.bridge, self.l10n, self.theme, self)
        dlg.exec_()

    def _refresh_all_quotas(self) -> None:
        self.btn_refresh_all.setEnabled(False)
        self.status_lbl.setText(self.l10n.bi("正在刷新所有有效账号配额…", "Refreshing all account quotas…"))

        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            self.btn_refresh_all.setEnabled(True)
            if err:
                self.status_lbl.setText(str(err))
            else:
                skipped = int((res or {}).get("skippedStandby") or 0)
                self.status_lbl.setText(
                    self.l10n.bi(
                        f"配额刷新完成（已静默跳过 {skipped} 个过期备用号）。",
                        f"Refresh complete ({skipped} expired standby skipped).",
                    )
                )
            self.reload()
            self.on_refresh_all()

        self.bridge.call_async({"command": "quota_refresh_all"}, _done, timeout=60.0)

    def _refresh_one(self, acc_id: str) -> None:
        self.status_lbl.setText(self.l10n.bi("正在刷新账号配额…", "Refreshing quota…"))

        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            self.status_lbl.setText(str(err or (res or {}).get("message") or (res or {}).get("error") or ""))
            self.reload()
            self.on_refresh_all()

        self.bridge.call_async({"command": "quota_refresh", "id": acc_id}, _done, timeout=30.0)

    def _rename_one(self, acc_id: str, current_name: str) -> None:
        text, ok = QInputDialog.getText(
            self,
            self.l10n.bi("修改账号备注", "Rename Account"),
            self.l10n.bi("请输入新备注名：", "Enter new display name:"),
            text=current_name,
        )
        if not ok or not text.strip():
            return
        self.bridge.call_async(
            {"command": "account_rename", "id": acc_id, "name": text.strip()},
            lambda *_: self.reload(),
        )

    def _delete_one(self, acc_id: str, email: str) -> None:
        ans = QMessageBox.question(
            self,
            self.l10n.bi("确认移除账号", "Confirm Account Removal"),
            self.l10n.bi(f"确定从 GravityBox 移除账号 {email}？（不影响云端 Google 账号）", f"Remove {email} from GravityBox?"),
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if ans != QMessageBox.Yes:
            return
        self.bridge.call_async({"command": "account_delete", "id": acc_id}, lambda *_: (self.reload(), self.on_refresh_all()))

    def _move_account(self, index: int, delta: int) -> None:
        ids = [str(a.get("id")) for a in self._accounts]
        target = index + delta
        if target < 0 or target >= len(ids):
            return
        ids[index], ids[target] = ids[target], ids[index]
        self.bridge.call_async({"command": "account_reorder", "ids": ids}, lambda *_: self.reload())

    def _switch_account(self, acc_id: str, email: str) -> None:
        self.status_lbl.setText(self.l10n.bi("正在执行切号前安全检查…", "Running switch preflight check…"))

        def _after_preflight(res: dict[str, Any] | None, err: Exception | None) -> None:
            if err or not res or not res.get("ok"):
                self.status_lbl.setText(str(err or (res or {}).get("error") or "Preflight failed"))
                return
            if res.get("hasRunningTask"):
                QMessageBox.warning(
                    self,
                    self.l10n.bi("检测到正在运行的任务", "Active Agent Task Running"),
                    self.l10n.bi(
                        f"Antigravity 正在执行任务（{res.get('taskReason', '')}），请等待任务完成后再切换账号。",
                        f"Antigravity has an active task ({res.get('taskReason', '')}). Wait until it finishes.",
                    ),
                )
                self.status_lbl.setText("")
                return
            relaunch_after = False
            if res.get("appRunning"):
                ans = QMessageBox.question(
                    self,
                    self.l10n.bi("关闭 Antigravity 并切换账号", "Close Antigravity & Switch Account"),
                    self.l10n.bi(
                        f"切换至 {email} 需要先安全关闭 Antigravity。\n点击「是」将自动安全关闭、原子切号并重新启动 Antigravity。",
                        f"Switching to {email} requires closing Antigravity first.\nClick Yes to stop Antigravity, switch atomically, and relaunch.",
                    ),
                    QMessageBox.Yes | QMessageBox.No,
                    QMessageBox.No,
                )
                if ans != QMessageBox.Yes:
                    self.status_lbl.setText("")
                    return
                if not stop_antigravity_gracefully(timeout=6.0):
                    QMessageBox.warning(
                        self,
                        "GravityBox",
                        self.l10n.bi("未能关闭 Antigravity，请手动退出后重试。", "Failed to close Antigravity. Please quit it manually."),
                    )
                    return
                relaunch_after = True

            self.status_lbl.setText(self.l10n.bi(f"正在原子切换至 {email}…", f"Switching atomically to {email}…"))

            def _after_switch(sw_res: dict[str, Any] | None, sw_err: Exception | None) -> None:
                if sw_err or not sw_res or not sw_res.get("ok"):
                    msg = str(sw_err or (sw_res or {}).get("error") or "Switch failed")
                    self.status_lbl.setText(msg)
                    QMessageBox.warning(self, self.l10n.bi("切号失败", "Switch Failed"), msg)
                else:
                    self.status_lbl.setText(str(sw_res.get("message") or self.l10n.bi("切换成功", "Switched")))
                    if relaunch_after:
                        launch_antigravity(with_debug_port=True)
                self.reload()
                self.on_refresh_all()

            self.bridge.call_async({"command": "account_switch", "id": acc_id, "target": "all"}, _after_switch, timeout=30.0)

        self.bridge.call_async({"command": "account_switch_preflight"}, _after_preflight, timeout=15.0)

    def _rollback_switch(self) -> None:
        if is_antigravity_running():
            ans = QMessageBox.question(
                self,
                self.l10n.bi("关闭 Antigravity 并撤销切号", "Close Antigravity & Rollback"),
                self.l10n.bi("撤销切号需先安全关闭 Antigravity，是否继续？", "Rollback requires closing Antigravity first. Continue?"),
                QMessageBox.Yes | QMessageBox.No,
            )
            if ans != QMessageBox.Yes:
                return
            if not stop_antigravity_gracefully(timeout=6.0):
                QMessageBox.warning(self, "GravityBox", self.l10n.bi("请先手动退出 Antigravity。", "Please quit Antigravity first."))
                return

        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            self.status_lbl.setText(str(err or (res or {}).get("message") or (res or {}).get("error") or ""))
            self.reload()
            self.on_refresh_all()

        self.bridge.call_async({"command": "account_switch_rollback"}, _done, timeout=30.0)

    def _clear_recovery(self) -> None:
        if not self._recovery_digest:
            return
        self.bridge.call_async(
            {"command": "account_recovery_clear", "digest": self._recovery_digest, "confirm": True},
            lambda *_: self.reload(),
        )


class UsagePage(QWidget):
    def __init__(
        self,
        bridge: BackendBridge,
        l10n: L10n,
        theme: ThemeColors,
        icons: ModelIconProvider,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.bridge = bridge
        self.l10n = l10n
        self.theme = theme
        self.icons = icons
        self._period = "7d"

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        scroll, lay = _scroll_page()
        outer.addWidget(scroll)

        hdr = QHBoxLayout()
        self.title_lbl = QLabel(l10n.bi("用量统计", "Usage Analytics"))
        self.title_lbl.setObjectName("PageTitle")
        hdr.addWidget(self.title_lbl)
        hdr.addStretch(1)
        self.combo_period = QComboBox()
        for code, zh, en in (
            ("today", "今日", "Today"),
            ("7d", "近 7 天", "Last 7 Days"),
            ("30d", "近 30 天", "Last 30 Days"),
            ("all", "全部历史", "All Time"),
        ):
            self.combo_period.addItem(l10n.bi(zh, en), code)
        self.combo_period.setCurrentIndex(1)
        self.combo_period.currentIndexChanged.connect(self._on_period_changed)
        hdr.addWidget(self.combo_period)
        self.btn_pricing = QPushButton(l10n.bi("价格同步…", "Pricing Sync…"))
        self.btn_pricing.clicked.connect(self._open_pricing)
        self.btn_reload = QPushButton(l10n.bi("刷新", "Refresh"))
        self.btn_reload.clicked.connect(lambda: self.reload(force=True))
        hdr.addWidget(self.btn_pricing)
        hdr.addWidget(self.btn_reload)
        lay.addLayout(hdr)

        # KPI Row
        kpis = QHBoxLayout()
        kpis.setSpacing(10)
        self.kpi_tokens = MetricTile(l10n.bi("总 Token", "Total Tokens"))
        self.kpi_cost = MetricTile(l10n.bi("估算费用", "Estimated Cost"))
        self.kpi_cache = MetricTile(l10n.bi("缓存命中率", "Cache Hit Rate"))
        self.kpi_reqs = MetricTile(l10n.bi("生成次数", "Generations"))
        for tile in (self.kpi_tokens, self.kpi_cost, self.kpi_cache, self.kpi_reqs):
            kpis.addWidget(tile, 1)
        lay.addLayout(kpis)

        # Daily / Hourly Chart Card
        chart_card = Card()
        cl = QVBoxLayout(chart_card)
        cl.setContentsMargins(14, 12, 14, 12)
        self.chart_title = QLabel(l10n.bi("用量趋势", "Usage Trend"))
        self.chart_title.setObjectName("SectionTitle")
        cl.addWidget(self.chart_title)
        self.chart = BarTrendChart(theme)
        cl.addWidget(self.chart)
        lay.addWidget(chart_card)

        # Model Breakdown Card
        models_card = Card()
        ml = QVBoxLayout(models_card)
        ml.setContentsMargins(14, 12, 14, 12)
        ml.setSpacing(8)
        self.models_hdr = QLabel(l10n.bi("模型分布", "Model Breakdown"))
        self.models_hdr.setObjectName("SectionTitle")
        ml.addWidget(self.models_hdr)
        self.models_lay = QVBoxLayout()
        self.models_lay.setSpacing(6)
        ml.addLayout(self.models_lay)
        lay.addWidget(models_card)

        # Recent Events Card
        events_card = Card()
        el = QVBoxLayout(events_card)
        el.setContentsMargins(14, 12, 14, 12)
        el.setSpacing(6)
        self.events_hdr = QLabel(l10n.bi("最近调用明细", "Recent Usage Events"))
        self.events_hdr.setObjectName("SectionTitle")
        el.addWidget(self.events_hdr)
        self.events_lay = QVBoxLayout()
        self.events_lay.setSpacing(6)
        el.addLayout(self.events_lay)
        lay.addWidget(events_card)

        lay.addStretch(1)

    def retranslate(self) -> None:
        self.title_lbl.setText(self.l10n.bi("用量统计", "Usage Analytics"))
        self.btn_pricing.setText(self.l10n.bi("价格同步…", "Pricing Sync…"))
        self.btn_reload.setText(self.l10n.bi("刷新", "Refresh"))
        self.chart_title.setText(self.l10n.bi("用量趋势", "Usage Trend"))
        self.models_hdr.setText(self.l10n.bi("模型分布", "Model Breakdown"))
        self.events_hdr.setText(self.l10n.bi("最近调用明细", "Recent Usage Events"))

    def _on_period_changed(self) -> None:
        self._period = str(self.combo_period.currentData() or "7d")
        self.reload(force=False)

    def _open_pricing(self) -> None:
        dlg = PricingSyncDialog(self.bridge, self.l10n, self.theme, self)
        dlg.exec_()
        if dlg.changed:
            self.reload(force=True)

    def reload(self, force: bool = False) -> None:
        period = self._period

        def _done_summary(res: dict[str, Any] | None, _err: Exception | None) -> None:
            if not res or not res.get("ok"):
                return
            s = res.get("summary") or {}
            self.kpi_tokens.set_data(
                self.l10n.bi("总 Token", "Total Tokens"),
                format_tokens(s.get("totalTokens")),
                self.l10n.bi(
                    f"输入 {format_tokens(s.get('promptTokens'))} · 输出 {format_tokens(s.get('candidatesTokens'))}",
                    f"In {format_tokens(s.get('promptTokens'))} · Out {format_tokens(s.get('candidatesTokens'))}",
                ),
            )
            self.kpi_cost.set_data(
                self.l10n.bi("估算费用", "Estimated Cost"),
                format_usd(s.get("estimatedUsd")),
                str(s.get("scanScopeDescription") or ""),
            )
            hit = float(s.get("cacheHitRate") or 0.0)
            pct = hit * 100.0 if hit <= 1.0 else hit
            self.kpi_cache.set_data(
                self.l10n.bi("缓存命中率", "Cache Hit Rate"),
                f"{pct:.1f}%",
                self.l10n.bi(
                    f"缓存读 {format_tokens(s.get('cachedTokens'))}",
                    f"Cached {format_tokens(s.get('cachedTokens'))}",
                ),
            )
            self.kpi_reqs.set_data(
                self.l10n.bi("生成次数", "Generations"),
                str(int(s.get("requestCount") or 0)),
                self.l10n.bi(
                    f"已扫描 {int(s.get('databasesScanned') or 0)} 个库",
                    f"Scanned {int(s.get('databasesScanned') or 0)} DBs",
                ),
            )

            # Chart points
            pts: list[tuple[str, float, str]] = []
            if period == "today":
                for h in res.get("todayHourly") or []:
                    lbl = str(h.get("hour") or h.get("label") or "")
                    tok = float(h.get("total_tokens") or h.get("totalTokens") or h.get("tokens") or 0)
                    reqs = int(h.get("request_count") or h.get("requestCount") or 0)
                    pts.append((lbl, tok, f"{format_tokens(tok)} tokens · {reqs} calls"))
            else:
                for d in res.get("dailyTrends") or []:
                    lbl = str(d.get("date") or d.get("day") or "")
                    tok = float(d.get("totalTokens") or d.get("total_tokens") or 0)
                    cost = float(d.get("estimatedUsd") or d.get("estimated_usd") or 0)
                    pts.append((lbl, tok, f"{format_tokens(tok)} tokens · {format_usd(cost)}"))
            self.chart.set_points(pts, self.theme)

            # Models breakdown
            _clear_layout(self.models_lay)
            models = res.get("byModel") or res.get("models") or []
            if not models:
                lbl = QLabel(self.l10n.bi("该时间范围内暂无模型用量数据。", "No model usage data in this period."))
                lbl.setObjectName("Secondary")
                self.models_lay.addWidget(lbl)
            else:
                total_tok = sum(float(m.get("totalTokens") or m.get("total_tokens") or 0) for m in models) or 1.0
                for m in models[:12]:
                    mname = str(m.get("displayName") or m.get("model") or m.get("name") or "Unknown")
                    mtok = float(m.get("totalTokens") or m.get("total_tokens") or 0)
                    mcost = float(m.get("estimatedUsd") or m.get("estimated_usd") or 0)
                    reqs = int(m.get("requestCount") or m.get("request_count") or 0)
                    priced = m.get("priced", True)

                    row = Card("SubCard")
                    rl = QVBoxLayout(row)
                    rl.setContentsMargins(10, 8, 10, 8)
                    rl.setSpacing(4)
                    top = QHBoxLayout()
                    pm = self.icons.pixmap_for(mname, 18)
                    if pm:
                        il = QLabel()
                        il.setPixmap(pm)
                        top.addWidget(il)
                    nl = QLabel(mname)
                    nl.setStyleSheet("font-weight: 600;")
                    top.addWidget(nl)
                    if not priced:
                        top.addWidget(PillBadge(self.l10n.bi("未计价", "Unpriced"), "amber", self.theme))
                    top.addStretch(1)
                    stat = QLabel(f"{reqs}x · {format_tokens(mtok)} · {format_usd(mcost)}")
                    stat.setObjectName("Secondary")
                    top.addWidget(stat)
                    rl.addLayout(top)
                    rl.addWidget(ProgressBarWidget(mtok / total_tok, self.theme))
                    self.models_lay.addWidget(row)

        def _done_events(res: dict[str, Any] | None, _err: Exception | None) -> None:
            _clear_layout(self.events_lay)
            rows = (res or {}).get("rows") or []
            if not rows:
                lbl = QLabel(self.l10n.bi("暂无明细记录。", "No recent events."))
                lbl.setObjectName("Secondary")
                self.events_lay.addWidget(lbl)
                return
            for ev in rows[:15]:
                card = Card("SubCard")
                hl = QHBoxLayout(card)
                hl.setContentsMargins(10, 7, 10, 7)
                model = str(ev.get("displayName") or ev.get("model") or "Model")
                ts = str(ev.get("timestamp") or ev.get("time") or "")
                tok = format_tokens(ev.get("totalTokens") or ev.get("total_tokens"))
                cost = format_usd(ev.get("estimatedUsd") or ev.get("estimated_usd"))
                left = QVBoxLayout()
                l1 = QLabel(model)
                l1.setStyleSheet("font-weight: 600;")
                l2 = QLabel(ts)
                l2.setObjectName("Secondary")
                left.addWidget(l1)
                left.addWidget(l2)
                hl.addLayout(left, 1)
                right = QLabel(f"{tok} · {cost}")
                right.setObjectName("Secondary")
                hl.addWidget(right)
                self.events_lay.addWidget(card)

        self.bridge.call_async({"command": "usage_summary", "period": period, "force": force}, _done_summary, timeout=30.0)
        self.bridge.call_async({"command": "usage_events", "period": period, "offset": 0, "limit": 15, "force": force}, _done_events, timeout=30.0)


class SettingsPage(QWidget):
    def __init__(
        self,
        bridge: BackendBridge,
        l10n: L10n,
        theme: ThemeColors,
        on_locale_changed: Callable[[str], None],
        on_refresh_all: Callable[[], None],
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.bridge = bridge
        self.l10n = l10n
        self.theme = theme
        self.on_locale_changed = on_locale_changed
        self.on_refresh_all = on_refresh_all

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        scroll, lay = _scroll_page()
        outer.addWidget(scroll)

        self.title_lbl = QLabel(l10n.bi("设置", "Settings"))
        self.title_lbl.setObjectName("PageTitle")
        lay.addWidget(self.title_lbl)

        # Card 1: Language & IDE Features
        c1 = Card()
        c1_lay = QVBoxLayout(c1)
        c1_lay.setContentsMargins(16, 14, 16, 14)
        c1_lay.setSpacing(12)

        lang_row = QHBoxLayout()
        self.lang_lbl = QLabel(l10n.bi("界面语言（应用 + 后端 + HUD 联动）", "Language (App + Backend + HUD)"))
        self.combo_lang = QComboBox()
        self.combo_lang.addItem(l10n.bi("跟随系统", "Follow System"), "system")
        self.combo_lang.addItem("简体中文", "zh-Hans")
        self.combo_lang.addItem("English", "en")
        idx = self.combo_lang.findData(l10n.preference)
        if idx >= 0:
            self.combo_lang.setCurrentIndex(idx)
        self.combo_lang.currentIndexChanged.connect(self._on_lang_changed)
        lang_row.addWidget(self.lang_lbl, 1)
        lang_row.addWidget(self.combo_lang)
        c1_lay.addLayout(lang_row)

        self.chk_i18n = QCheckBox(l10n.bi("启用 Antigravity 零侵入中文热适配", "Enable non-invasive Antigravity Chinese localization"))
        self.chk_i18n.setChecked(True)
        self.chk_i18n.clicked.connect(self._on_toggle_i18n)
        c1_lay.addWidget(self.chk_i18n)

        self.chk_hud = QCheckBox(l10n.bi("启用输入框实时会话遥测 HUD", "Enable in-IDE real-time telemetry HUD"))
        self.chk_hud.setChecked(True)
        self.chk_hud.clicked.connect(self._on_toggle_hud)
        c1_lay.addWidget(self.chk_hud)

        self.chk_autostart = QCheckBox(l10n.bi("Ubuntu 登录时自动在托盘启动 GravityBox", "Launch GravityBox in system tray at login"))
        self.chk_autostart.setChecked(is_autostart_enabled())
        self.chk_autostart.toggled.connect(lambda checked: set_autostart_enabled(checked))
        c1_lay.addWidget(self.chk_autostart)
        lay.addWidget(c1)

        # Card 2: Cache Maintenance
        c2 = Card()
        c2_lay = QHBoxLayout(c2)
        c2_lay.setContentsMargins(16, 14, 16, 14)
        c2_txt = QVBoxLayout()
        self.maint_title = QLabel(l10n.bi("非破坏性缓存维护", "Non-Destructive Cache Maintenance"))
        self.maint_title.setObjectName("SectionTitle")
        self.maint_sub = QLabel(l10n.bi("释放浏览器与会话孤儿缓存，先固化 Token 账本并移入可恢复隔离区。", "Safely reclaim cache while preserving usage ledger and rollback snapshots."))
        self.maint_sub.setObjectName("Secondary")
        self.maint_sub.setWordWrap(True)
        c2_txt.addWidget(self.maint_title)
        c2_txt.addWidget(self.maint_sub)
        c2_lay.addLayout(c2_txt, 1)
        self.btn_maint = QPushButton(l10n.bi("打开维护工具…", "Open Maintenance…"))
        self.btn_maint.setObjectName("PrimaryBtn")
        self.btn_maint.clicked.connect(self._open_maintenance)
        c2_lay.addWidget(self.btn_maint)
        lay.addWidget(c2)

        # Card 3: Paths & Diagnostics
        c3 = Card()
        c3_lay = QVBoxLayout(c3)
        c3_lay.setContentsMargins(16, 14, 16, 14)
        c3_lay.setSpacing(8)
        self.diag_title = QLabel(l10n.bi("运行环境与诊断", "Runtime & Diagnostics"))
        self.diag_title.setObjectName("SectionTitle")
        c3_lay.addWidget(self.diag_title)

        install = find_antigravity_install()
        info_lines = [
            f"Antigravity: {install if install else 'Not detected'}",
            f"State Dir: {bridge.state_dir}",
            f"Cache Dir: {default_cache_dir()}",
            f"Log Dir: {default_log_dir()}",
        ]
        self.paths_lbl = QLabel("\n".join(info_lines))
        self.paths_lbl.setObjectName("Secondary")
        self.paths_lbl.setTextInteractionFlags(Qt.TextSelectableByMouse)
        c3_lay.addWidget(self.paths_lbl)

        btn_row = QHBoxLayout()
        self.btn_open_state = QPushButton(l10n.bi("打开数据目录", "Open Data Folder"))
        self.btn_open_state.clicked.connect(lambda: open_path_or_url(str(bridge.state_dir)))
        self.btn_view_log = QPushButton(l10n.bi("查看后端日志", "View Backend Log"))
        self.btn_view_log.clicked.connect(self._view_log)
        self.btn_restart = QPushButton(l10n.bi("重启后端服务", "Restart Backend"))
        self.btn_restart.clicked.connect(self._restart_backend)
        btn_row.addWidget(self.btn_open_state)
        btn_row.addWidget(self.btn_view_log)
        btn_row.addWidget(self.btn_restart)
        btn_row.addStretch(1)
        c3_lay.addLayout(btn_row)
        lay.addWidget(c3)

        lay.addStretch(1)

    def retranslate(self) -> None:
        self.title_lbl.setText(self.l10n.bi("设置", "Settings"))
        self.lang_lbl.setText(self.l10n.bi("界面语言（应用 + 后端 + HUD 联动）", "Language (App + Backend + HUD)"))
        self.chk_i18n.setText(self.l10n.bi("启用 Antigravity 零侵入中文热适配", "Enable non-invasive Antigravity Chinese localization"))
        self.chk_hud.setText(self.l10n.bi("启用输入框实时会话遥测 HUD", "Enable in-IDE real-time telemetry HUD"))
        self.chk_autostart.setText(self.l10n.bi("Ubuntu 登录时自动在托盘启动 GravityBox", "Launch GravityBox in system tray at login"))
        self.maint_title.setText(self.l10n.bi("非破坏性缓存维护", "Non-Destructive Cache Maintenance"))
        self.btn_maint.setText(self.l10n.bi("打开维护工具…", "Open Maintenance…"))
        self.diag_title.setText(self.l10n.bi("运行环境与诊断", "Runtime & Diagnostics"))
        self.btn_open_state.setText(self.l10n.bi("打开数据目录", "Open Data Folder"))
        self.btn_view_log.setText(self.l10n.bi("查看后端日志", "View Backend Log"))
        self.btn_restart.setText(self.l10n.bi("重启后端服务", "Restart Backend"))

    def sync_status(self, st: dict[str, Any]) -> None:
        self.chk_i18n.blockSignals(True)
        self.chk_i18n.setChecked(bool(st.get("translationEnabled", True)))
        self.chk_i18n.blockSignals(False)
        self.chk_hud.blockSignals(True)
        self.chk_hud.setChecked(bool(st.get("hudEnabled", True)))
        self.chk_hud.blockSignals(False)

    def _on_lang_changed(self) -> None:
        pref = str(self.combo_lang.currentData() or "system")
        self.on_locale_changed(pref)

    def _on_toggle_i18n(self, checked: bool) -> None:
        self.bridge.call_async({"command": "resume" if checked else "pause"}, lambda *_: self.on_refresh_all())

    def _on_toggle_hud(self, checked: bool) -> None:
        self.bridge.call_async({"command": "hud_set", "enabled": checked}, lambda *_: self.on_refresh_all())

    def _open_maintenance(self) -> None:
        dlg = MaintenanceDialog(self.bridge, self.l10n, self.theme, self)
        dlg.exec_()

    def _view_log(self) -> None:
        log_path = default_log_dir() / "backend.log"
        content = ""
        try:
            content = log_path.read_text("utf-8", errors="replace")[-30000:]
        except Exception as exc:
            content = str(exc)
        dlg = QWidget()
        dlg.setWindowTitle(str(log_path))
        dlg.resize(760, 480)
        lay = QVBoxLayout(dlg)
        edit = QPlainTextEdit()
        edit.setReadOnly(True)
        edit.setPlainText(content or "(empty)")
        lay.addWidget(edit)
        self._log_window = dlg
        dlg.show()

    def _restart_backend(self) -> None:
        try:
            self.bridge.restart()
        except Exception as exc:
            QMessageBox.warning(self, "GravityBox", str(exc))


class AboutPage(QWidget):
    def __init__(
        self,
        resource_root: Path,
        l10n: L10n,
        theme: ThemeColors,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.resource_root = resource_root
        self.l10n = l10n
        self.theme = theme
        self.version = read_app_version(resource_root)
        self.build_info = read_build_info(resource_root)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        scroll, lay = _scroll_page()
        outer.addWidget(scroll)

        self.title_lbl = QLabel(l10n.bi("关于 GravityBox", "About GravityBox"))
        self.title_lbl.setObjectName("PageTitle")
        lay.addWidget(self.title_lbl)

        hero = Card()
        hl = QHBoxLayout(hero)
        hl.setContentsMargins(18, 16, 18, 16)
        hl.setSpacing(16)
        icon_path = resolve_app_icon_path(resource_root)
        if icon_path:
            pm = QPixmap(str(icon_path)).scaled(64, 64, Qt.KeepAspectRatio, Qt.SmoothTransformation)
            il = QLabel()
            il.setPixmap(pm)
            hl.addWidget(il)
        col = QVBoxLayout()
        t = QLabel(f"GravityBox v{self.version}")
        t.setStyleSheet("font-size: 18px; font-weight: 700;")
        sub = QLabel(
            l10n.bi(
                f"Ubuntu / Linux 桌面伴侣 ({platform.machine()}) · 纯本地 · 开源 MIT 协议",
                f"Ubuntu / Linux Desktop Companion ({platform.machine()}) · Local-First · MIT License",
            )
        )
        sub.setObjectName("Secondary")
        col.addWidget(t)
        col.addWidget(sub)
        if self.build_info.get("node"):
            bi = QLabel(f"Bundled Node {self.build_info.get('node')} · Build {self.build_info.get('revision', '')}")
            bi.setObjectName("Secondary")
            col.addWidget(bi)
        hl.addLayout(col, 1)
        lay.addWidget(hero)

        # Privacy card
        priv = Card()
        pl = QVBoxLayout(priv)
        pl.setContentsMargins(16, 14, 16, 14)
        pl.setSpacing(6)
        self.priv_title = QLabel(l10n.bi("隐私与安全红线", "Privacy & Security Commitments"))
        self.priv_title.setObjectName("SectionTitle")
        self.priv_body = QLabel(
            l10n.bi(
                "• 零遥测、零云端中转，所有账号凭据以 0600 权限仅存本机并通过系统 Secret Service 钥匙串同步。\n"
                "• 零侵入式热适配：基于本机回环 CDP 调试接口与 Isolated World 运行，绝不修改官方应用包。\n"
                "• 数据零硬删除：账号切换采用四阶段原子事务与可撤销快照，缓存维护采用可恢复隔离区。",
                "• Zero telemetry or proxy servers. Credentials stay local with 0600 permissions and Linux Secret Service.\n"
                "• Non-invasive hot injection over loopback CDP Isolated World; official binaries are never modified.\n"
                "• Non-destructive safety: 4-phase atomic account switching with rollback and reversible cache vault.",
            )
        )
        self.priv_body.setObjectName("Secondary")
        self.priv_body.setWordWrap(True)
        pl.addWidget(self.priv_title)
        pl.addWidget(self.priv_body)
        lay.addWidget(priv)

        # Links & Update check
        actions = QHBoxLayout()
        self.btn_update = QPushButton(l10n.bi("检查更新", "Check for Updates"))
        self.btn_update.setObjectName("PrimaryBtn")
        self.btn_update.clicked.connect(self._check_update)
        self.btn_github = QPushButton("GitHub")
        self.btn_github.clicked.connect(lambda: open_path_or_url("https://github.com/Enzoo404/gravitybox"))
        self.btn_license = QPushButton(l10n.bi("开源许可", "License"))
        self.btn_license.clicked.connect(self._open_license)
        actions.addWidget(self.btn_update)
        actions.addWidget(self.btn_github)
        actions.addWidget(self.btn_license)
        actions.addStretch(1)
        lay.addLayout(actions)

        self.update_lbl = QLabel("")
        self.update_lbl.setObjectName("Secondary")
        self.update_lbl.setWordWrap(True)
        lay.addWidget(self.update_lbl)
        lay.addStretch(1)

    def retranslate(self) -> None:
        self.title_lbl.setText(self.l10n.bi("关于 GravityBox", "About GravityBox"))
        self.priv_title.setText(self.l10n.bi("隐私与安全红线", "Privacy & Security Commitments"))
        self.btn_update.setText(self.l10n.bi("检查更新", "Check for Updates"))
        self.btn_license.setText(self.l10n.bi("开源许可", "License"))

    def _check_update(self) -> None:
        self.update_lbl.setText(self.l10n.bi("正在检查 GitHub Releases…", "Checking GitHub Releases…"))
        try:
            req = urllib.request.Request(
                "https://api.github.com/repos/Enzoo404/gravitybox/releases/latest",
                headers={"User-Agent": f"GravityBox-Linux/{self.version}"},
            )
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            tag = str(data.get("tag_name") or "").lstrip("v")
            if tag and tag != self.version:
                self.update_lbl.setText(
                    self.l10n.bi(
                        f"发现新版本 v{tag}（当前 v{self.version}），请前往 GitHub Releases 下载。",
                        f"New release v{tag} available (current v{self.version}). Visit GitHub Releases.",
                    )
                )
            else:
                self.update_lbl.setText(self.l10n.bi(f"当前已是最新版本 v{self.version}。", f"You are up to date (v{self.version})."))
        except Exception as exc:
            self.update_lbl.setText(self.l10n.bi(f"检查更新失败：{exc}", f"Update check failed: {exc}"))

    def _open_license(self) -> None:
        for name in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
            p = self.resource_root / name
            if p.is_file():
                open_path_or_url(str(p))
                return
