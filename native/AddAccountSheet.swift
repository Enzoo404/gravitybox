import Cocoa

final class AddAccountSheet: NSObject {
    static let sheetWidth: CGFloat = 460
    static let collapsedHeight: CGFloat = 294
    static let expandedHeight: CGFloat = 338

    unowned let app: Assistant
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: AddAccountSheet.sheetWidth, height: AddAccountSheet.collapsedHeight),
        styleMask: [.titled],
        backing: .buffered,
        defer: false
    )
    let status = text("", size: 12, color: Design.secondary, wrap: true)
    let spinner = NSProgressIndicator()
    let currentButton = button("保存当前账号", target: nil, action: #selector(saveCurrent))
    let googleButton = button("Google 授权登录…", target: nil, action: #selector(signIn))
    let cancelButton = button("取消", target: nil, action: #selector(cancel))
    private var feedback: NSStackView!
    var sessionID: String?
    var pollTimer: Timer?
    var requestInFlight = false
    var closing = false
    var saved: () -> Void
    var onDismiss: (() -> Void)?

    init(app: Assistant, saved: @escaping () -> Void) {
        self.app = app
        self.saved = saved
        super.init()
        window.title = "添加账号"
        window.isReleasedWhenClosed = false
        currentButton.target = self
        googleButton.target = self
        // F06: 只保留一个实心主按钮（Google 授权登录）；“保存当前账号”降级为描边次级按钮，
        // 并把初始键盘焦点与默认 Enter 都交给主按钮，避免两个“主按钮”竞争。
        let currentEmail = app.statusValue.liveAccountEmail.isEmpty ? app.statusValue.activeAccountEmail : app.statusValue.liveAccountEmail
        currentButton.title = "保存当前账号"
        currentButton.isEnabled = true
        currentButton.toolTip = currentEmail
        currentButton.bezelColor = nil
        googleButton.bezelColor = Design.blue
        googleButton.keyEquivalent = "\r"
        window.initialFirstResponder = googleButton
        cancelButton.target = self
        cancelButton.keyEquivalent = "\u{1b}"
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.isHidden = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            spinner.widthAnchor.constraint(equalToConstant: 16),
            spinner.heightAnchor.constraint(equalToConstant: 16)
        ])

        func choice(_ icon: String, _ title: String, _ subtitle: String, _ action: NSButton) -> NSView {
            let titleLbl = text(title, size: 13, weight: .semibold, color: .labelColor)
            let subLbl = text(subtitle, size: 11, color: Design.secondary, wrap: true)
            subLbl.setContentHuggingPriority(.defaultLow, for: .horizontal)
            var textViews: [NSView] = [titleLbl, subLbl]
            if action === currentButton, !currentEmail.isEmpty {
                let emailLbl = text(currentEmail, size: 10.5, color: .secondaryLabelColor)
                emailLbl.font = .systemFont(ofSize: 11.5, weight: .regular)
                emailLbl.lineBreakMode = .byTruncatingMiddle
                emailLbl.toolTip = currentEmail
                emailLbl.setContentHuggingPriority(.defaultLow, for: .horizontal)
                emailLbl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
                textViews.append(emailLbl)
            }
            let textCol = vertical(textViews, spacing: 2.5)
            textCol.alignment = .leading
            textCol.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
            textCol.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            for v in textViews {
                v.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
                fillWidth(v, in: textCol)
            }
            action.setContentHuggingPriority(.required, for: .horizontal)
            action.setContentCompressionResistancePriority(.required, for: .horizontal)
            let badge = iconBadge(icon, tint: Design.blue, size: 30)
            let row = horizontal([badge, textCol, action], spacing: 12)
            row.alignment = .centerY
            return group([row], inset: 14)
        }

        feedback = horizontal([spinner, status], spacing: 8)
        feedback.isHidden = true
        let headerBadge = iconBadge("person.badge.plus", tint: Design.blue, size: 32)
        let headerTitle = vertical([
            text("添加账号", size: 16, weight: .semibold, color: .labelColor),
            text("支持直接导入当前登录的 Antigravity 账号，或通过浏览器添加备用账号", size: 11.5, color: Design.secondary)
        ], spacing: 2)
        let headerRow = horizontal([headerBadge, headerTitle, flexibleSpace()], spacing: 10)
        headerRow.alignment = .centerY
        let root = vertical([
            headerRow,
            choice("person.crop.rectangle", "保存当前账号", "读取本机已登录的账号", currentButton),
            choice("globe", "Google 授权登录", "在浏览器中完成授权，凭据仅保存在本机", googleButton),
            feedback,
            horizontal([flexibleSpace(), cancelButton])
        ], spacing: 12)
        let surface = SheetVisualEffectView()
        let content = fixedPage(root)
        surface.addSubview(content)
        pin(content, to: surface)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.contentView = surface
        Design.applyControls(surface)
        window.setContentSize(NSSize(width: Self.sheetWidth, height: Self.collapsedHeight))
    }

    deinit {
        pollTimer?.invalidate()
    }

    func show(in parent: NSWindow, onDismiss: @escaping () -> Void) {
        self.onDismiss = onDismiss
        parent.beginSheet(window) { [weak self] _ in
            self?.pollTimer?.invalidate()
            self?.onDismiss?()
        }
        // F06: Sheet 成为 key 后再锁定一次初始焦点，避免 AppKit 按视图顺序落到次级按钮。
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window.sheetParent != nil else { return }
            self.window.makeFirstResponder(self.googleButton)
        }
    }

    func busy(_ value: Bool) {
        feedback.isHidden = status.stringValue.isEmpty
        window.setContentSize(NSSize(width: Self.sheetWidth, height: feedback.isHidden ? Self.collapsedHeight : Self.expandedHeight))
        currentButton.isEnabled = !value
        googleButton.isEnabled = !value
        spinner.isHidden = !value
        if value {
            spinner.startAnimation(nil)
        } else {
            spinner.stopAnimation(nil)
        }
    }

    func fail(_ message: String) {
        status.stringValue = message
        status.textColor = accessibleDangerColor()
        busy(false)
        cancelButton.isEnabled = true
    }

    @objc func saveCurrent() {
        status.stringValue = "正在读取当前账号…"
        status.textColor = Design.secondary
        busy(true)
        cancelButton.isEnabled = false
        app.bridge.send(["command": "account_save_current"]) { [weak self] response in
            guard let self else { return }
            switch response {
            case .success:
                self.saved()
                self.dismiss()
            case .failure(let error):
                self.fail(error.localizedDescription)
            }
        }
    }

    @objc func signIn() {
        status.stringValue = "正在打开 Google 授权…"
        status.textColor = Design.secondary
        busy(true)
        requestInFlight = true
        cancelButton.isEnabled = false
        app.bridge.send(["command": "account_oauth_begin"]) { [weak self] response in
            guard let self else { return }
            self.requestInFlight = false
            self.cancelButton.isEnabled = true
            switch response {
            case .failure(let error):
                self.fail(error.localizedDescription)
            case .success(let value):
                guard let id = value["id"] as? String,
                      let link = value["url"] as? String,
                      let url = URL(string: link),
                      url.scheme == "https",
                      url.host == "accounts.google.com",
                      url.path == "/o/oauth2/v2/auth" else {
                    self.fail("授权地址无效，请重试。")
                    return
                }
                self.sessionID = id
                #if !NATIVE_UI_TEST
                guard NSWorkspace.shared.open(url) else {
                    self.app.bridge.send(["command": "account_oauth_cancel", "id": id]) { _ in }
                    self.fail("无法打开浏览器，请重试。")
                    return
                }
                #endif
                self.status.stringValue = "请在浏览器中完成 Google 授权。"
                self.pollTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                    self?.checkLogin()
                }
            }
        }
    }

    func checkLogin() {
        guard let id = sessionID, !requestInFlight, !closing else { return }
        requestInFlight = true
        app.bridge.send(["command": "account_oauth_status", "id": id]) { [weak self] response in
            guard let self else { return }
            self.requestInFlight = false
            switch response {
            case .failure(let error):
                self.pollTimer?.invalidate()
                self.fail(error.localizedDescription)
            case .success(let value):
                let phase = value["phase"] as? String ?? "failed"
                self.cancelButton.isEnabled = phase != "saving"
                if phase == "succeeded" {
                    self.pollTimer?.invalidate()
                    self.saved()
                    self.dismiss()
                } else if ["failed", "cancelled", "expired"].contains(phase) {
                    self.pollTimer?.invalidate()
                    self.fail(value["message"] as? String ?? "授权未完成，请重试。")
                } else if phase == "saving" {
                    self.status.stringValue = "正在保存账号…"
                }
            }
        }
    }

    @objc func cancel() {
        guard cancelButton.isEnabled, !closing else { return }
        guard let id = sessionID else {
            dismiss()
            return
        }
        closing = true
        cancelButton.isEnabled = false
        app.bridge.send(["command": "account_oauth_cancel", "id": id]) { [weak self] response in
            guard let self else { return }
            self.closing = false
            switch response {
            case .failure:
                self.fail("无法取消授权，请重试。")
            case .success(let value):
                if value["phase"] as? String == "saving" { return }
                self.dismiss()
            }
        }
    }

    func dismiss() {
        pollTimer?.invalidate()
        window.sheetParent?.endSheet(window)
    }
}
