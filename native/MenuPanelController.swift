import Cocoa

final class MenuPanelController: NSViewController {
    static let panelWidth: CGFloat = 396
    static let defaultPanelHeight: CGFloat = 535
    static let periods = ["today", "7d", "30d", "all"]
    static let periodLabels = ["今日", "近 7 天", "近 30 天", "全部"]

    unowned let app: Assistant

    // Top Chrome
    let brandLabel = text("GravityBox", size: 15, weight: .semibold, color: .labelColor)
    let headerRefreshButton: InlineRefreshButton
    let moreButton: DesignButton
    let tabSelector: MenuSegmentedTabsView

    // Scrollable Content Host
    let contentScroll = MenuSilentScrollView()
    let documentContainer = TopAlignedDocument()
    let usageRoot = NSStackView()
    let quotaRoot = NSStackView()
    let accountsRoot = NSStackView()

    // Tab 0: Usage Controls
    let periodSelector: MenuSegmentedTabsView
    let usageScopeLabel = text("本机历史用量 · 非按账号归属", size: 11, color: Design.secondary, wrap: true)
    let tokensTile: MenuMetricTileView
    let requestsTile: MenuMetricTileView
    let costTile: MenuMetricTileView
    let cacheTile: MenuMetricTileView
    let trendTitleLabel = text("今日趋势", size: 12.5, weight: .semibold, color: .labelColor)
    let trendCoverageLabel = text("", size: 10.5, color: Design.secondary)
    let chartDimensionToggle: MenuSegmentedTabsView
    let trendChart = MenuTrendChartView()
    let modelsHeaderCountLabel = text("", size: 11, color: Design.secondary)
    let modelsListStack = NSStackView()
    private var modelRowViewsByName: [String: MenuModelUsageItemView] = [:]
    private var modelDividerViewsByName: [String: NSView] = [:]
    private var renderedModelNames: [String] = []
    let toggleModelsButton = button("展开其余模型", target: nil, action: #selector(toggleAllModelsPressed))
    let usageFooterLabel = text("", size: 11, color: Design.secondary, wrap: true)

    // Tab 1: Quota Controls
    let quotaAccountNameLabel = text("正在读取账号…", size: 15, weight: .semibold, color: .labelColor)
    let quotaTierBadge = pillBadge("", color: Design.blue)
    let quotaStatusBadge = pillBadge("已选记录", color: Design.blue)
    let quotaEmailLabel = text("", size: 11, color: .secondaryLabelColor, wrap: true)
    let quotaGemini5h = MenuMeterRow(title: "5 小时")
    let quotaGeminiWeekly = MenuMeterRow(title: "每周")
    let quotaClaude5h = MenuMeterRow(title: "5 小时")
    let quotaClaudeWeekly = MenuMeterRow(title: "每周")
    let quotaArgon = MenuMeterRow(title: "每周")
    let quotaCarbon = MenuMeterRow(title: "每周")
    let quotaExtraStandaloneStack = NSStackView()
    let quotaWarningLabel = text("", size: 11, color: accessibleWarningColor(), wrap: true)
    let quotaFooterLabel = text("", size: 11, color: .secondaryLabelColor, wrap: true)
    let quotaGroupsContainer = NSStackView()
    let quotaEmptyButton = button("前往账号页添加…", target: nil, action: #selector(openAccountsFromQuotaEmpty))

    // Tab 2: Accounts Controls
    let accountsCountLabel = text("0 个", size: 11, color: Design.secondary)
    let accountsCardsStack = NSStackView()
    private var accountCardsById: [String: MenuExpandableAccountCardView] = [:]
    private var renderedAccountIds: [String] = []

    // Bottom Bar
    let openAntigravityBtn = button("打开 Antigravity", target: nil, action: #selector(openAntigravityFromFooter))
    let openMainBtn = button("打开主界面 ↗", target: nil, action: #selector(openMainFromFooter))

    // State
    private(set) var selectedTab: Int = 0
    private(set) var selectedPeriod: Int = 0
    private(set) var selectedChartDimension: MenuTrendChartView.Dimension = .tokens
    private(set) var showAllModels: Bool = false
    private(set) var expandedAccountIds: Set<String> = []
    private var hasInitializedExpandedAccount = false
    private var renderedUsageSnapshotKey = ""
    private var renderedUsageModelKey = ""
    private var quotaHeaderEmail: String = ""
    private var activePeriodTrendNote: String = ""

    private static let timeFormatter: DateFormatter = InterfaceText.shortTimeFormatter
    private static let dateTimeFormatter: DateFormatter = InterfaceText.shortDateTimeFormatter

    init(app: Assistant) {
        self.app = app
        let initialTab = max(0, min(2, app.configuration?.value.menuSelectedTab ?? 0))
        let initialPeriod = max(0, min(3, app.configuration?.value.menuUsagePeriod ?? 0))
        let initialDim: MenuTrendChartView.Dimension = (app.configuration?.value.menuTrendMetric == "requests") ? .requests : .tokens
        self.selectedTab = initialTab
        self.selectedPeriod = initialPeriod
        self.selectedChartDimension = initialDim

        self.headerRefreshButton = InlineRefreshButton("刷新", width: 68, target: nil, action: #selector(refreshPressed))
        self.moreButton = DesignButton(title: "", target: nil, action: #selector(morePressed))
        self.moreButton.image = NSImage(systemSymbolName: "ellipsis", accessibilityDescription: "更多操作")
        self.moreButton.imagePosition = .imageOnly
        self.tabSelector = MenuSegmentedTabsView(items: ["用量", "配额", "账号"], style: .primaryTabs, selected: initialTab, accessibilityLabel: "菜单栏一级分页")
        self.periodSelector = MenuSegmentedTabsView(items: Self.periodLabels, style: .secondaryRange, selected: initialPeriod, accessibilityLabel: "用量统计时间范围")
        self.chartDimensionToggle = MenuSegmentedTabsView(items: ["Token", "请求"], style: .compactToggle, selected: initialDim == .requests ? 1 : 0, accessibilityLabel: "趋势图统计维度")

        self.tokensTile = MenuMetricTileView(key: "tokens", title: "Token 用量")
        self.requestsTile = MenuMetricTileView(key: "requests", title: "请求数")
        self.costTile = MenuMetricTileView(key: "cost", title: "API 费用估算")
        self.cacheTile = MenuMetricTileView(key: "cache", title: "缓存命中率")

        super.init(nibName: nil, bundle: nil)

        headerRefreshButton.target = self
        headerRefreshButton.refusesFirstResponder = false
        moreButton.target = self
        moreButton.refusesFirstResponder = false
        moreButton.setAccessibilityLabel("更多操作")
        moreButton.toolTip = nil
        moreButton.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            moreButton.widthAnchor.constraint(equalToConstant: 30),
            moreButton.heightAnchor.constraint(equalToConstant: 28)
        ])

        toggleModelsButton.target = self
        toggleModelsButton.controlSize = .small
        quotaEmptyButton.target = self
        quotaEmptyButton.controlSize = .small
        openAntigravityBtn.title = "打开 Antigravity"
        openAntigravityBtn.target = self
        openAntigravityBtn.controlSize = .small
        openMainBtn.target = self
        openMainBtn.controlSize = .small

        tabSelector.onSelect = { [weak self] idx in self?.selectTab(idx, persist: true) }
        periodSelector.onSelect = { [weak self] idx in self?.selectPeriod(idx, persist: true) }
        chartDimensionToggle.onSelect = { [weak self] idx in
            self?.selectChartDimension(idx == 1 ? .requests : .tokens, persist: true)
        }
        trendChart.onHoverBucket = { [weak self] bucket in
            guard let self else { return }
            if let b = bucket {
                if b.isFuture {
                    self.trendCoverageLabel.stringValue = "\(b.tooltipLabel) · 尚未到达"
                } else if self.selectedChartDimension == .tokens {
                    self.trendCoverageLabel.stringValue = "\(b.tooltipLabel) · \(InterfaceText.formatCompactTokens(b.value, formatSmallWithLocale: true)) Token"
                } else {
                    self.trendCoverageLabel.stringValue = "\(b.tooltipLabel) · \(b.value.formatted()) 次请求"
                }
                self.trendCoverageLabel.alphaValue = 1.0
            } else {
                if !self.activePeriodTrendNote.isEmpty {
                    self.trendCoverageLabel.stringValue = self.activePeriodTrendNote
                    self.trendCoverageLabel.alphaValue = 1.0
                } else {
                    self.trendCoverageLabel.stringValue = ""
                    self.trendCoverageLabel.alphaValue = 0.0
                }
            }
        }
    }
    required init?(coder: NSCoder) { fatalError() }

    private func resolvedTargetHeight() -> CGFloat {
        let activeScreen = app.item?.button?.window?.screen ?? viewIfLoaded?.window?.screen ?? NSScreen.main
        let screenMax = (activeScreen?.visibleFrame.height ?? 780) - 48
        return min(Self.defaultPanelHeight, max(480, screenMax))
    }

    override func loadView() {
        let fixedHeight = resolvedTargetHeight()
        let rootSurface = MenuPanelRootView()
        rootSurface.frame = NSRect(x: 0, y: 0, width: Self.panelWidth, height: fixedHeight)
        self.preferredContentSize = NSSize(width: Self.panelWidth, height: fixedHeight)

        // 1. Header Bar
        let brandIcon: NSImageView = {
            if let markImg = Design.brandMarkImage() {
                let iv = NSImageView(image: markImg)
                iv.imageScaling = .scaleProportionallyUpOrDown
                iv.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([
                    iv.widthAnchor.constraint(equalToConstant: 17),
                    iv.heightAnchor.constraint(equalToConstant: 17)
                ])
                iv.setAccessibilityElement(false)
                return iv
            }
            let fallback = symbol("sparkles", size: 13.5, color: Design.blue)
            fallback.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .semibold)
            return fallback
        }()
        let headerActions = horizontal([headerRefreshButton, moreButton], spacing: 6)
        headerActions.alignment = .centerY
        let topBar = horizontal([brandIcon, brandLabel, flexibleSpace(), headerActions], spacing: 6)
        topBar.alignment = .centerY

        let headerStack = vertical([topBar, tabSelector], spacing: 8)
        fillWidth(topBar, in: headerStack)
        fillWidth(tabSelector, in: headerStack)
        let headerHost = NSView()
        let headerBottomLine = DesignDividerView()
        headerHost.translatesAutoresizingMaskIntoConstraints = false
        headerHost.setContentCompressionResistancePriority(.required, for: .vertical)
        headerHost.setContentHuggingPriority(.required, for: .vertical)
        headerHost.addSubview(headerStack)
        headerHost.addSubview(headerBottomLine)
        headerStack.translatesAutoresizingMaskIntoConstraints = false
        headerBottomLine.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            headerHost.heightAnchor.constraint(equalToConstant: 86),
            headerStack.leadingAnchor.constraint(equalTo: headerHost.leadingAnchor, constant: 14),
            headerStack.trailingAnchor.constraint(equalTo: headerHost.trailingAnchor, constant: -14),
            headerStack.topAnchor.constraint(equalTo: headerHost.topAnchor, constant: 10),
            headerStack.bottomAnchor.constraint(equalTo: headerHost.bottomAnchor, constant: -8),
            headerBottomLine.leadingAnchor.constraint(equalTo: headerHost.leadingAnchor, constant: 14),
            headerBottomLine.trailingAnchor.constraint(equalTo: headerHost.trailingAnchor, constant: -14),
            headerBottomLine.bottomAnchor.constraint(equalTo: headerHost.bottomAnchor),
            headerBottomLine.heightAnchor.constraint(equalToConstant: 1)
        ])

        // 2. Build Tab 0 (Usage)
        buildUsageTab()

        // 3. Build Tab 1 (Quota)
        buildQuotaTab()

        // 4. Build Tab 2 (Accounts)
        buildAccountsTab()

        // 5. Middle Scrollable Host
        contentScroll.wantsLayer = true
        contentScroll.contentView.wantsLayer = true
        contentScroll.drawsBackground = false
        contentScroll.hasVerticalScroller = true
        contentScroll.autohidesScrollers = true
        contentScroll.automaticallyAdjustsContentInsets = false
        contentScroll.translatesAutoresizingMaskIntoConstraints = false
        contentScroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        contentScroll.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        documentContainer.wantsLayer = true
        documentContainer.translatesAutoresizingMaskIntoConstraints = false
        contentScroll.documentView = documentContainer

        let contentStack = vertical([usageRoot, quotaRoot, accountsRoot], spacing: 0)
        contentStack.detachesHiddenViews = true
        documentContainer.addSubview(contentStack)
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        for pageView in [usageRoot, quotaRoot, accountsRoot] {
            fillWidth(pageView, in: contentStack)
        }
        NSLayoutConstraint.activate([
            documentContainer.widthAnchor.constraint(equalTo: contentScroll.contentView.widthAnchor),
            contentStack.leadingAnchor.constraint(equalTo: documentContainer.leadingAnchor, constant: 14),
            contentStack.trailingAnchor.constraint(equalTo: documentContainer.trailingAnchor, constant: -14),
            contentStack.topAnchor.constraint(equalTo: documentContainer.topAnchor, constant: 10),
            contentStack.bottomAnchor.constraint(equalTo: documentContainer.bottomAnchor, constant: -10)
        ])

        // 6. Footer Bar
        openAntigravityBtn.image = NSImage(systemSymbolName: "arrow.up.forward.app", accessibilityDescription: nil)
        openAntigravityBtn.imagePosition = .imageLeading
        let footerRow = horizontal([openAntigravityBtn, flexibleSpace(), openMainBtn], spacing: 10)
        footerRow.alignment = .centerY
        let footerHost = MenuPanelFooterHostView()
        footerHost.translatesAutoresizingMaskIntoConstraints = false
        footerHost.setContentCompressionResistancePriority(.required, for: .vertical)
        footerHost.setContentHuggingPriority(.required, for: .vertical)
        footerHost.addSubview(footerRow)
        footerRow.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            footerHost.heightAnchor.constraint(equalToConstant: 42),
            footerRow.leadingAnchor.constraint(equalTo: footerHost.leadingAnchor, constant: 14),
            footerRow.trailingAnchor.constraint(equalTo: footerHost.trailingAnchor, constant: -14),
            footerRow.centerYAnchor.constraint(equalTo: footerHost.centerYAnchor)
        ])

        for sub in [headerHost, contentScroll, footerHost] {
            rootSurface.addSubview(sub)
        }
        NSLayoutConstraint.activate([
            headerHost.topAnchor.constraint(equalTo: rootSurface.topAnchor),
            headerHost.leadingAnchor.constraint(equalTo: rootSurface.leadingAnchor),
            headerHost.trailingAnchor.constraint(equalTo: rootSurface.trailingAnchor),

            contentScroll.topAnchor.constraint(equalTo: headerHost.bottomAnchor),
            contentScroll.leadingAnchor.constraint(equalTo: rootSurface.leadingAnchor),
            contentScroll.trailingAnchor.constraint(equalTo: rootSurface.trailingAnchor),
            contentScroll.bottomAnchor.constraint(equalTo: footerHost.topAnchor),

            footerHost.leadingAnchor.constraint(equalTo: rootSurface.leadingAnchor),
            footerHost.trailingAnchor.constraint(equalTo: rootSurface.trailingAnchor),
            footerHost.bottomAnchor.constraint(equalTo: rootSurface.bottomAnchor)
        ])
        self.view = rootSurface
        applyActiveTabVisibility()
    }

    private func buildUsageTab() {
        usageRoot.orientation = .vertical
        usageRoot.alignment = .leading
        usageRoot.spacing = 6
        usageRoot.detachesHiddenViews = true

        let row1 = horizontal([tokensTile, requestsTile], spacing: 7)
        row1.distribution = .fillEqually
        let row2 = horizontal([costTile, cacheTile], spacing: 7)
        row2.distribution = .fillEqually

        let trendTitleCol = vertical([trendTitleLabel, trendCoverageLabel], spacing: 2)
        trendTitleCol.alignment = .leading
        trendCoverageLabel.alphaValue = 0.0
        trendCoverageLabel.lineBreakMode = .byTruncatingTail
        trendCoverageLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let trendHeader = horizontal([trendTitleCol, flexibleSpace(), chartDimensionToggle], spacing: 8)
        trendHeader.alignment = .centerY
        trendHeader.translatesAutoresizingMaskIntoConstraints = false
        trendHeader.heightAnchor.constraint(equalToConstant: 32).isActive = true
        let trendContent = vertical([trendHeader, trendChart], spacing: 4)
        trendContent.detachesHiddenViews = true
        fillWidth(trendHeader, in: trendContent)
        fillWidth(trendChart, in: trendContent)
        let trendCard = group([trendContent], inset: 9)
        trendCard.cornerRadius = Design.Radius.popover
        trendCard.fillColor = Design.popoverCardBackground
        trendCard.borderColor = Design.popoverCardBorder

        modelsHeaderCountLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        let modelsHeader = horizontal([text("模型用量", size: 12.5, weight: .semibold, color: .labelColor), flexibleSpace(), modelsHeaderCountLabel], spacing: 8)
        modelsHeader.alignment = .centerY
        modelsListStack.orientation = .vertical
        modelsListStack.alignment = .leading
        modelsListStack.spacing = 4
        modelsListStack.detachesHiddenViews = true
        toggleModelsButton.isHidden = true

        let modelsContent = vertical([modelsHeader, divider(), modelsListStack, toggleModelsButton], spacing: 4)
        modelsContent.detachesHiddenViews = true
        fillWidth(modelsHeader, in: modelsContent)
        fillWidth(modelsListStack, in: modelsContent)
        let modelsCard = group([modelsContent], inset: 9)
        modelsCard.cornerRadius = Design.Radius.popover
        modelsCard.fillColor = Design.popoverCardBackground
        modelsCard.borderColor = Design.popoverCardBorder

        usageFooterLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
        usageFooterLabel.alignment = .right
        usageFooterLabel.textColor = Design.secondary

        for section in [periodSelector, usageScopeLabel, row1, row2, trendCard, modelsCard, usageFooterLabel] {
            usageRoot.addArrangedSubview(section)
            fillWidth(section, in: usageRoot)
        }
        usageRoot.setCustomSpacing(6, after: modelsCard)
    }

    private func buildQuotaTab() {
        quotaRoot.orientation = .vertical
        quotaRoot.alignment = .leading
        quotaRoot.spacing = 10
        quotaRoot.detachesHiddenViews = true

        quotaAccountNameLabel.lineBreakMode = .byTruncatingTail
        quotaAccountNameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        quotaTierBadge.setContentCompressionResistancePriority(.required, for: .horizontal)
        quotaStatusBadge.setContentCompressionResistancePriority(.required, for: .horizontal)
        quotaEmailLabel.font = .systemFont(ofSize: 11.5, weight: .regular)
        quotaEmailLabel.lineBreakMode = .byTruncatingMiddle

        let copyMenu = NSMenu()
        let copyItem = NSMenuItem(title: "复制完整邮箱", action: #selector(copyQuotaHeaderEmail), keyEquivalent: "")
        copyItem.target = self
        copyMenu.addItem(copyItem)
        quotaEmailLabel.menu = copyMenu

        let nameRow = horizontal([quotaAccountNameLabel, quotaTierBadge, quotaStatusBadge, flexibleSpace()], spacing: 6)
        nameRow.alignment = .centerY
        nameRow.detachesHiddenViews = true
        let identityStack = vertical([nameRow, quotaEmailLabel], spacing: 4)
        fillWidth(nameRow, in: identityStack)
        fillWidth(quotaEmailLabel, in: identityStack)
        let identityCard = group([identityStack], inset: 12)
        identityCard.cornerRadius = Design.Radius.medium
        identityCard.fillColor = Design.popoverCardBackground
        identityCard.borderColor = Design.popoverCardBorder

        let geminiHeader = MenuQuotaHelpers.groupHeader("Gemini", brands: ["gemini"])
        let geminiStack = vertical([geminiHeader, quotaGemini5h, quotaGeminiWeekly], spacing: 6)
        fillWidth(geminiHeader, in: geminiStack)
        fillWidth(quotaGemini5h, in: geminiStack)
        fillWidth(quotaGeminiWeekly, in: geminiStack)

        let claudeHeader = MenuQuotaHelpers.groupHeader("Claude/GPT", brands: ["claude", "openai"])
        let claudeStack = vertical([claudeHeader, quotaClaude5h, quotaClaudeWeekly], spacing: 6)
        fillWidth(claudeHeader, in: claudeStack)
        fillWidth(quotaClaude5h, in: claudeStack)
        fillWidth(quotaClaudeWeekly, in: claudeStack)

        quotaArgon.accessibilityGroupName = "Gemini 4 Argon"
        let argonHeader = MenuQuotaHelpers.groupHeader("Gemini 4 Argon", brands: ["gemini"])
        let argonStack = vertical([argonHeader, quotaArgon], spacing: 6)
        fillWidth(argonHeader, in: argonStack)
        fillWidth(quotaArgon, in: argonStack)

        quotaCarbon.accessibilityGroupName = "Gemini 4 Carbon"
        let carbonHeader = MenuQuotaHelpers.groupHeader("Gemini 4 Carbon", brands: ["gemini"])
        let carbonStack = vertical([carbonHeader, quotaCarbon], spacing: 6)
        fillWidth(carbonHeader, in: carbonStack)
        fillWidth(quotaCarbon, in: carbonStack)

        quotaExtraStandaloneStack.orientation = .vertical
        quotaExtraStandaloneStack.alignment = .leading
        quotaExtraStandaloneStack.spacing = 8
        quotaExtraStandaloneStack.isHidden = true
        quotaExtraStandaloneStack.detachesHiddenViews = true

        let unifiedQuotaContent = vertical([
            geminiStack,
            divider(),
            claudeStack,
            divider(),
            argonStack,
            divider(),
            carbonStack,
            quotaExtraStandaloneStack
        ], spacing: 8)
        unifiedQuotaContent.detachesHiddenViews = true
        for v in unifiedQuotaContent.arrangedSubviews { fillWidth(v, in: unifiedQuotaContent) }

        let quotaUnifiedCard = group([unifiedQuotaContent], inset: 12)
        quotaUnifiedCard.cornerRadius = Design.Radius.medium
        quotaUnifiedCard.fillColor = Design.popoverCardBackground
        quotaUnifiedCard.borderColor = Design.popoverCardBorder

        quotaGroupsContainer.orientation = .vertical
        quotaGroupsContainer.alignment = .leading
        quotaGroupsContainer.spacing = 0
        quotaGroupsContainer.addArrangedSubview(quotaUnifiedCard)
        fillWidth(quotaUnifiedCard, in: quotaGroupsContainer)

        quotaWarningLabel.isHidden = true
        quotaEmptyButton.isHidden = true
        quotaFooterLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
        quotaFooterLabel.alignment = .right
        quotaFooterLabel.textColor = Design.secondary

        for section in [identityCard, quotaGroupsContainer, quotaEmptyButton, quotaWarningLabel, quotaFooterLabel] {
            quotaRoot.addArrangedSubview(section)
            fillWidth(section, in: quotaRoot)
        }
    }

    private func buildAccountsTab() {
        accountsRoot.orientation = .vertical
        accountsRoot.alignment = .leading
        accountsRoot.spacing = 8
        accountsRoot.detachesHiddenViews = true

        accountsCountLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        let topRow = horizontal([text("已保存账号", size: 12.5, weight: .semibold, color: .labelColor), flexibleSpace(), accountsCountLabel], spacing: 8)
        topRow.alignment = .centerY

        accountsCardsStack.orientation = .vertical
        accountsCardsStack.alignment = .leading
        accountsCardsStack.spacing = 8
        accountsCardsStack.detachesHiddenViews = true

        for section in [topRow, accountsCardsStack] {
            accountsRoot.addArrangedSubview(section)
            fillWidth(section, in: accountsRoot)
        }
    }

    private func performWithoutAnimation(_ block: () -> Void) {
        let savedOrigin = contentScroll.contentView.bounds.origin
        NSAnimationContext.beginGrouping()
        NSAnimationContext.current.duration = 0
        NSAnimationContext.current.allowsImplicitAnimation = false
        block()
        updatePreferredPanelSize()
        let maxY = max(0, documentContainer.bounds.height - contentScroll.contentView.bounds.height)
        let clampedY = max(0, min(savedOrigin.y, maxY))
        if abs(contentScroll.contentView.bounds.origin.y - clampedY) > 0.5 {
            contentScroll.contentView.scroll(to: NSPoint(x: 0, y: clampedY))
            contentScroll.reflectScrolledClipView(contentScroll.contentView)
        }
        NSAnimationContext.endGrouping()
    }

    // MARK: - Lifecycle & Tab Switching

    func panelWillOpen() {
        let _ = self.view
        trendChart.resetHoverState()
        let cfgTab = max(0, min(2, app.configuration?.value.menuSelectedTab ?? selectedTab))
        let cfgPeriod = max(0, min(3, app.configuration?.value.menuUsagePeriod ?? selectedPeriod))
        let cfgDim: MenuTrendChartView.Dimension = (app.configuration?.value.menuTrendMetric == "requests") ? .requests : .tokens
        selectedTab = cfgTab
        selectedPeriod = cfgPeriod
        selectedChartDimension = cfgDim
        tabSelector.setSelected(selectedTab)
        periodSelector.setSelected(selectedPeriod)
        chartDimensionToggle.setSelected(selectedChartDimension == .requests ? 1 : 0)
        trendChart.dimension = selectedChartDimension
        performWithoutAnimation {
            applyActiveTabVisibility(resetScroll: true)
            syncFromAssistant()
        }
        ensureDataForActiveTab(force: false)
    }

    func panelDidClose() {
        trendChart.stopAnimation()
    }

    func selectTab(_ index: Int, persist: Bool = true) {
        let prevTab = selectedTab
        let clamped = max(0, min(2, index))
        selectedTab = clamped
        tabSelector.setSelected(clamped)
        trendChart.resetHoverState()
        if persist, app.configuration?.value.menuSelectedTab != clamped {
            app.configuration?.value.menuSelectedTab = clamped
            app.scheduleConfigurationSave()
        }
        let shouldAnimate = Design.shouldAnimate(in: view) && app.menuPopover?.isShown == true
        if shouldAnimate {
            applyActiveTabVisibility(resetScroll: true)
            syncFromAssistant()
            updatePreferredPanelSize()
            let activeRoot: NSView = selectedTab == 0 ? usageRoot : (selectedTab == 1 ? quotaRoot : accountsRoot)
            activeRoot.wantsLayer = true
            let slideOffset: CGFloat = clamped > prevTab ? 16.0 : (clamped < prevTab ? -16.0 : 0.0)
            activeRoot.alphaValue = 0.0
            activeRoot.layer?.transform = CATransform3DMakeTranslation(slideOffset, 0, 0)
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.20
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                activeRoot.animator().alphaValue = 1.0
                activeRoot.layer?.transform = CATransform3DIdentity
            }
        } else {
            performWithoutAnimation {
                applyActiveTabVisibility(resetScroll: true)
                syncFromAssistant()
                let activeRoot: NSView = selectedTab == 0 ? usageRoot : (selectedTab == 1 ? quotaRoot : accountsRoot)
                activeRoot.alphaValue = 1.0
                activeRoot.layer?.transform = CATransform3DIdentity
            }
        }
        ensureDataForActiveTab(force: false)
    }

    func selectPeriod(_ index: Int, persist: Bool = true) {
        let clamped = max(0, min(3, index))
        selectedPeriod = clamped
        periodSelector.setSelected(clamped)
        if persist, app.configuration?.value.menuUsagePeriod != clamped {
            app.configuration?.value.menuUsagePeriod = clamped
            app.scheduleConfigurationSave()
        }
        renderedUsageSnapshotKey = ""
        renderedUsageModelKey = ""
        performWithoutAnimation {
            syncUsageTabFromCache()
        }
        let periodKey = Self.periods[clamped]
        app.fetchUsageSummary(period: periodKey, force: false)
    }

    func selectChartDimension(_ dimension: MenuTrendChartView.Dimension, persist: Bool = true) {
        selectedChartDimension = dimension
        chartDimensionToggle.setSelected(dimension == .requests ? 1 : 0)
        trendChart.dimension = dimension
        if persist, app.configuration?.value.menuTrendMetric != dimension.rawValue {
            app.configuration?.value.menuTrendMetric = dimension.rawValue
            app.scheduleConfigurationSave()
        }
        renderedUsageSnapshotKey = ""
        performWithoutAnimation {
            syncUsageTabFromCache()
        }
    }

    @objc func toggleAllModelsPressed() {
        showAllModels.toggle()
        renderedUsageModelKey = ""
        if Design.shouldAnimate(in: view) && app.menuPopover?.isShown == true {
            syncUsageTabFromCache()
            updatePreferredPanelSize()
        } else {
            performWithoutAnimation {
                syncUsageTabFromCache()
            }
        }
    }

    private func applyActiveTabVisibility(resetScroll: Bool = false) {
        usageRoot.isHidden = (selectedTab != 0)
        quotaRoot.isHidden = (selectedTab != 1)
        accountsRoot.isHidden = (selectedTab != 2)
        headerRefreshButton.title = "刷新"
        headerRefreshButton.toolTip = nil
        switch selectedTab {
        case 0:
            openMainBtn.title = "打开用量页 ↗"
        case 1:
            openMainBtn.title = "打开总览页 ↗"
        default:
            openMainBtn.title = "打开账号页 ↗"
        }
        if resetScroll {
            contentScroll.contentView.scroll(to: .zero)
            contentScroll.reflectScrolledClipView(contentScroll.contentView)
        }
    }

    private func ensureDataForActiveTab(force: Bool) {
        guard app.reachable else { return }
        switch selectedTab {
        case 0:
            let periodKey = Self.periods[selectedPeriod]
            app.fetchUsageSummary(period: periodKey, force: force)
        case 1:
            if app.cachedAccounts.isEmpty {
                app.fetchAccountList(notifyPage: true)
            } else if force {
                if let active = app.resolvedMenuAccount(), let id = active["id"] as? String, !id.isEmpty {
                    app.refreshSingleAccountQuota(id: id)
                } else {
                    app.refreshAccountQuotas()
                }
            }
        default:
            if app.cachedAccounts.isEmpty {
                app.fetchAccountList(notifyPage: true)
            } else if force {
                app.refreshAccountQuotas()
            }
        }
    }

    func refreshCurrentTab() {
        ensureDataForActiveTab(force: true)
    }

    @objc private func refreshPressed() {
        refreshCurrentTab()
    }

    @objc private func morePressed() {
        let menu = app.buildMoreMenu()
        Design.popUpMenu(menu, below: moreButton)
    }

    @objc private func openAntigravityFromFooter() {
        app.closeMenuPopover()
        app.openAntigravity()
    }

    @objc private func openMainFromFooter() {
        app.openMainWindowFromMenuPanel(tab: selectedTab, usagePeriod: selectedPeriod)
    }

    @objc private func openAccountsFromQuotaEmpty() {
        app.showAccountsFromMenuCard()
    }

    @objc private func copyQuotaHeaderEmail() {
        guard !quotaHeaderEmail.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(quotaHeaderEmail, forType: .string)
    }

    // MARK: - Synchronization with Assistant Data Domains

    func onUsageReportUpdated(period: String, result: Result<[String: Any], Error>) {
        guard isViewLoaded else { return }
        let currentPeriodKey = Self.periods[selectedPeriod]
        if period == currentPeriodKey, selectedTab == 0 {
            performWithoutAnimation {
                syncUsageTabFromCache()
                syncHeaderRefreshState()
            }
        }
    }

    func syncFromAssistant() {
        guard isViewLoaded else { return }
        performWithoutAnimation {
            syncHeaderRefreshState()
            switch selectedTab {
            case 0:
                syncUsageTabFromCache()
            case 1:
                syncQuotaTab()
            default:
                syncAccountsTab()
            }
        }
    }

    func syncHeaderRefreshState() {
        guard isViewLoaded else { return }
        let periodKey = Self.periods[selectedPeriod]
        switch selectedTab {
        case 0:
            let busy = app.usageManualRefreshPeriods.contains(periodKey)
            headerRefreshButton.setBusy(busy, available: app.reachable)
        case 1:
            let active = app.resolvedMenuAccount()
            let activeId = active?["id"] as? String ?? app.activeAccountId
            let busy = app.quotaRefreshing || (!activeId.isEmpty && app.refreshingAccountIds.contains(activeId))
            headerRefreshButton.setBusy(busy, available: app.reachable && (!activeId.isEmpty || !app.cachedAccounts.isEmpty))
        default:
            let busy = app.quotaRefreshing
            headerRefreshButton.setBusy(busy, available: app.reachable && !app.cachedAccounts.isEmpty)
        }
    }

    // MARK: - Tab 0 Rendering (Usage)

    private func syncUsageTabFromCache() {
        let periodKey = Self.periods[selectedPeriod]
        let periodLabel = Self.periodLabels[selectedPeriod]
        trendTitleLabel.stringValue = selectedPeriod == 0 ? "今日趋势" : (selectedPeriod == 3 ? "全部趋势" : "\(periodLabel)趋势")

        guard let report = app.cachedUsageReportsByPeriod[periodKey] else {
            if let err = app.usageFetchErrorsByPeriod[periodKey], !err.isEmpty {
                usageScopeLabel.stringValue = "读取失败：\(err)"
                usageScopeLabel.textColor = accessibleWarningColor()
                usageScopeLabel.isHidden = false
                for tile in [tokensTile, requestsTile, costTile, cacheTile] { tile.setValueText("—") }
                usageFooterLabel.stringValue = "无法读取统计 · 点击右上角「刷新」重试"
                usageFooterLabel.textColor = accessibleWarningColor()
            } else if !app.reachable {
                usageScopeLabel.stringValue = "正在等待本机服务…"
                usageScopeLabel.textColor = Design.secondary
                usageScopeLabel.isHidden = false
                for tile in [tokensTile, requestsTile, costTile, cacheTile] { tile.setValueText("—") }
                usageFooterLabel.stringValue = "本机服务离线"
                usageFooterLabel.textColor = accessibleWarningColor()
            } else {
                usageScopeLabel.isHidden = true
            }
            return
        }

        let summary = report["summary"] as? [String: Any] ?? [:]
        let availability = summary["availability"] as? String ?? "complete"
        if availability == "unavailable" {
            usageScopeLabel.stringValue = "所选会话数据库均读取失败"
            usageScopeLabel.textColor = accessibleWarningColor()
            usageScopeLabel.isHidden = false
            for tile in [tokensTile, requestsTile, costTile, cacheTile] { tile.setValueText("—", warning: true) }
            trendChart.buckets = []
            modelsListStack.arrangedSubviews.forEach { modelsListStack.removeArrangedSubview($0); $0.removeFromSuperview() }
            renderedModelNames.removeAll()
            usageFooterLabel.stringValue = "统计暂不可用 · 可打开主界面查看诊断详情"
            usageFooterLabel.textColor = accessibleWarningColor()
            return
        }

        let total = intVal(summary, "totalTokens")
        let requests = intVal(summary, "requestCount")
        let usd = doubleVal(summary, "estimatedUsd")
        let prompt = intVal(summary, "promptTokens")
        let cached = intVal(summary, "cachedTokens")
        let denom = prompt + cached
        let cacheHit = doubleVal(summary, "cacheHitRate", fallback: denom > 0 ? (Double(cached) / Double(denom)) * 100.0 : 0.0)
        let pricedCount = intVal(summary, "pricedModels", fallback: intVal(summary, "priced_models"))
        let unpricedCount = intVal(summary, "unpricedModels", fallback: intVal(summary, "unpriced_models"))

        let scanned = intVal(summary, "databasesScanned")
        let discovered = intVal(summary, "databasesDiscovered", fallback: scanned)
        let failed = intVal(summary, "failedDatabasesCount")
        let skipped = intVal(summary, "skippedLargeRecords")
        let unknown = intVal(summary, "unknownTimeRecords")
        if failed > 0 || skipped > 0 || unknown > 0 || (discovered > 0 && scanned < discovered) {
            usageScopeLabel.stringValue = InterfaceText.usageScope(scanned: scanned, discovered: discovered, failed: failed, skipped: skipped, unknown: unknown)
            usageScopeLabel.textColor = accessibleWarningColor()
            usageScopeLabel.isHidden = false
        } else {
            usageScopeLabel.stringValue = ""
            usageScopeLabel.isHidden = true
        }

        tokensTile.setValueText(InterfaceText.formatCompactTokens(total, formatSmallWithLocale: true))
        tokensTile.toolTip = nil
        requestsTile.setValueText("\(requests.formatted())")
        let isAllUnpriced = unpricedCount > 0 && pricedCount == 0 && total > 0 && usd == 0
        costTile.setValueText(isAllUnpriced ? "未计价" : (unpricedCount > 0 ? "部分 " : "") + InterfaceText.formatUsd(usd))
        cacheTile.setValueText(denom > 0 ? String(format: "%.1f%%", cacheHit) : "—")

        let snapKey = "\(report["snapshotId"] ?? ""):\(periodKey):\(selectedChartDimension.rawValue):\(total):\(requests):\(failed):\(unknown)"
        if snapKey != renderedUsageSnapshotKey {
            renderedUsageSnapshotKey = snapKey
            updateMenuTrendBuckets(report: report, summary: summary)
        }

        let models = (report["byModel"] as? [[String: Any]]) ?? (report["models"] as? [[String: Any]]) ?? []
        let modelKey = "\(report["snapshotId"] ?? ""):\(periodKey):\(models.count):\(showAllModels):\(total)"
        if modelKey != renderedUsageModelKey {
            renderedUsageModelKey = modelKey
            rebuildMenuModelList(models: models, totalTokens: total)
        }

        let lastScan = doubleVal(summary, "lastScannedAt", fallback: doubleVal(summary, "generated_at"))
        let timeStr = lastScan > 0 ? Self.timeFormatter.string(from: Date(timeIntervalSince1970: lastScan)) : "刚刚"
        var footerParts: [String] = ["更新于 \(timeStr)"]
        if let fetchErr = app.usageFetchErrorsByPeriod[periodKey], !fetchErr.isEmpty {
            footerParts.append("刷新失败 · 沿用上次记录")
        } else if availability == "cached" {
            footerParts.append("沿用缓存快照")
        } else if failed > 0 {
            footerParts.append("\(failed) 个会话库异常")
        }
        usageFooterLabel.stringValue = footerParts.joined(separator: " · ")
        usageFooterLabel.textColor = (app.usageFetchErrorsByPeriod[periodKey] != nil || failed > 0 || availability == "cached")
            ? accessibleWarningColor()
            : Design.secondary
    }

    private func updateMenuTrendBuckets(report: [String: Any], summary: [String: Any]) {
        let isTokens = (selectedChartDimension == .tokens)
        if selectedPeriod == 0 {
            let hourly = (report["todayHourly"] as? [[String: Any]]) ?? (summary["today_hourly"] as? [[String: Any]]) ?? []
            var hourValMap: [String: Int] = [:]
            for h in hourly {
                if let hourStr = h["hour"] as? String, let suffix = hourStr.split(separator: " ").last {
                    let v = isTokens
                        ? (intVal(h, "total_tokens", fallback: intVal(h, "totalTokens")))
                        : (intVal(h, "request_count", fallback: intVal(h, "requestCount")))
                    hourValMap[String(suffix), default: 0] += v
                }
            }
            let currentHour = Calendar.current.component(.hour, from: Date())
            var pts: [MenuTrendChartView.Bucket] = []
            for hr in 0..<24 {
                let key = String(format: "%02d:00", hr)
                let rawVal = hourValMap[key] ?? 0
                let isFuture = (rawVal == 0 && hr > currentHour)
                pts.append(.init(label: String(format: "%02d时", hr), tooltipLabel: "今日 \(key)", value: rawVal, isFuture: isFuture))
            }
            trendChart.buckets = pts
            activePeriodTrendNote = ""
            trendCoverageLabel.stringValue = ""
            trendCoverageLabel.alphaValue = 0.0
            return
        }

        let daily = (report["dailyTrends"] as? [[String: Any]]) ?? (summary["daily_trends"] as? [[String: Any]]) ?? []
        let targetSlice: ArraySlice<[String: Any]>
        if selectedPeriod == 1 {
            targetSlice = daily.suffix(7)
        } else if selectedPeriod == 2 {
            targetSlice = daily.suffix(30)
        } else {
            targetSlice = daily[...]
        }

        if selectedPeriod == 3 && targetSlice.count > 90 {
            // 按自然月 (yyyy-MM) 聚合
            var monthOrder: [String] = []
            var monthTotals: [String: Int] = [:]
            for d in targetSlice {
                let dateStr = (d["date"] as? String) ?? ""
                let monthKey = dateStr.count >= 7 ? String(dateStr.prefix(7)) : dateStr
                guard !monthKey.isEmpty else { continue }
                if monthTotals[monthKey] == nil { monthOrder.append(monthKey) }
                let v = isTokens
                    ? intVal(d, "total_tokens", fallback: intVal(d, "totalTokens"))
                    : intVal(d, "request_count", fallback: intVal(d, "requestCount"))
                monthTotals[monthKey, default: 0] += v
            }
            trendChart.buckets = monthOrder.map { m in
                let shortLbl = m.count >= 7 ? String(m.suffix(5)) : m
                return .init(label: shortLbl, tooltipLabel: "\(m) 月汇总", value: monthTotals[m] ?? 0, isFuture: false)
            }
        } else if selectedPeriod == 3 && targetSlice.count > 31 {
            // 按 7 天周桶聚合
            let items = Array(targetSlice)
            var buckets: [MenuTrendChartView.Bucket] = []
            var idx = 0
            while idx < items.count {
                let endIdx = min(items.count, idx + 7)
                let chunk = items[idx..<endIdx]
                let startD = (chunk.first?["date"] as? String) ?? ""
                let endD = (chunk.last?["date"] as? String) ?? ""
                let shortStart = startD.count >= 10 ? String(startD.suffix(5)) : startD
                let sumVal = chunk.reduce(0) { acc, item in
                    let v = isTokens
                        ? intVal(item, "total_tokens", fallback: intVal(item, "totalTokens"))
                        : intVal(item, "request_count", fallback: intVal(item, "requestCount"))
                    return acc + v
                }
                buckets.append(.init(label: shortStart, tooltipLabel: "\(startD) 至 \(endD)", value: sumVal, isFuture: false))
                idx = endIdx
            }
            trendChart.buckets = buckets
        } else {
            trendChart.buckets = targetSlice.map { d in
                let dateStr = (d["date"] as? String) ?? ""
                let shortDate = dateStr.count >= 10 ? String(dateStr.suffix(5)) : dateStr
                let v = isTokens
                    ? intVal(d, "total_tokens", fallback: intVal(d, "totalTokens"))
                    : intVal(d, "request_count", fallback: intVal(d, "requestCount"))
                return .init(label: shortDate, tooltipLabel: dateStr, value: v, isFuture: false)
            }
        }
        activePeriodTrendNote = ""
        trendCoverageLabel.stringValue = ""
        trendCoverageLabel.alphaValue = 0.0
    }

    private func rebuildMenuModelList(models: [[String: Any]], totalTokens: Int) {
        modelsHeaderCountLabel.stringValue = models.isEmpty ? "暂无记录" : "\(models.count) 个模型"

        guard !models.isEmpty else {
            modelRowViewsByName.removeAll()
            modelDividerViewsByName.removeAll()
            renderedModelNames.removeAll()
            modelsListStack.arrangedSubviews.forEach {
                modelsListStack.removeArrangedSubview($0)
                $0.removeFromSuperview()
            }
            let emptyLbl = text("当前时间范围暂无模型调用记录", size: 11.5, color: Design.secondary)
            modelsListStack.addArrangedSubview(emptyLbl)
            toggleModelsButton.isHidden = true
            return
        }

        let allNames = models.map { ($0["model"] as? String) ?? "未知模型" }
        let validNames = Set(allNames)
        modelRowViewsByName = modelRowViewsByName.filter { validNames.contains($0.key) }
        modelDividerViewsByName = modelDividerViewsByName.filter { validNames.contains($0.key) }

        for item in models {
            let rawName = (item["model"] as? String) ?? "未知模型"
            let mTokens = intVal(item, "totalTokens", fallback: intVal(item, "total_tokens"))
            let ratio = totalTokens > 0 ? CGFloat(mTokens) / CGFloat(totalTokens) : 0
            let tokensStr = InterfaceText.formatCompactTokens(mTokens, formatSmallWithLocale: true)

            if let existing = modelRowViewsByName[rawName] {
                existing.update(tokensText: tokensStr, shareFraction: ratio)
            } else {
                let rowView = MenuModelUsageItemView(
                    model: rawName,
                    tokensText: tokensStr,
                    shareFraction: ratio
                )
                modelRowViewsByName[rawName] = rowView
            }
        }

        if allNames != renderedModelNames {
            renderedModelNames = allNames
            modelsListStack.arrangedSubviews.forEach {
                modelsListStack.removeArrangedSubview($0)
                $0.removeFromSuperview()
            }
            for (idx, name) in allNames.enumerated() {
                guard let rowView = modelRowViewsByName[name] else { continue }
                if idx > 0 {
                    let line = modelDividerViewsByName[name] ?? {
                        let d = divider()
                        modelDividerViewsByName[name] = d
                        return d
                    }()
                    modelsListStack.addArrangedSubview(line)
                    fillWidth(line, in: modelsListStack)
                }
                modelsListStack.addArrangedSubview(rowView)
                fillWidth(rowView, in: modelsListStack)
            }
        }

        let visibleCount = showAllModels ? allNames.count : min(3, allNames.count)
        for (idx, name) in allNames.enumerated() {
            let shouldHide = idx >= visibleCount
            if let rowView = modelRowViewsByName[name], rowView.isHidden != shouldHide {
                rowView.isHidden = shouldHide
            }
            if idx > 0, let divView = modelDividerViewsByName[name], divView.isHidden != shouldHide {
                divView.isHidden = shouldHide
            }
        }

        if models.count > 3 {
            toggleModelsButton.title = showAllModels ? "收起其余模型" : "展开其余 \(models.count - 3) 个模型"
            toggleModelsButton.isHidden = false
        } else {
            toggleModelsButton.isHidden = true
        }
    }

    // MARK: - Tab 1 Rendering (Quota)

    private func syncQuotaTab() {
        let active = app.resolvedMenuAccount()
        guard let account = active else {
            let liveUnsaved = !app.statusValue.liveAccountEmail.isEmpty
            quotaAccountNameLabel.stringValue = !app.reachable ? "正在等待本机服务…" : (liveUnsaved ? "运行中账号尚未保存" : "尚未保存账号")
            quotaEmailLabel.stringValue = liveUnsaved ? "检测到 \(app.statusValue.liveAccountEmail)，请前往账号页保存" : "点击下方按钮在主界面保存当前账号或登录备用账号"
            quotaHeaderEmail = app.statusValue.liveAccountEmail
            quotaTierBadge.isHidden = true
            quotaStatusBadge.isHidden = true
            quotaGroupsContainer.isHidden = true
            quotaEmptyButton.isHidden = false
            quotaWarningLabel.isHidden = true
            quotaFooterLabel.stringValue = app.reachable ? "保存账号后即可在菜单栏实时查看各模型周期配额" : "本机服务离线"
            quotaFooterLabel.textColor = .secondaryLabelColor
            return
        }

        quotaGroupsContainer.isHidden = false
        quotaEmptyButton.isHidden = true

        let id = account["id"] as? String ?? ""
        let email = account["email"] as? String ?? ""
        quotaHeaderEmail = email
        let display = AccountIdentity.displayName(name: account["name"] as? String, email: email)
        let tier = AccountIdentity.normalizeTier(account["subscription_tier"] as? String)
        quotaAccountNameLabel.stringValue = display
        quotaEmailLabel.stringValue = email
        quotaEmailLabel.toolTip = nil
        quotaTierBadge.title = tier
        quotaTierBadge.tint = tier == "ULTRA" ? .systemPurple : (tier == "PRO" ? .systemBlue : Design.inactivePill)
        quotaTierBadge.isHidden = tier.isEmpty

        let liveEmail = app.statusValue.liveAccountEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        let isLiveMatch = !liveEmail.isEmpty && liveEmail.caseInsensitiveCompare(email) == .orderedSame
        if isLiveMatch {
            quotaStatusBadge.title = "当前账号"
            quotaStatusBadge.tint = Design.blue
            quotaStatusBadge.isHidden = false
        } else if !liveEmail.isEmpty {
            quotaStatusBadge.title = "已选记录 · 非运行账号"
            quotaStatusBadge.tint = accessibleWarningColor()
            quotaStatusBadge.isHidden = false
        } else {
            quotaStatusBadge.title = "已选记录"
            quotaStatusBadge.tint = Design.inactivePill
            quotaStatusBadge.isHidden = false
        }

        let contract = QuotaPresentation.contract(account)
        quotaGemini5h.titleLabel.stringValue = contract.geminiPrimary.label
        quotaGemini5h.apply(percentage: contract.geminiPrimary.window?.percentage, placeholder: contract.geminiPrimary.window?.placeholder ?? "未知", reset: contract.geminiPrimary.window?.resetText ?? "", stale: contract.geminiPrimary.window?.stale == true)
        quotaGeminiWeekly.titleLabel.stringValue = "每周"
        quotaGeminiWeekly.apply(percentage: contract.geminiWeekly?.percentage, placeholder: contract.geminiWeekly?.placeholder ?? "未知", reset: contract.geminiWeekly?.resetText ?? "", stale: contract.geminiWeekly?.stale == true)

        quotaClaude5h.titleLabel.stringValue = contract.claudePrimary.label
        quotaClaude5h.apply(percentage: contract.claudePrimary.window?.percentage, placeholder: contract.claudePrimary.window?.placeholder ?? "未知", reset: contract.claudePrimary.window?.resetText ?? "", stale: contract.claudePrimary.window?.stale == true)
        quotaClaudeWeekly.titleLabel.stringValue = "每周"
        quotaClaudeWeekly.apply(percentage: contract.claudeWeekly?.percentage, placeholder: contract.claudeWeekly?.placeholder ?? "未知", reset: contract.claudeWeekly?.resetText ?? "", stale: contract.claudeWeekly?.stale == true)

        let argonState = contract.argon
        let argonPlaceholder = argonState?.availability == "disabled" ? "不可用" : (argonState?.placeholder ?? "未知")
        switch argonState?.periodLabel {
        case "5小时": quotaArgon.titleLabel.stringValue = "5 小时"
        case "每周": quotaArgon.titleLabel.stringValue = "每周"
        case "周期未知": quotaArgon.titleLabel.stringValue = "周期未知"
        default: quotaArgon.titleLabel.stringValue = ""
        }
        quotaArgon.apply(percentage: argonState?.percentage, placeholder: argonPlaceholder, reset: argonState?.percentage == nil ? "" : (argonState?.resetText ?? ""), stale: argonState?.stale == true)

        let carbonState = contract.carbon
        let carbonPlaceholder = carbonState?.availability == "disabled" ? "不可用" : (carbonState?.placeholder ?? "未知")
        switch carbonState?.periodLabel {
        case "5小时": quotaCarbon.titleLabel.stringValue = "5 小时"
        case "每周": quotaCarbon.titleLabel.stringValue = "每周"
        case "周期未知": quotaCarbon.titleLabel.stringValue = "周期未知"
        default: quotaCarbon.titleLabel.stringValue = ""
        }
        quotaCarbon.apply(percentage: carbonState?.percentage, placeholder: carbonPlaceholder, reset: carbonState?.percentage == nil ? "" : (carbonState?.resetText ?? ""), stale: carbonState?.stale == true)

        MenuQuotaHelpers.syncExtraStandaloneGroups(contract.extraStandaloneModels, into: quotaExtraStandaloneStack, withLeadingDividers: true, headerFontSize: 11.5, iconSize: 13)

        var warnings: [String] = []
        if let readiness = account["credentialReadiness"] as? [String: Any], readiness["state"] as? String == "needs_authorization" {
            warnings.append("登录授权已失效，请前往主界面重新授权")
        }
        if let singleErr = app.singleAccountRefreshErrors[id], !singleErr.isEmpty {
            warnings.append(InterfaceText.quotaMessage(singleErr))
        } else if let refreshErr = account["quota_refresh_error"] as? String, !refreshErr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !refreshErr.contains("双周期") {
            warnings.append(InterfaceText.quotaMessage(refreshErr))
        } else if let globalErr = app.quotaRefreshError, !globalErr.isEmpty, !InterfaceText.isMultiAccountSummary(globalErr) {
            warnings.append(InterfaceText.quotaMessage(globalErr))
        }
        if let quota = account["quota"] as? [String: Any], let staleGroups = quota["stale_groups"] as? [[String: Any]], !staleGroups.isEmpty {
            let names = staleGroups.compactMap { $0["name"] as? String }.filter { !$0.isEmpty }
            warnings.append("部分分组沿用上次记录：" + (names.isEmpty ? "部分分组" : names.joined(separator: "、")))
        }
        quotaWarningLabel.stringValue = warnings.joined(separator: "；")
        quotaWarningLabel.isHidden = warnings.isEmpty

        let quota = account["quota"] as? [String: Any]
        let stamp = QuotaPresentation.number(quota?["last_updated"]) ?? QuotaPresentation.number(account["quota_last_updated"]) ?? 0
        if app.quotaRefreshing || (!id.isEmpty && app.refreshingAccountIds.contains(id)) {
            quotaFooterLabel.stringValue = "正在刷新配额…"
            quotaFooterLabel.textColor = .secondaryLabelColor
        } else if stamp > 0 {
            let date = Date(timeIntervalSince1970: stamp)
            let fmt = Calendar.current.isDateInToday(date) ? Self.timeFormatter : Self.dateTimeFormatter
            let isStale = Date().timeIntervalSince(date) > 15 * 60
            quotaFooterLabel.stringValue = (!app.reachable ? "本机服务离线 · " : "") + "更新于 \(fmt.string(from: date))" + (isStale ? " · 待刷新" : "")
            quotaFooterLabel.textColor = isStale ? accessibleWarningColor() : .secondaryLabelColor
        } else {
            quotaFooterLabel.stringValue = "尚未取得配额记录"
            quotaFooterLabel.textColor = .secondaryLabelColor
        }
    }

    // MARK: - Tab 2 Rendering (Accounts)

    func toggleAccountExpanded(_ id: String) {
        if expandedAccountIds.contains(id) {
            expandedAccountIds.remove(id)
        } else {
            expandedAccountIds.insert(id)
        }
        if Design.shouldAnimate(in: view) && app.menuPopover?.isShown == true {
            syncAccountsTab()
            updatePreferredPanelSize()
        } else {
            performWithoutAnimation {
                syncAccountsTab()
            }
        }
    }

    private func syncAccountsTab() {
        let accounts = app.cachedAccounts
        accountsCountLabel.stringValue = "\(accounts.count) 个账号"

        guard !accounts.isEmpty else {
            accountCardsById.removeAll()
            renderedAccountIds.removeAll()
            accountsCardsStack.arrangedSubviews.forEach {
                accountsCardsStack.removeArrangedSubview($0)
                $0.removeFromSuperview()
            }
            let emptyLbl = text(app.reachable ? "暂无账号，请前往主界面添加" : "正在等待本机服务读取账号列表…", size: 11.5, color: Design.secondary, wrap: true)
            let box = group([emptyLbl], inset: 12)
            accountsCardsStack.addArrangedSubview(box)
            fillWidth(box, in: accountsCardsStack)
            return
        }

        let resolvedActive = app.resolvedMenuAccount()
        let activeId = (resolvedActive?["id"] as? String) ?? app.activeAccountId
        if !hasInitializedExpandedAccount, !activeId.isEmpty {
            expandedAccountIds.insert(activeId)
            hasInitializedExpandedAccount = true
        }

        let ordered = accounts.enumerated().sorted { lhs, rhs in
            let l = (lhs.element["id"] as? String) == activeId
            let r = (rhs.element["id"] as? String) == activeId
            return l == r ? lhs.offset < rhs.offset : l
        }.map(\.element)

        let nextIds = ordered.compactMap { $0["id"] as? String }
        let validSet = Set(nextIds)
        accountCardsById = accountCardsById.filter { validSet.contains($0.key) }

        let liveEmail = app.statusValue.liveAccountEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        let recommendedId = app.accountsPage?.recommendedAccountId

        for item in ordered {
            guard let id = item["id"] as? String, !id.isEmpty else { continue }
            let card = accountCardsById[id] ?? {
                let c = MenuExpandableAccountCardView(accountId: id)
                c.onToggleExpand = { [weak self] accId in self?.toggleAccountExpanded(accId) }
                c.onSwitchAccount = { [weak self] accId in self?.app.switchAccountByIdFromMenu(accId) }
                c.onRefreshSingle = { [weak self] accId in self?.app.refreshSingleAccountQuota(id: accId) }
                accountCardsById[id] = c
                return c
            }()
            let email = item["email"] as? String ?? ""
            let isCurrent = (id == activeId)
            let isLiveVerified = isCurrent && !liveEmail.isEmpty && liveEmail.caseInsensitiveCompare(email) == .orderedSame
            card.apply(
                account: item,
                isCurrent: isCurrent,
                isLiveVerified: isLiveVerified,
                isRecommended: id == recommendedId,
                isExpanded: expandedAccountIds.contains(id),
                reachable: app.reachable,
                switchInFlight: app.accountSwitchInFlight,
                globalBusy: app.quotaRefreshing,
                singleBusy: app.refreshingAccountIds.contains(id),
                singleError: app.singleAccountRefreshErrors[id]
            )
        }

        if nextIds != renderedAccountIds {
            renderedAccountIds = nextIds
            accountsCardsStack.arrangedSubviews.forEach {
                accountsCardsStack.removeArrangedSubview($0)
                $0.removeFromSuperview()
            }
            for id in nextIds {
                guard let card = accountCardsById[id] else { continue }
                accountsCardsStack.addArrangedSubview(card)
                fillWidth(card, in: accountsCardsStack)
            }
        }
    }

    // MARK: - Dynamic Content-Fitted Panel Height (Zero bottom blank gap, smooth micro-interpolation)

    func updatePreferredPanelSize() {
        guard isViewLoaded else { return }
        let contentWidth = Self.panelWidth - 28
        documentContainer.frame.size.width = Self.panelWidth
        documentContainer.layoutSubtreeIfNeeded()
        let activeRoot: NSView = selectedTab == 0 ? usageRoot : (selectedTab == 1 ? quotaRoot : accountsRoot)
        activeRoot.frame.size.width = contentWidth
        activeRoot.layoutSubtreeIfNeeded()
        documentContainer.layoutSubtreeIfNeeded()
        let contentHeight = ceil(activeRoot.fittingSize.height) + 20 // 10pt top + 10pt bottom inset
        let chromeHeight: CGFloat = 86 + 42 // header (86pt) + footer (42pt)
        let rawTotal = chromeHeight + contentHeight
        let activeScreen = app.item?.button?.window?.screen ?? viewIfLoaded?.window?.screen ?? NSScreen.main
        let screenMax = (activeScreen?.visibleFrame.height ?? 820) - 48
        let targetHeight = min(max(300, rawTotal), min(686, screenMax))
        let newSize = NSSize(width: Self.panelWidth, height: targetHeight)
        preferredContentSize = newSize
        let shouldAnimate = Design.shouldAnimate(in: view) && app.menuPopover?.isShown == true
        if let popover = app.menuPopover {
            if abs(popover.contentSize.height - newSize.height) > 0.5 || abs(popover.contentSize.width - newSize.width) > 0.5 {
                if shouldAnimate {
                    NSAnimationContext.runAnimationGroup { ctx in
                        ctx.duration = 0.18
                        ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                        popover.contentSize = newSize
                    }
                } else {
                    popover.contentSize = newSize
                }
            }
        } else if abs(view.frame.height - newSize.height) > 0.5 {
            if shouldAnimate {
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0.18
                    ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                    view.animator().frame.size = newSize
                }
            } else {
                view.frame.size = newSize
            }
        }
        view.layoutSubtreeIfNeeded()
    }
}

