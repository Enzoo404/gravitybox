import Cocoa
import CryptoKit
import Darwin

enum UpdatePackageIntegrity {
    static func failure(_ message: String) -> NSError {
        NSError(domain: "GravityBoxUpdate", code: 20, userInfo: [NSLocalizedDescriptionKey: message])
    }

    static func expectedHash(_ text: String, fileName: String) throws -> String {
        let lines = text.components(separatedBy: .newlines).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        let pattern = #"^([0-9a-fA-F]{64})[ \t]+\*?(.+?)$"#
        guard lines.count == 1,
              let match = lines[0].range(of: pattern, options: .regularExpression) else {
            throw failure("SHA-256 校验文件格式无效，已停止更新；当前版本仍可继续使用。")
        }
        let line = String(lines[0][match]), hash = String(line.prefix(64)).lowercased()
        var name = String(line.dropFirst(64)).trimmingCharacters(in: .whitespaces)
        if name.hasPrefix("*") { name.removeFirst() }
        guard name == fileName else { throw failure("SHA-256 校验文件与安装包名称不匹配，已停止更新。") }
        return hash
    }

    static func fileHash(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hash = SHA256()
        while let data = try handle.read(upToCount: 1_048_576), !data.isEmpty { hash.update(data: data) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func appHash(_ app: URL) throws -> String {
        var hash = SHA256()
        for path in ["Contents/MacOS/GravityBox", "Contents/Info.plist", "Contents/_CodeSignature/CodeResources"] {
            hash.update(data: Data(try fileHash(app.appendingPathComponent(path)).utf8))
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func verify(_ file: URL, expected: String) throws {
        guard try fileHash(file) == expected else { throw failure("安装包 SHA-256 校验不一致，已停止更新；当前版本仍可继续使用。") }
    }
}

/// Kept in the private updates directory until installation is confirmed or recovered.
struct UpdateInstallReceipt: Codable {
    var schema = 1
    var phase = "prepared"
    var token: String
    var targetPath: String
    var backupPath: String
    var expectedVersion: String
    var newAppHash: String
    var oldAppHash: String?
    var dmgPath: String

    func save(to url: URL) throws {
        let data = try JSONEncoder().encode(self)
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

/// The same implementation is exercised with synthetic app bundles and injected launch/failure hooks.
enum UpdateInstaller {
    static let receiptName = "install-receipt.json"

    static func executable(_ app: URL) -> URL { app.appendingPathComponent("Contents/MacOS/GravityBox") }

    static func version(_ app: URL) throws -> String {
        let data = try Data(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        guard let info = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let version = info["CFBundleShortVersionString"] as? String else { throw UpdatePackageIntegrity.failure("应用版本信息无效。") }
        return version
    }

    static func swap(_ first: URL, _ second: URL) throws {
        guard renameatx_np(AT_FDCWD, first.path, AT_FDCWD, second.path, UInt32(RENAME_SWAP)) == 0 else {
            throw UpdatePackageIntegrity.failure("无法原子替换应用，旧版本已保留（错误 \(errno)）。")
        }
    }

    static func validateApp(_ app: URL, version: String, appHash: String) throws {
        let info = try Data(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        guard let plist = try PropertyListSerialization.propertyList(from: info, format: nil) as? [String: Any],
              plist["CFBundleIdentifier"] as? String == "local.gravitybox.app",
              plist["CFBundleShortVersionString"] as? String == version,
              try UpdatePackageIntegrity.appHash(app) == appHash else {
            throw UpdatePackageIntegrity.failure("新版本应用身份、版本或内容不匹配，旧版本未被替换。")
        }
        let check = Process()
        check.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        check.arguments = ["--verify", "--deep", "--strict", app.path]
        check.standardOutput = FileHandle.nullDevice; check.standardError = FileHandle.nullDevice
        try check.run(); check.waitUntilExit()
        guard check.terminationStatus == 0 else { throw UpdatePackageIntegrity.failure("新版本应用签名完整性校验失败。") }
    }

    /// Copy onto the target volume before quitting; the existing app is untouched on any error.
    static func prepare(stagedApp: URL, target: URL, work: URL, version: String, dmg: URL, validate: (URL, String, String) throws -> Void = validateApp) throws -> URL {
        let fm = FileManager.default
        let backup = target.deletingLastPathComponent().appendingPathComponent(".GravityBox-backup-\(UUID().uuidString).app")
        let hash = try UpdatePackageIntegrity.appHash(stagedApp)
        try validate(stagedApp, version, hash)
        let oldHash = fm.fileExists(atPath: target.path) ? try UpdatePackageIntegrity.appHash(target) : nil
        do {
            try fm.copyItem(at: stagedApp, to: backup)
            try validate(backup, version, hash)
            let receipt = UpdateInstallReceipt(token: UUID().uuidString, targetPath: target.path, backupPath: backup.path,
                expectedVersion: version, newAppHash: hash, oldAppHash: oldHash, dmgPath: dmg.path)
            let file = work.appendingPathComponent(receiptName)
            try receipt.save(to: file)
            return file
        } catch {
            // Only this attempt's uninstalled copy; never the user's target app.
            try? fm.removeItem(at: backup)
            throw error
        }
    }

    static func launch(_ target: URL, receipt: URL?, token: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-n", target.path, "--args", "--restarted-after-update"]
        if let receipt { process.arguments! += ["--update-receipt", receipt.path, "--update-token", token] }
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        try process.run(); process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw UpdatePackageIntegrity.failure("新版本未能启动。") }
    }

    static func waitForReady(_ receipt: URL, token: String, timeout: TimeInterval = 40) -> Bool {
        let end = Date().addingTimeInterval(timeout), ready = receipt.deletingLastPathComponent().appendingPathComponent("ready")
        while Date() < end {
            if (try? String(contentsOf: ready, encoding: .utf8)) == token { return true }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return false
    }

    static func stopNewApp(_ target: URL) throws {
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: "local.gravitybox.app")
            .filter { $0.bundleURL?.resolvingSymlinksInPath().path == target.resolvingSymlinksInPath().path }
        for app in running { _ = app.terminate() }
        let end = Date().addingTimeInterval(3)
        while running.contains(where: { !$0.isTerminated }) && Date() < end { Thread.sleep(forTimeInterval: 0.1) }
        for app in running where !app.isTerminated { _ = app.forceTerminate() }
        let forcedEnd = Date().addingTimeInterval(2)
        while running.contains(where: { !$0.isTerminated }) && Date() < forcedEnd { Thread.sleep(forTimeInterval: 0.1) }
        guard running.allSatisfy({ $0.isTerminated }) else { throw UpdatePackageIntegrity.failure("新版本仍在运行，恢复副本已保留。") }
    }

    static func run(receiptURL: URL,
                    exchange: (URL, URL) throws -> Void = swap,
                    validate: (URL, String, String) throws -> Void = validateApp,
                    openApp: (URL, URL?, String) throws -> Void = launch,
                    awaitReady: (URL, String) -> Bool = { waitForReady($0, token: $1) },
                    stopApp: (URL) throws -> Void = stopNewApp) throws {
        let fm = FileManager.default
        var receipt = try JSONDecoder().decode(UpdateInstallReceipt.self, from: Data(contentsOf: receiptURL))
        guard receipt.schema == 1 else { throw UpdatePackageIntegrity.failure("更新恢复记录版本不受支持。") }
        let target = URL(fileURLWithPath: receipt.targetPath), backup = URL(fileURLWithPath: receipt.backupPath)
        guard target != backup, target.deletingLastPathComponent() == backup.deletingLastPathComponent(),
              backup.lastPathComponent.hasPrefix(".GravityBox-backup-") else { throw UpdatePackageIntegrity.failure("更新恢复路径无效。") }
        func currentHash(_ app: URL) -> String? { try? UpdatePackageIntegrity.appHash(app) }
        if receipt.phase == "confirmed" || receipt.phase == "rolled-back" { return }
        if receipt.oldAppHash != nil, currentHash(target) == receipt.oldAppHash,
           currentHash(backup) == receipt.newAppHash, ["installed", "recovery-required"].contains(receipt.phase) {
            // A previous helper restored the old app but stopped before persisting its result.
            receipt.phase = "rolled-back"; try receipt.save(to: receiptURL); return
        }
        var exchanged = currentHash(target) == receipt.newAppHash &&
            (receipt.oldAppHash == nil || currentHash(backup) == receipt.oldAppHash)
        do {
            if !exchanged {
                guard currentHash(target) == receipt.oldAppHash else { throw UpdatePackageIntegrity.failure("目标应用已由其他程序改变，已保留恢复材料。") }
                try validate(backup, receipt.expectedVersion, receipt.newAppHash)
                if receipt.oldAppHash != nil { try exchange(backup, target) }
                else { try fm.moveItem(at: backup, to: target) }
                exchanged = true
            }
            receipt.phase = "installed"; try receipt.save(to: receiptURL)
            try validate(target, receipt.expectedVersion, receipt.newAppHash)
            try openApp(target, receiptURL, receipt.token)
            guard awaitReady(receiptURL, receipt.token) else { throw UpdatePackageIntegrity.failure("新版本后台未能就绪。") }
            receipt.phase = "confirmed"; try receipt.save(to: receiptURL)
            // Keep the old app and receipt as a recovery point. Startup cleanup must not remove them.
        } catch {
            if exchanged {
                do {
                    guard currentHash(target) == receipt.newAppHash else { throw UpdatePackageIntegrity.failure("目标应用已变化，停止覆盖。") }
                    try stopApp(target)
                    guard currentHash(target) == receipt.newAppHash else { throw UpdatePackageIntegrity.failure("目标应用已变化，停止覆盖。") }
                    if let oldHash = receipt.oldAppHash {
                        guard currentHash(backup) == oldHash else { throw UpdatePackageIntegrity.failure("旧版本恢复副本已变化。") }
                        try validate(backup, version(backup), oldHash)
                        try exchange(backup, target)
                    } else { try fm.moveItem(at: target, to: backup) }
                    receipt.phase = "rolled-back"; try receipt.save(to: receiptURL)
                    if receipt.oldAppHash != nil { try? openApp(target, nil, "") }
                } catch {
                    receipt.phase = "recovery-required"; try? receipt.save(to: receiptURL)
                    throw UpdatePackageIntegrity.failure("更新未完成，自动恢复受阻；旧版本及恢复记录已保留在 \(receiptURL.deletingLastPathComponent().path)。")
                }
            }
            throw error
        }
    }

    private static func launchReceipt(arguments: [String], state: URL, bundle: URL) -> (URL, UpdateInstallReceipt)? {
        guard let i = arguments.firstIndex(of: "--update-receipt"), i + 1 < arguments.count,
              let t = arguments.firstIndex(of: "--update-token"), t + 1 < arguments.count else { return nil }
        let requested = URL(fileURLWithPath: arguments[i + 1]).standardizedFileURL
        let file = requested.resolvingSymlinksInPath()
        let work = file.deletingLastPathComponent(), updates = state.resolvingSymlinksInPath().appendingPathComponent("updates/transactions").standardizedFileURL
        guard file.lastPathComponent == receiptName, work.lastPathComponent.hasPrefix("install-"),
              work.deletingLastPathComponent().path == updates.path,
              (try? requested.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == false,
              (try? requested.deletingLastPathComponent().resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == false,
              let data = try? Data(contentsOf: file),
              let receipt = try? JSONDecoder().decode(UpdateInstallReceipt.self, from: data),
              receipt.schema == 1, receipt.token == arguments[t + 1],
              URL(fileURLWithPath: receipt.targetPath).resolvingSymlinksInPath().path == bundle.resolvingSymlinksInPath().path,
              let info = try? Data(contentsOf: bundle.appendingPathComponent("Contents/Info.plist")),
              let plist = (try? PropertyListSerialization.propertyList(from: info, format: nil)) as? [String: Any],
              plist["CFBundleIdentifier"] as? String == "local.gravitybox.app",
              plist["CFBundleShortVersionString"] as? String == receipt.expectedVersion,
              (try? UpdatePackageIntegrity.appHash(bundle)) == receipt.newAppHash else { return nil }
        return (file, receipt)
    }

    static func isConfirmed(arguments: [String], state: URL, bundle: URL) -> Bool {
        guard let (file, receipt) = launchReceipt(arguments: arguments, state: state, bundle: bundle),
              receipt.phase == "confirmed" else { return false }
        return (try? String(contentsOf: file.deletingLastPathComponent().appendingPathComponent("ready"), encoding: .utf8)) == receipt.token
    }

    /// A ready acknowledgement alone is not permission to clean packages; the helper must confirm first.
    @discardableResult
    static func acknowledge(arguments: [String], state: URL, bundle: URL) -> Bool {
        guard let (file, receipt) = launchReceipt(arguments: arguments, state: state, bundle: bundle) else { return false }
        do {
            try Data(receipt.token.utf8).write(to: file.deletingLastPathComponent().appendingPathComponent("ready"), options: .atomic)
            return true
        } catch { return false }
    }
}
