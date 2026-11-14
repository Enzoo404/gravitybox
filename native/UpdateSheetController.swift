import Cocoa

final class UpdateSheetController: NSObject, NSWindowDelegate {
    unowned let app: Assistant
    let sheet = SheetWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 292), styleMask: [.titled], backing: .buffered, defer: false)
    let titleLabel = text("GravityBox", size: 16, weight: .bold, color: .labelColor)
    let verPill: PillBadge
    let githubBtn: NSButton
    let statusIconView = symbol("checkmark.seal.fill", size: 13, color: Design.blue)
    let changelogHeading = text("版本说明", size: 12, weight: .semibold, color: .labelColor)
    let changelogTextView = NSTextView()
    let autoUpdateSwitch = DesignSwitch()
    let closeBtn = button("完成", target: nil, action: #selector(closeSheet))
    let primaryBtn = DesignButton(title: "重新检查", target: nil, action: #selector(primaryAction))
    private let trailingFooter = horizontal([], spacing: 8)
    var spinner: NSProgressIndicator { primaryBtn.activitySpinner }

    init(app: Assistant) {
        self.app = app
        let ver = app.updateManager.currentVersion
        self.verPill = pillBadge("v\(ver)", color: Design.blue)
        self.githubBtn = button("GitHub ↗", target: nil, action: #selector(openGitHubReleases))
        super.init()
        githubBtn.target = self
        githubBtn.refusesFirstResponder = true

        primaryBtn.bezelStyle = .rounded
        primaryBtn.isBordered = false
        primaryBtn.font = .systemFont(ofSize: 12, weight: .medium)
        primaryBtn.setAccessibilityLabel("重新检查")

        sheet.delegate = self
        sheet.title = "软件更新"
        sheet.isReleasedWhenClosed = false
        sheet.onCancelOperation = { [weak self] in
            guard let self, self.closeBtn.isEnabled else { return }
            self.closeSheet()
        }
        sheet.isOpaque = false
        sheet.backgroundColor = .clear

        let surface = SheetVisualEffectView()
        sheet.contentView = surface

        let iconBox = NSBox()
        iconBox.boxType = .custom
        iconBox.cornerRadius = 10.5
        iconBox.fillColor = Design.inactivePillFill
        iconBox.borderWidth = 0.75
        iconBox.borderColor = Design.inactivePillBorder
        iconBox.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iconBox.widthAnchor.constraint(equalToConstant: 42),
            iconBox.heightAnchor.constraint(equalToConstant: 42)
        ])
        if let mark = Design.brandMarkImage() {
            let imgView = NSImageView(image: mark)
            imgView.imageScaling = .scaleProportionallyUpOrDown
            imgView.translatesAutoresizingMaskIntoConstraints = false
            iconBox.addSubview(imgView)
            NSLayoutConstraint.activate([
                imgView.widthAnchor.constraint(equalToConstant: 25),
                imgView.heightAnchor.constraint(equalToConstant: 25),
                imgView.centerXAnchor.constraint(equalTo: iconBox.centerXAnchor),
                imgView.centerYAnchor.constraint(equalTo: iconBox.centerYAnchor)
            ])
        }

        let titleRow = horizontal([titleLabel, verPill], spacing: 7)
        titleRow.alignment = .centerY
        let headerRow = horizontal([iconBox, titleRow, flexibleSpace(), githubBtn], spacing: 12)
        headerRow.alignment = .centerY

        statusIconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 12.5, weight: .semibold)
        for c in statusIconView.constraints where c.firstAttribute == .width || c.firstAttribute == .height {
            c.constant = 16
        }
        let notesHeaderRow = horizontal([statusIconView, changelogHeading, flexibleSpace()], spacing: 6)
        notesHeaderRow.alignment = .centerY

        changelogTextView.isEditable = false
        changelogTextView.isSelectable = true
        changelogTextView.drawsBackground = false
        changelogTextView.font = .systemFont(ofSize: 12)
        changelogTextView.textColor = .labelColor
        changelogTextView.textContainerInset = NSSize(width: 0, height: 2)
        changelogTextView.textContainer?.lineFragmentPadding = 0
        changelogTextView.isVerticallyResizable = true
        changelogTextView.isHorizontallyResizable = false
        changelogTextView.autoresizingMask = [.width]
        changelogTextView.textContainer?.widthTracksTextView = true

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.documentView = changelogTextView
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: 112).isActive = true

        let notesDivider = divider()
        let notesStack = vertical([notesHeaderRow, notesDivider, scroll], spacing: 8)
        fillWidth(notesHeaderRow, in: notesStack)
        fillWidth(notesDivider, in: notesStack)
        fillWidth(scroll, in: notesStack)
        let notesCard = group([notesStack], inset: 13)
        notesCard.cornerRadius = Design.Radius.medium

        autoUpdateSwitch.controlSize = .small
        autoUpdateSwitch.state = app.configuration.value.autoUpdateEnabled ? .on : .off
        autoUpdateSwitch.target = self
        autoUpdateSwitch.action = #selector(toggleAutoUpdate)
        autoUpdateSwitch.setAccessibilityLabel("自动更新")

        let autoUpdateLabel = text("自动更新", size: 12.5, weight: .medium, color: .labelColor)
        let autoUpdateHint = text("后台自动预下载新版本", size: 11, color: Design.secondary)
        let autoUpdateLeft = horizontal([autoUpdateSwitch, autoUpdateLabel, autoUpdateHint], spacing: 6)
        autoUpdateLeft.alignment = .centerY

        closeBtn.target = self
        closeBtn.keyEquivalent = "\r"
        closeBtn.bezelColor = Design.blue
        primaryBtn.target = self
        primaryBtn.bezelColor = Design.blue
        primaryBtn.keyEquivalent = "\r"

        trailingFooter.alignment = .centerY
        trailingFooter.addArrangedSubview(primaryBtn)
        trailingFooter.addArrangedSubview(closeBtn)
        let footerRow = horizontal([autoUpdateLeft, flexibleSpace(), trailingFooter], spacing: 8)
        footerRow.alignment = .centerY

        let root = vertical([
            headerRow,
            notesCard,
            divider(),
            footerRow
        ], spacing: 12)
        for child in root.arrangedSubviews { fillWidth(child, in: root) }

        let content = fixedPage(root)
        surface.addSubview(content)
        pin(content, to: surface)
        Design.applyControls(surface)

        app.updateManager.onStateChanged = { [weak self] in
            self?.renderState()
        }
        renderState()
    }

    private func setNotesContent(_ content: String) {
        changelogTextView.string = content
        guard let storage = changelogTextView.textStorage else { return }
        let fullRange = NSRange(location: 0, length: storage.length)
        guard fullRange.length > 0 else { return }
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 4.0
        paragraph.paragraphSpacing = 5.0
        storage.setAttributes([
            .font: NSFont.systemFont(ofSize: 12, weight: .regular),
            .foregroundColor: Design.primary.withAlphaComponent(0.88),
            .paragraphStyle: paragraph
        ], range: fullRange)
    }

    private func setStatusIcon(_ symbolName: String, tint: NSColor) {
        statusIconView.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)
        statusIconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 12.5, weight: .semibold)
        statusIconView.contentTintColor = tint
    }

    func show(in parent: NSWindow) {
        app.updateManager.validateCachedDMGState()
        autoUpdateSwitch.state = app.configuration.value.autoUpdateEnabled ? .on : .off
        renderState()
        if sheet.sheetParent == nil {
            parent.beginSheet(sheet)
        }
        sheet.makeFirstResponder(nil)
        if case .idle = app.updateManager.state {
            app.updateManager.checkForUpdates(silent: false)
        } else if case .upToDate = app.updateManager.state {
            app.updateManager.checkForUpdates(silent: false)
        } else if case .failed = app.updateManager.state {
            app.updateManager.checkForUpdates(silent: false)
        }
    }

    private func setFooterActionPrimaryRight(_ primaryIsRight: Bool) {
        let desired: [NSView] = primaryIsRight ? [closeBtn, primaryBtn] : [primaryBtn, closeBtn]
        if trailingFooter.arrangedSubviews.count != desired.count
            || !zip(trailingFooter.arrangedSubviews, desired).allSatisfy({ $0 === $1 }) {
            trailingFooter.arrangedSubviews.forEach { trailingFooter.removeArrangedSubview($0) }
            for v in desired { trailingFooter.addArrangedSubview(v) }
        }
        if primaryIsRight {
            primaryBtn.bezelColor = Design.blue
            primaryBtn.keyEquivalent = "\r"
            closeBtn.bezelColor = nil
            closeBtn.keyEquivalent = "\u{1b}"
        } else {
            primaryBtn.bezelColor = nil
            primaryBtn.keyEquivalent = ""
            closeBtn.bezelColor = Design.blue
            closeBtn.keyEquivalent = "\r"
        }
    }

    func renderState() {
        let ver = app.updateManager.currentVersion
        let buildStr = app.updateManager.currentBuildDisplay
        verPill.title = "v\(ver)"
        switch app.updateManager.state {
        case .idle, .checking:
            setStatusIcon("arrow.triangle.2.circlepath", tint: Design.blue)
            changelogHeading.stringValue = "版本说明"
            setNotesContent("• 当前运行版本：GravityBox v\(ver)（构建 \(buildStr)）\n• 正在同步 GitHub Release 最新版本信息，请稍候…")
            closeBtn.title = "完成"
            closeBtn.isEnabled = true
            primaryBtn.title = "检查中…"
            primaryBtn.showsSpinner = true
            primaryBtn.isEnabled = false
            setFooterActionPrimaryRight(false)
        case .upToDate:
            setStatusIcon("checkmark.seal.fill", tint: .systemGreen)
            changelogHeading.stringValue = "当前版本状态"
            setNotesContent("• 当前运行版本 GravityBox v\(ver)（构建 \(buildStr)）已是最新发布版本。\n• 开启下方「自动更新」后，后台将自动检测新版本并预下载更新包。")
            closeBtn.title = "完成"
            closeBtn.isEnabled = true
            primaryBtn.title = "重新检查"
            primaryBtn.showsSpinner = false
            primaryBtn.isEnabled = true
            setFooterActionPrimaryRight(false)
        case .updateAvailable(let release):
            setStatusIcon("sparkles", tint: Design.blue)
            changelogHeading.stringValue = "\(release.tagName) 更新日志"
            setNotesContent(AppUpdateManager.formatReleaseNotes(release.changelog))
            closeBtn.title = "稍后"
            closeBtn.isEnabled = true
            primaryBtn.title = "立即更新"
            primaryBtn.showsSpinner = false
            primaryBtn.isEnabled = true
            setFooterActionPrimaryRight(true)
        case .downloading(let release):
            setStatusIcon("arrow.down.circle.fill", tint: Design.blue)
            changelogHeading.stringValue = "\(release.tagName) 更新日志"
            setNotesContent(AppUpdateManager.formatReleaseNotes(release.changelog))
            closeBtn.title = "后台下载"
            closeBtn.isEnabled = true
            primaryBtn.title = "取消下载"
            primaryBtn.showsSpinner = true
            primaryBtn.isEnabled = true
            setFooterActionPrimaryRight(true)
        case .readyToInstall(let release, _):
            setStatusIcon("checkmark.shield.fill", tint: .systemGreen)
            changelogHeading.stringValue = "\(release.tagName) 更新日志"
            setNotesContent(AppUpdateManager.formatReleaseNotes(release.changelog))
            closeBtn.title = "稍后"
            closeBtn.isEnabled = true
            primaryBtn.title = "立即更新"
            primaryBtn.showsSpinner = false
            primaryBtn.isEnabled = true
            setFooterActionPrimaryRight(true)
        case .installing(let release):
            setStatusIcon("gearshape.2.fill", tint: Design.blue)
            changelogHeading.stringValue = "\(release.tagName) 更新日志"
            setNotesContent(AppUpdateManager.formatReleaseNotes(release.changelog))
            closeBtn.title = "稍后"
            closeBtn.isEnabled = false
            primaryBtn.title = "正在安装…"
            primaryBtn.showsSpinner = true
            primaryBtn.isEnabled = false
            setFooterActionPrimaryRight(true)
        case .failed(let message):
            setStatusIcon("exclamationmark.triangle.fill", tint: accessibleWarningColor())
            changelogHeading.stringValue = "检查结果"
            setNotesContent("• 未能完成在线更新：\(message)\n• 您可以点击右上角「GitHub ↗」直接查看或下载最新 Release 安装包。")
            closeBtn.title = "完成"
            closeBtn.isEnabled = true
            primaryBtn.title = "重试"
            primaryBtn.showsSpinner = false
            primaryBtn.isEnabled = true
            setFooterActionPrimaryRight(false)
        }
        primaryBtn.setAccessibilityLabel(primaryBtn.title)
    }

    @objc func toggleAutoUpdate() {
        let previous = app.configuration.value.autoUpdateEnabled
        let next = autoUpdateSwitch.state == .on
        app.configuration.value.autoUpdateEnabled = next
        do {
            try app.configuration.save()
            app.configureAutoUpdateTimer()
            app.syncUpdatePromptControls()
            app.aboutPage?.syncAutoUpdateSwitch()
            if next {
                if let release = app.updateManager.availableRelease {
                    if !app.updateManager.hasDownloadedUpdateReady {
                        app.updateManager.preDownloadRelease(release, silent: true)
                    }
                } else {
                    app.updateManager.checkForUpdates(silent: true)
                }
            }
        } catch {
            app.configuration.value.autoUpdateEnabled = previous
            autoUpdateSwitch.state = previous ? .on : .off
            app.showMessage(error.localizedDescription, error: true)
        }
    }

    @objc func primaryAction() {
        switch app.updateManager.state {
        case .updateAvailable(let release), .readyToInstall(let release, _):
            app.updateManager.installRelease(release)
        case .upToDate, .failed, .idle:
            app.updateManager.checkForUpdates(silent: false)
        case .downloading:
            app.updateManager.cancelDownload()
        case .checking, .installing:
            break
        }
    }

    @objc func openGitHubReleases() {
        if let release = app.updateManager.availableRelease {
            NSWorkspace.shared.open(release.htmlURL)
        } else {
            NSWorkspace.shared.open(AppUpdateManager.releasesPageURL)
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard closeBtn.isEnabled else { return false }
        closeSheet()
        return false
    }

    @objc func closeSheet() {
        sheet.sheetParent?.endSheet(sheet)
    }
}
