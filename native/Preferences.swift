import Cocoa
import CryptoKit
import ServiceManagement

struct AppReleaseInfo {
    let version: String
    let tagName: String
    let title: String
    let changelog: String
    let publishedDate: String
    let htmlURL: URL
    let dmgURL: URL?
    let sha256URL: URL?
}

final class AppUpdateManager {
    enum State {
        case idle
        case checking
        case upToDate
        case updateAvailable(AppReleaseInfo)
        case downloading(AppReleaseInfo)
        case readyToInstall(AppReleaseInfo, URL)
        case installing(AppReleaseInfo)
        case failed(String)
    }

    static let latestReleaseEndpoint = URL(string: "https://api.github.com/repos/Enzoo404/gravitybox/releases/latest")!
    static let releasesPageURL = URL(string: "https://github.com/Enzoo404/gravitybox/releases")!

    unowned let app: Assistant
    private(set) var state: State = .idle
    private(set) var availableRelease: AppReleaseInfo?
    private(set) var downloadedDMGURL: URL?
    var onStateChanged: (() -> Void)?
    private var checkInFlight = false
    private var downloadInFlight = false

    init(app: Assistant) {
        self.app = app
    }

    var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
    }

    var currentBuildDisplay: String {
        var buildStr = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if buildStr.lowercased().hasPrefix("build ") {
            buildStr = String(buildStr.dropFirst(6)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let infoURL = Bundle.main.resourceURL?.appendingPathComponent("build-info.json"),
           let data = try? Data(contentsOf: infoURL),
           let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let rev = (info["revision"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !rev.isEmpty, buildStr != rev {
            buildStr = buildStr.isEmpty ? rev : "\(buildStr) · \(rev)"
        }
        return buildStr.isEmpty ? "10000" : buildStr
    }

    static func normalizeVersion(_ raw: String) -> String {
        var cleaned = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.lowercased().hasPrefix("v") {
            cleaned = String(cleaned.dropFirst()).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let dash = cleaned.firstIndex(of: "-") {
            cleaned = String(cleaned[..<dash])
        }
        return cleaned
    }

    static func isNewerVersion(_ remoteRaw: String, than currentRaw: String) -> Bool {
        let remoteParts = normalizeVersion(remoteRaw).split(separator: ".").map { Int($0) ?? 0 }
        let currentParts = normalizeVersion(currentRaw).split(separator: ".").map { Int($0) ?? 0 }
        let count = max(remoteParts.count, currentParts.count, 3)
        for i in 0..<count {
            let r = i < remoteParts.count ? remoteParts[i] : 0
            let c = i < currentParts.count ? currentParts[i] : 0
            if r != c { return r > c }
        }
        return false
    }

    private func transition(_ next: State) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.state = next
            self.app.preferencesController?.refreshUpdateRowState()
            self.onStateChanged?()
        }
    }

    func simulateRelease(_ release: AppReleaseInfo?) {
        availableRelease = release
        downloadedDMGURL = nil
        if let release {
            state = .updateAvailable(release)
        } else {
            state = .upToDate
        }
        app.preferencesController?.refreshUpdateRowState()
        onStateChanged?()
    }

    func checkForUpdates(silent: Bool = false) {
        guard !checkInFlight, !downloadInFlight else { return }
        #if NATIVE_UI_TEST
        if let release = availableRelease {
            transition(.updateAvailable(release))
        } else {
            transition(.upToDate)
        }
        return
        #else
        checkInFlight = true
        transition(.checking)
        var req = URLRequest(url: Self.latestReleaseEndpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("GravityBox/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")

        URLSession.shared.dataTask(with: req) { [weak self] data, response, error in
            guard let self else { return }
            defer { self.checkInFlight = false }
            if let error {
                if !silent {
                    self.transition(.failed("无法连接 GitHub Releases：\(error.localizedDescription)"))
                } else {
                    self.transition(self.availableRelease.map { .updateAvailable($0) } ?? .idle)
                }
                return
            }
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            if statusCode == 404 {
                DispatchQueue.main.async {
                    self.availableRelease = nil
                    self.downloadedDMGURL = nil
                    self.transition(.upToDate)
                }
                return
            }
            guard statusCode == 200, let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                if !silent {
                    self.transition(.failed("获取 GitHub 版本信息失败（HTTP \(statusCode)）"))
                }
                return
            }
            if (json["draft"] as? Bool) == true || (json["prerelease"] as? Bool) == true {
                DispatchQueue.main.async {
                    self.availableRelease = nil
                    self.downloadedDMGURL = nil
                    self.transition(.upToDate)
                }
                return
            }
            let tagName = (json["tag_name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let remoteVersion = Self.normalizeVersion(tagName)
            guard !remoteVersion.isEmpty, Self.isNewerVersion(remoteVersion, than: self.currentVersion) else {
                DispatchQueue.main.async {
                    self.availableRelease = nil
                    self.downloadedDMGURL = nil
                    self.transition(.upToDate)
                }
                return
            }

            let name = (json["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "GravityBox v\(remoteVersion)"
            let body = (json["body"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let publishedRaw = (json["published_at"] as? String) ?? ""
            let publishedDate = publishedRaw.count >= 10 ? String(publishedRaw.prefix(10)) : "最新构建"
            let htmlURL = (json["html_url"] as? String).flatMap(URL.init(string:)) ?? Self.releasesPageURL

            var dmgURL: URL?
            var sha256URL: URL?
            if let assets = json["assets"] as? [[String: Any]] {
                for asset in assets {
                    guard let assetName = asset["name"] as? String,
                          let downloadStr = asset["browser_download_url"] as? String,
                          let url = URL(string: downloadStr) else { continue }
                    if assetName.hasSuffix(".dmg") {
                        dmgURL = url
                    } else if assetName.hasSuffix(".dmg.sha256") {
                        sha256URL = url
                    }
                }
            }

            let info = AppReleaseInfo(
                version: remoteVersion,
                tagName: tagName.isEmpty ? "v\(remoteVersion)" : tagName,
                title: name,
                changelog: body.isEmpty ? "• 包含稳定性提升与细节体验优化。" : body,
                publishedDate: publishedDate,
                htmlURL: htmlURL,
                dmgURL: dmgURL,
                sha256URL: sha256URL
            )

            DispatchQueue.main.async {
                self.availableRelease = info
                let cached = self.cachedDMGPath(for: info.version)
                if FileManager.default.fileExists(atPath: cached.path) {
                    self.downloadedDMGURL = cached
                    self.transition(.readyToInstall(info, cached))
                } else {
                    self.downloadedDMGURL = nil
                    self.transition(.updateAvailable(info))
                    if self.app.configuration.value.autoUpdateEnabled, info.dmgURL != nil {
                        self.preDownloadRelease(info, silent: true)
                    }
                }
            }
        }.resume()
        #endif
    }

    static func formatReleaseNotes(_ raw: String) -> String {
        let normalized = raw.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        var outputLines: [String] = []
        var inCodeBlock = false
        for rawLine in normalized.components(separatedBy: "\n") {
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                inCodeBlock.toggle()
                continue
            }
            if inCodeBlock {
                outputLines.append("  " + rawLine)
                continue
            }
            var line = rawLine
            if trimmed.hasPrefix("### ") {
                line = String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespaces)
            } else if trimmed.hasPrefix("## ") {
                line = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            } else if trimmed.hasPrefix("# ") {
                line = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)
            } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                line = "• " + String(trimmed.dropFirst(2))
            }
            line = line.replacingOccurrences(of: "**", with: "")
                .replacingOccurrences(of: "`", with: "")
            outputLines.append(line)
        }
        var result = outputLines.joined(separator: "\n")
        while result.contains("\n\n\n") {
            result = result.replacingOccurrences(of: "\n\n\n", with: "\n\n")
        }
        result = result.trimmingCharacters(in: .whitespacesAndNewlines)
        return result.isEmpty ? "• 包含稳定性提升与细节体验优化。" : result
    }

    private func cachedDMGPath(for version: String) -> URL {
        app.state.appendingPathComponent("updates/v\(version)/GravityBox-\(version)-arm64.dmg")
    }

    private static func configureSilentProcess(_ proc: Process) {
        proc.standardInput = FileHandle.nullDevice
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
    }

    func preDownloadRelease(_ release: AppReleaseInfo, silent: Bool, completion: ((Result<URL, Error>) -> Void)? = nil) {
        if let ready = downloadedDMGURL, FileManager.default.fileExists(atPath: ready.path) {
            transition(.readyToInstall(release, ready))
            completion?(.success(ready))
            return
        }
        guard let dmgURL = release.dmgURL else {
            let err = NSError(domain: "GravityBoxUpdate", code: 1, userInfo: [NSLocalizedDescriptionKey: "该版本未附带 DMG 安装包，请前往 GitHub 下载。"])
            if !silent { transition(.failed(err.localizedDescription)) }
            completion?(.failure(err))
            return
        }
        guard !downloadInFlight else { return }
        downloadInFlight = true
        transition(.downloading(release))

        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            defer { self.downloadInFlight = false }
            do {
                let targetFile = self.cachedDMGPath(for: release.version)
                let dir = targetFile.deletingLastPathComponent()
                let fm = FileManager.default
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
                let tempDMG = dir.appendingPathComponent("download-\(UUID().uuidString).dmg.part")
                defer { try? fm.removeItem(at: tempDMG) }

                let dmgData = try Data(contentsOf: dmgURL)
                try dmgData.write(to: tempDMG, options: .atomic)

                if let shaURL = release.sha256URL,
                   let shaText = try? String(contentsOf: shaURL, encoding: .utf8) {
                    let expectedHash = shaText.split(whereSeparator: { $0.isWhitespace }).first.map(String.init)?.lowercased() ?? ""
                    if expectedHash.count == 64 {
                        let actualHash = SHA256.hash(data: dmgData).map { String(format: "%02x", $0) }.joined()
                        if actualHash != expectedHash {
                            throw NSError(domain: "GravityBoxUpdate", code: 2, userInfo: [NSLocalizedDescriptionKey: "安装包 SHA-256 校验不一致，已拦截损坏文件。"])
                        }
                    }
                }

                let verifyProc = Process()
                verifyProc.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
                verifyProc.arguments = ["verify", "-quiet", tempDMG.path]
                Self.configureSilentProcess(verifyProc)
                try verifyProc.run()
                verifyProc.waitUntilExit()
                guard verifyProc.terminationStatus == 0 else {
                    throw NSError(domain: "GravityBoxUpdate", code: 3, userInfo: [NSLocalizedDescriptionKey: "DMG 磁盘映像完整性校验未通过。"])
                }

                if fm.fileExists(atPath: targetFile.path) {
                    try fm.removeItem(at: targetFile)
                }
                try fm.moveItem(at: tempDMG, to: targetFile)

                DispatchQueue.main.async {
                    self.downloadedDMGURL = targetFile
                    self.transition(.readyToInstall(release, targetFile))
                    completion?(.success(targetFile))
                }
            } catch {
                DispatchQueue.main.async {
                    if !silent {
                        self.transition(.failed(error.localizedDescription))
                    } else {
                        self.transition(.updateAvailable(release))
                    }
                    completion?(.failure(error))
                }
            }
        }
    }

    func installRelease(_ release: AppReleaseInfo) {
        if let dmgFile = downloadedDMGURL, FileManager.default.fileExists(atPath: dmgFile.path) {
            executeInstall(release: release, dmgFile: dmgFile)
        } else if release.dmgURL != nil {
            preDownloadRelease(release, silent: false) { [weak self] result in
                if case .success(let dmgFile) = result {
                    self?.executeInstall(release: release, dmgFile: dmgFile)
                }
            }
        } else {
            NSWorkspace.shared.open(release.htmlURL)
        }
    }

    static func resolveInstallTargetAppPath(bundleURL: URL = Bundle.main.bundleURL) -> String {
        let bundlePath = bundleURL.standardizedFileURL.path
        if bundlePath.hasSuffix(".app"),
           !bundlePath.hasPrefix("/Volumes/"),
           !bundlePath.contains("/build/dmg-stage/"),
           FileManager.default.isWritableFile(atPath: (bundlePath as NSString).deletingLastPathComponent) {
            return bundlePath
        }
        return "/Applications/GravityBox.app"
    }

    static func buildDetachedUpdaterScript(myPid: Int32, stagedAppPath: String, targetAppPath: String, workDirPath: String) -> String {
        return """
        nohup /bin/sh -c '
        trap "" HUP TERM INT QUIT PIPE
        i=0
        while kill -0 \(myPid) 2>/dev/null && [ $i -lt 25 ]; do
          sleep 0.2
          i=$((i + 1))
        done
        if kill -0 \(myPid) 2>/dev/null; then
          kill -9 \(myPid) 2>/dev/null || true
          sleep 0.2
        fi
        pkill -f "GravityBox.app/Contents/MacOS/GravityBox --lifecycle-agent" 2>/dev/null || true
        if rm -rf "\(targetAppPath)" && mv "\(stagedAppPath)" "\(targetAppPath)"; then
          /usr/bin/xattr -dr com.apple.quarantine "\(targetAppPath)" 2>/dev/null || true
        else
          /usr/bin/ditto "\(stagedAppPath)" "\(targetAppPath)" 2>/dev/null || true
          /usr/bin/xattr -dr com.apple.quarantine "\(targetAppPath)" 2>/dev/null || true
        fi
        rm -rf "\(workDirPath)" 2>/dev/null || true
        /usr/bin/open -n "\(targetAppPath)" --args --restarted-after-update >/dev/null 2>&1 || /usr/bin/open "\(targetAppPath)" >/dev/null 2>&1
        ' >/dev/null 2>&1 &
        """
    }

    private func executeInstall(release: AppReleaseInfo, dmgFile: URL) {
        transition(.installing(release))
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let fm = FileManager.default
            let workDir = self.app.state.appendingPathComponent("updates/install-\(UUID().uuidString)")
            let mountDir = workDir.appendingPathComponent("mount")
            let stagedApp = workDir.appendingPathComponent("GravityBox.app")
            do {
                try fm.createDirectory(at: mountDir, withIntermediateDirectories: true)
                let attach = Process()
                attach.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
                attach.arguments = ["attach", "-nobrowse", "-readonly", "-quiet", "-mountpoint", mountDir.path, dmgFile.path]
                Self.configureSilentProcess(attach)
                try attach.run()
                attach.waitUntilExit()
                guard attach.terminationStatus == 0 else {
                    try? fm.removeItem(at: dmgFile)
                    throw NSError(domain: "GravityBoxUpdate", code: 4, userInfo: [NSLocalizedDescriptionKey: "无法挂载更新镜像，已清理缓存文件，请点击重试。"])
                }
                defer {
                    let detach = Process()
                    detach.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
                    detach.arguments = ["detach", mountDir.path, "-force", "-quiet"]
                    Self.configureSilentProcess(detach)
                    try? detach.run()
                    detach.waitUntilExit()
                }

                let mountedApp = mountDir.appendingPathComponent("GravityBox.app")
                guard fm.fileExists(atPath: mountedApp.appendingPathComponent("Contents/MacOS/GravityBox").path) else {
                    try? fm.removeItem(at: dmgFile)
                    throw NSError(domain: "GravityBoxUpdate", code: 5, userInfo: [NSLocalizedDescriptionKey: "更新镜像内未找到有效的 GravityBox.app。"])
                }
                try fm.copyItem(at: mountedApp, to: stagedApp)

                let xattrProc = Process()
                xattrProc.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
                xattrProc.arguments = ["-dr", "com.apple.quarantine", stagedApp.path]
                Self.configureSilentProcess(xattrProc)
                try? xattrProc.run()
                xattrProc.waitUntilExit()

                let signCheck = Process()
                signCheck.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
                signCheck.arguments = ["--verify", "--deep", "--strict", stagedApp.path]
                Self.configureSilentProcess(signCheck)
                try signCheck.run()
                signCheck.waitUntilExit()
                guard signCheck.terminationStatus == 0 else {
                    try? fm.removeItem(at: dmgFile)
                    throw NSError(domain: "GravityBoxUpdate", code: 6, userInfo: [NSLocalizedDescriptionKey: "新版本应用包代码签名校验未通过。"])
                }

                DispatchQueue.main.async {
                    self.app.suppressLifecycleAutoQuit(seconds: 60)
                    let myPid = getpid()
                    let targetAppPath = Self.resolveInstallTargetAppPath()
                    let script = Self.buildDetachedUpdaterScript(
                        myPid: myPid,
                        stagedAppPath: stagedApp.path,
                        targetAppPath: targetAppPath,
                        workDirPath: workDir.path
                    )
                    let updater = Process()
                    updater.executableURL = URL(fileURLWithPath: "/bin/sh")
                    updater.arguments = ["-c", script]
                    Self.configureSilentProcess(updater)
                    do {
                        try updater.run()
                        updater.waitUntilExit()
                        self.app.quitForUpdate()
                    } catch {
                        try? fm.removeItem(at: workDir)
                        self.transition(.failed("无法启动安装辅助脚本：\(error.localizedDescription)"))
                    }
                }
            } catch {
                try? fm.removeItem(at: workDir)
                DispatchQueue.main.async {
                    if !fm.fileExists(atPath: dmgFile.path) {
                        self.downloadedDMGURL = nil
                    }
                    self.transition(.failed(error.localizedDescription))
                }
            }
        }
    }
}

final class UpdateSheetController: NSObject, NSWindowDelegate {
    unowned let app: Assistant
    let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 304), styleMask: [.titled], backing: .buffered, defer: false)
    let statusHeadline = text("正在检查 GitHub Release 最新版本…", size: 11.5, weight: .medium, color: Design.secondary, wrap: true)
    let statusIconView = symbol("checkmark.seal.fill", size: 13, color: Design.blue)
    let changelogHeading = text("版本说明", size: 12, weight: .semibold, color: .labelColor)
    let stateBadge = pillBadge("检查中", color: Design.inactivePill)
    let changelogTextView = NSTextView()
    let autoUpdateSwitch = NSSwitch()
    let spinner = NSProgressIndicator()
    let closeBtn = button("完成", target: nil, action: #selector(closeSheet))
    let primaryBtn = button("重新检查", target: nil, action: #selector(primaryAction))

    init(app: Assistant) {
        self.app = app
        super.init()
        sheet.delegate = self
        sheet.title = "软件更新"
        sheet.isReleasedWhenClosed = false
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

        let ver = app.updateManager.currentVersion
        let buildStr = app.updateManager.currentBuildDisplay
        let titleLabel = text("GravityBox", size: 15.5, weight: .bold, color: .labelColor)
        let verPill = pillBadge("v\(ver)", color: Design.blue)
        let buildPill = pillBadge("构建 \(buildStr)", color: Design.inactivePill)
        let titleRow = horizontal([titleLabel, verPill, buildPill, flexibleSpace()], spacing: 6)
        titleRow.alignment = .centerY

        statusHeadline.maximumNumberOfLines = 1
        statusHeadline.lineBreakMode = .byTruncatingTail
        let headerMeta = vertical([titleRow, statusHeadline], spacing: 4)
        headerMeta.alignment = .leading
        headerMeta.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let githubBtn = button("GitHub ↗", target: self, action: #selector(openGitHubReleases))
        let headerRow = horizontal([iconBox, headerMeta, flexibleSpace(), githubBtn], spacing: 12)
        headerRow.alignment = .centerY

        statusIconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 12.5, weight: .semibold)
        for c in statusIconView.constraints where c.firstAttribute == .width || c.firstAttribute == .height {
            c.constant = 16
        }
        stateBadge.setContentCompressionResistancePriority(.required, for: .horizontal)
        let notesHeaderRow = horizontal([statusIconView, changelogHeading, flexibleSpace(), stateBadge], spacing: 6)
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
        scroll.heightAnchor.constraint(equalToConstant: 108).isActive = true

        let notesDivider = divider()
        let notesStack = vertical([notesHeaderRow, notesDivider, scroll], spacing: 8)
        fillWidth(notesHeaderRow, in: notesStack)
        fillWidth(notesDivider, in: notesStack)
        fillWidth(scroll, in: notesStack)
        let notesCard = group([notesStack], inset: 13)
        notesCard.cornerRadius = 12

        autoUpdateSwitch.controlSize = .small
        autoUpdateSwitch.state = app.configuration.value.autoUpdateEnabled ? .on : .off
        autoUpdateSwitch.target = self
        autoUpdateSwitch.action = #selector(toggleAutoUpdate)
        autoUpdateSwitch.setAccessibilityLabel("自动更新")

        let autoUpdateLabel = text("自动更新", size: 12.5, weight: .medium, color: .labelColor)
        let autoUpdateHint = text("后台自动预下载新版本", size: 11, color: Design.secondary)
        let autoUpdateLeft = horizontal([autoUpdateSwitch, autoUpdateLabel, autoUpdateHint], spacing: 6)
        autoUpdateLeft.alignment = .centerY

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.isHidden = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            spinner.widthAnchor.constraint(equalToConstant: 16),
            spinner.heightAnchor.constraint(equalToConstant: 16)
        ])

        closeBtn.target = self
        closeBtn.keyEquivalent = "\u{1b}"
        primaryBtn.target = self
        primaryBtn.bezelColor = Design.blue
        primaryBtn.keyEquivalent = "\r"

        let footerRow = horizontal([autoUpdateLeft, flexibleSpace(), spinner, closeBtn, primaryBtn], spacing: 8)
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
        autoUpdateSwitch.state = app.configuration.value.autoUpdateEnabled ? .on : .off
        renderState()
        if sheet.sheetParent == nil {
            parent.beginSheet(sheet)
        }
        if case .idle = app.updateManager.state {
            app.updateManager.checkForUpdates(silent: false)
        } else if case .upToDate = app.updateManager.state {
            app.updateManager.checkForUpdates(silent: false)
        } else if case .failed = app.updateManager.state {
            app.updateManager.checkForUpdates(silent: false)
        }
    }

    func renderState() {
        let ver = app.updateManager.currentVersion
        let buildStr = app.updateManager.currentBuildDisplay
        switch app.updateManager.state {
        case .idle, .checking:
            statusHeadline.stringValue = "正在连接 GitHub Releases 检查更新…"
            statusHeadline.textColor = Design.secondary
            setStatusIcon("arrow.triangle.2.circlepath", tint: Design.blue)
            changelogHeading.stringValue = "版本说明"
            stateBadge.title = "正在检查"
            stateBadge.tint = Design.inactivePill
            setNotesContent("• 当前运行版本：GravityBox v\(ver)（构建 \(buildStr)）\n• 正在同步 GitHub Release 最新版本信息，请稍候…")
            spinner.isHidden = false
            spinner.startAnimation(nil)
            closeBtn.title = "关闭"
            closeBtn.isEnabled = true
            primaryBtn.title = "检查中…"
            primaryBtn.isEnabled = false
        case .upToDate:
            statusHeadline.stringValue = "已同步 GitHub Releases 官方更新通道"
            statusHeadline.textColor = Design.secondary
            setStatusIcon("checkmark.seal.fill", tint: .systemGreen)
            changelogHeading.stringValue = "当前版本状态"
            stateBadge.title = "已是最新"
            stateBadge.tint = .systemGreen
            setNotesContent("• 当前运行版本 GravityBox v\(ver)（构建 \(buildStr)）已是最新发布版本。\n• 开启下方「自动更新」后，后台将自动检测新版本并预下载更新包。")
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            closeBtn.title = "完成"
            closeBtn.isEnabled = true
            primaryBtn.title = "重新检查"
            primaryBtn.isEnabled = true
        case .updateAvailable(let release):
            statusHeadline.stringValue = "发现新版本 v\(release.version)（发布于 \(release.publishedDate)）"
            statusHeadline.textColor = Design.blue
            setStatusIcon("sparkles", tint: Design.blue)
            changelogHeading.stringValue = "\(release.tagName) 更新日志"
            stateBadge.title = "可升级"
            stateBadge.tint = Design.blue
            setNotesContent(AppUpdateManager.formatReleaseNotes(release.changelog))
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            closeBtn.title = "稍后"
            closeBtn.isEnabled = true
            primaryBtn.title = "立即更新"
            primaryBtn.isEnabled = true
        case .downloading(let release):
            statusHeadline.stringValue = "正在下载并校验 GravityBox v\(release.version)…"
            statusHeadline.textColor = Design.blue
            setStatusIcon("arrow.down.circle.fill", tint: Design.blue)
            changelogHeading.stringValue = "\(release.tagName) 更新日志"
            stateBadge.title = "下载校验中"
            stateBadge.tint = Design.blue
            setNotesContent(AppUpdateManager.formatReleaseNotes(release.changelog))
            spinner.isHidden = false
            spinner.startAnimation(nil)
            closeBtn.title = "后台下载"
            closeBtn.isEnabled = true
            primaryBtn.title = "下载中…"
            primaryBtn.isEnabled = false
        case .readyToInstall(let release, _):
            statusHeadline.stringValue = "新版本 v\(release.version) 已就绪，可立即覆盖安装"
            statusHeadline.textColor = Design.blue
            setStatusIcon("checkmark.shield.fill", tint: .systemGreen)
            changelogHeading.stringValue = "\(release.tagName) 更新日志"
            stateBadge.title = "SHA-256 已校验"
            stateBadge.tint = .systemGreen
            setNotesContent(AppUpdateManager.formatReleaseNotes(release.changelog))
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            closeBtn.title = "稍后"
            closeBtn.isEnabled = true
            primaryBtn.title = "立即更新"
            primaryBtn.isEnabled = true
        case .installing(let release):
            statusHeadline.stringValue = "正在安装 GravityBox v\(release.version) 并准备重启…"
            statusHeadline.textColor = Design.blue
            setStatusIcon("gearshape.2.fill", tint: Design.blue)
            changelogHeading.stringValue = "\(release.tagName) 更新日志"
            stateBadge.title = "正在安装"
            stateBadge.tint = Design.blue
            setNotesContent(AppUpdateManager.formatReleaseNotes(release.changelog))
            spinner.isHidden = false
            spinner.startAnimation(nil)
            closeBtn.title = "稍后"
            closeBtn.isEnabled = false
            primaryBtn.title = "正在安装…"
            primaryBtn.isEnabled = false
        case .failed(let message):
            statusHeadline.stringValue = message
            statusHeadline.textColor = accessibleDangerColor()
            setStatusIcon("exclamationmark.triangle.fill", tint: accessibleWarningColor())
            changelogHeading.stringValue = "检查结果"
            stateBadge.title = "更新受阻"
            stateBadge.tint = .systemOrange
            setNotesContent("• 未能完成在线更新：\(message)\n• 您可以点击右上角「GitHub ↗」直接查看或下载最新 Release 安装包。")
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            closeBtn.title = "关闭"
            closeBtn.isEnabled = true
            primaryBtn.title = "重试"
            primaryBtn.isEnabled = true
        }
    }

    @objc func toggleAutoUpdate() {
        let previous = app.configuration.value.autoUpdateEnabled
        let next = autoUpdateSwitch.state == .on
        app.configuration.value.autoUpdateEnabled = next
        do {
            try app.configuration.save()
            app.configureAutoUpdateTimer()
            if next, let release = app.updateManager.availableRelease, app.updateManager.downloadedDMGURL == nil {
                app.updateManager.preDownloadRelease(release, silent: true)
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
        case .checking, .downloading, .installing:
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

final class PreferencesController: NSObject {
    static let refreshIntervals = [0, 5, 10, 15, 30, 60]

    unowned let app: Assistant
    var view: NSView!
    let translationSwitch = NSSwitch()
    let refresh = NSPopUpButton(frame: .zero, pullsDown: false)
    let login = NSSwitch()
    let syncLifecycleSwitch = NSSwitch()
    let aboutSubtitleLabel = text("", size: 11, color: Design.blue, wrap: true)
    var checkUpdateBtn: NSButton!
    let feedback = text("", size: 11, color: Design.secondary, wrap: true)
    var updateSheet: UpdateSheetController?

    init(app: Assistant) {
        self.app = app
        super.init()
        translationSwitch.controlSize = .small
        translationSwitch.state = app.statusValue.enabled ? .on : .off
        translationSwitch.isEnabled = app.reachable && app.statusValue.mode != "unsupported"
        translationSwitch.target = self; translationSwitch.action = #selector(toggleTranslation); translationSwitch.setAccessibilityLabel("界面汉化")

        login.controlSize = .small
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        login.target = self; login.action = #selector(toggleLogin); login.setAccessibilityLabel("登录时启动")

        syncLifecycleSwitch.controlSize = .small
        syncLifecycleSwitch.state = app.configuration.value.syncAntigravityLifecycle ? .on : .off
        syncLifecycleSwitch.target = self; syncLifecycleSwitch.action = #selector(toggleSyncLifecycle)
        syncLifecycleSwitch.setAccessibilityLabel("跟随 Antigravity 启停")

        refresh.addItems(withTitles: ["手动刷新", "每 5 分钟", "每 10 分钟", "每 15 分钟", "每 30 分钟", "每 60 分钟"])
        refresh.selectItem(at: Self.refreshIntervals.firstIndex(of: app.configuration.value.quotaRefreshMinutes) ?? 0)
        refresh.target = self; refresh.action = #selector(refreshChanged); refresh.setAccessibilityLabel("配额刷新间隔")
        refresh.translatesAutoresizingMaskIntoConstraints = false
        refresh.widthAnchor.constraint(equalToConstant: 118).isActive = true

        let general = vertical([
            settingRow(icon: "power", tint: .systemGray, title: "登录时启动", subtitle: "登录 macOS 时自动在菜单栏启动 GravityBox", control: login),
            divider(),
            settingRow(icon: "character.book.closed", tint: .systemGreen, title: "界面汉化", subtitle: "基于外置词典实时汉化 Antigravity 界面，不改动官方应用包", control: translationSwitch),
            divider(),
            settingRow(icon: "link", tint: .systemTeal, title: "跟随 Antigravity 启停", subtitle: "打开 Antigravity 时自动在菜单栏启动，关闭时一并退出", control: syncLifecycleSwitch),
            divider(),
            settingRow(icon: "arrow.clockwise", tint: Design.blue, title: "配额刷新间隔", subtitle: "定时在后台同步已保存账号的最新剩余配额", control: refresh)
        ], spacing: 12)
        for child in general.arrangedSubviews { fillWidth(child, in: general) }

        let manageCacheBtn = button("管理缓存…", target: self, action: #selector(showMaintenanceSheet))
        let storageRow = settingRow(
            icon: "internaldrive",
            tint: .systemOrange,
            title: "存储与维护",
            subtitle: "管理运行加速缓存与会话状态，安全清理冗余文件并支持原位恢复",
            control: manageCacheBtn
        )
        let maintenance = vertical([
            storageRow
        ], spacing: 12)
        for child in maintenance.arrangedSubviews { fillWidth(child, in: maintenance) }

        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
        let verPill = pillBadge("v\(version)", color: Design.blue)
        checkUpdateBtn = button("检查更新", target: self, action: #selector(showUpdateSheet))
        let aboutRow = settingRow(
            icon: "app-icon",
            tint: .systemIndigo,
            title: "GravityBox",
            badge: verPill,
            subtitle: "",
            control: checkUpdateBtn
        )
        aboutSubtitleLabel.maximumNumberOfLines = 1
        aboutSubtitleLabel.lineBreakMode = .byTruncatingTail
        aboutSubtitleLabel.isHidden = true
        if let rowStack = aboutRow as? NSStackView,
           let captionsStack = rowStack.arrangedSubviews.dropFirst().first as? NSStackView {
            captionsStack.addArrangedSubview(aboutSubtitleLabel)
        }
        let details = vertical([aboutRow], spacing: 12)
        for child in details.arrangedSubviews { fillWidth(child, in: details) }

        let generalCard = group([general], inset: 16)
        generalCard.cornerRadius = 14
        let maintenanceCard = group([maintenance], inset: 16)
        maintenanceCard.cornerRadius = 14
        let aboutCard = group([details], inset: 16)
        aboutCard.cornerRadius = 14

        func sectionGroup(_ title: String, card: NSView) -> NSStackView {
            let hdr = text(title, size: 11.5, weight: .semibold, color: Design.secondary)
            let grp = vertical([hdr, card], spacing: 6)
            fillWidth(hdr, in: grp)
            fillWidth(card, in: grp)
            return grp
        }

        let root = pageStack(title: "设置")
        root.spacing = 14
        root.addArrangedSubview(sectionGroup("运行与联动", card: generalCard))
        root.addArrangedSubview(sectionGroup("存储", card: maintenanceCard))
        root.addArrangedSubview(sectionGroup("关于", card: aboutCard))
        feedback.isHidden = true
        root.addArrangedSubview(feedback)
        view = scrollPage(root); Design.applyControls(view)
        refreshUpdateRowState()
    }

    var maintenanceSheet: MaintenanceSheetController?

    @objc func showMaintenanceSheet() {
        guard let window = app.window else { return }
        if maintenanceSheet == nil {
            maintenanceSheet = MaintenanceSheetController(app: app)
        }
        maintenanceSheet?.show(in: window)
    }

    @objc func showUpdateSheet() {
        guard let window = app.window else { return }
        if updateSheet == nil {
            updateSheet = UpdateSheetController(app: app)
        }
        updateSheet?.show(in: window)
    }

    func refreshUpdateRowState() {
        if let release = app.updateManager.availableRelease {
            let subtitleText = "发现新版本 v\(release.version)，可立即升级"
            aboutSubtitleLabel.stringValue = subtitleText
            aboutSubtitleLabel.toolTip = subtitleText
            aboutSubtitleLabel.isHidden = false
        } else {
            aboutSubtitleLabel.stringValue = ""
            aboutSubtitleLabel.toolTip = nil
            aboutSubtitleLabel.isHidden = true
        }
    }

    func update() {
        translationSwitch.state = app.statusValue.enabled ? .on : .off
        translationSwitch.isEnabled = app.reachable && app.statusValue.mode != "unsupported"
        syncLifecycleSwitch.state = app.configuration.value.syncAntigravityLifecycle ? .on : .off
        refresh.selectItem(at: Self.refreshIntervals.firstIndex(of: app.configuration.value.quotaRefreshMinutes) ?? 0)
        refreshUpdateRowState()
        updateSheet?.autoUpdateSwitch.state = app.configuration.value.autoUpdateEnabled ? .on : .off
    }

    @objc func toggleTranslation() {
        app.toggleTranslation()
    }

    @objc func toggleSyncLifecycle() {
        let previous = app.configuration.value.syncAntigravityLifecycle
        let next = syncLifecycleSwitch.state == .on
        app.configuration.value.syncAntigravityLifecycle = next
        do {
            try app.configuration.save()
            feedback.stringValue = ""; feedback.isHidden = true
            app.syncLifecycleAgentRegistration()
        } catch {
            app.configuration.value.syncAntigravityLifecycle = previous
            syncLifecycleSwitch.state = previous ? .on : .off
            showError(error)
        }
    }

    @objc func refreshChanged() {
        let previous = app.configuration.value.quotaRefreshMinutes
        let idx = max(0, min(Self.refreshIntervals.count - 1, refresh.indexOfSelectedItem))
        app.configuration.value.quotaRefreshMinutes = Self.refreshIntervals[idx]
        do { try app.configuration.save(); app.configureQuotaRefreshTimer(); feedback.stringValue = ""; feedback.isHidden = true }
        catch {
            app.configuration.value.quotaRefreshMinutes = previous
            refresh.selectItem(at: Self.refreshIntervals.firstIndex(of: previous) ?? 0)
            showError(error)
        }
    }

    @objc func toggleLogin() {
        do {
            if login.state == .on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            if SMAppService.mainApp.status == .requiresApproval {
                SMAppService.openSystemSettingsLoginItems()
            }
            feedback.stringValue = ""
            feedback.isHidden = true
        } catch {
            showError(error)
        }
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    private func showError(_ error: Error) { app.showMessage(error.localizedDescription, error: true) }
}
