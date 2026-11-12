import Cocoa

// MARK: - Segmented Storage Composition Bar (Safe Junk vs Stateful Cache vs Protected Core Assets)
final class CacheCompositionBar: NSView {
    var safeBytes: Int64 = 0 { didSet { animateFractions() } }
    var statefulBytes: Int64 = 0 { didSet { animateFractions() } }
    var protectedBytes: Int64 = 0 { didSet { animateFractions() } }

    private var displayedSafeFrac: CGFloat = 0
    private var displayedStatefulFrac: CGFloat = 0
    private let motion = DesignMotion()

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: 8)
    }

    override init(frame frameRect: NSRect = .zero) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 8).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.progressIndicator)
        setAccessibilityLabel("存储空间构成占比条")
    }

    required init?(coder: NSCoder) { fatalError() }

    deinit {
        motion.cancel()
    }

    private func animateFractions() {
        let total = max(1, safeBytes + statefulBytes + protectedBytes)
        let targetSafe = safeBytes > 0 ? CGFloat(safeBytes) / CGFloat(total) : 0
        let targetStateful = statefulBytes > 0 ? CGFloat(statefulBytes) / CGFloat(total) : 0
        motion.cancel()
        let startSafe = displayedSafeFrac
        let startStateful = displayedStatefulFrac
        guard Design.shouldAnimate(in: self),
              (abs(targetSafe - startSafe) >= 0.005 || abs(targetStateful - startStateful) >= 0.005) else {
            displayedSafeFrac = targetSafe
            displayedStatefulFrac = targetStateful
            needsDisplay = true
            return
        }
        motion.animate(in: self, from: 0.0, to: 1.0, curve: .sweep, threshold: 0.005) { [weak self] progress in
            guard let self else { return }
            self.displayedSafeFrac = startSafe + (targetSafe - startSafe) * progress
            self.displayedStatefulFrac = startStateful + (targetStateful - startStateful) * progress
            self.needsDisplay = true
        } completion: { [weak self] in
            self?.displayedSafeFrac = targetSafe
            self?.displayedStatefulFrac = targetStateful
            self?.needsDisplay = true
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            motion.cancel()
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        let radius = bounds.height / 2
        let trackRect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let trackPath = NSBezierPath(roundedRect: trackRect, xRadius: radius, yRadius: radius)
        Design.track.setFill()
        trackPath.fill()

        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua

        guard safeBytes > 0 || statefulBytes > 0 || protectedBytes > 0 else { return }

        NSGraphicsContext.current?.saveGraphicsState()
        trackPath.addClip()

        let usableWidth = bounds.width
        var cursorX: CGFloat = 0

        if safeBytes > 0 && displayedSafeFrac > 0 {
            let w = max(8, min(usableWidth, round(usableWidth * displayedSafeFrac)))
            let segRect = NSRect(x: cursorX, y: 0, width: w, height: bounds.height)
            if let grad = NSGradient(starting: Design.blue.withAlphaComponent(0.75), ending: Design.blue) {
                grad.draw(in: segRect, angle: 0)
            } else {
                Design.blue.setFill()
                segRect.fill()
            }
            cursorX = min(usableWidth, cursorX + w + 2)
        }

        if statefulBytes > 0 && displayedStatefulFrac > 0 && cursorX < usableWidth {
            let w = max(6, min(usableWidth - cursorX, round(usableWidth * displayedStatefulFrac)))
            Design.color(0xD97706, 0xFBBF24).withAlphaComponent(0.88).setFill()
            NSRect(x: cursorX, y: 0, width: w, height: bounds.height).fill()
            cursorX = min(usableWidth, cursorX + w + 2)
        }

        if protectedBytes > 0 && cursorX < usableWidth {
            let protWidth = max(0, usableWidth - cursorX)
            if protWidth > 0 {
                let protColor = isDark
                    ? NSColor.white.withAlphaComponent(0.26)
                    : NSColor.black.withAlphaComponent(0.18)
                protColor.setFill()
                NSRect(x: cursorX, y: 0, width: protWidth, height: bounds.height).fill()
            }
        }

        NSGraphicsContext.current?.restoreGraphicsState()
    }
}

// MARK: - First-Class Storage & Maintenance Module ("存储与维护")
final class CachePage: NSObject {
    static let retentionChoices: [(title: String, days: Int)] = [
        ("保留近 7 天", 7),
        ("保留近 30 天", 30),
        ("全部非活跃", 0)
    ]

    unowned let app: Assistant
    let view: NSView

    let scanButton: InlineRefreshButton
    let clearButton: NSButton
    let retentionPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let recommendButton: NSButton
    let toggleAllButton: NSButton
    let snapshotPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let restoreLatestButton: NSButton
    let openTrashButton: NSButton
    let sheetDoneButton: NSButton

    // Hero Card Controls
    let reclaimableTitleLabel = text("可移入废纸篓体积", size: 11.5, weight: .medium, color: Design.secondary)
    let reclaimableValueLabel = text("正在扫描…", size: 28, weight: .bold)
    let selectedSummaryBadge = pillBadge("正在扫描", color: .secondaryLabelColor)
    let appStateLabel = text("", size: 11.5, color: Design.secondary)
    let compositionBar = CacheCompositionBar()
    let safeLegendLabel = text("无损缓存与临时文件 —", size: 11, color: Design.secondary)
    let statefulLegendWrap = NSStackView()
    let statefulLegendLabel = text("可瘦身历史 —", size: 11, color: Design.secondary)
    let protectedLegendLabel = text("核心数据 — 已保护", size: 11, color: Design.secondary)
    let lastScannedLabel = text("", size: 11, color: Design.secondary)

    // Breakdown Card Controls
    let breakdownWarningLabel = text("", size: 11, color: accessibleWarningColor())
    let itemsStack = NSStackView()

    // Footer Recovery Card Controls
    let recoveryTitleLabel = text("废纸篓安全恢复", size: 13, weight: .semibold, color: .labelColor)
    let recoverySubtitleLabel = text("清理项移入系统废纸篓并保留恢复点，支持一键原位还原", size: 11, color: Design.secondary)
    let feedbackLabel = text("", size: 11.5, color: Design.secondary, wrap: true)

    // State
    var entries: [[String: Any]] = []
    var protectedEntries: [[String: Any]] = []
    var snapshots: [[String: Any]] = []
    var selectedNames = Set<String>()
    var hasInitializedSelection = false
    var selectedRetentionDays: Int = 7
    var scanToken = ""
    var totalCacheBytes: Int64 = 0
    var safeCacheBytes: Int64 = 0
    var statefulCacheBytes: Int64 = 0
    var totalProtectedBytes: Int64 = 0
    var totalCacheFiles: Int = 0
    var uncertainConversationCount = 0
    var isTruncated = false
    var appRunning = false
    var browserBusy = false
    var scannedAt: Int = 0
    var busy = false
    private var restorableSnapshots: [[String: Any]] = []
    private var latestRestorableSnapshotId: String = ""
    private var lastFetchTime: Date = .distantPast
    private struct ItemRowControls {
        let rowView: NSStackView
        let checkbox: NSButton
        let titleLabel: NSTextField
        let subtitleLabel: NSTextField
        let sizeLabel: NSTextField
        var bytes: Int64
        var clearable: Bool
    }
    private var rowControlsByName: [String: ItemRowControls] = [:]
    private var renderedItemNames: [String] = []
    private var renderedLayoutSignature: String = ""

    private static let timeFormatter: DateFormatter = InterfaceText.shortTimeFormatter

    private static let snapshotDateFormatter: DateFormatter = InterfaceText.shortDateTimeFormatter

    init(app: Assistant) {
        self.app = app
        scanButton = InlineRefreshButton("重新扫描", width: 86, target: nil, action: #selector(scanNow))
        clearButton = button("清理选中项…", target: nil, action: #selector(clearSelectedCaches))
        clearButton.bezelColor = Design.blue
        clearButton.isEnabled = false

        retentionPopup.addItems(withTitles: Self.retentionChoices.map(\.title))
        retentionPopup.selectItem(at: 0)
        retentionPopup.setAccessibilityLabel("历史瘦身保留窗口")
        retentionPopup.translatesAutoresizingMaskIntoConstraints = false
        retentionPopup.widthAnchor.constraint(equalToConstant: 118).isActive = true

        recommendButton = button("推荐项", target: nil, action: #selector(selectRecommendedOnly))
        recommendButton.setAccessibilityLabel("推荐项 / 默认安全项")
        recommendButton.controlSize = .small
        recommendButton.isEnabled = false
        toggleAllButton = button("清空勾选", target: nil, action: #selector(toggleSelectAll))
        toggleAllButton.controlSize = .small
        toggleAllButton.isEnabled = false

        snapshotPopup.setAccessibilityLabel("选择恢复快照")
        snapshotPopup.translatesAutoresizingMaskIntoConstraints = false
        snapshotPopup.widthAnchor.constraint(equalToConstant: 192).isActive = true
        snapshotPopup.isHidden = true

        restoreLatestButton = button("原位恢复", target: nil, action: #selector(restoreLatestSnapshot))
        restoreLatestButton.controlSize = .small
        restoreLatestButton.isHidden = true
        openTrashButton = button("打开废纸篓", target: nil, action: #selector(openTrashFolder))
        openTrashButton.controlSize = .small
        sheetDoneButton = button("完成", target: nil, action: #selector(MaintenanceSheetController.closeSheet))
        sheetDoneButton.controlSize = .small
        sheetDoneButton.keyEquivalent = "\u{1b}"
        sheetDoneButton.isHidden = true

        let headerActions = horizontal([scanButton, clearButton, sheetDoneButton], spacing: 8)
        headerActions.detachesHiddenViews = true
        let root = pageStack(title: "存储与维护", actions: headerActions)
        root.spacing = 10

        // 1. Calm Hero Overview Card (Matches Overview & Usage visual density)
        reclaimableValueLabel.font = .monospacedDigitSystemFont(ofSize: 28, weight: .semibold)
        reclaimableValueLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        safeLegendLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        statefulLegendLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        protectedLegendLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        lastScannedLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)

        let heroLeftValueRow = horizontal([reclaimableValueLabel, selectedSummaryBadge], spacing: 10)
        heroLeftValueRow.alignment = .centerY
        let heroLeftCol = vertical([reclaimableTitleLabel, heroLeftValueRow], spacing: 4)
        let heroTopRow = horizontal([heroLeftCol, flexibleSpace(), appStateLabel], spacing: 12)
        heroTopRow.alignment = .bottom

        let blueDot = Self.makeLegendDot(color: Design.blue)
        let amberDot = Self.makeLegendDot(color: Design.color(0xD97706, 0xFBBF24))
        let grayDot = Self.makeLegendDot(color: NSColor.secondaryLabelColor.withAlphaComponent(0.55))

        let legendSafe = horizontal([blueDot, safeLegendLabel], spacing: 6)
        legendSafe.alignment = .centerY

        statefulLegendWrap.orientation = .horizontal
        statefulLegendWrap.alignment = .centerY
        statefulLegendWrap.spacing = 6
        statefulLegendWrap.addArrangedSubview(amberDot)
        statefulLegendWrap.addArrangedSubview(statefulLegendLabel)

        let legendProtected = horizontal([grayDot, protectedLegendLabel], spacing: 6)
        legendProtected.alignment = .centerY

        let compressiblePriority = NSLayoutConstraint.Priority(45)
        for lbl in [reclaimableTitleLabel, appStateLabel, safeLegendLabel, statefulLegendLabel, protectedLegendLabel, lastScannedLabel, breakdownWarningLabel, recoveryTitleLabel, recoverySubtitleLabel] {
            lbl.maximumNumberOfLines = 1
            lbl.lineBreakMode = .byTruncatingTail
            lbl.cell?.wraps = false
            lbl.cell?.truncatesLastVisibleLine = true
            lbl.setContentCompressionResistancePriority(compressiblePriority, for: .horizontal)
            lbl.setContentHuggingPriority(NSLayoutConstraint.Priority(10), for: .horizontal)
        }
        selectedSummaryBadge.setContentCompressionResistancePriority(compressiblePriority, for: .horizontal)

        let legendSpacer = flexibleSpace()
        legendSpacer.setContentHuggingPriority(NSLayoutConstraint.Priority(20), for: .horizontal)
        let legendRow = horizontal([legendSafe, statefulLegendWrap, legendProtected, legendSpacer, lastScannedLabel], spacing: 14)
        legendRow.alignment = .centerY

        let heroCard = group([heroTopRow, compositionBar, legendRow], inset: 13, spacing: 8)
        heroCard.cornerRadius = 14
        root.addArrangedSubview(heroCard)

        // 2. Clean Storage Governance Checklist Card (Zero row capsules, zero boxed row icons, zero mini bars)
        let breakdownTitleLabel = text("存储治理清单", size: 13, weight: .semibold)
        let selectionButtons = horizontal([retentionPopup, recommendButton, toggleAllButton], spacing: 6)
        selectionButtons.alignment = .centerY
        selectionButtons.setContentHuggingPriority(.required, for: .horizontal)
        selectionButtons.setContentCompressionResistancePriority(.required, for: .horizontal)
        let breakdownHeader = horizontal([breakdownTitleLabel, flexibleSpace(), selectionButtons], spacing: 12)
        breakdownHeader.alignment = .centerY

        breakdownWarningLabel.isHidden = true

        itemsStack.orientation = .vertical
        itemsStack.alignment = .leading
        itemsStack.spacing = 6.5

        let breakdownContent = vertical([breakdownHeader, breakdownWarningLabel, divider(), itemsStack], spacing: 8)
        for child in breakdownContent.arrangedSubviews { fillWidth(child, in: breakdownContent) }
        let breakdownCard = group([breakdownContent], inset: 13)
        breakdownCard.cornerRadius = 14
        root.addArrangedSubview(breakdownCard)

        // 3. Calm Single-Row Trash Recovery Card (Matches Settings row density)
        let recoveryIconBox = Self.makeIconBadge(symbolName: "clock.arrow.circlepath", tint: Design.blue, neutral: false)
        let recoveryTextCol = vertical([recoveryTitleLabel, recoverySubtitleLabel], spacing: 2)
        recoveryTextCol.alignment = .leading
        recoveryTextCol.setContentHuggingPriority(NSLayoutConstraint.Priority(30), for: .horizontal)
        recoveryTextCol.setContentCompressionResistancePriority(compressiblePriority, for: .horizontal)

        let recoveryActions = horizontal([snapshotPopup, restoreLatestButton, openTrashButton], spacing: 8)
        recoveryActions.detachesHiddenViews = true
        recoveryActions.alignment = .centerY
        recoveryActions.setContentHuggingPriority(.required, for: .horizontal)
        recoveryActions.setContentCompressionResistancePriority(.required, for: .horizontal)
        let recoverySpacer = flexibleSpace()
        recoverySpacer.setContentHuggingPriority(NSLayoutConstraint.Priority(20), for: .horizontal)
        let recoveryRow = horizontal([recoveryIconBox, recoveryTextCol, recoverySpacer, recoveryActions], spacing: 11)
        recoveryRow.alignment = .centerY

        let recoveryCard = group([recoveryRow], inset: 12)
        recoveryCard.cornerRadius = 14
        root.addArrangedSubview(recoveryCard)

        feedbackLabel.isHidden = true
        root.addArrangedSubview(feedbackLabel)

        view = scrollPage(root)
        super.init()

        scanButton.target = self
        clearButton.target = self
        retentionPopup.target = self
        retentionPopup.action = #selector(retentionWindowChanged)
        recommendButton.target = self
        toggleAllButton.target = self
        snapshotPopup.target = self
        snapshotPopup.action = #selector(snapshotSelectionChanged)
        restoreLatestButton.target = self
        openTrashButton.target = self
        Design.applyControls(view)
    }

    private static func makeLegendDot(color: NSColor) -> NSBox {
        let dot = NSBox()
        dot.boxType = .custom
        dot.cornerRadius = 3.5
        dot.borderWidth = 0
        dot.fillColor = color
        dot.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            dot.widthAnchor.constraint(equalToConstant: 7),
            dot.heightAnchor.constraint(equalToConstant: 7)
        ])
        return dot
    }

    private static func makeIconBadge(symbolName: String, tint: NSColor, neutral: Bool = false) -> NSBox {
        let box = NSBox()
        box.boxType = .custom
        box.cornerRadius = 7.5
        box.fillColor = NSColor(name: nil) { app in
            let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            if neutral {
                return isDark ? NSColor.white.withAlphaComponent(0.07) : NSColor.black.withAlphaComponent(0.045)
            }
            return tint.withAlphaComponent(isDark ? 0.18 : 0.10)
        }
        box.borderWidth = 0.5
        box.borderColor = NSColor(name: nil) { app in
            let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            if neutral {
                return isDark ? NSColor.white.withAlphaComponent(0.12) : NSColor.black.withAlphaComponent(0.08)
            }
            return tint.withAlphaComponent(isDark ? 0.32 : 0.18)
        }
        box.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            box.widthAnchor.constraint(equalToConstant: 28),
            box.heightAnchor.constraint(equalToConstant: 28)
        ])
        let iconView = symbol(symbolName, size: 13.5, color: tint)
        iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13.5, weight: .medium)
        box.addSubview(iconView)
        NSLayoutConstraint.activate([
            iconView.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: box.centerYAnchor)
        ])
        return box
    }

    private func formatBytes(_ bytes: Int64) -> String {
        if bytes <= 0 { return "0 B" }
        return ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    func update(force: Bool = false) {
        guard !busy else { return }
        let expired = Date().timeIntervalSince(lastFetchTime) >= 60.0
        if !force && !expired && !entries.isEmpty { return }
        fetch(force: force)
    }

    @objc func scanNow() {
        guard !busy else { return }
        feedbackLabel.isHidden = true
        fetch(force: true)
    }

    func fetch(force: Bool = false) {
        guard app.reachable, !busy else {
            if !app.reachable {
                if entries.isEmpty {
                    reclaimableValueLabel.stringValue = "—"
                    selectedSummaryBadge.title = "等待服务"
                    selectedSummaryBadge.tint = .secondaryLabelColor
                    clearButton.isEnabled = false
                    recommendButton.isEnabled = false
                    toggleAllButton.isEnabled = false
                }
                appStateLabel.stringValue = "等待本机服务…"
                scanButton.setBusy(false, available: false)
            }
            return
        }
        busy = true
        scanButton.setBusy(true, available: app.reachable)
        retentionPopup.isEnabled = false
        if entries.isEmpty {
            reclaimableValueLabel.stringValue = "正在扫描…"
            selectedSummaryBadge.title = "正在扫描"
            selectedSummaryBadge.tint = .secondaryLabelColor
            clearButton.isEnabled = false
            recommendButton.isEnabled = false
            toggleAllButton.isEnabled = false
        }
        app.bridge.send(["command": "maintenance_scan", "retentionDays": selectedRetentionDays]) { [weak self] response in
            guard let self else { return }
            self.busy = false
            self.scanButton.setBusy(false, available: self.app.reachable)
            self.retentionPopup.isEnabled = self.app.reachable
            self.lastFetchTime = Date()
            switch response {
            case .failure(let error):
                self.reclaimableValueLabel.stringValue = "扫描失败"
                self.selectedSummaryBadge.title = "请重试"
                self.selectedSummaryBadge.tint = .secondaryLabelColor
                self.breakdownWarningLabel.isHidden = false
                self.breakdownWarningLabel.stringValue = error.localizedDescription
                self.clearButton.isEnabled = false
            case .success(let value):
                self.applyScanPayload(value)
                self.app.preferencesController?.applyStorageScanPayload(value)
            }
        }
    }

    @objc func retentionWindowChanged() {
        let idx = max(0, min(Self.retentionChoices.count - 1, retentionPopup.indexOfSelectedItem))
        let nextDays = Self.retentionChoices[idx].days
        guard nextDays != selectedRetentionDays else { return }
        selectedRetentionDays = nextDays
        feedbackLabel.isHidden = true
        fetch(force: true)
    }

    private func defaultMetadata(for name: String) -> (title: String, subtitle: String, icon: String, category: String, defaultSelected: Bool, impactWarning: String?) {
        switch name {
        case "Cache":
            return ("网络与静态资源缓存", "界面静态资源与临时网络响应数据", "internaldrive", "safe", true, nil)
        case "Code Cache":
            return ("V8 字节码编译缓存", "JavaScript 与 WebAssembly 预编译加速缓存", "cpu", "safe", true, nil)
        case "GPUCache":
            return ("图形与着色器缓存", "Metal 与 WebGL 图形渲染管线编译产物", "sparkles.rectangle.stack", "safe", true, nil)
        case "DawnCache":
            return ("WebGPU 图形加速缓存", "Dawn 引擎图形管线与计算着色器缓存", "cube.transparent", "safe", true, nil)
        case "DawnWebGPUCache":
            return ("WebGPU 管线缓存", "WebGPU 渲染管线与着色器加速缓存", "cube.transparent", "safe", true, nil)
        case "DawnGraphiteCache":
            return ("Graphite 渲染管线缓存", "Chromium Graphite 图形管线预编译产物", "cube.transparent", "safe", true, nil)
        case "GraphiteDawnCache":
            return ("Graphite 着色器加速缓存", "现代图形后端预编译着色器与管线缓存", "sparkles.rectangle.stack", "safe", true, nil)
        case "ShaderCache":
            return ("底层着色器缓存", "图形驱动预编译着色器残留数据", "sparkles.rectangle.stack", "safe", true, nil)
        case "CachedData":
            return ("工作区运行编译缓存", "主进程与渲染进程预编译脚本缓存", "memorychip", "safe", true, nil)
        case "CachedExtensionVSIXs":
            return ("扩展安装包残留", "插件安装与更新遗留的 VSIX 压缩包", "shippingbox", "safe", true, nil)
        case "CachedProfilesData":
            return ("配置快照临时缓存", "工作区配置切换生成的临时加速缓存", "doc.badge.gearshape", "safe", true, nil)
        case "Crashpad":
            return ("崩溃转储与诊断残留", "历史崩溃报告与废弃诊断转储文件", "exclamationmark.triangle", "safe", true, nil)
        case "logs":
            return ("历史运行日志", "主进程、渲染进程与扩展宿主历史日志", "doc.text", "safe", true, nil)
        case "blob_storage":
            return ("临时二进制块缓存", "运行期产生的临时二进制块数据", "archivebox", "safe", true, nil)
        case "PartitionsCache":
            return ("内嵌视图子分区缓存", "内嵌浏览器与隔离分区的静态资源及编译缓存", "square.split.2x2", "safe", true, nil)
        case "AgentBrowserCache":
            return ("浏览器沙箱加速缓存", "Browser 沙箱的网页与编译缓存（保留站点登录与 Cookie）", "globe", "safe", true, nil)
        case "OrphanAgentData":
            return ("崩溃日志与临时媒体", "父对话已删除的孤儿任务碎片、崩溃日志与临时媒体缓存", "trash.slash", "safe", true, nil)
        case "AgentTaskStepLogs":
            return ("历史任务与步骤输出日志", "非活跃对话的后台终端日志、步骤输出与 scratch 草稿", "terminal", "stateful", false, "主对话与正式产物完好保留")
        case "AgentVerboseTranscripts":
            return ("全量冗余转录与分片镜像", "非活跃对话的 transcript_full 与分片镜像（保留紧凑版记录）", "doc.on.doc", "stateful", false, "对话界面与紧凑版记录不受影响")
        case "AgentSubagentDatabases":
            return ("历史子智能体轨迹库", "已完成任务的后台 Subagent 数据库（清理前自动归档 Token 账单）", "arrow.triangle.branch", "stateful", false, "主对话与历史账单完好保留，旧子智能体过程不再展开")
        case "Service Worker":
            return ("后台服务工作线程", "按需清理 · 清理后重新初始化扩展后台状态", "gearshape.2", "stateful", false, "重置扩展后台状态")
        case "Session Storage":
            return ("内嵌视图会话缓存", "按需清理 · 清理后重置部分内嵌视图临时会话", "rectangle.stack", "stateful", false, "重置临时会话状态")
        case "WebStorage":
            return ("Web 视图持久缓存", "按需清理 · 清理后重置扩展内嵌网页状态", "globe", "stateful", false, "重置内嵌网页状态")
        case "Local Storage":
            return ("扩展与站点本地存储", "按需清理 · 清理后可能需重新授权部分扩展", "externaldrive.badge.person.crop", "stateful", false, "可能需重新授权扩展")
        case "Cookies":
            return ("网络会话与授权凭据", "按需清理 · 清理后部分服务需重新登录授权", "key.horizontal", "stateful", false, "清理后需重新登录授权")
        case "Network Persistent State":
            return ("网络连接协商状态", "按需清理 · 清理后重新协商网络连接参数", "network", "stateful", false, "重置网络连接偏好")
        default:
            return (name, "应用运行缓存目录", "folder", "safe", true, nil)
        }
    }

    private func isStatefulItem(_ item: [String: Any]) -> Bool {
        if let cat = item["category"] as? String {
            return cat == "stateful"
        }
        let name = item["name"] as? String ?? ""
        return defaultMetadata(for: name).category == "stateful"
    }

    private func isDefaultSelected(_ item: [String: Any]) -> Bool {
        if let def = item["defaultSelected"] as? Bool {
            return def
        }
        return !isStatefulItem(item)
    }

    /// Only show cache items that actually occupy space or have an access warning; if all are 0 B, keep the core 3 so the card isn't blank.
    private func visibleEntries() -> [[String: Any]] {
        let nonZeroOrBlocked = entries.filter { intVal($0, "bytes") > 0 || ($0["clearable"] as? Bool == false) }
        if !nonZeroOrBlocked.isEmpty {
            return nonZeroOrBlocked
        }
        return Array(entries.prefix(3))
    }

    private func applyScanPayload(_ value: [String: Any]) {
        scanToken = value["token"] as? String ?? ""
        appRunning = value["running"] as? Bool == true
        browserBusy = value["browserBusy"] as? Bool == true
        if value["retentionDays"] != nil {
            let returnedDays = intVal(value, "retentionDays", fallback: selectedRetentionDays)
            if let matchIdx = Self.retentionChoices.firstIndex(where: { $0.days == returnedDays }) {
                selectedRetentionDays = returnedDays
                if retentionPopup.indexOfSelectedItem != matchIdx {
                    retentionPopup.selectItem(at: matchIdx)
                }
            }
        }
        scannedAt = intVal(value, "scannedAt", fallback: Int(Date().timeIntervalSince1970))
        totalCacheBytes = Int64(intVal(value, "totalBytes"))
        totalCacheFiles = intVal(value, "totalFiles")
        let rawEntries = value["entries"] as? [[String: Any]] ?? []
        entries = rawEntries
        if totalCacheFiles == 0 {
            totalCacheFiles = entries.reduce(0) { $0 + intVal($1, "fileCount") }
        }
        isTruncated = value["truncated"] as? Bool == true
        uncertainConversationCount = intVal(value["uncertainConversations"] as? [String: Any] ?? [:], "count")

        safeCacheBytes = entries.filter { !isStatefulItem($0) }.reduce(Int64(0)) { $0 + Int64(intVal($1, "bytes")) }
        statefulCacheBytes = entries.filter { isStatefulItem($0) }.reduce(Int64(0)) { $0 + Int64(intVal($1, "bytes")) }
        if totalCacheBytes == 0 {
            totalCacheBytes = safeCacheBytes + statefulCacheBytes
        }

        let rawProtected = value["protectedEntries"] as? [[String: Any]] ?? []
        protectedEntries = rawProtected
        totalProtectedBytes = Int64(intVal(value, "protectedBytes", fallback: rawProtected.reduce(0) { $0 + intVal($1, "bytes") }))

        snapshots = value["snapshots"] as? [[String: Any]] ?? []

        let activeClearableEntries = visibleEntries().filter { ($0["clearable"] as? Bool != false) && intVal($0, "bytes") > 0 }
        let allClearableNames = Set(activeClearableEntries.compactMap { $0["name"] as? String })
        let recommendedNames = Set(activeClearableEntries.filter { isDefaultSelected($0) }.compactMap { $0["name"] as? String })

        if !hasInitializedSelection {
            selectedNames = recommendedNames
            hasInitializedSelection = true
        } else {
            selectedNames = selectedNames.intersection(allClearableNames)
        }

        renderAll()
    }

    private func selectionSummary() -> (bytes: Int64, files: Int, count: Int, statefulCount: Int) {
        var bytes: Int64 = 0
        var files = 0
        var count = 0
        var statefulCount = 0
        for item in visibleEntries() {
            let itemBytes = Int64(intVal(item, "bytes"))
            guard let name = item["name"] as? String,
                  item["clearable"] as? Bool != false,
                  itemBytes > 0,
                  selectedNames.contains(name) else { continue }
            bytes += itemBytes
            files += intVal(item, "fileCount")
            count += 1
            if isStatefulItem(item) {
                statefulCount += 1
            }
        }
        return (bytes, files, count, statefulCount)
    }

    private func updateSummaryAndControls() {
        let sel = selectionSummary()
        let shown = visibleEntries()
        let blocked = shown.filter { $0["clearable"] as? Bool == false }
        let clearableEntries = shown.filter { ($0["clearable"] as? Bool != false) && intVal($0, "bytes") > 0 }
        let recommendedNames = Set(clearableEntries.filter { isDefaultSelected($0) }.compactMap { $0["name"] as? String })

        let heroDisplayBytes = sel.count > 0 ? sel.bytes : safeCacheBytes
        reclaimableTitleLabel.stringValue = "可移入废纸篓体积"
        reclaimableValueLabel.stringValue = formatBytes(heroDisplayBytes)

        var protectionNotes = blocked.map { "\($0["name"] ?? "缓存")：\($0["reason"] ?? "无法读取")" }
        if uncertainConversationCount > 0 { protectionNotes.append("\(uncertainConversationCount) 个会话关系待确认，已保护并排除清理") }
        breakdownWarningLabel.stringValue = protectionNotes.joined(separator: "；")
        breakdownWarningLabel.setAccessibilityLabel(breakdownWarningLabel.stringValue)
        breakdownWarningLabel.isHidden = protectionNotes.isEmpty

        compositionBar.safeBytes = safeCacheBytes
        compositionBar.statefulBytes = statefulCacheBytes
        compositionBar.protectedBytes = totalProtectedBytes

        safeLegendLabel.stringValue = "无损缓存与临时文件 \(formatBytes(safeCacheBytes))"
        if statefulCacheBytes > 0 {
            statefulLegendWrap.isHidden = false
            statefulLegendLabel.stringValue = "可瘦身历史 \(formatBytes(statefulCacheBytes))"
        } else {
            statefulLegendWrap.isHidden = true
        }
        if isTruncated {
            protectedLegendLabel.stringValue = totalProtectedBytes > 0
                ? "核心数据 \(formatBytes(totalProtectedBytes)) · 部分统计（超出扫描时限）"
                : "核心数据 · 部分统计（超出扫描时限）"
        } else {
            protectedLegendLabel.stringValue = totalProtectedBytes > 0
                ? "核心数据 \(formatBytes(totalProtectedBytes)) 已保护"
                : "核心数据已保护"
        }

        if scannedAt > 0 {
            lastScannedLabel.stringValue = "更新于 \(Self.timeFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(scannedAt))))"
        } else {
            lastScannedLabel.stringValue = ""
        }

        let safeClearableEntries = clearableEntries.filter { !isStatefulItem($0) }
        let safeClearableCount = safeClearableEntries.count
        let safeSelectedCount = selectedNames.intersection(Set(safeClearableEntries.compactMap { $0["name"] as? String })).count
        recommendButton.isEnabled = !busy && !recommendedNames.isEmpty && selectedNames != recommendedNames
        let shouldOfferClearSelection = (safeSelectedCount == safeClearableCount && safeClearableCount > 0) || (!selectedNames.isEmpty && safeClearableCount == 0)
        let nextToggleTitle = shouldOfferClearSelection ? "清空勾选" : "全选安全项"
        if toggleAllButton.title != nextToggleTitle {
            toggleAllButton.title = nextToggleTitle
            toggleAllButton.invalidateIntrinsicContentSize()
        }
        toggleAllButton.isEnabled = !busy && (safeClearableCount > 0 || !selectedNames.isEmpty)

        clearButton.isEnabled = !busy && blocked.isEmpty && sel.bytes > 0 && sel.count > 0
        let nextClearTitle = sel.count > 0 ? "清理选中项 (\(sel.count))…" : "清理选中项…"
        if clearButton.title != nextClearTitle {
            clearButton.title = nextClearTitle
            clearButton.invalidateIntrinsicContentSize()
        }
    }

    private func updateSelectionInPlace() {
        updateSummaryAndControls()
        for (name, ctrl) in rowControlsByName {
            let isSelected = ctrl.clearable && ctrl.bytes > 0 && selectedNames.contains(name)
            ctrl.checkbox.state = isSelected ? .on : .off
            ctrl.checkbox.isEnabled = ctrl.clearable && ctrl.bytes > 0 && !busy
            ctrl.sizeLabel.textColor = isSelected ? .labelColor : Design.secondary
        }
    }

    private func renderAll() {
        let state = PerformanceSignpost.begin("CacheRenderAll")
        defer { PerformanceSignpost.end("CacheRenderAll", state) }
        updateSummaryAndControls()
        rebuildItemsStack()
        updateRecoveryFooter()
    }

    private func makeItemRowControls(name: String, title: String) -> ItemRowControls {
        let checkbox = NSButton(checkboxWithTitle: "", target: self, action: #selector(itemSelectionChanged(_:)))
        checkbox.identifier = NSUserInterfaceItemIdentifier(name)
        checkbox.setAccessibilityLabel("勾选 \(title)")

        let compressiblePriority = NSLayoutConstraint.Priority(45)
        let titleLbl = text(title, size: 13, weight: .semibold, color: .labelColor)
        titleLbl.lineBreakMode = .byTruncatingTail
        titleLbl.setContentHuggingPriority(NSLayoutConstraint.Priority(10), for: .horizontal)
        titleLbl.setContentCompressionResistancePriority(compressiblePriority, for: .horizontal)

        let subLbl = text("", size: 11, color: Design.secondary)
        subLbl.maximumNumberOfLines = 1
        subLbl.lineBreakMode = .byTruncatingTail
        subLbl.cell?.wraps = false
        subLbl.cell?.truncatesLastVisibleLine = true
        subLbl.setContentHuggingPriority(NSLayoutConstraint.Priority(10), for: .horizontal)
        subLbl.setContentCompressionResistancePriority(compressiblePriority, for: .horizontal)

        let captions = vertical([titleLbl, subLbl], spacing: 2)
        captions.alignment = .leading
        captions.setContentHuggingPriority(NSLayoutConstraint.Priority(30), for: .horizontal)
        captions.setContentCompressionResistancePriority(compressiblePriority, for: .horizontal)

        let sizeLbl = text("0 B", size: 13, weight: .semibold, color: Design.secondary)
        sizeLbl.font = .monospacedDigitSystemFont(ofSize: 13, weight: .semibold)
        sizeLbl.alignment = .right
        sizeLbl.setContentHuggingPriority(.required, for: .horizontal)
        sizeLbl.setContentCompressionResistancePriority(.required, for: .horizontal)

        let rowSpacer = flexibleSpace()
        rowSpacer.setContentHuggingPriority(NSLayoutConstraint.Priority(20), for: .horizontal)
        let row = horizontal([checkbox, captions, rowSpacer, sizeLbl], spacing: 10)
        row.alignment = .centerY

        return ItemRowControls(
            rowView: row,
            checkbox: checkbox,
            titleLabel: titleLbl,
            subtitleLabel: subLbl,
            sizeLabel: sizeLbl,
            bytes: 0,
            clearable: true
        )
    }

    private func rebuildItemsStack() {
        let shown = visibleEntries()
        // Sort safe items first (by size descending), stateful items second (by size descending)
        let sortedEntries = shown.enumerated().sorted { lhs, rhs in
            let lStateful = isStatefulItem(lhs.element)
            let rStateful = isStatefulItem(rhs.element)
            if lStateful != rStateful { return !lStateful }
            let lBytes = intVal(lhs.element, "bytes")
            let rBytes = intVal(rhs.element, "bytes")
            if lBytes != rBytes { return lBytes > rBytes }
            return lhs.offset < rhs.offset
        }.map(\.element)

        var nextNames: [String] = []
        for item in sortedEntries {
            let name = item["name"] as? String ?? "Cache"
            nextNames.append(name)
            let defaults = defaultMetadata(for: name)
            let serverTitle = (item["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let serverSubtitle = (item["subtitle"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let title = serverTitle.isEmpty ? defaults.title : serverTitle
            let subtitle = serverSubtitle.isEmpty ? defaults.subtitle : serverSubtitle
            let bytes = Int64(intVal(item, "bytes"))
            let clearable = item["clearable"] as? Bool != false
            let canSelect = clearable && bytes > 0
            let isSelected = canSelect && selectedNames.contains(name)

            var ctrl = rowControlsByName[name] ?? makeItemRowControls(name: name, title: title)
            ctrl.bytes = bytes
            ctrl.clearable = clearable
            ctrl.checkbox.state = isSelected ? .on : .off
            ctrl.checkbox.isEnabled = canSelect && !busy
            ctrl.checkbox.setAccessibilityLabel("勾选 \(title)")
            if ctrl.titleLabel.stringValue != title { ctrl.titleLabel.stringValue = title }

            let detailCopy: String
            if !clearable, let reason = item["reason"] as? String, !reason.isEmpty {
                detailCopy = reason
            } else if name == "AgentBrowserCache" && browserBusy {
                detailCopy = "\(subtitle) · 独立浏览器运行中，清理时自动跳过"
            } else {
                detailCopy = subtitle
            }
            if ctrl.subtitleLabel.stringValue != detailCopy { ctrl.subtitleLabel.stringValue = detailCopy }
            ctrl.subtitleLabel.textColor = clearable ? Design.secondary : accessibleWarningColor()

            let sizeText = bytes > 0 ? formatBytes(bytes) : "0 B"
            if ctrl.sizeLabel.stringValue != sizeText { ctrl.sizeLabel.stringValue = sizeText }
            ctrl.sizeLabel.textColor = isSelected ? .labelColor : Design.secondary
            rowControlsByName[name] = ctrl
        }

        let validNames = Set(nextNames)
        rowControlsByName = rowControlsByName.filter { validNames.contains($0.key) }

        let safeNames = nextNames.filter { name in
            guard let item = sortedEntries.first(where: { ($0["name"] as? String) == name }) else { return true }
            return !isStatefulItem(item)
        }
        let statefulNames = nextNames.filter { name in
            guard let item = sortedEntries.first(where: { ($0["name"] as? String) == name }) else { return false }
            return isStatefulItem(item)
        }
        let currentWindowTitle = Self.retentionChoices.first(where: { $0.days == selectedRetentionDays })?.title ?? "保留近 7 天"
        let nextSignature = "\(safeNames.joined(separator: "|"))##\(statefulNames.joined(separator: "|"))##\(statefulNames.isEmpty ? currentWindowTitle : "has-stateful")"

        if nextSignature != renderedLayoutSignature {
            renderedLayoutSignature = nextSignature
            renderedItemNames = nextNames
            itemsStack.arrangedSubviews.forEach {
                itemsStack.removeArrangedSubview($0)
                $0.removeFromSuperview()
            }

            if !safeNames.isEmpty {
                let safeDot = Self.makeLegendDot(color: Design.blue)
                let safeTitle = text("无损缓存与临时文件（推荐清理）", size: 11.5, weight: .semibold, color: Design.secondary)
                let safeHeader = horizontal([safeDot, safeTitle], spacing: 6)
                safeHeader.alignment = .centerY
                itemsStack.addArrangedSubview(safeHeader)
                fillWidth(safeHeader, in: itemsStack)
                for (idx, name) in safeNames.enumerated() {
                    guard let ctrl = rowControlsByName[name] else { continue }
                    if idx > 0 {
                        let line = divider()
                        itemsStack.addArrangedSubview(line)
                        fillWidth(line, in: itemsStack)
                    }
                    itemsStack.addArrangedSubview(ctrl.rowView)
                    fillWidth(ctrl.rowView, in: itemsStack)
                }
            }

            if !safeNames.isEmpty {
                let sectionDivider = divider()
                itemsStack.addArrangedSubview(sectionDivider)
                fillWidth(sectionDivider, in: itemsStack)
                itemsStack.setCustomSpacing(10, after: sectionDivider)
            }

            let historyDot = Self.makeLegendDot(color: Design.color(0xD97706, 0xFBBF24))
            let historyTitle = text("历史深度瘦身（按需勾选 · 主对话与历史账单完好保留）", size: 11.5, weight: .semibold, color: Design.secondary)
            let historyHeader = horizontal([historyDot, historyTitle], spacing: 6)
            historyHeader.alignment = .centerY
            itemsStack.addArrangedSubview(historyHeader)
            fillWidth(historyHeader, in: itemsStack)

            if !statefulNames.isEmpty {
                for (idx, name) in statefulNames.enumerated() {
                    guard let ctrl = rowControlsByName[name] else { continue }
                    if idx > 0 {
                        let line = divider()
                        itemsStack.addArrangedSubview(line)
                        fillWidth(line, in: itemsStack)
                    }
                    itemsStack.addArrangedSubview(ctrl.rowView)
                    fillWidth(ctrl.rowView, in: itemsStack)
                }
            } else {
                let emptyHint = text("当前范围（\(currentWindowTitle)）外暂无可瘦身的历史运行日志或子智能体库", size: 11, color: Design.secondary)
                emptyHint.maximumNumberOfLines = 1
                emptyHint.lineBreakMode = .byTruncatingTail
                itemsStack.addArrangedSubview(emptyHint)
                fillWidth(emptyHint, in: itemsStack)
            }
        }
    }

    private func renderSelectedSnapshotSummary(_ snap: [String: Any]) {
        let bytes = Int64(intVal(snap, "totalBytes"))
        let ts = intVal(snap, "timestamp")
        let items = (snap["items"] as? [String]) ?? []
        let rawTitles = (snap["itemTitles"] as? [String]) ?? items.map { defaultMetadata(for: $0).title }
        let timeStr = ts > 0
            ? Self.snapshotDateFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(ts)))
            : "近期"
        let sizeStr = bytes > 0 ? formatBytes(bytes) : "\(max(1, items.count)) 项"
        if restorableSnapshots.count >= 2 {
            recoveryTitleLabel.stringValue = "可恢复快照（共 \(restorableSnapshots.count) 个）· \(sizeStr)"
        } else {
            recoveryTitleLabel.stringValue = "最近清理 · \(timeStr)（\(sizeStr)）"
        }
        if !rawTitles.isEmpty {
            let preview = rawTitles.prefix(2).joined(separator: "、")
            let suffix = rawTitles.count > 2 ? " 等 \(rawTitles.count) 项" : ""
            recoverySubtitleLabel.stringValue = "含 \(preview)\(suffix) · 支持一键原位还原"
        } else {
            recoverySubtitleLabel.stringValue = "已移入系统废纸篓，支持一键原位还原"
        }
        recoverySubtitleLabel.toolTip = nil
    }

    private func updateRecoveryFooter() {
        restorableSnapshots = snapshots.filter { snap in
            guard (snap["restorable"] as? Bool) == true,
                  let id = snap["id"] as? String, !id.isEmpty else { return false }
            return true
        }

        if !restorableSnapshots.isEmpty {
            let preferredId: String
            if restorableSnapshots.contains(where: { ($0["id"] as? String) == latestRestorableSnapshotId }) {
                preferredId = latestRestorableSnapshotId
            } else {
                preferredId = (restorableSnapshots[0]["id"] as? String) ?? ""
            }
            latestRestorableSnapshotId = preferredId

            if restorableSnapshots.count >= 2 {
                snapshotPopup.removeAllItems()
                var selectedIdx = 0
                for (idx, snap) in restorableSnapshots.enumerated() {
                    let id = (snap["id"] as? String) ?? ""
                    let ts = intVal(snap, "timestamp")
                    let bytes = Int64(intVal(snap, "totalBytes"))
                    let items = (snap["items"] as? [String]) ?? []
                    let timeStr = ts > 0
                        ? Self.snapshotDateFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(ts)))
                        : "快照 \(idx + 1)"
                    let sizeStr = bytes > 0 ? formatBytes(bytes) : "\(max(1, items.count)) 项"
                    snapshotPopup.addItem(withTitle: "\(timeStr) · \(sizeStr)")
                    snapshotPopup.lastItem?.representedObject = id
                    if id == preferredId { selectedIdx = idx }
                }
                snapshotPopup.selectItem(at: selectedIdx)
                snapshotPopup.isHidden = false
                snapshotPopup.isEnabled = !busy
            } else {
                snapshotPopup.removeAllItems()
                snapshotPopup.isHidden = true
            }

            if let activeSnap = restorableSnapshots.first(where: { ($0["id"] as? String) == preferredId }) ?? restorableSnapshots.first {
                renderSelectedSnapshotSummary(activeSnap)
            }
            restoreLatestButton.isHidden = false
            restoreLatestButton.isEnabled = !busy
        } else if let latestSnap = snapshots.first {
            latestRestorableSnapshotId = ""
            snapshotPopup.removeAllItems()
            snapshotPopup.isHidden = true
            let ts = intVal(latestSnap, "timestamp")
            let timeStr = ts > 0
                ? Self.snapshotDateFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(ts)))
                : "近期"
            let restored = latestSnap["restoredAt"] != nil
            recoveryTitleLabel.stringValue = restored ? "最近清理（\(timeStr) · 已恢复）" : "废纸篓安全恢复"
            recoverySubtitleLabel.stringValue = "清理项移入系统废纸篓并保留恢复点，支持一键原位还原"
            recoverySubtitleLabel.toolTip = nil
            restoreLatestButton.isHidden = true
        } else {
            latestRestorableSnapshotId = ""
            snapshotPopup.removeAllItems()
            snapshotPopup.isHidden = true
            recoveryTitleLabel.stringValue = "废纸篓安全恢复"
            recoverySubtitleLabel.stringValue = "清理项移入系统废纸篓并保留恢复点，支持一键原位还原"
            recoverySubtitleLabel.toolTip = nil
            restoreLatestButton.isHidden = true
        }
    }

    @objc func snapshotSelectionChanged() {
        guard let id = snapshotPopup.selectedItem?.representedObject as? String, !id.isEmpty else { return }
        latestRestorableSnapshotId = id
        if let activeSnap = restorableSnapshots.first(where: { ($0["id"] as? String) == id }) {
            renderSelectedSnapshotSummary(activeSnap)
        }
    }

    @objc func itemSelectionChanged(_ sender: NSButton) {
        guard let name = sender.identifier?.rawValue, !name.isEmpty else { return }
        if sender.state == .on {
            selectedNames.insert(name)
        } else {
            selectedNames.remove(name)
        }
        updateSelectionInPlace()
    }

    @objc func selectRecommendedOnly() {
        let recommendedNames = Set(visibleEntries().compactMap { item -> String? in
            guard item["clearable"] as? Bool != false, intVal(item, "bytes") > 0, isDefaultSelected(item) else { return nil }
            return item["name"] as? String
        })
        selectedNames = recommendedNames
        updateSelectionInPlace()
    }

    @objc func toggleSelectAll() {
        let safeClearableNames = Set(visibleEntries().compactMap { item -> String? in
            guard item["clearable"] as? Bool != false, intVal(item, "bytes") > 0, !isStatefulItem(item) else { return nil }
            return item["name"] as? String
        })
        let selectedSafe = selectedNames.intersection(safeClearableNames)
        let shouldClearAll = (selectedSafe.count == safeClearableNames.count && !safeClearableNames.isEmpty) || (!selectedNames.isEmpty && safeClearableNames.isEmpty)
        if shouldClearAll {
            selectedNames.removeAll()
        } else {
            selectedNames.formUnion(safeClearableNames)
        }
        updateSelectionInPlace()
    }

    @objc func openTrashFolder() {
        let trashURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".Trash")
        NSWorkspace.shared.open(trashURL)
    }

    @objc func restoreLatestSnapshot() {
        guard !latestRestorableSnapshotId.isEmpty else { return }
        let dummy = NSButton()
        dummy.identifier = NSUserInterfaceItemIdentifier(latestRestorableSnapshotId)
        restoreSnapshot(dummy)
    }

    @objc func clearSelectedCaches() {
        guard !busy, !scanToken.isEmpty else { return }
        let sel = selectionSummary()
        guard sel.count > 0, sel.bytes > 0 else { return }
        let orderedSelected = entries.compactMap { item -> String? in
            guard let name = item["name"] as? String,
                  item["clearable"] as? Bool != false,
                  intVal(item, "bytes") > 0,
                  selectedNames.contains(name) else { return nil }
            return name
        }
        guard !orderedSelected.isEmpty else { return }
        let tokenToClear = scanToken

        #if NATIVE_UI_TEST
        performClear(token: tokenToClear, selected: orderedSelected, restartAfter: false)
        return
        #else
        let presentConfirmModal: () -> Void = { [weak self] in
            guard let self else { return }
            let confirm = NSAlert()
            confirm.alertStyle = .informational
            let hasStateful = sel.statefulCount > 0
            if self.appRunning {
                confirm.messageText = hasStateful
                    ? "退出 Antigravity 并清理 \(self.formatBytes(sel.bytes)) 所选存储项？"
                    : "退出 Antigravity 并清理 \(self.formatBytes(sel.bytes)) 无损缓存与残留？"
                confirm.informativeText = hasStateful
                    ? "确认后将自动重启 Antigravity，并将所选 \(orderedSelected.count) 项（含 \(sel.statefulCount) 项历史深度瘦身）移入系统废纸篓。核心账号、主对话/归档对话与本地 Token 账单完好保留。"
                    : "确认后将自动重启 Antigravity，并将所选 \(orderedSelected.count) 项移入系统废纸篓。账号登录态与历史对话完好保留。"
                confirm.addButton(withTitle: "退出并清理")
                confirm.addButton(withTitle: "取消")
            } else {
                confirm.messageText = hasStateful
                    ? "确认清理所选 \(self.formatBytes(sel.bytes)) 存储项？"
                    : "确认清理所选 \(self.formatBytes(sel.bytes)) 无损缓存与残留？"
                confirm.informativeText = hasStateful
                    ? "所选 \(orderedSelected.count) 项（含 \(sel.statefulCount) 项历史深度瘦身）将移入系统废纸篓并生成恢复快照。核心账号、主对话/归档对话与本地 Token 账单完好保留。"
                    : "所选 \(orderedSelected.count) 项将移入系统废纸篓并生成恢复快照。账号登录态与历史对话完好保留。"
                confirm.addButton(withTitle: "移到废纸篓")
                confirm.addButton(withTitle: "取消")
            }

            let handleChoice: (NSApplication.ModalResponse) -> Void = { [weak self] response in
                guard let self else { return }
                guard response == .alertFirstButtonReturn else { return }
                if self.appRunning {
                    self.quitAntigravityAndClear(token: tokenToClear, selected: orderedSelected)
                } else {
                    self.performClear(token: tokenToClear, selected: orderedSelected, restartAfter: false)
                }
            }

            var parentWindow = self.app.window
            while let sheet = parentWindow?.activeSheetWindow { parentWindow = sheet }
            if let parentWindow, parentWindow.isVisible {
                confirm.beginSheetModal(for: parentWindow) { handleChoice($0) }
            } else {
                NSApp.activate(ignoringOtherApps: true)
                handleChoice(confirm.runModal())
            }
        }

        if appRunning {
            busy = true
            scanButton.setBusy(true, available: app.reachable)
            retentionPopup.isEnabled = false
            clearButton.isEnabled = false
            app.bridge.send(["command": "maintenance_preflight"]) { [weak self] preflightRes in
                guard let self else { return }
                self.busy = false
                self.scanButton.setBusy(false, available: self.app.reachable)
                self.retentionPopup.isEnabled = self.app.reachable
                self.updateSummaryAndControls()
                switch preflightRes {
                case .failure(let error):
                    let msg = error.localizedDescription
                    self.feedbackLabel.isHidden = false
                    self.feedbackLabel.textColor = accessibleWarningColor()
                    self.feedbackLabel.stringValue = msg
                    let warn = NSAlert()
                    warn.alertStyle = .warning
                    warn.messageText = "当前无法执行存储清理"
                    warn.informativeText = msg
                    warn.addButton(withTitle: "知道了")
                    var parentWindow = self.app.window
                    while let sheet = parentWindow?.activeSheetWindow { parentWindow = sheet }
                    if let parentWindow, parentWindow.isVisible {
                        warn.beginSheetModal(for: parentWindow, completionHandler: nil)
                    } else {
                        warn.runModal()
                    }
                case .success:
                    presentConfirmModal()
                }
            }
        } else {
            presentConfirmModal()
        }
        #endif
    }

    private func quitAntigravityAndClear(token: String, selected: [String]) {
        busy = true
        scanButton.setBusy(true, available: app.reachable)
        retentionPopup.isEnabled = false
        clearButton.isEnabled = false
        feedbackLabel.isHidden = false
        feedbackLabel.textColor = Design.secondary
        feedbackLabel.stringValue = "正在退出 Antigravity 并清理所选存储项…"

        app.quitAntigravityAndWait { [weak self] exited in
            guard let self else { return }
            guard exited else {
                self.busy = false
                self.scanButton.setBusy(false, available: self.app.reachable)
                self.retentionPopup.isEnabled = self.app.reachable
                let msg = "请先保存工作并退出 Antigravity，再执行存储清理。"
                self.feedbackLabel.isHidden = false
                self.feedbackLabel.textColor = accessibleWarningColor()
                self.feedbackLabel.stringValue = msg
                self.app.showMessage(msg, error: true)
                self.fetch(force: true)
                return
            }
            // Antigravity 及 language_server 完全静止后重新扫描最新指纹（保持当前保留窗口）再执行安全清理
            self.app.bridge.send(["command": "maintenance_scan", "retentionDays": self.selectedRetentionDays]) { [weak self] scanRes in
                guard let self else { return }
                switch scanRes {
                case .success(let scanPayload):
                    if scanPayload["running"] as? Bool == true {
                        self.busy = false
                        self.scanButton.setBusy(false, available: self.app.reachable)
                        self.retentionPopup.isEnabled = self.app.reachable
                        let msg = "请先保存工作并退出 Antigravity，再执行存储清理。"
                        self.feedbackLabel.isHidden = false
                        self.feedbackLabel.textColor = accessibleWarningColor()
                        self.feedbackLabel.stringValue = msg
                        self.app.showMessage(msg, error: true)
                        self.fetch(force: true)
                        return
                    }
                    let freshToken = (scanPayload["token"] as? String) ?? token
                    self.busy = false
                    self.performClear(token: freshToken, selected: selected, restartAfter: true)
                case .failure(let error):
                    self.busy = false
                    self.scanButton.setBusy(false, available: self.app.reachable)
                    self.retentionPopup.isEnabled = self.app.reachable
                    let msg = "退出 Antigravity 后重扫存储清单失败（\(error.localizedDescription)），已取消清理以保护数据。"
                    self.feedbackLabel.isHidden = false
                    self.feedbackLabel.textColor = accessibleWarningColor()
                    self.feedbackLabel.stringValue = msg
                    self.app.showMessage(msg, error: true)
                    self.fetch(force: true)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.app.openAntigravity() }
                }
            }
        }
    }

    private func performClear(token: String, selected: [String], restartAfter: Bool) {
        busy = true
        scanButton.setBusy(true, available: app.reachable)
        retentionPopup.isEnabled = false
        clearButton.isEnabled = false
        app.bridge.send(["command": "maintenance_clear", "token": token, "selectedNames": selected, "force": false]) { [weak self] response in
            guard let self else { return }
            self.busy = false
            self.scanButton.setBusy(false, available: self.app.reachable)
            self.retentionPopup.isEnabled = self.app.reachable
            switch response {
            case .failure(let error):
                self.feedbackLabel.isHidden = false
                self.feedbackLabel.textColor = accessibleWarningColor()
                self.feedbackLabel.stringValue = error.localizedDescription
                self.app.showMessage(error.localizedDescription, error: true)
                self.fetch(force: true)
                if restartAfter {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.app.openAntigravity() }
                }
            case .success(let value):
                let msg = (value["message"] as? String) ?? "已将所选存储项移入废纸篓"
                self.feedbackLabel.isHidden = false
                self.feedbackLabel.textColor = Design.secondary
                self.feedbackLabel.stringValue = msg
                self.app.showMessage(msg)
                self.fetch(force: true)
                self.app.overview?.fetch()
                self.app.usagePage?.fetch(force: true)
                if restartAfter {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.app.openAntigravity() }
                }
            }
        }
    }

    @objc func restoreSnapshot(_ sender: NSButton) {
        guard !busy, let snapshotId = sender.identifier?.rawValue, !snapshotId.isEmpty else { return }

        let executeRestore: () -> Void = { [weak self] in
            guard let self else { return }
            self.busy = true
            self.scanButton.setBusy(true, available: self.app.reachable)
            self.retentionPopup.isEnabled = false
            self.snapshotPopup.isEnabled = false
            self.clearButton.isEnabled = false
            self.app.bridge.send(["command": "maintenance_restore", "snapshotId": snapshotId]) { [weak self] response in
                guard let self else { return }
                self.busy = false
                self.scanButton.setBusy(false, available: self.app.reachable)
                self.retentionPopup.isEnabled = self.app.reachable
                switch response {
                case .failure(let error):
                    self.feedbackLabel.isHidden = false
                    self.feedbackLabel.textColor = accessibleWarningColor()
                    self.feedbackLabel.stringValue = error.localizedDescription
                    self.app.showMessage(error.localizedDescription, error: true)
                    self.fetch(force: true)
                case .success(let value):
                    let msg = (value["message"] as? String) ?? "已原位恢复存储快照"
                    self.feedbackLabel.isHidden = false
                    self.feedbackLabel.textColor = Design.secondary
                    self.feedbackLabel.stringValue = msg
                    self.app.showMessage(msg)
                    self.fetch(force: true)
                    self.app.overview?.fetch()
                    self.app.usagePage?.fetch(force: true)
                }
            }
        }

        #if NATIVE_UI_TEST
        executeRestore()
        #else
        if appRunning {
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = "请先退出 Antigravity 后再恢复缓存快照"
            alert.informativeText = "为避免缓存目录在恢复过程中发生读写冲突，请先关闭 Antigravity，再点击「原位恢复」。"
            alert.addButton(withTitle: "知道了")
            var parentWindow = app.window
            while let sheet = parentWindow?.activeSheetWindow { parentWindow = sheet }
            if let parentWindow, parentWindow.isVisible {
                alert.beginSheetModal(for: parentWindow, completionHandler: nil)
            } else {
                alert.runModal()
            }
            return
        }
        executeRestore()
        #endif
    }
}

// MARK: - Maintenance Sheet Window Controller (方案 A: 设置面板内嵌弹窗)
final class MaintenanceSheetController: NSObject, NSWindowDelegate {
    unowned let app: Assistant
    let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 740, height: 616), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    var cachePage: CachePage
    var onDismiss: (() -> Void)?

    init(app: Assistant) {
        self.app = app
        let page = app.cachePage ?? CachePage(app: app)
        app.cachePage = page
        self.cachePage = page
        super.init()
        sheet.delegate = self
        sheet.title = "存储与维护 · Antigravity"
        sheet.isReleasedWhenClosed = false

        page.sheetDoneButton.target = self
        page.sheetDoneButton.action = #selector(closeSheet)
        page.sheetDoneButton.isHidden = false

        let surface = SheetVisualEffectView()
        surface.addSubview(page.view)
        pin(page.view, to: surface, inset: 0)
        sheet.isOpaque = false
        sheet.backgroundColor = .clear
        sheet.contentView = surface
        Design.applyControls(surface)
    }

    func show(in parent: NSWindow, onDismiss: (() -> Void)? = nil) {
        guard sheet.sheetParent == nil else { return }
        self.onDismiss = onDismiss
        cachePage.update(force: true)
        parent.beginSheet(sheet) { [weak self] _ in
            self?.onDismiss?()
        }
    }

    @objc func closeSheet() {
        sheet.sheetParent?.endSheet(sheet)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        closeSheet()
        return false
    }
}
