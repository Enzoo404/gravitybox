import Cocoa

struct DesktopApplicationTarget {
    static var applicationsDirectory = "/Applications"
    static var installedChannelsOverride: [String]? = nil

    static var allTargets: [DesktopApplicationTarget] { [DesktopApplicationTarget()] }

    static func installedChannels() -> [String] {
        if let override = installedChannelsOverride { return override.filter { $0 == "stable" } }
        return FileManager.default.fileExists(atPath: DesktopApplicationTarget().path) ? ["stable"] : []
    }

    static var bothInstalled: Bool { false }
    static func effectiveChannel(configured: String) -> String { "stable" }

    // Accept the old initializer shape for configuration migration, never select another app.
    init(channel: String = "stable") {}
    var channel: String { "stable" }
    var bundleName: String { "Antigravity" }
    var name: String { "Antigravity" }
    var label: String { "Antigravity" }
    var path: String { (Self.applicationsDirectory as NSString).appendingPathComponent("Antigravity.app") }
    var bundleIdentifier: String { "com.google.antigravity" }
    var supportsAccountSwitch: Bool { true }

    func matches(_ app: NSRunningApplication) -> Bool { matchesStrict(app) }
    func matchesStrict(_ app: NSRunningApplication) -> Bool {
        app.bundleIdentifier == bundleIdentifier && app.bundleURL?.standardizedFileURL.path == URL(fileURLWithPath: path).standardizedFileURL.path
    }
    static func matchesAny(_ app: NSRunningApplication) -> Bool { DesktopApplicationTarget().matchesStrict(app) }
    static func preferredLaunchPath(fallbackChannel: String = "stable") -> String { DesktopApplicationTarget().path }
}

struct AppConfiguration: Codable {
    var schema = 2
    var lastPage = 0
    var navigationVersion: Int?
    var quotaRefreshMinutes = 0
    var localizationShortcutEnabled = true
    var syncAntigravityLifecycle = false
    var autoUpdateEnabled = false
    var lastCleanedVersion = ""
    var accountsCollapsed = false
    var menuSelectedTab = 0
    var menuUsagePeriod = 0
    var menuTrendMetric = "tokens"
    var applicationChannel = "stable"

    enum CodingKeys: String, CodingKey {
        case localizationShortcutEnabled, quotaRefreshMinutes, schema, lastPage, navigationVersion, syncAntigravityLifecycle, autoUpdateEnabled, lastCleanedVersion, accountsCollapsed, menuSelectedTab, menuUsagePeriod, menuTrendMetric, applicationChannel
    }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        localizationShortcutEnabled = (try? container.decode(Bool.self, forKey: .localizationShortcutEnabled)) ?? true
        quotaRefreshMinutes = (try? container.decode(Int.self, forKey: .quotaRefreshMinutes)) ?? 0
        schema = (try? container.decode(Int.self, forKey: .schema)) ?? 2
        lastPage = (try? container.decode(Int.self, forKey: .lastPage)) ?? 0
        navigationVersion = try? container.decode(Int.self, forKey: .navigationVersion)
        syncAntigravityLifecycle = (try? container.decode(Bool.self, forKey: .syncAntigravityLifecycle)) ?? false
        autoUpdateEnabled = (try? container.decode(Bool.self, forKey: .autoUpdateEnabled)) ?? false
        lastCleanedVersion = (try? container.decode(String.self, forKey: .lastCleanedVersion)) ?? ""
        accountsCollapsed = (try? container.decode(Bool.self, forKey: .accountsCollapsed)) ?? false
        if let channel = try container.decodeIfPresent(String.self, forKey: .applicationChannel) {
            guard ["stable", "insiders"].contains(channel) else { throw BackendFailure(message: "应用版本选择无效，原配置已保留。") }
            applicationChannel = "stable"
        }
        menuSelectedTab = max(0, min(2, (try? container.decode(Int.self, forKey: .menuSelectedTab)) ?? 0))
        menuUsagePeriod = max(0, min(3, (try? container.decode(Int.self, forKey: .menuUsagePeriod)) ?? 0))
        if let rawMetric = try? container.decode(String.self, forKey: .menuTrendMetric), ["tokens", "requests"].contains(rawMetric) {
            menuTrendMetric = rawMetric
        } else {
            menuTrendMetric = "tokens"
        }
    }

    mutating func migrateNavigation() {
        guard navigationVersion != 5 else { return }
        if navigationVersion == 4 {
            // 5-page (0:总览,1:账号,2:用量,3:缓存,4:设置) -> 4-page (0:总览,1:账号,2:用量,3:设置)
            lastPage = [0: 0, 1: 1, 2: 2, 3: 3, 4: 3][lastPage] ?? 0
        } else if navigationVersion == 3 {
            // 4-page (0:总览,1:账号,2:用量,3:设置) -> 4-page (0:总览,1:账号,2:用量,3:设置)
            lastPage = min(3, max(0, lastPage))
        } else if navigationVersion == 2 {
            // 5-page (0:总览,1:账号,2:用量,3:汉化,4:设置) -> 4-page (0:总览,1:账号,2:用量,3:设置)
            lastPage = [0: 0, 1: 1, 2: 2, 3: 3, 4: 3][lastPage] ?? 0
        } else {
            lastPage = [0: 0, 1: 1, 2: 3, 3: 3, 4: 3][lastPage] ?? 0
        }
        navigationVersion = 5
    }
}

final class ConfigurationStore {
    let file: URL
    var value: AppConfiguration
    private var retainedDocument: [String:Any] = [:]
    init(state: URL) throws {
        file = state.appendingPathComponent("config.json")
        let fm = FileManager.default
        try fm.createDirectory(at: state, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let data: Data
        do { data = try Data(contentsOf: file) }
        catch let error as NSError {
            guard error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError else { throw BackendFailure(message: "配置无法读取，原文件已保留。") }
            value = AppConfiguration(); return
        }
        if let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if raw["schema"] != nil && (raw["schema"] as? Int) != 2 { throw BackendFailure(message: "配置版本暂不支持，原文件已保留。") }
            if let channel = raw["applicationChannel"], !(channel is String && ["stable", "insiders"].contains(channel as! String)) {
                throw BackendFailure(message: "应用版本选择无效，原配置已保留。")
            }
            retainedDocument = raw
            if let current = try? JSONDecoder().decode(AppConfiguration.self, from: data) {
                value = current
                if raw["applicationChannel"] as? String == "insiders" {
                    let backup = state.appendingPathComponent("config-before-stable-only.json")
                    if !fm.fileExists(atPath: backup.path) {
                        guard fm.createFile(atPath: backup.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
                            throw BackendFailure(message: "旧配置备份失败，原文件已保留。")
                        }
                    }
                    try save()
                }
                return
            }
            value = AppConfiguration()
            return
        } else { throw BackendFailure(message: "配置文件格式损坏，已保留原文件。") }
    }
    func save() throws {
        value.applicationChannel = "stable"
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let encoded = try encoder.encode(value)
        // Merge with the latest disk document so navigation never removes retired or external fields.
        var document = retainedDocument
        if let data = try? Data(contentsOf: file) {
            guard let latest = try JSONSerialization.jsonObject(with: data) as? [String:Any],
                  latest["schema"] == nil || latest["schema"] as? Int == 2 else {
                throw BackendFailure(message: "配置已变化或损坏，原文件已保留。")
            }
            document = latest
        }
        let known = try JSONSerialization.jsonObject(with:encoded) as! [String:Any]
        for (key, value) in known { document[key] = value }
        let data = try JSONSerialization.data(withJSONObject:document,options:[.prettyPrinted,.sortedKeys])
        let temp = file.deletingLastPathComponent().appendingPathComponent("config-\(UUID().uuidString).tmp")
        guard FileManager.default.createFile(atPath: temp.path, contents: data, attributes: [.posixPermissions: 0o600]) else { throw BackendFailure(message: "配置无法写入，请检查磁盘空间和权限。") }
        defer { try? FileManager.default.removeItem(at: temp) }
        if rename(temp.path, file.path) != 0 { throw BackendFailure(message: "配置未能保存 · \(errno)，请重试。") }
    }
}
