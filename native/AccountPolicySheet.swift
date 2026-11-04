import Cocoa

/// Keep the field editor and the inactive number on exactly the same text rectangle.
private final class PolicyNumberCell: NSTextFieldCell {
    private func textRect(_ rect: NSRect) -> NSRect {
        let font = font ?? .systemFont(ofSize: 12)
        let height = ceil(font.ascender - font.descender + font.leading)
        return NSRect(x: rect.minX+8, y: rect.midY-height/2, width: max(0, rect.width-16), height: height)
    }
    override func draw(withFrame rect: NSRect, in view: NSView) {
        let focused = (view as? NSTextField)?.currentEditor() != nil
        drawInput(rect, focused: focused)
        guard !focused else { return }
        let style = NSMutableParagraphStyle(); style.alignment = alignment
        (stringValue as NSString).draw(in: textRect(rect), withAttributes: [
            .font: font ?? NSFont.systemFont(ofSize: 12),
            .foregroundColor: NSColor.labelColor, .paragraphStyle: style
        ])
    }
    override func edit(withFrame rect: NSRect, in view: NSView, editor: NSText, delegate: Any?, event: NSEvent?) {
        editor.alignment = alignment
        if let tv = editor as? NSTextView {
            tv.drawsBackground = false
            tv.textContainerInset = .zero
            tv.textContainer?.lineFragmentPadding = 0
        }
        super.edit(withFrame: textRect(rect), in: view, editor: editor, delegate: delegate, event: event)
    }
    override func select(withFrame rect: NSRect, in view: NSView, editor: NSText, delegate: Any?, start: Int, length: Int) {
        editor.alignment = alignment
        if let tv = editor as? NSTextView {
            tv.drawsBackground = false
            tv.textContainerInset = .zero
            tv.textContainer?.lineFragmentPadding = 0
        }
        super.select(withFrame: textRect(rect), in: view, editor: editor, delegate: delegate, start: start, length: length)
    }
}

final class PolicyNumberField: NSTextField {
    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { needsDisplay = true }
        return ok
    }
    override func textDidEndEditing(_ notification: Notification) {
        super.textDidEndEditing(notification)
        needsDisplay = true
    }
}

final class AccountPolicySheet: NSObject {
    unowned let app: Assistant
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 396), styleMask: [.titled], backing: .buffered, defer: false)
    let strategyPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let modelPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let reserve = PolicyNumberField(string: "")
    let candidate = PolicyNumberField(string: "")
    let errorLabel = text("", size: 11.5, color: accessibleDangerColor(), wrap: true)
    let saved: () -> Void
    var onDismiss: (() -> Void)?
    let saveButton = button("保存", target: nil, action: #selector(save))

    init(app: Assistant, config: [String: Any], saved: @escaping () -> Void) {
        self.app = app
        self.saved = saved
        super.init()
        window.title = "智能切换配置"
        window.isReleasedWhenClosed = false

        strategyPopup.addItem(withTitle: "配额充裕优先")
        strategyPopup.lastItem?.representedObject = "priority"
        strategyPopup.addItem(withTitle: "按顺序轮询")
        strategyPopup.lastItem?.representedObject = "round_robin"
        let strat = config["strategy"] as? String ?? "priority"
        strategyPopup.selectItem(at: strat == "round_robin" ? 1 : 0)
        strategyPopup.translatesAutoresizingMaskIntoConstraints = false
        strategyPopup.heightAnchor.constraint(equalToConstant: 28).isActive = true
        strategyPopup.widthAnchor.constraint(equalToConstant: 170).isActive = true
        strategyPopup.setAccessibilityLabel("推荐策略")

        modelPopup.addItem(withTitle: "Gemini")
        modelPopup.lastItem?.representedObject = "gemini"
        modelPopup.addItem(withTitle: "Claude/GPT")
        modelPopup.lastItem?.representedObject = "claude"
        modelPopup.addItem(withTitle: "Gemini 4 Argon")
        modelPopup.lastItem?.representedObject = "argon"
        let monitored = config["monitored_model"] as? String ?? "gemini"
        switch monitored {
        case "claude": modelPopup.selectItem(at: 1)
        case "argon": modelPopup.selectItem(at: 2)
        default: modelPopup.selectItem(at: 0)
        }
        modelPopup.translatesAutoresizingMaskIntoConstraints = false
        modelPopup.heightAnchor.constraint(equalToConstant: 28).isActive = true
        modelPopup.widthAnchor.constraint(equalToConstant: 170).isActive = true
        modelPopup.setAccessibilityLabel("监测模型组")

        reserve.stringValue = "\(intVal(config, "reserve_percentage", fallback: 10))"
        candidate.stringValue = "\(intVal(config, "candidate_min_percentage", fallback: 30))"
        reserve.setAccessibilityLabel("当前账号低于百分比")
        candidate.setAccessibilityLabel("推荐账号至少剩余百分比")
        for field in [reserve, candidate] {
            let value = field.stringValue
            field.cell = PolicyNumberCell(textCell: value)
            field.identifier = NSUserInterfaceItemIdentifier("native-percent-input")
            field.alignment = .center
            field.isEditable = true; field.isSelectable = true
            field.isBezeled = false; field.drawsBackground = false; field.focusRingType = .none
            field.font = .systemFont(ofSize: 12)
            (field.cell as? NSTextFieldCell)?.usesSingleLineMode = true
            field.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                field.widthAnchor.constraint(equalToConstant: 64),
                field.heightAnchor.constraint(equalToConstant: 28)
            ])
        }

        func policyFormRow(title: String, subtitle: String, control: NSView) -> NSView {
            let titleLbl = text(title, size: 12.5, weight: .medium, color: .labelColor)
            let subLbl = text(subtitle, size: 11, color: Design.secondary, wrap: true)
            subLbl.isHidden = subtitle.isEmpty
            let left = vertical([titleLbl, subLbl], spacing: 2)
            left.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            control.setContentHuggingPriority(.required, for: .horizontal)
            control.setContentCompressionResistancePriority(.required, for: .horizontal)
            let row = horizontal([left, flexibleSpace(), control], spacing: 12)
            row.alignment = .centerY
            return row
        }

        func percentControl(_ field: NSTextField) -> NSView {
            let unit = text("%", size: 12, weight: .medium, color: Design.secondary)
            let row = horizontal([field, unit], spacing: 6)
            row.alignment = .centerY
            return row
        }

        let fields = vertical([
            policyFormRow(title: "推荐排序方式", subtitle: "优先推荐 ULTRA / PRO 订阅账号，同等级下按此规则挑选", control: strategyPopup),
            divider(),
            policyFormRow(title: "监测模型范围", subtitle: "", control: modelPopup),
            divider(),
            policyFormRow(title: "触发切换阈值", subtitle: "当前账号剩余配额低于或等于该值时提示切换", control: percentControl(reserve)),
            divider(),
            policyFormRow(title: "候选准入下限", subtitle: "备用账号剩余配额至少达到该值才参与推荐", control: percentControl(candidate))
        ], spacing: 12)
        for fieldRow in fields.arrangedSubviews { fillWidth(fieldRow, in: fields) }

        let cancel = button("取消", target: self, action: #selector(cancel))
        cancel.keyEquivalent = "\u{1b}"
        saveButton.target = self
        saveButton.bezelColor = Design.blue
        saveButton.keyEquivalent = "\r"
        errorLabel.isHidden = true

        let headerBadge = iconBadge("arrow.triangle.2.circlepath", tint: Design.blue, size: 32)
        let titleBlock = vertical([
            text("智能切换配置", size: 16, weight: .semibold, color: .labelColor),
            text("当前账号配额偏低时，自动评估并推荐最佳备用账号", size: 11.5, color: Design.secondary)
        ], spacing: 2)
        let heading = horizontal([headerBadge, titleBlock, flexibleSpace()], spacing: 10)
        heading.alignment = .centerY

        let footer = horizontal([errorLabel, flexibleSpace(), cancel, saveButton], spacing: 8)
        footer.alignment = .centerY

        let root = vertical([heading, group([fields], inset: 16), footer], spacing: 16)
        let surface = SheetVisualEffectView()
        let content = fixedPage(root)
        surface.addSubview(content)
        pin(content, to: surface)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.contentView = surface
        Design.applyControls(surface)
        for popup in [strategyPopup, modelPopup] {
            popup.focusRingType = .none
            popup.cell?.focusRingType = .none
        }
    }

    func show(in parent: NSWindow, onDismiss: @escaping () -> Void) {
        self.onDismiss = onDismiss
        parent.beginSheet(window) { [weak self] _ in self?.onDismiss?() }
    }

    @objc func cancel() {
        window.sheetParent?.endSheet(window)
    }

    @objc func save() {
        guard let low = Int(reserve.stringValue.trimmingCharacters(in: .whitespaces)), (1...98).contains(low) else {
            errorLabel.stringValue = "触发阈值请输入 1–98 之间的整数。"
            errorLabel.isHidden = false
            return
        }
        guard let min = Int(candidate.stringValue.trimmingCharacters(in: .whitespaces)), (2...100).contains(min) else {
            errorLabel.stringValue = "候选下限请输入 2–100 之间的整数。"
            errorLabel.isHidden = false
            return
        }
        guard min > low else {
            errorLabel.stringValue = "候选准入下限必须大于触发切换阈值。"
            errorLabel.isHidden = false
            return
        }
        let strat = strategyPopup.selectedItem?.representedObject as? String ?? "priority"
        let model = modelPopup.selectedItem?.representedObject as? String ?? "gemini"
        saveButton.isEnabled = false
        app.bridge.send([
            "command": "auto_switch_set",
            "config": [
                "reserve_percentage": low,
                "candidate_min_percentage": min,
                "strategy": strat,
                "monitored_model": model
            ]
        ]) { [weak self] response in
            guard let self else { return }
            self.saveButton.isEnabled = true
            switch response {
            case .success:
                self.saved()
                self.cancel()
            case .failure(let error):
                self.errorLabel.stringValue = error.localizedDescription
                self.errorLabel.isHidden = false
            }
        }
    }
}
