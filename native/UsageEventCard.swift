import Cocoa

final class UsageEventCard: NSView {
    let modelLabel = text("", size: 12, weight: .semibold)
    let timeLabel = text("", size: 10.5, color: Design.secondary)
    let inputLabel = text("", size: 11, weight: .medium)
    let outputLabel = text("", size: 11, weight: .medium)
    let cacheWriteLabel = text("", size: 11, weight: .medium)
    let cacheLabel = text("", size: 11, weight: .medium)
    let modelIcon = symbol("sparkles", size: 16, color: Design.secondary)
    private let card = DesignCardBox()
    private var hoverTracking: NSTrackingArea?
    private let hoverMotion = DesignMotion()
    private var hoverProgress: CGFloat = 0
    private var hovered = false {
        didSet {
            guard oldValue != hovered else { return }
            let target: CGFloat = hovered ? 1.0 : 0.0
            hoverMotion.animate(in: self, from: hoverProgress, to: target, curve: .hover) { [weak self] val in
                guard let self else { return }
                self.hoverProgress = val
                self.card.borderColor = val > 0.01 ? Design.primary.withAlphaComponent(0.085 + 0.105 * val) : Design.border
                self.card.needsDisplay = true
            }
        }
    }
    private static let dateFormat: DateFormatter = { let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN"); f.dateFormat = "yyyy-MM-dd HH:mm:ss"; return f }()
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        identifier = NSUserInterfaceItemIdentifier("usage-event-card")
        modelLabel.lineBreakMode = .byTruncatingMiddle
        modelLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        modelLabel.setContentCompressionResistancePriority(.required, for: .vertical)
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
        timeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        timeLabel.setContentCompressionResistancePriority(.required, for: .vertical)
        func metric(_ title: String, _ value: NSTextField) -> NSView {
            let titleLbl = text(title, size: 11, color: Design.secondary)
            titleLbl.setContentCompressionResistancePriority(.required, for: .vertical)
            value.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
            value.setContentCompressionResistancePriority(.required, for: .vertical)
            let row = horizontal([titleLbl, value, flexibleSpace()], spacing: 5)
            row.alignment = .centerY
            return row
        }
        let heading = horizontal([modelIcon, modelLabel, flexibleSpace(), timeLabel], spacing: 8)
        heading.alignment = .centerY
        let tokens = horizontal([metric("输入", inputLabel), metric("输出", outputLabel), metric("缓存读取", cacheLabel), metric("缓存写入", cacheWriteLabel)], spacing: 10)
        tokens.distribution = .fillEqually
        tokens.alignment = .centerY
        let body = vertical([heading, tokens], spacing: 7)
        fillWidth(heading, in: body)
        fillWidth(tokens, in: body)
        card.boxType = .custom
        card.cornerRadius = 10
        card.borderWidth = 0.5
        card.borderColor = Design.border
        card.fillColor = Design.card
        card.shadow = Design.cardShadow()
        card.contentViewMargins = .zero
        card.addSubview(body)
        body.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            body.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 14),
            body.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
            body.centerYAnchor.constraint(equalTo: card.centerYAnchor),
            body.topAnchor.constraint(greaterThanOrEqualTo: card.topAnchor, constant: 9),
            body.bottomAnchor.constraint(lessThanOrEqualTo: card.bottomAnchor, constant: -9)
        ])
        addSubview(card)
        pin(card, to: self, inset: 1)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }
    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }
    override func prepareForReuse() {
        super.prepareForReuse()
        hovered = false
    }
    func configure(_ event: [String:Any], highlight: String = "") {
        let rawModel = event["model"] as? String ?? "未知模型"
        let model = rawModel
        if !highlight.isEmpty, let range = model.range(of: highlight, options: .caseInsensitive) {
            let attr = NSMutableAttributedString(string: model, attributes: [
                .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
                .foregroundColor: Design.primary
            ])
            let nsRange = NSRange(range, in: model)
            attr.addAttributes([
                .foregroundColor: Design.blue,
                .underlineStyle: NSUnderlineStyle.single.rawValue
            ], range: nsRange)
            modelLabel.attributedStringValue = attr
        } else {
            modelLabel.attributedStringValue = NSAttributedString(string: model, attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: NSColor.labelColor])
        }
        modelLabel.setAccessibilityLabel(model)
        enableTextCopy(modelLabel, value: rawModel, title: "复制模型 ID")
        let stamp = doubleVal(event,"timestamp_seconds")
        timeLabel.stringValue = stamp > 0 ? Self.dateFormat.string(from:Date(timeIntervalSince1970:stamp)) : "时间未知"
        inputLabel.stringValue = intVal(event,"input_tokens").formatted(); outputLabel.stringValue = intVal(event,"output_tokens").formatted(); cacheLabel.stringValue = intVal(event,"cached_tokens").formatted();cacheWriteLabel.stringValue = intVal(event,"cache_write_tokens").formatted()
        if let brand = ModelIcons.brands(for:model).first,let image = ModelIcons.image(brand) { modelIcon.image = image; modelIcon.contentTintColor = ModelIcons.tintColor(for: image) }
        else { modelIcon.image = NSImage(systemSymbolName:"sparkles",accessibilityDescription:nil); modelIcon.contentTintColor = Design.secondary }
    }
}
