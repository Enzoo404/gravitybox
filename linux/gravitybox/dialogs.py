from __future__ import annotations

import os
from datetime import datetime
from typing import Any

from PyQt5.QtCore import Qt, QTimer
from PyQt5.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from .antigravity_ctl import open_path_or_url
from .backend import BackendBridge
from .l10n import L10n
from .theme import ThemeColors
from .widgets import Card, PillBadge, format_bytes


class ManageAccountsDialog(QDialog):
    """v1.1.3 three-card account management panel: Save Current + Batch JSON Import + 0600 Backup Export + OAuth/Token."""

    def __init__(
        self,
        bridge: BackendBridge,
        l10n: L10n,
        theme: ThemeColors,
        oauth_configured: bool = False,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.bridge = bridge
        self.l10n = l10n
        self.theme = theme
        self._oauth_session_id: str | None = None
        self._oauth_timer = QTimer(self)
        self._oauth_timer.setInterval(1200)
        self._oauth_timer.timeout.connect(self._poll_oauth)
        self.changed = False

        self.setWindowTitle(l10n.bi("管理账号", "Manage Accounts"))
        self.setMinimumWidth(560)

        root = QVBoxLayout(self)
        root.setContentsMargins(18, 16, 18, 16)
        root.setSpacing(12)

        # Card 1: Save current account
        c1 = Card()
        c1_lay = QHBoxLayout(c1)
        c1_lay.setContentsMargins(14, 12, 14, 12)
        c1_text = QVBoxLayout()
        t1 = QLabel(l10n.bi("保存当前登录账号", "Save Current Active Account"))
        t1.setObjectName("SectionTitle")
        s1 = QLabel(l10n.bi("读取当前 Antigravity 活跃登录凭据并安全入库（0600 私有权限）。", "Read current Antigravity login credentials into local 0600 vault."))
        s1.setObjectName("Secondary")
        s1.setWordWrap(True)
        c1_text.addWidget(t1)
        c1_text.addWidget(s1)
        c1_lay.addLayout(c1_text, 1)
        self.btn_save_current = QPushButton(l10n.bi("立即保存", "Save Now"))
        self.btn_save_current.setObjectName("PrimaryBtn")
        self.btn_save_current.clicked.connect(self._on_save_current)
        c1_lay.addWidget(self.btn_save_current)
        root.addWidget(c1)

        # Card 2: Batch JSON import
        c2 = Card()
        c2_lay = QVBoxLayout(c2)
        c2_lay.setContentsMargins(14, 12, 14, 12)
        c2_lay.setSpacing(8)
        t2 = QLabel(l10n.bi("从 JSON 批量导入账号", "Batch Import Accounts from JSON"))
        t2.setObjectName("SectionTitle")
        s2 = QLabel(l10n.bi("支持单文件、多文件或整个目录导入，按邮箱自动去重与合并。", "Supports single file, multiple files, or a directory with email deduplication."))
        s2.setObjectName("Secondary")
        s2.setWordWrap(True)
        c2_lay.addWidget(t2)
        c2_lay.addWidget(s2)
        row2 = QHBoxLayout()
        self.btn_import_files = QPushButton(l10n.bi("选择 JSON 文件…", "Select JSON File(s)…"))
        self.btn_import_files.clicked.connect(self._on_import_files)
        self.btn_import_dir = QPushButton(l10n.bi("选择目录…", "Select Directory…"))
        self.btn_import_dir.clicked.connect(self._on_import_dir)
        row2.addWidget(self.btn_import_files)
        row2.addWidget(self.btn_import_dir)
        row2.addStretch(1)
        c2_lay.addLayout(row2)
        root.addWidget(c2)

        # Card 3: 0600 Backup export
        c3 = Card()
        c3_lay = QHBoxLayout(c3)
        c3_lay.setContentsMargins(14, 12, 14, 12)
        c3_text = QVBoxLayout()
        t3 = QLabel(l10n.bi("导出 0600 账号备份", "Export 0600 Account Backup"))
        t3.setObjectName("SectionTitle")
        s3 = QLabel(l10n.bi("经二次确认后由后端以 0600 权限原子落盘，凭据不经界面层暴露。", "Atomically written by backend with 0600 permissions after confirmation."))
        s3.setObjectName("Secondary")
        s3.setWordWrap(True)
        c3_text.addWidget(t3)
        c3_text.addWidget(s3)
        c3_lay.addLayout(c3_text, 1)
        self.btn_export = QPushButton(l10n.bi("导出备份…", "Export Backup…"))
        self.btn_export.clicked.connect(self._on_export_backup)
        c3_lay.addWidget(self.btn_export)
        root.addWidget(c3)

        # Card 4: OAuth / Manual refresh token
        c4 = Card()
        c4_lay = QVBoxLayout(c4)
        c4_lay.setContentsMargins(14, 12, 14, 12)
        c4_lay.setSpacing(8)
        t4 = QLabel(l10n.bi("添加新账号（Google 授权 / Refresh Token）", "Add Account (Google OAuth / Refresh Token)"))
        t4.setObjectName("SectionTitle")
        c4_lay.addWidget(t4)
        tok_row = QHBoxLayout()
        self.token_input = QLineEdit()
        self.token_input.setEchoMode(QLineEdit.Password)
        self.token_input.setPlaceholderText(l10n.bi("粘贴 Refresh Token (1//...)", "Paste Refresh Token (1//...)"))
        self.btn_add_token = QPushButton(l10n.bi("添加凭据", "Add Token"))
        self.btn_add_token.clicked.connect(self._on_add_token)
        tok_row.addWidget(self.token_input, 1)
        tok_row.addWidget(self.btn_add_token)
        c4_lay.addLayout(tok_row)

        oauth_row = QHBoxLayout()
        self.btn_oauth = QPushButton(l10n.bi("通过浏览器 Google 登录", "Sign in with Google"))
        self.btn_oauth.setEnabled(oauth_configured)
        self.btn_oauth.clicked.connect(self._on_start_oauth)
        oauth_hint = QLabel(
            l10n.bi("已配置 OAuth 客户端", "OAuth client configured")
            if oauth_configured
            else l10n.bi("未配置自建 OAuth 客户端（可选，在数据目录 .env 中配置）", "Optional: configure custom OAuth client in state-dir .env")
        )
        oauth_hint.setObjectName("Secondary")
        oauth_hint.setWordWrap(True)
        oauth_row.addWidget(self.btn_oauth)
        oauth_row.addWidget(oauth_hint, 1)
        c4_lay.addLayout(oauth_row)
        root.addWidget(c4)

        self.status_label = QLabel("")
        self.status_label.setObjectName("Secondary")
        self.status_label.setWordWrap(True)
        root.addWidget(self.status_label)

        footer = QHBoxLayout()
        footer.addStretch(1)
        btn_close = QPushButton(l10n.bi("完成", "Done"))
        btn_close.clicked.connect(self.accept)
        footer.addWidget(btn_close)
        root.addLayout(footer)

    def _set_busy(self, busy: bool, msg: str = "") -> None:
        for b in (self.btn_save_current, self.btn_import_files, self.btn_import_dir, self.btn_export, self.btn_add_token):
            b.setEnabled(not busy)
        if msg:
            self.status_label.setText(msg)

    def _on_save_current(self) -> None:
        self._set_busy(True, self.l10n.bi("正在读取当前 Antigravity 登录账号…", "Saving current account…"))

        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            self._set_busy(False)
            if err or not res or not res.get("ok"):
                msg = str(err) if err else str((res or {}).get("error") or "Failed")
                self.status_label.setText(msg)
                return
            email = (res.get("account") or {}).get("email", "")
            self.changed = True
            self.status_label.setText(self.l10n.bi(f"已保存当前账号：{email}", f"Saved current account: {email}"))

        self.bridge.call_async({"command": "account_save_current"}, _done, timeout=20.0)

    def _run_import(self, paths: list[str]) -> None:
        if not paths:
            return
        self._set_busy(True, self.l10n.bi("正在导入账号 JSON…", "Importing JSON accounts…"))

        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            self._set_busy(False)
            if err or not res or not res.get("ok"):
                msg = str(err) if err else str((res or {}).get("error") or "Import failed")
                self.status_label.setText(msg)
                return
            self.changed = True
            imp = res.get("imported", 0)
            upd = res.get("updated", 0)
            skip = res.get("skipped", 0)
            self.status_label.setText(
                self.l10n.bi(
                    f"导入完成：新增 {imp}，更新 {upd}，跳过 {skip}",
                    f"Import complete: {imp} imported, {upd} updated, {skip} skipped",
                )
            )

        self.bridge.call_async({"command": "account_import_json", "paths": paths}, _done, timeout=30.0)

    def _on_import_files(self) -> None:
        files, _ = QFileDialog.getOpenFileNames(
            self,
            self.l10n.bi("选择账号 JSON 文件", "Select Account JSON Files"),
            os.path.expanduser("~"),
            "JSON Files (*.json);;All Files (*)",
        )
        self._run_import(files)

    def _on_import_dir(self) -> None:
        directory = QFileDialog.getExistingDirectory(
            self,
            self.l10n.bi("选择包含账号 JSON 的目录", "Select Directory with JSON Accounts"),
            os.path.expanduser("~"),
        )
        if directory:
            self._run_import([directory])

    def _on_export_backup(self) -> None:
        default_name = f"gravitybox-accounts-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
        dest, _ = QFileDialog.getSaveFileName(
            self,
            self.l10n.bi("导出账号备份（0600 权限）", "Export Account Backup (0600)"),
            os.path.join(os.path.expanduser("~"), default_name),
            "JSON Files (*.json)",
        )
        if not dest:
            return
        confirm = QMessageBox.question(
            self,
            self.l10n.bi("确认导出敏感备份", "Confirm Sensitive Backup Export"),
            self.l10n.bi(
                f"导出的备份文件包含账号凭据，将以 0600 仅当前用户可读权限写入：\n{dest}\n\n确认继续？",
                f"The backup contains account credentials and will be written with 0600 permissions to:\n{dest}\n\nContinue?",
            ),
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if confirm != QMessageBox.Yes:
            return
        self._set_busy(True, self.l10n.bi("正在安全写入备份文件…", "Exporting backup…"))

        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            self._set_busy(False)
            if err or not res or not res.get("ok"):
                msg = str(err) if err else str((res or {}).get("error") or "Export failed")
                self.status_label.setText(msg)
                return
            self.status_label.setText(
                self.l10n.bi(
                    f"已安全导出 {res.get('count', 0)} 个账号至 {res.get('path', dest)} (0600)",
                    f"Exported {res.get('count', 0)} accounts to {res.get('path', dest)} (0600)",
                )
            )

        self.bridge.call_async(
            {"command": "account_export_backup", "path": dest, "confirmed": True},
            _done,
            timeout=20.0,
        )

    def _on_add_token(self) -> None:
        token = self.token_input.text().strip()
        if not token:
            return
        self._set_busy(True, self.l10n.bi("正在验证并保存凭据…", "Validating and saving token…"))

        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            self._set_busy(False)
            if err or not res or not res.get("ok"):
                msg = str(err) if err else str((res or {}).get("error") or "Failed")
                self.status_label.setText(msg)
                return
            self.token_input.clear()
            self.changed = True
            self.status_label.setText(self.l10n.bi("已启动凭据验证任务，完成后自动刷新列表。", "Token verification task started."))

        self.bridge.call_async({"command": "account_add_token_start", "refreshToken": token}, _done)

    def _on_start_oauth(self) -> None:
        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            if err or not res or not res.get("ok"):
                self.status_label.setText(str(err or (res or {}).get("error") or "OAuth failed"))
                return
            self._oauth_session_id = str(res.get("id") or "")
            auth_url = str(res.get("authUrl") or res.get("url") or "")
            if auth_url:
                open_path_or_url(auth_url)
            self.status_label.setText(self.l10n.bi("请在浏览器中完成 Google 登录授权…", "Complete Google sign-in in your browser…"))
            self._oauth_timer.start()

        self.bridge.call_async({"command": "account_oauth_begin"}, _done)

    def _poll_oauth(self) -> None:
        if not self._oauth_session_id:
            self._oauth_timer.stop()
            return
        sid = self._oauth_session_id

        def _done(res: dict[str, Any] | None, _err: Exception | None) -> None:
            if not res:
                return
            state = str(res.get("state") or res.get("status") or "")
            if state in ("done", "completed", "success"):
                self._oauth_timer.stop()
                self.changed = True
                self.status_label.setText(self.l10n.bi("Google 授权登录成功！", "Google OAuth login succeeded!"))
            elif state in ("failed", "error", "cancelled"):
                self._oauth_timer.stop()
                self.status_label.setText(str(res.get("error") or state))

        self.bridge.call_async({"command": "account_oauth_status", "id": sid}, _done)

    def closeEvent(self, event: Any) -> None:
        self._oauth_timer.stop()
        if self._oauth_session_id:
            self.bridge.call_async({"command": "account_oauth_cancel", "id": self._oauth_session_id}, lambda *_: None)
        super().closeEvent(event)


class AutoSwitchPolicyDialog(QDialog):
    def __init__(self, bridge: BackendBridge, l10n: L10n, theme: ThemeColors, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.bridge = bridge
        self.l10n = l10n
        self.theme = theme
        self.setWindowTitle(l10n.bi("智能切号策略", "Auto-Switch Policy"))
        self.setMinimumWidth(480)

        lay = QVBoxLayout(self)
        lay.setContentsMargins(18, 16, 18, 16)
        lay.setSpacing(12)

        card = Card()
        form = QVBoxLayout(card)
        form.setContentsMargins(14, 14, 14, 14)
        form.setSpacing(10)

        self.chk_enabled = QCheckBox(l10n.bi("启用低额度智能推荐提醒", "Enable low-quota smart recommendation"))
        form.addWidget(self.chk_enabled)

        row_thresh = QHBoxLayout()
        row_thresh.addWidget(QLabel(l10n.bi("剩余额度触发阈值 (%)", "Remaining quota threshold (%)")))
        self.spin_threshold = QSpinBox()
        self.spin_threshold.setRange(5, 80)
        self.spin_threshold.setValue(20)
        row_thresh.addStretch(1)
        row_thresh.addWidget(self.spin_threshold)
        form.addLayout(row_thresh)

        row_strat = QHBoxLayout()
        row_strat.addWidget(QLabel(l10n.bi("备选账号排序策略", "Candidate selection strategy")))
        self.combo_strategy = QComboBox()
        self.combo_strategy.addItem(l10n.bi("优先级最高优先", "Priority order"), "priority")
        self.combo_strategy.addItem(l10n.bi("均衡轮转 (Round-Robin)", "Balanced Round-Robin"), "round_robin")
        row_strat.addStretch(1)
        row_strat.addWidget(self.combo_strategy)
        form.addLayout(row_strat)
        lay.addWidget(card)

        self.preview_label = QLabel(l10n.bi("正在读取策略配置…", "Loading policy…"))
        self.preview_label.setObjectName("Secondary")
        self.preview_label.setWordWrap(True)
        lay.addWidget(self.preview_label)

        btns = QHBoxLayout()
        self.btn_preview = QPushButton(l10n.bi("评估推荐账号", "Evaluate Recommendation"))
        self.btn_preview.clicked.connect(self._on_preview)
        btns.addWidget(self.btn_preview)
        btns.addStretch(1)
        btn_cancel = QPushButton(l10n.bi("取消", "Cancel"))
        btn_cancel.clicked.connect(self.reject)
        self.btn_save = QPushButton(l10n.bi("保存策略", "Save Policy"))
        self.btn_save.setObjectName("PrimaryBtn")
        self.btn_save.clicked.connect(self._on_save)
        btns.addWidget(btn_cancel)
        btns.addWidget(self.btn_save)
        lay.addLayout(btns)

        self._load_config()

    def _current_cfg(self) -> dict[str, Any]:
        return {
            "enabled": self.chk_enabled.isChecked(),
            "reserve_percentage": self.spin_threshold.value(),
            "strategy": self.combo_strategy.currentData(),
        }

    def _load_config(self) -> None:
        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            if err or not res or not res.get("ok"):
                self.preview_label.setText(str(err or (res or {}).get("error") or ""))
                return
            cfg = res.get("config") or {}
            self.chk_enabled.setChecked(bool(cfg.get("enabled", False)))
            self.spin_threshold.setValue(int(cfg.get("reserve_percentage", cfg.get("threshold", 20))))
            strat = str(cfg.get("strategy", "priority"))
            idx = self.combo_strategy.findData(strat)
            if idx >= 0:
                self.combo_strategy.setCurrentIndex(idx)
            self.preview_label.setText(self.l10n.bi("已加载当前策略。", "Policy loaded."))

        self.bridge.call_async({"command": "auto_switch_get"}, _done)

    def _on_preview(self) -> None:
        self.preview_label.setText(self.l10n.bi("正在评估最佳候选账号…", "Evaluating best candidate…"))

        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            if err or not res or not res.get("ok"):
                self.preview_label.setText(str(err or (res or {}).get("error") or "Error"))
                return
            reason = str(res.get("reason") or res.get("message") or "")
            cand = res.get("bestCandidate") or {}
            if cand.get("email"):
                self.preview_label.setText(f"{reason}\n→ {cand.get('email')}")
            else:
                self.preview_label.setText(reason or self.l10n.bi("无需切换", "No switch needed"))

        self.bridge.call_async({"command": "auto_switch_best", "config": self._current_cfg()}, _done)

    def _on_save(self) -> None:
        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            if err or not res or not res.get("ok"):
                self.preview_label.setText(str(err or (res or {}).get("error") or "Save failed"))
                return
            self.accept()

        self.bridge.call_async({"command": "auto_switch_set", "config": self._current_cfg()}, _done)


class MaintenanceDialog(QDialog):
    """Non-destructive cache maintenance & displaced-storage snapshot recovery."""

    def __init__(self, bridge: BackendBridge, l10n: L10n, theme: ThemeColors, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.bridge = bridge
        self.l10n = l10n
        self.theme = theme
        self._scan_token: str | None = None
        self._checkboxes: dict[str, QCheckBox] = {}
        self.setWindowTitle(l10n.bi("非破坏性缓存维护", "Non-Destructive Cache Maintenance"))
        self.setMinimumSize(640, 500)

        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 16, 16, 16)
        lay.setSpacing(10)

        top = QHBoxLayout()
        top.addWidget(QLabel(l10n.bi("保留天数", "Retention days")))
        self.combo_days = QComboBox()
        for d in (7, 30, 0):
            self.combo_days.addItem(
                l10n.bi(f"{d} 天" if d > 0 else "全部可清理项", f"{d} days" if d > 0 else "All clearable"),
                d,
            )
        self.combo_days.currentIndexChanged.connect(self._scan)
        top.addWidget(self.combo_days)
        top.addStretch(1)
        self.btn_rescan = QPushButton(l10n.bi("重新扫描", "Rescan"))
        self.btn_rescan.clicked.connect(self._scan)
        top.addWidget(self.btn_rescan)
        lay.addLayout(top)

        self.tabs = QTabWidget()
        # Tab 1: Scan items
        scan_tab = QWidget()
        scan_lay = QVBoxLayout(scan_tab)
        self.scan_scroll = QScrollArea()
        self.scan_scroll.setWidgetResizable(True)
        self.scan_container = QWidget()
        self.scan_items_lay = QVBoxLayout(self.scan_container)
        self.scan_items_lay.setSpacing(6)
        self.scan_items_lay.addStretch(1)
        self.scan_scroll.setWidget(self.scan_container)
        scan_lay.addWidget(self.scan_scroll)
        self.tabs.addTab(scan_tab, l10n.bi("可清理缓存项", "Cache Categories"))

        # Tab 2: Snapshot history
        hist_tab = QWidget()
        hist_lay = QVBoxLayout(hist_tab)
        self.hist_scroll = QScrollArea()
        self.hist_scroll.setWidgetResizable(True)
        self.hist_container = QWidget()
        self.hist_items_lay = QVBoxLayout(self.hist_container)
        self.hist_items_lay.setSpacing(6)
        self.hist_items_lay.addStretch(1)
        self.hist_scroll.setWidget(self.hist_container)
        hist_lay.addWidget(self.hist_scroll)
        self.tabs.addTab(hist_tab, l10n.bi("可回滚快照历史", "Recovery Snapshots"))
        lay.addWidget(self.tabs, 1)

        self.status_label = QLabel(l10n.bi("正在扫描缓存目录…", "Scanning cache directories…"))
        self.status_label.setObjectName("Secondary")
        self.status_label.setWordWrap(True)
        lay.addWidget(self.status_label)

        footer = QHBoxLayout()
        self.btn_clear = QPushButton(l10n.bi("安全移入隔离区", "Move Selected to Safe Vault"))
        self.btn_clear.setObjectName("PrimaryBtn")
        self.btn_clear.clicked.connect(self._clear_selected)
        footer.addWidget(self.btn_clear)
        footer.addStretch(1)
        btn_close = QPushButton(l10n.bi("关闭", "Close"))
        btn_close.clicked.connect(self.accept)
        footer.addWidget(btn_close)
        lay.addLayout(footer)

        self._scan()
        self._load_history()

    def _clear_layout(self, layout: QVBoxLayout) -> None:
        while layout.count():
            item = layout.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()

    def _scan(self) -> None:
        self.btn_rescan.setEnabled(False)
        self.btn_clear.setEnabled(False)
        self.status_label.setText(self.l10n.bi("正在扫描…", "Scanning…"))
        days = self.combo_days.currentData()

        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            self.btn_rescan.setEnabled(True)
            if err or not res or not res.get("ok"):
                self.status_label.setText(str(err or (res or {}).get("error") or "Scan failed"))
                return
            self._scan_token = res.get("token")
            items = res.get("entries") or res.get("items") or []
            self._checkboxes.clear()
            self._clear_layout(self.scan_items_lay)
            total_bytes = 0
            for it in items:
                name = str(it.get("name") or "")
                title = str(it.get("title") or name)
                subtitle = str(it.get("subtitle") or "")
                b = int(it.get("bytes") or 0)
                clearable = bool(it.get("clearable", False))
                exists = bool(it.get("exists", False))
                if not exists and b == 0:
                    continue
                total_bytes += b
                row_card = Card("SubCard")
                rl = QHBoxLayout(row_card)
                rl.setContentsMargins(10, 8, 10, 8)
                chk = QCheckBox(f"{title}  ({format_bytes(b)})")
                chk.setChecked(clearable and bool(it.get("defaultSelected", False)) and b > 0)
                chk.setEnabled(clearable and b > 0)
                self._checkboxes[name] = chk
                col = QVBoxLayout()
                col.addWidget(chk)
                if subtitle:
                    sub_lbl = QLabel(subtitle)
                    sub_lbl.setObjectName("Secondary")
                    sub_lbl.setWordWrap(True)
                    col.addWidget(sub_lbl)
                rl.addLayout(col, 1)
                self.scan_items_lay.addWidget(row_card)
            self.scan_items_lay.addStretch(1)
            self.btn_clear.setEnabled(bool(self._scan_token) and len(self._checkboxes) > 0)
            self.status_label.setText(
                self.l10n.bi(
                    f"扫描完成，发现 {len(self._checkboxes)} 项，共计 {format_bytes(total_bytes)}（绝不物理硬删除）。",
                    f"Found {len(self._checkboxes)} items totaling {format_bytes(total_bytes)} (non-destructive).",
                )
            )

        self.bridge.call_async({"command": "maintenance_scan", "retentionDays": days}, _done, timeout=30.0)

    def _clear_selected(self) -> None:
        selected = [name for name, chk in self._checkboxes.items() if chk.isChecked()]
        if not selected or not self._scan_token:
            return
        self.btn_clear.setEnabled(False)
        self.status_label.setText(self.l10n.bi("正在安全归档并移入隔离区…", "Archiving and moving selected items…"))

        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            if err or not res or not res.get("ok"):
                self.btn_clear.setEnabled(True)
                self.status_label.setText(str(err or (res or {}).get("error") or "Clear failed"))
                return
            freed = int(res.get("freedBytes") or res.get("movedBytes") or 0)
            self.status_label.setText(
                self.l10n.bi(
                    f"安全清理完成，已隔离 {format_bytes(freed)}，可随时从“可回滚快照历史”恢复。",
                    f"Moved {format_bytes(freed)} to vault. Restore anytime from Recovery Snapshots.",
                )
            )
            self._scan()
            self._load_history()

        self.bridge.call_async(
            {"command": "maintenance_clear", "token": self._scan_token, "selectedNames": selected},
            _done,
            timeout=60.0,
        )

    def _load_history(self) -> None:
        def _done(res: dict[str, Any] | None, _err: Exception | None) -> None:
            self._clear_layout(self.hist_items_lay)
            snaps = (res or {}).get("snapshots") or []
            if not snaps:
                lbl = QLabel(self.l10n.bi("暂无清理快照记录。", "No maintenance snapshots yet."))
                lbl.setObjectName("Secondary")
                self.hist_items_lay.addWidget(lbl)
            else:
                for snap in snaps:
                    sid = str(snap.get("id") or snap.get("snapshotId") or "")
                    card = Card("SubCard")
                    hl = QHBoxLayout(card)
                    hl.setContentsMargins(10, 8, 10, 8)
                    info = QVBoxLayout()
                    info.addWidget(QLabel(f"{sid}  ·  {format_bytes(snap.get('totalBytes') or snap.get('bytes') or 0)}"))
                    sub = QLabel(str(snap.get("createdAt") or snap.get("at") or ""))
                    sub.setObjectName("Secondary")
                    info.addWidget(sub)
                    hl.addLayout(info, 1)
                    btn = QPushButton(self.l10n.bi("一键恢复", "Restore"))
                    btn.clicked.connect(lambda _c=False, _sid=sid: self._restore_snapshot(_sid))
                    hl.addWidget(btn)
                    self.hist_items_lay.addWidget(card)
            self.hist_items_lay.addStretch(1)

        self.bridge.call_async({"command": "maintenance_history"}, _done)

    def _restore_snapshot(self, sid: str) -> None:
        self.status_label.setText(self.l10n.bi(f"正在恢复快照 {sid}…", f"Restoring snapshot {sid}…"))

        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            if err or not res or not res.get("ok"):
                self.status_label.setText(str(err or (res or {}).get("error") or "Restore failed"))
                return
            self.status_label.setText(self.l10n.bi("快照已完整恢复。", "Snapshot restored."))
            self._scan()
            self._load_history()

        self.bridge.call_async({"command": "maintenance_restore", "snapshotId": sid}, _done, timeout=45.0)


class PricingSyncDialog(QDialog):
    """Remote pricing feed hot-sync & ledger revaluation dialog."""

    def __init__(self, bridge: BackendBridge, l10n: L10n, theme: ThemeColors, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.bridge = bridge
        self.l10n = l10n
        self.theme = theme
        self.changed = False
        self.setWindowTitle(l10n.bi("远端价格同步与账本重估", "Pricing Feed Sync & Ledger Revaluation"))
        self.setMinimumWidth(520)

        lay = QVBoxLayout(self)
        lay.setContentsMargins(18, 16, 18, 16)
        lay.setSpacing(12)

        card = Card()
        cl = QVBoxLayout(card)
        cl.setContentsMargins(14, 14, 14, 14)
        cl.setSpacing(8)
        self.info_label = QLabel(l10n.bi("正在读取价格目录状态…", "Loading pricing feed status…"))
        self.info_label.setWordWrap(True)
        cl.addWidget(self.info_label)

        self.chk_auto = QCheckBox(l10n.bi("自动增量同步远端权威价格目录（ETag / SHA-256 校验）", "Auto-sync remote pricing feed (ETag / SHA-256 verified)"))
        self.chk_auto.toggled.connect(self._on_toggle_auto)
        cl.addWidget(self.chk_auto)

        btn_row = QHBoxLayout()
        self.btn_sync_now = QPushButton(l10n.bi("立即检查更新", "Check & Sync Now"))
        self.btn_sync_now.setObjectName("PrimaryBtn")
        self.btn_sync_now.clicked.connect(self._on_sync_now)
        self.btn_revalue = QPushButton(l10n.bi("重估未计价历史记录", "Revalue Unpriced History"))
        self.btn_revalue.clicked.connect(self._on_revalue_preview)
        btn_row.addWidget(self.btn_sync_now)
        btn_row.addWidget(self.btn_revalue)
        btn_row.addStretch(1)
        cl.addLayout(btn_row)
        lay.addWidget(card)

        self.result_label = QLabel("")
        self.result_label.setObjectName("Secondary")
        self.result_label.setWordWrap(True)
        lay.addWidget(self.result_label)

        footer = QHBoxLayout()
        footer.addStretch(1)
        btn_close = QPushButton(l10n.bi("完成", "Done"))
        btn_close.clicked.connect(self.accept)
        footer.addWidget(btn_close)
        lay.addLayout(footer)

        self._load_status()

    def _load_status(self) -> None:
        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            if err or not res or not res.get("ok"):
                self.info_label.setText(str(err or (res or {}).get("error") or "Unavailable"))
                return
            st = res.get("status") or {}
            self.chk_auto.blockSignals(True)
            self.chk_auto.setChecked(bool(st.get("autoSyncEnabled", False)))
            self.chk_auto.blockSignals(False)
            ver = st.get("activeVersion") or st.get("version") or "--"
            src = st.get("activeSource") or st.get("source") or "bundled"
            checked = st.get("lastCheckedAt") or "--"
            self.info_label.setText(
                self.l10n.bi(
                    f"当前价格目录版本：{ver}\n来源：{src}\n最近检查：{checked}",
                    f"Active pricing version: {ver}\nSource: {src}\nLast checked: {checked}",
                )
            )

        self.bridge.call_async({"command": "pricing_sync_status"}, _done)

    def _on_toggle_auto(self, checked: bool) -> None:
        self.bridge.call_async({"command": "pricing_sync_set", "enabled": checked}, lambda *_: None)

    def _on_sync_now(self) -> None:
        self.btn_sync_now.setEnabled(False)
        self.result_label.setText(self.l10n.bi("正在拉取远端价格目录…", "Fetching remote pricing feed…"))

        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            self.btn_sync_now.setEnabled(True)
            if err or not res or not res.get("ok"):
                self.result_label.setText(str(err or (res or {}).get("error") or "Sync failed"))
                return
            self.changed = True
            self.result_label.setText(str(res.get("message") or self.l10n.bi("价格目录已是最新。", "Pricing catalog up to date.")))
            self._load_status()

        self.bridge.call_async({"command": "pricing_sync_check"}, _done, timeout=25.0)

    def _on_revalue_preview(self) -> None:
        self.btn_revalue.setEnabled(False)
        self.result_label.setText(self.l10n.bi("正在预估历史账本变更…", "Previewing ledger revaluation…"))

        def _done(res: dict[str, Any] | None, err: Exception | None) -> None:
            self.btn_revalue.setEnabled(True)
            if err or not res or not res.get("ok"):
                self.result_label.setText(str(err or (res or {}).get("error") or "Preview failed"))
                return
            preview = res.get("preview") or {}
            affected = int(preview.get("affectedEvents") or preview.get("changedCount") or 0)
            pid = str(preview.get("previewId") or "")
            if affected <= 0 or not pid:
                self.result_label.setText(self.l10n.bi("所有历史记录均已按当前费率核算，无需重估。", "No historical records need revaluation."))
                return
            ans = QMessageBox.question(
                self,
                self.l10n.bi("确认重估历史费用", "Confirm Ledger Revaluation"),
                self.l10n.bi(f"将按最新权威费率重估 {affected} 条历史记录，确认应用？", f"Revalue {affected} historical events with latest rates?"),
                QMessageBox.Yes | QMessageBox.No,
            )
            if ans == QMessageBox.Yes:
                self.bridge.call_async(
                    {"command": "api_pricing_revalue", "mode": "unpriced_only", "confirm": True, "previewId": pid},
                    self._on_revalue_applied,
                    timeout=30.0,
                )

        self.bridge.call_async({"command": "api_pricing_revalue_preview", "mode": "unpriced_only"}, _done, timeout=25.0)

    def _on_revalue_applied(self, res: dict[str, Any] | None, err: Exception | None) -> None:
        if err or not res or not res.get("ok"):
            self.result_label.setText(str(err or (res or {}).get("error") or "Revaluation failed"))
            return
        self.changed = True
        self.result_label.setText(str(res.get("message") or self.l10n.bi("历史费用重估完成。", "Revaluation applied.")))
