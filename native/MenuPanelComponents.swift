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

/// 菜单卡片与面板共用的配额展示辅助。
enum MenuQuotaHelpers {
    /// "4 小时 13 分钟后重置" -> "4小时13分后重置"，菜单内保持一行。
    static func compactReset(_ raw: String) -> String {
        InterfaceText.countdown(raw)
            .replacingOccurrences(of: "分钟", with: "分")
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "·", with: " · ")
    }

    static func groupHeader(_ title: String, brands: [String], fontSize: CGFloat = 11.5, iconSize: CGFloat = 13, spacing: CGFloat = 5) -> NSView {
        var views: [NSView] = brands.compactMap { brand in
            guard let image = ModelIcons.image(brand) else { return nil }
            let icon = NSImageView(image: image)
            icon.imageScaling = .scaleProportionallyUpOrDown
            icon.contentTintColor = ModelIcons.tintColor(for: image)
            icon.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([icon.widthAnchor.constraint(equalToConstant: iconSize), icon.heightAnchor.constraint(equalToConstant: iconSize)])
            icon.setAccessibilityElement(false)
            return icon
        }
        let lbl = text(title, size: fontSize, weight: .semibold, color: .secondaryLabelColor)
        lbl.alignment = .left
        views.append(lbl)
        let row = horizontal(views, spacing: spacing)
        row.alignment = .centerY
        return row
    }

    static func syncExtraStandaloneGroups(_ models: [QuotaPresentation.Argon], into stack: NSStackView, withLeadingDividers: Bool, headerFontSize: CGFloat = 11.5, iconSize: CGFloat = 13) {
        stack.arrangedSubviews.forEach {
            stack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        guard !models.isEmpty else {
            stack.isHidden = true
            return
        }
        stack.isHidden = false
        for (idx, item) in models.enumerated() {
            if withLeadingDividers || idx > 0 {
                let div = divider()
                stack.addArrangedSubview(div)
                fillWidth(div, in: stack)
            }
            let brands = ModelIcons.brands(for: item.modelName)
            let hdr = groupHeader(item.modelName, brands: brands, fontSize: headerFontSize, iconSize: iconSize, spacing: 5)
            let rowTitle: String
            switch item.periodLabel {
            case "5小时": rowTitle = "5 小时"
            case "每周": rowTitle = "每周"
            case "周期未知": rowTitle = "周期未知"
            default: rowTitle = ""
            }
            let row = MenuMeterRow(title: rowTitle)
            row.accessibilityGroupName = item.modelName
            let placeholder = item.availability == "disabled" ? "不可用" : item.placeholder
            row.apply(percentage: item.percentage, placeholder: placeholder, reset: item.percentage == nil ? "" : item.resetText, stale: item.stale)
            let grp = vertical([hdr, row], spacing: 6)
            grp.alignment = .leading
            fillWidth(hdr, in: grp)
            fillWidth(row, in: grp)
            stack.addArrangedSubview(grp)
            fillWidth(grp, in: stack)
        }
    }
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
        top.detachesHiddenViews = true
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
    var accessibilityGroupName = ""
    func apply(percentage: Int?, placeholder: String, reset: String, stale: Bool) {
        let compactReset = MenuQuotaHelpers.compactReset(reset)
        let titleEmpty = titleLabel.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if titleLabel.isHidden != titleEmpty { titleLabel.isHidden = titleEmpty }
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
        setAccessibilityLabel([accessibilityGroupName, titleLabel.stringValue, valueLabel.stringValue, compactReset].filter { !$0.isEmpty }.joined(separator: "，"))
    }
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

    override func layout() {
        super.layout()
        needsDisplay = true
    }

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
        refusesFirstResponder = false
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
        let display = model
        self.nameLabel = text(display, size: 12, weight: .semibold, color: .labelColor, wrap: true)
        self.tokensLabel = text(tokensText, size: 12, weight: .semibold, color: .labelColor)
        super.init(frame: .zero)

        nameLabel.maximumNumberOfLines = 2
        nameLabel.lineBreakMode = .byWordWrapping
        nameLabel.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
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
            let display = rawModel
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
    let carbonRow = MenuMeterRow(title: "Gemini 4 Carbon")
    let extraStandaloneStack = NSStackView()
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
        cornerRadius = Design.Radius.popover
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
        stateButton.refusesFirstResponder = false
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

        extraStandaloneStack.orientation = .vertical
        extraStandaloneStack.alignment = .leading
        extraStandaloneStack.spacing = 6
        extraStandaloneStack.isHidden = true
        extraStandaloneStack.detachesHiddenViews = true

        let detailViews: [NSView] = [
            divider(),
            gemini5hRow,
            geminiWeeklyRow,
            claude5hRow,
            claudeWeeklyRow,
            argonRow,
            carbonRow,
            extraStandaloneStack,
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
        stateButton.toolTip = nil
        stateButton.setAccessibilityLabel(isCurrent ? "当前账号" : "切换至该账号")
        stateButton.setAccessibilityRole(.button)
        nameLabel.stringValue = display
        emailLabel.stringValue = email
        emailLabel.toolTip = nil

        tierBadge.title = tier
        tierBadge.tint = tier == "ULTRA" ? .systemPurple : (tier == "PRO" ? .systemBlue : Design.inactivePill)
        tierBadge.isHidden = tier.isEmpty

        if isCurrent {
            statusBadge.title = isLiveVerified ? "当前账号" : "已选记录"
            statusBadge.tint = isLiveVerified ? Design.blue : Design.inactivePill
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

        let carbonState = contract.carbon
        let carbonPlaceholder = carbonState?.availability == "disabled" ? "不可用" : (carbonState?.placeholder ?? "未知")
        carbonRow.titleLabel.stringValue = carbonState?.title ?? "Gemini 4 Carbon"
        carbonRow.apply(percentage: carbonState?.percentage, placeholder: carbonPlaceholder, reset: carbonState?.percentage == nil ? "" : (carbonState?.resetText ?? ""), stale: carbonState?.stale == true)

        extraStandaloneStack.arrangedSubviews.forEach {
            extraStandaloneStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        let extraModels = contract.extraStandaloneModels
        extraStandaloneStack.isHidden = extraModels.isEmpty
        for extra in extraModels {
            let row = MenuMeterRow(title: extra.title)
            let ph = extra.availability == "disabled" ? "不可用" : extra.placeholder
            row.apply(percentage: extra.percentage, placeholder: ph, reset: extra.percentage == nil ? "" : extra.resetText, stale: extra.stale)
            extraStandaloneStack.addArrangedSubview(row)
            fillWidth(row, in: extraStandaloneStack)
        }

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
