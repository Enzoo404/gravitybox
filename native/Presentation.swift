import Foundation

enum ModelDisplayName {
    private static let catalogNames: [String: String] = {
        var urls: [URL] = []
        if let resource = Bundle.main.resourceURL {
            urls.append(resource.appendingPathComponent("model-catalog.json"))
        }
        if let path = ProcessInfo.processInfo.environment["GRAVITYBOX_UI_RESOURCES"] {
            urls.append(URL(fileURLWithPath: path).appendingPathComponent("model-catalog.json"))
        }
        urls.append(URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("assets/model-catalog.json"))
        for url in urls {
            if let data = try? Data(contentsOf: url),
               let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let names = value["names"] as? [String: String] {
                return names
            }
        }
        return [:]
    }()

    static func name(_ identifier: String) -> String {
        let names = catalogNames
        let value = identifier.lowercased()
        if let name = names[value] { return name }
        if value.hasPrefix("google/"), let name = names[String(value.dropFirst(7))] { return name }
        for (suffix, label) in [("-extra-low", "Extra Low"), ("-high", "High"), ("-medium", "Medium"), ("-low", "Low"), ("-thinking", "Thinking")] where value.hasSuffix(suffix) {
            if let name = names[String(value.dropLast(suffix.count))] {
                return name + " " + label
            }
        }
        // Only normalize a known display-name qualifier. Opaque IDs stay exact.
        for qualifier in ["High", "Medium", "Low", "Thinking"] {
            for brackets in [(" (", ")"), ("（", "）")] {
                let suffix = brackets.0 + qualifier + brackets.1
                if identifier.hasSuffix(suffix) {
                    let base = String(identifier.dropLast(suffix.count))
                    if names.values.contains(base) { return base + " " + qualifier }
                }
            }
        }
        return identifier
    }
}

enum InterfaceText {
    static let shortDateTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MM-dd HH:mm"
        return formatter
    }()
    static let shortTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    static func countdown(_ raw: String) -> String {
        let pattern = try! NSRegularExpression(pattern: "([0-9]+)\\s*(天|小时|分钟|分|秒)")
        let value = NSMutableString(string: raw)
        let source = raw as NSString
        for match in pattern.matches(in: raw, range: NSRange(location: 0, length: source.length)).reversed() {
            let unit = source.substring(with: match.range(at: 2))
            value.replaceCharacters(in: match.range, with: source.substring(with: match.range(at: 1)) + " " + (unit == "分" ? "分钟" : unit))
        }
        return (value as String).replacingOccurrences(of: "(天|小时|分钟|秒)(?=[0-9])", with: "$1 ", options: .regularExpression)
    }

    static func quotaMessage(_ raw: String) -> String {
        if raw.contains("3501") { return "许可校验失败 · 3501" }
        if raw.range(of: "HTTP\\s*403", options: .regularExpression) != nil { return "配额查询受限 · 403" }
        if raw.range(of: "HTTP\\s*401|invalid_grant", options: .regularExpression) != nil { return "登录已失效" }
        if raw.contains("凭据") { return "登录凭据待更新" }
        if raw.contains("超时") || raw.contains("timeout") { return "配额查询超时" }
        if raw.contains("未返回") || raw.contains("未取得") || raw.contains("沿用") { return "配额未更新" }
        return raw.isEmpty ? "" : "配额刷新失败"
    }

    static func usageScope(scanned: Int, discovered: Int, failed: Int, skipped: Int, unknown: Int) -> String {
        var parts = [discovered > scanned ? "\(scanned)/\(discovered) 个会话数据库" : "\(scanned) 个会话数据库"]
        if failed > 0 { parts.append("\(failed) 个读取失败") }
        if skipped > 0 { parts.append("\(skipped) 条未读取") }
        if unknown > 0 { parts.append("\(unknown) 条时间未知") }
        return parts.joined(separator: " · ")
    }

    static func formatCompactTokens(_ count: Int, formatSmallWithLocale: Bool = false) -> String {
        if count >= 1_000_000_000 { return String(format: "%.1fB", Double(count) / 1_000_000_000.0) }
        if count >= 1_000_000 { return String(format: "%.1fM", Double(count) / 1_000_000.0) }
        if count >= 1_000 { return String(format: "%.1fK", Double(count) / 1_000.0) }
        return formatSmallWithLocale ? count.formatted() : "\(count)"
    }

    static func formatUsd(_ value: Double) -> String {
        if value <= 0 { return "$0.00" }
        if value < 0.001 { return "<$0.001" }
        if value < 0.01 { return String(format: "$%.3f", value) }
        return String(format: "$%.2f", value)
    }
}
