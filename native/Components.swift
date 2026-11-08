import Cocoa

func text(_ value: String, size: CGFloat = 13, weight: NSFont.Weight = .regular, color: NSColor = .labelColor, wrap: Bool = false) -> NSTextField {
    let label = wrap ? NSTextField(wrappingLabelWithString: value) : NSTextField(labelWithString: value)
    label.font = .systemFont(ofSize: size, weight: weight); label.textColor = color
    if wrap {
        label.maximumNumberOfLines = 0
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }
    return label
}
func vertical(_ views: [NSView], spacing: CGFloat = 12) -> NSStackView {
    let stack = NSStackView(views: views); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = spacing
    return stack
}
func horizontal(_ views: [NSView], spacing: CGFloat = 10) -> NSStackView {
    let stack = NSStackView(views: views); stack.orientation = .horizontal; stack.alignment = .centerY; stack.spacing = spacing
    return stack
}
func flexibleSpace() -> NSView {
    let view = NSView(); view.setContentHuggingPriority(.defaultLow, for: .horizontal); return view
}
func pin(_ view: NSView, to parent: NSView, inset: CGFloat = 0) {
    view.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([view.leadingAnchor.constraint(equalTo: parent.leadingAnchor, constant: inset), view.trailingAnchor.constraint(equalTo: parent.trailingAnchor, constant: -inset), view.topAnchor.constraint(equalTo: parent.topAnchor, constant: inset), view.bottomAnchor.constraint(equalTo: parent.bottomAnchor, constant: -inset)])
}
func fillWidth(_ view: NSView, in stack: NSStackView) { view.translatesAutoresizingMaskIntoConstraints = false; view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
func symbol(_ name: String, size: CGFloat = 22, color: NSColor = .controlAccentColor) -> NSImageView {
    let view = NSImageView(image: NSImage(systemSymbolName: name, accessibilityDescription: nil) ?? NSImage(systemSymbolName: "square", accessibilityDescription: nil) ?? NSImage())
    view.setAccessibilityElement(false)
    view.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: size, weight: .regular); view.contentTintColor = color
    view.translatesAutoresizingMaskIntoConstraints = false; view.widthAnchor.constraint(equalToConstant: size + 4).isActive = true; view.heightAnchor.constraint(equalToConstant: size + 4).isActive = true
    return view
}
func button(_ title: String, target: AnyObject?, action: Selector) -> NSButton {
    let view = DesignButton(title: title, target: target, action: action)
    view.bezelStyle = .rounded; view.isBordered = false; view.font = .systemFont(ofSize: 12, weight: .medium)
    view.setAccessibilityLabel(title); return view
}
class DesignCardBox: NSBox {
    var enablesHoverHighlight: Bool = false {
        didSet {
            if enablesHoverHighlight { updateTrackingAreas() }
        }
    }
    private var hoverTrackingArea: NSTrackingArea?
    private let hoverMotion = DesignMotion()
    private var hoverProgress: CGFloat = 0

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTrackingArea { removeTrackingArea(area); hoverTrackingArea = nil }
        guard enablesHoverHighlight else { return }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        hoverTrackingArea = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) {
        guard enablesHoverHighlight else { return }
        hoverMotion.animate(in: self, from: hoverProgress, to: 1.0, curve: .hover) { [weak self] val in
            self?.hoverProgress = val
            self?.needsDisplay = true
        }
    }

    override func mouseExited(with event: NSEvent) {
        guard enablesHoverHighlight else { return }
        hoverMotion.animate(in: self, from: hoverProgress, to: 0.0, curve: .hover) { [weak self] val in
            self?.hoverProgress = val
            self?.needsDisplay = true
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if Design.isInPopover(self) {
            shadow = nil
        }
        if window == nil {
            hoverMotion.cancel()
            hoverProgress = 0
        }
    }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if enablesHoverHighlight && hoverProgress > 0.005 {
            let hoverRect = bounds.insetBy(dx: 0.5, dy: 0.5)
            let hoverPath = NSBezierPath(roundedRect: hoverRect, xRadius: cornerRadius, yRadius: cornerRadius)
            (isDark ? NSColor.white.withAlphaComponent(0.028 * hoverProgress) : NSColor.black.withAlphaComponent(0.016 * hoverProgress)).setFill()
            hoverPath.fill()
            Design.blue.withAlphaComponent((isDark ? 0.22 : 0.16) * hoverProgress).setStroke()
            hoverPath.lineWidth = 0.75
            hoverPath.stroke()
        }
        Design.drawSpecularBevel(in: bounds, cornerRadius: cornerRadius, isDark: isDark)
    }
}

final class SheetVisualEffectView: NSVisualEffectView {
    override init(frame frameRect: NSRect = .zero) {
        super.init(frame: frameRect)
        material = .sheet
        blendingMode = .behindWindow
        state = .active
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.masksToBounds = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let path = NSBezierPath(roundedRect: bounds, xRadius: 12, yRadius: 12)
        (isDark ? NSColor(white: 0.14, alpha: 0.88) : NSColor(white: 0.98, alpha: 0.88)).setFill()
        path.fill()
        Design.drawSpecularBevel(in: bounds, cornerRadius: 12, isDark: isDark)
    }
}

final class PillSelectionView: NSView {
    override var allowsVibrancy: Bool { false }
    private let motion = DesignMotion()
    private var currentTargetRect: NSRect = .zero

    override init(frame frameRect: NSRect = .zero) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 9
    }
    required init?(coder: NSCoder) { fatalError() }

    func slide(to targetRect: NSRect, in view: NSView?) {
        guard targetRect != currentTargetRect else { return }
        currentTargetRect = targetRect
        guard Design.shouldAnimate(in: view), frame != .zero, frame != targetRect else {
            frame = targetRect
            needsDisplay = true
            return
        }
        let startY = frame.origin.y
        let startH = frame.height
        let targetY = targetRect.origin.y
        let targetH = targetRect.height
        motion.animate(in: view, from: 0.0, to: 1.0, curve: .spring, threshold: 0.01) { [weak self] p in
            guard let self else { return }
            let y = startY + (targetY - startY) * p
            let h = startH + (targetH - startH) * p
            self.frame = NSRect(x: targetRect.origin.x, y: y, width: targetRect.width, height: h)
            self.needsDisplay = true
        } completion: { [weak self] in
            self?.frame = targetRect
            self?.needsDisplay = true
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let rect = bounds.insetBy(dx: 0.5, dy: 1.0)
        let path = NSBezierPath(roundedRect: rect, xRadius: 9, yRadius: 9)
        Design.blue.withAlphaComponent(isDark ? 0.22 : 0.12).setFill()
        path.fill()
    }
}

func group(_ rows: [NSView], inset: CGFloat = 17, spacing: CGFloat = 0) -> NSBox {
    let box = DesignCardBox(); box.boxType = .custom; box.cornerRadius = 12; box.borderWidth = 0.5
    box.borderColor = Design.border; box.fillColor = Design.card; box.contentViewMargins = .zero
    box.shadow = Design.cardShadow()
    let stack = vertical(rows, spacing: spacing); box.addSubview(stack); pin(stack, to: box, inset: inset)
    for row in rows { fillWidth(row, in: stack) }
    return box
}
func groupStack(_ box: NSBox) -> NSStackView? {
    (box.subviews.first as? NSStackView) ?? (box.contentView?.subviews.first as? NSStackView)
}
final class DesignDividerView: NSView {
    override var isOpaque: Bool { false }
    override var allowsVibrancy: Bool { false }
    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: 1)
    }
    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 1).isActive = true
        setAccessibilityElement(false)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ dirtyRect: NSRect) {
        designHairline(lightAlpha: 0.06, darkAlpha: 0.07).setFill()
        bounds.fill()
    }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

func divider() -> NSView {
    DesignDividerView()
}
func pageHeader(title: String, actions: NSView? = nil) -> NSView {
    let titleLabel = text(title, size: 24, weight: .semibold)
    titleLabel.identifier = NSUserInterfaceItemIdentifier("page-title")
    titleLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    titleLabel.setContentCompressionResistancePriority(.required, for: .vertical)
    guard let actions else { return titleLabel }
    actions.setContentHuggingPriority(.required, for: .horizontal)
    actions.setContentCompressionResistancePriority(.required, for: .horizontal)
    let row = horizontal([titleLabel, flexibleSpace(), actions])
    row.alignment = .centerY
    return row
}
func pageStack(title: String, actions: NSView? = nil) -> NSStackView {
    vertical([pageHeader(title: title, actions: actions)], spacing: 20)
}
func fixedPage(_ stack: NSStackView) -> NSView {
    let container = NSView()
    container.addSubview(stack)
    stack.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 24),
        stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -24),
        stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 20),
        stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -20)
    ])
    for child in stack.arrangedSubviews { fillWidth(child, in: stack) }
    return container
}
final class TopAlignedDocument: NSView { override var isFlipped: Bool { true } }

final class StickyHeaderScrollView: NSScrollView {
    let headerHost = NSVisualEffectView()
    let headerDivider = DesignDividerView()
    private var boundsObserver: NSObjectProtocol?

    init(headerView: NSView) {
        super.init(frame: .zero)
        drawsBackground = false
        hasVerticalScroller = true
        autohidesScrollers = true
        automaticallyAdjustsContentInsets = false
        contentInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)

        headerHost.material = .headerView
        headerHost.blendingMode = .withinWindow
        headerHost.state = .active
        headerHost.wantsLayer = true
        headerView.translatesAutoresizingMaskIntoConstraints = false
        headerDivider.translatesAutoresizingMaskIntoConstraints = false
        headerDivider.isHidden = true
        headerHost.addSubview(headerView)
        headerHost.addSubview(headerDivider)
        NSLayoutConstraint.activate([
            headerView.leadingAnchor.constraint(equalTo: headerHost.leadingAnchor, constant: 24),
            headerView.trailingAnchor.constraint(equalTo: headerHost.trailingAnchor, constant: -24),
            headerView.topAnchor.constraint(equalTo: headerHost.topAnchor, constant: 13),
            headerView.bottomAnchor.constraint(equalTo: headerHost.bottomAnchor, constant: -5),
            headerDivider.leadingAnchor.constraint(equalTo: headerHost.leadingAnchor, constant: 24),
            headerDivider.trailingAnchor.constraint(equalTo: headerHost.trailingAnchor, constant: -24),
            headerDivider.bottomAnchor.constraint(equalTo: headerHost.bottomAnchor),
            headerDivider.heightAnchor.constraint(equalToConstant: 1)
        ])
        addSubview(headerHost)

        contentView.postsBoundsChangedNotifications = true
        boundsObserver = NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification,
            object: contentView,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            let scrolled = self.contentView.bounds.origin.y > 2.0
            if self.headerDivider.isHidden == scrolled {
                self.headerDivider.isHidden = !scrolled
            }
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    deinit {
        if let boundsObserver {
            NotificationCenter.default.removeObserver(boundsObserver)
        }
    }

    override func tile() {
        super.tile()
        let headerH: CGFloat = 52
        headerHost.frame = NSRect(x: 0, y: 0, width: bounds.width, height: headerH)
        var clipFrame = contentView.frame
        clipFrame.origin.y = headerH
        clipFrame.size.height = max(0, bounds.height - headerH)
        contentView.frame = clipFrame
        if let vScroller = verticalScroller {
            var sFrame = vScroller.frame
            sFrame.origin.y = headerH
            sFrame.size.height = max(0, bounds.height - headerH)
            vScroller.frame = sFrame
        }
    }
}

func scrollPage(_ stack: NSStackView) -> NSView {
    if let first = stack.arrangedSubviews.first,
       (first.identifier?.rawValue == "page-title" || first.subviews.contains(where: { $0.identifier?.rawValue == "page-title" })) {
        stack.removeArrangedSubview(first)
        first.removeFromSuperview()
        let scroll = StickyHeaderScrollView(headerView: first)
        let document = TopAlignedDocument()
        document.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = document
        document.addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 4),
            stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -16)
        ])
        for view in stack.arrangedSubviews { fillWidth(view, in: stack) }
        return scroll
    }

    let scroll = NSScrollView()
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.automaticallyAdjustsContentInsets = false
    scroll.contentInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
    let document = TopAlignedDocument()
    document.translatesAutoresizingMaskIntoConstraints = false
    scroll.documentView = document
    document.addSubview(stack)
    stack.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 24),
        stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -24),
        stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 20),
        stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -20)
    ])
    for view in stack.arrangedSubviews { fillWidth(view, in: stack) }
    return scroll
}
/// Overview stretches the account quota card to fill the minimum window cleanly while keeping KPI cards balanced.
func dashboardScrollPage(_ stack: NSStackView, hero: NSView, metrics: [NSView]) -> NSView {
    let scroll = scrollPage(stack) as! NSScrollView
    for metric in metrics {
        metric.heightAnchor.constraint(greaterThanOrEqualToConstant: 88).isActive = true
    }
    return scroll
}

// MARK: - Safe Numeric Extraction Helper
func intVal(_ dict: [String: Any], _ key: String, fallback: Int = 0) -> Int {
    if let n = dict[key] as? NSNumber { return n.intValue }
    if let i = dict[key] as? Int { return i }
    if let d = dict[key] as? Double { return Int(d) }
    return fallback
}
func doubleVal(_ dict: [String: Any], _ key: String, fallback: Double = 0.0) -> Double {
    if let n = dict[key] as? NSNumber { return n.doubleValue }
    if let d = dict[key] as? Double { return d }
    if let i = dict[key] as? Int { return Double(i) }
    return fallback
}

// MARK: - Apple HIG Sidebar Row View (Eliminates black selection box in offscreen/inactive states)
final class SidebarRowView: NSTableRowView {
    override var allowsVibrancy: Bool { false }
    override var isEmphasized: Bool {
        get { false }
        set {}
    }
    override var interiorBackgroundStyle: NSView.BackgroundStyle { .normal }
    var navigationSelected = false { didSet { needsDisplay = true } }
    private var hoverTracking: NSTrackingArea?
    private let hoverMotion = DesignMotion()
    private var hoverProgress: CGFloat = 0
    var hovered = false {
        didSet {
            guard oldValue != hovered else { return }
            hoverMotion.animate(in: self, from: hoverProgress, to: hovered ? 1.0 : 0.0, curve: .hover, threshold: 0.04) { [weak self] val in
                self?.hoverProgress = val
                self?.needsDisplay = true
            }
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }
    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }
    override func drawSelection(in dirtyRect: NSRect) {}
    override func drawBackground(in dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let rect = bounds.insetBy(dx: 0.5, dy: 1.5)
        let path = NSBezierPath(roundedRect: rect, xRadius: 9, yRadius: 9)
        if hoverProgress > 0.02 && !navigationSelected {
            let hoverFill = isDark
                ? NSColor.white.withAlphaComponent(0.065 * hoverProgress)
                : NSColor.black.withAlphaComponent(0.048 * hoverProgress)
            hoverFill.setFill()
            path.fill()
        }
    }
}

// MARK: - Refined Sidebar Bottom Launcher Button (Matches SidebarRowView geometry & vector SF Symbols)
final class SidebarLaunchButton: NSButton {
    override var allowsVibrancy: Bool { false }
    private var hoverTracking: NSTrackingArea?
    private let hoverMotion = DesignMotion()
    private var hoverProgress: CGFloat = 0
    private var hovered = false {
        didSet {
            guard oldValue != hovered else { return }
            hoverMotion.animate(in: self, from: hoverProgress, to: hovered ? 1.0 : 0.0, curve: .hover, threshold: 0.04) { [weak self] val in
                self?.hoverProgress = val
                self?.needsDisplay = true
            }
        }
    }
    private let iconView = NSImageView()
    private let titleField: NSTextField

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: 36)
    }

    init(title: String = "打开 Antigravity", target: AnyObject?, action: Selector) {
        self.titleField = text(title, size: 13, weight: .medium, color: Design.primary.withAlphaComponent(0.86))
        super.init(frame: .zero)
        self.title = title
        self.target = target
        self.action = action
        bezelStyle = .inline
        isBordered = false
        focusRingType = .none
        setButtonType(.momentaryChange)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 36).isActive = true
        setAccessibilityLabel(title)

        iconView.image = NSImage(systemSymbolName: "arrow.up.forward.app", accessibilityDescription: nil)
        iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 14.5, weight: .medium)
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.setAccessibilityElement(false)
        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 18),
            iconView.heightAnchor.constraint(equalToConstant: 18)
        ])

        titleField.lineBreakMode = .byTruncatingTail
        titleField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        titleField.setAccessibilityElement(false)

        let row = horizontal([iconView, titleField], spacing: 10)
        row.alignment = .centerY
        addSubview(row)
        row.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            row.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -10),
            row.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    override func hitTest(_ point: NSPoint) -> NSView? {
        super.hitTest(point) == nil ? nil : self
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }

    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let active = isHighlighted || hoverProgress > 0.5
        let rect = bounds.insetBy(dx: 0.5, dy: 1.5)
        let path = NSBezierPath(roundedRect: rect, xRadius: 9, yRadius: 9)

        if isHighlighted {
            Design.blue.withAlphaComponent(isDark ? 0.20 : 0.12).setFill()
            path.fill()
        } else if hoverProgress > 0.02 {
            let hoverFill = isDark ? NSColor.white.withAlphaComponent(0.08 * hoverProgress) : NSColor.black.withAlphaComponent(0.048 * hoverProgress)
            hoverFill.setFill()
            path.fill()
        }

        let accentTint = isDark
            ? NSColor(srgbRed: 0.38, green: 0.68, blue: 1.0, alpha: 1.0)
            : Design.blue
        iconView.contentTintColor = active ? accentTint : Design.secondary
        titleField.textColor = active ? (isDark ? .white : Design.blue) : Design.primary.withAlphaComponent(0.84)

        if window?.firstResponder === self {
            Design.blue.setStroke()
            path.lineWidth = 2
            path.stroke()
        }
    }
}


struct LiveStatus {
    var bundleCacheHit = false
    var connectionError = ""
    var working = false
    var taskRevision = 0
    var languageMode = "zh"
    var mode = "starting"
    var appVersion = ""
    var entries = 0
    var windows = 0
    var message = "正在连接本机服务…"
    var dictionaryVersion = ""
    var dictionaryError = ""
    var baseVersion = "2.23.0"
    var rss: Double = 0
    var updatedAt = ""
    var pending = 0
    var activeAccountEmail = ""
    var activeFiveHourQuota: Int? = nil
    var activeSubscriptionTier = "FREE"
    var accountsRevision = ""
    var liveAccountEmail = ""

    init(_ raw: [String: Any] = [:]) {
        working = (raw["healing"] as? Bool == true) || (raw["runningTasks"] as? Int ?? 0) > 0
        taskRevision = raw["taskRevision"] as? Int ?? 0
        bundleCacheHit = raw["bundleCacheHit"] as? Bool ?? false
        languageMode = raw["languageMode"] as? String ?? "zh"
        mode = raw["mode"] as? String ?? "starting"
        appVersion = raw["appVersion"] as? String ?? ""
        entries = raw["entries"] as? Int ?? 0
        windows = raw["windows"] as? Int ?? 0
        message = raw["message"] as? String ?? "正在连接本机服务…"
        dictionaryVersion = raw["dictionaryVersion"] as? String ?? ""
        dictionaryError = raw["dictionaryError"] as? String ?? ""
        baseVersion = raw["dictionaryBaseVersion"] as? String ?? "2.23.0"
        rss = (raw["rssMB"] as? NSNumber)?.doubleValue ?? 0
        updatedAt = raw["updatedAt"] as? String ?? ""
        pending = raw["newStringsCount"] as? Int ?? 0
        activeAccountEmail = raw["activeAccountEmail"] as? String ?? ""
        activeFiveHourQuota = raw["activeFiveHourQuota"] as? Int
        activeSubscriptionTier = raw["activeSubscriptionTier"] as? String ?? "FREE"
        accountsRevision = (raw["accountsRevision"] as? String) ?? "\(raw["accountsRevision"] ?? "")"
        liveAccountEmail = raw["liveAccountEmail"] as? String ?? ""
        if let errors = raw["errors"] as? [String], !errors.isEmpty {
            connectionError = errors.joined(separator: "；")
        }
    }

    var enabled: Bool {
        mode == "connected" || mode == "adaptive" || mode == "waiting" || mode == "waiting-window"
    }

    var title: String {
        if !dictionaryError.isEmpty { return "需要检查词典" }
        if !connectionError.isEmpty { return "部分界面需要检查" }
        if working && enabled { return "正在处理任务" }
        switch mode {
        case "connected", "adaptive": return "已连接"
        case "paused": return "汉化已暂停"
        case "unsupported": return "等待版本适配"
        case "legacy-blocked": return "检测到旧版汉化"
        case "error": return "连接需要处理"
        case "stopped": return "服务已停止"
        case "waiting-window": return "等待可连接窗口"
        case "waiting": return "等待目标界面"
        default: return "等待 Antigravity"
        }
    }

    var color: NSColor {
        if !connectionError.isEmpty { return .systemOrange }
        if working && enabled { return .systemBlue }
        if !dictionaryError.isEmpty { return .systemOrange }
        switch mode {
        case "connected": return languageMode == "zh" ? .systemGreen : .systemBlue
        case "adaptive", "unsupported", "legacy-blocked": return .systemOrange
        case "error": return .systemRed
        default: return .secondaryLabelColor
        }
    }
}


// MARK: - G01/F04: 浅色可读色（只压暗、不换色相；深色沿用系统色）
private func gbSRGBLinear(_ v: CGFloat) -> CGFloat { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
private func gbLuminance(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGFloat {
    0.2126 * gbSRGBLinear(r) + 0.7152 * gbSRGBLinear(g) + 0.0722 * gbSRGBLinear(b)
}
private func gbResolvedSRGB(_ color: NSColor, _ appearance: NSAppearance) -> NSColor {
    var resolved = color
    appearance.performAsCurrentDrawingAppearance { resolved = color.usingColorSpace(.sRGB) ?? color }
    return resolved
}

/// 胶囊 tint：浅色下按“同色 14% 胶囊底”把文字色压暗到 ≥4.5:1；深色保持原色。
func readablePillTint(_ color: NSColor, fillAlpha: CGFloat = 0.14) -> NSColor {
    NSColor(name: nil) { appearance in
        if appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua { return gbResolvedSRGB(color, appearance) }
        let base = gbResolvedSRGB(color, appearance)
        var r = base.redComponent, g = base.greenComponent, b = base.blueComponent
        let cardLuminance: CGFloat = 1.0 // Design.card 浅色 #FFFFFF
        for _ in 0..<24 {
            let luminance = gbLuminance(r, g, b)
            let background = (1 - fillAlpha) * cardLuminance + fillAlpha * luminance
            if (background + 0.05) / (luminance + 0.05) >= 4.5 { break }
            r *= 0.86; g *= 0.86; b *= 0.86
        }
        return NSColor(srgbRed: r, green: g, blue: b, alpha: 1)
    }
}

/// 浅色可读警示橙（#B45309，白底 5.1:1）；深色保持系统橙。
func accessibleWarningColor() -> NSColor {
    NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? .systemOrange
            : NSColor(srgbRed: 0.706, green: 0.325, blue: 0.035, alpha: 1)
    }
}

/// 浅色可读错误红（#B91C1C，白底 6.4:1）；深色保持系统红。
func accessibleDangerColor() -> NSColor {
    NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? .systemRed
            : NSColor(srgbRed: 0.725, green: 0.110, blue: 0.110, alpha: 1)
    }
}

final class PillBadge: NSView {
    override var allowsVibrancy: Bool { false }
    let label = text("", size: 11, weight: .semibold)
    var emphasized = false { didSet { updateLabelTextColor(); needsDisplay = true } }
    var tint: NSColor { didSet { updateLabelTextColor(); needsDisplay = true } }
    var title: String { get { label.stringValue } set { label.stringValue = newValue; toolTip = newValue; setAccessibilityLabel(newValue); invalidateIntrinsicContentSize(); needsDisplay = true } }

    static func isNeutralOrInactiveTint(_ color: NSColor, in appearance: NSAppearance) -> Bool {
        if color === Design.inactivePill || color === Design.secondary || color == .secondaryLabelColor || color == .systemGray {
            return true
        }
        let srgb = gbResolvedSRGB(color, appearance)
        let maxC = max(srgb.redComponent, max(srgb.greenComponent, srgb.blueComponent))
        let minC = min(srgb.redComponent, min(srgb.greenComponent, srgb.blueComponent))
        return (maxC - minC) < 0.08
    }

    private func updateLabelTextColor() {
        if emphasized {
            label.textColor = .white
            return
        }
        let currentTint = tint
        label.textColor = NSColor(name: nil) { appearance in
            if Self.isNeutralOrInactiveTint(currentTint, in: appearance) {
                return gbResolvedSRGB(Design.inactivePill, appearance)
            }
            return gbResolvedSRGB(readablePillTint(currentTint), appearance)
        }
    }

    init(_ title: String, color: NSColor) {
        tint = color; super.init(frame: .zero)
        label.setAccessibilityElement(false); label.stringValue = title; updateLabelTextColor(); label.lineBreakMode = .byTruncatingTail
        addSubview(label); label.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8), label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8), label.topAnchor.constraint(equalTo: topAnchor, constant: 2.5), label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2.5)])
        setAccessibilityElement(true); setAccessibilityRole(.staticText); setAccessibilityLabel(title)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var intrinsicContentSize: NSSize { NSSize(width: label.intrinsicContentSize.width + 16, height: label.intrinsicContentSize.height + 5) }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateLabelTextColor()
        needsDisplay = true
    }
    override func draw(_ rect: NSRect) {
        let radius = bounds.height / 2
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if !emphasized && Self.isNeutralOrInactiveTint(tint, in: effectiveAppearance) {
            Design.inactivePillFill.setFill()
            path.fill()
            Design.inactivePillBorder.setStroke()
            path.lineWidth = 0.75
            path.stroke()
            return
        }
        let display: NSColor = emphasized ? .white : readablePillTint(tint)
        display.withAlphaComponent(isDark ? 0.18 : 0.12).setFill()
        path.fill()
        display.withAlphaComponent(isDark ? 0.34 : 0.24).setStroke()
        path.lineWidth = 0.8
        path.stroke()
    }
}
func pillBadge(_ title: String, color: NSColor) -> PillBadge { PillBadge(title, color: color) }

// MARK: - Apple HIG Modern Avatar View (40pt Frosted Circular Badge)
func iconBadge(_ name: String, tint: NSColor, size: CGFloat = 24) -> NSView {
    let box = NSBox()
    box.boxType = .custom
    box.cornerRadius = round(size * 0.26 * 2.0) / 2.0
    box.fillColor = NSColor(name: nil) { app in
        let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        return tint.withAlphaComponent(isDark ? 0.18 : 0.11)
    }
    box.borderWidth = 0.5
    box.borderColor = NSColor(name: nil) { app in
        let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        return tint.withAlphaComponent(isDark ? 0.34 : 0.20)
    }
    box.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([box.widthAnchor.constraint(equalToConstant: size), box.heightAnchor.constraint(equalToConstant: size)])
    let ptSize: CGFloat = size == 24 ? 13 : (size >= 36 ? 17.5 : 15)
    let image = symbol(name, size: ptSize, color: tint)
    image.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: ptSize, weight: .semibold)
    box.addSubview(image)
    NSLayoutConstraint.activate([image.centerXAnchor.constraint(equalTo: box.centerXAnchor), image.centerYAnchor.constraint(equalTo: box.centerYAnchor)])
    box.setAccessibilityElement(false)
    return box
}
func settingRow(icon: String, tint: NSColor, title: String, badge: NSView? = nil, subtitle: String, control: NSView) -> NSView {
    let titleLabel = text(title, size: 13, weight: .semibold, color: .labelColor)
    let titleView: NSView
    if let badge {
        let row = horizontal([titleLabel, badge], spacing: 6)
        row.alignment = .centerY
        titleView = row
    } else {
        titleView = titleLabel
    }
    var labels: [NSView] = [titleView]
    if !subtitle.isEmpty {
        let sub = text(subtitle, size: 11, color: Design.secondary, wrap: true)
        sub.maximumNumberOfLines = 1
        sub.lineBreakMode = .byTruncatingTail
        sub.toolTip = subtitle
        labels.append(sub)
    }
    let captions = vertical(labels, spacing: 2)
    captions.alignment = .leading
    captions.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    control.setContentHuggingPriority(.required, for: .horizontal)
    control.setContentCompressionResistancePriority(.required, for: .horizontal)
    let iconBox = NSBox()
    iconBox.boxType = .custom
    iconBox.cornerRadius = 7.5
    iconBox.fillColor = NSColor(name: nil) { app in
        let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if icon == "app-icon" {
            return isDark ? NSColor.white.withAlphaComponent(0.07) : NSColor.black.withAlphaComponent(0.04)
        }
        return tint.withAlphaComponent(isDark ? 0.18 : 0.10)
    }
    iconBox.borderWidth = 0.5
    iconBox.borderColor = NSColor(name: nil) { app in
        let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if icon == "app-icon" {
            return isDark ? NSColor.white.withAlphaComponent(0.12) : NSColor.black.withAlphaComponent(0.08)
        }
        return tint.withAlphaComponent(isDark ? 0.32 : 0.18)
    }
    iconBox.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        iconBox.widthAnchor.constraint(equalToConstant: 28),
        iconBox.heightAnchor.constraint(equalToConstant: 28)
    ])
    if icon == "app-icon", let markImg = Design.brandMarkImage() {
        let imgView = NSImageView(image: markImg)
        imgView.imageScaling = .scaleProportionallyUpOrDown
        imgView.translatesAutoresizingMaskIntoConstraints = false
        imgView.setAccessibilityElement(false)
        iconBox.addSubview(imgView)
        NSLayoutConstraint.activate([
            imgView.widthAnchor.constraint(equalToConstant: 17),
            imgView.heightAnchor.constraint(equalToConstant: 17),
            imgView.centerXAnchor.constraint(equalTo: iconBox.centerXAnchor),
            imgView.centerYAnchor.constraint(equalTo: iconBox.centerYAnchor)
        ])
    } else {
        let iconView = symbol(icon.replacingOccurrences(of: ".fill", with: ""), size: 13.5, color: tint)
        iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13.5, weight: .medium)
        iconBox.addSubview(iconView)
        NSLayoutConstraint.activate([
            iconView.centerXAnchor.constraint(equalTo: iconBox.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconBox.centerYAnchor)
        ])
    }
    iconBox.setAccessibilityElement(false)
    let row = horizontal([iconBox, captions, flexibleSpace(), control], spacing: 11)
    row.alignment = .centerY
    return row
}
func metricValue() -> NSTextField {
    let label = text("—"); label.font = .monospacedDigitSystemFont(ofSize: 21, weight: .bold); label.lineBreakMode = .byTruncatingTail
    label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal); return label
}

final class SurfaceView: NSView {
    override var isOpaque: Bool { true }
    override func draw(_ rect: NSRect) { Design.background.setFill(); rect.fill() }
}

final class EmptyStateView: NSView {
    let iconView: NSImageView
    let titleLabel: NSTextField
    let subtitleLabel: NSTextField
    let actionButton: NSButton?

    init(icon: String, title: String, subtitle: String, buttonTitle: String? = nil, target: AnyObject? = nil, action: Selector? = nil) {
        iconView = NSImageView()
        iconView.image = NSImage(systemSymbolName: icon, accessibilityDescription: nil)
        iconView.contentTintColor = .secondaryLabelColor
        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 40),
            iconView.heightAnchor.constraint(equalToConstant: 40)
        ])

        titleLabel = text(title, size: 14, weight: .semibold, color: .labelColor)
        titleLabel.alignment = .center

        subtitleLabel = text(subtitle, size: 12, weight: .regular, color: Design.secondary, wrap: true)
        subtitleLabel.alignment = .center
        subtitleLabel.maximumNumberOfLines = 3

        var views: [NSView] = [iconView, titleLabel]
        if let btnTitle = buttonTitle, let act = action {
            let btn = button(btnTitle, target: target, action: act)
            btn.bezelStyle = .rounded
            btn.controlSize = .regular
            views.append(btn)
            actionButton = btn
        } else {
            actionButton = nil
        }

        super.init(frame: .zero)
        let stack = vertical(views, spacing: 10)
        stack.alignment = .centerX
        addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -20),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 160)
        ])
    }

    required init?(coder: NSCoder) { fatalError() }
}

final class TableScrollView: NSScrollView {
    var tableStyle: NSTableView.Style = .fullWidth
    private var fittedWidth: CGFloat = -1
    // G02/F16: 深浅色下统一表格网格线为低对比语义色；表格高度贴合真实行数，避免把空白区域
    // 画成一条条“空记录”分隔线（深色下的可见度远高于浅色，形成深浅不一致）。
    private static let gridLineColor = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor.white.withAlphaComponent(0.035)
            : NSColor.black.withAlphaComponent(0.10)
    }
    private var originalGridMasks: [ObjectIdentifier: NSTableView.GridLineStyle] = [:]
    override func tile() { super.tile(); fitColumns(); updateEmptyRowGrid() }
    override func layout() { super.layout(); fitColumns(); updateEmptyRowGrid() }
    // G02/F16: NSTableView 在 scroll view 内会把自己的 frame 拉伸到视口高度，并在空白行也画网格线；
    // 数据不足以填满视口时隐藏网格线（与浅色“无行分隔线”一致），填满视口时恢复，
    // 并用自适应低对比色统一深浅色的可见度。
    private func updateEmptyRowGrid() {
        guard let table = documentView as? NSTableView else { return }
        let key = ObjectIdentifier(table)
        if !table.gridStyleMask.isEmpty { originalGridMasks[key] = table.gridStyleMask }
        let rows = table.numberOfRows
        let contentHeight: CGFloat = rows > 0 ? table.rect(ofRow: rows - 1).maxY : 0
        let fillsViewport = contentHeight >= contentView.bounds.height - 1
        let desired: NSTableView.GridLineStyle = fillsViewport ? (originalGridMasks[key] ?? []) : []
        if table.gridStyleMask != desired { table.gridStyleMask = desired }
        if !desired.isEmpty { table.gridColor = Self.gridLineColor }
    }
    private func fitColumns() {
        guard let table = documentView as? NSTableView, !table.tableColumns.isEmpty else { return }
        if table.style != tableStyle { table.style = tableStyle }
        let width = max(contentView.bounds.width, table.tableColumns.reduce(0) { $0 + $1.minWidth } + CGFloat(table.tableColumns.count) * table.intercellSpacing.width)
        guard abs(width - fittedWidth) > 0.5 || abs(table.frame.width - width) > 0.5 else { return }; fittedWidth = width
        let columns = table.tableColumns, weights = table.tableColumns.map { $0.width }, total = table.tableColumns.reduce(0) { $0 + $1.width }
        let gutters = CGFloat(columns.count) * table.intercellSpacing.width
        let minimum = columns.reduce(0) { $0 + $1.minWidth }, extra = max(0, width - minimum - gutters)
        table.columnAutoresizingStyle = .noColumnAutoresizing
        for (index,column) in columns.enumerated() { column.width = column.minWidth + extra * (total > 0 ? weights[index] / total : 1 / CGFloat(columns.count)) }
        table.setFrameSize(NSSize(width: width, height: table.frame.height))
    }
}

// MARK: - QuotaBarView (三层分离配额组件：名称+百分比、细轨道进度条、重置倒计时)
final class QuotaBarView: NSView {
    final class TrackView: NSView {
        var percentage: Int = 0 {
            didSet {
                guard oldValue != percentage else { return }
                animateTo(CGFloat(percentage))
            }
        }
        private var displayedPercentage: CGFloat = 0
        private let motion = DesignMotion()
        var percentageKnown: Bool = true
        var staleData: Bool = false

        deinit { motion.cancel() }

        private func animateTo(_ target: CGFloat) {
            motion.cancel()
            guard Design.shouldAnimate(in: self) else {
                displayedPercentage = target
                needsDisplay = true
                return
            }
            let start = displayedPercentage
            if abs(target - start) < 0.5 {
                displayedPercentage = target
                needsDisplay = true
                return
            }
            motion.animate(in: self, from: start, to: target, curve: .sweep, threshold: 0.5) { [weak self] val in
                self?.displayedPercentage = val
                self?.needsDisplay = true
            }
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window == nil {
                motion.cancel()
                displayedPercentage = CGFloat(percentage)
            }
        }

        var healthyTint: NSColor = Design.blue

        override func draw(_ dirtyRect: NSRect) {
            let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let radius: CGFloat = bounds.height / 2.0
            let trackRect = bounds.insetBy(dx: 0.5, dy: 0.5)
            let trackPath = NSBezierPath(roundedRect: trackRect, xRadius: radius, yRadius: radius)

            Design.track.setFill()
            trackPath.fill()

            NSColor(white: isDark ? 1.0 : 0.0, alpha: isDark ? 0.055 : 0.045).setStroke()
            trackPath.lineWidth = 0.5
            trackPath.stroke()

            // 填充长度对应剩余配额，低配额联动警示色/危急色，最小宽度不小于轨道高度以避免 1% 裁切变形
            if percentageKnown && percentage > 0 {
                let effectivePct = displayedPercentage > 0 ? displayedPercentage : CGFloat(percentage)
                let fillW = max(trackRect.height, min(bounds.width, bounds.width * effectivePct / 100.0))
                if fillW > 0 {
                    let fillRect = NSRect(x: 0, y: 0, width: fillW, height: bounds.height)
                    NSGraphicsContext.current?.saveGraphicsState()
                    trackPath.addClip()
                    let baseColor: NSColor
                    if percentage <= 10 {
                        baseColor = accessibleDangerColor()
                    } else if percentage <= 20 {
                        baseColor = accessibleWarningColor()
                    } else {
                        baseColor = healthyTint
                    }
                    let startTint = staleData ? baseColor.withAlphaComponent(0.35) : baseColor.withAlphaComponent(0.75)
                    let endTint = staleData ? baseColor.withAlphaComponent(0.45) : baseColor
                    let fillPath = NSBezierPath(roundedRect: fillRect, xRadius: radius, yRadius: radius)
                    if let grad = NSGradient(starting: startTint, ending: endTint) {
                        grad.draw(in: fillPath, angle: 0)
                    } else {
                        endTint.setFill()
                        fillPath.fill()
                    }
                    NSGraphicsContext.current?.restoreGraphicsState()
                }
            }
        }
    }

    let titleLabel = text("", size: 11, weight: .regular, color: .labelColor)
    let percentageLabel = NSTextField(labelWithString: "")
    let trackView = TrackView()
    let resetLabel = text("", size: 10, color: Design.secondary)
    let iconView = NSImageView()
    let secondaryIconView = NSImageView()

    private(set) var percentage: Int = 0
    private(set) var percentageKnown: Bool = true
    private(set) var staleData: Bool = false
    var unknownPlaceholder: String = "待刷新"

    private var leftStack: NSStackView!
    private var topRow: NSStackView!
    private var containerStack: NSStackView!

    // 百分比文字颜色：普通用主文字色；低配额变橙/红；未知为次级灰
    private var percentageTextColor: NSColor {
        if staleData { return accessibleWarningColor() }
        guard percentageKnown else { return Design.secondary }
        if percentage <= 10 {
            return accessibleDangerColor()
        } else if percentage <= 20 {
            return accessibleWarningColor()
        } else {
            return .labelColor
        }
    }

    // 重置倒计时颜色：普通倒计时使用 .secondaryLabelColor，仅紧急状态（如“即将重置”/已过/配额告急）使用警示色
    private var resetTextColor: NSColor {
        let text = resetLabel.stringValue
        let isUrgent = text.contains("即将重置") || text.contains("已过") || text.contains("告急")
        guard isUrgent else { return Design.secondary }
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if text.contains("已过") || text.contains("告急") {
            return isDark
                ? NSColor(srgbRed: 0.984, green: 0.443, blue: 0.522, alpha: 1.0)
                : accessibleDangerColor()
        }
        return isDark
            ? NSColor(srgbRed: 0.984, green: 0.749, blue: 0.141, alpha: 1.0)
            : accessibleWarningColor()
    }

    init(title: String = "", percentage: Int? = nil, resetText: String = "", icon: String = "sparkles", unknownPlaceholder: String? = nil, stale: Bool = false) {
        self.percentage = max(0, min(100, percentage ?? 0))
        self.percentageKnown = percentage != nil
        self.staleData = stale
        if let unknownPlaceholder = unknownPlaceholder {
            self.unknownPlaceholder = unknownPlaceholder
        } else {
            self.unknownPlaceholder = "未知"
        }
        trackView.percentage = self.percentage
        trackView.percentageKnown = self.percentageKnown
        trackView.staleData = self.staleData

        iconView.image = icon.isEmpty ? nil : NSImage(systemSymbolName: icon, accessibilityDescription: nil)
        iconView.contentTintColor = .secondaryLabelColor
        iconView.setContentHuggingPriority(.required, for: .horizontal)
        iconView.setContentCompressionResistancePriority(.required, for: .horizontal)
        iconView.isHidden = icon.isEmpty
        secondaryIconView.isHidden = true
        for image in [iconView,secondaryIconView] {
            image.translatesAutoresizingMaskIntoConstraints = false; image.imageScaling = .scaleProportionallyUpOrDown
            NSLayoutConstraint.activate([image.widthAnchor.constraint(equalToConstant:14),image.heightAnchor.constraint(equalToConstant:14)])
            image.setAccessibilityElement(false)
        }

        leftStack = horizontal([iconView, secondaryIconView, titleLabel], spacing: 5)
        topRow = horizontal([leftStack, flexibleSpace(), resetLabel, percentageLabel], spacing: 6)
        topRow.alignment = .centerY

        containerStack = vertical([topRow, trackView], spacing: 4.5)
        containerStack.alignment = .leading

        super.init(frame: .zero)

        titleLabel.stringValue = title
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentHuggingPriority(NSLayoutConstraint.Priority(245), for: .horizontal)
        titleLabel.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(240), for: .horizontal)

        resetLabel.stringValue = InterfaceText.countdown(resetText)
        resetLabel.alignment = .right
        resetLabel.lineBreakMode = .byTruncatingTail
        resetLabel.setContentHuggingPriority(NSLayoutConstraint.Priority(230), for: .horizontal)
        resetLabel.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(230), for: .horizontal)
        resetLabel.isHidden = resetLabel.stringValue.isEmpty

        percentageLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        percentageLabel.stringValue = percentageKnown ? "\(self.percentage)%" : self.unknownPlaceholder
        percentageLabel.setContentHuggingPriority(.required, for: .horizontal)
        percentageLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        addSubview(containerStack)
        containerStack.translatesAutoresizingMaskIntoConstraints = false
        trackView.translatesAutoresizingMaskIntoConstraints = false

        let bottomTie = containerStack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2)
        bottomTie.priority = .defaultHigh
        NSLayoutConstraint.activate([
            containerStack.leadingAnchor.constraint(equalTo: leadingAnchor),
            containerStack.trailingAnchor.constraint(equalTo: trailingAnchor),
            containerStack.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            bottomTie,
            topRow.widthAnchor.constraint(equalTo: containerStack.widthAnchor),
            trackView.widthAnchor.constraint(equalTo: containerStack.widthAnchor),
            trackView.heightAnchor.constraint(equalToConstant: 8)
        ])

        applyModelIcon(fallback: icon)
        applyColor()
        updateAccessibility()
    }

    func useComfortableLayout() {
        containerStack.spacing = 5.5
        for constraint in trackView.constraints where constraint.firstAttribute == .height { constraint.constant = 8 }
        trackView.isHidden = false
        resetLabel.isHidden = resetLabel.stringValue.isEmpty
        let minH = heightAnchor.constraint(greaterThanOrEqualToConstant: 52)
        minH.priority = .defaultHigh
        minH.isActive = true
    }
    func useCompactLayout() {
        containerStack.spacing = 4.5
        for constraint in trackView.constraints where constraint.firstAttribute == .height { constraint.constant = 8 }
        trackView.isHidden = false
        resetLabel.isHidden = resetLabel.stringValue.isEmpty
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColor()
        trackView.needsDisplay = true
    }

    private func applyColor() {
        titleLabel.textColor = .labelColor
        if ModelIcons.brands(for:titleLabel.stringValue).isEmpty { iconView.contentTintColor = .secondaryLabelColor }
        trackView.healthyTint = Design.blue
        percentageLabel.textColor = percentageTextColor
        resetLabel.textColor = resetTextColor
        trackView.needsDisplay = true
        needsDisplay = true
    }

    private func updateAccessibility() {
        titleLabel.toolTip = titleLabel.stringValue
        resetLabel.toolTip = resetLabel.stringValue
        var desc = titleLabel.stringValue.isEmpty ? "剩余配额" : titleLabel.stringValue
        desc += percentageKnown ? " 剩余 \(percentage)%" : " \(unknownPlaceholder)"
        if staleData { desc += " · 数据已过期" }
        if !resetLabel.stringValue.isEmpty {
            desc += "，\(resetLabel.stringValue)"
        }
        setAccessibilityElement(true)
        setAccessibilityRole(.progressIndicator)
        setAccessibilityLabel(desc)
        setAccessibilityHelp("显示剩余配额；轨道长度对应剩余百分比。")
        if percentageKnown {
            setAccessibilityValue(NSNumber(value: percentage))
            setAccessibilityMinValue(NSNumber(value: 0))
            setAccessibilityMaxValue(NSNumber(value: 100))
        } else {
            setAccessibilityValue(nil)
        }
        titleLabel.setAccessibilityElement(false)
        percentageLabel.setAccessibilityElement(false)
        resetLabel.setAccessibilityElement(false)
        iconView.setAccessibilityElement(false)
    }

    private func applyModelIcon(fallback:String) {
        let brands=ModelIcons.brands(for:titleLabel.stringValue)
        if let first=brands.first,let image=ModelIcons.image(first) {
            iconView.image=image;iconView.isHidden=false;iconView.contentTintColor=ModelIcons.tintColor(for: image)
            if brands.count>1,let second=ModelIcons.image(brands[1]) { secondaryIconView.image=second;secondaryIconView.isHidden=false;secondaryIconView.contentTintColor=ModelIcons.tintColor(for: second) }
            else { secondaryIconView.isHidden=true }
        } else { iconView.image=fallback.isEmpty ? nil : NSImage(systemSymbolName:fallback,accessibilityDescription:nil);iconView.isHidden=fallback.isEmpty;secondaryIconView.isHidden=true }
    }

    func update(title: String? = nil, percentage: Int?, resetText: String = "", icon: String? = nil, unknownPlaceholder: String? = nil, stale: Bool = false) {
        let nextTitle = title ?? titleLabel.stringValue
        let nextPlaceholder = unknownPlaceholder ?? self.unknownPlaceholder
        let nextPct = max(0, min(100, percentage ?? 0))
        let nextKnown = percentage != nil
        let nextReset = InterfaceText.countdown(resetText)
        let titleChanged = titleLabel.stringValue != nextTitle
        if !titleChanged
            && self.unknownPlaceholder == nextPlaceholder
            && self.percentage == nextPct
            && self.percentageKnown == nextKnown
            && self.staleData == stale
            && resetLabel.stringValue == nextReset
            && icon == nil {
            return
        }
        if titleChanged {
            titleLabel.stringValue = nextTitle
        }
        if self.unknownPlaceholder != nextPlaceholder {
            self.unknownPlaceholder = nextPlaceholder
        }
        if titleChanged || icon != nil {
            if let icon {
                iconView.image = icon.isEmpty ? nil : NSImage(systemSymbolName: icon, accessibilityDescription: nil)
                iconView.isHidden = icon.isEmpty
            }
            applyModelIcon(fallback: icon ?? "sparkles")
        }
        self.percentage = nextPct
        self.percentageKnown = nextKnown
        self.staleData = stale
        trackView.percentage = self.percentage
        trackView.percentageKnown = self.percentageKnown
        trackView.staleData = self.staleData
        let nextPctText = percentageKnown ? "\(self.percentage)%" : self.unknownPlaceholder
        if percentageLabel.stringValue != nextPctText {
            percentageLabel.stringValue = nextPctText
        }
        if resetLabel.stringValue != nextReset {
            resetLabel.stringValue = nextReset
        }
        trackView.isHidden = false
        let shouldHideReset = resetLabel.stringValue.isEmpty
        if resetLabel.isHidden != shouldHideReset {
            resetLabel.isHidden = shouldHideReset
            needsLayout = true
        }
        applyColor()
        updateAccessibility()
        trackView.needsDisplay = true
    }
}

func quotaBar(title: String = "", percentage: Int? = nil, resetText: String = "", icon: String = "sparkles", unknownPlaceholder: String? = nil, stale: Bool = false) -> QuotaBarView {
    QuotaBarView(title: title, percentage: percentage, resetText: resetText, icon: icon, unknownPlaceholder: unknownPlaceholder, stale: stale)
}

/// F12/G02: 图表与表格参考线的自适应低对比色。避免 `separatorColor` 在浅色下解析成白线不可见、
/// 在深色下却偏亮造成深浅不一致。
func designHairline() -> NSColor { designHairline(lightAlpha: 0.09, darkAlpha: 0.05) }
func designHairline(lightAlpha: CGFloat, darkAlpha: CGFloat) -> NSColor {
    NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor.white.withAlphaComponent(darkAlpha)
            : NSColor.black.withAlphaComponent(lightAlpha)
    }
}

// MARK: - UsageTrendChartView (CoreGraphics Bar Chart for Hourly/Daily Token Usage)
final class UsageTrendChartView: NSView {
    static func todayPoints(_ hourly: [[String: Any]]) -> [Point] {
        var hourMap: [String: Int] = [:]
        for h in hourly {
            if let hourStr = h["hour"] as? String, let suffix = hourStr.split(separator: " ").last {
                let t = (h["total_tokens"] as? Int) ?? (h["totalTokens"] as? Int) ?? 0
                hourMap[String(suffix), default: 0] += t
            }
        }
        var pts: [Point] = []
        for hr in 0..<24 {
            let lbl = String(format: "%02d:00", hr)
            pts.append(.init(label: String(format: "%02d时", hr), tokens: hourMap[lbl] ?? 0))
        }
        return pts
    }

    struct Point: Equatable {
        let label: String
        let tokens: Int
    }
    private var revealProgress: CGFloat = 1.0
    private let revealMotion = DesignMotion()
    private let hoverMotion = DesignMotion()
    private var animatedHoverX: CGFloat? = nil
    var onHoverPoint: ((Point?) -> Void)?
    var points: [Point] = [] {
        didSet {
            hoveredIndex = nil
            animatedHoverX = nil
            hoverMotion.cancel()
            let activeSummary = points.filter { $0.tokens > 0 }.prefix(8).map { "\($0.label): \(compactTokens($0.tokens))" }.joined(separator: "，")
            let peak = points.map(\.tokens).max() ?? 0
            let peakText = peak > 0 ? "峰值 \(compactTokens(peak)) Token" : "当前时段无消耗"
            setAccessibilityHelp(activeSummary.isEmpty ? peakText : "\(peakText)；时段明细：\(activeSummary)")
            guard oldValue != points else {
                needsDisplay = true
                return
            }
            startRevealAnimation()
        }
    }
    var subtitle: String = "近期消耗分布" {
        didSet { needsDisplay = true }
    }
    private var hoverTrackingArea: NSTrackingArea?
    private var hoveredIndex: Int? = nil {
        didSet {
            if oldValue != hoveredIndex { needsDisplay = true }
        }
    }

    override init(frame frameRect: NSRect = .zero) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 96).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel("Token 用量趋势柱状图")
    }
    required init?(coder: NSCoder) { fatalError() }
    deinit {
        revealMotion.cancel()
        hoverMotion.cancel()
    }

    private func startRevealAnimation() {
        revealMotion.cancel()
        guard Design.shouldAnimate(in: self), points.contains(where: { $0.tokens > 0 }) else {
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

    func resetHoverState() {
        hoverMotion.cancel()
        animatedHoverX = nil
        if hoveredIndex != nil {
            hoveredIndex = nil
            toolTip = nil
            onHoverPoint?(nil)
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            revealMotion.cancel()
            hoverMotion.cancel()
            revealProgress = 1.0
            resetHoverState()
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTrackingArea { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        hoverTrackingArea = area
        addTrackingArea(area)
    }

    override func mouseMoved(with event: NSEvent) {
        let pt = convert(event.locationInWindow, from: nil)
        guard bounds.contains(pt), !points.isEmpty else {
            resetHoverState()
            return
        }
        let leftPad: CGFloat = axisGutter, rightPad: CGFloat = 6
        let usableWidth = max(40, bounds.width - leftPad - rightPad)
        let slotWidth = usableWidth / CGFloat(points.count)
        let idx = Int(floor((pt.x - leftPad) / slotWidth))
        if points.indices.contains(idx) {
            let targetX = leftPad + (CGFloat(idx) + 0.5) * slotWidth
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
            let item = points[idx]
            toolTip = nil
            onHoverPoint?(item)
        } else {
            resetHoverState()
        }
    }

    override func mouseExited(with event: NSEvent) {
        resetHoverState()
    }

    // F12: 纵轴左侧留白，放 0 / 峰值刻度；数据条整体右移但仍保留原有蓝柱样式与 108pt 高度。
    private let axisGutter: CGFloat = 46

    private func compactTokens(_ value: Int) -> String {
        InterfaceText.formatCompactTokens(value, formatSmallWithLocale: true)
    }

    override func draw(_ dirtyRect: NSRect) {
        let chartBottom: CGFloat = 20
        let chartTop: CGFloat = bounds.height - 6
        let chartHeight = max(20, chartTop - chartBottom)
        let leftPad = axisGutter
        let rightPad: CGFloat = 6
        let usableWidth = max(40, bounds.width - leftPad - rightPad)
        let axisAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: .regular),
            .foregroundColor: Design.secondary
        ]

        // Baseline（保留一条实线基线；无标签虚线已删除）
        let baseLine = NSBezierPath()
        baseLine.move(to: NSPoint(x: leftPad, y: chartBottom))
        baseLine.line(to: NSPoint(x: bounds.width - rightPad, y: chartBottom))
        designHairline(lightAlpha: 0.22, darkAlpha: 0.22).setStroke()
        baseLine.lineWidth = 1
        baseLine.stroke()

        guard !points.isEmpty else {
            let emptyStr = "暂无该时段会话记录" as NSString
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 12),
                .foregroundColor: Design.secondary
            ]
            let sz = emptyStr.size(withAttributes: attrs)
            emptyStr.draw(at: NSPoint(x: (bounds.width - sz.width) / 2, y: (bounds.height - sz.height) / 2), withAttributes: attrs)
            return
        }

        let peakVal = points.map(\.tokens).max() ?? 0
        guard peakVal > 0 else {
            let emptyStr = "当前时段暂无消耗分布" as NSString
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 11.5),
                .foregroundColor: Design.secondary
            ]
            let sz = emptyStr.size(withAttributes: attrs)
            emptyStr.draw(at: NSPoint(x: leftPad + (usableWidth - sz.width) / 2, y: chartBottom + (chartHeight - sz.height) / 2), withAttributes: attrs)
            return
        }
        let maxVal = max(peakVal, 1)

        // F12: 纵轴只保留 0 与峰值两个刻度（峰值带 M/K 单位）；峰值参考线属于“带标注的虚线”，
        // 不再保留原先横穿全图且没有含义说明的中位虚线。
        let peakText = compactTokens(maxVal) as NSString
        let peakSize = peakText.size(withAttributes: axisAttrs)
        peakText.draw(at: NSPoint(x: max(2, leftPad - 8 - peakSize.width), y: chartTop - peakSize.height), withAttributes: axisAttrs)

        let zeroText = "0" as NSString
        let zeroSize = zeroText.size(withAttributes: axisAttrs)
        zeroText.draw(at: NSPoint(x: max(2, leftPad - 8 - zeroSize.width), y: chartBottom - zeroSize.height / 2), withAttributes: axisAttrs)

        let peakLine = NSBezierPath()
        peakLine.move(to: NSPoint(x: leftPad, y: chartTop))
        peakLine.line(to: NSPoint(x: bounds.width - rightPad, y: chartTop))
        peakLine.setLineDash([3, 4], count: 2, phase: 0)
        designHairline().setStroke()
        peakLine.lineWidth = 0.8
        peakLine.stroke()

        let count = points.count
        let slotWidth = usableWidth / CGFloat(count)
        let barWidth = min(22, max(4, slotWidth * 0.62))
        let labelAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: .regular),
            .foregroundColor: Design.secondary
        ]

        // U12: 动态根据可用宽度自适应抽稀刻度，并施加严格的包围盒几何防碰撞，杜绝 20时 与 23时 挤压重叠
        let minLabelGap: CGFloat = 8.0
        let effectiveStep: Int
        if usableWidth < 340 {
            effectiveStep = count > 16 ? 6 : (count > 8 ? 4 : 2)
        } else if usableWidth < 460 {
            effectiveStep = count > 16 ? 4 : (count > 8 ? 2 : 1)
        } else {
            effectiveStep = count > 16 ? 3 : (count > 8 ? 2 : 1)
        }

        var lastDrawnRight: CGFloat = -999.0

        for (idx, pt) in points.enumerated() {
            let cx = leftPad + (CGFloat(idx) + 0.5) * slotWidth
            let isHovered = (hoveredIndex == idx)
            let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua

            // 0 柱位浅灰基槽
            let baseH: CGFloat = 2.5
            let baseRect = NSRect(x: cx - barWidth / 2, y: chartBottom + 1, width: barWidth, height: baseH)
            let basePath = NSBezierPath(roundedRect: baseRect, xRadius: min(1.25, barWidth / 2), yRadius: min(1.25, barWidth / 2))
            NSColor.labelColor.withAlphaComponent(isDark ? 0.12 : 0.08).setFill()
            basePath.fill()

            // 悬停即时跟随微光光标
            if isHovered {
                let cursorCenterX = animatedHoverX ?? cx
                let cursorRect = NSRect(x: cursorCenterX - slotWidth * 0.44, y: chartBottom + 1, width: slotWidth * 0.88, height: chartHeight)
                let cursorPath = NSBezierPath(roundedRect: cursorRect, xRadius: 4, yRadius: 4)
                NSColor.labelColor.withAlphaComponent(isDark ? 0.065 : 0.045).setFill()
                cursorPath.fill()
            }

            if pt.tokens > 0 {
                let ratio = max(0.06, min(1, CGFloat(pt.tokens) / CGFloat(maxVal))) * revealProgress
                let h = chartHeight * ratio
                let r = min(3.0, barWidth / 2)
                let bx = cx - barWidth / 2
                let by = chartBottom + 1
                let bh = max(r, h)

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

            // 刻度文本绘制与防撞逻辑：步长对齐，末尾点仅在空间充裕时绘制
            let isStepMatch = (idx % effectiveStep == 0)
            let isLastPoint = (idx == count - 1)
            let isNearLast = (count - 1 - idx < effectiveStep / 2)

            if isStepMatch && !isNearLast || (isLastPoint && !isStepMatch) {
                let ns = pt.label as NSString
                let sz = ns.size(withAttributes: labelAttrs)
                let drawX = max(2, min(bounds.width - sz.width - 2, cx - sz.width / 2))
                if drawX >= lastDrawnRight + minLabelGap {
                    ns.draw(at: NSPoint(x: drawX, y: 3), withAttributes: labelAttrs)
                    lastDrawnRight = drawX + sz.width
                }
            }
        }

        // 柱体即时跟随数据胶囊
        if let hIdx = hoveredIndex, points.indices.contains(hIdx) {
            let pt = points[hIdx]
            let cx = animatedHoverX ?? (leftPad + (CGFloat(hIdx) + 0.5) * slotWidth)
            let ratio = maxVal > 0 ? max(0.06, min(1, CGFloat(pt.tokens) / CGFloat(maxVal))) : 0
            let barH = pt.tokens > 0 ? chartHeight * ratio : 0
            let capStr = "\(compactTokens(pt.tokens))" as NSString
            let capAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .semibold),
                .foregroundColor: NSColor.white
            ]
            let capSize = capStr.size(withAttributes: capAttrs)
            let capW = capSize.width + 12
            let capH: CGFloat = 18
            let minX = leftPad
            let maxX = max(minX, bounds.width - rightPad - capW)
            let capX = max(minX, min(maxX, cx - capW / 2))
            let capY = min(chartTop - capH, max(chartBottom + barH + 5, chartBottom + 12))
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

// MARK: - ModelDonutChartView (CoreGraphics Multi-Segment Donut Chart for Model Cost Share)
final class ModelDonutChartView: NSView {
    struct Slice {
        let model: String
        let usd: Double
        let tokens: Int
        let color: NSColor
    }
    private var revealProgress: CGFloat = 1.0
    private let revealMotion = DesignMotion()
    private let hoverMotion = DesignMotion()
    private var hoverTrackingArea: NSTrackingArea?
    private var hoveredSliceIndex: Int? = nil
    private var hoverEmphasis: CGFloat = 0.0
    var slices: [Slice] = [] {
        didSet {
            hoveredSliceIndex = nil
            hoverEmphasis = 0.0
            let oldKey = oldValue.map { "\($0.model):\($0.usd):\($0.tokens)" }.joined(separator: "|")
            let newKey = slices.map { "\($0.model):\($0.usd):\($0.tokens)" }.joined(separator: "|")
            guard oldKey != newKey else {
                needsDisplay = true
                return
            }
            startRevealAnimation()
        }
    }
    var totalUsd: Double = 0 {
        didSet { needsDisplay = true }
    }

    override init(frame frameRect: NSRect = .zero) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 104).isActive = true
        heightAnchor.constraint(equalToConstant: 104).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel("模型费用占比环图")
    }
    required init?(coder: NSCoder) { fatalError() }
    deinit {
        revealMotion.cancel()
        hoverMotion.cancel()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTrackingArea { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        hoverTrackingArea = area
        addTrackingArea(area)
    }

    override func mouseMoved(with event: NSEvent) {
        let pt = convert(event.locationInWindow, from: nil)
        let center = NSPoint(x: bounds.midX, y: bounds.midY)
        let radius = min(bounds.width, bounds.height) / 2 - 8.5
        let dx = pt.x - center.x
        let dy = pt.y - center.y
        let dist = hypot(dx, dy)
        let validSlices = slices.filter { $0.usd > 0 }
        let sumUsd = validSlices.reduce(0.0) { $0 + $1.usd }
        guard sumUsd > 0, dist >= radius - 12 && dist <= radius + 12 else {
            clearHoveredSlice()
            return
        }
        // Convert atan2 angle (CCW from +X) into clockwise degrees starting from 90° (top)
        let degCCW = atan2(dy, dx) * 180.0 / .pi
        var cwFromTop = 90.0 - degCCW
        while cwFromTop < 0 { cwFromTop += 360.0 }
        while cwFromTop >= 360.0 { cwFromTop -= 360.0 }

        var accum: CGFloat = 0
        var hitIndex: Int? = nil
        for (idx, slice) in validSlices.enumerated() {
            let sweep = CGFloat(slice.usd / sumUsd) * 360.0
            if cwFromTop >= accum && cwFromTop <= accum + sweep {
                hitIndex = idx
                break
            }
            accum += sweep
        }
        if let hitIndex {
            if hoveredSliceIndex != hitIndex {
                hoveredSliceIndex = hitIndex
                hoverMotion.animate(in: self, from: hoverEmphasis, to: 1.0, curve: .hover) { [weak self] val in
                    self?.hoverEmphasis = val
                    self?.needsDisplay = true
                }
            }
        } else {
            clearHoveredSlice()
        }
    }

    override func mouseExited(with event: NSEvent) {
        clearHoveredSlice()
    }

    private func clearHoveredSlice() {
        guard hoveredSliceIndex != nil else { return }
        hoveredSliceIndex = nil
        hoverMotion.animate(in: self, from: hoverEmphasis, to: 0.0, curve: .hover) { [weak self] val in
            self?.hoverEmphasis = val
            self?.needsDisplay = true
        }
    }

    private func startRevealAnimation() {
        revealMotion.cancel()
        guard Design.shouldAnimate(in: self), slices.contains(where: { $0.usd > 0 }) else {
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

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            revealMotion.cancel()
            hoverMotion.cancel()
            hoveredSliceIndex = nil
            hoverEmphasis = 0.0
            revealProgress = 1.0
            alphaValue = 1.0
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        let center = NSPoint(x: bounds.midX, y: bounds.midY)
        let radius = min(bounds.width, bounds.height) / 2 - 8.5
        let lineWidth: CGFloat = 8.5

        // Background track ring
        let track = NSBezierPath()
        track.appendArc(withCenter: center, radius: radius, startAngle: 0, endAngle: 360)
        track.lineWidth = lineWidth
        Design.track.setStroke()
        track.stroke()

        let sumUsd = slices.reduce(0.0) { $0 + $1.usd }
        let validSlices = slices.filter { $0.usd > 0 }
        let gap: CGFloat = validSlices.count > 1 ? 3.0 : 0.0

        if sumUsd > 0 {
            var startAngle: CGFloat = 90
            for (idx, slice) in validSlices.enumerated() {
                let isSliceHovered = (hoveredSliceIndex == idx)
                let sweep = CGFloat(slice.usd / sumUsd) * 360.0 * revealProgress
                let effectiveSweep = max(2.0 * revealProgress, sweep - gap)
                let endAngle = startAngle - effectiveSweep
                let sliceRadius = isSliceHovered ? (radius + 1.2 * hoverEmphasis) : radius
                let sliceWidth = isSliceHovered ? (lineWidth + 2.2 * hoverEmphasis) : lineWidth
                let arc = NSBezierPath()
                arc.appendArc(withCenter: center, radius: sliceRadius, startAngle: startAngle, endAngle: endAngle, clockwise: true)
                arc.lineWidth = sliceWidth
                arc.lineCapStyle = .butt
                let alpha: CGFloat = (hoveredSliceIndex == nil || isSliceHovered) ? 1.0 : max(0.45, 1.0 - 0.50 * hoverEmphasis)
                slice.color.withAlphaComponent(alpha).setStroke()
                arc.stroke()
                startAngle = endAngle - gap
            }
        }

        // Center text - optically and mathematically centered vertically
        let activeUsd: Double
        let subLabelString: String
        if let hIdx = hoveredSliceIndex, validSlices.indices.contains(hIdx), sumUsd > 0 {
            let hSlice = validSlices[hIdx]
            activeUsd = hSlice.usd
            let pct = Int(round((hSlice.usd / sumUsd) * 100.0))
            subLabelString = "占比 \(pct)%"
        } else {
            activeUsd = totalUsd
            subLabelString = "等效账单"
        }

        let usdText: NSString
        if totalUsd > 0 && totalUsd < 0.001 {
            usdText = "<$0.001" as NSString
        } else if activeUsd > 0 && activeUsd < 0.001 {
            usdText = "<$0.001" as NSString
        } else if activeUsd < 0.01 && activeUsd > 0 {
            usdText = String(format: "$%.3f", activeUsd) as NSString
        } else {
            usdText = String(format: "$%.2f", activeUsd) as NSString
        }
        let mainAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 15, weight: .bold),
            .foregroundColor: NSColor.labelColor
        ]
        let subText = subLabelString as NSString
        let subAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10, weight: .medium),
            .foregroundColor: NSColor.secondaryLabelColor
        ]
        let mSz = usdText.size(withAttributes: mainAttrs)
        let sSz = subText.size(withAttributes: subAttrs)
        let gapBetween: CGFloat = 3.0
        let totalH = mSz.height + gapBetween + sSz.height
        let bottomY = center.y - (totalH / 2)

        subText.draw(at: NSPoint(x: center.x - sSz.width / 2, y: bottomY), withAttributes: subAttrs)
        usdText.draw(at: NSPoint(x: center.x - mSz.width / 2, y: bottomY + sSz.height + gapBetween), withAttributes: mainAttrs)
    }
}

