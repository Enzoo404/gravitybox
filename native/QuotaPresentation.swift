import Cocoa

/// Shared presentation layer for the backend quota contract.
///
/// The backend passes `familyWindows` / `argonStatus` / `carbonStatus` / `standaloneModels` /
/// `quotaWarnings` / `refreshState` at the top level of account cards and dashboard accounts.
/// Fractions are 0...1 and are converted to percent only here. Legacy percent fields remain a
/// fallback for older fixtures, but a legacy weekly value is never relabelled as a 5-hour value.
enum QuotaPresentation {
    static let staleResetText = "数据已过期"
    private static let extraStandaloneGeminiRegex = try? NSRegularExpression(
        pattern: "^gemini-[4-9](?:\\.[0-9]+)?-([a-z][a-z0-9]*?)(?:-(?:trial|preview|exp|disabled))?$",
        options: [.caseInsensitive]
    )

    struct Window {
        var percentage: Int?
        var known: Bool
        var stale: Bool
        var resetCountdown: String
        var observedAt: Double?
        var source: String
        var unknownReason: String

        var staleText: String { staleResetText }
        var resetText: String {
            if known && stale { return resetCountdown.isEmpty ? staleResetText : "\(resetCountdown) · \(staleResetText)" }
            if known { return resetCountdown }
            return ""
        }
        var placeholder: String {
            if stale && !known { return "已过期" }
            if unknownReason.contains("失败") { return "读取失败" }
            if unknownReason.contains("未读取") || unknownReason.contains("尚未") { return "未知" }
            return "未知"
        }
    }

    struct Argon {
        var key: String = "argon"
        var modelName: String = "Gemini 4 Argon"
        var availability: String   // available | disabled | unknown
        var quotaState: String     // known | not_reported | stale
        var period: String?        // 5h | weekly | unspecified | nil
        var remaining: Double?     // fraction 0...1
        var resetCountdown: String
        var message: String
        var observedAt: Double?
        var source: String?

        var percentage: Int? {
            guard ["known", "stale"].contains(quotaState), let remaining, remaining.isFinite else { return nil }
            return Int((min(1, max(0, remaining)) * 100).rounded())
        }
        var stale: Bool { quotaState == "stale" }
        var periodLabel: String {
            switch period {
            case "5h": return "5小时"
            case "weekly": return "每周"
            case "unspecified": return "周期未知"
            default: return ""
            }
        }
        var title: String {
            if (quotaState == "known" || quotaState == "stale") && percentage != nil {
                switch period {
                case "weekly": return "\(modelName) · 每周"
                case "5h": return "\(modelName) · 5 小时"
                case "unspecified": return modelName
                default: return modelName
                }
            }
            return modelName
        }
        var placeholder: String {
            if stale { return "已过期" }
            switch availability {
            case "disabled": return "不可用"
            case "available": return "配额未知"
            default: return "未知"
            }
        }
        var resetText: String {
            if stale {
                let base = resetCountdown.isEmpty ? "" : "\(resetCountdown) · "
                return base + staleResetText
            }
            if quotaState == "known" {
                if period == "unspecified" { return resetCountdown.isEmpty ? "周期未知" : resetCountdown }
                return resetCountdown
            }
            switch availability {
            case "disabled": return ""
            case "available": return "配额未知"
            default: return "配额未知"
            }
        }
        var compactText: String {
            if stale { return "\(modelName) · 数据已过期" }
            if quotaState == "known" { return modelName }
            if key != "argon" {
                switch availability {
                case "disabled": return "\(modelName) · 不可用"
                default: return "\(modelName) · 配额未知"
                }
            }
            switch availability {
            case "disabled": return "Gemini 4 Argon · 不可用"
            case "available": return "Gemini 4 Argon · 配额未知"
            default: return "Gemini 4 Argon · 配额未知"
            }
        }
    }

    struct Contract {
        var hasContract = false
        var gemini5h: Window?
        var geminiWeekly: Window?
        var claude5h: Window?
        var claudeWeekly: Window?
        var geminiModel: Window?
        var claudeModel: Window?
        var argon: Argon?
        var carbon: Argon?
        var standaloneModels: [Argon] = []
        var quotaWarnings: [String] = []
        var quotaWarningCodes: [String] = []
        var refreshComplete: Bool?
        var refreshMessage = ""
        var geminiPrimary: PrimaryWindow { primaryWindow(gemini5h, model: geminiModel) }
        var claudePrimary: PrimaryWindow { primaryWindow(claude5h, model: claudeModel) }
        /// Extra standalone models beyond Argon and Carbon (automatically detected new models/groups)
        var extraStandaloneModels: [Argon] {
            standaloneModels.filter { $0.key != "argon" && $0.key != "carbon" }
        }
    }

    struct PrimaryWindow {
        var window: Window?
        var label: String
    }

    private static func primaryWindow(_ fiveHour: Window?, model: Window?) -> PrimaryWindow {
        if let fiveHour, fiveHour.known && !fiveHour.stale { return PrimaryWindow(window: fiveHour, label: "5 小时") }
        if let model, model.known && (!model.stale || fiveHour?.known != true) {
            return PrimaryWindow(window: model, label: "模型配额")
        }
        return PrimaryWindow(window: fiveHour, label: "5 小时")
    }

    static func missingWindowPlaceholder(otherPercentage: Int?) -> String {
        "未知"
    }

    // MARK: - Parsing

    static func dict(_ any: Any?) -> [String: Any]? { any as? [String: Any] }

    static func number(_ any: Any?) -> Double? {
        if let n = any as? NSNumber { return n.doubleValue }
        if let d = any as? Double { return d }
        if let i = any as? Int { return Double(i) }
        if let s = any as? String, let d = Double(s) { return d }
        return nil
    }

    static func boolValue(_ any: Any?) -> Bool? {
        if let b = any as? Bool { return b }
        if let n = any as? NSNumber { return n.boolValue }
        return nil
    }

    static func text(_ any: Any?) -> String {
        (any as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    /// Backend contract fractions are 0...1. Anything outside the range is rejected (no fake 100%).
    static func fraction(_ any: Any?) -> Double? {
        guard let value = number(any), value.isFinite, value >= 0, value <= 1 else { return nil }
        return value
    }

    private static func percent(_ fraction: Double?) -> Int? {
        guard let fraction, fraction.isFinite else { return nil }
        return Int((min(1, max(0, fraction)) * 100).rounded())
    }

    private static func fallbackWindow(percentValue: Int?, countdown: String, unknownReason: String) -> Window? {
        guard let percentValue else { return nil }
        return Window(percentage: max(0, min(100, percentValue)), known: true, stale: false,
                      resetCountdown: countdown, observedAt: nil, source: "legacy", unknownReason: unknownReason)
    }

    private static func window(_ raw: Any?, unknownReason: String) -> Window? {
        guard let raw = dict(raw) else { return nil }
        let knownFlag = boolValue(raw["known"]) ?? false
        let remaining = fraction(raw["remaining"])
        let stale = boolValue(raw["stale"]) ?? false
        let countdown = text(raw["resetCountdown"])
        let observed = number(raw["observedAt"])
        let source = text(raw["source"])
        let percentage = knownFlag ? percent(remaining) : nil
        return Window(percentage: percentage, known: knownFlag && percentage != nil,
                      stale: stale, resetCountdown: countdown, observedAt: observed, source: source,
                      unknownReason: knownFlag ? "接口未返回可用数值" : unknownReason)
    }

    private static func argon(_ raw: [String: Any]?, defaultKey: String = "argon", defaultModelName: String = "Gemini 4 Argon") -> Argon? {
        guard let raw else { return nil }
        let key = text(raw["key"]).isEmpty ? defaultKey : text(raw["key"])
        let rawDisplay = !text(raw["displayName"]).isEmpty ? text(raw["displayName"]) : text(raw["modelName"])
        let resolvedName: String
        if key == "argon" {
            resolvedName = "Gemini 4 Argon"
        } else if key == "carbon" {
            resolvedName = "Gemini 4 Carbon"
        } else if !rawDisplay.isEmpty {
            resolvedName = ModelDisplayName.name(rawDisplay)
        } else {
            resolvedName = ModelDisplayName.name(defaultModelName)
        }
        let availability = text(raw["availability"]).isEmpty ? "unknown" : text(raw["availability"])
        let remaining = fraction(raw["remaining"])
        let state = text(raw["quotaState"]).isEmpty ? (remaining != nil ? "known" : "not_reported") : text(raw["quotaState"])
        return Argon(key: key, modelName: resolvedName, availability: availability, quotaState: state,
                     period: raw["period"] as? String, remaining: remaining,
                     resetCountdown: text(raw["resetCountdown"]), message: text(raw["message"]),
                     observedAt: number(raw["observedAt"]), source: raw["source"] as? String)
    }

    private static func familyWindow(_ familyWindows: [String: Any]?, family: String, key: String, label: String) -> Window? {
        guard let familyWindows = dict(familyWindows?[family]) else { return nil }
        return window(familyWindows[key], unknownReason: "接口未返回\(label)窗口")
    }

    /// Parses top-level contract fields, falling back to legacy percent fields without inventing
    /// windows. Legacy sentinel `以周限额为准` explicitly means the 5-hour window was not returned.
    static func contract(_ raw: [String: Any]) -> Contract {
        var result = Contract()
        let nested = dict(raw["quota"])
        let familyWindows = dict(raw["familyWindows"]) ?? nested.flatMap { dict($0["familyWindows"]) }
        let modelQuota = dict(raw["familyModelQuota"]) ?? nested.flatMap { dict($0["familyModelQuota"]) }
        let argonRaw = dict(raw["argonStatus"]) ?? nested.flatMap { dict($0["argonStatus"]) }
        let carbonRaw = dict(raw["carbonStatus"]) ?? nested.flatMap { dict($0["carbonStatus"]) }
        let standaloneRaw = (raw["standaloneModels"] as? [[String: Any]]) ?? nested.flatMap { $0["standaloneModels"] as? [[String: Any]] }
        result.hasContract = familyWindows != nil || argonRaw != nil || carbonRaw != nil || modelQuota != nil
        result.geminiModel = window(modelQuota?["gemini"], unknownReason: "接口未返回模型配额")
        result.claudeModel = window(modelQuota?["claude"], unknownReason: "接口未返回模型配额")
        result.quotaWarnings = (raw["quotaWarnings"] as? [String]) ?? nested.flatMap { $0["quotaWarnings"] as? [String] } ?? []
        result.quotaWarningCodes = (raw["quotaWarningCodes"] as? [String]) ?? nested.flatMap { $0["quotaWarningCodes"] as? [String] } ?? []
        let refreshState = dict(raw["refreshState"]) ?? nested.flatMap { dict($0["refreshState"]) }
        if let refreshState {
            result.refreshComplete = boolValue(refreshState["complete"])
            result.refreshMessage = text(refreshState["message"])
        }

        if let familyWindows, result.hasContract {
            result.gemini5h = familyWindow(familyWindows, family: "gemini", key: "fiveHour", label: "Gemini 5 小时")
            result.geminiWeekly = familyWindow(familyWindows, family: "gemini", key: "weekly", label: "Gemini 每周")
            result.claude5h = familyWindow(familyWindows, family: "claude", key: "fiveHour", label: "Claude/GPT 5 小时")
            result.claudeWeekly = familyWindow(familyWindows, family: "claude", key: "weekly", label: "Claude/GPT 每周")
        }
        let rawModels = (raw["models"] as? [[String: Any]]) ?? (nested?["models"] as? [[String: Any]]) ?? []
        if let argonRaw {
            result.argon = argon(argonRaw, defaultKey: "argon", defaultModelName: "Gemini 4 Argon")
        } else if !result.hasContract {
            let argonModels = rawModels.filter { m in
                let name = (m["name"] as? String ?? (m["model_id"] as? String ?? "")).lowercased()
                let display = (m["display_name"] as? String ?? "").lowercased()
                return (m["is_argon"] as? Bool == true) || name.contains("argon") || display.contains("argon")
            }
            let allArgonDisabled = !argonModels.isEmpty && argonModels.allSatisfy { m in
                let name = (m["name"] as? String ?? (m["model_id"] as? String ?? "")).lowercased()
                return (m["disabled"] as? Bool == true) || name.contains("disabled")
            }
            // Legacy fallback. `argonWeeklyRemaining` never proves a weekly period, so it is shown
            // as an unspecified-period value instead of fabricating "每周".
            let legacyArgon = (raw["argonWeeklyRemaining"] as? Int)
            if allArgonDisabled {
                result.argon = Argon(key: "argon", modelName: "Gemini 4 Argon", availability: "disabled", quotaState: "not_reported", period: nil,
                                     remaining: nil, resetCountdown: "",
                                     message: "当前账号无 Gemini 4 Argon 权限",
                                     observedAt: nil, source: "legacy")
            } else if let legacyArgon {
                result.argon = Argon(key: "argon", modelName: "Gemini 4 Argon", availability: "unknown", quotaState: "known", period: "unspecified",
                                     remaining: Double(max(0, min(100, legacyArgon))) / 100.0,
                                     resetCountdown: text(raw["argonWeeklyResetCountdown"]),
                                     message: "旧版接口返回的 Argon 额度未标明周期",
                                     observedAt: nil, source: "legacy")
            } else {
                result.argon = Argon(key: "argon", modelName: "Gemini 4 Argon", availability: "unknown", quotaState: "not_reported", period: nil,
                                     remaining: nil, resetCountdown: "",
                                     message: "本轮接口未返回 Argon 模型记录，无法判断权限或额度 · 不代表无权限",
                                     observedAt: nil, source: nil)
            }
        }

        if let carbonRaw {
            result.carbon = argon(carbonRaw, defaultKey: "carbon", defaultModelName: "Gemini 4 Carbon")
        } else if !result.hasContract {
            let carbonModels = rawModels.filter { m in
                let name = (m["name"] as? String ?? (m["model_id"] as? String ?? "")).lowercased()
                let display = (m["display_name"] as? String ?? "").lowercased()
                return (m["is_carbon"] as? Bool == true) || name.contains("carbon") || display.contains("carbon")
            }
            let allCarbonDisabled = !carbonModels.isEmpty && carbonModels.allSatisfy { m in
                let name = (m["name"] as? String ?? (m["model_id"] as? String ?? "")).lowercased()
                return (m["disabled"] as? Bool == true) || name.contains("disabled")
            }
            let legacyCarbon = (raw["carbonWeeklyRemaining"] as? Int)
            if allCarbonDisabled {
                result.carbon = Argon(key: "carbon", modelName: "Gemini 4 Carbon", availability: "disabled", quotaState: "not_reported", period: nil,
                                      remaining: nil, resetCountdown: "",
                                      message: "当前账号无 Gemini 4 Carbon 权限（不可用）",
                                      observedAt: nil, source: "legacy")
            } else if let legacyCarbon {
                result.carbon = Argon(key: "carbon", modelName: "Gemini 4 Carbon", availability: "unknown", quotaState: "known", period: "unspecified",
                                      remaining: Double(max(0, min(100, legacyCarbon))) / 100.0,
                                      resetCountdown: text(raw["carbonWeeklyResetCountdown"]),
                                      message: "Carbon 旧版额度未标明周期（剩余 \(legacyCarbon)%）",
                                      observedAt: nil, source: "legacy")
            } else if let enabledCarbon = carbonModels.first(where: { ($0["disabled"] as? Bool) != true }) {
                let ownPct = (enabledCarbon["own_percentage"] as? Int) ?? ((enabledCarbon["percentage_known"] as? Bool == true) ? (enabledCarbon["percentage"] as? Int) : nil)
                let cd = text(enabledCarbon["reset_countdown"])
                if let ownPct {
                    result.carbon = Argon(key: "carbon", modelName: "Gemini 4 Carbon", availability: "available", quotaState: "known", period: "unspecified",
                                          remaining: Double(max(0, min(100, ownPct))) / 100.0,
                                          resetCountdown: cd,
                                          message: "Carbon 模型记录存在，已取得未标明窗口的额度（剩余 \(ownPct)%）",
                                          observedAt: nil, source: "legacy")
                } else {
                    result.carbon = Argon(key: "carbon", modelName: "Gemini 4 Carbon", availability: "available", quotaState: "not_reported", period: nil,
                                          remaining: nil, resetCountdown: "",
                                          message: "存在 Carbon 模型记录，但本轮未返回可用配额数值",
                                          observedAt: nil, source: "legacy")
                }
            } else {
                result.carbon = Argon(key: "carbon", modelName: "Gemini 4 Carbon", availability: "unknown", quotaState: "not_reported", period: nil,
                                      remaining: nil, resetCountdown: "",
                                      message: "本轮接口未返回 Carbon 模型记录，无法判断权限或额度 · 不代表无权限",
                                      observedAt: nil, source: nil)
            }
        }

        if result.carbon == nil {
            result.carbon = Argon(key: "carbon", modelName: "Gemini 4 Carbon", availability: "unknown", quotaState: "not_reported", period: nil,
                remaining: nil, resetCountdown: "", message: "本轮未返回 Carbon 配额或权限", observedAt: nil, source: nil)
        }

        if let standaloneRaw, !standaloneRaw.isEmpty {
            result.standaloneModels = standaloneRaw.compactMap { item in
                let k = text(item["key"]).isEmpty ? "other" : text(item["key"])
                let name = text(item["displayName"]).isEmpty ? k : text(item["displayName"])
                return argon(item, defaultKey: k, defaultModelName: name)
            }
            if let firstArgon = result.standaloneModels.first(where: { $0.key == "argon" }) {
                result.argon = firstArgon
            }
            if let firstCarbon = result.standaloneModels.first(where: { $0.key == "carbon" }) {
                result.carbon = firstCarbon
            }
        } else {
            var list: [Argon] = []
            if let a = result.argon { list.append(a) }
            if let c = result.carbon { list.append(c) }
            // Auto-detect any extra standalone Gemini 4+ models from rawModels when standaloneModels array is absent
            var seenKeys: Set<String> = ["argon", "carbon", "gemini-4-argon", "gemini-4-carbon"]
            for m in rawModels {
                let rawId = (m["model_id"] as? String ?? (m["name"] as? String ?? "")).lowercased()
                let family = (m["family"] as? String ?? "").lowercased()
                let isExtraGemini4: Bool = {
                    guard let match = extraStandaloneGeminiRegex?.firstMatch(in: rawId, range: NSRange(location: 0, length: (rawId as NSString).length)) else { return false }
                    let code = (rawId as NSString).substring(with: match.range(at: 1)).lowercased()
                    return !["argon", "carbon", "hydrogen", "pro", "flash", "ultra", "nano", "lite", "default"].contains(code)
                }()
                guard family == "other" || isExtraGemini4 else { continue }
                let baseKey = rawId.replacingOccurrences(of: "-(?:trial|preview|exp|disabled|tiered|latest)$", with: "", options: .regularExpression)
                guard !baseKey.isEmpty, !seenKeys.contains(baseKey) else { continue }
                seenKeys.insert(baseKey)
                let title = (m["display_name"] as? String)?.replacingOccurrences(of: "\\s+(?:Trial|Preview|Exp)$", with: "", options: .regularExpression) ?? ModelDisplayName.name(baseKey)
                let isDisabled = (m["disabled"] as? Bool == true) || rawId.contains("disabled")
                let pct = (m["own_percentage"] as? Int) ?? ((m["percentage_known"] as? Bool == true) ? (m["percentage"] as? Int) : nil)
                let cd = text(m["reset_countdown"])
                if isDisabled {
                    list.append(Argon(key: baseKey, modelName: title, availability: "disabled", quotaState: "not_reported", period: nil,
                                      remaining: nil, resetCountdown: "", message: "当前账号无 \(title) 权限（不可用）", observedAt: nil, source: "legacy"))
                } else if let pct {
                    list.append(Argon(key: baseKey, modelName: title, availability: "available", quotaState: "known", period: "unspecified",
                                      remaining: Double(max(0, min(100, pct))) / 100.0, resetCountdown: cd, message: "\(title) 配额已取得", observedAt: nil, source: "legacy"))
                } else {
                    list.append(Argon(key: baseKey, modelName: title, availability: "available", quotaState: "not_reported", period: nil,
                                      remaining: nil, resetCountdown: "", message: "存在 \(title) 模型记录，但本轮未返回可用配额数值", observedAt: nil, source: "legacy"))
                }
            }
            result.standaloneModels = list
        }

        if !result.hasContract {
            let g5Countdown = text(raw["geminiFiveHourResetCountdown"])
            let gWeekCountdown = text(raw["geminiWeeklyResetCountdown"])
            let g5Raw = (raw["geminiFiveHourRemaining"] as? Int) ?? (raw["fiveHourRemaining"] as? Int)
            let gWeekRaw = (raw["geminiWeeklyRemaining"] as? Int) ?? (raw["weeklyRemaining"] as? Int)
            let c5Raw = raw["claudeFiveHourRemaining"] as? Int
            let cWeekRaw = raw["claudeWeeklyRemaining"] as? Int
            let sentinel = g5Countdown.contains("以周限额为准")
            if sentinel {
                result.gemini5h = Window(percentage: nil, known: false, stale: false, resetCountdown: "",
                                         observedAt: nil, source: "legacy",
                                         unknownReason: "仅返回每周窗口，5 小时窗口未返回")
            } else if let g5Raw {
                let cd = g5Countdown.isEmpty && gWeekRaw == nil ? text(raw["geminiResetCountdown"]) : g5Countdown
                result.gemini5h = fallbackWindow(percentValue: g5Raw, countdown: cd, unknownReason: "接口未返回 5 小时窗口")
            }
            if let gWeekRaw {
                let cd = gWeekCountdown.isEmpty && g5Raw == nil ? text(raw["geminiResetCountdown"]) : gWeekCountdown
                result.geminiWeekly = fallbackWindow(percentValue: gWeekRaw, countdown: cd, unknownReason: "接口未返回每周窗口")
            }
            if let c5Raw {
                result.claude5h = fallbackWindow(percentValue: c5Raw, countdown: text(raw["claudeFiveHourResetCountdown"]),
                                                unknownReason: "接口未返回 Claude/GPT 5 小时窗口")
            }
            if let cWeekRaw {
                let cd = text(raw["claudeWeeklyResetCountdown"]).isEmpty && c5Raw == nil
                    ? text(raw["claudeResetCountdown"]) : text(raw["claudeWeeklyResetCountdown"])
                result.claudeWeekly = fallbackWindow(percentValue: cWeekRaw, countdown: cd, unknownReason: "接口未返回 Claude/GPT 每周窗口")
            }
        }
        return result
    }

    // MARK: - Shared display helpers

    /// Menu line: still uses the "Gemini 5小时 X% · 每周 Y%" shell so existing menu layout stays,
    /// but unknown/stale windows are labelled instead of fabricated.
    static func menuQuotaText(_ raw: [String: Any]) -> String {
        let contract = contract(raw)
        func part(_ name: String, _ window: Window?) -> String {
            guard let window else { return "\(name) 未知" }
            if let percentage = window.percentage {
                return "\(name) \(percentage)%" + (window.stale ? " · 数据已过期" : "")
            }
            return "\(name) 未知"
        }
        var line = "Gemini " + part(contract.geminiPrimary.label, contract.geminiPrimary.window) + " · " + part("每周", contract.geminiWeekly)
        if contract.quotaWarnings.isEmpty && contract.refreshComplete == false { line += " · 部分刷新" }
        return line
    }

    static func menuAccountSummary(_ raw: [String:Any]) -> String {
        let value = contract(raw)
        func part(_ name: String, _ primary: PrimaryWindow, _ weekly: Window?) -> String {
            let first = primary.window?.known == true ? primary.window : nil
            guard let window = first ?? weekly else { return "\(name) 未知" }
            if window.stale { return "\(name) 已过期" }
            guard let pct = window.percentage else { return "\(name) 未知" }
            return "\(name) \(first == nil ? "每周" : primary.label.replacingOccurrences(of: " ", with: "")) \(pct == 0 ? "已耗尽" : "\(pct)%")"
        }
        let g = part("Gemini", value.geminiPrimary, value.geminiWeekly)
        let c = part("Claude/GPT", value.claudePrimary, value.claudeWeekly)
        return [g,c].joined(separator:"\n")
    }

    static func warningSummary(_ contract: Contract, excluding: [String] = []) -> String {
        if !contract.quotaWarnings.isEmpty {
            var seen = Set<String>()
            let messages = contract.quotaWarnings.filter { warning in
                // Argon / Carbon already carry this explanation beside their own quota bars.
                !warning.hasPrefix("ARGON_") && !warning.hasPrefix("CARBON_")
                    && warning != contract.argon?.message && warning != contract.carbon?.message
            }.map { warning -> String in
                if let range = warning.range(of: ": ") { return String(warning[range.upperBound...]) }
                return warning
            }.filter { !excluding.contains($0) && seen.insert($0).inserted }
            if !messages.isEmpty {
                return messages.prefix(2).joined(separator: "；") + (messages.count > 2 ? "；另有 \(messages.count - 2) 项配额提示" : "")
            }
            if !excluding.isEmpty { return "" }
        }
        if contract.refreshComplete == false { return "本轮配额刷新部分完成；未返回的窗口等待下次刷新。" }
        return ""
    }

    static func fingerprint(_ raw: [String: Any]) -> String {
        let fields = ["familyWindows", "familyModelQuota", "argonStatus", "carbonStatus", "standaloneModels", "refreshState", "quotaWarnings"].reduce(into: [String: Any]()) {
            if let value = raw[$1] { $0[$1] = value }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]),
              let value = String(data: data, encoding: .utf8) else { return "" }
        return value
    }
}
