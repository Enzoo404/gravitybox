import Cocoa

final class AboutPage: NSObject {
    unowned let app: Assistant
    var view: NSView!

    let versionPill: PillBadge
    let envPill = pillBadge("macOS · arm64", color: Design.inactivePill)
    let checkUpdateBtn: InlineRefreshButton
    let installNowBtn = button("立即更新", target: nil, action: #selector(installAvailableUpdate))
    let cancelDownloadBtn = button("取消下载", target: nil, action: #selector(cancelActiveDownload))
    let releaseNotesBtn = button("更新日志…", target: nil, action: #selector(openUpdateSheet))
    let updateStatusIcon = symbol("checkmark.seal.fill", size: 14, color: Design.secondary)
    let updateStatusLabel = text("点击右上角「检查更新」获取最新版本", size: 12.5, weight: .medium, color: .labelColor)
    let updateMetaLabel = text("", size: 11.5, color: Design.secondary)
    let autoUpdateSwitch = DesignSwitch()
    let versionSpecLabel = text("", size: 12.5, weight: .medium, color: .labelColor)
    let osSpecLabel = text("", size: 12.5, weight: .medium, color: .labelColor)
    let revealDataBtn = button("在访达中显示", target: nil, action: #selector(revealDataFolder))
    let githubReleasesBtn = button("GitHub ↗", target: nil, action: #selector(openReleasesPage))
    private let heroActions = horizontal([], spacing: 8)

    init(app: Assistant) {
        self.app = app
        let ver = app.updateManager.currentVersion
        self.versionPill = pillBadge("v\(ver)", color: Design.blue)
        self.checkUpdateBtn = InlineRefreshButton("检查更新", width: 92, target: nil, action: #selector(checkForUpdates))
        super.init()

        checkUpdateBtn.target = self
        installNowBtn.target = self
        installNowBtn.bezelColor = Design.blue
        cancelDownloadBtn.target = self
        releaseNotesBtn.target = self
        revealDataBtn.target = self
        revealDataBtn.controlSize = .small
        githubReleasesBtn.target = self
        githubReleasesBtn.controlSize = .small

        // 1. Hero & Update Card
        let iconBox = NSBox()
        iconBox.boxType = .custom
        iconBox.cornerRadius = 12
        iconBox.fillColor = Design.inactivePillFill
        iconBox.borderWidth = 0.75
        iconBox.borderColor = Design.inactivePillBorder
        iconBox.contentViewMargins = .zero
        iconBox.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iconBox.widthAnchor.constraint(equalToConstant: 48),
            iconBox.heightAnchor.constraint(equalToConstant: 48)
        ])
        iconBox.setAccessibilityElement(false)
        if let mark = Design.brandMarkImage() ?? Design.appIconImage() {
            let imgView = NSImageView(image: mark)
            imgView.imageScaling = .scaleProportionallyUpOrDown
            imgView.translatesAutoresizingMaskIntoConstraints = false
            iconBox.addSubview(imgView)
            NSLayoutConstraint.activate([
                imgView.widthAnchor.constraint(equalToConstant: 30),
                imgView.heightAnchor.constraint(equalToConstant: 30),
                imgView.centerXAnchor.constraint(equalTo: iconBox.centerXAnchor),
                imgView.centerYAnchor.constraint(equalTo: iconBox.centerYAnchor)
            ])
        }

        let appName = text("GravityBox", size: 18, weight: .bold, color: .labelColor)
        let titleLine = horizontal([appName, versionPill, envPill], spacing: 7)
        titleLine.alignment = .centerY
        versionPill.setContentCompressionResistancePriority(.required, for: .horizontal)
        envPill.setContentCompressionResistancePriority(.required, for: .horizontal)

        let tagline = text("原生 Antigravity 账号配额与双语工作台", size: 11.5, color: Design.secondary)
        tagline.lineBreakMode = .byTruncatingTail
        let brandCol = vertical([titleLine, tagline], spacing: 3)
        brandCol.alignment = .leading
        brandCol.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        heroActions.alignment = .centerY
        heroActions.detachesHiddenViews = true
        heroActions.addArrangedSubview(releaseNotesBtn)
        heroActions.addArrangedSubview(checkUpdateBtn)
        heroActions.addArrangedSubview(installNowBtn)
        heroActions.addArrangedSubview(cancelDownloadBtn)

        let heroTop = horizontal([iconBox, brandCol, flexibleSpace(), heroActions], spacing: 12)
        heroTop.alignment = .centerY

        updateStatusIcon.translatesAutoresizingMaskIntoConstraints = false
        updateStatusIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13.5, weight: .semibold)
        updateStatusLabel.lineBreakMode = .byTruncatingTail
        updateStatusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        updateMetaLabel.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .regular)
        updateMetaLabel.setContentHuggingPriority(.required, for: .horizontal)
        updateMetaLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        let statusRow = horizontal([updateStatusIcon, updateStatusLabel, flexibleSpace(), updateMetaLabel], spacing: 8)
        statusRow.alignment = .centerY

        autoUpdateSwitch.controlSize = .small
        autoUpdateSwitch.state = app.configuration.value.autoUpdateEnabled ? .on : .off
        autoUpdateSwitch.target = self
        autoUpdateSwitch.action = #selector(toggleAutoUpdate)
        autoUpdateSwitch.setAccessibilityLabel("自动检查并预下载更新")
        let autoTitle = text("自动检查并预下载更新", size: 13, weight: .semibold, color: .labelColor)
        let autoSub = text("开启后将在后台定期检查 GitHub Release 新版本并预下载安装包", size: 11, color: Design.secondary)
        autoSub.lineBreakMode = .byTruncatingTail
        let autoCaptions = vertical([autoTitle, autoSub], spacing: 2)
        autoCaptions.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let autoRow = horizontal([autoCaptions, flexibleSpace(), autoUpdateSwitch], spacing: 12)
        autoRow.alignment = .centerY

        let heroInner = vertical([heroTop, divider(), statusRow, divider(), autoRow], spacing: 11)
        for child in heroInner.arrangedSubviews { fillWidth(child, in: heroInner) }
        let heroCard = group([heroInner], inset: 14)
        heroCard.cornerRadius = 14

        // 2. System & Runtime Specs Card (Apple System Settings About style)
        let buildDisplay = resolvedBuildSummary()
        versionSpecLabel.stringValue = buildDisplay.isEmpty ? "v\(ver)" : "v\(ver)（Build \(buildDisplay)）"
        versionSpecLabel.font = .monospacedDigitSystemFont(ofSize: 12.5, weight: .medium)
        enableTextCopy(versionSpecLabel, title: "复制版本信息")

        let osVer = ProcessInfo.processInfo.operatingSystemVersion
        let osStr = osVer.patchVersion > 0
            ? "macOS \(osVer.majorVersion).\(osVer.minorVersion).\(osVer.patchVersion)"
            : "macOS \(osVer.majorVersion).\(osVer.minorVersion)"
        osSpecLabel.stringValue = "\(osStr) · Apple Silicon (arm64)"
        osSpecLabel.font = .monospacedDigitSystemFont(ofSize: 12.5, weight: .medium)

        let targetSpecLabel = text("Antigravity 正式版（com.google.antigravity）", size: 12.5, weight: .medium, color: .labelColor)
        targetSpecLabel.lineBreakMode = .byTruncatingMiddle

        let displayStatePath = app.state.path.replacingOccurrences(
            of: FileManager.default.homeDirectoryForCurrentUser.path,
            with: "~"
        )
        let dataPathLabel = text(displayStatePath, size: 12, weight: .regular, color: Design.secondary)
        dataPathLabel.lineBreakMode = .byTruncatingMiddle
        dataPathLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        enableTextCopy(dataPathLabel, value: app.state.path, title: "复制目录路径")

        func specRow(_ key: String, right: NSView) -> NSView {
            let keyLbl = text(key, size: 12.5, weight: .regular, color: Design.secondary)
            keyLbl.setContentHuggingPriority(.required, for: .horizontal)
            keyLbl.setContentCompressionResistancePriority(.required, for: .horizontal)
            let row = horizontal([keyLbl, flexibleSpace(), right], spacing: 12)
            row.alignment = .centerY
            return row
        }

        let dataRight = horizontal([dataPathLabel, revealDataBtn], spacing: 8)
        dataRight.alignment = .centerY
        dataRight.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let specsInner = vertical([
            specRow("应用版本", right: versionSpecLabel),
            divider(),
            specRow("系统环境", right: osSpecLabel),
            divider(),
            specRow("目标应用", right: targetSpecLabel),
            divider(),
            specRow("数据目录", right: dataRight)
        ], spacing: 9.5)
        for child in specsInner.arrangedSubviews { fillWidth(child, in: specsInner) }
        let specsCard = group([specsInner], inset: 14)
        specsCard.cornerRadius = 14

        // 3. Project & Privacy Principles Card
        let localOnlyPill = pillBadge("仅本机运行 · 零遥测", color: Design.inactivePill)
        localOnlyPill.setContentHuggingPriority(.required, for: .horizontal)
        localOnlyPill.setContentCompressionResistancePriority(.required, for: .horizontal)

        let projectInner = vertical([
            settingRow(
                icon: "shippingbox",
                tint: Design.blue,
                title: "GitHub Releases",
                subtitle: "查看历史发行版本、更新日志与 SHA-256 校验说明",
                control: githubReleasesBtn
            ),
            divider(),
            settingRow(
                icon: "lock.shield",
                tint: .systemGreen,
                title: "本地数据与隐私原则",
                subtitle: "账号凭据、用量账本与汉化词典仅保存在本机，绝不上传任何遥测数据",
                control: localOnlyPill
            )
        ], spacing: 11)
        for child in projectInner.arrangedSubviews { fillWidth(child, in: projectInner) }
        let projectCard = group([projectInner], inset: 14)
        projectCard.cornerRadius = 14

        func sectionGroup(_ title: String, card: NSView) -> NSStackView {
            let hdr = text(title, size: 11.5, weight: .semibold, color: Design.secondary)
            let grp = vertical([hdr, card], spacing: 6)
            fillWidth(hdr, in: grp)
            fillWidth(card, in: grp)
            return grp
        }

        let root = pageStack(title: "关于")
        root.spacing = 12
        root.addArrangedSubview(heroCard)
        root.addArrangedSubview(sectionGroup("版本与环境", card: specsCard))
        root.addArrangedSubview(sectionGroup("项目与隐私", card: projectCard))
        fillWidth(heroCard, in: root)

        view = scrollPage(root)
        Design.applyControls(view)
        refreshUpdateState()
    }

    private func resolvedBuildSummary() -> String {
        var buildStr = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if buildStr.lowercased().hasPrefix("build ") {
            buildStr = String(buildStr.dropFirst(6)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let infoURLs = [
            app.resources.appendingPathComponent("build-info.json"),
            Bundle.main.resourceURL?.appendingPathComponent("build-info.json")
        ].compactMap { $0 }
        for url in infoURLs {
            if let data = try? Data(contentsOf: url),
               let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let rev = (info["revision"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !rev.isEmpty {
                return buildStr.isEmpty || buildStr == rev ? rev : "\(buildStr) · \(rev)"
            }
        }
        return buildStr.isEmpty ? app.updateManager.currentBuildDisplay : buildStr
    }

    func syncAutoUpdateSwitch() {
        autoUpdateSwitch.state = app.configuration.value.autoUpdateEnabled ? .on : .off
    }

    func refreshUpdateState() {
        syncAutoUpdateSwitch()
        let ver = app.updateManager.currentVersion
        versionPill.title = "v\(ver)"
        switch app.updateManager.state {
        case .idle:
            updateStatusIcon.image = NSImage(systemSymbolName: "arrow.triangle.2.circlepath", accessibilityDescription: nil)
            updateStatusIcon.contentTintColor = Design.secondary
            updateStatusLabel.stringValue = "点击右上角「检查更新」获取 GitHub Release 最新版本"
            updateMetaLabel.stringValue = "当前 v\(ver)"
            checkUpdateBtn.isHidden = false
            checkUpdateBtn.setBusy(false, available: true)
            installNowBtn.isHidden = true
            cancelDownloadBtn.isHidden = true
            releaseNotesBtn.isHidden = true
        case .checking:
            updateStatusIcon.image = NSImage(systemSymbolName: "arrow.triangle.2.circlepath", accessibilityDescription: nil)
            updateStatusIcon.contentTintColor = Design.blue
            updateStatusLabel.stringValue = "正在检查 GitHub Release 最新版本…"
            updateMetaLabel.stringValue = "当前 v\(ver)"
            checkUpdateBtn.isHidden = false
            checkUpdateBtn.setBusy(true, available: true)
            installNowBtn.isHidden = true
            cancelDownloadBtn.isHidden = true
            releaseNotesBtn.isHidden = true
        case .upToDate:
            updateStatusIcon.image = NSImage(systemSymbolName: "checkmark.seal.fill", accessibilityDescription: nil)
            updateStatusIcon.contentTintColor = .systemGreen
            updateStatusLabel.stringValue = "GravityBox v\(ver) 已是最新版本"
            updateMetaLabel.stringValue = "官方发布一致"
            checkUpdateBtn.isHidden = false
            checkUpdateBtn.setBusy(false, available: true)
            installNowBtn.isHidden = true
            cancelDownloadBtn.isHidden = true
            releaseNotesBtn.isHidden = true
        case .updateAvailable(let release):
            updateStatusIcon.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: nil)
            updateStatusIcon.contentTintColor = Design.blue
            updateStatusLabel.stringValue = "发现新版本 \(release.tagName)，可立即升级"
            updateMetaLabel.stringValue = release.publishedDate.isEmpty ? "" : "发布于 \(release.publishedDate)"
            checkUpdateBtn.isHidden = true
            installNowBtn.title = "立即更新"
            installNowBtn.isEnabled = true
            installNowBtn.isHidden = false
            cancelDownloadBtn.isHidden = true
            releaseNotesBtn.isHidden = false
        case .downloading(let release):
            updateStatusIcon.image = NSImage(systemSymbolName: "arrow.down.circle.fill", accessibilityDescription: nil)
            updateStatusIcon.contentTintColor = Design.blue
            updateStatusLabel.stringValue = "正在后台下载 \(release.tagName) 更新包并校验 SHA-256…"
            updateMetaLabel.stringValue = "下载中"
            checkUpdateBtn.isHidden = true
            installNowBtn.isHidden = true
            cancelDownloadBtn.isEnabled = true
            cancelDownloadBtn.isHidden = false
            releaseNotesBtn.isHidden = false
        case .readyToInstall(let release, _):
            updateStatusIcon.image = NSImage(systemSymbolName: "checkmark.shield.fill", accessibilityDescription: nil)
            updateStatusIcon.contentTintColor = .systemGreen
            updateStatusLabel.stringValue = "\(release.tagName) 更新包已就绪并校验通过，可立即安装"
            updateMetaLabel.stringValue = "已校验"
            checkUpdateBtn.isHidden = true
            installNowBtn.title = "立即更新"
            installNowBtn.isEnabled = true
            installNowBtn.isHidden = false
            cancelDownloadBtn.isHidden = true
            releaseNotesBtn.isHidden = false
        case .installing(let release):
            updateStatusIcon.image = NSImage(systemSymbolName: "gearshape.2.fill", accessibilityDescription: nil)
            updateStatusIcon.contentTintColor = Design.blue
            updateStatusLabel.stringValue = "正在准备重启并安装 \(release.tagName)…"
            updateMetaLabel.stringValue = "安装中"
            checkUpdateBtn.isHidden = true
            installNowBtn.title = "正在安装…"
            installNowBtn.isEnabled = false
            installNowBtn.isHidden = false
            cancelDownloadBtn.isHidden = true
            releaseNotesBtn.isHidden = false
        case .failed(let message):
            updateStatusIcon.image = NSImage(systemSymbolName: "exclamationmark.triangle.fill", accessibilityDescription: nil)
            updateStatusIcon.contentTintColor = accessibleWarningColor()
            updateStatusLabel.stringValue = "检查更新未完成：\(message)"
            updateMetaLabel.stringValue = "可重试"
            checkUpdateBtn.isHidden = false
            checkUpdateBtn.setBusy(false, available: true)
            installNowBtn.isHidden = true
            cancelDownloadBtn.isHidden = true
            releaseNotesBtn.isHidden = false
        }
    }

    func update() {
        refreshUpdateState()
    }

    @objc func checkForUpdates() {
        app.updateManager.checkForUpdates(silent: false)
    }

    @objc func installAvailableUpdate() {
        guard let release = app.updateManager.availableRelease else {
            checkForUpdates()
            return
        }
        app.showUpdateSheet()
        app.updateManager.installRelease(release)
    }

    @objc func cancelActiveDownload() {
        app.updateManager.cancelDownload()
    }

    @objc func openUpdateSheet() {
        app.showUpdateSheet()
    }

    @objc func toggleAutoUpdate() {
        let enabled = autoUpdateSwitch.state == .on
        app.configuration.value.autoUpdateEnabled = enabled
        try? app.configuration.save()
        app.configureAutoUpdateTimer()
        app.updateSheet?.autoUpdateSwitch.state = enabled ? .on : .off
    }

    @objc func revealDataFolder() {
        NSWorkspace.shared.activateFileViewerSelecting([app.state])
    }

    @objc func openReleasesPage() {
        if let release = app.updateManager.availableRelease {
            NSWorkspace.shared.open(release.htmlURL)
        } else {
            NSWorkspace.shared.open(AppUpdateManager.releasesPageURL)
        }
    }
}
