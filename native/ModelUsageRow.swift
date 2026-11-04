import Cocoa

// A model summary uses two calm lines instead of a nested spreadsheet or quota control.
final class ModelUsageRow: NSView {
    let nameLabel: NSTextField
    let costLabel: NSTextField
    let tokensLabel: NSTextField

    init(name: String, tokens: String, input: String, output: String, requests: Int, cost: String, share: Int, shareText: String? = nil) {
        let isUnpriced = cost == "未计价"
        nameLabel = text(Self.displayName(name), size: 13, weight: .semibold)
        costLabel = text(cost, size: 14, weight: .semibold, color: isUnpriced ? Design.secondary : .labelColor)
        tokensLabel = text("\(tokens) Token", size: 12, weight: .medium)
        super.init(frame: .zero)
        identifier = NSUserInterfaceItemIdentifier("model-usage-row")
        nameLabel.lineBreakMode = .byTruncatingMiddle
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        nameLabel.toolTip = name
        nameLabel.setAccessibilityLabel(Self.displayName(name) + "，模型 ID：" + name)
        tokensLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        costLabel.font = .monospacedDigitSystemFont(ofSize: isUnpriced ? 12.5 : 14, weight: .semibold)
        costLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        let icon = symbol("sparkles", size: 15, color: Design.secondary)
        if let brand = ModelIcons.brands(for: name).first, let image = ModelIcons.image(brand) {
            icon.image = image
            icon.contentTintColor = ModelIcons.tintColor(for: image)
        }
        let iconBox = NSBox()
        iconBox.boxType = .custom
        iconBox.cornerRadius = 7
        iconBox.fillColor = Design.subcard
        iconBox.borderWidth = 0.5
        iconBox.borderColor = Design.border
        iconBox.contentViewMargins = .zero
        iconBox.translatesAutoresizingMaskIntoConstraints = false
        iconBox.addSubview(icon)
        NSLayoutConstraint.activate([
            iconBox.widthAnchor.constraint(equalToConstant: 26),
            iconBox.heightAnchor.constraint(equalToConstant: 26),
            icon.centerXAnchor.constraint(equalTo: iconBox.centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: iconBox.centerYAnchor)
        ])

        let heading = horizontal([iconBox, nameLabel, flexibleSpace(), costLabel], spacing: 9)
        heading.alignment = .centerY
        let resolvedShare = shareText ?? "\(share)%"
        let reqLabel = text("\(requests.formatted()) 次请求", size: 11, color: Design.secondary)
        reqLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        let shareLabel = text("Token 占比 \(resolvedShare)", size: 11, color: Design.secondary)
        shareLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        let metrics = horizontal([
            tokensLabel,
            reqLabel,
            flexibleSpace(),
            shareLabel
        ], spacing: 16)
        tokensLabel.setAccessibilityHelp("输入 \(input) Token，输出 \(output) Token")
        let body = vertical([heading, metrics], spacing: 6)
        addSubview(body)
        pin(body, to: self, inset: 2)
        fillWidth(heading, in: body)
        fillWidth(metrics, in: body)
        setAccessibilityElement(false)
    }

    static func displayName(_ id: String) -> String {
        ModelDisplayName.name(id)
    }

    required init?(coder: NSCoder) { fatalError() }
}
