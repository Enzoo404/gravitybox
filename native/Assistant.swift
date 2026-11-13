import Cocoa
import ServiceManagement
import Carbon

/// G03: 侧栏与内容区之间的 1px 分隔线。NSSplitViewController 系统分隔线在深色下仅约 1.1:1，
/// 这里在侧栏 trailing 叠一条随外观更新的语义色线（深色白 8%、浅色黑 9%），不改变侧栏宽度/布局。
private final class SidebarSeparatorView: NSView {
    override var isOpaque: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        let color: NSColor = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor.white.withAlphaComponent(0.13)
            : NSColor.black.withAlphaComponent(0.09)
        color.setFill()
        bounds.fill()
    }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

extension NSWindow {
    var activeSheetWindow: NSWindow? {
        attachedSheet ?? NSApp.windows.first { $0.sheetParent === self }
    }
}

final class Assistant: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate, NSPopoverDelegate, NSTableViewDataSource, NSTableViewDelegate {
    let names = ["总览", "账号", "用量", "设置"]
    var bridge: BackendBridge!
    var configuration: ConfigurationStore!
    var item: NSStatusItem!
    var menuPopover: NSPopover?
    var menuPanelController: MenuPanelController?
    var window: NSWindow?
    var sidebar = NSTableView()
    let pillSelectionView = PillSelectionView()
    var pageHost = NSView()
    var contentVisible: Bool { window?.isVisible == true && window?.isMiniaturized != true && window?.occlusionState.contains(.visible) == true }
    var currentPage = 0
    var dashboardPage: DashboardPage? { overview }
    var overview: DashboardPage?
    var accountsPage: AccountsPage?
    var usageSelectedPeriod = 0
    var usageScrollOrigin = NSPoint.zero
    var usagePage: UsagePage?
    var cachePage: CachePage?
    var preferencesController: PreferencesController?
    var cachedAccounts: [[String: Any]] = []
    var activeAccountId: String = ""
    var pendingAccountTaskId: String?
    var accountSwitchInFlight = false
    var menuTracking = false
    var cachedUsageReportsByPeriod: [String: [String: Any]] = [:]
    var usageLastFetchTimeByPeriod: [String: Date] = [:]
    var usageInFlightByPeriod: [String: Bool] = [:]
    var usageGenerationByPeriod: [String: Int] = [:]
    var usagePendingForceByPeriod = Set<String>()
    var usageManualRefreshPeriods = Set<String>()
    var usageFetchErrorsByPeriod: [String: String] = [:]
    private var usageWaitersByPeriod: [String: [(Result<[String: Any], Error>) -> Void]] = [:]
    private var usageAutoHealAttemptsByPeriod: [String: Int] = [:]
    private var usageAutoHealPendingPeriods = Set<String>()
    var singleAccountRefreshErrors: [String: String] = [:]
    private var popoverGlobalClickMonitor: Any?
    private var popoverLocalKeyMonitor: Any?
    private var quotaRefreshStartedAt: Date?
    private var recoveryAttempts = 0
    private var autoRestartAttempts = 0
    private var lastAutoRestartAt = Date.distantPast
    private var selfHealingPending = false
    /// 汉化开关命令在途时的乐观目标：期间到达的陈旧状态快照不得把开关弹回旧状态。
    private var pendingTranslationTarget: Bool?
    private var translationCommandGeneration = 0
    private var pendingHudTarget: Bool?
    private var hudCommandGeneration = 0
    private var nextRecoveryAt = Date.distantPast
    #if NATIVE_UI_TEST
    var confirmSwitchForTesting: ((String, @escaping (Bool) -> Void) -> Void)?
    #endif
    private(set) var quotaRefreshing = false
    var refreshingAccountIds = Set<String>()
    private(set) var quotaRefreshError: String?
    var quotaRefreshPollTimer: Timer?
    weak var openMenuQuotaView: MenuQuotaView?
    private var isBreathing = false
    private var breathingMotion: DesignMotion?
    var lastTaskRevision = -1
    var statusValue = LiveStatus()
    var taskRows: [[String: Any]] = []
    var reachable = false
    var quotaRefreshTimer: Timer?
    var autoUpdateTimer: Timer?
    private var updateLaunchAcknowledged = false
    lazy var updateManager = AppUpdateManager(app: self)
    var timer: Timer?
    var directorySource: DispatchSourceFileSystemObject?
    var refreshInFlight = false
    var quitting = false
    let serviceFootnoteLabel = text("", size: 10.5, color: Design.secondary)
    private var configSaveWorkItem: DispatchWorkItem?
    private(set) var lastOperationError: String?
    private var presentedError: String?
    private var lastAccountListFetchAt: Date = .distantPast
    private var lastFetchedAccountsRevision = ""
    private var lastFetchedLiveEmail = ""
    private var accountListInFlight = false
    private var accountListPendingNotifyPage = false
    private var accountListGeneration = 0
    private var accountListWaiters: [(Result<[String: Any], Error>) -> Void] = []
    private let stateWatchQueue = DispatchQueue(label: "local.gravitybox.state-watch", qos: .utility)
    private var stateWatchWorkItem: DispatchWorkItem?
    private var antigravityWasRunning = false
    private(set) var suppressLifecycleAutoQuitUntil: Date = .distantPast
    private var workspaceLaunchObserver: NSObjectProtocol?
    private var workspaceTerminateObserver: NSObjectProtocol?
    static var applicationChannel = "stable"
    static var selectedTarget: DesktopApplicationTarget { DesktopApplicationTarget(channel: applicationChannel) }
    var targetApplication: DesktopApplicationTarget { Self.selectedTarget }
    weak var installUpdateButton: SidebarLaunchButton?
    weak var launchApplicationButton: SidebarLaunchButton?
    let state: URL
    init(state: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/GravityBox")) { self.state = state; super.init() }
    var resources: URL {
        #if NATIVE_UI_TEST
        if let path = ProcessInfo.processInfo.environment["GRAVITYBOX_UI_RESOURCES"] { return URL(fileURLWithPath: path) }
        #endif
        return Bundle.main.resourceURL!
    }
    #if NATIVE_UI_TEST
    var openedApplications = 0
    #endif

    static func processArguments(for pid: pid_t) -> [String] {
        BackendBridge.processArguments(for: pid)
    }

    static func isMainPeerApplication(_ app: NSRunningApplication, excludingPid myPid: pid_t) -> Bool {
        let pid = app.processIdentifier
        guard pid > 0, pid != myPid, !app.isTerminated, app.activationPolicy != .prohibited else { return false }
        let args = processArguments(for: pid)
        if args.contains("--lifecycle-agent") { return false }
        return true
    }

    static func findExistingMainPeer(excludingPid myPid: pid_t = getpid()) -> NSRunningApplication? {
        let bundleId = Bundle.main.bundleIdentifier ?? "local.gravitybox.app"
        return NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
            isMainPeerApplication($0, excludingPid: myPid)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let restartedAfterUpdate = CommandLine.arguments.contains("--restarted-after-update")
        if restartedAfterUpdate {
            for _ in 0..<25 {
                if Self.findExistingMainPeer() == nil { break }
                usleep(100_000)
            }
        }
        if let peer = Self.findExistingMainPeer() {
            if !CommandLine.arguments.contains("--launched-by-antigravity") {
                DistributedNotificationCenter.default().postNotificationName(NSNotification.Name("local.gravitybox.show-panel"), object: nil, userInfo: nil, deliverImmediately: true)
                peer.activate()
            }
            quitting = true; NSApp.terminate(nil); return
        }
        NSApp.setActivationPolicy(.accessory)
        do { configuration = try ConfigurationStore(state: state) }
        catch { let alert = NSAlert(error: error); alert.runModal(); NSApp.terminate(nil); return }
        let effectiveChannel = DesktopApplicationTarget.effectiveChannel(configured: configuration.value.applicationChannel)
        if effectiveChannel != configuration.value.applicationChannel {
            configuration.value.applicationChannel = effectiveChannel
            try? configuration.save()
        }
        Self.applicationChannel = effectiveChannel
        bridge = BackendBridge(resources: resources, state: state)
        bridge.onExit = { [weak self] message in
            guard let self, !self.quitting else { return }
            self.reachable = false; self.failPendingQuotaRefresh(message); self.updateViews()
            self.scheduleSelfHealingRestart(reason: message)
        }
        if configuration.value.navigationVersion != 5 {
            configuration.value.migrateNavigation(); try? configuration.save()
        }
        installApplicationMenu()
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = baseMenuConnectedIcon()
        item.button?.setAccessibilityLabel("GravityBox")
        item.button?.target = self
        item.button?.action = #selector(statusItemClicked(_:))
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        updateStatusItemState()
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(showPanel), name: NSNotification.Name("local.gravitybox.show-panel"), object: nil)
        bridge.launch { [weak self] result in if case .failure(let error) = result { self?.showMessage(error.localizedDescription, error: true) } }
        watchState()
        let data = NSAppleEventManager.shared().currentAppleEvent?.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))
        let loginLaunch = data?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
        let launchedByAntigravity = CommandLine.arguments.contains("--launched-by-antigravity")
        if !loginLaunch && !launchedByAntigravity { showPanel() }
        installAntigravityLifecycleObserver()
        syncLifecycleAgentRegistration()
        // 登录项启动时没有窗口，历史上因此从未创建定时器，菜单栏配额永远不更新。
        configureRefreshTimer()
        if quotaRefreshTimer == nil { configureQuotaRefreshTimer() }
        configureAutoUpdateTimer()
        refresh()
    }
    func installApplicationMenu() {
        let main = NSMenu()
        let app = NSMenu(); let appItem = NSMenuItem(); appItem.submenu = app; main.addItem(appItem)
        add(app, "关于 GravityBox", #selector(about), "")
        add(app, "检查更新…", #selector(checkForUpdatesFromMenu), "")
        app.addItem(.separator()); add(app, "设置…", #selector(showSettings), ",")
        app.addItem(.separator()); add(app, "隐藏 GravityBox", #selector(NSApplication.hide(_:)), "h", target: NSApp)
        add(app, "退出 GravityBox", #selector(quit), "q")
        let edit = NSMenu(title: "编辑"); let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: ""); editItem.submenu = edit; main.addItem(editItem)
        for (title, selector, key) in [("撤销", Selector(("undo:")), "z"), ("剪切", #selector(NSText.cut(_:)), "x"), ("复制", #selector(NSText.copy(_:)), "c"), ("粘贴", #selector(NSText.paste(_:)), "v"), ("全选", #selector(NSText.selectAll(_:)), "a")] { let value = NSMenuItem(title: title, action: selector, keyEquivalent: key); edit.addItem(value) }
        let view = NSMenu(title: "显示"); let viewItem = NSMenuItem(title: "显示", action: nil, keyEquivalent: ""); viewItem.submenu = view; main.addItem(viewItem)
        for (index, name) in names.enumerated() { let value = add(view, name, #selector(menuNavigate(_:)), String(index + 1)); value.tag = index }
        let windows = NSMenu(title: "窗口"); let windowItem = NSMenuItem(title: "窗口", action: nil, keyEquivalent: ""); windowItem.submenu = windows; main.addItem(windowItem)
        add(windows, "关闭窗口", #selector(NSWindow.performClose(_:)), "w", target: nil)
        add(windows, "最小化", #selector(NSWindow.performMiniaturize(_:)), "m", target: nil); NSApp.windowsMenu = windows
        NSApp.mainMenu = main
    }
    @discardableResult func add(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String = "", target: AnyObject? = nil) -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key); entry.target = target ?? self
        // Responder-chain window commands must not target the application delegate.
        if action == #selector(NSWindow.performClose(_:)) || action == #selector(NSWindow.performMiniaturize(_:)) { entry.target = nil }
        menu.addItem(entry); return entry
    }
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.showsStateColumn = true
        let active = resolvedMenuAccount()
        let email = active?["email"] as? String ?? statusValue.activeAccountEmail
        let name = active?["name"] as? String ?? ""
        let tier = AccountIdentity.normalizeTier(active?["subscription_tier"] as? String)
        let accountSummary: String
        if !reachable {
            accountSummary = "正在等待本机服务…"
        } else if email.isEmpty {
            accountSummary = "尚未保存账号"
        } else {
            let display = name.isEmpty ? email : "\(name) · \(email)"
            accountSummary = "\(display) · \(tier)"
        }

        // 1. 现代纵向矩形卡片：整合身份、套餐徽章、无胶囊极简刷新与各模型配额进度条
        let quotaText = QuotaPresentation.menuQuotaText(active ?? [:])
        let cardTitle = "\(accountSummary) · \(quotaText)"
        let cardItem = NSMenuItem(title: cardTitle, action: nil, keyEquivalent: "")
        let quotaView = MenuQuotaView(target: self, account: active, placeholder: accountSummary, enabled: reachable && pendingAccountTaskId == nil && !quotaRefreshing)
        openMenuQuotaView = quotaView
        cardItem.view = quotaView
        menu.addItem(cardItem)

        menu.addItem(.separator())

        // 2. 界面汉化与对话状态栏
        let toggle = add(menu, "界面汉化", #selector(toggleTranslation))
        let stateSize = NSSize(width: 13, height: 13)
        let checkmark = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)
        checkmark?.size = stateSize; checkmark?.isTemplate = true; toggle.onStateImage = checkmark
        toggle.offStateImage = NSImage(size: stateSize, flipped: false) { _ in true }
        toggle.state = statusValue.enabled ? NSControl.StateValue.on : NSControl.StateValue.off
        toggle.isEnabled = reachable && statusValue.mode != "unsupported"

        let hudToggle = add(menu, "对话状态栏", #selector(toggleHud))
        hudToggle.onStateImage = checkmark
        hudToggle.offStateImage = toggle.offStateImage
        hudToggle.state = effectiveHudEnabled() ? NSControl.StateValue.on : NSControl.StateValue.off
        hudToggle.isEnabled = reachable && statusValue.mode != "unsupported"

        menu.addItem(.separator())

        // 3. 打开 Antigravity
        add(menu, "打开 \(targetApplication.label)", #selector(openAntigravity))

        // 4. 打开 GravityBox
        add(menu, "打开 GravityBox", #selector(showPanel), "o")

        // 5. 设置…
        add(menu, "设置…", #selector(showSettings), ",")

        menu.addItem(.separator())

        // 6. 退出 GravityBox
        add(menu, "退出 GravityBox", #selector(quit), "q")
    }
    func resolvedMenuAccount() -> [String:Any]? {
        if !statusValue.liveAccountEmail.isEmpty,
           let matched = cachedAccounts.first(where: { ($0["email"] as? String ?? "").caseInsensitiveCompare(statusValue.liveAccountEmail) == .orderedSame }) {
            return matched
        }
        if !activeAccountId.isEmpty,
           let matched = cachedAccounts.first(where: { $0["id"] as? String == activeAccountId }) {
            return matched
        }
        return cachedAccounts.first
    }

    private var cachedBaseMenuIcon: NSImage?

    func baseMenuConnectedIcon() -> NSImage? {
        if let cached = cachedBaseMenuIcon { return cached }
        guard let base = NSImage(contentsOf: resources.appendingPathComponent("icons/menu-connected.png")) else { return nil }
        base.size = NSSize(width: 18, height: 18)
        base.isTemplate = true
        cachedBaseMenuIcon = base
        return base
    }

    func updateStatusItemState(buttonOverride: NSButton? = nil) {
        guard let button = buttonOverride ?? item?.button else { return }
        let baseIcon = baseMenuConnectedIcon()
        if button.image !== baseIcon {
            button.image = baseIcon
        }

        let targetAlpha: CGFloat = reachable ? 1.0 : 0.50
        #if NATIVE_UI_TEST
        button.alphaValue = targetAlpha
        #else
        if quotaRefreshing && reachable {
            if !isBreathing {
                isBreathing = true
                startBreathingPulse(baseAlpha: targetAlpha)
            }
        } else {
            if isBreathing {
                isBreathing = false
                breathingMotion?.cancel()
                breathingMotion = nil
                button.alphaValue = targetAlpha
            } else if abs(button.alphaValue - targetAlpha) > 0.02 {
                button.alphaValue = targetAlpha
            }
        }
        #endif
    }

    private func startBreathingPulse(baseAlpha: CGFloat) {
        guard isBreathing, let button = item?.button else { return }
        breathingMotion?.cancel()
        let motion = DesignMotion()
        breathingMotion = motion
        let lowAlpha = max(0.35, baseAlpha * 0.55)
        motion.animate(in: button, from: baseAlpha, to: lowAlpha, curve: .breathe, threshold: 0.01) { [weak button] p in
            button?.alphaValue = p
        } completion: { [weak self, weak button] in
            guard let self, self.isBreathing, let button else { return }
            self.breathingMotion?.animate(in: button, from: lowAlpha, to: baseAlpha, curve: .breathe, threshold: 0.01) { [weak button] p in
                button?.alphaValue = p
            } completion: { [weak self] in
                guard let self, self.isBreathing else { return }
                self.startBreathingPulse(baseAlpha: baseAlpha)
            }
        }
    }
    func menuWillOpen(_ menu: NSMenu) { menuTracking = true; configureRefreshTimer(); refresh() }
    func menuDidClose(_ menu: NSMenu) { if menuPopover?.isShown != true { menuTracking = false; configureRefreshTimer() } }

    func scheduleConfigurationSave() {
        configSaveWorkItem?.cancel()
        let saveWork = DispatchWorkItem { [weak self] in try? self?.configuration.save() }
        configSaveWorkItem = saveWork
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: saveWork)
    }

    @objc func statusItemClicked(_ sender: Any?) {
        toggleMenuPopover()
    }

    func toggleMenuPopover() {
        if menuPopover?.isShown == true {
            closeMenuPopover()
        } else {
            openMenuPopover()
        }
    }

    func ensureMenuPanelController() -> MenuPanelController {
        if let existing = menuPanelController { return existing }
        let controller = MenuPanelController(app: self)
        menuPanelController = controller
        return controller
    }

    func openMenuPopover() {
        guard let button = item?.button else { return }
        let controller = ensureMenuPanelController()
        let popover = menuPopover ?? {
            let p = NSPopover()
            p.contentViewController = controller
            p.behavior = .transient
            p.delegate = self
            menuPopover = p
            return p
        }()
        popover.animates = true
        menuTracking = true
        configureRefreshTimer()
        controller.panelWillOpen()
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        controller.view.window?.makeKey()
        controller.view.window?.makeFirstResponder(nil)
        installPopoverMonitors()
        refresh()
    }

    func closeMenuPopover() {
        removePopoverMonitors()
        if menuPopover?.isShown == true {
            menuPopover?.performClose(nil)
        }
        if menuTracking {
            menuTracking = false
            configureRefreshTimer()
            menuPanelController?.panelDidClose()
        }
    }

    func popoverDidClose(_ notification: Notification) {
        removePopoverMonitors()
        menuTracking = false
        configureRefreshTimer()
        menuPanelController?.panelDidClose()
    }

    private func installPopoverMonitors() {
        removePopoverMonitors()
        popoverGlobalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
            guard let self, self.menuPopover?.isShown == true else { return }
            let mouseLoc = NSEvent.mouseLocation
            if let popWin = self.menuPanelController?.view.window, popWin.frame.contains(mouseLoc) { return }
            if let btnWin = self.item?.button?.window, btnWin.frame.contains(mouseLoc) { return }
            self.closeMenuPopover()
        }
        popoverLocalKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.menuPopover?.isShown == true,
                  let popWin = self.menuPanelController?.view.window,
                  event.window === popWin else { return event }
            if event.keyCode == 53 { // Escape
                self.closeMenuPopover()
                return nil
            }
            if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
               let key = event.charactersIgnoringModifiers?.lowercased() {
                switch key {
                case ",":
                    self.closeMenuPopover()
                    self.showSettings()
                    return nil
                case "o":
                    self.openMainWindowFromMenuPanel(tab: self.menuPanelController?.selectedTab ?? 0, usagePeriod: self.menuPanelController?.selectedPeriod ?? 0)
                    return nil
                case "r":
                    self.menuPanelController?.refreshCurrentTab()
                    return nil
                case "q":
                    self.closeMenuPopover()
                    self.quit()
                    return nil
                default:
                    break
                }
            }
            return event
        }
    }

    private func removePopoverMonitors() {
        if let monitor = popoverGlobalClickMonitor {
            NSEvent.removeMonitor(monitor)
            popoverGlobalClickMonitor = nil
        }
        if let monitor = popoverLocalKeyMonitor {
            NSEvent.removeMonitor(monitor)
            popoverLocalKeyMonitor = nil
        }
    }

    func buildMoreMenu() -> NSMenu {
        let menu = NSMenu(title: "更多操作")
        menu.showsStateColumn = true
        let toggle = add(menu, "界面汉化", #selector(toggleTranslation))
        let stateSize = NSSize(width: 13, height: 13)
        let checkmark = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)
        checkmark?.size = stateSize; checkmark?.isTemplate = true; toggle.onStateImage = checkmark
        toggle.offStateImage = NSImage(size: stateSize, flipped: false) { _ in true }
        toggle.state = statusValue.enabled ? NSControl.StateValue.on : NSControl.StateValue.off
        toggle.isEnabled = reachable && statusValue.mode != "unsupported"

        let hudToggle = add(menu, "对话状态栏", #selector(toggleHud))
        hudToggle.onStateImage = checkmark
        hudToggle.offStateImage = toggle.offStateImage
        hudToggle.state = effectiveHudEnabled() ? NSControl.StateValue.on : NSControl.StateValue.off
        hudToggle.isEnabled = reachable && statusValue.mode != "unsupported"

        menu.addItem(.separator())
        add(menu, "设置…", #selector(showSettingsFromMenuPanel), ",")
        menu.addItem(.separator())
        add(menu, "退出 GravityBox", #selector(quitFromMenuPanel), "q")
        return menu
    }

    @objc func showSettingsFromMenuPanel() {
        closeMenuPopover()
        showSettings()
    }

    @objc func showAboutFromMenuPanel() {
        closeMenuPopover()
        about()
    }

    @objc func quitFromMenuPanel() {
        closeMenuPopover()
        quit()
    }

    func openMainWindowFromMenuPanel(tab: Int, usagePeriod: Int) {
        closeMenuPopover()
        switch tab {
        case 0:
            let targetPeriod = max(0, min(3, usagePeriod))
            usageSelectedPeriod = targetPeriod
            usageScrollOrigin = .zero
            usagePage?.periodSegment.selectedSegment = targetPeriod
            selectPage(2)
            if let usagePage {
                usagePage.periodSegment.selectedSegment = targetPeriod
                usagePage.periodChanged(usagePage.periodSegment)
            }
        case 1:
            selectPage(0)
        case 2:
            selectPage(1)
        default:
            selectPage(0)
        }
    }

    func fetchUsageSummary(period: String, force: Bool = false, allowCached: Bool = true, completion: ((Result<[String: Any], Error>) -> Void)? = nil) {
        let cacheKey = period
        if !force && allowCached,
           let cached = cachedUsageReportsByPeriod[cacheKey],
           let lastAt = usageLastFetchTimeByPeriod[cacheKey],
           Date().timeIntervalSince(lastAt) < 15.0,
           ((cached["summary"] as? [String: Any])?["failedDatabasesCount"] as? Int ?? 0) == 0 {
            completion?(.success(cached))
            return
        }
        if force {
            usageAutoHealAttemptsByPeriod[cacheKey] = 0
        }
        if let completion {
            usageWaitersByPeriod[cacheKey, default: []].append(completion)
        }
        if usageInFlightByPeriod[cacheKey] == true {
            if force {
                usagePendingForceByPeriod.insert(cacheKey)
                usageManualRefreshPeriods.insert(cacheKey)
                menuPanelController?.syncHeaderRefreshState()
            }
            return
        }
        usageInFlightByPeriod[cacheKey] = true
        let generation = (usageGenerationByPeriod[cacheKey] ?? 0) + 1
        usageGenerationByPeriod[cacheKey] = generation
        if force {
            usageManualRefreshPeriods.insert(cacheKey)
            menuPanelController?.syncHeaderRefreshState()
        }
        var payload: [String: Any] = ["command": "usage_summary", "period": period]
        if force { payload["force"] = true }
        bridge.send(payload) { [weak self] response in
            guard let self else { return }
            if self.usagePendingForceByPeriod.remove(cacheKey) != nil {
                self.usageInFlightByPeriod[cacheKey] = false
                self.fetchUsageSummary(period: period, force: true, allowCached: false)
                return
            }
            self.usageInFlightByPeriod[cacheKey] = false
            self.usageManualRefreshPeriods.remove(cacheKey)
            guard generation >= (self.usageGenerationByPeriod[cacheKey] ?? 0) else { return }
            self.usageLastFetchTimeByPeriod[cacheKey] = Date()
            let waiters = self.usageWaitersByPeriod.removeValue(forKey: cacheKey) ?? []
            switch response {
            case .failure(let error):
                self.usageFetchErrorsByPeriod[cacheKey] = error.localizedDescription
            case .success(let value):
                self.usageFetchErrorsByPeriod[cacheKey] = nil
                self.cachedUsageReportsByPeriod[cacheKey] = value
                let failedCount = (value["summary"] as? [String: Any])?["failedDatabasesCount"] as? Int ?? 0
                if failedCount == 0 {
                    self.usageAutoHealAttemptsByPeriod[cacheKey] = 0
                } else {
                    #if !NATIVE_UI_TEST
                    let attempts = self.usageAutoHealAttemptsByPeriod[cacheKey, default: 0]
                    if attempts < 2 && !self.usageAutoHealPendingPeriods.contains(cacheKey) && self.reachable && !self.quitting {
                        self.usageAutoHealAttemptsByPeriod[cacheKey] = attempts + 1
                        self.usageAutoHealPendingPeriods.insert(cacheKey)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
                            guard let self else { return }
                            self.usageAutoHealPendingPeriods.remove(cacheKey)
                            guard self.reachable && !self.quitting else { return }
                            self.fetchUsageSummary(period: period, force: false, allowCached: false)
                        }
                    }
                    #endif
                }
                if force && self.contentVisible && self.currentPage == 2 {
                    self.usagePage?.update(force: false)
                }
            }
            self.menuPanelController?.onUsageReportUpdated(period: period, result: response)
            for waiter in waiters { waiter(response) }
        }
    }

    func refreshSingleAccountQuota(id: String, completion: ((Result<[String: Any], Error>) -> Void)? = nil) {
        guard !id.isEmpty, reachable, !refreshingAccountIds.contains(id) else { return }
        singleAccountRefreshErrors[id] = nil
        refreshingAccountIds.insert(id)
        updateQuotaRefreshControls()
        menuPanelController?.syncFromAssistant()
        bridge.send(["command": "quota_refresh", "id": id]) { [weak self] response in
            guard let self else { return }
            self.refreshingAccountIds.remove(id)
            switch response {
            case .failure(let error):
                self.singleAccountRefreshErrors[id] = error.localizedDescription
            case .success:
                self.singleAccountRefreshErrors[id] = nil
                self.fetchAccountList(notifyPage: true)
                self.overview?.update(force: true)
            }
            self.updateQuotaRefreshControls()
            self.menuPanelController?.syncFromAssistant()
            completion?(response)
        }
    }

    func buildAccountSwitchMenu() -> NSMenu {
        let switchSubmenu = NSMenu(title: "切换账号")
        switchSubmenu.showsStateColumn = true
        if cachedAccounts.isEmpty {
            let emptyItem = NSMenuItem(title: "暂无可用账号快照", action: nil, keyEquivalent: "")
            emptyItem.isEnabled = false
            switchSubmenu.addItem(emptyItem)
        } else {
            let ordered = cachedAccounts.enumerated().sorted { lhs, rhs in
                let l = lhs.element["id"] as? String == activeAccountId
                let r = rhs.element["id"] as? String == activeAccountId
                return l == r ? lhs.offset < rhs.offset : l
            }.map(\.element)
            for acc in ordered {
                let id = acc["id"] as? String ?? ""
                let accEmail = acc["email"] as? String ?? "未知账号"
                let label = acc["name"] as? String ?? ""
                let displayName = label.isEmpty ? accEmail : "\(label) · \(accEmail)"
                let accTier = AccountIdentity.normalizeTier(acc["subscription_tier"] as? String)
                let title = "\(displayName) · \(accTier) · \(QuotaPresentation.menuQuotaText(acc))"
                let accItem = NSMenuItem(title: title, action: #selector(switchAccountFromMenu(_:)), keyEquivalent: "")
                accItem.target = self
                accItem.representedObject = id
                accItem.isEnabled = acc["disabled"] as? Bool != true
                if id == activeAccountId || (activeAccountId.isEmpty && accEmail == statusValue.activeAccountEmail) { accItem.state = .on }
                switchSubmenu.addItem(accItem)
            }
        }
        switchSubmenu.addItem(.separator())
        let manageItem = NSMenuItem(title: "管理账号…", action: #selector(showAccountsFromMenuCard), keyEquivalent: "")
        manageItem.target = self
        switchSubmenu.addItem(manageItem)
        return switchSubmenu
    }
    func popUpAccountSwitchMenu(from anchorView: NSView) {
        let submenu = buildAccountSwitchMenu()
        Design.popUpMenu(submenu, below: anchorView)
    }
    @objc func showAccountsFromMenuCard() {
        closeMenuPopover()
        item?.menu?.cancelTracking()
        showAccounts()
    }
    func switchAccountByIdFromMenu(_ id: String) {
        guard !id.isEmpty, id != activeAccountId else { return }
        closeMenuPopover()
        item?.menu?.cancelTracking()
        let targetAccount = cachedAccounts.first(where: { ($0["id"] as? String) == id })
        let email = targetAccount?["email"] as? String ?? ""
        let name = targetAccount?["name"] as? String ?? ""
        requestInteractiveAccountSwitch(id: id, email: email, name: name)
    }
    @objc func switchAccountFromMenu(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        switchAccountByIdFromMenu(id)
    }
    func requestInteractiveAccountSwitch(id: String, email: String, name: String, completion: (() -> Void)? = nil) {
        guard !id.isEmpty, !accountSwitchInFlight, reachable else { return }
        accountSwitchInFlight = true
        bridge.send(["command": "account_switch_preflight", "id": id]) { [weak self] result in
            guard let self else { return }
            guard case .success(let payload) = result else {
                self.accountSwitchInFlight = false
                if case .failure(let error) = result {
                    self.showMessage("无法确认切换前置条件：" + error.localizedDescription, error: true)
                }
                return
            }
            let appRunning = payload["appRunning"] as? Bool == true
            let insidersRunning = payload["insidersRunning"] as? Bool == true
            let stableRunning = (payload["stableRunning"] as? Bool) ?? (appRunning && !insidersRunning)
            let shouldQuitAndRelaunch = !insidersRunning && (stableRunning || Self.isAntigravityRunning())
            let hasRunningTask = (payload["hasRunningTask"] as? Bool == true) || (payload["safe"] as? Bool == false)
            let display: String
            if !name.isEmpty && name.caseInsensitiveCompare(email) != .orderedSame && !email.isEmpty {
                display = "\(name)（\(email)）"
            } else {
                display = email.isEmpty ? (name.isEmpty ? "目标账号" : name) : email
            }
            if insidersRunning {
                self.accountSwitchInFlight = false
                self.showMessage("检测到 Antigravity Insiders 正在运行，请先保存工作并手动退出后再切换账号", error: true)
                return
            }
            let performSwitch = { [weak self] in
                guard let self else { return }
                self.suppressLifecycleAutoQuit(seconds: 75.0)
                self.bridge.send(["command": "account_switch", "id": id, "target": "all", "autoRefreshToken": true]) { [weak self] response in
                    guard let self else { return }; self.accountSwitchInFlight = false
                    switch response {
                    case .failure(let error):
                        if shouldQuitAndRelaunch { self.relaunchAntigravityAfterSwitch() }
                        self.showMessage("切换账号失败：" + error.localizedDescription, error: true)
                    case .success(let value):
                        self.showMessage(value["message"] as? String ?? "已切换至账号：\(email)")
                        if shouldQuitAndRelaunch { self.relaunchAntigravityAfterSwitch() }
                        self.refresh(); self.accountsPage?.fetch(); self.overview?.fetch(); completion?()
                    }
                }
            }
            let execute: (Bool) -> Void = { [weak self] confirmed in
                guard let self else { return }
                guard confirmed else { self.accountSwitchInFlight = false; return }
                #if NATIVE_UI_TEST
                if self.confirmSwitchForTesting != nil {
                    self.bridge.send(["command": "account_switch", "id": id, "target": "all", "autoRefreshToken": true]) { [weak self] response in
                        guard let self else { return }; self.accountSwitchInFlight = false
                        if case .success(let value) = response {
                            self.showMessage(value["message"] as? String ?? "已切换至账号：\(email)")
                            if shouldQuitAndRelaunch { self.relaunchAntigravityAfterSwitch() }
                            self.refresh(); self.accountsPage?.fetch(); self.overview?.fetch(); completion?()
                        }
                    }
                    return
                }
                #endif
                if shouldQuitAndRelaunch {
                    self.quitAntigravityAndWait { [weak self] exited in
                        guard let self else { return }
                        guard exited else {
                            self.accountSwitchInFlight = false
                            self.showMessage("请先在 Antigravity 中保存工作并退出应用，再切换账号", error: true)
                            return
                        }
                        performSwitch()
                    }
                } else {
                    performSwitch()
                }
            }
            if hasRunningTask {
                #if NATIVE_UI_TEST
                if self.confirmSwitchForTesting != nil {
                    self.accountSwitchInFlight = false
                    return
                }
                #endif
                let busyAlert = NSAlert()
                busyAlert.alertStyle = .warning
                busyAlert.messageText = "切换至 \(display)？"
                busyAlert.informativeText = "检测到 Antigravity 有正在运行的任务，现在切换会中断当前任务并重启应用。"
                busyAlert.addButton(withTitle: "仍要切换")
                busyAlert.addButton(withTitle: "取消")
                if let window = self.window, window.isVisible, window.activeSheetWindow == nil {
                    busyAlert.beginSheetModal(for: window) { execute($0 == .alertFirstButtonReturn) }
                } else {
                    NSApp.activate(ignoringOtherApps: true)
                    execute(busyAlert.runModal() == .alertFirstButtonReturn)
                }
                return
            }
            #if NATIVE_UI_TEST
            if let confirm = self.confirmSwitchForTesting { confirm(display, execute); return }
            #endif
            let alert = NSAlert()
            alert.alertStyle = .informational
            alert.messageText = "切换至 \(display)？"
            alert.informativeText = appRunning
                ? "当前无正在运行的任务，确认后将自动重启 Antigravity 生效。"
                : "Antigravity 当前未运行，确认后将直接切换账号。"
            alert.addButton(withTitle: "确认切换")
            alert.addButton(withTitle: "取消")
            if let window = self.window, window.isVisible, window.activeSheetWindow == nil {
                alert.beginSheetModal(for: window) { execute($0 == .alertFirstButtonReturn) }
            } else {
                NSApp.activate(ignoringOtherApps: true)
                execute(alert.runModal() == .alertFirstButtonReturn)
            }
        }
    }
    static func hasRunningAntigravityProcess(psOutput: String, appPaths: [String]) -> Bool {
        psOutput.split(separator: "\n").contains { line in
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            return appPaths.contains { trimmed.hasPrefix($0 + "/Contents/") }
        }
    }

    func quitAntigravityAndWait(completion: @escaping (Bool) -> Void) {
        suppressLifecycleAutoQuit(seconds: 30.0)
        let allTargets = DesktopApplicationTarget.allTargets
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let appPaths = allTargets.map(\.path)
            let runningApps = NSWorkspace.shared.runningApplications.filter {
                DesktopApplicationTarget.matchesAny($0)
            }
            for app in runningApps { _ = app.terminate() }
            func hasAntigravityProcesses() -> Bool {
                let task = Process()
                task.executableURL = URL(fileURLWithPath: "/bin/ps")
                task.arguments = ["-ax", "-ww", "-o", "args="]
                let pipe = Pipe()
                task.standardOutput = pipe
                task.standardError = FileHandle.nullDevice
                do {
                    try task.run()
                    let data = pipe.fileHandleForReading.readDataToEndOfFile()
                    task.waitUntilExit()
                    let output = String(data: data, encoding: .utf8) ?? ""
                    return Self.hasRunningAntigravityProcess(psOutput: output, appPaths: appPaths)
                } catch { return false }
            }
            func hasWorkspaceRegistration() -> Bool {
                DispatchQueue.main.sync {
                    Self.isAntigravityRunning()
                }
            }
            let start = Date()
            var retriedTerminate = false
            while (hasAntigravityProcesses() || hasWorkspaceRegistration()) && Date().timeIntervalSince(start) < 20.0 {
                if !retriedTerminate && Date().timeIntervalSince(start) >= 2.0 {
                    retriedTerminate = true
                    DispatchQueue.main.async {
                        for app in NSWorkspace.shared.runningApplications where DesktopApplicationTarget.matchesAny(app) && !app.isTerminated {
                            _ = app.terminate()
                        }
                    }
                }
                Thread.sleep(forTimeInterval: 0.15)
            }
            let exited = !hasAntigravityProcesses() && !hasWorkspaceRegistration()
            if exited {
                // Allow LaunchServices / runningboardd to finish unregistering the terminated app job before relaunch.
                Thread.sleep(forTimeInterval: 0.3)
            }
            DispatchQueue.main.async {
                self?.suppressLifecycleAutoQuit(seconds: 20.0)
                completion(exited)
            }
        }
    }

    @objc func refreshAccountQuotas() {
        guard !quotaRefreshing, pendingAccountTaskId == nil, reachable else { return }
        quotaRefreshing = true; quotaRefreshStartedAt = Date(); quotaRefreshError = nil; updateQuotaRefreshControls()
        let poll = Timer(timeInterval: 0.75, repeats: true) { [weak self] _ in self?.refresh(taskPollOnly: true) }
        quotaRefreshPollTimer?.invalidate(); quotaRefreshPollTimer = poll
        RunLoop.main.add(poll, forMode: .common); RunLoop.main.add(poll, forMode: .eventTracking)
        bridge.send(["command": "quota_refresh_start"]) { [weak self] response in
            guard let self else { return }
            switch response {
            case .failure(let error): self.finishQuotaRefresh(error: error.localizedDescription)
            case .success(let value):
                guard let id = value["taskId"] as? String, !id.isEmpty else { self.finishQuotaRefresh(error: "未取得刷新任务，请重试"); return }
                self.pendingAccountTaskId = id; self.refresh(taskPollOnly: true)
            }
        }
    }
    func finishQuotaRefresh(error: String?) {
        quotaRefreshing = false; quotaRefreshStartedAt = nil; pendingAccountTaskId = nil; quotaRefreshError = error; quotaRefreshPollTimer?.invalidate(); quotaRefreshPollTimer = nil
        updateQuotaRefreshControls(); fetchAccountList(notifyPage: true); overview?.update(force: true)
    }
    func updateQuotaRefreshControls() {
        let available = reachable && (pendingAccountTaskId == nil || quotaRefreshing)
        func apply(_ view: NSView) {
            if let control = view as? QuotaRefreshButton {
                let cid = control.identifier?.rawValue ?? ""
                control.applyGlobalRefreshState(globalBusy: quotaRefreshing, available: available, error: quotaRefreshError, cardBusy: refreshingAccountIds.contains(cid))
            }
            for child in view.subviews { apply(child) }
        }
        apply(pageHost)
        updateStatusItemState()
        if menuTracking || menuPopover?.isShown == true {
            menuPanelController?.syncFromAssistant()
        }
        guard menuTracking else { return }
        openMenuQuotaView?.refreshButton.setRefreshState(busy: quotaRefreshing, available: available, error: quotaRefreshError)
        let active = resolvedMenuAccount()
        if let active {
            openMenuQuotaView?.label.stringValue = QuotaPresentation.menuQuotaText(active)
            openMenuQuotaView?.apply(account: active, available: available)
        } else {
            openMenuQuotaView?.apply(account: nil, placeholder: reachable ? "尚未保存账号" : "正在等待本机服务…", available: available)
        }
    }
    @objc func showPanel() {
        if window == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 1024, height: 710),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            window.titlebarAppearsTransparent = true
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.minSize = NSSize(width: 880, height: 580)
            window.setFrameAutosaveName("GravityBox.MainWindow.v08")
            window.toolbar = nil
            window.titleVisibility = .hidden
            window.title = "GravityBox"
            window.titlebarSeparatorStyle = .none
            window.isMovableByWindowBackground = true

            let split = NSSplitViewController()
            split.view.wantsLayer = true
            let sideController = NSViewController()
            let side = NSVisualEffectView()
            side.material = .sidebar
            side.blendingMode = .behindWindow
            side.state = .active
            side.wantsLayer = true
            sideController.view = side

            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("navigation"))
            column.resizingMask = .autoresizingMask
            sidebar.addTableColumn(column)
            sidebar.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
            sidebar.headerView = nil
            sidebar.rowHeight = 36
            sidebar.style = .plain
            sidebar.backgroundColor = .clear
            sidebar.selectionHighlightStyle = .none
            sidebar.intercellSpacing = NSSize(width: 0, height: 4)
            sidebar.dataSource = self
            sidebar.delegate = self
            sidebar.setAccessibilityLabel("导航")
            sidebar.addSubview(pillSelectionView, positioned: .below, relativeTo: nil)
            pillSelectionView.autoresizingMask = [.width]

            let scroll = NSScrollView()
            scroll.documentView = sidebar
            scroll.hasVerticalScroller = false
            scroll.drawsBackground = false

            let brandHeader = NSView()
            let brandIconView: NSImageView = {
                if let mark = Design.brandMarkImage() {
                    let iv = NSImageView(image: mark)
                    iv.imageScaling = .scaleProportionallyUpOrDown
                    return iv
                } else {
                    return symbol("sparkles", size: 16, color: Design.blue)
                }
            }()
            brandIconView.translatesAutoresizingMaskIntoConstraints = false
            let brandLabel = text("GravityBox", size: 14.5, weight: .semibold, color: .labelColor)
            brandLabel.translatesAutoresizingMaskIntoConstraints = false
            brandHeader.addSubview(brandIconView)
            brandHeader.addSubview(brandLabel)
            NSLayoutConstraint.activate([
                brandIconView.leadingAnchor.constraint(equalTo: brandHeader.leadingAnchor, constant: 12),
                brandIconView.centerYAnchor.constraint(equalTo: brandHeader.centerYAnchor),
                brandIconView.widthAnchor.constraint(equalToConstant: 20),
                brandIconView.heightAnchor.constraint(equalToConstant: 20),
                brandLabel.leadingAnchor.constraint(equalTo: brandIconView.trailingAnchor, constant: 8),
                brandLabel.centerYAnchor.constraint(equalTo: brandHeader.centerYAnchor),
                brandLabel.trailingAnchor.constraint(lessThanOrEqualTo: brandHeader.trailingAnchor, constant: -8),
                brandHeader.heightAnchor.constraint(equalToConstant: 28)
            ])

            let installBtn = SidebarLaunchButton(
                title: "安装更新",
                symbolName: "arrow.down.circle",
                isUpdatePrompt: true,
                target: self,
                action: #selector(installUpdateFromSidebar)
            )
            installBtn.isHidden = true
            installUpdateButton = installBtn

            let globalOpenBtn = SidebarLaunchButton(title: "打开 Antigravity", target: self, action: #selector(openAntigravity))
            launchApplicationButton = globalOpenBtn

            serviceFootnoteLabel.alignment = .left
            serviceFootnoteLabel.lineBreakMode = .byTruncatingTail
            serviceFootnoteLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            updateServiceFootnote()

            let footnoteBox = NSView()
            footnoteBox.addSubview(serviceFootnoteLabel)
            serviceFootnoteLabel.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                serviceFootnoteLabel.leadingAnchor.constraint(equalTo: footnoteBox.leadingAnchor, constant: 12),
                serviceFootnoteLabel.trailingAnchor.constraint(lessThanOrEqualTo: footnoteBox.trailingAnchor, constant: -8),
                serviceFootnoteLabel.topAnchor.constraint(equalTo: footnoteBox.topAnchor),
                serviceFootnoteLabel.bottomAnchor.constraint(equalTo: footnoteBox.bottomAnchor)
            ])

            let bottomStack = vertical([footnoteBox, installBtn, globalOpenBtn], spacing: 6)
            bottomStack.detachesHiddenViews = true
            footnoteBox.isHidden = reachable
            let sideStack = vertical([brandHeader, scroll, bottomStack], spacing: 10)
            side.addSubview(sideStack)
            sideStack.translatesAutoresizingMaskIntoConstraints = false
            let sideSeparator = SidebarSeparatorView()
            sideSeparator.translatesAutoresizingMaskIntoConstraints = false
            side.addSubview(sideSeparator)
            NSLayoutConstraint.activate([
                sideSeparator.trailingAnchor.constraint(equalTo: side.trailingAnchor),
                sideSeparator.topAnchor.constraint(equalTo: side.topAnchor),
                sideSeparator.bottomAnchor.constraint(equalTo: side.bottomAnchor),
                sideSeparator.widthAnchor.constraint(equalToConstant: 1),
                sideStack.leadingAnchor.constraint(equalTo: side.leadingAnchor, constant: 12),
                sideStack.trailingAnchor.constraint(equalTo: side.trailingAnchor, constant: -12),
                sideStack.topAnchor.constraint(equalTo: side.safeAreaLayoutGuide.topAnchor, constant: 16),
                sideStack.bottomAnchor.constraint(equalTo: side.bottomAnchor, constant: -14)
            ])
            fillWidth(brandHeader, in: sideStack)
            fillWidth(scroll, in: sideStack)
            fillWidth(bottomStack, in: sideStack)
            fillWidth(footnoteBox, in: bottomStack)
            fillWidth(installBtn, in: bottomStack)
            fillWidth(globalOpenBtn, in: bottomStack)
            syncUpdatePromptControls()
            scroll.setContentHuggingPriority(.defaultLow, for: .vertical)

            let left = NSSplitViewItem(sidebarWithViewController: sideController)
            left.minimumThickness = 190
            left.maximumThickness = 210
            left.canCollapse = false
            split.addSplitViewItem(left)

            let content = NSViewController()
            let root = SurfaceView()
            content.view = root
            let rootStack = vertical([pageHost], spacing: 0)
            root.addSubview(rootStack)
            rootStack.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                rootStack.leadingAnchor.constraint(equalTo: root.leadingAnchor),
                rootStack.trailingAnchor.constraint(equalTo: root.trailingAnchor),
                rootStack.topAnchor.constraint(equalTo: root.topAnchor),
                rootStack.bottomAnchor.constraint(equalTo: root.bottomAnchor)
            ])
            fillWidth(pageHost, in: rootStack)
            pageHost.setContentHuggingPriority(.defaultLow, for: .vertical)
            split.addSplitViewItem(NSSplitViewItem(viewController: content))
            window.contentViewController = split
            self.window = window
            Design.applyControls(split.view)
            currentPage = min(names.count - 1, max(0, configuration.value.lastPage))
            sidebar.selectRowIndexes(IndexSet(integer: currentPage), byExtendingSelection: false)
            navigate(currentPage)
            updateNavigationAppearance()
            let restored = window.setFrameUsingName("GravityBox.MainWindow.v08")
            if window.frame.width < window.minSize.width || window.frame.height < window.minSize.height {
                var clampedFrame = window.frame
                clampedFrame.size.width = max(clampedFrame.size.width, window.minSize.width)
                clampedFrame.size.height = max(clampedFrame.size.height, window.minSize.height)
                window.setFrame(clampedFrame, display: false)
            }
            let visible = NSScreen.screens.contains {
                $0.visibleFrame.intersection(window.frame).width >= 120 &&
                $0.visibleFrame.intersection(window.frame).height >= 100
            }
            if !restored || !visible { window.center() }
        }
        #if !NATIVE_UI_TEST
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        #endif
        configureRefreshTimer()
        if quotaRefreshTimer == nil { configureQuotaRefreshTimer() }
        refresh()
    }
    func numberOfRows(in tableView: NSTableView) -> Int { names.count }
    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let view = SidebarRowView()
        view.navigationSelected = sidebar.selectedRow == row
        return view
    }
    private func navTextColor(selected: Bool) -> NSColor {
        guard selected else { return Design.primary.withAlphaComponent(0.84) }
        return NSColor(name: nil) { app in
            app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? .white
                : Design.blue
        }
    }
    private func navIconColor(selected: Bool) -> NSColor {
        guard selected else { return Design.secondary }
        return NSColor(name: nil) { app in
            app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(srgbRed: 0.38, green: 0.68, blue: 1.0, alpha: 1.0)
                : Design.blue
        }
    }
    private func navSymbolName(row: Int, selected: Bool) -> String {
        let outline = ["square.grid.2x2", "person.2", "chart.bar", "gearshape"][row]
        let filled = ["square.grid.2x2.fill", "person.2.fill", "chart.bar.fill", "gearshape.fill"][row]
        return selected ? filled : outline
    }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let cell = NSTableCellView()
        let selected = sidebar.selectedRow == row
        let label = text(names[row], size: 13, weight: selected ? .semibold : .medium, color: navTextColor(selected: selected))
        cell.textField = label
        let icon = symbol(navSymbolName(row: row, selected: selected), size: 14.5, color: navIconColor(selected: selected))
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 14.5, weight: selected ? .semibold : .medium)
        cell.imageView = icon
        let content = horizontal([icon, label], spacing: 10)
        content.alignment = .centerY
        cell.addSubview(content)
        content.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 12),
            content.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            content.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -10)
        ])
        cell.setAccessibilityLabel(names[row])
        return cell
    }
    func tableViewSelectionDidChange(_ notification: Notification) {
        updateNavigationAppearance()
        let row = sidebar.selectedRow
        if row >= 0 { navigate(row) }
    }
    func updateNavigationAppearance() {
        let selected = sidebar.selectedRow
        if selected >= 0 && selected < names.count {
            let rowRect = sidebar.rect(ofRow: selected)
            if rowRect.width > 0 && rowRect.height > 0 {
                pillSelectionView.isHidden = false
                pillSelectionView.slide(to: rowRect, in: sidebar)
            }
        } else {
            pillSelectionView.isHidden = true
        }
        for row in names.indices {
            let isCurrent = row == selected
            (sidebar.rowView(atRow: row, makeIfNecessary: false) as? SidebarRowView)?.navigationSelected = isCurrent
            if let cell = sidebar.view(atColumn: 0, row: row, makeIfNecessary: false) as? NSTableCellView {
                cell.textField?.font = .systemFont(ofSize: 13, weight: isCurrent ? .semibold : .medium)
                cell.textField?.textColor = navTextColor(selected: isCurrent)
                if let image = cell.imageView {
                    image.image = NSImage(systemSymbolName: navSymbolName(row: row, selected: isCurrent), accessibilityDescription: nil)
                    image.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 14.5, weight: isCurrent ? .semibold : .medium)
                    image.contentTintColor = navIconColor(selected: isCurrent)
                }
            }
        }
    }

    func currentContentPage() -> NSView? {
        switch currentPage {
        case 1: return accountsPage?.view
        case 2: return usagePage?.view
        case 3: return preferencesController?.view
        default: return overview?.view
        }
    }

    func selectPage(_ index: Int) {
        guard names.indices.contains(index), window?.activeSheetWindow == nil else { return }; showPanel()
        if sidebar.selectedRow == index { navigate(index) }
        else { sidebar.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
        updateNavigationAppearance()
    }
    @objc func menuNavigate(_ item: NSMenuItem) { selectPage(item.tag) }
    func navigate(_ index: Int) {
        guard names.indices.contains(index) else { return }
        let navSignpost = PerformanceSignpost.begin("NavigatePage")
        defer { PerformanceSignpost.end("NavigatePage", navSignpost) }
        let hadContent = !pageHost.subviews.isEmpty
        if index == currentPage && hadContent { return }
        let previousPage = currentPage
        if let usagePage { usageSelectedPeriod = usagePage.periodSegment.selectedSegment; if let scroll = usagePage.view as? NSScrollView { usageScrollOrigin = scroll.contentView.bounds.origin } }
        currentPage = index
        if configuration.value.lastPage != index {
            configuration.value.lastPage = index
            scheduleConfigurationSave()
        }
        let content: NSView
        let isNewPage: Bool
        switch index {
        case 1:
            isNewPage = accountsPage == nil
            let page = accountsPage ?? AccountsPage(app: self)
            accountsPage = page
            page.update()
            content = page.view
        case 2:
            isNewPage = usagePage == nil
            let page = usagePage ?? UsagePage(app: self)
            usagePage = page
            page.update()
            content = page.view
        case 3:
            isNewPage = preferencesController == nil
            let page = preferencesController ?? PreferencesController(app: self)
            preferencesController = page
            page.update()
            content = page.view
        default:
            isNewPage = overview == nil
            let page = overview ?? DashboardPage(app: self)
            overview = page
            page.update()
            content = page.view
        }
        let oldViews = pageHost.subviews.filter { $0 !== content }
        let animateFade = hadContent && Design.shouldAnimate(in: pageHost)
        if !animateFade {
            for oldView in oldViews {
                oldView.layer?.removeAllAnimations()
                oldView.removeFromSuperview()
                oldView.alphaValue = 1.0
            }
        }
        content.layer?.removeAllAnimations()
        content.wantsLayer = true
        if content.superview !== pageHost {
            pageHost.addSubview(content)
            pin(content, to: pageHost)
        } else {
            pageHost.addSubview(content)
        }
        if isNewPage { Design.applyControls(content) }
        pageHost.layoutSubtreeIfNeeded()
        window?.makeFirstResponder(sidebar); window?.title = "GravityBox"; updateViews()
        if animateFade {
            let offsetY: CGFloat = index > previousPage ? -6.0 : 6.0
            content.alphaValue = 0.0
            content.layer?.transform = CATransform3DMakeTranslation(0, offsetY, 0)
            for oldView in oldViews {
                oldView.layer?.removeAllAnimations()
                oldView.wantsLayer = true
            }
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.22
                ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1.0, 0.36, 1.0)
                content.animator().alphaValue = 1.0
                content.layer?.transform = CATransform3DIdentity
                for oldView in oldViews {
                    oldView.animator().alphaValue = 0.0
                }
            }, completionHandler: { [weak self] in
                guard let self else { return }
                content.layer?.transform = CATransform3DIdentity
                let active = self.currentContentPage()
                for oldView in oldViews {
                    if oldView !== active && oldView.superview === self.pageHost {
                        oldView.removeFromSuperview()
                        oldView.alphaValue = 1.0
                        oldView.layer?.transform = CATransform3DIdentity
                    }
                }
            })
        } else {
            content.alphaValue = 1.0
            content.layer?.transform = CATransform3DIdentity
        }
    }
    func configureQuotaRefreshTimer() {
        quotaRefreshTimer?.invalidate(); quotaRefreshTimer = nil
        let minutes = configuration.value.quotaRefreshMinutes
        guard [5, 10, 15, 30, 60].contains(minutes), !quitting else { return }
        quotaRefreshTimer = Timer.scheduledTimer(withTimeInterval: TimeInterval(minutes * 60), repeats: true) { [weak self] _ in
            guard let self, self.reachable, self.pendingAccountTaskId == nil else { return }; self.refreshAccountQuotas()
        }
    }
    func configureRefreshTimer(){
        guard !quitting else { return }
        timer?.invalidate()
        // 仅在窗口可见或状态栏菜单展开时采用 3s 前台节奏；无窗口/隐藏/遮挡驻留时统一降频至 12s。
        let visible = menuTracking || contentVisible
        timer=Timer.scheduledTimer(withTimeInterval:visible ? 3:12,repeats:true){[weak self]_ in self?.refresh()};timer?.tolerance=visible ? 0.5:3
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }
    func windowWillClose(_ notification:Notification){DispatchQueue.main.async{[weak self]in self?.configureRefreshTimer()}}
    func windowDidMiniaturize(_ notification:Notification){configureRefreshTimer()}
    func windowDidDeminiaturize(_ notification:Notification){configureRefreshTimer();refresh()}
    func windowDidChangeOcclusionState(_ notification:Notification){configureRefreshTimer()}

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showPanel(); return true }
    @objc func showAccounts() { selectPage(1) }
    @objc func showUsage() { selectPage(2) }
    @objc func showSettings() { selectPage(3) }
    func setTranslationEnabled(_ enable: Bool) {
        let previousStatus = statusValue
        translationCommandGeneration += 1
        let commandGen = translationCommandGeneration
        pendingTranslationTarget = enable
        statusValue.translationEnabled = enable
        if enable {
            if statusValue.mode == "paused" || statusValue.mode == "error" || statusValue.mode == "starting" {
                statusValue.mode = "waiting"
            }
        } else {
            statusValue.mode = "paused"
        }
        updateViews()
        let sendCommand = { [weak self] in
            guard let self, commandGen == self.translationCommandGeneration else { return }
            self.bridge.send(["command": enable ? "resume" : "pause"]) { [weak self] result in
                DispatchQueue.main.async {
                    guard let self, commandGen == self.translationCommandGeneration else { return }
                    self.pendingTranslationTarget = nil
                    switch result {
                    case .success(let value):
                        if let raw = value["status"] as? [String: Any] {
                            self.reachable = true
                            self.recoveryAttempts = 0
                            self.statusValue = self.mergeStatusSnapshot(raw, previous: self.statusValue)
                            self.updateViews()
                        }
                        self.refresh()
                    case .failure(let error):
                        self.statusValue.translationEnabled = previousStatus.translationEnabled
                        self.updateViews()
                        self.showMessage(error.localizedDescription, error: true)
                        self.refresh()
                    }
                }
            }
        }
        if !reachable && !bridge.isOwnedProcessRunning {
            recoveryAttempts = 0
            nextRecoveryAt = .distantPast
            bridge.launch { _ in sendCommand() }
        } else {
            sendCommand()
        }
    }
    func effectiveHudEnabled() -> Bool {
        if let pending = pendingHudTarget { return pending }
        if let live = statusValue.hudEnabled { return live }
        return configuration?.value.hudEnabled ?? true
    }
    func setHudEnabled(_ enable: Bool) {
        let previousStatus = statusValue
        let previousConfig = configuration.value.hudEnabled
        hudCommandGeneration += 1
        let commandGen = hudCommandGeneration
        pendingHudTarget = enable
        statusValue.hudEnabled = enable
        configuration.value.hudEnabled = enable
        try? configuration.save()
        updateViews()
        bridge.send(["command": "hud_set", "enabled": enable]) { [weak self] result in
            DispatchQueue.main.async {
                guard let self, commandGen == self.hudCommandGeneration else { return }
                self.pendingHudTarget = nil
                switch result {
                case .success(let value):
                    if let raw = value["status"] as? [String: Any] {
                        self.reachable = true
                        self.recoveryAttempts = 0
                        self.statusValue = self.mergeStatusSnapshot(raw, previous: self.statusValue)
                    }
                    self.updateViews()
                case .failure(let error):
                    self.statusValue.hudEnabled = previousStatus.hudEnabled
                    self.configuration.value.hudEnabled = previousConfig
                    try? self.configuration.save()
                    self.updateViews()
                    self.showMessage(error.localizedDescription, error: true)
                }
            }
        }
    }
    @objc func toggleTranslation() {
        setTranslationEnabled(!statusValue.enabled)
    }
    @objc func toggleHud() {
        setHudEnabled(!effectiveHudEnabled())
    }
    @objc func openAntigravity() {
        #if NATIVE_UI_TEST
        openedApplications += 1; return
        #else
        suppressLifecycleAutoQuit(seconds: 30.0)
        let launchPath = DesktopApplicationTarget.preferredLaunchPath(fallbackChannel: Self.applicationChannel)
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        config.createsNewApplicationInstance = false
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: launchPath), configuration: config) { [weak self] _, error in
            if let error {
                DispatchQueue.main.async { self?.showMessage(error.localizedDescription, error: true) }
            }
        }
        #endif
    }

    func relaunchAntigravityAfterSwitch(attemptsRemaining: Int = 3) {
        #if NATIVE_UI_TEST
        openedApplications += 1
        return
        #else
        suppressLifecycleAutoQuit(seconds: 30.0)
        let launchPath = DesktopApplicationTarget.preferredLaunchPath(fallbackChannel: Self.applicationChannel)
        if attemptsRemaining <= 1 {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                proc.arguments = ["-a", launchPath]
                proc.standardOutput = FileHandle.nullDevice
                proc.standardError = FileHandle.nullDevice
                let launchError: Error? = {
                    do {
                        try proc.run()
                        proc.waitUntilExit()
                        return proc.terminationStatus == 0 ? nil : BackendFailure(message: "open exited with \(proc.terminationStatus)")
                    } catch {
                        return error
                    }
                }()
                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 1.2) { [weak self] in
                    guard let self else { return }
                    let running = DispatchQueue.main.sync { Self.isAntigravityRunning() }
                    if !running {
                        DispatchQueue.main.async {
                            let detail = launchError?.localizedDescription ?? "请手动打开 Antigravity"
                            self.showMessage("账号已切换，但自动重启 Antigravity 失败：\(detail)", error: true)
                        }
                    }
                }
            }
            return
        }

        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        config.createsNewApplicationInstance = false
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: launchPath), configuration: config) { [weak self] app, error in
            guard let self else { return }
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 1.2) { [weak self] in
                guard let self else { return }
                let running = DispatchQueue.main.sync { Self.isAntigravityRunning() || (app != nil && app?.isTerminated == false) }
                if running {
                    DispatchQueue.main.async { self.antigravityWasRunning = true }
                    return
                }
                if attemptsRemaining > 1 {
                    DispatchQueue.main.async {
                        self.relaunchAntigravityAfterSwitch(attemptsRemaining: attemptsRemaining - 1)
                    }
                } else if let error {
                    DispatchQueue.main.async {
                        self.showMessage("账号已切换，但自动重启 Antigravity 失败：\(error.localizedDescription)", error: true)
                    }
                }
            }
        }
        #endif
    }
    static var antigravityBundlePath: String { DesktopApplicationTarget.preferredLaunchPath(fallbackChannel: applicationChannel) }
    static let lifecycleAgentLabel = "local.gravitybox.lifecycle"

    static func isAntigravityApp(_ app: NSRunningApplication) -> Bool {
        DesktopApplicationTarget.matchesAny(app)
    }

    static func isAntigravityRunning() -> Bool {
        NSWorkspace.shared.runningApplications.contains(where: isAntigravityApp)
    }

    func installAntigravityLifecycleObserver() {
        #if !NATIVE_UI_TEST
        antigravityWasRunning = Self.isAntigravityRunning()
        let nc = NSWorkspace.shared.notificationCenter
        if let obs = workspaceLaunchObserver { nc.removeObserver(obs) }
        if let obs = workspaceTerminateObserver { nc.removeObserver(obs) }
        workspaceLaunchObserver = nc.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let self else { return }
            if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, Self.isAntigravityApp(app) {
                self.antigravityWasRunning = true
            } else if Self.isAntigravityRunning() {
                self.antigravityWasRunning = true
            }
        }
        workspaceTerminateObserver = nc.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let self else { return }
            let matchedApp = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication).map(Self.isAntigravityApp) ?? false
            guard matchedApp || (self.antigravityWasRunning && !Self.isAntigravityRunning()) else { return }
            self.checkAntigravityExitedAndQuitIfNeeded()
        }
        #endif
    }

    private func checkAntigravityExitedAndQuitIfNeeded() {
        #if !NATIVE_UI_TEST
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self else { return }
            if Self.isAntigravityRunning() {
                self.antigravityWasRunning = true
                return
            }
            let wasRunning = self.antigravityWasRunning
            self.antigravityWasRunning = false
            guard wasRunning,
                  self.configuration?.value.syncAntigravityLifecycle == true,
                  !self.quitting,
                  Date() >= self.suppressLifecycleAutoQuitUntil else { return }
            self.stopBackendAndQuit()
        }
        #endif
    }

    func syncLifecycleAgentRegistration() {
        #if !NATIVE_UI_TEST
        antigravityWasRunning = Self.isAntigravityRunning()
        let enabled = configuration?.value.syncAntigravityLifecycle == true
        let launchAgentsDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents")
        let plistURL = launchAgentsDir.appendingPathComponent("\(Self.lifecycleAgentLabel).plist")
        let installedExec = "/Applications/GravityBox.app/Contents/MacOS/GravityBox"
        let executablePath = FileManager.default.isExecutableFile(atPath: installedExec)
            ? installedExec
            : (Bundle.main.executableURL?.path ?? installedExec)
        let uid = getuid()
        DispatchQueue.global(qos: .utility).async {
            let fm = FileManager.default
            func runLaunchctl(_ args: [String]) {
                let task = Process()
                task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
                task.arguments = args
                task.standardOutput = FileHandle.nullDevice
                task.standardError = FileHandle.nullDevice
                try? task.run()
                task.waitUntilExit()
            }
            if enabled {
                try? fm.createDirectory(at: launchAgentsDir, withIntermediateDirectories: true)
                let plist: [String: Any] = [
                    "Label": Self.lifecycleAgentLabel,
                    "ProgramArguments": [executablePath, "--lifecycle-agent"],
                    "RunAtLoad": true,
                    "KeepAlive": true,
                    "ProcessType": "Background"
                ]
                if let data = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) {
                    try? data.write(to: plistURL, options: .atomic)
                    runLaunchctl(["bootout", "gui/\(uid)", plistURL.path])
                    runLaunchctl(["bootstrap", "gui/\(uid)", plistURL.path])
                }
            } else {
                if fm.fileExists(atPath: plistURL.path) {
                    runLaunchctl(["bootout", "gui/\(uid)", plistURL.path])
                    try? fm.removeItem(at: plistURL)
                } else {
                    runLaunchctl(["bootout", "gui/\(uid)/\(Self.lifecycleAgentLabel)"])
                }
            }
        }
        #endif
    }

    @objc func about() {
        let version = updateManager.currentVersion
        var buildStr = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if buildStr.lowercased().hasPrefix("build ") {
            buildStr = String(buildStr.dropFirst(6)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let infoURL = Bundle.main.resourceURL?.appendingPathComponent("build-info.json"),
           let data = try? Data(contentsOf: infoURL),
           let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let rev = (info["revision"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !rev.isEmpty, buildStr != rev {
            buildStr = buildStr.isEmpty ? rev : "\(buildStr) · \(rev)"
        }
        let resolvedBuild = buildStr.isEmpty ? updateManager.currentBuildDisplay : buildStr
        guard let window, window.isVisible, window.activeSheetWindow == nil else {
            let alert = NSAlert(); alert.messageText = "GravityBox"; alert.informativeText = "版本 \(version)\n构建 \(resolvedBuild)"; alert.addButton(withTitle: "关闭")
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
            return
        }
        let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 236), styleMask: [.titled], backing: .buffered, defer: false)
        sheet.isReleasedWhenClosed = false
        sheet.backgroundColor = .clear
        sheet.isOpaque = false
        let surface = SheetVisualEffectView()
        sheet.contentView = surface

        let iconView = NSImageView(image: Design.appIconImage() ?? NSImage())
        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 64),
            iconView.heightAnchor.constraint(equalToConstant: 64)
        ])

        let nameLabel = text("GravityBox", size: 18, weight: .bold, color: .labelColor)
        let versionBadge = pillBadge("版本 \(version) · 构建 \(resolvedBuild)", color: Design.blue)
        let descLabel = text("原生 macOS Antigravity 账号配额与汉化工作台", size: 11.5, color: Design.secondary)

        final class AboutSheetDismiss: NSObject {
            let host: NSWindow
            let sheet: NSWindow
            init(host: NSWindow, sheet: NSWindow) { self.host = host; self.sheet = sheet }
            @objc func close() { host.endSheet(sheet) }
        }
        let dismiss = AboutSheetDismiss(host: window, sheet: sheet)
        let closeBtn = button("完成", target: dismiss, action: #selector(AboutSheetDismiss.close))
        closeBtn.bezelColor = .controlAccentColor
        closeBtn.keyEquivalent = "\r"
        closeBtn.widthAnchor.constraint(greaterThanOrEqualToConstant: 88).isActive = true

        let stack = vertical([iconView, nameLabel, versionBadge, descLabel, closeBtn], spacing: 10)
        stack.alignment = .centerX
        stack.setCustomSpacing(6, after: nameLabel)
        stack.setCustomSpacing(16, after: descLabel)
        surface.addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: surface.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: surface.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: surface.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: surface.trailingAnchor, constant: -20)
        ])
        window.beginSheet(sheet) { _ in withExtendedLifetime(dismiss) {} }
    }
    func perform(_ payload: [String: Any], completion: (([String: Any]) -> Void)? = nil) {
        bridge.send(payload) { [weak self] result in switch result { case .success(let value): completion?(value); case .failure(let error): self?.showMessage(error.localizedDescription, error: true) } }
    }
    func fetchAccountList(notifyPage: Bool = true, completion: ((Result<[String: Any], Error>) -> Void)? = nil) {
        if let completion { accountListWaiters.append(completion) }
        if notifyPage { accountListPendingNotifyPage = true }
        guard !accountListInFlight else { return }
        accountListInFlight = true
        accountListGeneration += 1
        let generation = accountListGeneration
        lastAccountListFetchAt = Date()
        bridge.send(["command": "account_list"]) { [weak self] res in
            guard let self else { return }
            self.accountListInFlight = false
            let waiters = self.accountListWaiters
            let shouldNotifyPage = self.accountListPendingNotifyPage
            self.accountListWaiters.removeAll()
            self.accountListPendingNotifyPage = false
            if case .success(let val) = res, generation >= self.accountListGeneration, let list = val["accounts"] as? [[String: Any]] {
                self.lastFetchedAccountsRevision = self.statusValue.accountsRevision
                self.lastFetchedLiveEmail = self.statusValue.liveAccountEmail
                var resolvedActiveId = val["activeId"] as? String ?? (val["currentAccountId"] as? String ?? "")
                if !self.statusValue.liveAccountEmail.isEmpty,
                   let live = list.first(where: { ($0["email"] as? String ?? "").caseInsensitiveCompare(self.statusValue.liveAccountEmail) == .orderedSame }),
                   let id = live["id"] as? String {
                    resolvedActiveId = id
                }
                self.activeAccountId = resolvedActiveId
                self.cachedAccounts = list.enumerated().sorted { lhs, rhs in
                    let l = lhs.element["id"] as? String == resolvedActiveId
                    let r = rhs.element["id"] as? String == resolvedActiveId
                    return l == r ? lhs.offset < rhs.offset : l
                }.map(\.element)
                self.updateQuotaRefreshControls()
                if shouldNotifyPage { self.accountsPage?.fetch(val) }
            }
            for waiter in waiters { waiter(res) }
        }
    }
    func refresh(taskPollOnly: Bool = false) {
        #if !NATIVE_UI_TEST
        if Self.isAntigravityRunning() {
            antigravityWasRunning = true
        } else if antigravityWasRunning {
            checkAntigravityExitedAndQuitIfNeeded()
        }
        #endif
        guard !refreshInFlight, !quitting else { return }; refreshInFlight = true
        if let started = quotaRefreshStartedAt, Date().timeIntervalSince(started) > 45 { failPendingQuotaRefresh("刷新超时，请重试；保留上次配额") }
        let needTasks = taskPollOnly || pendingAccountTaskId != nil || quotaRefreshing
        let includeAccounts = !taskPollOnly && (menuTracking || (contentVisible && currentPage <= 1))
        bridge.send(["command": "status","includeTasks":needTasks,"includeAccounts":includeAccounts,"tasksSince":reachable ? lastTaskRevision:-1]) { [weak self] result in guard let self else { return }; self.refreshInFlight = false
            switch result {
            case .success(let value):
                self.updateManager.cleanupAfterSuccessfulLaunch()
                self.reachable = true; self.recoveryAttempts = 0; self.autoRestartAttempts = 0; var raw=value["status"] as? [String:Any] ?? [:];raw["taskRevision"]=value["taskRevision"];raw["runningTasks"]=value["runningTasks"];self.statusValue=self.mergeStatusSnapshot(raw, previous:self.statusValue);if let rows=value["tasks"] as? [[String:Any]]{self.taskRows=rows;self.lastTaskRevision=value["taskRevision"] as? Int ?? 0}
                if includeAccounts {
                    let accountsChanged = (!self.statusValue.accountsRevision.isEmpty && self.statusValue.accountsRevision != self.lastFetchedAccountsRevision) || self.statusValue.liveAccountEmail != self.lastFetchedLiveEmail
                    let periodicAccountRefreshDue = (self.menuTracking || (self.contentVisible && self.currentPage == 1)) && Date().timeIntervalSince(self.lastAccountListFetchAt) >= 15.0
                    if self.cachedAccounts.isEmpty || accountsChanged || periodicAccountRefreshDue {
                        self.fetchAccountList(notifyPage: true)
                    }
                }
                if let pending = self.pendingAccountTaskId, let task = self.taskRows.first(where: { $0["id"] as? String == pending && $0["state"] as? String != "running" }) {
                    self.pendingAccountTaskId = nil
                    if self.quotaRefreshing { self.finishQuotaRefresh(error: task["state"] as? String == "succeeded" ? nil : (task["message"] as? String ?? "配额刷新未完成")) }
                    else { self.showMessage(task["message"] as? String ?? "账号操作已结束", error: task["state"] as? String != "succeeded"); self.fetchAccountList(notifyPage: true); self.overview?.update(force: true) }
                }
            case .failure:
                self.reachable = false
                self.failPendingQuotaRefresh("本机服务连接中断，保留上次配额")
                if !self.bridge.isOwnedProcessRunning && !self.bridge.isRestarting && !self.selfHealingPending && self.recoveryAttempts < 3 && Date() >= self.nextRecoveryAt {
                    self.recoveryAttempts += 1; self.nextRecoveryAt = Date().addingTimeInterval(Double(self.recoveryAttempts * 10))
                    self.bridge.launch()
                }
            }
            self.updateViews()
        }
    }
    func failPendingQuotaRefresh(_ message: String) {
        guard quotaRefreshing || pendingAccountTaskId != nil else { return }
        quotaRefreshing = false; pendingAccountTaskId = nil; quotaRefreshStartedAt = nil
        quotaRefreshError = message; quotaRefreshPollTimer?.invalidate(); quotaRefreshPollTimer = nil
    }
    func scheduleSelfHealingRestart(reason: String) {
        guard !quitting, !bridge.isRestarting, !selfHealingPending else { return }
        let now = Date()
        if now.timeIntervalSince(lastAutoRestartAt) > 60.0 {
            autoRestartAttempts = 0
        }
        guard autoRestartAttempts < 3 else {
            NSLog("[GravityBox] 后台子进程短时间内连续异常退出 3 次，停止自动拉起并保留报错: %@", reason)
            return
        }
        autoRestartAttempts += 1
        lastAutoRestartAt = now
        selfHealingPending = true
        NSLog("[GravityBox] 后台子进程异常退出 (%@)，将在 1 秒后尝试自动自愈重启 (第 %d/3 次)...", reason, autoRestartAttempts)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self else { return }
            self.selfHealingPending = false
            guard !self.quitting, !self.reachable, !self.bridge.isOwnedProcessRunning else { return }
            self.bridge.launch { [weak self] result in
                guard let self else { return }
                switch result {
                case .success:
                    NSLog("[GravityBox] 后台子进程自愈重启成功，重新同步状态与用量。")
                    self.refresh()
                    if self.contentVisible && self.currentPage == 2 {
                        self.usagePage?.fetch()
                    }
                    if self.menuPopover?.isShown == true, let panel = self.menuPanelController {
                        let periodKey = MenuPanelController.periods[max(0, min(MenuPanelController.periods.count - 1, panel.selectedPeriod))]
                        self.fetchUsageSummary(period: periodKey, force: true, allowCached: false)
                    }
                case .failure(let error):
                    NSLog("[GravityBox] 后台子进程自愈重启失败: %@", error.localizedDescription)
                }
            }
        }
    }
    func updateServiceFootnote() {
        let isConnected = reachable
        serviceFootnoteLabel.superview?.isHidden = isConnected
        if isConnected {
            serviceFootnoteLabel.stringValue = ""
            return
        }
        let dotColor = accessibleWarningColor()
        let dotFont = NSFont.systemFont(ofSize: 8, weight: .bold)
        let textFont = NSFont.systemFont(ofSize: 10.5, weight: .medium)
        let attr = NSMutableAttributedString(
            string: "○ ",
            attributes: [.foregroundColor: dotColor, .font: dotFont]
        )
        attr.append(NSAttributedString(
            string: "等待本机服务…",
            attributes: [.foregroundColor: Design.secondary.withAlphaComponent(0.90), .font: textFont]
        ))
        serviceFootnoteLabel.attributedStringValue = attr
    }
    func updateViews() {
        item?.button?.toolTip = nil
        item?.button?.setAccessibilityLabel("GravityBox · "+(reachable ? statusValue.title:"连接已断开"))
        updateStatusItemState()
        updateServiceFootnote()
        if contentVisible {
            switch currentPage {
            case 0: overview?.update()
            case 2: usagePage?.update()
            case 3:
                preferencesController?.update()
                if preferencesController?.maintenanceSheet?.sheet.isVisible == true {
                    cachePage?.update()
                }
            default: break
            }
        }
        updateQuotaRefreshControls()
    }
    func showMessage(_ message: String, error: Bool = false) {
        guard error, !message.isEmpty else { lastOperationError = nil; pageHost.setAccessibilityHelp(nil); return }
        lastOperationError = message
        pageHost.setAccessibilityHelp(message)
        #if !NATIVE_UI_TEST
        guard presentedError == nil else { return }
        presentedError = message
        let alert = NSAlert(); alert.alertStyle = .warning
        alert.messageText = "操作未完成"; alert.informativeText = message
        alert.addButton(withTitle: "好")
        if let window, window.isVisible {
            var parent = window
            while let sheet = parent.activeSheetWindow { parent = sheet }
            alert.beginSheetModal(for: parent) { [weak self] _ in self?.presentedError = nil }
        } else {
            NSApp.activate(ignoringOtherApps: true)
            _ = alert.runModal()
            presentedError = nil
        }
        #endif
    }
    func watchState() {
        let fd = open(state.path, O_EVTONLY); guard fd >= 0 else { return }
        let statusURL = state.appendingPathComponent("status.json")
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write], queue: stateWatchQueue)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            self.stateWatchWorkItem?.cancel()
            let work = DispatchWorkItem { [weak self] in
                guard let self,
                      let data = try? Data(contentsOf: statusURL),
                      let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.bridge.ownedPID == nil || (raw["pid"] as? NSNumber)?.int32Value == self.bridge.ownedPID else { return }
                    let rawTaskRev = raw["taskRevision"] as? Int ?? 0
                    if self.reachable && rawTaskRev < self.statusValue.taskRevision { return }
                    let wasReachable = self.reachable
                    let taskChanged = self.statusValue.taskRevision != rawTaskRev
                    self.reachable = true
                    self.recoveryAttempts = 0
                    self.statusValue = self.mergeStatusSnapshot(raw, previous: self.statusValue)
                    self.updateViews()
                    if !wasReachable || (taskChanged && (self.pendingAccountTaskId != nil || self.quotaRefreshing)) {
                        self.refresh()
                    }
                }
            }
            self.stateWatchWorkItem = work
            self.stateWatchQueue.asyncAfter(deadline: .now() + 0.04, execute: work)
        }
        source.setCancelHandler { close(fd) }; source.resume(); directorySource = source
    }
    /// 合并 status.json 快照：其中缺失的账号字段沿用上一次 socket status 的值，避免账号/费用 UI 瞬时清空。
    private func mergeStatusSnapshot(_ raw: [String: Any], previous: LiveStatus) -> LiveStatus {
        var merged = LiveStatus(raw)
        if raw["translationEnabled"] == nil { merged.translationEnabled = previous.translationEnabled }
        if raw["hudEnabled"] == nil { merged.hudEnabled = previous.hudEnabled }
        if raw["activeAccountEmail"] == nil { merged.activeAccountEmail = previous.activeAccountEmail }
        if raw["activeFiveHourQuota"] == nil { merged.activeFiveHourQuota = previous.activeFiveHourQuota }
        if raw["activeSubscriptionTier"] == nil { merged.activeSubscriptionTier = previous.activeSubscriptionTier }
        if raw["accountsRevision"] == nil { merged.accountsRevision = previous.accountsRevision }
        if raw["liveAccountEmail"] == nil { merged.liveAccountEmail = previous.liveAccountEmail }
        if let target = pendingTranslationTarget {
            merged.translationEnabled = target
            if target {
                if merged.mode == "paused" || merged.mode == "error" || merged.mode == "starting" { merged.mode = "waiting" }
            } else {
                merged.mode = "paused"
            }
        }
        if let hudTarget = pendingHudTarget {
            merged.hudEnabled = hudTarget
        }
        if pendingHudTarget == nil, let authoritative = raw["hudEnabled"] as? Bool,
           let configuration, configuration.value.hudEnabled != authoritative {
            configuration.value.hudEnabled = authoritative
            try? configuration.save()
        }
        return merged
    }
    func syncUpdatePromptControls() {
        preferencesController?.refreshUpdateRowState()
        if let release = updateManager.availableRelease {
            installUpdateButton?.badgeText = "v\(release.version)"
            installUpdateButton?.toolTip = nil
            installUpdateButton?.isHidden = false
        } else {
            installUpdateButton?.badgeText = ""
            installUpdateButton?.toolTip = nil
            installUpdateButton?.isHidden = true
        }
    }
    @objc func installUpdateFromSidebar() {
        guard let release = updateManager.availableRelease else {
            checkForUpdatesFromMenu()
            return
        }
        if let active = window?.activeSheetWindow, active !== preferencesController?.updateSheet?.sheet {
            dismissAllSheetsAndPopovers()
        }
        showPanel()
        if let window {
            if preferencesController == nil {
                preferencesController = PreferencesController(app: self)
            }
            if preferencesController?.updateSheet == nil {
                preferencesController?.updateSheet = UpdateSheetController(app: self)
            }
            preferencesController?.updateSheet?.show(in: window)
        }
        updateManager.installRelease(release)
    }
    func configureAutoUpdateTimer() {
        autoUpdateTimer?.invalidate()
        autoUpdateTimer = nil
        #if !NATIVE_UI_TEST
        guard configuration?.value.autoUpdateEnabled == true else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            guard let self, !self.quitting, self.configuration?.value.autoUpdateEnabled == true else { return }
            self.updateManager.checkForUpdates(silent: true)
        }
        let t = Timer(timeInterval: 6 * 3600.0, repeats: true) { [weak self] _ in
            guard let self, !self.quitting, self.configuration?.value.autoUpdateEnabled == true else { return }
            self.updateManager.checkForUpdates(silent: true)
        }
        t.tolerance = 300.0
        RunLoop.main.add(t, forMode: .common)
        autoUpdateTimer = t
        #endif
    }
    func suppressLifecycleAutoQuit(seconds: TimeInterval) {
        let candidate = Date().addingTimeInterval(seconds)
        if candidate > suppressLifecycleAutoQuitUntil {
            suppressLifecycleAutoQuitUntil = candidate
        }
    }
    @objc func checkForUpdatesFromMenu() {
        if let active = window?.activeSheetWindow, active !== preferencesController?.updateSheet?.sheet {
            dismissAllSheetsAndPopovers()
        }
        showSettings()
        preferencesController?.showUpdateSheet()
    }
    @objc func quit() {
        performQuit()
    }

    func dismissAllSheetsAndPopovers() {
        closeMenuPopover()
        guard let window else { return }
        var safetyCounter = 0
        while let rootSheet = window.activeSheetWindow, safetyCounter < 8 {
            safetyCounter += 1
            var leaf = rootSheet
            var depth = 0
            while let child = leaf.activeSheetWindow, depth < 8 {
                leaf = child
                depth += 1
            }
            let parent = leaf.sheetParent ?? window
            parent.endSheet(leaf)
            leaf.orderOut(nil)
        }
    }

    func quitForUpdate() {
        quitting = true
        suppressLifecycleAutoQuit(seconds: 60)
        timer?.invalidate(); timer = nil
        quotaRefreshTimer?.invalidate(); quotaRefreshTimer = nil
        quotaRefreshPollTimer?.invalidate(); quotaRefreshPollTimer = nil
        autoUpdateTimer?.invalidate(); autoUpdateTimer = nil
        if configSaveWorkItem != nil {
            configSaveWorkItem?.cancel()
            configSaveWorkItem = nil
            try? configuration?.save()
        }
        dismissAllSheetsAndPopovers()
        window?.orderOut(nil)
        #if NATIVE_UI_TEST
        return
        #else
        bridge.forceStop(timeout: 2.0) { [weak self] in
            self?.directorySource?.cancel()
            self?.directorySource = nil
            NSApp.terminate(nil)
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.35) {
                Darwin._exit(0)
            }
        }
        #endif
    }

    private func performQuit() {
        guard !quitting else { return }
        stopBackendAndQuit()
    }
    private func stopBackendAndQuit() {
        guard !quitting else { return }; quitting = true
        timer?.invalidate(); quotaRefreshTimer?.invalidate(); quotaRefreshPollTimer?.invalidate(); autoUpdateTimer?.invalidate()
        if configSaveWorkItem != nil {
            configSaveWorkItem?.cancel()
            configSaveWorkItem = nil
            try? configuration?.save()
        }
        dismissAllSheetsAndPopovers()
        bridge.send(["command":"stop"]) { [weak self] result in
            guard let self else { return }
            if case .success = result { self.directorySource?.cancel(); NSApp.terminate(nil) }
            else if !self.bridge.isOwnedProcessRunning { self.directorySource?.cancel(); NSApp.terminate(nil) }
            else { self.quitting = false; self.configureRefreshTimer(); self.configureQuotaRefreshTimer(); self.configureAutoUpdateTimer(); self.showPanel(); self.showMessage("尚未确认撤销汉化，请稍后重试退出。", error:true) }
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { if quitting { return .terminateNow }; quit(); return .terminateCancel }
}

#if !NATIVE_UI_TEST
private enum AntigravityLifecycleAgent {
    private static var cachedConfigMtime: Date?
    private static var cachedSyncEnabled: Bool = false

    static func isSyncEnabled() -> Bool {
        let configURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/GravityBox/config.json")
        let mtime = (try? FileManager.default.attributesOfItem(atPath: configURL.path))?[.modificationDate] as? Date
        if let mtime, mtime == cachedConfigMtime {
            return cachedSyncEnabled
        }
        guard let data = try? Data(contentsOf: configURL),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            cachedConfigMtime = nil
            cachedSyncEnabled = false
            return false
        }
        cachedConfigMtime = mtime
        Assistant.applicationChannel = "stable"
        cachedSyncEnabled = (raw["syncAntigravityLifecycle"] as? Bool == true)
        return cachedSyncEnabled
    }

    static func isMainGravityBoxRunning() -> Bool {
        Assistant.findExistingMainPeer(excludingPid: getpid()) != nil
    }

    static func launchGravityBoxIfNeeded() {
        guard isSyncEnabled(), !isMainGravityBoxRunning() else { return }
        let installedURL = URL(fileURLWithPath: "/Applications/GravityBox.app")
        let bundleURL = FileManager.default.fileExists(atPath: installedURL.path) ? installedURL : Bundle.main.bundleURL
        let config = NSWorkspace.OpenConfiguration()
        config.activates = false
        config.createsNewApplicationInstance = false
        config.arguments = ["--launched-by-antigravity"]
        NSWorkspace.shared.openApplication(at: bundleURL, configuration: config, completionHandler: nil)
    }

    static func run() -> Never {
        if !isSyncEnabled() { exit(0) }
        var wasRunning = Assistant.isAntigravityRunning()
        let nc = NSWorkspace.shared.notificationCenter
        nc.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { note in
            if !isSyncEnabled() { exit(0) }
            if let launched = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
               Assistant.isAntigravityApp(launched) {
                wasRunning = true
                launchGravityBoxIfNeeded()
            }
        }
        nc.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { _ in
            if !Assistant.isAntigravityRunning() {
                wasRunning = false
            }
        }
        let timer = Timer(timeInterval: 6.0, repeats: true) { _ in
            if !isSyncEnabled() { exit(0) }
            let nowRunning = Assistant.isAntigravityRunning()
            if nowRunning && !wasRunning {
                wasRunning = true
                launchGravityBoxIfNeeded()
            } else if !nowRunning {
                wasRunning = false
            }
        }
        timer.tolerance = 1.5
        RunLoop.main.add(timer, forMode: .common)
        RunLoop.main.run()
        exit(0)
    }
}

@main struct GravityBoxMain {
    static func main() {
        if let i = CommandLine.arguments.firstIndex(of: "--install-update"), i + 1 < CommandLine.arguments.count {
            do { try UpdateInstaller.run(receiptURL: URL(fileURLWithPath: CommandLine.arguments[i + 1])); exit(0) }
            catch { fputs("GravityBox 更新未完成；恢复材料已保留。\n", stderr); exit(1) }
        }
        if CommandLine.arguments.contains("--lifecycle-agent") {
            AntigravityLifecycleAgent.run()
        }
        let app = NSApplication.shared
        let delegate = Assistant()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}

#endif
