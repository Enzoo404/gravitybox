import Cocoa

@main struct QuotaContractFixture {
    static func check(_ value: Bool, _ message: String) {
        if !value { FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1) }
    }
    static func main() {
        let unknown: [String: Any] = ["availability":"unknown", "quotaState":"not_reported"]
        let weekly: [String: Any] = ["remaining":0.73, "known":true, "stale":false, "resetCountdown":"6天后重置"]
        let raw: [String: Any] = ["familyWindows":["gemini":["weekly":weekly]], "argonStatus":unknown,
            "geminiFiveHourRemaining":100, "argonWeeklyRemaining":100]
        let contract = QuotaPresentation.contract(raw)
        check(contract.gemini5h == nil, "New contract must override legacy fabricated 5h")
        check(contract.geminiWeekly?.percentage == 73, "Fraction conversion")
        let modelRaw: [String: Any] = ["familyWindows":["gemini":["weekly":weekly]],
            "familyModelQuota":["gemini":["remaining":1,"known":true,"stale":false,"resetCountdown":"4小时59分后重置"],
                                "claude":["remaining":1,"known":true,"stale":false,"resetCountdown":"6天23小时后重置"]]]
        let modelContract = QuotaPresentation.contract(modelRaw)
        check(modelContract.gemini5h == nil && modelContract.claude5h == nil, "Model quota must not fabricate a 5h window")
        check(modelContract.geminiPrimary.window?.percentage == 100 && modelContract.geminiPrimary.label == "模型配额", "Known model quota must remain visible")
        check(modelContract.claudePrimary.window?.resetText == "6天23小时后重置", "Weekly-length model reset must stay intact")
        check(QuotaPresentation.menuQuotaText(modelRaw).contains("模型配额 100%"), "Menu must display model value without fake period")
        check(QuotaPresentation.menuAccountSummary(modelRaw).contains("Claude/GPT 模型配额 100%"), "Account menu shares fallback semantics")
        check(QuotaPresentation.contract(["quota":modelRaw]).geminiPrimary.window?.percentage == 100, "Nested IPC shares model quota")
        var explicitRaw = modelRaw
        explicitRaw["familyWindows"] = ["gemini":["fiveHour":["remaining":0.4,"known":true,"stale":false]]]
        let explicit = QuotaPresentation.contract(explicitRaw)
        check(explicit.geminiPrimary.window?.percentage == 40 && explicit.geminiPrimary.label == "5 小时", "Explicit fresh period wins")
        var zeroRaw = modelRaw; zeroRaw["familyModelQuota"] = ["gemini":["remaining":0,"known":true,"stale":false]]
        check(QuotaPresentation.contract(zeroRaw).geminiPrimary.window?.percentage == 0, "Model zero is exhausted, never unknown")
        check(QuotaPresentation.fingerprint(modelRaw) != QuotaPresentation.fingerprint(zeroRaw), "Model-only updates repaint cards")
        check(contract.argon?.percentage == nil && contract.argon?.title == "Gemini 4 Argon", "No invented Argon week/value")
        check(contract.argon?.resetText == "配额未知", "Missing metadata cannot deny permission")
        check(QuotaPresentation.menuQuotaText(raw).contains("5 小时 未知 · 每周 73%"), "Menu shares contract")
        let nested = QuotaPresentation.contract(["quota":raw])
        check(nested.argon?.placeholder == contract.argon?.placeholder, "Nested IPC shares contract")
        let known = QuotaPresentation.contract(["argonStatus":["availability":"available", "quotaState":"known", "remaining":0.42, "period":"unspecified"]])
        check(known.argon?.percentage == 42 && known.argon?.title == "Gemini 4 Argon" && known.argon?.resetText == "周期未知", "Own quota must not claim weekly")
        let disabled = QuotaPresentation.contract(["argonStatus":["availability":"disabled", "quotaState":"not_reported"]])
        check(disabled.argon?.percentage == nil && disabled.argon?.placeholder == "不可用" && disabled.argon?.resetText == "", "Disabled is not zero and shows 不可用")
        let stale = QuotaPresentation.contract(["familyWindows":["gemini":["weekly":["remaining":0.6,"known":true,"stale":true]]],
            "argonStatus":["availability":"unknown", "quotaState":"stale", "remaining":0.3,"period":"weekly"]])
        check(stale.geminiWeekly?.percentage == 60 && stale.geminiWeekly?.resetText.contains("数据已过期") == true, "Carried values labelled")
        check(stale.argon?.percentage == 30 && stale.argon?.resetText.contains("数据已过期") == true, "Carried Argon labelled")
        check(QuotaPresentation.menuQuotaText(["familyWindows":["gemini":["weekly":["remaining":0.6,"known":true,"stale":true]]]]).contains("数据已过期"), "Menu labels stale")
        let invalid = QuotaPresentation.contract(["argonStatus":["quotaState":"known","remaining":12]])
        check(invalid.argon?.percentage == nil, "Invalid fraction cannot produce 100%")
        let legacy = QuotaPresentation.contract(["geminiFiveHourRemaining":73,"geminiWeeklyRemaining":73,"geminiFiveHourResetCountdown":"以周限额为准"])
        check(legacy.gemini5h?.percentage == nil && legacy.geminiWeekly?.percentage == 73, "Legacy copied value not revived")
        check(QuotaPresentation.fingerprint(raw) != QuotaPresentation.fingerprint(["argonStatus":["availability":"available"]]), "Contract changes repaint cards")
        let warning = QuotaPresentation.contract(["quotaWarnings":["UNVERIFIED_CLOUD_SCOPE: HTTP 403", "OTHER: Other information"]])
        check(QuotaPresentation.warningSummary(warning, excluding:["HTTP 403"]) == "Other information", "Refresh error not repeated; independent warnings retained")
        let same = QuotaPresentation.contract(["quotaWarnings":["UNVERIFIED_CLOUD_SCOPE: HTTP 403"], "refreshState":["complete":false]])
        check(QuotaPresentation.warningSummary(same, excluding:["HTTP 403"]).isEmpty, "Single failure renders only once")
        check(ModelDisplayName.name("gemini-3.8-flash-n") == "gemini-3.8-flash-n", "Opaque N ID must not collapse to base model")
        check(ModelDisplayName.name("claude-opus-5-5-high") == "Claude Opus 5.5 High", "Preserve exact effort variant")
        check(ModelDisplayName.name("gemini-4-argon-trial") == "Gemini 4 Argon Trial", "Preserve trial variant")
        check(ModelDisplayName.name("gemini-3.8-flash-exp-a") == "gemini-3.8-flash-exp-a", "Unknown variants stay exact")
        check(InterfaceText.quotaMessage("HTTP 403 (#3501)") == "许可校验失败 · 3501", "Concise service state")
        print("30 native quota assertions passed")
    }
}
