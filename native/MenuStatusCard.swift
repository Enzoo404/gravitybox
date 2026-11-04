import Cocoa

/// 状态栏弹出卡片：固定宽度的纵向信息卡，直接展示当前账号与各家族配额。
/// 只使用语义色与透明背景，叠加在系统菜单毛玻璃材质上，浅色/深色外观自动适配。
final class MenuMeterBar: NSView {
    private let motion = DesignMotion()
    private var displayedFraction: CGFloat = 0
    var fraction: CGFloat? {
        didSet {
            guard oldValue != fraction else { return }
            guard let target = fraction, target > 0 else {
                motion.cancel()
                displayedFraction = 0
                needsDisplay = true
                return
            }
            let clamped = min(1, max(0, target))
            motion.animate(in: self, from: displayedFraction, to: clamped, curve: .sweep, threshold: 0.005) { [weak self] val in
                self?.displayedFraction = val
                self?.needsDisplay = true
            }
        }
    }
    var tint: NSColor = Design.blue { didSet { needsDisplay = true } }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: 6) }
    override var isOpaque: Bool { false }
    override var allowsVibrancy: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let radius = bounds.height / 2
        let track = NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius)
        NSColor.labelColor.withAlphaComponent(isDark ? 0.16 : 0.10).setFill(); track.fill()

        guard let fraction, fraction > 0 else { return }
        let effective = displayedFraction > 0 ? displayedFraction : min(1, fraction)
        let width = max(bounds.height, bounds.width * min(1, effective))
        NSGraphicsContext.current?.saveGraphicsState(); track.addClip()
        let fillRect = NSRect(x: 0, y: 0, width: width, height: bounds.height)
        let fillPath = NSBezierPath(roundedRect: fillRect, xRadius: radius, yRadius: radius)
        if let grad = NSGradient(starting: tint.withAlphaComponent(0.75), ending: tint) {
            grad.draw(in: fillPath, angle: 0)
        } else {
            tint.setFill(); fillPath.fill()
        }
        NSGraphicsContext.current?.restoreGraphicsState()
    }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
}

/// 单个配额窗口：标题 + 重置时间 + 百分比，下方一条细进度条。
final class MenuMeterRow: NSView {
    override var allowsVibrancy: Bool { false }
    let titleLabel = text("", size: 12, color: .labelColor)
    let resetLabel = text("", size: 10.5, color: .secondaryLabelColor)
    let valueLabel = text("", size: 12, weight: .semibold, color: .labelColor)
    let bar = MenuMeterBar()
    private var lastAppliedKey = ""

    init(title: String) {
        super.init(frame: .zero)
        titleLabel.stringValue = title
        titleLabel.alignment = .left
        if let cell = titleLabel.cell as? NSTextFieldCell { cell.lineBreakMode = .byTruncatingTail }
        valueLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        valueLabel.alignment = .right
        resetLabel.alignment = .right
        resetLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        valueLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        resetLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let top = horizontal([titleLabel, flexibleSpace(), resetLabel, valueLabel], spacing: 6)
        top.alignment = .firstBaseline
        let stack = vertical([top, bar], spacing: 4)
        stack.alignment = .leading
        addSubview(stack); pin(stack, to: self)
        fillWidth(top, in: stack); fillWidth(bar, in: stack)
        bar.heightAnchor.constraint(equalToConstant: 6).isActive = true
        valueLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 34).isActive = true
        setAccessibilityElement(true); setAccessibilityRole(.progressIndicator)
    }
    required init?(coder: NSCoder) { fatalError() }

    private var healthyTint: NSColor {
        Design.blue
    }

    /// percentage == nil 时只画灰色空轨道，并显示占位文字（未知 / 不可用 / 已过期）。
    func apply(percentage: Int?, placeholder: String, reset: String, stale: Bool) {
        let compactReset = MenuStatusCard.compactReset(reset)
        let key = "\(titleLabel.stringValue)|\(percentage.map(String.init) ?? "nil")|\(placeholder)|\(compactReset)|\(stale)"
        guard key != lastAppliedKey else { return }
        lastAppliedKey = key
        if resetLabel.stringValue != compactReset { resetLabel.stringValue = compactReset }
        if resetLabel.isHidden != compactReset.isEmpty { resetLabel.isHidden = compactReset.isEmpty }
        if let percentage {
            let value = max(0, min(100, percentage))
            valueLabel.stringValue = "\(value)%"
            let baseTint: NSColor
            if value <= 10 {
                baseTint = accessibleDangerColor()
            } else if value <= 20 {
                baseTint = accessibleWarningColor()
            } else {
                baseTint = healthyTint
            }
            bar.tint = stale ? baseTint.withAlphaComponent(0.45) : baseTint
            bar.fraction = CGFloat(value) / 100
            valueLabel.textColor = value <= 10 ? accessibleDangerColor() : value <= 20 ? accessibleWarningColor() : .labelColor
            resetLabel.textColor = stale ? accessibleWarningColor() : .secondaryLabelColor
            setAccessibilityValue(NSNumber(value: value))
        } else {
            valueLabel.stringValue = placeholder
            valueLabel.textColor = .secondaryLabelColor
            bar.fraction = nil
            bar.tint = healthyTint
            resetLabel.textColor = .secondaryLabelColor
            setAccessibilityValue(nil)
        }
        setAccessibilityLabel([titleLabel.stringValue, valueLabel.stringValue, compactReset].filter { !$0.isEmpty }.joined(separator: "，"))
    }
}

/// 账号身份切换器按钮：继承自 NSButton，确保在 NSMenuItem.view 的菜单追踪循环中 100% 响应点击。
/// 切换图标紧随账号与套餐胶囊后方，文本严格与下方配额行左对齐（x = 0）。
final class MenuAccountSwitcher: NSButton {
    let switchIcon = symbol("chevron.down", size: 11, color: Design.secondary)
    private var hoverTracking: NSTrackingArea?
    var hovered = false { didSet { updateVisualState() } }
    var expanded = false { didSet { updateVisualState() } }

    init(content: NSView, target: AnyObject?, action: Selector) {
        super.init(frame: .zero)
        self.title = ""
        self.target = target
        self.action = action
        bezelStyle = .inline
        isBordered = false
        focusRingType = .none
        setButtonType(.momentaryChange)
        switchIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 10.5, weight: .medium)
        switchIcon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            switchIcon.widthAnchor.constraint(equalToConstant: 14),
            switchIcon.heightAnchor.constraint(equalToConstant: 14)
        ])
        addSubview(content)
        content.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: leadingAnchor),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            content.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2)
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.popUpButton)
        setAccessibilityLabel("切换账号")
    }
    required init?(coder: NSCoder) { fatalError() }

    override var acceptsFirstResponder: Bool { isEnabled }
    override var canBecomeKeyView: Bool { isEnabled }
    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 36, 49: performClick(nil)
        case 53: enclosingMenuItem?.menu?.cancelTracking()
        case 125: window?.selectNextKeyView(self)
        case 126: window?.selectPreviousKeyView(self)
        default: super.keyDown(with:event)
        }
    }
    override func hitTest(_ point: NSPoint) -> NSView? {
        super.hitTest(point) == nil ? nil : self
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }

    private func updateVisualState() {
        let active = isEnabled && (hovered || isHighlighted || expanded || window?.firstResponder === self)
        switchIcon.image = NSImage(systemSymbolName: expanded ? "chevron.up" : "chevron.down", accessibilityDescription: nil)
        switchIcon.contentTintColor = active ? Design.blue : Design.secondary
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let active = isEnabled && (hovered || isHighlighted || expanded || window?.firstResponder === self)
        switchIcon.contentTintColor = active ? Design.blue : Design.secondary
        guard active else { return }
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let alpha: CGFloat = (isHighlighted || expanded) ? (isDark ? 0.14 : 0.08) : (isDark ? 0.08 : 0.04)
        (isDark ? NSColor.white : NSColor.black).withAlphaComponent(alpha).setFill()
        let iconBounds = convert(switchIcon.bounds, from: switchIcon)
        let iconRect = NSRect(x: iconBounds.midX-12, y: iconBounds.midY-12, width: 24, height: 24)
        NSBezierPath(roundedRect: iconRect, xRadius: 8, yRadius: 8).fill()
    }
}

/// 卡片内联账号切换条目按钮（继承自 NSButton，在 NSMenuItem.view 内直接响应点击，彻底规避嵌套 NSMenu 失效问题）。
final class MenuAccountRowButton: NSButton {
    let accountId: String
    let isCurrent: Bool
    private var hoverTracking: NSTrackingArea?
    private let fullEmail: String
    var hovered = false { didSet { needsDisplay = true } }

    init(accountId: String, name: String, email: String, tier: String, quotaSummary: String, isCurrent: Bool, enabled: Bool, target: AnyObject?, action: Selector) {
        self.accountId = accountId
        self.isCurrent = isCurrent
        self.fullEmail = email
        super.init(frame: .zero)
        self.title = ""
        self.target = target
        self.action = action
        self.isEnabled = enabled
        bezelStyle = .inline
        isBordered = false
        focusRingType = .none
        setButtonType(.momentaryChange)

        let checkIcon = symbol(isCurrent ? "checkmark.circle.fill" : "circle", size: 12, color: isCurrent ? Design.blue : Design.secondary.withAlphaComponent(0.45))
        let nameLbl = text(name, size: 12, weight: isCurrent ? .semibold : .medium, color: .labelColor)
        nameLbl.alignment = .left
        nameLbl.lineBreakMode = .byTruncatingTail
        nameLbl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let badge = pillBadge(tier, color: tier == "ULTRA" ? .systemPurple : tier == "PRO" ? .systemBlue : .secondaryLabelColor)
        badge.isHidden = tier.isEmpty
        badge.setContentCompressionResistancePriority(.required, for: .horizontal)

        let quotaLbl = text(quotaSummary, size: 10.5, weight: .medium, color: .secondaryLabelColor)
        quotaLbl.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .medium)
        quotaLbl.alignment = .left
        quotaLbl.lineBreakMode = .byTruncatingTail
        quotaLbl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let topRow = horizontal([nameLbl, flexibleSpace(), badge], spacing: 5)
        topRow.alignment = .centerY

        let emailLbl = text(email, size: 10.5, color: .secondaryLabelColor)
        emailLbl.font = .systemFont(ofSize: 11.5, weight: .regular)
        emailLbl.alignment = .left
        emailLbl.lineBreakMode = .byTruncatingMiddle
        emailLbl.toolTip = email
        emailLbl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let rightStack = vertical([topRow, emailLbl, quotaLbl], spacing: 2.5)
        rightStack.alignment = .leading
        fillWidth(topRow, in: rightStack)
        fillWidth(emailLbl, in: rightStack); fillWidth(quotaLbl, in: rightStack)

        let row = horizontal([checkIcon, rightStack], spacing: 8)
        row.alignment = .centerY
        rightStack.translatesAutoresizingMaskIntoConstraints = false
        rightStack.widthAnchor.constraint(equalTo: row.widthAnchor, constant: -24).isActive = true
        addSubview(row)
        row.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6)
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("切换至 \(name) \(email)，\(quotaSummary)")
        let context = NSMenu()
        let copy = NSMenuItem(title:"复制完整邮箱", action:#selector(copyEmail), keyEquivalent:"")
        copy.target = self; context.addItem(copy); menu = context
    }
    @objc private func copyEmail() {
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(fullEmail,forType:.string)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var acceptsFirstResponder: Bool { isEnabled }
    override var canBecomeKeyView: Bool { isEnabled }
    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 36, 49: performClick(nil)
        case 53: enclosingMenuItem?.menu?.cancelTracking()
        case 125: window?.selectNextKeyView(self)
        case 126: window?.selectPreviousKeyView(self)
        default: super.keyDown(with:event)
        }
    }
    override func hitTest(_ point: NSPoint) -> NSView? {
        super.hitTest(point) == nil ? nil : self
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }

    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: rect, xRadius: 7, yRadius: 7)
        if isEnabled && (hovered || isHighlighted || window?.firstResponder === self) {
            let alpha: CGFloat = isHighlighted ? (isDark ? 0.18 : 0.10) : (isDark ? 0.12 : 0.06)
            (isDark ? NSColor.white : NSColor.black).withAlphaComponent(alpha).setFill()
            path.fill()
        } else if isCurrent {
            Design.blue.withAlphaComponent(isDark ? 0.16 : 0.08).setFill()
            path.fill()
            Design.blue.withAlphaComponent(isDark ? 0.35 : 0.22).setStroke()
            path.lineWidth = 1
            path.stroke()
        }
    }
}

final class MenuStatusCard: NSView {
    static let cardWidth: CGFloat = 320
    static let inset: CGFloat = 28

    let nameLabel = text("", size: 13, weight: .semibold, color: .labelColor)
    let emailLabel = text("", size: 11, color: .secondaryLabelColor, wrap: true)
    let tierBadge = pillBadge("", color: .systemBlue)
    var accountSwitcher: MenuAccountSwitcher!
    let refreshButton: MenuRefreshButton
    let gemini5h = MenuMeterRow(title: "5 小时")
    let geminiWeekly = MenuMeterRow(title: "每周")
    let claude5h = MenuMeterRow(title: "5 小时")
    let claudeWeekly = MenuMeterRow(title: "每周")
    let argon = MenuMeterRow(title: "Gemini 4 Argon")
    let footerLabel = text("", size: 10.5, color: .secondaryLabelColor)
    private let quotaStack: NSStackView
    private let accountListStack = NSStackView()
    private let accountListScroll = NSScrollView()
    private var listHeight: NSLayoutConstraint!
    private var listFingerprint = ""
    private let stack: NSStackView
    private var lastUpdated: Double = 0
    private var showingAccountList = false
    weak var assistant: Assistant?

    /// account == nil 时用 placeholder 作为主标题（服务未就绪 / 尚未保存账号），不显示配额区。
    init(target: Assistant, account: [String: Any]?, placeholder: String = "尚未保存账号", enabled: Bool) {
        refreshButton = MenuRefreshButton(target: nil, action: #selector(refreshPressed))
        assistant = target
        func groupHeader(_ title: String, brands: [String]) -> NSView {
            var views: [NSView] = brands.compactMap { brand in
                guard let image = ModelIcons.image(brand) else { return nil }
                let icon = NSImageView(image: image); icon.imageScaling = .scaleProportionallyUpOrDown
                icon.contentTintColor = ModelIcons.tintColor(for: image)
                icon.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([icon.widthAnchor.constraint(equalToConstant: 12), icon.heightAnchor.constraint(equalToConstant: 12)])
                icon.setAccessibilityElement(false); return icon
            }
            let lbl = text(title, size: 11, weight: .semibold, color: .secondaryLabelColor)
            lbl.alignment = .left
            views.append(lbl)
            let row = horizontal(views, spacing: 4)
            row.alignment = .centerY
            return row
        }
        let geminiGroup = vertical([groupHeader("Gemini", brands: ["gemini"]), gemini5h, geminiWeekly], spacing: 7)
        let claudeGroup = vertical([groupHeader("Claude/GPT", brands: ["claude", "openai"]), claude5h, claudeWeekly], spacing: 7)
        let argonGroup = vertical([groupHeader("Gemini 4 Argon", brands: ["gemini"]), argon], spacing: 7)
        for (group, rows) in [(geminiGroup, [gemini5h, geminiWeekly]), (claudeGroup, [claude5h, claudeWeekly]), (argonGroup, [argon])] {
            group.alignment = .leading
            for row in rows { fillWidth(row, in: group) }
        }
        quotaStack = vertical([geminiGroup, claudeGroup, argonGroup], spacing: 14)
        quotaStack.alignment = .leading
        for group in [geminiGroup, claudeGroup, argonGroup] { fillWidth(group, in: quotaStack) }

        accountListStack.orientation = .vertical
        accountListStack.alignment = .leading
        accountListStack.spacing = 4
        accountListStack.isHidden = true
        let listDocument = TopAlignedDocument(); listDocument.translatesAutoresizingMaskIntoConstraints = false
        accountListScroll.documentView = listDocument
        accountListScroll.drawsBackground = false; accountListScroll.hasVerticalScroller = true; accountListScroll.autohidesScrollers = true
        accountListScroll.isHidden = true; listDocument.addSubview(accountListStack); pin(accountListStack, to: listDocument)
        listDocument.widthAnchor.constraint(equalTo: accountListScroll.contentView.widthAnchor).isActive = true
        listHeight = accountListScroll.heightAnchor.constraint(equalToConstant: 0); listHeight.isActive = true

        nameLabel.alignment = .left
        nameLabel.lineBreakMode = .byTruncatingTail
        emailLabel.alignment = .left
        emailLabel.lineBreakMode = .byWordWrapping
        emailLabel.maximumNumberOfLines = 2
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        emailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        tierBadge.setContentCompressionResistancePriority(.required, for: .horizontal)

        let identity = vertical([], spacing: 2)
        identity.alignment = .leading
        stack = vertical([], spacing: 12)
        stack.alignment = .leading

        super.init(frame: NSRect(x: 0, y: 0, width: Self.cardWidth, height: 100))

        accountSwitcher = MenuAccountSwitcher(content: identity, target: self, action: #selector(toggleAccountList))
        accountSwitcher.switchIcon.setContentCompressionResistancePriority(.required, for: .horizontal)
        let nameRow = horizontal([nameLabel, tierBadge, accountSwitcher.switchIcon, flexibleSpace()], spacing: 7)
        nameRow.setCustomSpacing(18, after: tierBadge)
        nameRow.alignment = .centerY
        identity.addArrangedSubview(nameRow)
        identity.addArrangedSubview(emailLabel)
        fillWidth(nameRow, in: identity); fillWidth(emailLabel, in: identity)
        identity.setContentHuggingPriority(.defaultLow, for: .horizontal)
        identity.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        accountSwitcher.setContentHuggingPriority(.defaultLow, for: .horizontal)
        accountSwitcher.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let header = horizontal([accountSwitcher, refreshButton], spacing: 8)
        accountSwitcher.translatesAutoresizingMaskIntoConstraints = false
        accountSwitcher.widthAnchor.constraint(equalTo: header.widthAnchor, constant: -34).isActive = true
        header.alignment = .centerY

        let divider = MenuCardDivider()
        footerLabel.alignment = .left
        footerLabel.lineBreakMode = .byTruncatingTail
        for view in [header, divider, accountListScroll, quotaStack, footerLabel] {
            stack.addArrangedSubview(view)
            fillWidth(view, in: stack)
        }
        stack.setCustomSpacing(10, after: quotaStack)
        divider.heightAnchor.constraint(equalToConstant: 1).isActive = true
        refreshButton.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([refreshButton.widthAnchor.constraint(equalToConstant: 26), refreshButton.heightAnchor.constraint(equalToConstant: 26)])

        autoresizingMask = [.width]
        refreshButton.target = self
        refreshButton.setRefreshState(busy: target.quotaRefreshing, available: enabled || target.quotaRefreshing, error: target.quotaRefreshError)
        addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Self.inset),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Self.inset),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 12)
        ])
        apply(account: account, placeholder: placeholder)
        setAccessibilityElement(false)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: NSSize {
        NSSize(width: Self.cardWidth, height: max(56, frame.height))
    }

    func updateHeight() {
        if showingAccountList {
            accountListStack.layoutSubtreeIfNeeded()
            listHeight.constant = min(360, max(44, ceil(accountListStack.fittingSize.height)))
        }
        stack.layoutSubtreeIfNeeded()
        let fitted = stack.fittingSize.height
        let h = ceil(fitted) + 12 + 12
        frame.size = NSSize(width: Self.cardWidth, height: max(56, h))
        invalidateIntrinsicContentSize()
    }

    private func rebuildAccountList() {
        guard let assistant else { return }
        let key = assistant.cachedAccounts.map { account in
            "\(account["id"] ?? ""):\(account["name"] ?? ""):\(account["email"] ?? ""):\(account["disabled"] ?? false):\(account["subscription_tier"] ?? ""):\(QuotaPresentation.menuAccountSummary(account))"
        }.joined(separator:"|") + assistant.activeAccountId + String(assistant.reachable) + String(assistant.accountSwitchInFlight)
        guard key != listFingerprint else { return }; listFingerprint = key
        accountListStack.arrangedSubviews.forEach {
            accountListStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        let ordered = assistant.cachedAccounts.enumerated().sorted { lhs, rhs in
            let l = lhs.element["id"] as? String == assistant.activeAccountId
            let r = rhs.element["id"] as? String == assistant.activeAccountId
            return l == r ? lhs.offset < rhs.offset : l
        }.map(\.element)

        if ordered.isEmpty {
            let empty = text("暂无已保存账号", size: 11.5, color: .secondaryLabelColor)
            accountListStack.addArrangedSubview(empty)
        } else {
            for acc in ordered {
                let identity = AccountIdentity(acc)
                let id = identity.id, email = identity.email, display = identity.displayName, tier = identity.tier
                let g5 = QuotaPresentation.menuAccountSummary(acc)
                let isCurrent = id == assistant.activeAccountId || (assistant.activeAccountId.isEmpty && email.caseInsensitiveCompare(assistant.statusValue.activeAccountEmail) == .orderedSame)
                let enabled = assistant.reachable && !assistant.accountSwitchInFlight && identity.selectable
                let rowBtn = MenuAccountRowButton(accountId: id, name: display, email: email, tier: tier, quotaSummary: g5, isCurrent: isCurrent, enabled: enabled, target: self, action: #selector(accountRowPressed(_:)))
                accountListStack.addArrangedSubview(rowBtn)
                fillWidth(rowBtn, in: accountListStack)
            }
        }
    }

    @objc func toggleAccountList() {
        showingAccountList.toggle()
        accountListScroll.isHidden = !showingAccountList
        accountSwitcher.setAccessibilityExpanded(showingAccountList)
        accountSwitcher.expanded = showingAccountList
        if showingAccountList {
            rebuildAccountList()
            quotaStack.isHidden = true
            footerLabel.isHidden = true
            accountListStack.isHidden = false
        } else {
            accountListStack.isHidden = true
            quotaStack.isHidden = false
            footerLabel.isHidden = false
        }
        updateHeight()
        if let quotaView = superview as? MenuQuotaView {
            quotaView.frame.size.height = frame.height
            quotaView.invalidateIntrinsicContentSize()
        }
    }

    @objc func accountRowPressed(_ sender: MenuAccountRowButton) {
        guard let assistant else { return }
        let id = sender.accountId
        guard !id.isEmpty else { return }
        showingAccountList = false
        accountSwitcher.expanded = false
        accountListStack.isHidden = true
        quotaStack.isHidden = false
        footerLabel.isHidden = false
        accountListScroll.isHidden = true
        updateHeight()
        assistant.switchAccountByIdFromMenu(id)
    }

    /// 刷新期间菜单保持打开时就地更新数值；结构固定，不改变卡片高度。
    func apply(account: [String: Any]?, placeholder: String = "尚未保存账号") {
        guard let account else {
            nameLabel.stringValue = placeholder
            emailLabel.stringValue = ""
            emailLabel.isHidden = true
            tierBadge.isHidden = true
            quotaStack.isHidden = true
            accountListStack.isHidden = true
            accountListScroll.isHidden = true
            accountSwitcher.isEnabled = assistant?.reachable == true
            accountSwitcher.switchIcon.isHidden = false
            footerLabel.stringValue = ""
            footerLabel.isHidden = true
            refreshButton.isHidden = true
            updateHeight()
            return
        }
        let email = account["email"] as? String ?? ""
        let display = AccountIdentity.displayName(name: account["name"] as? String, email: email)
        nameLabel.stringValue = display
        emailLabel.stringValue = email
        emailLabel.toolTip = email
        accountSwitcher.toolTip = email
        let emailMenu = NSMenu()
        let copyEmail = NSMenuItem(title: "复制完整邮箱", action: #selector(copyHeaderEmail), keyEquivalent: "")
        copyEmail.target = self
        emailMenu.addItem(copyEmail)
        accountSwitcher.menu = emailMenu
        emailLabel.isHidden = email.isEmpty
        let tier = AccountIdentity.normalizeTier(account["subscription_tier"] as? String)
        tierBadge.title = tier
        tierBadge.tint = tier == "ULTRA" ? .systemPurple : tier == "PRO" ? .systemBlue : .secondaryLabelColor
        tierBadge.isHidden = tier.isEmpty
        accountSwitcher.isEnabled = assistant?.reachable == true && assistant?.accountSwitchInFlight != true
        accountSwitcher.switchIcon.isHidden = false
        accountSwitcher.setAccessibilityLabel("当前账号 \(display)，点击切换账号")
        refreshButton.isHidden = false
        accountListScroll.isHidden = !showingAccountList
        if showingAccountList {
            rebuildAccountList()
            quotaStack.isHidden = true
            footerLabel.isHidden = true
            accountListStack.isHidden = false
        } else {
            accountListStack.isHidden = true
            quotaStack.isHidden = false
            footerLabel.isHidden = false
        }

        let contract = QuotaPresentation.contract(account)
        func show(_ row: MenuMeterRow, _ window: QuotaPresentation.Window?) {
            row.apply(percentage: window?.percentage, placeholder: window?.placeholder ?? "未知", reset: window?.resetText ?? "", stale: window?.stale == true)
        }
        gemini5h.titleLabel.stringValue = contract.geminiPrimary.label
        show(gemini5h, contract.geminiPrimary.window); show(geminiWeekly, contract.geminiWeekly)
        claude5h.titleLabel.stringValue = contract.claudePrimary.label
        show(claude5h, contract.claudePrimary.window); show(claudeWeekly, contract.claudeWeekly)
        let argonState = contract.argon
        let argonPlaceholder = argonState?.availability == "disabled" ? "不可用" : (argonState?.placeholder ?? "未知")
        argon.titleLabel.stringValue = argonState?.periodLabel == "5小时" ? "5 小时" : "每周"
        argon.apply(percentage: argonState?.percentage, placeholder: argonPlaceholder,
                    reset: argonState?.percentage == nil ? "" : (argonState?.resetText ?? ""), stale: argonState?.stale == true)

        let quota = account["quota"] as? [String: Any]
        lastUpdated = QuotaPresentation.number(quota?["last_updated"]) ?? QuotaPresentation.number(account["quota_last_updated"]) ?? 0
        updateFooter()
        updateHeight()
    }

    private static let todayTimeFormatter: DateFormatter = InterfaceText.shortTimeFormatter

    private static let dateTimeFormatter: DateFormatter = InterfaceText.shortDateTimeFormatter

    func updateFooter() {
        guard !quotaStack.isHidden else { return }
        let busy = !refreshButton.spinner.isHidden
        let failure = refreshButton.lastError
        if busy { footerLabel.stringValue = "正在刷新配额…"; footerLabel.textColor = .secondaryLabelColor; return }
        if !failure.isEmpty { footerLabel.stringValue = "刷新失败 · 点击右上角重试"; footerLabel.textColor = accessibleWarningColor(); return }
        guard lastUpdated > 0 else { footerLabel.stringValue = "尚未取得配额记录"; footerLabel.textColor = .secondaryLabelColor; return }
        let date = Date(timeIntervalSince1970: lastUpdated)
        let formatter = Calendar.current.isDateInToday(date) ? Self.todayTimeFormatter : Self.dateTimeFormatter
        let stale = Date().timeIntervalSince(date) > 15 * 60
        footerLabel.stringValue = (assistant?.reachable == false ? "本机服务离线 · " : "") + "更新于 \(formatter.string(from: date))" + (stale ? " · 待刷新" : "")
        footerLabel.textColor = stale ? accessibleWarningColor() : .secondaryLabelColor
    }

    func setRefreshState(busy: Bool, available: Bool, error: String?) {
        refreshButton.setRefreshState(busy: busy, available: available, error: error)
        updateFooter()
    }

    @objc private func copyHeaderEmail() {
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(emailLabel.stringValue,forType:.string)
    }
    @objc func refreshPressed() {
        guard refreshButton.isEnabled, let assistant else { return }
        refreshButton.isEnabled = false
        assistant.refreshAccountQuotas()
    }

    /// "4 小时 13 分钟后重置" -> "4小时13分后重置"，菜单内保持一行。
    static func compactReset(_ raw: String) -> String {
        InterfaceText.countdown(raw)
            .replacingOccurrences(of: "分钟", with: "分")
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "·", with: " · ")
    }
}

/// 卡片内的发丝分隔线（语义色，随外观更新）。
final class MenuCardDivider: NSView {
    override var isOpaque: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.separatorColor.setFill(); bounds.fill()
    }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
}

// MARK: - Three-Tab Native Menu Panel ("用量｜配额｜账号", 396pt Popover)

final class MenuSegmentedTabsView: NSView {
    enum Style {
        case primaryTabs
        case secondaryRange
        case compactToggle
    }

    override var allowsVibrancy: Bool { false }
    let items: [String]
    let style: Style
    var onSelect: ((Int) -> Void)?
    private var buttons: [SegmentItemButton] = []
    private(set) var selectedIndex: Int = 0
    private var slidePosition: CGFloat = 0
    private let slideMotion = DesignMotion()

    final class SegmentItemButton: NSButton {
        override var allowsVibrancy: Bool { false }
        let index: Int
        let barStyle: Style
        var isSelectedSegment = false { didSet { if oldValue != isSelectedSegment { needsDisplay = true } } }
        private var hoverTracking: NSTrackingArea?
        var hovered = false { didSet { if oldValue != hovered { needsDisplay = true } } }

        init(title: String, index: Int, style: Style, target: AnyObject?, action: Selector) {
            self.index = index
            self.barStyle = style
            super.init(frame: .zero)
            self.title = title
            self.target = target
            self.action = action
            bezelStyle = .inline
            isBordered = false
            focusRingType = .none
            setButtonType(.momentaryChange)
            setAccessibilityElement(true)
            setAccessibilityRole(.radioButton)
            setAccessibilityLabel(title)
        }
        required init?(coder: NSCoder) { fatalError() }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let area = hoverTracking { removeTrackingArea(area) }
            let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
            hoverTracking = area
            addTrackingArea(area)
        }
        override func mouseEntered(with event: NSEvent) { if isEnabled { hovered = true } }
        override func mouseExited(with event: NSEvent) { hovered = false }

        override func draw(_ dirtyRect: NSRect) {
            let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let radius: CGFloat = barStyle == .primaryTabs ? 7 : 6
            let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
            let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)

            if !isSelectedSegment && hovered {
                (isDark ? NSColor.white.withAlphaComponent(0.06) : NSColor.black.withAlphaComponent(0.04)).setFill()
                path.fill()
            }

            let fontSize: CGFloat = barStyle == .primaryTabs ? 12.5 : (barStyle == .secondaryRange ? 11.5 : 11)
            let weight: NSFont.Weight = isSelectedSegment ? .semibold : .medium
            let fg: NSColor
            if isSelectedSegment {
                switch barStyle {
                case .primaryTabs:
                    fg = .labelColor
                case .secondaryRange, .compactToggle:
                    fg = isDark ? NSColor(srgbRed: 0.44, green: 0.72, blue: 1.0, alpha: 1.0) : Design.blue
                }
            } else {
                fg = hovered ? .labelColor : Design.secondary
            }

            let pStyle = NSMutableParagraphStyle()
            pStyle.alignment = .center
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: fontSize, weight: weight),
                .foregroundColor: fg,
                .paragraphStyle: pStyle
            ]
            let sz = (title as NSString).size(withAttributes: attrs)
            let drawRect = NSRect(x: 2, y: (bounds.height - sz.height) / 2, width: max(0, bounds.width - 4), height: sz.height)
            (title as NSString).draw(in: drawRect, withAttributes: attrs)

            if window?.firstResponder === self {
                Design.blue.setStroke()
                path.lineWidth = 1.5
                path.stroke()
            }
        }
    }

    init(items: [String], style: Style = .primaryTabs, selected: Int = 0, accessibilityLabel: String) {
        self.items = items
        self.style = style
        let initial = max(0, min(items.count - 1, selected))
        self.selectedIndex = initial
        self.slidePosition = CGFloat(initial)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let barHeight: CGFloat = style == .primaryTabs ? 32 : (style == .secondaryRange ? 28 : 24)
        heightAnchor.constraint(equalToConstant: barHeight).isActive = true

        let stack = NSStackView()
        stack.orientation = .horizontal
        stack.distribution = style == .compactToggle ? .fillProportionally : .fillEqually
        stack.spacing = 3
        for (idx, item) in items.enumerated() {
            let btn = SegmentItemButton(title: item, index: idx, style: style, target: self, action: #selector(segmentPressed(_:)))
            btn.isSelectedSegment = (idx == self.selectedIndex)
            btn.setAccessibilityValue(idx == self.selectedIndex ? 1 : 0)
            if style == .compactToggle {
                btn.translatesAutoresizingMaskIntoConstraints = false
                btn.widthAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
            }
            buttons.append(btn)
            stack.addArrangedSubview(btn)
            btn.heightAnchor.constraint(equalToConstant: barHeight - 6).isActive = true
        }
        addSubview(stack)
        pin(stack, to: self, inset: 3)
        setAccessibilityElement(true)
        setAccessibilityRole(.tabGroup)
        setAccessibilityLabel(accessibilityLabel)
    }
    required init?(coder: NSCoder) { fatalError() }

    func setSelected(_ index: Int) {
        let clamped = max(0, min(items.count - 1, index))
        selectedIndex = clamped
        for (idx, btn) in buttons.enumerated() {
            btn.isSelectedSegment = (idx == clamped)
            btn.setAccessibilityValue(idx == clamped ? 1 : 0)
        }
        let target = CGFloat(clamped)
        slideMotion.animate(in: self, from: slidePosition, to: target, curve: .spring, threshold: 0.01) { [weak self] pos in
            self?.slidePosition = pos
            self?.needsDisplay = true
        }
    }

    @objc private func segmentPressed(_ sender: SegmentItemButton) {
        guard sender.index != selectedIndex else { return }
        setSelected(sender.index)
        onSelect?(sender.index)
    }

    private func interpolatedThumbRect() -> NSRect {
        guard !buttons.isEmpty else { return .zero }
        let lowIdx = max(0, min(buttons.count - 1, Int(floor(slidePosition))))
        let highIdx = max(0, min(buttons.count - 1, Int(ceil(slidePosition))))
        let frac = max(0, min(1, slidePosition - CGFloat(lowIdx)))
        let r1 = convert(buttons[lowIdx].bounds, from: buttons[lowIdx])
        let r2 = convert(buttons[highIdx].bounds, from: buttons[highIdx])
        if r1.width <= 1 {
            let inset: CGFloat = 3
            let spacing: CGFloat = 3
            let count = CGFloat(max(1, items.count))
            let totalW = max(0, bounds.width - inset * 2 - spacing * (count - 1))
            let itemW = totalW / count
            let x = inset + slidePosition * (itemW + spacing)
            return NSRect(x: x, y: inset, width: itemW, height: max(0, bounds.height - inset * 2))
        }
        return NSRect(
            x: r1.origin.x + (r2.origin.x - r1.origin.x) * frac,
            y: r1.origin.y + (r2.origin.y - r1.origin.y) * frac,
            width: r1.width + (r2.width - r1.width) * frac,
            height: r1.height + (r2.height - r1.height) * frac
        )
    }

    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if style != .compactToggle {
            let radius: CGFloat = style == .primaryTabs ? 9 : 8
            let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
            let bg: NSColor
            if style == .primaryTabs {
                bg = isDark ? NSColor.white.withAlphaComponent(0.05) : NSColor.black.withAlphaComponent(0.04)
            } else {
                bg = isDark ? NSColor.white.withAlphaComponent(0.035) : NSColor.black.withAlphaComponent(0.026)
            }
            bg.setFill()
            path.fill()
        }

        let thumbRect = interpolatedThumbRect().insetBy(dx: 0.5, dy: 0.5)
        guard thumbRect.width > 1 && thumbRect.height > 1 else { return }
        let thumbRadius: CGFloat = style == .primaryTabs ? 7 : 6
        let thumbPath = NSBezierPath(roundedRect: thumbRect, xRadius: thumbRadius, yRadius: thumbRadius)

        switch style {
        case .primaryTabs:
            NSGraphicsContext.saveGraphicsState()
            // 浮雕微立体阴影
            let thumbShadow = NSShadow()
            thumbShadow.shadowColor = isDark
                ? NSColor.black.withAlphaComponent(0.40)
                : NSColor.black.withAlphaComponent(0.12)
            thumbShadow.shadowOffset = NSSize(width: 0, height: -1.0)
            thumbShadow.shadowBlurRadius = 3.0
            thumbShadow.set()

            let fill = isDark ? NSColor.white.withAlphaComponent(0.12) : NSColor.white.withAlphaComponent(0.88)
            fill.setFill()
            thumbPath.fill()
            NSGraphicsContext.restoreGraphicsState()

            (isDark ? NSColor.white.withAlphaComponent(0.13) : NSColor.black.withAlphaComponent(0.06)).setStroke()
            thumbPath.lineWidth = 0.8
            thumbPath.stroke()

            // 0.5pt 顶部镜面高光斜角
            let topHighlight = NSBezierPath(roundedRect: thumbRect.insetBy(dx: 0.5, dy: 0.5), xRadius: thumbRadius - 0.5, yRadius: thumbRadius - 0.5)
            NSColor.white.withAlphaComponent(isDark ? 0.16 : 0.45).setStroke()
            topHighlight.lineWidth = 0.5
            topHighlight.stroke()
        case .secondaryRange:
            let fill = isDark
                ? Design.blue.withAlphaComponent(0.20)
                : Design.blue.withAlphaComponent(0.10)
            fill.setFill()
            thumbPath.fill()
            Design.blue.withAlphaComponent(isDark ? 0.36 : 0.20).setStroke()
            thumbPath.lineWidth = 0.8
            thumbPath.stroke()
        case .compactToggle:
            Design.blue.withAlphaComponent(isDark ? 0.24 : 0.12).setFill()
            thumbPath.fill()
        }
    }
}

final class MenuMetricTileView: NSView {
    override var allowsVibrancy: Bool { false }
    let metricKey: String
    let iconView: NSImageView
    let titleLabel: NSTextField
    let valueLabel: NSTextField

    init(key: String, title: String) {
        self.metricKey = key
        self.titleLabel = text(title, size: 11.5, weight: .medium, color: Design.secondary)
        self.valueLabel = text("—", size: 20, weight: .bold, color: Design.text)

        let iconName: String
        switch key {
        case "tokens":
            iconName = "sparkles"
        case "requests":
            iconName = "paperplane.fill"
        case "cost":
            iconName = "dollarsign.circle.fill"
        case "cache":
            iconName = "bolt.badge.clock.fill"
        default:
            iconName = "chart.bar.fill"
        }
        let iconTint = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor.white.withAlphaComponent(0.72)
                : NSColor.labelColor.withAlphaComponent(0.60)
        }
        let iv = NSImageView()
        iv.image = NSImage(systemSymbolName: iconName, accessibilityDescription: nil)
        iv.contentTintColor = iconTint
        iv.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
        iv.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iv.widthAnchor.constraint(equalToConstant: 13),
            iv.heightAnchor.constraint(equalToConstant: 13)
        ])
        iv.setAccessibilityElement(false)
        self.iconView = iv

        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 55).isActive = true

        valueLabel.font = .monospacedDigitSystemFont(ofSize: 20, weight: .bold)
        valueLabel.lineBreakMode = .byTruncatingTail
        valueLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let topRow = horizontal([iv, titleLabel], spacing: 4.5)
        topRow.alignment = .centerY

        let stack = vertical([topRow, valueLabel], spacing: 3.5)
        stack.alignment = .leading
        fillWidth(topRow, in: stack)
        fillWidth(valueLabel, in: stack)
        addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
        titleLabel.setAccessibilityElement(false)
        valueLabel.setAccessibilityElement(false)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        refreshAccessibility()
    }
    required init?(coder: NSCoder) { fatalError() }

    func setValueText(_ text: String, warning: Bool = false) {
        if valueLabel.stringValue != text {
            valueLabel.stringValue = text
        }
        valueLabel.textColor = warning ? accessibleWarningColor() : Design.text
        refreshAccessibility()
    }

    func refreshAccessibility() {
        setAccessibilityLabel("\(titleLabel.stringValue)，\(valueLabel.stringValue)")
    }

    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: rect, xRadius: 11, yRadius: 11)
        Design.popoverCardBackground.setFill()
        path.fill()
        Design.popoverCardBorder.setStroke()
        path.lineWidth = 1.0
        path.stroke()
        Design.drawSpecularBevel(in: bounds, cornerRadius: 11, isDark: isDark)
    }
}

final class MenuTrendChartView: NSView {
    override var allowsVibrancy: Bool { false }
    enum Dimension: String {
        case tokens = "tokens"
        case requests = "requests"
    }

    struct Bucket: Equatable {
        let label: String
        let tooltipLabel: String
        let value: Int
        let isFuture: Bool
    }

    var dimension: Dimension = .tokens {
        didSet {
            if oldValue != dimension {
                setAccessibilityLabel(dimension == .tokens ? "菜单栏 Token 用量趋势图" : "菜单栏请求数趋势图")
                needsDisplay = true
            }
        }
    }
    private var revealProgress: CGFloat = 1.0
    private let revealMotion = DesignMotion()
    private let hoverMotion = DesignMotion()
    private var animatedHoverX: CGFloat? = nil
    var onHoverBucket: ((Bucket?) -> Void)?
    private var hoverTrackingArea: NSTrackingArea?
    private var hoveredIndex: Int? = nil {
        didSet { if oldValue != hoveredIndex { needsDisplay = true } }
    }
    var buckets: [Bucket] = [] {
        didSet {
            hoveredIndex = nil
            animatedHoverX = nil
            hoverMotion.cancel()
            guard oldValue != buckets else { return }
            startRevealAnimation()
        }
    }

    override init(frame frameRect: NSRect = .zero) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 86).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel("菜单栏 Token 用量趋势图")
    }
    required init?(coder: NSCoder) { fatalError() }
    deinit {
        revealMotion.cancel()
        hoverMotion.cancel()
    }

    func resetHoverState() {
        hoverMotion.cancel()
        animatedHoverX = nil
        if hoveredIndex != nil {
            hoveredIndex = nil
            toolTip = nil
            onHoverBucket?(nil)
        }
    }

    func stopAnimation() {
        revealMotion.cancel()
        revealProgress = 1.0
        alphaValue = 1.0
        resetHoverState()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { stopAnimation() }
    }

    private func startRevealAnimation() {
        revealMotion.cancel()
        guard Design.shouldAnimate(in: self), buckets.contains(where: { $0.value > 0 && !$0.isFuture }) else {
            revealProgress = 1.0
            alphaValue = 1.0
            needsDisplay = true
            return
        }
        revealProgress = 0.0
        alphaValue = 1.0
        revealMotion.animate(in: self, from: 0.0, to: 1.0, curve: .sweep, threshold: 0.01) { [weak self] val in
            self?.revealProgress = val
            self?.needsDisplay = true
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTrackingArea { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        hoverTrackingArea = area
        addTrackingArea(area)
    }

    private let leftGutter: CGFloat = 42
    private let rightPad: CGFloat = 6

    override func mouseMoved(with event: NSEvent) {
        let pt = convert(event.locationInWindow, from: nil)
        guard bounds.contains(pt), !buckets.isEmpty else {
            resetHoverState()
            return
        }
        let usableWidth = max(40, bounds.width - leftGutter - rightPad)
        let slotWidth = usableWidth / CGFloat(buckets.count)
        let idx = Int(floor((pt.x - leftGutter) / slotWidth))
        if buckets.indices.contains(idx) {
            let targetX = leftGutter + (CGFloat(idx) + 0.5) * slotWidth
            if hoveredIndex != idx {
                if let currentX = animatedHoverX, Design.shouldAnimate(in: self) {
                    hoverMotion.animate(in: self, from: currentX, to: targetX, curve: .hover, threshold: 0.5) { [weak self] val in
                        self?.animatedHoverX = val
                        self?.needsDisplay = true
                    }
                } else {
                    hoverMotion.cancel()
                    animatedHoverX = targetX
                }
                hoveredIndex = idx
            } else if animatedHoverX == nil {
                animatedHoverX = targetX
            }
            let item = buckets[idx]
            toolTip = nil
            onHoverBucket?(item)
        } else {
            resetHoverState()
        }
    }

    override func mouseExited(with event: NSEvent) {
        resetHoverState()
    }

    private func formatAxisValue(_ value: Int) -> String {
        if dimension == .tokens {
            return InterfaceText.formatCompactTokens(value, formatSmallWithLocale: true)
        }
        return value >= 1000 ? String(format: "%.1fK", Double(value) / 1000.0) : "\(value)"
    }

    override func draw(_ dirtyRect: NSRect) {
        let chartBottom: CGFloat = 20
        let chartTop: CGFloat = bounds.height - 6
        let chartHeight = max(20, chartTop - chartBottom)
        let usableWidth = max(40, bounds.width - leftGutter - rightPad)
        let axisAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: .regular),
            .foregroundColor: Design.secondary
        ]

        let baseLine = NSBezierPath()
        baseLine.move(to: NSPoint(x: leftGutter, y: chartBottom))
        baseLine.line(to: NSPoint(x: bounds.width - rightPad, y: chartBottom))
        designHairline(lightAlpha: 0.22, darkAlpha: 0.22).setStroke()
        baseLine.lineWidth = 1
        baseLine.stroke()

        let peakVal = buckets.filter { !$0.isFuture }.map(\.value).max() ?? 0
        guard !buckets.isEmpty, peakVal > 0 else {
            let emptyStr = (buckets.isEmpty ? "暂无该时段会话记录" : "当前时段暂无消耗分布") as NSString
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 11.5),
                .foregroundColor: Design.secondary
            ]
            let sz = emptyStr.size(withAttributes: attrs)
            emptyStr.draw(at: NSPoint(x: leftGutter + (usableWidth - sz.width) / 2, y: chartBottom + (chartHeight - sz.height) / 2), withAttributes: attrs)
            return
        }

        let peakText = formatAxisValue(peakVal) as NSString
        let peakSize = peakText.size(withAttributes: axisAttrs)
        peakText.draw(at: NSPoint(x: max(2, leftGutter - 6 - peakSize.width), y: chartTop - peakSize.height), withAttributes: axisAttrs)

        let zeroText = "0" as NSString
        let zeroSize = zeroText.size(withAttributes: axisAttrs)
        zeroText.draw(at: NSPoint(x: max(2, leftGutter - 6 - zeroSize.width), y: chartBottom - zeroSize.height / 2), withAttributes: axisAttrs)

        let peakLine = NSBezierPath()
        peakLine.move(to: NSPoint(x: leftGutter, y: chartTop))
        peakLine.line(to: NSPoint(x: bounds.width - rightPad, y: chartTop))
        peakLine.setLineDash([3, 4], count: 2, phase: 0)
        designHairline().setStroke()
        peakLine.lineWidth = 0.8
        peakLine.stroke()

        let count = buckets.count
        let slotWidth = usableWidth / CGFloat(count)
        let barWidth = min(18, max(3.5, slotWidth * 0.64))
        let effectiveStep: Int = count > 20 ? 6 : (count > 10 ? 3 : (count > 6 ? 2 : 1))
        var lastDrawnRight: CGFloat = -999.0

        for (idx, bucket) in buckets.enumerated() {
            let cx = leftGutter + (CGFloat(idx) + 0.5) * slotWidth
            let isHovered = (hoveredIndex == idx)
            let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua

            // 0 柱位浅灰基槽
            if !bucket.isFuture {
                let baseH: CGFloat = 2.5
                let baseRect = NSRect(x: cx - barWidth / 2, y: chartBottom, width: barWidth, height: baseH)
                let basePath = NSBezierPath(roundedRect: baseRect, xRadius: min(1.25, barWidth / 2), yRadius: min(1.25, barWidth / 2))
                NSColor.labelColor.withAlphaComponent(isDark ? 0.12 : 0.08).setFill()
                basePath.fill()
            }

            // 悬停即时跟随微光光标
            if isHovered && !bucket.isFuture {
                let cursorCenterX = animatedHoverX ?? cx
                let cursorRect = NSRect(x: cursorCenterX - slotWidth * 0.44, y: chartBottom, width: slotWidth * 0.88, height: chartHeight)
                let cursorPath = NSBezierPath(roundedRect: cursorRect, xRadius: 4, yRadius: 4)
                NSColor.labelColor.withAlphaComponent(isDark ? 0.065 : 0.045).setFill()
                cursorPath.fill()
            }

            if !bucket.isFuture && bucket.value > 0 {
                let ratio = max(0.06, min(1.0, CGFloat(bucket.value) / CGFloat(peakVal))) * revealProgress
                let bh = max(3.0, chartHeight * ratio)
                let bx = cx - barWidth / 2
                let by = chartBottom
                let r = min(2.5, min(barWidth / 2, bh / 2))
                let barPath = NSBezierPath()
                barPath.move(to: NSPoint(x: bx, y: by))
                barPath.line(to: NSPoint(x: bx, y: by + bh - r))
                barPath.appendArc(withCenter: NSPoint(x: bx + r, y: by + bh - r), radius: r, startAngle: 180, endAngle: 90, clockwise: true)
                barPath.line(to: NSPoint(x: bx + barWidth - r, y: by + bh))
                barPath.appendArc(withCenter: NSPoint(x: bx + barWidth - r, y: by + bh - r), radius: r, startAngle: 90, endAngle: 0, clockwise: true)
                barPath.line(to: NSPoint(x: bx + barWidth, y: by))
                barPath.close()

                let grad = NSGradient(
                    starting: Design.blue.withAlphaComponent(isHovered ? 0.90 : 0.72),
                    ending: Design.blue
                )
                grad?.draw(in: barPath, angle: 90)
            }

            let isStepMatch = (idx % effectiveStep == 0)
            let isLast = (idx == count - 1)
            let isNearLast = (count - 1 - idx < effectiveStep / 2)
            if (isStepMatch && !isNearLast) || (isLast && !isStepMatch) {
                let ns = bucket.label as NSString
                let sz = ns.size(withAttributes: axisAttrs)
                let drawX = max(2, min(bounds.width - sz.width - 2, cx - sz.width / 2))
                if drawX >= lastDrawnRight + 6 {
                    ns.draw(at: NSPoint(x: drawX, y: 2), withAttributes: axisAttrs)
                    lastDrawnRight = drawX + sz.width
                }
            }
        }

        // 柱体即时跟随数据胶囊
        if let hIdx = hoveredIndex, buckets.indices.contains(hIdx) {
            let b = buckets[hIdx]
            let cx = animatedHoverX ?? (leftGutter + (CGFloat(hIdx) + 0.5) * slotWidth)
            let ratio = peakVal > 0 ? max(0.06, min(1.0, CGFloat(b.value) / CGFloat(peakVal))) : 0
            let barH = (!b.isFuture && b.value > 0) ? chartHeight * ratio : 0
            let capStr: NSString
            if b.isFuture {
                capStr = "未到达" as NSString
            } else if dimension == .tokens {
                capStr = InterfaceText.formatCompactTokens(b.value, formatSmallWithLocale: true) as NSString
            } else {
                capStr = "\(b.value)" as NSString
            }
            let capAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .semibold),
                .foregroundColor: NSColor.white
            ]
            let capSize = capStr.size(withAttributes: capAttrs)
            let capW = capSize.width + 12
            let capH: CGFloat = 18
            let minX = leftGutter
            let maxX = max(minX, bounds.width - rightPad - capW)
            let capX = max(minX, min(maxX, cx - capW / 2))
            let capY = min(chartTop - capH, max(chartBottom + barH + 4, chartBottom + 10))
            let capRect = NSRect(x: capX, y: capY, width: capW, height: capH)
            let capPath = NSBezierPath(roundedRect: capRect, xRadius: capH / 2, yRadius: capH / 2)
            let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            (isDark ? NSColor(white: 0.18, alpha: 0.94) : NSColor(white: 0.15, alpha: 0.88)).setFill()
            capPath.fill()
            (isDark ? NSColor.white.withAlphaComponent(0.18) : NSColor.black.withAlphaComponent(0.12)).setStroke()
            capPath.lineWidth = 0.5
            capPath.stroke()
            capStr.draw(at: NSPoint(x: capX + (capW - capSize.width) / 2, y: capY + (capH - capSize.height) / 2), withAttributes: capAttrs)
        }
    }
}

final class MenuPlainClickButton: NSButton {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        title = ""
        bezelStyle = .inline
        isBordered = false
        focusRingType = .none
        refusesFirstResponder = true
        wantsLayer = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ dirtyRect: NSRect) {
        // Custom container row handles its own background; suppress NSButtonCell's default highlight flash.
    }
}

/// 采用原生 .overlay 悬浮半透明滚动条且绝不挤占内容区宽度的滚动容器。
final class MenuSilentScrollView: NSScrollView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        hasVerticalScroller = true
        hasHorizontalScroller = false
        autohidesScrollers = true
        scrollerStyle = .overlay
        drawsBackground = false
        automaticallyAdjustsContentInsets = false
    }
    required init?(coder: NSCoder) { fatalError() }

    override var scrollerStyle: NSScroller.Style {
        get { .overlay }
        set { super.scrollerStyle = .overlay }
    }

    override func tile() {
        super.tile()
        contentView.frame = bounds
        #if NATIVE_UI_TEST
        verticalScroller?.frame = .zero
        horizontalScroller?.frame = .zero
        #endif
    }
}

final class MenuModelUsageItemView: NSView {
    let rawModel: String
    let iconView = symbol("sparkles", size: 12, color: Design.secondary)
    let nameLabel: NSTextField
    let tokensLabel: NSTextField
    let shareBar = MenuMeterBar()

    init(model: String, tokensText: String, shareFraction: CGFloat) {
        self.rawModel = model
        let display = ModelDisplayName.name(model)
        self.nameLabel = text(display, size: 12, weight: .semibold, color: .labelColor, wrap: true)
        self.tokensLabel = text(tokensText, size: 12, weight: .semibold, color: .labelColor)
        super.init(frame: .zero)

        nameLabel.maximumNumberOfLines = 2
        nameLabel.lineBreakMode = .byWordWrapping
        nameLabel.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        nameLabel.toolTip = model
        tokensLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        tokensLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        if let brand = ModelIcons.brands(for: model).first, let image = ModelIcons.image(brand) {
            iconView.image = image
            iconView.contentTintColor = ModelIcons.tintColor(for: image)
        }
        iconView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 14),
            iconView.heightAnchor.constraint(equalToConstant: 14)
        ])

        shareBar.tint = Design.blue
        shareBar.fraction = max(0.02, min(1.0, shareFraction))
        shareBar.heightAnchor.constraint(equalToConstant: 4.5).isActive = true

        let topRow = horizontal([iconView, nameLabel, flexibleSpace(), tokensLabel], spacing: 6)
        topRow.alignment = .centerY

        let stack = vertical([topRow, shareBar], spacing: 4)
        fillWidth(topRow, in: stack)
        fillWidth(shareBar, in: stack)
        addSubview(stack)
        pin(stack, to: self, inset: 2)

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("\(display)，\(tokensText) Token")
    }
    required init?(coder: NSCoder) { fatalError() }

    func update(tokensText: String, shareFraction: CGFloat) {
        if tokensLabel.stringValue != tokensText {
            tokensLabel.stringValue = tokensText
            let display = ModelDisplayName.name(rawModel)
            setAccessibilityLabel("\(display)，\(tokensText) Token")
        }
        shareBar.fraction = max(0.02, min(1.0, shareFraction))
    }
}

typealias MenuModelUsageRow = MenuModelUsageItemView


final class MenuExpandableAccountCardView: NSBox {
    let accountId: String
    private var fullEmail: String = ""
    private(set) var isCurrentAccount = false
    private(set) var isAccountReachable = true
    private(set) var isSwitchInFlight = false
    let stateButton = NSButton()
    let headerButton = MenuPlainClickButton(frame: .zero)
    let stateIcon = symbol("circle", size: 12, color: Design.secondary)
    let nameLabel = text("", size: 12.5, weight: .semibold, color: .labelColor)
    let tierBadge = pillBadge("", color: .systemBlue)
    let statusBadge = pillBadge("", color: Design.blue)
    let chevronIcon = symbol("chevron.down", size: 10, color: Design.secondary)
    let emailLabel = text("", size: 10.5, color: .secondaryLabelColor)

    let detailContainer = NSStackView()
    let gemini5hRow = MenuMeterRow(title: "Gemini · 5 小时")
    let geminiWeeklyRow = MenuMeterRow(title: "Gemini · 每周")
    let claude5hRow = MenuMeterRow(title: "Claude/GPT · 5 小时")
    let claudeWeeklyRow = MenuMeterRow(title: "Claude/GPT · 每周")
    let argonRow = MenuMeterRow(title: "Gemini 4 Argon")
    let warningLabel = text("", size: 10.5, color: accessibleWarningColor(), wrap: true)
    let timestampLabel = text("", size: 10.5, color: Design.secondary)
    let switchButton = button("切换账号…", target: nil, action: #selector(switchPressed))
    let singleRefreshButton = QuotaRefreshButton(target: nil, action: #selector(refreshSinglePressed))

    var onToggleExpand: ((String) -> Void)?
    var onSwitchAccount: ((String) -> Void)?
    var onRefreshSingle: ((String) -> Void)?
    private var hoverTrackingArea: NSTrackingArea?
    private let hoverMotion = DesignMotion()
    private var hoverProgress: CGFloat = 0
    private var wasExpanded: Bool? = nil

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTrackingArea { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        hoverTrackingArea = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) {
        hoverMotion.animate(in: self, from: hoverProgress, to: 1.0, curve: .hover) { [weak self] val in
            self?.hoverProgress = val
            self?.needsDisplay = true
        }
    }

    override func mouseExited(with event: NSEvent) {
        hoverMotion.animate(in: self, from: hoverProgress, to: 0.0, curve: .hover) { [weak self] val in
            self?.hoverProgress = val
            self?.needsDisplay = true
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if hoverProgress > 0.005 {
            let hoverPath = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: cornerRadius, yRadius: cornerRadius)
            (isDark ? NSColor.white.withAlphaComponent(0.032 * hoverProgress) : NSColor.black.withAlphaComponent(0.018 * hoverProgress)).setFill()
            hoverPath.fill()
        }
        Design.drawSpecularBevel(in: bounds, cornerRadius: cornerRadius, isDark: isDark)
    }

    private static let todayFormatter: DateFormatter = InterfaceText.shortTimeFormatter
    private static let dateFormatter: DateFormatter = InterfaceText.shortDateTimeFormatter

    init(accountId: String) {
        self.accountId = accountId
        super.init(frame: .zero)
        boxType = .custom
        cornerRadius = 11
        borderWidth = 1
        borderColor = Design.popoverCardBorder
        fillColor = Design.popoverCardBackground
        contentViewMargins = .zero

        nameLabel.lineBreakMode = .byTruncatingTail
        nameLabel.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        nameLabel.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(600), for: .horizontal)
        tierBadge.setContentHuggingPriority(.required, for: .horizontal)
        tierBadge.setContentCompressionResistancePriority(.required, for: .horizontal)
        statusBadge.setContentHuggingPriority(.required, for: .horizontal)
        statusBadge.setContentCompressionResistancePriority(.required, for: .horizontal)
        emailLabel.font = .systemFont(ofSize: 11.5, weight: .regular)
        emailLabel.lineBreakMode = .byTruncatingMiddle
        emailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        timestampLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)

        stateButton.title = ""
        stateButton.bezelStyle = .inline
        stateButton.isBordered = false
        stateButton.focusRingType = .none
        stateButton.setButtonType(.momentaryChange)
        stateButton.refusesFirstResponder = true
        stateButton.target = self
        stateButton.action = #selector(stateIconClicked)
        stateButton.addSubview(stateIcon)
        stateIcon.translatesAutoresizingMaskIntoConstraints = false
        stateButton.translatesAutoresizingMaskIntoConstraints = false
        stateButton.setContentHuggingPriority(.required, for: .horizontal)
        stateButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            stateButton.widthAnchor.constraint(equalToConstant: 18),
            stateButton.heightAnchor.constraint(equalToConstant: 18),
            stateIcon.centerXAnchor.constraint(equalTo: stateButton.centerXAnchor),
            stateIcon.centerYAnchor.constraint(equalTo: stateButton.centerYAnchor)
        ])

        let titleSpacer = flexibleSpace()
        titleSpacer.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let topTitleRow = horizontal([nameLabel, tierBadge, statusBadge, titleSpacer, chevronIcon], spacing: 5)
        topTitleRow.alignment = .centerY
        topTitleRow.detachesHiddenViews = true

        let headerLines = vertical([topTitleRow, emailLabel], spacing: 2)
        headerLines.alignment = .leading
        for v in headerLines.arrangedSubviews { fillWidth(v, in: headerLines) }

        headerButton.title = ""
        headerButton.bezelStyle = .inline
        headerButton.isBordered = false
        headerButton.focusRingType = .none
        headerButton.setButtonType(.momentaryChange)
        headerButton.target = self
        headerButton.action = #selector(headerClicked)
        headerButton.addSubview(headerLines)
        pin(headerLines, to: headerButton)
        headerButton.setContentHuggingPriority(.defaultLow, for: .horizontal)
        headerButton.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let copyMenu = NSMenu()
        let copyItem = NSMenuItem(title: "复制完整邮箱", action: #selector(copyEmail), keyEquivalent: "")
        copyItem.target = self
        copyMenu.addItem(copyItem)
        headerButton.menu = copyMenu

        switchButton.controlSize = .small
        switchButton.target = self
        singleRefreshButton.controlSize = .small
        singleRefreshButton.identifier = NSUserInterfaceItemIdentifier(accountId)
        singleRefreshButton.target = self

        let actionRow = horizontal([timestampLabel, flexibleSpace(), switchButton, singleRefreshButton], spacing: 8)
        actionRow.alignment = .centerY
        actionRow.detachesHiddenViews = true

        let detailViews: [NSView] = [
            divider(),
            gemini5hRow,
            geminiWeeklyRow,
            claude5hRow,
            claudeWeeklyRow,
            argonRow,
            warningLabel,
            actionRow
        ]
        detailContainer.orientation = .vertical
        detailContainer.alignment = .leading
        detailContainer.spacing = 6
        detailContainer.detachesHiddenViews = true
        for v in detailViews {
            detailContainer.addArrangedSubview(v)
            fillWidth(v, in: detailContainer)
        }

        let headerRow = horizontal([stateButton, headerButton], spacing: 7)
        headerRow.alignment = .top
        headerRow.detachesHiddenViews = true
        headerButton.translatesAutoresizingMaskIntoConstraints = false
        headerButton.widthAnchor.constraint(equalTo: headerRow.widthAnchor, constant: -25).isActive = true

        let root = vertical([headerRow, detailContainer], spacing: 8)
        root.detachesHiddenViews = true
        fillWidth(headerRow, in: root)
        fillWidth(detailContainer, in: root)
        addSubview(root)
        pin(root, to: self, inset: 10)
    }
    required init?(coder: NSCoder) { fatalError() }

    func apply(account: [String: Any], isCurrent: Bool, isLiveVerified: Bool, isRecommended: Bool, isExpanded: Bool, reachable: Bool, switchInFlight: Bool, globalBusy: Bool, singleBusy: Bool, singleError: String?) {
        let email = account["email"] as? String ?? "未命名账号"
        fullEmail = email
        let rawName = account["name"] as? String
        let display = AccountIdentity.displayName(name: rawName, email: email)
        let tier = AccountIdentity.normalizeTier(account["subscription_tier"] as? String)
        let summary = QuotaPresentation.menuAccountSummary(account).replacingOccurrences(of: "\n", with: " · ")

        self.isCurrentAccount = isCurrent
        self.isAccountReachable = reachable
        self.isSwitchInFlight = switchInFlight

        stateIcon.image = NSImage(systemSymbolName: isCurrent ? "checkmark.circle.fill" : "circle", accessibilityDescription: isCurrent ? "当前账号" : "切换至该账号")
        stateIcon.contentTintColor = isCurrent ? Design.blue : Design.secondary.withAlphaComponent(0.45)
        stateButton.toolTip = isCurrent ? "当前使用账号" : "点击切换至该账号"
        stateButton.setAccessibilityLabel(isCurrent ? "当前账号" : "切换至该账号")
        stateButton.setAccessibilityRole(.button)
        nameLabel.stringValue = display
        emailLabel.stringValue = email
        emailLabel.toolTip = email

        tierBadge.title = tier
        tierBadge.tint = tier == "ULTRA" ? .systemPurple : (tier == "PRO" ? .systemBlue : .secondaryLabelColor)
        tierBadge.isHidden = tier.isEmpty

        if isCurrent {
            statusBadge.title = isLiveVerified ? "当前账号" : "已选记录"
            statusBadge.tint = Design.blue
            statusBadge.isHidden = false
        } else if isRecommended {
            statusBadge.title = "推荐备用"
            statusBadge.tint = .systemGreen
            statusBadge.isHidden = false
        } else {
            statusBadge.isHidden = true
        }

        borderColor = isCurrent ? Design.blue.withAlphaComponent(0.42) : Design.popoverCardBorder
        borderWidth = isCurrent ? 1.25 : 1.0
        fillColor = Design.popoverCardBackground
        chevronIcon.image = NSImage(systemSymbolName: isExpanded ? "chevron.up" : "chevron.down", accessibilityDescription: nil)
        let animatedToggle = (wasExpanded != nil && wasExpanded != isExpanded && Design.shouldAnimate(in: self))
        wasExpanded = isExpanded
        detailContainer.isHidden = !isExpanded
        if animatedToggle && isExpanded {
            detailContainer.wantsLayer = true
            detailContainer.alphaValue = 0.0
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.18
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                detailContainer.animator().alphaValue = 1.0
            }
        } else {
            detailContainer.alphaValue = 1.0
        }
        headerButton.setAccessibilityLabel("\(display)，\(email)，\(isCurrent ? "当前账号" : "备用账号")，\(summary)")

        let contract = QuotaPresentation.contract(account)
        gemini5hRow.titleLabel.stringValue = "Gemini · \(contract.geminiPrimary.label)"
        gemini5hRow.apply(percentage: contract.geminiPrimary.window?.percentage, placeholder: contract.geminiPrimary.window?.placeholder ?? "未知", reset: contract.geminiPrimary.window?.resetText ?? "", stale: contract.geminiPrimary.window?.stale == true)
        geminiWeeklyRow.titleLabel.stringValue = "Gemini · 每周"
        geminiWeeklyRow.apply(percentage: contract.geminiWeekly?.percentage, placeholder: contract.geminiWeekly?.placeholder ?? "未知", reset: contract.geminiWeekly?.resetText ?? "", stale: contract.geminiWeekly?.stale == true)

        claude5hRow.titleLabel.stringValue = "Claude/GPT · \(contract.claudePrimary.label)"
        claude5hRow.apply(percentage: contract.claudePrimary.window?.percentage, placeholder: contract.claudePrimary.window?.placeholder ?? "未知", reset: contract.claudePrimary.window?.resetText ?? "", stale: contract.claudePrimary.window?.stale == true)
        claudeWeeklyRow.titleLabel.stringValue = "Claude/GPT · 每周"
        claudeWeeklyRow.apply(percentage: contract.claudeWeekly?.percentage, placeholder: contract.claudeWeekly?.placeholder ?? "未知", reset: contract.claudeWeekly?.resetText ?? "", stale: contract.claudeWeekly?.stale == true)

        let argonState = contract.argon
        let argonPlaceholder = argonState?.availability == "disabled" ? "不可用" : (argonState?.placeholder ?? "未知")
        argonRow.titleLabel.stringValue = argonState?.title ?? "Gemini 4 Argon"
        argonRow.apply(percentage: argonState?.percentage, placeholder: argonPlaceholder, reset: argonState?.percentage == nil ? "" : (argonState?.resetText ?? ""), stale: argonState?.stale == true)

        var warnings: [String] = []
        if let readiness = account["credentialReadiness"] as? [String: Any], readiness["state"] as? String == "needs_authorization" {
            warnings.append("登录授权已失效，请前往主界面重新授权")
        }
        if let singleError, !singleError.isEmpty {
            warnings.append(InterfaceText.quotaMessage(singleError))
        } else if let refreshErr = account["quota_refresh_error"] as? String, !refreshErr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !refreshErr.contains("双周期") {
            warnings.append(InterfaceText.quotaMessage(refreshErr))
        }
        if let quota = account["quota"] as? [String: Any], let staleGroups = quota["stale_groups"] as? [[String: Any]], !staleGroups.isEmpty {
            let names = staleGroups.compactMap { $0["name"] as? String }.filter { !$0.isEmpty }
            warnings.append("部分分组沿用上次记录：" + (names.isEmpty ? "部分分组" : names.joined(separator: "、")))
        }
        warningLabel.stringValue = warnings.joined(separator: "；")
        warningLabel.isHidden = warnings.isEmpty

        let quota = account["quota"] as? [String: Any]
        let stamp = QuotaPresentation.number(quota?["last_updated"]) ?? QuotaPresentation.number(account["quota_last_updated"]) ?? 0
        if stamp > 0 {
            let date = Date(timeIntervalSince1970: stamp)
            let fmt = Calendar.current.isDateInToday(date) ? Self.todayFormatter : Self.dateFormatter
            timestampLabel.stringValue = "更新于 \(fmt.string(from: date))"
            timestampLabel.isHidden = false
        } else {
            timestampLabel.stringValue = ""
            timestampLabel.isHidden = true
        }

        let canSwitch = !isCurrent && account["disabled"] as? Bool != true && account["validation_blocked"] as? Bool != true
        switchButton.isHidden = isCurrent
        switchButton.isEnabled = canSwitch && reachable && !switchInFlight
        singleRefreshButton.setRefreshState(busy: globalBusy || singleBusy, available: reachable && !globalBusy, error: singleError)
    }

    @objc private func stateIconClicked() {
        guard !isCurrentAccount && isAccountReachable && !isSwitchInFlight else { return }
        onSwitchAccount?(accountId)
    }

    @objc private func headerClicked() {
        onToggleExpand?(accountId)
    }

    @objc private func switchPressed() {
        onSwitchAccount?(accountId)
    }

    @objc private func refreshSinglePressed() {
        onRefreshSingle?(accountId)
    }

    @objc private func copyEmail() {
        guard !fullEmail.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(fullEmail, forType: .string)
    }
}

final class MenuPanelRootView: NSVisualEffectView {
    override var allowsVibrancy: Bool { false }
    init() {
        super.init(frame: .zero)
        material = .popover
        blendingMode = .behindWindow
        state = .active
        wantsLayer = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isOpaque: Bool { false }
}

final class MenuPanelFooterHostView: NSView {
    override var allowsVibrancy: Bool { false }
    override var isOpaque: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        Design.popoverFooterBackground.setFill()
        bounds.fill()
    }
}

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
    let quotaTierBadge = pillBadge("", color: .systemBlue)
    let quotaStatusBadge = pillBadge("已选记录", color: Design.blue)
    let quotaEmailLabel = text("", size: 11, color: .secondaryLabelColor, wrap: true)
    let quotaGemini5h = MenuMeterRow(title: "5 小时")
    let quotaGeminiWeekly = MenuMeterRow(title: "每周")
    let quotaClaude5h = MenuMeterRow(title: "5 小时")
    let quotaClaudeWeekly = MenuMeterRow(title: "每周")
    let quotaArgon = MenuMeterRow(title: "每周")
    let quotaWarningLabel = text("", size: 11, color: accessibleWarningColor(), wrap: true)
    let quotaFooterLabel = text("", size: 11, color: .secondaryLabelColor, wrap: true)
    let quotaGroupsContainer = NSStackView()
    let quotaEmptyButton = button("前往账号页添加…", target: nil, action: #selector(openMainFromFooter))

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
        headerRefreshButton.refusesFirstResponder = true
        moreButton.target = self
        moreButton.refusesFirstResponder = true
        moreButton.setAccessibilityLabel("更多操作")
        moreButton.toolTip = "汉化开关、设置、关于与退出"
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
        trendCard.cornerRadius = 11
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
        modelsCard.cornerRadius = 11
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
        identityCard.cornerRadius = 12
        identityCard.fillColor = Design.popoverCardBackground
        identityCard.borderColor = Design.popoverCardBorder

        func groupHeader(_ title: String, brands: [String]) -> NSView {
            var headerViews: [NSView] = brands.compactMap { brand in
                guard let image = ModelIcons.image(brand) else { return nil }
                let icon = NSImageView(image: image)
                icon.imageScaling = .scaleProportionallyUpOrDown
                icon.contentTintColor = ModelIcons.tintColor(for: image)
                icon.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([icon.widthAnchor.constraint(equalToConstant: 13), icon.heightAnchor.constraint(equalToConstant: 13)])
                icon.setAccessibilityElement(false)
                return icon
            }
            let lbl = text(title, size: 11.5, weight: .semibold, color: .secondaryLabelColor)
            headerViews.append(lbl)
            let header = horizontal(headerViews, spacing: 5)
            header.alignment = .centerY
            return header
        }

        let geminiHeader = groupHeader("Gemini", brands: ["gemini"])
        let geminiStack = vertical([geminiHeader, quotaGemini5h, quotaGeminiWeekly], spacing: 6)
        fillWidth(geminiHeader, in: geminiStack)
        fillWidth(quotaGemini5h, in: geminiStack)
        fillWidth(quotaGeminiWeekly, in: geminiStack)

        let claudeHeader = groupHeader("Claude / GPT", brands: ["claude", "openai"])
        let claudeStack = vertical([claudeHeader, quotaClaude5h, quotaClaudeWeekly], spacing: 6)
        fillWidth(claudeHeader, in: claudeStack)
        fillWidth(quotaClaude5h, in: claudeStack)
        fillWidth(quotaClaudeWeekly, in: claudeStack)

        let argonHeader = groupHeader("Gemini 4 Argon", brands: ["gemini"])
        let argonStack = vertical([argonHeader, quotaArgon], spacing: 6)
        fillWidth(argonHeader, in: argonStack)
        fillWidth(quotaArgon, in: argonStack)

        let unifiedQuotaContent = vertical([
            geminiStack,
            divider(),
            claudeStack,
            divider(),
            argonStack
        ], spacing: 8)
        unifiedQuotaContent.detachesHiddenViews = true
        for v in unifiedQuotaContent.arrangedSubviews { fillWidth(v, in: unifiedQuotaContent) }

        let quotaUnifiedCard = group([unifiedQuotaContent], inset: 12)
        quotaUnifiedCard.cornerRadius = 12
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
        switch selectedTab {
        case 0:
            headerRefreshButton.toolTip = "重新读取当前时间范围的本机用量统计"
            openMainBtn.title = "打开用量页 ↗"
        case 1:
            headerRefreshButton.toolTip = "仅刷新当前展示账号的配额"
            openMainBtn.title = "打开总览页 ↗"
        default:
            headerRefreshButton.toolTip = "刷新所有已保存账号的配额"
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
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: -4), in: moreButton)
    }

    @objc private func openAntigravityFromFooter() {
        app.closeMenuPopover()
        app.openAntigravity()
    }

    @objc private func openMainFromFooter() {
        app.openMainWindowFromMenuPanel(tab: selectedTab, usagePeriod: selectedPeriod)
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
        trendTitleLabel.stringValue = selectedPeriod == 0 ? "今日趋势" : (selectedPeriod == 3 ? "历史趋势" : "\(periodLabel)趋势")

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
        let cacheWrite = intVal(summary, "cacheWriteTokens")
        let denom = prompt + cached + cacheWrite
        let cacheHit = doubleVal(summary, "cacheHitRate", fallback: denom > 0 ? (Double(cached) / Double(denom)) * 100.0 : 0.0)
        let pricedCount = intVal(summary, "pricedModels", fallback: intVal(summary, "priced_models"))
        let unpricedCount = intVal(summary, "unpricedModels", fallback: intVal(summary, "unpriced_models"))

        let scanned = intVal(summary, "databasesScanned")
        let discovered = intVal(summary, "databasesDiscovered", fallback: scanned)
        let failed = intVal(summary, "failedDatabasesCount")
        let skipped = intVal(summary, "skippedLargeRecords")
        let unknown = intVal(summary, "unknownTimeRecords")
        if failed > 0 || skipped > 0 || unknown > 0 {
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
        let isAllUnpriced = unpricedCount > 0 && pricedCount == 0 && total > 0
        costTile.setValueText(isAllUnpriced ? "未计价" : InterfaceText.formatUsd(usd))
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

        let firstDate = (targetSlice.first?["date"] as? String) ?? ""
        let lastDate = (targetSlice.last?["date"] as? String) ?? ""
        let unknownCount = intVal(summary, "unknownTimeRecords")

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
            var note = "按月汇总（\(firstDate) 至 \(lastDate)）"
            if unknownCount > 0 { note += " · 不含 \(unknownCount) 条时间未知记录" }
            activePeriodTrendNote = note
            trendCoverageLabel.stringValue = note
            trendCoverageLabel.alphaValue = 1.0
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
            var note = "按周汇总（\(firstDate) 至 \(lastDate)）"
            if unknownCount > 0 { note += " · 不含 \(unknownCount) 条时间未知记录" }
            activePeriodTrendNote = note
            trendCoverageLabel.stringValue = note
            trendCoverageLabel.alphaValue = 1.0
        } else {
            trendChart.buckets = targetSlice.map { d in
                let dateStr = (d["date"] as? String) ?? ""
                let shortDate = dateStr.count >= 10 ? String(dateStr.suffix(5)) : dateStr
                let v = isTokens
                    ? intVal(d, "total_tokens", fallback: intVal(d, "totalTokens"))
                    : intVal(d, "request_count", fallback: intVal(d, "requestCount"))
                return .init(label: shortDate, tooltipLabel: dateStr, value: v, isFuture: false)
            }
            if selectedPeriod == 3 && !firstDate.isEmpty && !lastDate.isEmpty {
                var note = "覆盖 \(firstDate) 至 \(lastDate)"
                if unknownCount > 0 { note += " · 不含 \(unknownCount) 条时间未知记录" }
                activePeriodTrendNote = note
                trendCoverageLabel.stringValue = note
                trendCoverageLabel.alphaValue = 1.0
            } else {
                activePeriodTrendNote = ""
                trendCoverageLabel.stringValue = ""
                trendCoverageLabel.alphaValue = 0.0
            }
        }
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
        quotaEmailLabel.toolTip = email
        quotaTierBadge.title = tier
        quotaTierBadge.tint = tier == "ULTRA" ? .systemPurple : (tier == "PRO" ? .systemBlue : .secondaryLabelColor)
        quotaTierBadge.isHidden = tier.isEmpty

        let liveEmail = app.statusValue.liveAccountEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        let isLiveMatch = !liveEmail.isEmpty && liveEmail.caseInsensitiveCompare(email) == .orderedSame
        if isLiveMatch {
            quotaStatusBadge.title = "当前账号"
            quotaStatusBadge.tint = Design.blue
            quotaStatusBadge.isHidden = false
        } else if !liveEmail.isEmpty {
            quotaStatusBadge.title = "已选记录 · 非运行账号"
            quotaStatusBadge.tint = .systemOrange
            quotaStatusBadge.isHidden = false
        } else {
            quotaStatusBadge.title = "已选记录"
            quotaStatusBadge.tint = .secondaryLabelColor
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
        quotaArgon.titleLabel.stringValue = argonState?.periodLabel == "5小时" ? "5 小时" : "每周"
        quotaArgon.apply(percentage: argonState?.percentage, placeholder: argonPlaceholder, reset: argonState?.percentage == nil ? "" : (argonState?.resetText ?? ""), stale: argonState?.stale == true)

        var warnings: [String] = []
        if let readiness = account["credentialReadiness"] as? [String: Any], readiness["state"] as? String == "needs_authorization" {
            warnings.append("登录授权已失效，请前往主界面重新授权")
        }
        if let singleErr = app.singleAccountRefreshErrors[id], !singleErr.isEmpty {
            warnings.append(InterfaceText.quotaMessage(singleErr))
        } else if let globalErr = app.quotaRefreshError, !globalErr.isEmpty {
            warnings.append(InterfaceText.quotaMessage(globalErr))
        } else if let refreshErr = account["quota_refresh_error"] as? String, !refreshErr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !refreshErr.contains("双周期") {
            warnings.append(InterfaceText.quotaMessage(refreshErr))
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
            let emptyLbl = text(app.reachable ? "尚未保存任何 Google 账号，可前往主界面账号页添加。" : "正在等待本机服务读取账号列表…", size: 11.5, color: Design.secondary, wrap: true)
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

