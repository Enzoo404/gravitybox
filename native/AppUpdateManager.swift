import Cocoa
import CryptoKit

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
    #if NATIVE_UI_TEST
    var checkTransport: ((URLRequest, @escaping (Data?, URLResponse?, Error?) -> Void) -> Void)?
    #endif
    private var checkGeneration = 0
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
        guard Thread.isMainThread else { DispatchQueue.main.async { [weak self] in self?.checkForUpdates(silent: silent) }; return }
        guard !checkInFlight, !downloadInFlight, !installationInFlight else { return }
        #if NATIVE_UI_TEST
        if checkTransport == nil {
            transition(availableRelease.map { .updateAvailable($0) } ?? .upToDate)
            return
        }
        #endif
        checkInFlight = true
        checkGeneration += 1
        let generation = checkGeneration
        transition(.checking)
        var req = URLRequest(url: Self.latestReleaseEndpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("GravityBox/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")

        let transport: (URLRequest, @escaping (Data?, URLResponse?, Error?) -> Void) -> Void
        #if NATIVE_UI_TEST
        transport = checkTransport ?? { request, completion in URLSession.shared.dataTask(with: request, completionHandler: completion).resume() }
        #else
        transport = { request, completion in URLSession.shared.dataTask(with: request, completionHandler: completion).resume() }
        #endif
        transport(req) { [weak self] data, response, error in
          DispatchQueue.main.async {
            guard let self, generation == self.checkGeneration, self.checkInFlight else { return }
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
          }
        }
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
