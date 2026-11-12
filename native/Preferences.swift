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
    private var downloadTask: Task<Void, Never>?
    private var installationInFlight = false
    private var pendingInstallAfterDownload = false
    private var cleanupInFlight = false
    private var launchCleanupCompleted = false
    private var launchAcknowledgeAttempted = false

    init(app: Assistant) {
        self.app = app
    }

    var currentVersion: String {
        if let bundleVer = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !bundleVer.isEmpty {
            return bundleVer
        }
        let candidateURLs: [URL?] = [
            app.resources.appendingPathComponent("build-info.json"),
            Bundle.main.resourceURL?.appendingPathComponent("build-info.json"),
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("package.json")
        ]
        for url in candidateURLs.compactMap({ $0 }) {
            if let data = try? Data(contentsOf: url),
               let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let ver = (info["version"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !ver.isEmpty {
                return Self.normalizeVersion(ver)
            }
        }
        return "1.0.5"
    }

    var currentBuildDisplay: String {
        var buildStr = (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if buildStr.lowercased().hasPrefix("build ") {
            buildStr = String(buildStr.dropFirst(6)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let infoURLs = [
            app.resources.appendingPathComponent("build-info.json"),
            Bundle.main.resourceURL?.appendingPathComponent("build-info.json")
        ].compactMap { $0 }
        for infoURL in infoURLs {
            if let data = try? Data(contentsOf: infoURL),
               let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if buildStr.isEmpty, let buildNum = info["buildNumber"] {
                    buildStr = "\(buildNum)"
                }
                if let rev = (info["revision"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !rev.isEmpty, !buildStr.contains(rev) {
                    buildStr = buildStr.isEmpty ? rev : "\(buildStr) · \(rev)"
                }
                break
            }
        }
        return buildStr.isEmpty ? "10005" : buildStr
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
            self.app.syncUpdatePromptControls()
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
        app.syncUpdatePromptControls()
        onStateChanged?()
    }

    func simulateChecking() {
        state = .checking
        app.syncUpdatePromptControls()
        onStateChanged?()
    }

    func checkForUpdates(silent: Bool = false) {
        guard !checkInFlight, !downloadInFlight, !installationInFlight else { return }
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
                } else {
                    self.transition(self.availableRelease.map { .updateAvailable($0) } ?? .idle)
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
                    let expectedName = "GravityBox-\(remoteVersion)-arm64.dmg"
                    if assetName == expectedName { dmgURL = url }
                    else if assetName == expectedName + ".sha256" { sha256URL = url }
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
                self.downloadedDMGURL = nil
                self.transition(.updateAvailable(info))
                if FileManager.default.fileExists(atPath: cached.path) || self.app.configuration.value.autoUpdateEnabled {
                    self.preDownloadRelease(info, silent: true)
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
        var codeBlockLines: [String] = []
        var skipSection = false

        func isBoilerplateHeading(_ heading: String) -> Bool {
            let lower = heading.lowercased()
            return lower.contains("sha-256") ||
                lower.contains("sha256") ||
                heading.contains("附件校验") ||
                heading.contains("安装与首次打开") ||
                heading.contains("手动安装")
        }

        func isBoilerplateCodeLine(_ line: String) -> Bool {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { return true }
            if t.contains("com.apple.quarantine") || t.hasPrefix("sudo xattr") || t.hasPrefix("xattr ") {
                return true
            }
            let parts = t.split(whereSeparator: { $0.isWhitespace })
            if let first = parts.first, first.count == 64,
               first.allSatisfy({ $0.isHexDigit }) {
                return true
            }
            return false
        }

        for rawLine in normalized.components(separatedBy: "\n") {
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if inCodeBlock {
                    inCodeBlock = false
                    if !skipSection && !codeBlockLines.allSatisfy(isBoilerplateCodeLine) {
                        for cLine in codeBlockLines {
                            outputLines.append("  " + cLine)
                        }
                    }
                    codeBlockLines.removeAll()
                } else {
                    inCodeBlock = true
                    codeBlockLines.removeAll()
                }
                continue
            }
            if inCodeBlock {
                codeBlockLines.append(rawLine)
                continue
            }
            var headingTitle: String?
            if trimmed.hasPrefix("### ") {
                headingTitle = String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespaces)
            } else if trimmed.hasPrefix("## ") {
                headingTitle = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            } else if trimmed.hasPrefix("# ") {
                headingTitle = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)
            }
            if let headingTitle {
                skipSection = isBoilerplateHeading(headingTitle)
                if !skipSection {
                    let cleanHeading = headingTitle.replacingOccurrences(of: "**", with: "")
                        .replacingOccurrences(of: "`", with: "")
                    outputLines.append(cleanHeading)
                }
                continue
            }
            if skipSection { continue }

            var line = rawLine
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
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

    static func verifyCachedDownload(_ file: URL) throws {
        let text = try String(contentsOf: file.appendingPathExtension("sha256"), encoding: .utf8)
        let expected = try UpdatePackageIntegrity.expectedHash(text, fileName: file.lastPathComponent)
        try UpdatePackageIntegrity.verify(file, expected: expected)
    }

    func preDownloadRelease(_ release: AppReleaseInfo, silent: Bool, completion: ((Result<URL, Error>) -> Void)? = nil) {
        guard !downloadInFlight else { return }
        downloadInFlight = true
        downloadedDMGURL = nil
        transition(.downloading(release))
        let targetFile = cachedDMGPath(for: release.version)
        downloadTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let preparation = Task.detached(priority: .utility) { () -> Result<URL, Error> in
            let result: Result<URL, Error>
            do {
            let file = try await { () async throws -> URL in
                guard release.version.range(of: #"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"#, options: .regularExpression) != nil else {
                    throw UpdatePackageIntegrity.failure("更新版本号无效，已停止更新。")
                }
                let fm = FileManager.default
                // Rehash on every reuse, including installation. Old unverified caches never qualify.
                if fm.fileExists(atPath: targetFile.path), (try? Self.verifyCachedDownload(targetFile)) != nil {
                    return targetFile
                }
                guard let dmgURL = release.dmgURL, let shaURL = release.sha256URL else {
                    throw UpdatePackageIntegrity.failure("该版本缺少安装包或 SHA-256 校验文件，已停止更新；当前版本仍可继续使用。")
                }
                let shaText: String
                do { let (data, response) = try await URLSession.shared.data(from: shaURL); guard (response as? HTTPURLResponse)?.statusCode == 200, data.count < 65536, let decoded = String(data: data, encoding: .utf8) else { throw URLError(.badServerResponse) }; shaText = decoded }
                catch { throw UpdatePackageIntegrity.failure("无法读取 SHA-256 校验文件，已停止更新，请稍后重试。") }
                let expected = try UpdatePackageIntegrity.expectedHash(shaText, fileName: targetFile.lastPathComponent)
                let dir = targetFile.deletingLastPathComponent()
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
                let tempDMG = dir.appendingPathComponent("download-\(UUID().uuidString).dmg.part")
                defer { try? fm.removeItem(at: tempDMG) }
                let (download, response) = try await URLSession.shared.download(from: dmgURL)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                try Task.checkCancellation()
                try fm.moveItem(at: download, to: tempDMG)
                try UpdatePackageIntegrity.verify(tempDMG, expected: expected)
                let verify = Process()
                verify.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
                verify.arguments = ["verify", "-quiet", tempDMG.path]
                Self.configureSilentProcess(verify)
                try verify.run(); verify.waitUntilExit()
                guard verify.terminationStatus == 0 else { throw UpdatePackageIntegrity.failure("DMG 磁盘映像完整性校验未通过。") }
                try Task.checkCancellation()
                guard rename(tempDMG.path, targetFile.path) == 0 else { throw UpdatePackageIntegrity.failure("无法保存已校验安装包，请稍后重试。") }
                // A crash between these writes leaves an unusable cache, never an unchecked ready state.
                try Data("\(expected)  \(targetFile.lastPathComponent)\n".utf8).write(to: targetFile.appendingPathExtension("sha256"), options: .atomic)
                try Self.verifyCachedDownload(targetFile)
                return targetFile
            }()
            result = .success(file)
            } catch { result = .failure(error) }
            return result
            }
            let result = await withTaskCancellationHandler { await preparation.value } onCancel: { preparation.cancel() }
                self.downloadInFlight = false
                let shouldAutoInstall = self.pendingInstallAfterDownload
                self.pendingInstallAfterDownload = false
                switch result {
                case .success(let file):
                    self.downloadedDMGURL = file
                    self.transition(.readyToInstall(release, file))
                    if shouldAutoInstall && !self.installationInFlight {
                        self.installationInFlight = true
                        self.executeInstall(release: release, dmgFile: file)
                    }
                case .failure(let error):
                    if error is CancellationError || (error as? URLError)?.code == .cancelled { self.transition(.updateAvailable(release)) }
                    else { self.transition((silent && !shouldAutoInstall) ? .updateAvailable(release) : .failed(error.localizedDescription)) }
                }
                completion?(result)
        }
    }

    func cancelDownload() { pendingInstallAfterDownload = false; downloadTask?.cancel() }

    func installRelease(_ release: AppReleaseInfo) {
        guard !installationInFlight else { return }
        if downloadInFlight {
            pendingInstallAfterDownload = true
            transition(.downloading(release))
            return
        }
        installationInFlight = true
        // The cached path must pass the same validation as a newly downloaded package.
        preDownloadRelease(release, silent: false) { [weak self] result in
            switch result {
            case .success(let file): self?.executeInstall(release: release, dmgFile: file)
            case .failure: self?.installationInFlight = false
            }
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

    private static let dmgFilenameRegex = try! NSRegularExpression(
        pattern: #"^GravityBox[-_ ]v?(\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?)(?:-(?:arm64|universal|x86_64|mac))?\.dmg(?:\.sha256)?$"#,
        options: [.caseInsensitive]
    )

    static func extractGravityBoxDMGVersion(from fileName: String) -> String? {
        let ns = fileName as NSString
        let range = NSRange(location: 0, length: ns.length)
        guard let match = dmgFilenameRegex.firstMatch(in: fileName, options: [], range: range),
              match.numberOfRanges >= 2 else {
            return nil
        }
        let rawVer = ns.substring(with: match.range(at: 1))
        let normalized = normalizeVersion(rawVer)
        return normalized.isEmpty ? nil : normalized
    }

    var hasDownloadedUpdateReady: Bool {
        guard let url = downloadedDMGURL, !downloadInFlight else { return false }
        if case .installing = state { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }

    func validateCachedDMGState() {
        if let url = downloadedDMGURL, !FileManager.default.fileExists(atPath: url.path) {
            downloadedDMGURL = nil
            if case .readyToInstall(let release, _) = state {
                state = .updateAvailable(release)
            }
        }
    }

    /// Invoked only after a successful backend status reply, never merely because the app started.
    func cleanupAfterSuccessfulLaunch() {
        #if !NATIVE_UI_TEST
        guard !cleanupInFlight, !launchCleanupCompleted, !installationInFlight else { return }
        let arguments = CommandLine.arguments, version = currentVersion, bundle = Bundle.main.bundleURL, stateDir = app.state
        let hasReceipt = arguments.contains("--update-receipt")
        if !hasReceipt && app.configuration.value.lastCleanedVersion == version {
            launchCleanupCompleted = true
            return
        }
        let needAck = hasReceipt && !launchAcknowledgeAttempted
        launchAcknowledgeAttempted = true
        cleanupInFlight = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            if needAck {
                _ = UpdateInstaller.acknowledge(arguments: arguments, state: stateDir, bundle: bundle)
            }
            var confirmed = false
            if hasReceipt {
                // Ready is only the new app's acknowledgement; wait briefly for the helper's committed confirmation.
                for _ in 0..<15 {
                    if UpdateInstaller.isConfirmed(arguments: arguments, state: stateDir, bundle: bundle) {
                        confirmed = true
                        break
                    }
                    Thread.sleep(forTimeInterval: 0.1)
                }
            } else {
                // Manual drag-and-drop upgrades have no helper receipt: validate the running app after backend readiness.
                confirmed = (try? UpdateInstaller.validateApp(bundle, version: version, appHash: UpdatePackageIntegrity.appHash(bundle))) != nil
            }
            if confirmed {
                _ = self.cleanupObsoleteUpdateArtifacts(successfulLaunchConfirmed: true,
                    restartedAfterUpdate: arguments.contains("--restarted-after-update"), detachMountedVolumes: true)
            }
            DispatchQueue.main.async {
                self.cleanupInFlight = false
                self.launchCleanupCompleted = confirmed || !hasReceipt
            }
        }
        #endif
    }

    @discardableResult
    func cleanupObsoleteUpdateArtifacts(
        successfulLaunchConfirmed: Bool = false,
        restartedAfterUpdate: Bool = false,
        currentVersionOverride: String? = nil,
        downloadsDirectory: URL? = nil,
        detachMountedVolumes: Bool = false
    ) -> Int {
        guard successfulLaunchConfirmed else { return 0 }
        let fm = FileManager.default
        let currentVer = Self.normalizeVersion(currentVersionOverride ?? currentVersion)
        var cleanedCount = 0

        let updatesDir = app.state.appendingPathComponent("updates", isDirectory: true)
        if let entries = try? fm.contentsOfDirectory(at: updatesDir, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles]) {
            for entryURL in entries {
                let name = entryURL.lastPathComponent
                let values = try? entryURL.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                if values?.isSymbolicLink == true { continue }
                let isDir = values?.isDirectory == true

                if isDir && name.hasPrefix("install-") {
                    if case .installing = state { continue }
                    if fm.fileExists(atPath: entryURL.appendingPathComponent(UpdateInstaller.receiptName).path) { continue }
                    if (try? fm.removeItem(at: entryURL)) != nil {
                        cleanedCount += 1
                    }
                    continue
                }

                if isDir && name == "transactions" {
                    if case .installing = state { continue }
                    if let txEntries = try? fm.contentsOfDirectory(at: entryURL, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles]) {
                        for txURL in txEntries {
                            let txValues = try? txURL.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                            guard txValues?.isSymbolicLink != true, txValues?.isDirectory == true, txURL.lastPathComponent.hasPrefix("install-") else { continue }
                            let receiptURL = txURL.appendingPathComponent(UpdateInstaller.receiptName)
                            if !fm.fileExists(atPath: receiptURL.path) {
                                if (try? fm.removeItem(at: txURL)) != nil { cleanedCount += 1 }
                                continue
                            }
                            if let rData = try? Data(contentsOf: receiptURL),
                               let receipt = try? JSONDecoder().decode(UpdateInstallReceipt.self, from: rData),
                               receipt.phase == "confirmed" {
                                for stagedName in ["GravityBox.app", "installer", "mount"] {
                                    let stagedItem = txURL.appendingPathComponent(stagedName)
                                    if fm.fileExists(atPath: stagedItem.path), (try? fm.removeItem(at: stagedItem)) != nil {
                                        cleanedCount += 1
                                    }
                                }
                            }
                        }
                    }
                    continue
                }

                if isDir && name.lowercased().hasPrefix("v") {
                    let folderVer = Self.normalizeVersion(name)
                    if !folderVer.isEmpty && !Self.isNewerVersion(folderVer, than: currentVer) {
                        if (try? fm.removeItem(at: entryURL)) != nil {
                            cleanedCount += 1
                        }
                    } else if !downloadInFlight,
                              let children = try? fm.contentsOfDirectory(at: entryURL, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) {
                        for child in children where child.lastPathComponent.hasSuffix(".dmg.part") {
                            if (try? fm.removeItem(at: child)) != nil {
                                cleanedCount += 1
                            }
                        }
                    }
                    continue
                }

                if !isDir {
                    if !downloadInFlight && name.hasSuffix(".dmg.part") {
                        if (try? fm.removeItem(at: entryURL)) != nil {
                            cleanedCount += 1
                        }
                    } else if let pkgVer = Self.extractGravityBoxDMGVersion(from: name),
                              !Self.isNewerVersion(pkgVer, than: currentVer) {
                        if (try? fm.removeItem(at: entryURL)) != nil {
                            cleanedCount += 1
                        }
                    }
                }
            }
        }

        let lastCleaned = app.configuration?.value.lastCleanedVersion ?? ""
        let isVersionUpgrade = !currentVer.isEmpty && lastCleaned != currentVer

        if detachMountedVolumes && (restartedAfterUpdate || isVersionUpgrade) {
            let bundlePath = Bundle.main.bundleURL.standardizedFileURL.path
            if !bundlePath.hasPrefix("/Volumes/") {
                let volumesDir = URL(fileURLWithPath: "/Volumes", isDirectory: true)
                if let mounts = try? fm.contentsOfDirectory(at: volumesDir, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) {
                    for mountURL in mounts {
                        let mountName = mountURL.lastPathComponent
                        guard mountName.lowercased().hasPrefix("gravitybox"),
                              fm.fileExists(atPath: mountURL.appendingPathComponent("GravityBox.app/Contents/Info.plist").path) else {
                            continue
                        }
                        let detach = Process()
                        detach.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
                        detach.arguments = ["detach", mountURL.path, "-force", "-quiet"]
                        Self.configureSilentProcess(detach)
                        try? detach.run()
                        detach.waitUntilExit()
                    }
                }
            }
        }

        // 仅在显式传入指定目录（如单元测试隔离环境）时清理，严禁默认扫描用户 ~/Downloads，杜绝 TCC 权限弹窗与隐私越界
        if let downloadsURL = downloadsDirectory,
           let files = try? fm.contentsOfDirectory(at: downloadsURL, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles]) {
            for fileURL in files {
                let values = try? fileURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                guard values?.isSymbolicLink != true, values?.isRegularFile == true else { continue }
                let fileName = fileURL.lastPathComponent
                guard let pkgVer = Self.extractGravityBoxDMGVersion(from: fileName),
                      !Self.isNewerVersion(pkgVer, than: currentVer) else {
                    continue
                }
                if (try? fm.trashItem(at: fileURL, resultingItemURL: nil)) != nil {
                    cleanedCount += 1
                } else if (try? fm.removeItem(at: fileURL)) != nil {
                    cleanedCount += 1
                }
            }
        }

        let syncMemoryState = { [weak self] in
            guard let self else { return }
            if let dmg = self.downloadedDMGURL, !fm.fileExists(atPath: dmg.path) {
                self.downloadedDMGURL = nil
            }
            if let rel = self.availableRelease, !Self.isNewerVersion(rel.version, than: currentVer) {
                self.availableRelease = nil
                self.downloadedDMGURL = nil
                self.state = .upToDate
                self.app.syncUpdatePromptControls()
                self.onStateChanged?()
            } else {
                self.validateCachedDMGState()
                self.app.syncUpdatePromptControls()
            }
            if self.app.configuration != nil && self.app.configuration.value.lastCleanedVersion != currentVer {
                self.app.configuration.value.lastCleanedVersion = currentVer
                try? self.app.configuration.save()
            }
        }
        if Thread.isMainThread {
            syncMemoryState()
        } else {
            DispatchQueue.main.async(execute: syncMemoryState)
        }

        return cleanedCount
    }

    static func shellQuote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'" }

    static func buildDetachedUpdaterScript(myPid: Int32, stagedAppPath: String, targetAppPath: String, workDirPath: String, dmgFilePath: String = "") -> String {
        let helper = URL(fileURLWithPath: workDirPath).appendingPathComponent("installer").path
        let receipt = URL(fileURLWithPath: workDirPath).appendingPathComponent(UpdateInstaller.receiptName).path
        let body = """
        trap "" HUP TERM INT QUIT PIPE
        i=0
        while kill -0 \(myPid) 2>/dev/null && [ $i -lt 50 ]; do
          sleep 0.2
          i=$((i + 1))
        done
        if kill -0 \(myPid) 2>/dev/null; then
          kill -9 \(myPid) 2>/dev/null || true
          sleep 0.2
        fi
        exec \(shellQuote(helper)) --install-update \(shellQuote(receipt))
        """
        return "nohup /bin/sh -c " + shellQuote(body) + " >/dev/null 2>&1 &"
    }

    private func executeInstall(release: AppReleaseInfo, dmgFile: URL) {
        transition(.installing(release))
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let fm = FileManager.default
            let workDir = self.app.state.appendingPathComponent("updates/transactions/install-\(UUID().uuidString)")
            let mountDir = workDir.appendingPathComponent("mount")
            let stagedApp = workDir.appendingPathComponent("GravityBox.app")
            do {
                try Self.verifyCachedDownload(dmgFile)
                try fm.createDirectory(at: mountDir, withIntermediateDirectories: true)
                let attach = Process()
                attach.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
                attach.arguments = ["attach", "-nobrowse", "-readonly", "-quiet", "-mountpoint", mountDir.path, dmgFile.path]
                Self.configureSilentProcess(attach)
                try attach.run()
                attach.waitUntilExit()
                guard attach.terminationStatus == 0 else {
                    throw NSError(domain: "GravityBoxUpdate", code: 4, userInfo: [NSLocalizedDescriptionKey: "无法挂载更新镜像，安装包已保留，请重试或重新下载。"])
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
                    throw NSError(domain: "GravityBoxUpdate", code: 6, userInfo: [NSLocalizedDescriptionKey: "新版本应用包代码签名校验未通过。"])
                }

                let targetAppPath = Self.resolveInstallTargetAppPath()
                let receipt = try UpdateInstaller.prepare(stagedApp: stagedApp, target: URL(fileURLWithPath: targetAppPath),
                    work: workDir, version: release.version, dmg: dmgFile)
                let helper = workDir.appendingPathComponent("installer")
                try fm.copyItem(at: Bundle.main.executableURL!, to: helper)
                try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
                // The signed helper is the currently running binary, independent of the app being exchanged.
                guard fm.fileExists(atPath: receipt.path) else { throw UpdatePackageIntegrity.failure("更新恢复记录未能保存。") }
                DispatchQueue.main.async {
                    self.app.suppressLifecycleAutoQuit(seconds: 60)
                    let myPid = getpid()
                    let script = Self.buildDetachedUpdaterScript(
                        myPid: myPid,
                        stagedAppPath: stagedApp.path,
                        targetAppPath: targetAppPath,
                        workDirPath: workDir.path,
                        dmgFilePath: dmgFile.path
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
                        self.installationInFlight = false
                        self.transition(.failed("无法启动安装辅助脚本，旧版本和恢复材料已保留：\(error.localizedDescription)"))
                    }
                }
            } catch {
                if !fm.fileExists(atPath: workDir.appendingPathComponent(UpdateInstaller.receiptName).path) { try? fm.removeItem(at: workDir) }
                DispatchQueue.main.async {
                    self.installationInFlight = false
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
    let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 292), styleMask: [.titled], backing: .buffered, defer: false)
    let titleLabel = text("GravityBox", size: 16, weight: .bold, color: .labelColor)
    let verPill: PillBadge
    let githubBtn: NSButton
    let statusIconView = symbol("checkmark.seal.fill", size: 13, color: Design.blue)
    let changelogHeading = text("版本说明", size: 12, weight: .semibold, color: .labelColor)
    let changelogTextView = NSTextView()
    let autoUpdateSwitch = DesignSwitch()
    let closeBtn = button("完成", target: nil, action: #selector(closeSheet))
    let primaryBtn = DesignButton(title: "重新检查", target: nil, action: #selector(primaryAction))
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

        closeBtn.target = self
        closeBtn.keyEquivalent = "\u{1b}"
        primaryBtn.target = self
        primaryBtn.bezelColor = Design.blue
        primaryBtn.keyEquivalent = "\r"

        let footerRow = horizontal([autoUpdateLeft, flexibleSpace(), closeBtn, primaryBtn], spacing: 8)
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

    func renderState() {
        let ver = app.updateManager.currentVersion
        let buildStr = app.updateManager.currentBuildDisplay
        verPill.title = "v\(ver)"
        switch app.updateManager.state {
        case .idle, .checking:
            setStatusIcon("arrow.triangle.2.circlepath", tint: Design.blue)
            changelogHeading.stringValue = "版本说明"
            setNotesContent("• 当前运行版本：GravityBox v\(ver)（构建 \(buildStr)）\n• 正在同步 GitHub Release 最新版本信息，请稍候…")
            closeBtn.title = "关闭"
            closeBtn.isEnabled = true
            primaryBtn.title = "检查中…"
            primaryBtn.showsSpinner = true
            primaryBtn.isEnabled = false
        case .upToDate:
            setStatusIcon("checkmark.seal.fill", tint: .systemGreen)
            changelogHeading.stringValue = "当前版本状态"
            setNotesContent("• 当前运行版本 GravityBox v\(ver)（构建 \(buildStr)）已是最新发布版本。\n• 开启下方「自动更新」后，后台将自动检测新版本并预下载更新包。")
            closeBtn.title = "完成"
            closeBtn.isEnabled = true
            primaryBtn.title = "重新检查"
            primaryBtn.showsSpinner = false
            primaryBtn.isEnabled = true
        case .updateAvailable(let release):
            setStatusIcon("sparkles", tint: Design.blue)
            changelogHeading.stringValue = "\(release.tagName) 更新日志"
            setNotesContent(AppUpdateManager.formatReleaseNotes(release.changelog))
            closeBtn.title = "稍后"
            closeBtn.isEnabled = true
            primaryBtn.title = "立即更新"
            primaryBtn.showsSpinner = false
            primaryBtn.isEnabled = true
        case .downloading(let release):
            setStatusIcon("arrow.down.circle.fill", tint: Design.blue)
            changelogHeading.stringValue = "\(release.tagName) 更新日志"
            setNotesContent(AppUpdateManager.formatReleaseNotes(release.changelog))
            closeBtn.title = "后台下载"
            closeBtn.isEnabled = true
            primaryBtn.title = "取消下载"
            primaryBtn.showsSpinner = true
            primaryBtn.isEnabled = true
        case .readyToInstall(let release, _):
            setStatusIcon("checkmark.shield.fill", tint: .systemGreen)
            changelogHeading.stringValue = "\(release.tagName) 更新日志"
            setNotesContent(AppUpdateManager.formatReleaseNotes(release.changelog))
            closeBtn.title = "稍后"
            closeBtn.isEnabled = true
            primaryBtn.title = "立即更新"
            primaryBtn.showsSpinner = false
            primaryBtn.isEnabled = true
        case .installing(let release):
            setStatusIcon("gearshape.2.fill", tint: Design.blue)
            changelogHeading.stringValue = "\(release.tagName) 更新日志"
            setNotesContent(AppUpdateManager.formatReleaseNotes(release.changelog))
            closeBtn.title = "稍后"
            closeBtn.isEnabled = false
            primaryBtn.title = "正在安装…"
            primaryBtn.showsSpinner = true
            primaryBtn.isEnabled = false
        case .failed(let message):
            setStatusIcon("exclamationmark.triangle.fill", tint: accessibleWarningColor())
            changelogHeading.stringValue = "检查结果"
            setNotesContent("• 未能完成在线更新：\(message)\n• 您可以点击右上角「GitHub ↗」直接查看或下载最新 Release 安装包。")
            closeBtn.title = "关闭"
            closeBtn.isEnabled = true
            primaryBtn.title = "重试"
            primaryBtn.showsSpinner = false
            primaryBtn.isEnabled = true
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

final class PreferencesController: NSObject {
    static let refreshIntervals = [0, 5, 10, 15, 30, 60]

    unowned let app: Assistant
    var view: NSView!
    let translationSwitch = DesignSwitch()
    let hudSwitch = DesignSwitch()
    let pricingSyncSwitch = DesignSwitch()
    let refresh = NSPopUpButton(frame: .zero, pullsDown: false)
    let login = DesignSwitch()
    let syncLifecycleSwitch = DesignSwitch()
    let storageBadge = pillBadge("", color: Design.blue)
    let storageSubtitleLabel = text("清理无损缓存、孤儿残留与历史运行日志，核心账号与主对话受保护", size: 11, color: Design.secondary, wrap: true)
    var manageCacheBtn: NSButton!
    let aboutSubtitleLabel = text("", size: 11, color: Design.blue, wrap: true)
    var checkUpdateBtn: NSButton!
    let feedback = text("", size: 11, color: Design.secondary, wrap: true)
    var updateSheet: UpdateSheetController?
    private var lastStorageScanAt: Date = .distantPast
    private var storageScanInFlight = false

    init(app: Assistant) {
        self.app = app
        super.init()
        translationSwitch.controlSize = .small
        translationSwitch.state = app.statusValue.enabled ? .on : .off
        translationSwitch.isEnabled = app.reachable && app.statusValue.mode != "unsupported"
        translationSwitch.target = self; translationSwitch.action = #selector(toggleTranslation); translationSwitch.setAccessibilityLabel("界面汉化")

        hudSwitch.controlSize = .small
        hudSwitch.state = app.effectiveHudEnabled() ? .on : .off
        hudSwitch.isEnabled = app.reachable && app.statusValue.mode != "unsupported"
        hudSwitch.target = self; hudSwitch.action = #selector(toggleHud); hudSwitch.setAccessibilityLabel("对话状态栏")

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

        pricingSyncSwitch.state = app.configuration.value.autoPricingSyncEnabled ? .on : .off
        pricingSyncSwitch.target = self; pricingSyncSwitch.action = #selector(togglePricingSync)
        pricingSyncSwitch.setAccessibilityLabel("自动更新价格基准")
        let general = vertical([
            settingRow(icon: "power", tint: .systemGray, title: "登录时启动", subtitle: "登录 macOS 时自动在菜单栏启动 GravityBox", control: login),
            divider(),
            settingRow(icon: "character.book.closed", tint: .systemGreen, title: "界面汉化", subtitle: "基于外置词典实时汉化 Antigravity 界面，不改动官方应用包", control: translationSwitch),
            divider(),
            settingRow(icon: "chart.bar.xaxis", tint: .systemIndigo, title: "对话状态栏", subtitle: "可独立开启；关闭汉化时以英文显示轮次、Token 与上下文", control: hudSwitch),
            divider(),
            settingRow(icon: "link", tint: .systemTeal, title: "跟随 Antigravity 启停", subtitle: "打开 Antigravity 时自动在菜单栏启动，关闭时一并退出", control: syncLifecycleSwitch),
            divider(),
            settingRow(icon: "arrow.clockwise", tint: Design.blue, title: "配额刷新间隔", subtitle: "定时在后台同步已保存账号的最新剩余配额", control: refresh),
            divider(),
            settingRow(icon: "dollarsign.circle", tint: Design.blue, title: "自动更新价格基准", subtitle: "允许从 GitHub 更新参考单价；历史已锁定费用保持不变", control: pricingSyncSwitch),
            divider(),
            settingRow(icon: "clock.arrow.circlepath", tint: .systemGray, title: "历史费用估算", subtitle: "按当前参考价重新估算，并保留原费率和前后对照", control: button("重新估算历史…", target: self, action: #selector(revalueHistory)))
        ], spacing: 12)
        for child in general.arrangedSubviews { fillWidth(child, in: general) }

        storageBadge.isHidden = true
        storageBadge.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        manageCacheBtn = button("管理存储…", target: self, action: #selector(showMaintenanceSheet))
        let storageRow = settingRow(
            icon: "internaldrive",
            tint: .systemOrange,
            title: "存储与维护",
            badge: storageBadge,
            subtitle: "",
            control: manageCacheBtn
        )
        storageSubtitleLabel.maximumNumberOfLines = 1
        storageSubtitleLabel.lineBreakMode = .byTruncatingTail
        storageSubtitleLabel.toolTip = nil
        if let rowStack = storageRow as? NSStackView,
           let captionsStack = rowStack.arrangedSubviews.dropFirst().first as? NSStackView {
            captionsStack.addArrangedSubview(storageSubtitleLabel)
        }
        let maintenance = vertical([
            storageRow
        ], spacing: 12)
        for child in maintenance.arrangedSubviews { fillWidth(child, in: maintenance) }

        let version = app.updateManager.currentVersion
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
        if let active = window.activeSheetWindow, active !== maintenanceSheet?.sheet { return }
        if maintenanceSheet == nil {
            maintenanceSheet = MaintenanceSheetController(app: app)
        }
        maintenanceSheet?.show(in: window) { [weak self] in
            self?.refreshStorageRowState(force: true)
        }
    }

    func applyStorageScanPayload(_ value: [String: Any]) {
        lastStorageScanAt = Date()
        let safeBytes = Int64(intVal(value, "safeBytes"))
        let statefulBytes = Int64(intVal(value, "statefulBytes"))
        if safeBytes >= 10 * 1024 * 1024 {
            let formatted = ByteCountFormatter.string(fromByteCount: safeBytes, countStyle: .file)
            storageBadge.title = "可释放 \(formatted)"
            storageBadge.tint = Design.blue
            storageBadge.isHidden = false
        } else if statefulBytes >= 50 * 1024 * 1024 {
            let formatted = ByteCountFormatter.string(fromByteCount: statefulBytes, countStyle: .file)
            storageBadge.title = "可瘦身 \(formatted)"
            storageBadge.tint = Design.secondary
            storageBadge.isHidden = false
        } else if safeBytes + statefulBytes > 0 {
            storageBadge.title = "状态良好"
            storageBadge.tint = Design.secondary
            storageBadge.isHidden = false
        } else {
            storageBadge.isHidden = true
        }
        if safeBytes > 0 && statefulBytes > 0 {
            let safeStr = ByteCountFormatter.string(fromByteCount: safeBytes, countStyle: .file)
            let statefulStr = ByteCountFormatter.string(fromByteCount: statefulBytes, countStyle: .file)
            storageSubtitleLabel.stringValue = "推荐清理 \(safeStr) 无损缓存，另有 \(statefulStr) 历史数据可按需瘦身"
        } else {
            storageSubtitleLabel.stringValue = "清理无损缓存、孤儿残留与历史运行日志，核心账号与主对话受保护"
        }
        storageSubtitleLabel.toolTip = nil
    }

    func refreshStorageRowState(force: Bool = false) {
        guard app.reachable else { return }
        guard !storageScanInFlight else { return }
        if !force && Date().timeIntervalSince(lastStorageScanAt) < 60.0 {
            return
        }
        storageScanInFlight = true
        let retentionDays = app.cachePage?.selectedRetentionDays ?? 7
        app.bridge.send(["command": "maintenance_scan", "retentionDays": retentionDays]) { [weak self] result in
            guard let self else { return }
            self.storageScanInFlight = false
            if case .success(let value) = result {
                self.applyStorageScanPayload(value)
            }
        }
    }

    @objc func showUpdateSheet() {
        guard let window = app.window else { return }
        if let active = window.activeSheetWindow, active !== updateSheet?.sheet { return }
        if updateSheet == nil {
            updateSheet = UpdateSheetController(app: app)
        }
        updateSheet?.show(in: window)
    }

    func refreshUpdateRowState() {
        if let release = app.updateManager.availableRelease {
            let subtitleText = "发现新版本 v\(release.version)，可立即升级"
            aboutSubtitleLabel.stringValue = subtitleText
            aboutSubtitleLabel.isHidden = false
        } else {
            aboutSubtitleLabel.stringValue = ""
            aboutSubtitleLabel.isHidden = true
        }
    }

    func update() {
        translationSwitch.state = app.statusValue.enabled ? .on : .off
        translationSwitch.isEnabled = app.reachable && app.statusValue.mode != "unsupported"
        hudSwitch.state = app.effectiveHudEnabled() ? .on : .off
        hudSwitch.isEnabled = app.reachable && app.statusValue.mode != "unsupported"
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        syncLifecycleSwitch.state = app.configuration.value.syncAntigravityLifecycle ? .on : .off
        refresh.selectItem(at: Self.refreshIntervals.firstIndex(of: app.configuration.value.quotaRefreshMinutes) ?? 0)
        refreshUpdateRowState()
        refreshStorageRowState()
        updateSheet?.autoUpdateSwitch.state = app.configuration.value.autoUpdateEnabled ? .on : .off
    }

    @objc func toggleTranslation() {
        let target = translationSwitch.state == .on
        app.setTranslationEnabled(target)
    }

    @objc func revalueHistory() {
        guard let window = app.window else { return }
        let alert = NSAlert()
        alert.messageText = "按当前参考价重新估算历史费用？"
        alert.informativeText = "历史费用估算将更新，原费率和前后金额对照会保留在本机。实际服务账单不受影响。"
        alert.addButton(withTitle: "取消")
        alert.addButton(withTitle: "重新估算")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertSecondButtonReturn, let self else { return }
            self.app.perform(["command": "api_pricing_revalue", "confirm": true]) { [weak self] _ in
                self?.app.overview?.fetch(); self?.app.usagePage?.fetch(force: true)
            }
        }
    }

    @objc func togglePricingSync() {
        let enabled = pricingSyncSwitch.state == .on
        pricingSyncSwitch.isEnabled = false
        app.bridge.send(["command": "pricing_sync_set", "enabled": enabled]) { [weak self] result in
            guard let self else { return }
            self.pricingSyncSwitch.isEnabled = true
            if case .success = result {
                self.app.configuration.value.autoPricingSyncEnabled = enabled
                try? self.app.configuration.save()
            } else { self.pricingSyncSwitch.state = self.app.configuration.value.autoPricingSyncEnabled ? .on : .off }
        }
    }

    @objc func toggleHud() {
        let target = hudSwitch.state == .on
        app.setHudEnabled(target)
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
