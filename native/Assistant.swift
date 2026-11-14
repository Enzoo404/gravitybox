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

final class Assistant: NSObject, NSApplicationDelegate, NSWindowDelegate, NSPopoverDelegate, NSTableViewDataSource, NSTableViewDelegate {
    let names = ["总览", "账号", "用量", "设置", "关于"]
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
    var aboutPage: AboutPage?
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
    var usageWaitersByPeriod: [String: [(Result<[String: Any], Error>) -> Void]] = [:]
    var usageAutoHealAttemptsByPeriod: [String: Int] = [:]
    var usageAutoHealPendingPeriods = Set<String>()
    var singleAccountRefreshErrors: [String: String] = [:]
    private var popoverGlobalClickMonitor: Any?
    private var popoverLocalKeyMonitor: Any?
    var quotaRefreshStartedAt: Date?
    var recoveryAttempts = 0
    var autoRestartAttempts = 0
    var lastAutoRestartAt = Date.distantPast
    var selfHealingPending = false
    /// 汉化开关命令在途时的乐观目标：期间到达的陈旧状态快照不得把开关弹回旧状态。
    var pendingTranslationTarget: Bool?
    var translationCommandGeneration = 0
    var pendingHudTarget: Bool?
    var hudCommandGeneration = 0
    var nextRecoveryAt = Date.distantPast
    #if NATIVE_UI_TEST
    var confirmSwitchForTesting: ((String, @escaping (Bool) -> Void) -> Void)?
    #endif
    var quotaRefreshing = false
    var refreshingAccountIds = Set<String>()
    var quotaRefreshError: String?
    var quotaRefreshPollTimer: Timer?
    private var isBreathing = false
    private var breathingMotion: DesignMotion?
    var lastTaskRevision = -1
    var statusValue = LiveStatus()
    var taskRows: [[String: Any]] = []
    var reachable = false
    var quotaRefreshTimer: Timer?
    var autoUpdateTimer: Timer?
    lazy var updateManager = AppUpdateManager(app: self)
    var timer: Timer?
    var directorySource: DispatchSourceFileSystemObject?
    var refreshInFlight = false
    var quitting = false
    let serviceFootnoteLabel = text("", size: 10.5, color: Design.secondary)
    var configSaveWorkItem: DispatchWorkItem?
    private(set) var lastOperationError: String?
    private var presentedError: String?
    var lastAccountListFetchAt: Date = .distantPast
    var lastFetchedAccountsRevision = ""
    var lastFetchedLiveEmail = ""
    var accountListInFlight = false
    var accountListPendingNotifyPage = false
    var accountListGeneration = 0
    var accountListWaiters: [(Result<[String: Any], Error>) -> Void] = []
    private let stateWatchQueue = DispatchQueue(label: "local.gravitybox.state-watch", qos: .utility)
    private var stateWatchWorkItem: DispatchWorkItem?
    var antigravityWasRunning = false
    var suppressLifecycleAutoQuitUntil: Date = .distantPast
    var workspaceLaunchObserver: NSObjectProtocol?
    var workspaceTerminateObserver: NSObjectProtocol?
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
        return Design.activeBlue
    }
    private func navSymbolName(row: Int, selected: Bool) -> String {
        let outline = ["square.grid.2x2", "person.2", "chart.bar", "gearshape", "info.circle"][row]
        let filled = ["square.grid.2x2.fill", "person.2.fill", "chart.bar.fill", "gearshape.fill", "info.circle.fill"][row]
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
        case 4: return aboutPage?.view
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
        case 4:
            isNewPage = aboutPage == nil
            let page = aboutPage ?? AboutPage(app: self)
            aboutPage = page
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
    @objc func showAbout() { selectPage(4) }
    @objc func about() {
        showAbout()
    }
    func perform(_ payload: [String: Any], completion: (([String: Any]) -> Void)? = nil) {
        bridge.send(payload) { [weak self] result in switch result { case .success(let value): completion?(value); case .failure(let error): self?.showMessage(error.localizedDescription, error: true) } }
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
            case 4:
                aboutPage?.update()
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
        presentSheetAlert(alert) { [weak self] _ in self?.presentedError = nil }
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
    func mergeStatusSnapshot(_ raw: [String: Any], previous: LiveStatus) -> LiveStatus {
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
            scheduleConfigurationSave()
        }
        return merged
    }
    func presentSheetAlert(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        if window == nil || window?.isVisible != true {
            showPanel()
        }
        guard let rootWindow = self.window else {
            NSApp.activate(ignoringOtherApps: true)
            completion(alert.runModal())
            return
        }
        var parent = rootWindow
        while let sheet = parent.activeSheetWindow { parent = sheet }
        NSApp.activate(ignoringOtherApps: true)
        alert.beginSheetModal(for: parent, completionHandler: completion)
    }
}

#if !NATIVE_UI_TEST
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
