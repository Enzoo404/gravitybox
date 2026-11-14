import Cocoa
import ServiceManagement

final class PreferencesController: NSObject {
    static let refreshIntervals = [0, 5, 10, 15, 30, 60]

    unowned let app: Assistant
    var view: NSView!
    let translationSwitch = DesignSwitch()
    let hudSwitch = DesignSwitch()
    let pricingSyncSwitch = DesignSwitch()
    var pricingSyncCheckBtn: InlineRefreshButton!
    let refresh = NSPopUpButton(frame: .zero, pullsDown: false)
    let login = DesignSwitch()
    let syncLifecycleSwitch = DesignSwitch()
    let storageBadge = pillBadge("", color: Design.blue)
    static let defaultStorageSubtitle = "清理无损缓存与历史日志，保留核心数据"
    let storageSubtitleLabel = text(PreferencesController.defaultStorageSubtitle, size: 11, color: Design.secondary, wrap: true)
    var manageCacheBtn: NSButton!
    var pricingSheet: PricingSyncSheetController?
    private var lastStorageScanAt: Date = .distantPast
    private var storageScanInFlight = false

    init(app: Assistant) {
        self.app = app
        super.init()
        translationSwitch.controlSize = .small
        translationSwitch.state = app.statusValue.enabled ? .on : .off
        translationSwitch.isEnabled = app.reachable && app.statusValue.mode != "unsupported"
        translationSwitch.target = self; translationSwitch.action = #selector(toggleTranslation); translationSwitch.setAccessibilityLabel("界面汉化")

        hudSwitch.controlSize = .small
        hudSwitch.state = app.effectiveHudEnabled() ? .on : .off
        hudSwitch.isEnabled = app.reachable && app.statusValue.mode != "unsupported"
        hudSwitch.target = self; hudSwitch.action = #selector(toggleHud); hudSwitch.setAccessibilityLabel("对话状态栏")

        login.controlSize = .small
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        login.target = self; login.action = #selector(toggleLogin); login.setAccessibilityLabel("登录时启动")

        syncLifecycleSwitch.controlSize = .small
        syncLifecycleSwitch.state = app.configuration.value.syncAntigravityLifecycle ? .on : .off
        syncLifecycleSwitch.target = self; syncLifecycleSwitch.action = #selector(toggleSyncLifecycle)
        syncLifecycleSwitch.setAccessibilityLabel("跟随 Antigravity 启停")

        refresh.addItems(withTitles: ["手动刷新", "每 5 分钟", "每 10 分钟", "每 15 分钟", "每 30 分钟", "每 60 分钟"])
        refresh.selectItem(at: Self.refreshIntervals.firstIndex(of: app.configuration.value.quotaRefreshMinutes) ?? 0)
        refresh.target = self; refresh.action = #selector(refreshChanged); refresh.setAccessibilityLabel("配额刷新间隔")
        refresh.translatesAutoresizingMaskIntoConstraints = false
        refresh.widthAnchor.constraint(equalToConstant: 118).isActive = true

        pricingSyncSwitch.controlSize = .small
        pricingSyncSwitch.state = app.configuration.value.autoPricingSyncEnabled ? .on : .off
        pricingSyncSwitch.target = self; pricingSyncSwitch.action = #selector(togglePricingSync)
        pricingSyncSwitch.setAccessibilityLabel("自动更新价格基准")
        pricingSyncCheckBtn = InlineRefreshButton("立即检查", width: 88, target: self, action: #selector(checkPricingSync))
        pricingSyncCheckBtn.setAccessibilityLabel("检查价格更新")
        let pricingControlGroup = horizontal([pricingSyncCheckBtn, pricingSyncSwitch], spacing: 8)
        pricingControlGroup.alignment = .centerY

        let enhanceGroup = vertical([
            settingRow(icon: "character.book.closed", tint: .systemGreen, title: "界面汉化", subtitle: "实时汉化 Antigravity，不改动官方应用", control: translationSwitch),
            divider(),
            settingRow(icon: "chart.bar.xaxis", tint: .systemIndigo, title: "对话状态栏", subtitle: "在 Antigravity 输入框下方显示轮次、Token 与上下文", control: hudSwitch)
        ], spacing: 12)
        for child in enhanceGroup.arrangedSubviews { fillWidth(child, in: enhanceGroup) }

        let dataSyncGroup = vertical([
            settingRow(icon: "arrow.clockwise", tint: Design.blue, title: "配额刷新间隔", subtitle: "定时更新已保存账号的剩余配额", control: refresh),
            divider(),
            settingRow(icon: "dollarsign.circle", tint: Design.blue, title: "自动更新价格基准", subtitle: "自动同步公开模型费率，每 24 小时检查一次", control: pricingControlGroup)
        ], spacing: 12)
        for child in dataSyncGroup.arrangedSubviews { fillWidth(child, in: dataSyncGroup) }

        storageBadge.isHidden = true
        storageBadge.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        manageCacheBtn = button("管理存储…", target: self, action: #selector(showMaintenanceSheet))
        let storageRow = settingRow(
            icon: "internaldrive",
            tint: .systemOrange,
            title: "存储与维护",
            badge: storageBadge,
            subtitle: "",
            control: manageCacheBtn
        )
        storageSubtitleLabel.maximumNumberOfLines = 1
        storageSubtitleLabel.lineBreakMode = .byTruncatingTail
        storageSubtitleLabel.toolTip = nil
        if let rowStack = storageRow as? NSStackView,
           let captionsStack = rowStack.arrangedSubviews.dropFirst().first as? NSStackView {
            captionsStack.addArrangedSubview(storageSubtitleLabel)
        }
        let systemAndStorageGroup = vertical([
            settingRow(icon: "power", tint: .systemGray, title: "登录时启动", subtitle: "登录 macOS 时自动在菜单栏驻留", control: login),
            divider(),
            settingRow(icon: "link", tint: .systemTeal, title: "跟随 Antigravity 启停", subtitle: "随 Antigravity 自动启动并同步退出", control: syncLifecycleSwitch),
            divider(),
            storageRow
        ], spacing: 12)
        for child in systemAndStorageGroup.arrangedSubviews { fillWidth(child, in: systemAndStorageGroup) }

        let enhanceCard = group([enhanceGroup], inset: 16)
        enhanceCard.cornerRadius = Design.Radius.card
        let dataSyncCard = group([dataSyncGroup], inset: 16)
        dataSyncCard.cornerRadius = Design.Radius.card
        let systemAndStorageCard = group([systemAndStorageGroup], inset: 16)
        systemAndStorageCard.cornerRadius = Design.Radius.card

        func sectionGroup(_ title: String, card: NSView) -> NSStackView {
            let hdr = text(title, size: 11.5, weight: .semibold, color: Design.secondary)
            let grp = vertical([hdr, card], spacing: 6)
            fillWidth(hdr, in: grp)
            fillWidth(card, in: grp)
            return grp
        }

        let root = pageStack(title: "设置")
        root.spacing = 14
        root.addArrangedSubview(sectionGroup("Antigravity 增强", card: enhanceCard))
        root.addArrangedSubview(sectionGroup("配额与计价", card: dataSyncCard))
        root.addArrangedSubview(sectionGroup("系统与存储", card: systemAndStorageCard))
        view = scrollPage(root); Design.applyControls(view)
    }

    var maintenanceSheet: MaintenanceSheetController?

    @objc func showMaintenanceSheet() {
        guard let window = app.window else { return }
        if let active = window.activeSheetWindow, active !== maintenanceSheet?.sheet { return }
        if maintenanceSheet == nil {
            maintenanceSheet = MaintenanceSheetController(app: app)
        }
        maintenanceSheet?.show(in: window) { [weak self] in
            self?.refreshStorageRowState(force: true)
        }
    }

    func applyStorageScanPayload(_ value: [String: Any]) {
        lastStorageScanAt = Date()
        let safeBytes = Int64(intVal(value, "safeBytes"))
        let statefulBytes = Int64(intVal(value, "statefulBytes"))
        if safeBytes >= 10 * 1024 * 1024 {
            let formatted = ByteCountFormatter.string(fromByteCount: safeBytes, countStyle: .file)
            storageBadge.title = "可释放 \(formatted)"
            storageBadge.tint = Design.blue
            storageBadge.isHidden = false
        } else if statefulBytes >= 50 * 1024 * 1024 {
            let formatted = ByteCountFormatter.string(fromByteCount: statefulBytes, countStyle: .file)
            storageBadge.title = "可瘦身 \(formatted)"
            storageBadge.tint = Design.secondary
            storageBadge.isHidden = false
        } else if safeBytes + statefulBytes > 0 {
            storageBadge.title = "状态良好"
            storageBadge.tint = Design.secondary
            storageBadge.isHidden = false
        } else {
            storageBadge.isHidden = true
        }
        if safeBytes > 0 && statefulBytes > 0 {
            let safeStr = ByteCountFormatter.string(fromByteCount: safeBytes, countStyle: .file)
            let statefulStr = ByteCountFormatter.string(fromByteCount: statefulBytes, countStyle: .file)
            storageSubtitleLabel.stringValue = "可清理 \(safeStr) 无损缓存，另有 \(statefulStr) 历史数据可瘦身"
        } else {
            storageSubtitleLabel.stringValue = Self.defaultStorageSubtitle
        }
        storageSubtitleLabel.toolTip = nil
    }

    func refreshStorageRowState(force: Bool = false) {
        guard app.reachable else { return }
        guard !storageScanInFlight else { return }
        if !force && Date().timeIntervalSince(lastStorageScanAt) < 60.0 {
            return
        }
        storageScanInFlight = true
        let retentionDays = app.cachePage?.selectedRetentionDays ?? 7
        app.bridge.send(["command": "maintenance_scan", "retentionDays": retentionDays]) { [weak self] result in
            guard let self else { return }
            self.storageScanInFlight = false
            if case .success(let value) = result {
                self.applyStorageScanPayload(value)
            }
        }
    }

    func update() {
        translationSwitch.state = app.statusValue.enabled ? .on : .off
        translationSwitch.isEnabled = app.reachable && app.statusValue.mode != "unsupported"
        hudSwitch.state = app.effectiveHudEnabled() ? .on : .off
        hudSwitch.isEnabled = app.reachable && app.statusValue.mode != "unsupported"
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        syncLifecycleSwitch.state = app.configuration.value.syncAntigravityLifecycle ? .on : .off
        refresh.selectItem(at: Self.refreshIntervals.firstIndex(of: app.configuration.value.quotaRefreshMinutes) ?? 0)
        refreshStorageRowState()
        pricingSyncSwitch.state = app.configuration.value.autoPricingSyncEnabled ? .on : .off
        pricingSyncSwitch.isEnabled = app.reachable
        pricingSyncCheckBtn?.setBusy(pricingSyncCheckBtn?.isBusy == true, available: app.reachable)
    }

    @objc func toggleTranslation() {
        let target = translationSwitch.state == .on
        app.setTranslationEnabled(target)
    }

    @objc func togglePricingSync() {
        let enabled = pricingSyncSwitch.state == .on
        pricingSyncSwitch.isEnabled = false
        app.bridge.send(["command": "pricing_sync_set", "enabled": enabled]) { [weak self] result in
            guard let self else { return }
            self.pricingSyncSwitch.isEnabled = true
            if case .success = result {
                self.app.configuration.value.autoPricingSyncEnabled = enabled
                try? self.app.configuration.save()
            } else {
                self.pricingSyncSwitch.state = self.app.configuration.value.autoPricingSyncEnabled ? .on : .off
                self.app.showMessage("未能更新自动价格同步设置", error: true)
            }
        }
    }

    @objc func checkPricingSync() {
        guard pricingSyncCheckBtn?.isBusy != true else { return }
        pricingSyncCheckBtn?.setBusy(true, available: true)
        app.bridge.send(["command": "pricing_sync_check"]) { [weak self] result in
            guard let self else { return }
            self.pricingSyncCheckBtn?.setBusy(false, available: self.app.reachable)
            switch result {
            case .success(let payload):
                if payload["synced"] as? Bool == true {
                    self.app.overview?.fetch()
                    self.app.usagePage?.fetch(force: true)
                }
                if let window = self.app.window, window.activeSheetWindow == nil || window.activeSheetWindow === self.pricingSheet?.sheet {
                    if self.pricingSheet == nil {
                        self.pricingSheet = PricingSyncSheetController(app: self.app)
                    }
                    self.pricingSheet?.show(in: window, payload: payload)
                } else {
                    let count = (payload["prices"] as? [String: Any])?.count ?? (payload["count"] as? Int ?? 0)
                    let ok = payload["synced"] as? Bool == true
                    self.app.showMessage(ok ? "价格基准已同步（生效 \(count) 款模型）" : "检查提示：\(payload["error"] as? String ?? "未能同步远端价格")", error: !ok)
                }
            case .failure(let err):
                self.app.showMessage("同步失败：\(err.localizedDescription)", error: true)
            }
        }
    }

    @objc func toggleHud() {
        let target = hudSwitch.state == .on
        app.setHudEnabled(target)
    }

    @objc func toggleSyncLifecycle() {
        let previous = app.configuration.value.syncAntigravityLifecycle
        let next = syncLifecycleSwitch.state == .on
        app.configuration.value.syncAntigravityLifecycle = next
        do {
            try app.configuration.save()
            app.syncLifecycleAgentRegistration()
        } catch {
            app.configuration.value.syncAntigravityLifecycle = previous
            syncLifecycleSwitch.state = previous ? .on : .off
            showError(error)
        }
    }

    @objc func refreshChanged() {
        let previous = app.configuration.value.quotaRefreshMinutes
        let idx = max(0, min(Self.refreshIntervals.count - 1, refresh.indexOfSelectedItem))
        app.configuration.value.quotaRefreshMinutes = Self.refreshIntervals[idx]
        do { try app.configuration.save(); app.configureQuotaRefreshTimer() }
        catch {
            app.configuration.value.quotaRefreshMinutes = previous
            refresh.selectItem(at: Self.refreshIntervals.firstIndex(of: previous) ?? 0)
            showError(error)
        }
    }

    @objc func toggleLogin() {
        do {
            if login.state == .on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            if SMAppService.mainApp.status == .requiresApproval {
                SMAppService.openSystemSettingsLoginItems()
            }
        } catch {
            showError(error)
        }
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    private func showError(_ error: Error) { app.showMessage(error.localizedDescription, error: true) }
}
