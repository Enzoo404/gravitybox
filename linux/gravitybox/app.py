from __future__ import annotations

import argparse
import os
import signal
import socket
import sys
import threading
from pathlib import Path
from typing import Any

from PyQt5.QtCore import Qt, QTimer, pyqtSignal
from PyQt5.QtGui import QIcon, QPixmap
from PyQt5.QtWidgets import (
    QAction,
    QApplication,
    QFrame,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMenu,
    QPushButton,
    QStackedWidget,
    QSystemTrayIcon,
    QVBoxLayout,
    QWidget,
)

from .antigravity_ctl import safe_relaunch_antigravity
from .backend import BackendBridge
from .l10n import L10n
from .pages import AboutPage, AccountsPage, OverviewPage, SettingsPage, UsagePage
from .paths import (
    default_state_dir,
    read_app_version,
    resolve_app_icon_path,
    resolve_icons_dir,
    resolve_resource_root,
)
from .theme import DARK, LIGHT, build_stylesheet, detect_dark_mode
from .widgets import ModelIconProvider, PillBadge


class MainWindow(QMainWindow):
    raise_requested = pyqtSignal()

    def __init__(
        self,
        resource_root: Path,
        state_dir: Path,
        locale_pref: str = "system",
        start_minimized: bool = False,
    ) -> None:
        super().__init__()
        self.resource_root = resource_root
        self.state_dir = state_dir
        self.l10n = L10n(resource_root, locale_pref)
        self.theme = DARK if detect_dark_mode(QApplication.instance()) else LIGHT
        self.icons = ModelIconProvider(resource_root)
        self.bridge = BackendBridge(resource_root, state_dir, preferred_locale=locale_pref)
        self._quitting = False
        self._last_status: dict[str, Any] = {}

        self.setWindowTitle(f"GravityBox {read_app_version(resource_root)}")
        self.resize(1040, 720)
        self.setMinimumSize(860, 580)

        app_icon_path = resolve_app_icon_path(resource_root)
        if app_icon_path:
            self._app_icon = QIcon(str(app_icon_path))
            self.setWindowIcon(self._app_icon)
        else:
            self._app_icon = QIcon()

        # Root layout: Sidebar + Stacked Pages
        central = QWidget()
        self.setCentralWidget(central)
        root_lay = QHBoxLayout(central)
        root_lay.setContentsMargins(0, 0, 0, 0)
        root_lay.setSpacing(0)

        # Sidebar
        sidebar = QFrame()
        sidebar.setObjectName("Sidebar")
        sidebar.setFixedWidth(210)
        sb_lay = QVBoxLayout(sidebar)
        sb_lay.setContentsMargins(12, 16, 12, 14)
        sb_lay.setSpacing(6)

        brand = QHBoxLayout()
        brand.setSpacing(9)
        if app_icon_path:
            logo = QLabel()
            logo.setPixmap(QPixmap(str(app_icon_path)).scaled(28, 28, Qt.KeepAspectRatio, Qt.SmoothTransformation))
            brand.addWidget(logo)
        brand_txt = QLabel("GravityBox")
        brand_txt.setStyleSheet("font-size: 15.5px; font-weight: 700;")
        brand.addWidget(brand_txt, 1)
        sb_lay.addLayout(brand)
        sb_lay.addSpacing(10)

        self.nav_buttons: list[tuple[str, QPushButton]] = []
        nav_specs = [
            ("overview", "总览", "Overview"),
            ("accounts", "账号", "Accounts"),
            ("usage", "用量", "Usage"),
            ("settings", "设置", "Settings"),
            ("about", "关于", "About"),
        ]
        for idx, (key, zh, en) in enumerate(nav_specs):
            btn = QPushButton(self.l10n.bi(zh, en))
            btn.setObjectName("NavBtn")
            btn.setCursor(Qt.PointingHandCursor)
            btn.clicked.connect(lambda _c=False, i=idx: self.select_page(i))
            sb_lay.addWidget(btn)
            self.nav_buttons.append((key, btn))

        sb_lay.addStretch(1)
        self.sidebar_status = PillBadge(self.l10n.bi("启动中…", "Starting…"), "neutral", self.theme)
        sb_lay.addWidget(self.sidebar_status)
        root_lay.addWidget(sidebar)

        # Pages
        self.stack = QStackedWidget()
        self.overview_page = OverviewPage(self.bridge, self.l10n, self.theme, self.icons, self.refresh_all)
        self.accounts_page = AccountsPage(self.bridge, self.l10n, self.theme, self.refresh_all)
        self.usage_page = UsagePage(self.bridge, self.l10n, self.theme, self.icons)
        self.settings_page = SettingsPage(self.bridge, self.l10n, self.theme, self.change_locale, self.refresh_all)
        self.about_page = AboutPage(resource_root, self.l10n, self.theme)
        for p in (self.overview_page, self.accounts_page, self.usage_page, self.settings_page, self.about_page):
            self.stack.addWidget(p)
        root_lay.addWidget(self.stack, 1)

        self.select_page(0)
        self._setup_tray()
        self.raise_requested.connect(self.bring_to_front)

        # Backend lifecycle
        self.bridge.backend_ready.connect(self._on_backend_ready)
        self.bridge.backend_exited.connect(self._on_backend_exited)
        try:
            self.bridge.start()
        except Exception as exc:
            self.sidebar_status.setText(str(exc)[:30])
            self.sidebar_status.apply_tone("red", self.theme)

        self._poll_timer = QTimer(self)
        self._poll_timer.setInterval(5000)
        self._poll_timer.timeout.connect(self._poll_status)
        self._poll_timer.start()

        if not start_minimized:
            self.show()

    def _setup_tray(self) -> None:
        self.tray: QSystemTrayIcon | None = None
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return
        tray_icon_file = resolve_icons_dir(self.resource_root) / "menu-connected.png"
        icon = QIcon(str(tray_icon_file)) if tray_icon_file.is_file() else self._app_icon
        tray = QSystemTrayIcon(icon, self)
        tray.setToolTip("GravityBox")
        menu = QMenu()
        self.act_tray_status = QAction(self.l10n.bi("状态：连接中…", "Status: Connecting…"), menu)
        self.act_tray_status.setEnabled(False)
        self.act_tray_open = QAction(self.l10n.bi("打开 GravityBox 控制台", "Open GravityBox Console"), menu)
        self.act_tray_open.triggered.connect(self.bring_to_front)
        self.act_tray_refresh = QAction(self.l10n.bi("刷新配额", "Refresh Quota"), menu)
        self.act_tray_refresh.triggered.connect(lambda: self.bridge.call_async({"command": "quota_refresh"}, lambda *_: self.refresh_all()))
        self.act_tray_toggle_i18n = QAction(self.l10n.bi("暂停/恢复汉化", "Pause / Resume Localization"), menu)
        self.act_tray_toggle_i18n.triggered.connect(self._tray_toggle_i18n)
        self.act_tray_relaunch = QAction(self.l10n.bi("安全重启 Antigravity", "Safe Relaunch Antigravity"), menu)
        self.act_tray_relaunch.triggered.connect(lambda: safe_relaunch_antigravity())
        self.act_tray_quit = QAction(self.l10n.bi("退出 GravityBox", "Quit GravityBox"), menu)
        self.act_tray_quit.triggered.connect(self.quit_app)

        menu.addAction(self.act_tray_status)
        menu.addSeparator()
        menu.addAction(self.act_tray_open)
        menu.addAction(self.act_tray_refresh)
        menu.addAction(self.act_tray_toggle_i18n)
        menu.addAction(self.act_tray_relaunch)
        menu.addSeparator()
        menu.addAction(self.act_tray_quit)
        tray.setContextMenu(menu)
        tray.activated.connect(self._on_tray_activated)
        tray.show()
        self.tray = tray

    def _on_tray_activated(self, reason: QSystemTrayIcon.ActivationReason) -> None:
        if reason in (QSystemTrayIcon.Trigger, QSystemTrayIcon.DoubleClick):
            self.bring_to_front()

    def _tray_toggle_i18n(self) -> None:
        enabled = bool(self._last_status.get("translationEnabled", True))
        self.bridge.call_async({"command": "pause" if enabled else "resume"}, lambda *_: self.refresh_all())

    def bring_to_front(self) -> None:
        self.show()
        self.setWindowState((self.windowState() & ~Qt.WindowMinimized) | Qt.WindowActive)
        self.raise_()
        self.activateWindow()

    def select_page(self, idx: int) -> None:
        self.stack.setCurrentIndex(idx)
        for i, (_key, btn) in enumerate(self.nav_buttons):
            btn.setProperty("active", "true" if i == idx else "false")
            btn.style().unpolish(btn)
            btn.style().polish(btn)
        if idx == 0:
            self._load_dashboard()
        elif idx == 1:
            self.accounts_page.reload()
        elif idx == 2:
            self.usage_page.reload(force=False)

    def _on_backend_ready(self) -> None:
        self.sidebar_status.setText(self.l10n.bi("后端就绪", "Backend Ready"))
        self.sidebar_status.apply_tone("green", self.theme)
        self.refresh_all()

    def _on_backend_exited(self, reason: str) -> None:
        self.sidebar_status.setText(self.l10n.bi("后端已停止", "Backend Stopped"))
        self.sidebar_status.apply_tone("red", self.theme)
        if self.tray:
            self.act_tray_status.setText(f"Stopped ({reason})")

    def _poll_status(self) -> None:
        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            if err or not res or not res.get("ok"):
                return
            st = res.get("status") or {}
            self._last_status = st
            self.overview_page.update_status(st)
            self.settings_page.sync_status(st)
            self.accounts_page.set_oauth_configured(bool(st.get("oauthClientConfigured")))
            mode = str(st.get("mode") or "")
            if mode == "connected":
                self.sidebar_status.setText(self.l10n.bi("已连接 IDE", "IDE Connected"))
                self.sidebar_status.apply_tone("green", self.theme)
            elif mode == "paused":
                self.sidebar_status.setText(self.l10n.bi("已暂停", "Paused"))
                self.sidebar_status.apply_tone("amber", self.theme)
            else:
                self.sidebar_status.setText(self.l10n.bi("等待 IDE", "Waiting IDE"))
                self.sidebar_status.apply_tone("neutral", self.theme)

            if self.tray:
                acct = str(st.get("activeAccountEmail") or "")
                q5 = st.get("activeFiveHourQuota")
                q_str = f" · {int(round(q5))}%" if isinstance(q5, (int, float)) else ""
                summary = f"{acct}{q_str}" if acct else self.sidebar_status.text()
                self.act_tray_status.setText(summary)
                self.tray.setToolTip(f"GravityBox — {summary}")

        self.bridge.call_async({"command": "status", "includeTasks": False}, _done, timeout=8.0)

    def _load_dashboard(self) -> None:
        def _done(res: dict[str, Any] | None, _err: Exception | None) -> None:
            if res and res.get("ok"):
                self.overview_page.update_dashboard(res)

        self.bridge.call_async({"command": "dashboard_summary"}, _done, timeout=20.0)

    def refresh_all(self) -> None:
        self._poll_status()
        self._load_dashboard()
        idx = self.stack.currentIndex()
        if idx == 1:
            self.accounts_page.reload()
        elif idx == 2:
            self.usage_page.reload(force=False)

    def change_locale(self, pref: str) -> None:
        self.l10n.set_preference(pref)
        self.bridge.preferred_locale = pref
        self._retranslate_all()
        self.bridge.call_async({"command": "language_set", "language": pref}, lambda *_: self.refresh_all())

    def _retranslate_all(self) -> None:
        labels = [
            self.l10n.bi("总览", "Overview"),
            self.l10n.bi("账号", "Accounts"),
            self.l10n.bi("用量", "Usage"),
            self.l10n.bi("设置", "Settings"),
            self.l10n.bi("关于", "About"),
        ]
        for (_, btn), lbl in zip(self.nav_buttons, labels):
            btn.setText(lbl)
        self.overview_page.retranslate()
        self.accounts_page.retranslate()
        self.usage_page.retranslate()
        self.settings_page.retranslate()
        self.about_page.retranslate()
        if self.tray:
            self.act_tray_open.setText(self.l10n.bi("打开 GravityBox 控制台", "Open GravityBox Console"))
            self.act_tray_refresh.setText(self.l10n.bi("刷新配额", "Refresh Quota"))
            self.act_tray_toggle_i18n.setText(self.l10n.bi("暂停/恢复汉化", "Pause / Resume Localization"))
            self.act_tray_relaunch.setText(self.l10n.bi("安全重启 Antigravity", "Safe Relaunch Antigravity"))
            self.act_tray_quit.setText(self.l10n.bi("退出 GravityBox", "Quit GravityBox"))

    def closeEvent(self, event: Any) -> None:
        if not self._quitting and self.tray is not None and self.tray.isVisible():
            event.ignore()
            self.hide()
            return
        self._poll_timer.stop()
        self.bridge.shutdown()
        super().closeEvent(event)

    def quit_app(self) -> None:
        self._quitting = True
        if self.tray:
            self.tray.hide()
        self._poll_timer.stop()
        self.bridge.shutdown()
        QApplication.quit()


def _try_activate_existing(sock_path: Path) -> bool:
    if not sock_path.exists():
        return False
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(0.8)
    try:
        s.connect(str(sock_path))
        s.sendall(b"RAISE\n")
        return True
    except OSError:
        try:
            sock_path.unlink(missing_ok=True)
        except OSError:
            pass
        return False
    finally:
        s.close()


def _start_instance_listener(sock_path: Path, on_raise: Any) -> socket.socket | None:
    try:
        sock_path.parent.mkdir(parents=True, exist_ok=True)
        sock_path.unlink(missing_ok=True)
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(str(sock_path))
        os.chmod(sock_path, 0o600)
        srv.listen(4)

        def _loop() -> None:
            while True:
                try:
                    conn, _ = srv.accept()
                    try:
                        data = conn.recv(64)
                        if b"RAISE" in data:
                            on_raise()
                    finally:
                        conn.close()
                except OSError:
                    break

        threading.Thread(target=_loop, daemon=True).start()
        return srv
    except OSError:
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gravitybox", description="GravityBox Desktop Companion for Ubuntu/Linux")
    parser.add_argument("--state-dir", default=str(default_state_dir()), help="State directory path")
    parser.add_argument("--locale", default="system", help="UI locale (system | zh-Hans | en)")
    parser.add_argument("--minimized", action="store_true", help="Start minimized in system tray")
    parser.add_argument("--version", action="store_true", help="Print GravityBox version and exit")
    parser.add_argument("--check", action="store_true", help="Verify runtime environment and exit")
    args = parser.parse_args(argv)

    resource_root = resolve_resource_root()
    if args.version:
        print(f"GravityBox {read_app_version(resource_root)} (linux)")
        return 0
    if args.check:
        from .paths import resolve_backend_entry, resolve_node_binary
        node = resolve_node_binary(resource_root)
        entry = resolve_backend_entry(resource_root)
        ok = bool(node and node.is_file() and entry.is_file())
        print(f"resource_root={resource_root} node={node} backend={entry} ok={ok}")
        return 0 if ok else 1

    state_dir = Path(args.state_dir).expanduser().resolve()
    instance_sock = state_dir / "ui-instance.sock"
    if _try_activate_existing(instance_sock):
        return 0

    QApplication.setAttribute(Qt.AA_EnableHighDpiScaling, True)
    QApplication.setAttribute(Qt.AA_UseHighDpiPixmaps, True)
    app = QApplication(sys.argv[:1])
    app.setApplicationName("GravityBox")
    app.setQuitOnLastWindowClosed(False)

    theme = DARK if detect_dark_mode(app) else LIGHT
    app.setStyleSheet(build_stylesheet(theme))

    win = MainWindow(resource_root, state_dir, locale_pref=args.locale, start_minimized=args.minimized)
    srv = _start_instance_listener(instance_sock, win.raise_requested.emit)

    signal.signal(signal.SIGINT, lambda *_: win.quit_app())
    signal.signal(signal.SIGTERM, lambda *_: win.quit_app())
    sig_timer = QTimer()
    sig_timer.start(250)
    sig_timer.timeout.connect(lambda: None)

    code = app.exec_()
    if srv is not None:
        try:
            srv.close()
        except OSError:
            pass
    instance_sock.unlink(missing_ok=True)
    return code
