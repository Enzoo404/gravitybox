import Cocoa

@main struct NativeUIFixture {
    static var assertionCount = 0
    static func check(_ condition: Bool, _ message: String) {
        assertionCount += 1
        if !condition { FileHandle.standardError.write(Data((message+"\n").utf8)); exit(1) }
    }
    static func pump() {
        let end = Date().addingTimeInterval(0.15)
        while Date() < end { RunLoop.main.run(until:Date().addingTimeInterval(0.01)) }
    }
    @discardableResult
    static func waitUntil(
        timeout: TimeInterval = {
            if let custom = ProcessInfo.processInfo.environment["GRAVITYBOX_CI_TIMEOUT"], let val = TimeInterval(custom), val > 0 {
                return val
            }
            let isCI = ProcessInfo.processInfo.environment["CI"].map { !$0.isEmpty && $0 != "0" && $0.lowercased() != "false" } ?? false
            return isCI ? 10.0 : 3.0
        }(),
        step: TimeInterval = 0.05,
        description: String = "condition",
        condition: () -> Bool
    ) -> Bool {
        if condition() { return true }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(step))
            if condition() { return true }
        }
        let satisfied = condition()
        check(satisfied, "Timed out waiting for \(description) after \(timeout)s")
        return satisfied
    }
    static func capture(_ view: NSView, _ url: URL) throws {
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in:view.bounds) else { fatalError("No bitmap") }
        view.cacheDisplay(in:view.bounds,to:rep)
        try rep.representation(using:.png,properties:[:])!.write(to:url)
    }
    static func main() throws {
        let application = NSApplication.shared
        let interactive = CommandLine.arguments.contains("--interactive")
        application.setActivationPolicy(interactive ? .regular : .accessory)
        let state = URL(fileURLWithPath:CommandLine.arguments[1]), output = URL(fileURLWithPath:CommandLine.arguments[2])
        try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
        let assistant = Assistant(state:state)
        assistant.configuration = try ConfigurationStore(state:state)
        assistant.configuration.value.navigationVersion = 5
        assistant.bridge = BackendBridge(resources:state,state:state)
        assistant.reachable = true
        let status: [String:Any] = ["mode":"adaptive","windows":1,"entries":4300,"appVersion":"2.25.0","liveAccountEmail":"alex@example.invalid","activeAccountEmail":"alex@example.invalid","accountsRevision":"fixture","pid":-1]
        assistant.statusValue = LiveStatus(status)
        func bucket(_ percent: Double, reset: String = "2小时后重置") -> [String:Any] {
            ["remaining":percent/100,"known":true,"stale":false,"source":"live","observedAt":Date().timeIntervalSince1970,"resetCountdown":reset]
        }
        func account(_ id:String, _ name:String, _ email:String, _ current:Bool) -> [String:Any] {
            let windows:[String:Any] = ["gemini":["fiveHour":bucket(91),"weekly":bucket(33)],"claude":["fiveHour":bucket(current ? 0 : 100),"weekly":bucket(48)]]
            return ["id":id,"name":name,"email":email,"subscription_tier":"PRO","revision":id,"familyWindows":windows,"argonStatus":["availability":"available","quotaState":"known","period":"weekly","remaining":0.008],"quota":["last_updated":Date().timeIntervalSince1970,"source":"live"],"models":[]]
        }
        var accounts = [account("a","Alex","alex@example.invalid",true),account("b","无限","second-long-email@example.invalid",false),account("c","Charlie","third@example.invalid",false)]
        accounts[2]["subscription_tier"] = "FREE"
        accounts[2]["familyWindows"] = ["gemini":["weekly":bucket(100,reset:"6天23小时后重置")],"claude":["weekly":bucket(100,reset:"6天23小时后重置")]]
        accounts[2]["familyModelQuota"] = ["gemini":bucket(100,reset:"4小时59分后重置"),"claude":bucket(100,reset:"6天23小时后重置")]
        var activeId = "a", switches = 0, preflightState = "safe", lastTranslationCommand: String? = nil, lastHudCommandEnabled: Bool? = nil
        assistant.activeAccountId = activeId; assistant.cachedAccounts = accounts
        let models:[[String:Any]] = [
            ["model":"gemini-3.8-flash-n","totalTokens":90800000,"promptTokens":4000000,"candidatesTokens":300000,"requestCount":695,"estimatedUsd":10.77,"priced":true,"pricingStatus":"historical"],
            ["model":"gemini-3.8-flash-exp-a","totalTokens":12400000,"promptTokens":1100000,"candidatesTokens":90000,"requestCount":84,"estimatedUsd":6.40,"priced":true,"pricingStatus":"historical"],
            ["model":"claude-opus-5-5-medium","totalTokens":4500000,"promptTokens":900000,"candidatesTokens":120000,"requestCount":18,"estimatedUsd":5.25,"priced":true,"pricingStatus":"historical"],
            ["model":"claude-sonnet-4-6","totalTokens":2800000,"promptTokens":600000,"candidatesTokens":10000,"requestCount":43,"estimatedUsd":1.36,"priced":true]
        ]
        let todayHourly:[[String:Any]] = [
            ["hour":"2026-10-23 09:00","total_tokens":6200000],
            ["hour":"2026-10-23 10:00","total_tokens":14800000],
            ["hour":"2026-10-23 11:00","total_tokens":11400000],
            ["hour":"2026-10-23 14:00","total_tokens":19600000],
            ["hour":"2026-10-23 15:00","total_tokens":16200000],
            ["hour":"2026-10-23 16:00","total_tokens":12500000],
            ["hour":"2026-10-23 20:00","total_tokens":9800000],
            ["hour":"2026-10-23 21:00","total_tokens":7700000]
        ]
        let totals:[String:Any] = ["totalTokens":98200000,"promptTokens":4700000,"cachedTokens":93100000,"candidatesTokens":310000,"requestCount":756,"estimatedUsd":23.78,"pricedModels":4,"unpricedModels":0,"databasesScanned":343,"databasesDiscovered":343,"availability":"complete","scanScopeDescription":"全部 343 个会话数据库","lastScannedAt":Date().timeIntervalSince1970]
        assistant.bridge.fixtureReply = { payload in
            switch payload["command"] as? String {
            case "status": return ["ok":true,"status":status,"tasks":[],"taskRevision":0]
            case "account_list": return ["ok":true,"activeId":activeId,"accounts":accounts,"pendingSwitch":false]
            case "auto_switch_get": return ["ok":true,"config":["enabled":false,"strategy":"priority","monitored_model":"all"]]
            case "dashboard_summary": return ["ok":true,"accounts":accounts.first(where:{$0["id"] as? String == activeId})!.merging(["activeName":"Alex","activeEmail":"alex@example.invalid","activeTier":"PRO","liveAccountEmail":"alex@example.invalid","isLiveVerified":true]) { _, new in new },"usage":["todayTokens":98200000,"totalTokens":3000000000,"estimatedUsd":23.78,"allTimeEstimatedUsd":410.25,"requestCount":756,"totalRequestCount":27175,"todayPricedModels":4,"todayUnpricedModels":0,"pricedModels":4,"unpricedModels":0,"databasesScanned":343,"databasesDiscovered":343,"availability":"complete"]]
            case "usage_summary":
                let period = payload["period"] as? String ?? "today"
                return ["ok":true,"period":period,"snapshotId":"fixture-snapshot","summary":totals,"byModel":models,"todayHourly":todayHourly,"dailyTrends":[]]
            case "usage_events":
                let eventRows: [[String: Any]] = [
                    ["model": "gemini-3.8-flash-n", "timestamp_seconds": 1761544267, "input_tokens": 8290, "output_tokens": 374, "cached_tokens": 344104, "cache_write_tokens": 0],
                    ["model": "claude-opus-5-5-medium", "timestamp_seconds": 1761544259, "input_tokens": 6420, "output_tokens": 428, "cached_tokens": 343720, "cache_write_tokens": 0],
                    ["model": "gpt-5-turbo", "timestamp_seconds": 1761544255, "input_tokens": 5180, "output_tokens": 306, "cached_tokens": 240500, "cache_write_tokens": 0]
                ]
                return ["ok":true,"snapshot_id":"fixture-snapshot","rows":eventRows,"total":129,"scope":"全部 344 个会话数据库"]
            case "maintenance_scan":
                let reqRetention = intVal(payload, "retentionDays", fallback: 7)
                var scanEntries: [[String: Any]] = [
                    ["name": "Cache", "title": "网络与静态资源缓存", "subtitle": "界面静态资源与临时网络响应数据", "icon": "internaldrive", "category": "safe", "defaultSelected": true, "bytes": 524_288_000, "fileCount": 1820, "exists": true, "clearable": true],
                    ["name": "AgentBrowserCache", "title": "浏览器沙箱加速缓存", "subtitle": "Browser 沙箱的网页与编译缓存（保留站点登录与 Cookie）", "icon": "globe", "category": "safe", "defaultSelected": true, "bytes": 324_009_984, "fileCount": 1410, "exists": true, "clearable": true],
                    ["name": "PartitionsCache", "title": "内嵌视图子分区缓存", "subtitle": "内嵌浏览器与隔离分区的静态资源及编译缓存", "icon": "square.split.2x2", "category": "safe", "defaultSelected": true, "bytes": 96_468_992, "fileCount": 420, "exists": true, "clearable": true],
                    ["name": "OrphanAgentData", "title": "已删对话残留与临时文件", "subtitle": "含 6 个已删主对话遗留的孤儿记录、崩溃日志与临时媒体", "icon": "trash.slash", "category": "safe", "defaultSelected": true, "bytes": 48_234_496, "fileCount": 192, "exists": true, "clearable": true]
                ]
                let safeSum = 993_001_472
                var statefulSum = 0
                if reqRetention <= 7 {
                    scanEntries.append(contentsOf: [
                        ["name": "AgentSubagentDatabases", "title": "历史子智能体轨迹库", "subtitle": "7 天前共 142 个后台子智能体库（清理前自动归档 Token 账单）", "icon": "arrow.triangle.branch", "category": "stateful", "defaultSelected": false, "bytes": 856_686_592, "fileCount": 142, "exists": true, "clearable": true],
                        ["name": "AgentTaskStepLogs", "title": "历史任务与步骤输出日志", "subtitle": "7 天前对话的后台终端日志、步骤输出与 scratch 草稿", "icon": "terminal", "category": "stateful", "defaultSelected": false, "bytes": 218_103_808, "fileCount": 980, "exists": true, "clearable": true]
                    ])
                    statefulSum = 1_074_790_400
                }
                return [
                    "ok": true,
                    "token": "fixture-token",
                    "retentionDays": reqRetention,
                    "entries": scanEntries,
                    "safeBytes": safeSum,
                    "statefulBytes": statefulSum,
                    "totalBytes": safeSum + statefulSum,
                    "totalFiles": 4964,
                    "protectedEntries": [
                        ["id": "workspace", "title": "工作区与核心账号凭据", "subtitle": "User/globalStorage（OAuth 令牌库 state.vscdb）、Cookies、Local Storage 与工作区配置", "icon": "folder.badge.gearshape", "bytes": 87_031_808, "fileCount": 324, "exists": true],
                        ["id": "conversations", "title": "Agent 历史对话与上下文库", "subtitle": "受保护的主对话、已归档对话、正式产物与站点会话", "icon": "bubble.left.and.bubble.right", "bytes": 1_841_640_960, "fileCount": 201, "exists": true]
                    ],
                    "protectedBytes": 1_928_672_768,
                    "snapshots": [
                        ["id": "GravityBox-缓存-1729900800000", "timestamp": 1729900800, "totalBytes": 312_475_648, "fileCount": 3180, "items": ["Cache", "AgentBrowserCache", "OrphanAgentData"], "itemTitles": ["网络与静态资源缓存", "浏览器沙箱加速缓存", "已删对话残留与临时文件"], "movedCount": 3, "restorable": true, "interrupted": false],
                        ["id": "GravityBox-缓存-1729814400000", "timestamp": 1729814400, "totalBytes": 642_252_800, "fileCount": 1120, "items": ["AgentSubagentDatabases", "AgentTaskStepLogs"], "itemTitles": ["历史子智能体轨迹库", "历史任务与步骤输出日志"], "movedCount": 2, "restorable": true, "interrupted": false]
                    ],
                    "running": true,
                    "browserBusy": false,
                    "scannedAt": Int(Date().timeIntervalSince1970)
                ]
            case "account_switch_preflight": return [
                "ok": preflightState != "error",
                "safe": preflightState == "safe" || preflightState == "running_idle",
                "appRunning": preflightState == "busy" || preflightState == "running_idle",
                "stableRunning": preflightState == "running_idle",
                "hasRunningTask": preflightState == "busy",
                "error": "隔离预检失败"
            ]
            case "account_switch": switches += 1; activeId = payload["id"] as? String ?? activeId; return ["ok":true,"message":"隔离事务完成"]
            case "account_recovery_info": return ["ok":true,"available":false]
            case "pause": lastTranslationCommand = "pause"; return ["ok":true]
            case "resume": lastTranslationCommand = "resume"; return ["ok":true]
            case "hud_set":
                let enabled = payload["enabled"] as? Bool ?? true
                lastHudCommandEnabled = enabled
                var nextStatus = status
                nextStatus["hudEnabled"] = enabled
                return ["ok":true,"status":nextStatus]
            default: return ["ok":true]
            }
        }
        assistant.installApplicationMenu()
        assistant.showPanel(); pump()
        guard let window = assistant.window else { fatalError("Missing window") }
        if interactive {
            window.title = "GravityBox · 隔离 UI 预览（合成数据）"
            window.setFrame(NSRect(origin:window.frame.origin,size:NSSize(width:880,height:580)),display:true)
            window.makeKeyAndOrderFront(nil); application.activate(ignoringOtherApps:true)
            withExtendedLifetime(assistant) { application.run() }
            return
        }
        var captures:[String] = []
        for (theme, appearance) in [("light",NSAppearance.Name.aqua),("dark",NSAppearance.Name.darkAqua)] {
            window.appearance = NSAppearance(named:appearance)
            for size in [NSSize(width:880,height:580),NSSize(width:960,height:640),NSSize(width:1100,height:760)] {
                window.setFrame(NSRect(origin:window.frame.origin,size:size),display:true)
                for page in 0..<5 {
                    assistant.selectPage(page); pump(); window.contentView?.layoutSubtreeIfNeeded()
                    let name = "\(theme)-\(Int(size.width))x\(Int(size.height))-\(page).png"
                    try capture(window.contentView!,output.appendingPathComponent(name)); captures.append(name)
                    check(assistant.currentPage == page,"Navigation mismatch")
                    check(window.frame.width == size.width && (window.contentView?.fittingSize.width ?? 0) <= 880, "Page \(page) exceeds 880pt minimum window width")
                    if page == 0, size.width == 880, size.height == 580, let scroll = assistant.overview?.view as? NSScrollView, let document = scroll.documentView {
                        for card in [assistant.overview!.tokenMetricCard!, assistant.overview!.costMetricCard!, assistant.overview!.requestsMetricCard!] {
                            let rect = document.convert(card.bounds, from:card)
                            check(rect.minY >= scroll.contentView.bounds.minY-1 && rect.maxY <= scroll.contentView.bounds.maxY+1, "Minimum dashboard clips a metric card")
                        }
                    }
                    if page == 2 {
                        let usage = assistant.usagePage!
                        func labels(_ view:NSView)->[NSTextField] { (view as? NSTextField).map{[$0]} ?? view.subviews.flatMap{labels($0)} }
                        for targetName in ["gemini-3.8-flash-n", "gemini-3.8-flash-exp-a", "Claude Opus 5.5"] {
                            for label in labels(usage.donutLegendStack) where label.stringValue == targetName {
                                let width = (label.stringValue as NSString).size(withAttributes:[.font:label.font!]).width
                                check(label.bounds.width >= ceil(width), "Cost legend constrains model name \(targetName) at \(Int(size.width))pt width (\(label.bounds.width) < \(ceil(width)))")
                                check(label.bounds.height < 24, "Model label \(targetName) wrapped onto multiple lines at \(Int(size.width))pt width")
                            }
                        }
                        check(usage.costTitle.stringValue == "API费用估算" || usage.costTitle.stringValue == "今日费用估算" || usage.costTitle.stringValue == "API 费用估算","Title must remain API费用估算")
                        check(usage.priceCoverage.stringValue.isEmpty && usage.priceCoverage.isHidden,"Partial pricing model count must stay hidden")
                        check(usage.donutLegendStack.fittingSize.width <= size.width-190,"Legend exceeds page")
                    }
                }
            }
            let policy = AccountPolicySheet(app:assistant,config:["strategy":"priority","monitored_model":"gemini","reserve_percentage":10,"candidate_min_percentage":30],saved:{})
            policy.show(in:window,onDismiss:{})
            policy.window.appearance = NSAppearance(named:appearance); pump()
            check(policy.modelPopup.itemTitles == ["Gemini 全系模型","Gemini","Claude/GPT","Gemini 4 Argon","Gemini 4 Carbon"], "Model popup must expose Gemini 全系模型, Gemini, Claude/GPT, Gemini 4 Argon, and Gemini 4 Carbon")
            check(policy.strategyPopup.frame.width == policy.modelPopup.frame.width, "Policy popups must share uniform width")
            var dynamicAccount = accounts[0]
            dynamicAccount["standaloneModels"] = [
                ["key":"argon","displayName":"Gemini 4 Argon","availability":"available","quotaState":"known","period":"weekly","remaining":0.008],
                ["key":"carbon","displayName":"Gemini 4 Carbon","availability":"disabled","quotaState":"not_reported","period":"weekly"],
                ["key":"xenon","displayName":"Gemini 4 Xenon","availability":"available","quotaState":"known","period":"weekly","remaining":0.85]
            ]
            assistant.cachedAccounts = [dynamicAccount]
            let dynamicPolicy = AccountPolicySheet(app:assistant,config:["strategy":"priority","monitored_model":"xenon","reserve_percentage":10,"candidate_min_percentage":30],saved:{})
            check(dynamicPolicy.modelPopup.itemTitles == ["Gemini 全系模型","Gemini","Claude/GPT","Gemini 4 Argon","Gemini 4 Carbon","Gemini 4 Xenon"], "Model popup must auto-detect new standalone models")
            check(dynamicPolicy.modelPopup.selectedItem?.title == "Gemini 4 Xenon", "Model popup must select configured dynamic model")
            assistant.cachedAccounts = accounts
            for popup in [policy.strategyPopup, policy.modelPopup] {
                check(popup.focusRingType == .none && popup.cell?.focusRingType == NSFocusRingType.none, "Installed popup cell must not restore the square focus bezel")
                check(popup.cell is DesignPopUpCell, "PopUp buttons must use DesignPopUpCell so menus drop cleanly below the control")
                let origin = Design.popUpOrigin(below: popup)
                check(origin.x == 0 && origin.y == popup.bounds.maxY + 6, "Flipped popup origin must place menu 6pt below control bottom")
            }
            let unflippedProbe = NSView(frame: NSRect(x: 0, y: 0, width: 80, height: 28))
            check(Design.popUpOrigin(below: unflippedProbe) == NSPoint(x: 0, y: -6), "Unflipped anchor origin must place menu 6pt below control bottom")
            policy.window.makeFirstResponder(policy.strategyPopup); pump()
            try capture(policy.window.contentView!,output.appendingPathComponent("\(theme)-policy-popup-focused.png"))
            policy.window.makeFirstResponder(policy.reserve); pump()
            check(policy.reserve.currentEditor()?.alignment == .center, "Threshold editor changed number alignment")
            try capture(policy.window.contentView!,output.appendingPathComponent("\(theme)-policy-threshold-focused.png"))
            policy.window.makeFirstResponder(policy.candidate); pump()
            check(policy.candidate.currentEditor()?.alignment == .center, "Candidate editor changed number alignment")
            try capture(policy.window.contentView!,output.appendingPathComponent("\(theme)-policy-candidate-focused.png"))
            policy.cancel(); pump()
            let addSheet = AddAccountSheet(app: assistant, saved: {})
            addSheet.show(in: window, onDismiss: {})
            addSheet.window.appearance = NSAppearance(named: appearance)
            addSheet.window.contentView?.layoutSubtreeIfNeeded(); pump()
            func findLabels(_ v: NSView) -> [NSTextField] { (v as? NSTextField).map { [$0] } ?? v.subviews.flatMap { findLabels($0) } }
            let addLabels = findLabels(addSheet.window.contentView!)
            check(addLabels.contains { $0.stringValue == "读取本机已登录的账号" && $0.lineBreakMode != .byTruncatingMiddle && $0.bounds.width >= 150 }, "AddAccountSheet current-account description must not middle-truncate")
            check(addLabels.contains { $0.stringValue == "在浏览器中完成授权，凭据仅保存在本机" && $0.lineBreakMode != .byTruncatingMiddle && $0.bounds.width >= 180 }, "AddAccountSheet OAuth description must not middle-truncate")
            try capture(addSheet.window.contentView!, output.appendingPathComponent("\(theme)-add-account.png"))
            addSheet.dismiss(); pump()
            let logSheet = UsageLogController(app:assistant,period:"today")
            logSheet.show(in:window,onDismiss:{})
            logSheet.sheet.appearance = NSAppearance(named:appearance); pump()
            check(logSheet.refreshButton.title == "刷新" && logSheet.exportButton.title == "导出…", "UsageLogController must unify refresh and export buttons")
            logSheet.sheet.makeFirstResponder(logSheet.pageNumber); pump()
            check(logSheet.pageNumber.currentEditor()?.alignment == .center, "Page number editor must stay centered")
            logSheet.sheet.makeFirstResponder(nil); pump()
            try capture(logSheet.sheet.contentView!,output.appendingPathComponent("\(theme)-usage-log.png"))
            logSheet.closeSheet(); pump()
            assistant.selectPage(3); pump()
            let maintSheet = assistant.preferencesController?.maintenanceSheet ?? MaintenanceSheetController(app: assistant)
            maintSheet.sheet.appearance = NSAppearance(named: appearance)
            maintSheet.cachePage.fetch(force: true); pump()
            maintSheet.sheet.contentView?.layoutSubtreeIfNeeded(); pump()
            check(maintSheet.cachePage.retentionPopup.itemTitles == ["保留近 7 天", "保留近 30 天", "全部非活跃"], "Maintenance sheet must expose 3 retention window choices")
            check(!maintSheet.cachePage.snapshotPopup.isHidden && maintSheet.cachePage.snapshotPopup.numberOfItems == 2, "Maintenance recovery footer must expose multi-snapshot selector when >=2 restorable snapshots exist")
            check(maintSheet.cachePage.selectedNames == Set(["Cache", "AgentBrowserCache", "PartitionsCache", "OrphanAgentData"]), "Maintenance default selection must check safe items only and leave history slimming items unchecked")
            check(!maintSheet.cachePage.sheetDoneButton.isHidden && maintSheet.cachePage.sheetDoneButton.title == "完成", "Maintenance sheet must display 完成 button")
            check(maintSheet.cachePage.selectedSummaryBadge.title == "已选 4 项", "Maintenance selectedSummaryBadge must update from 正在扫描 to 已选 4 项 after scan completes")
            check(maintSheet.cachePage.breakdownWarningLabel.isHidden, "Maintenance breakdownWarningLabel must stay hidden when no items are blocked")
            check(maintSheet.cachePage.sheetDoneButton.frame.minY < maintSheet.cachePage.view.frame.minY, "Maintenance 完成 button must sit in pinned bottom footer below scroll area")
            check(maintSheet.cachePage.sheetDoneButton.frame.maxX > maintSheet.cachePage.clearButton.frame.minX, "Maintenance 完成 button must align at bottom-right")
            try capture(maintSheet.sheet.contentView!, output.appendingPathComponent("\(theme)-maintenance-sheet.png"))
            maintSheet.closeSheet(); pump()
            let card = MenuStatusCard(target:assistant,account:accounts[0],enabled:true)
            let host = NSWindow(contentRect:NSRect(x:0,y:0,width:320,height:600),styleMask:[.titled],backing:.buffered,defer:false)
            host.appearance = NSAppearance(named:appearance)
            let surface = DesignSurface(Design.card); host.contentView = surface
            card.autoresizingMask = []; surface.addSubview(card); card.frame.origin = .zero
            card.updateHeight()
            host.setContentSize(NSSize(width:320,height:card.frame.height)); host.contentView?.layoutSubtreeIfNeeded(); pump()
            check(card.emailLabel.stringValue == "alex@example.invalid","Full email lost")
            check(card.emailLabel.bounds.width > 200,"Identity width still compressed")
            try capture(surface,output.appendingPathComponent("\(theme)-menu-default.png"))
            card.toggleAccountList(); pump(); host.setContentSize(NSSize(width:320,height:card.frame.height)); host.contentView?.layoutSubtreeIfNeeded()
            try capture(surface,output.appendingPathComponent("\(theme)-menu-accounts.png")); host.orderOut(nil)
            let allAccounts = accounts
            accounts = [allAccounts[2]]; activeId = "c"; assistant.activeAccountId = "c"; assistant.cachedAccounts = accounts
            window.setFrame(NSRect(origin:window.frame.origin,size:NSSize(width:880,height:580)),display:true)
            assistant.selectPage(1); pump()
            assistant.accountsPage?.fetch()
            waitUntil(description: "AccountsPage activeId to sync to c") {
                assistant.accountsPage?.activeId == "c"
            }
            func quotaBars(_ view:NSView)->[QuotaBarView] { (view as? QuotaBarView).map{[$0]} ?? view.subviews.flatMap{quotaBars($0)} }
            let modelBars = quotaBars(window.contentView!).filter{$0.titleLabel.stringValue.contains("模型配额")}
            check(modelBars.count == 2 && modelBars.allSatisfy{$0.percentageKnown && $0.percentage == 100}, "FREE model quota must render known on both account rows")
            for bar in modelBars where !bar.resetLabel.stringValue.isEmpty {
                let naturalW = (bar.resetLabel.stringValue as NSString).size(withAttributes: [.font: bar.resetLabel.font!]).width
                check(bar.resetLabel.bounds.width + 1.0 >= floor(naturalW), "Model quota resetLabel (\(bar.resetLabel.stringValue)) must not truncate at 880pt minimum width (\(bar.resetLabel.bounds.width) < \(naturalW))")
            }
            check(assistant.accountsPage?.activeId == "c", "AccountsPage must preserve configured activeId when liveAccountEmail is not in saved accounts")
            try capture(window.contentView!,output.appendingPathComponent("\(theme)-free-model-quota.png"))
            let freeCard = MenuStatusCard(target:assistant,account:accounts[0],enabled:true)
            card.removeFromSuperview(); surface.addSubview(freeCard); freeCard.frame.origin = .zero; freeCard.updateHeight()
            host.setContentSize(NSSize(width:320,height:freeCard.frame.height)); host.contentView?.layoutSubtreeIfNeeded(); pump()
            check(freeCard.gemini5h.titleLabel.stringValue == "模型配额" && freeCard.gemini5h.valueLabel.stringValue == "100%", "Menu must show FREE model quota")
            check(freeCard.claude5h.resetLabel.stringValue.contains("6天23小时"), "Menu must preserve the real long model reset")
            try capture(surface,output.appendingPathComponent("\(theme)-free-model-menu.png"))
            accounts = allAccounts; activeId = "a"; assistant.activeAccountId = "a"; assistant.cachedAccounts = accounts
        }
        assistant.accountsPage!.fetch(); pump()
        let initialCards = assistant.accountsPage!.cardsStack.arrangedSubviews
        check(initialCards.count == 3, "Expected 3 account cards before countdown tick")
        accounts[0]["geminiFiveHourResetCountdown"] = "1小时59分后重置"
        assistant.accountsPage!.fetch(); pump()
        let updatedCards = assistant.accountsPage!.cardsStack.arrangedSubviews
        check(updatedCards.count == initialCards.count && zip(initialCards, updatedCards).allSatisfy { $0 === $1 }, "Countdown tick must update account cards in place without rebuilding card views")
        assistant.preferencesController?.showMaintenanceSheet(); pump()
        let initialCacheRows = assistant.cachePage!.itemsStack.arrangedSubviews
        assistant.cachePage!.fetch(force: true); pump()
        let updatedCacheRows = assistant.cachePage!.itemsStack.arrangedSubviews
        check(updatedCacheRows.count == initialCacheRows.count && zip(initialCacheRows, updatedCacheRows).allSatisfy { $0 === $1 }, "Cache scan must reuse checklist row views when item order is unchanged")
        assistant.preferencesController?.maintenanceSheet?.closeSheet(); pump()

        // Verify three-tab MenuPanelController (用量｜配额｜账号)
        let menuPanel = assistant.ensureMenuPanelController()
        let panelHost = NSWindow(contentRect: NSRect(x: 0, y: 0, width: MenuPanelController.panelWidth, height: MenuPanelController.defaultPanelHeight), styleMask: [.titled], backing: .buffered, defer: false)
        panelHost.contentViewController = menuPanel
        for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            panelHost.appearance = NSAppearance(named: appearance)
            menuPanel.selectTab(0, persist: false); menuPanel.panelWillOpen(); pump()
            panelHost.setContentSize(menuPanel.preferredContentSize); panelHost.contentView?.layoutSubtreeIfNeeded(); pump()
            check(menuPanel.brandLabel.superview?.superview?.superview?.frame.maxY == menuPanel.view.bounds.height, "Header bar must stay pinned to the top edge on Usage tab")
            try capture(panelHost.contentView!, output.appendingPathComponent("\(theme)-menu-panel-usage.png"))
            menuPanel.selectTab(1, persist: false); pump()
            panelHost.setContentSize(menuPanel.preferredContentSize); panelHost.contentView?.layoutSubtreeIfNeeded(); pump()
            check(menuPanel.brandLabel.superview?.superview?.superview?.frame.maxY == menuPanel.view.bounds.height, "Header bar must stay pinned to the top edge on Quota tab")
            try capture(panelHost.contentView!, output.appendingPathComponent("\(theme)-menu-panel-quota.png"))
            menuPanel.selectTab(2, persist: false); pump()
            panelHost.setContentSize(menuPanel.preferredContentSize); panelHost.contentView?.layoutSubtreeIfNeeded(); pump()
            check(menuPanel.brandLabel.superview?.superview?.superview?.frame.maxY == menuPanel.view.bounds.height, "Header bar must stay pinned to the top edge on Accounts tab")
            try capture(panelHost.contentView!, output.appendingPathComponent("\(theme)-menu-panel-accounts.png"))
        }
        menuPanel.selectTab(0, persist: false); menuPanel.panelWillOpen(); pump()
        let multiModelHeight = menuPanel.preferredContentSize.height
        check(menuPanel.selectedTab == 0, "Menu panel must default to Usage tab (0)")
        check(menuPanel.usageFooterLabel.stringValue.hasPrefix("更新于 "), "Menu usage footer must use concise 更新于 timestamp")
        check(menuPanel.usageFooterLabel.superview === menuPanel.usageRoot, "Menu usage footer must reside directly in usageRoot, outside modelsCard")
        check(menuPanel.tokensTile.valueLabel.stringValue == "98.2M", "Menu usage tab must match Usage KPI tokens")
        check(menuPanel.requestsTile.valueLabel.stringValue == "756", "Menu usage tab must match Usage KPI requests")
        check(menuPanel.costTile.valueLabel.stringValue == "$23.78", "Menu usage tab must match Usage KPI cost")
        check(menuPanel.tokensTile.toolTip == nil, "Tokens tile must not have tooltip per requirement")
        let metricTiles = [menuPanel.tokensTile, menuPanel.requestsTile, menuPanel.costTile, menuPanel.cacheTile]
        for tile in metricTiles {
            check(tile.iconView.image != nil, "\(tile.metricKey) tile must contain micro colored SF Symbol")
            check(tile.frame.height >= 54 && tile.frame.height <= 56, "\(tile.metricKey) tile must maintain 54~56pt compact height")
            check(tile.accessibilityRole() == .group, "\(tile.metricKey) tile must be a read-only group, not interactive button")
            check(!((tile as AnyObject) is NSControl), "\(tile.metricKey) tile must not inherit from NSControl")
            check(tile.titleLabel.font?.pointSize == 11.5, "\(tile.metricKey) tile title font must be 11.5pt")
            check(tile.valueLabel.font?.pointSize == 20, "\(tile.metricKey) tile value font must be 20pt")
            func subviewsRecursive(_ v: NSView) -> [NSView] { [v] + v.subviews.flatMap { subviewsRecursive($0) } }
            let allSubviews = subviewsRecursive(tile)
            check(allSubviews.filter { $0 is NSImageView }.count == 1, "\(tile.metricKey) tile must contain only 1 micro icon and no chevron arrow")
            check(allSubviews.filter { $0 is NSTextField }.count == 2, "\(tile.metricKey) tile must contain only title and value labels without subtitle lines")
        }
        panelHost.appearance = NSAppearance(named: .aqua); panelHost.contentView?.layoutSubtreeIfNeeded(); pump()
        check(menuPanel.contentScroll.contentView.frame.width == MenuPanelController.panelWidth && (menuPanel.contentScroll.verticalScroller?.frame.width ?? 0) == 0, "Menu panel content must never reserve a scroller gutter or squeeze content width")
        menuPanel.selectChartDimension(.requests, persist: false)
        check(menuPanel.trendChart.dimension == .requests, "Menu trend chart must support switching to requests dimension")
        menuPanel.selectChartDimension(.tokens, persist: false)
        let baselineUsageFitHeight = menuPanel.usageRoot.fittingSize.height
        let samplePt = menuPanel.trendChart.convert(NSPoint(x: 60, y: 40), to: nil)
        let hoverEvent = NSEvent.mouseEvent(with: .mouseMoved, location: samplePt, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!
        menuPanel.trendChart.mouseMoved(with: hoverEvent)
        check(menuPanel.trendChart.toolTip == nil, "Menu trend chart must not have hover tooltip per requirement")
        check(menuPanel.trendCoverageLabel.alphaValue == 1.0, "Trend coverage label must be visible on hover")
        check(menuPanel.usageRoot.fittingSize.height == baselineUsageFitHeight, "Menu usage view fitting height must remain stable on trend hover without jitter")
        menuPanel.trendChart.resetHoverState()
        check(menuPanel.trendCoverageLabel.alphaValue == 0.0, "Trend coverage label must be hidden when hover resets")
        check(menuPanel.usageRoot.fittingSize.height == baselineUsageFitHeight, "Menu usage view fitting height must remain stable after hover reset")
        check(!menuPanel.toggleModelsButton.isHidden && menuPanel.toggleModelsButton.title.contains("展开其余 1 个模型"), "Menu model list must default to top 3 and offer inline expansion")
        let firstThreeModels = Array(menuPanel.modelsListStack.arrangedSubviews.prefix(3))
        menuPanel.toggleAllModelsPressed()
        check(menuPanel.showAllModels && menuPanel.toggleModelsButton.title.contains("收起"), "Menu model list must expand all models in place")
        check(zip(firstThreeModels, menuPanel.modelsListStack.arrangedSubviews.prefix(3)).allSatisfy { $0 === $1 }, "Expanding model list must reuse existing model row views without rebuilding")
        for sub in menuPanel.modelsListStack.arrangedSubviews {
            guard let modelRow = sub as? MenuModelUsageRow else { continue }
            check(!((modelRow as AnyObject) is NSControl), "MenuModelUsageRow must be a read-only NSView, not NSControl")
            check(modelRow.accessibilityRole() == .group, "MenuModelUsageRow must have group accessibility role")
            func rowSubviews(_ v: NSView) -> [NSView] { [v] + v.subviews.flatMap { rowSubviews($0) } }
            let subs = rowSubviews(modelRow)
            check(subs.filter { $0 is NSButton }.isEmpty, "MenuModelUsageRow must contain 0 NSButtons (no headerButton)")
            check(subs.filter { $0 is NSImageView }.count == 1, "MenuModelUsageRow must contain only 1 icon and no chevronView")
            check(subs.filter { $0 is NSTextField }.count == 2, "MenuModelUsageRow must contain exactly 2 labels without detailLabel")
            check(subs.filter { $0 is MenuMeterBar }.count == 1, "MenuModelUsageRow must contain shareBar")
        }
        check(menuPanel.contentScroll.contentView.frame.width == MenuPanelController.panelWidth && (menuPanel.contentScroll.verticalScroller?.frame.width ?? 0) == 0, "Expanded menu panel must never reserve a scroller gutter or squeeze content width")
        menuPanel.toggleAllModelsPressed()
        // Verify single-model Usage tab shrinks height to fit content with zero bottom blank gap
        if var singleModelReport = assistant.cachedUsageReportsByPeriod["today"] {
            singleModelReport["byModel"] = [models[0]]
            singleModelReport["snapshotId"] = "single-model-snap"
            assistant.cachedUsageReportsByPeriod["today"] = singleModelReport
            menuPanel.onUsageReportUpdated(period: "today", result: .success(singleModelReport))
            panelHost.appearance = NSAppearance(named: .aqua)
            panelHost.setContentSize(menuPanel.preferredContentSize); panelHost.contentView?.layoutSubtreeIfNeeded(); pump()
            check(menuPanel.preferredContentSize.height < multiModelHeight - 60, "Single-model usage tab must shrink height to eliminate bottom blank space")
            try capture(panelHost.contentView!, output.appendingPathComponent("light-menu-panel-usage-single-model.png"))
        }
        menuPanel.selectTab(1, persist: false); pump()
        check(menuPanel.selectedTab == 1 && menuPanel.headerRefreshButton.title == "刷新" && menuPanel.headerRefreshButton.toolTip == nil, "Quota tab must keep fixed button title and zero hover tooltip")
        check(menuPanel.quotaAccountNameLabel.stringValue == "Alex" && menuPanel.quotaGemini5h.valueLabel.stringValue == "91%", "Quota tab must display active account identity and contract quota")
        check(menuPanel.quotaCarbon.valueLabel.stringValue == "未知", "Missing Carbon response must be unknown even for PRO")
        check(menuPanel.quotaCarbon.valueLabel.stringValue != "不可用", "Missing model cannot imply disabled")
        check(menuPanel.quotaFooterLabel.stringValue.hasPrefix("更新于 ") && !menuPanel.quotaFooterLabel.stringValue.contains("采样于"), "Quota tab footer must use concise 更新于 timestamp")
        check(menuPanel.quotaFooterLabel.superview === menuPanel.quotaRoot, "Quota tab footer must reside directly in quotaRoot")
        menuPanel.selectTab(2, persist: false); pump()
        check(menuPanel.selectedTab == 2 && menuPanel.headerRefreshButton.title == "刷新" && menuPanel.headerRefreshButton.toolTip == nil, "Accounts tab must keep fixed button title and zero hover tooltip")
        check(menuPanel.accountsCountLabel.stringValue == "3 个账号" && menuPanel.expandedAccountIds.contains("a"), "Accounts tab must list all accounts with active account expanded")
        menuPanel.toggleAccountExpanded("b")
        check(menuPanel.expandedAccountIds.contains("b"), "Clicking backup account row must expand its 5-window quota details without switching")
        for sub in menuPanel.accountsCardsStack.arrangedSubviews {
            if let card = sub as? MenuExpandableAccountCardView {
                check(card.stateButton.frame.width >= 16 && card.stateButton.frame.origin.x >= 0, "Account card stateButton must be clearly visible and uncrushed")
                check(card.nameLabel.frame.width >= 20, "Account card nameLabel must not be compressed down to ellipsis")
                let headerStack = card.headerButton.subviews.compactMap { $0 as? NSStackView }.first
                check(headerStack?.arrangedSubviews.count == 2, "Account card header stack must contain exactly 2 arranged subviews (topTitleRow and emailLabel), summaryLabel must be removed")
                check(headerStack?.arrangedSubviews.contains(card.emailLabel) == true, "Account card header stack must contain emailLabel")
                func cardSubviews(_ v: NSView) -> [NSView] { [v] + v.subviews.flatMap { cardSubviews($0) } }
                let allHeaderLabels = cardSubviews(card.headerButton).compactMap { $0 as? NSTextField }
                check(allHeaderLabels.allSatisfy { !$0.stringValue.contains("小时") && !$0.stringValue.contains("每周") }, "Account card header must not duplicate text quota summary")
            }
        }
        var switchedAccountId: String? = nil
        var toggledAccountId: String? = nil
        if let firstCard = menuPanel.accountsCardsStack.arrangedSubviews.first as? MenuExpandableAccountCardView {
            firstCard.onSwitchAccount = { switchedAccountId = $0 }
            firstCard.onToggleExpand = { toggledAccountId = $0 }
            firstCard.headerButton.performClick(nil)
            check(toggledAccountId == firstCard.accountId && switchedAccountId == nil, "Clicking account header must toggle expand without triggering switch")
        }
        if let secondCard = menuPanel.accountsCardsStack.arrangedSubviews.dropFirst().first as? MenuExpandableAccountCardView {
            secondCard.onSwitchAccount = { switchedAccountId = $0 }
            secondCard.onToggleExpand = { toggledAccountId = $0 }
            secondCard.stateButton.performClick(nil)
            check(switchedAccountId == secondCard.accountId, "Clicking account stateButton must trigger account switch independently")
        }
        assistant.openMainWindowFromMenuPanel(tab: 0, usagePeriod: 2); pump()
        check(assistant.currentPage == 2 && assistant.usageSelectedPeriod == 2, "Footer deep-link from Usage tab must navigate to UsagePage and carry selected period")
        check(assistant.usagePage!.donutChart.totalUsd == 23.78, "Donut chart must receive total equivalent USD")
        check(!assistant.usagePage!.donutChart.isHidden, "Donut chart must be visible when priced models exist")
        // Verify rapid page switching does not leave blank view host or drop views
        assistant.selectPage(0); assistant.selectPage(1); assistant.selectPage(0); pump()
        check(assistant.currentPage == 0, "Rapid switching must end on page 0")
        check(assistant.pageHost.subviews.contains(where: { $0 === assistant.overview!.view }), "Overview view must remain in pageHost after rapid switching")
        check(assistant.overview!.view.alphaValue == 1.0, "Overview view alpha must be 1.0 after completing transition")

        let ov = assistant.overview!
        assistant.cachedUsageReportsByPeriod["today"] = [
            "summary": totals,
            "byModel": models,
            "todayHourly": todayHourly
        ]
        ov.update(force: true)
        check(ov.rightBentoTitleLabel.stringValue == "今日活跃模型", "Overview right Bento card title must be 今日活跃模型")
        check(ov.rightBentoCountBadge.title == "Top 2 / 共 4 个", "Overview right Bento count badge must show Top 2 / 共 4 个")
        check(ov.bentoRightStack.arrangedSubviews.count == 2, "Overview Bento right stack must display 2 subrows")
        func findButtons(_ v: NSView) -> [NSButton] { (v as? NSButton).map { [$0] } ?? v.subviews.flatMap { findButtons($0) } }
        check(!findButtons(ov.view).contains { $0.title == "管理账号" }, "Overview hero card must not display 管理账号 button")
        if let firstBox = ov.bentoRightStack.arrangedSubviews.first as? NSBox {
            func findBadges(_ v: NSView) -> [PillBadge] { (v as? PillBadge).map { [$0] } ?? v.subviews.flatMap { findBadges($0) } }
            check(findBadges(firstBox).allSatisfy { $0.isHidden }, "Active model row must move USD into subtitle without showing a pill badge")
            check(firstBox.accessibilityLabel()?.contains("Gemini 3.8 Flash") == true || firstBox.accessibilityLabel()?.contains("gemini-3.8-flash") == true, "Subrow box must expose VoiceOver accessibility label")
            check(firstBox.toolTip == nil || firstBox.toolTip?.isEmpty == true, "Overview Bento subrows must be read-only without deep-link tooltip")
            check(firstBox.accessibilityRole() == .group, "Subrow box must be an accessible display group, not a button")
        }

        // Test single active model in Overview Bento
        assistant.cachedUsageReportsByPeriod["today"] = [
            "byModel": [models[0]],
            "todayHourly": todayHourly
        ]
        ov.update(force: true)
        check(ov.rightBentoTitleLabel.stringValue == "今日活跃模型", "Single model Bento title must remain 今日活跃模型")
        check(ov.rightBentoCountBadge.title == "1 个模型", "Single model Bento badge must show 1 个模型")
        check(ov.bentoRightStack.arrangedSubviews.count == 2, "Single model Bento must maintain exactly 2 subrows for layout symmetry")
        func allLabels(_ view: NSView) -> [NSTextField] { (view as? NSTextField).map{[$0]} ?? view.subviews.flatMap{allLabels($0)} }
        let singleLabels = allLabels(ov.bentoRightStack).map { $0.stringValue }
        check(singleLabels.contains(where: { $0.contains("占今日全部调用") }), "Single model Bento must state 占今日全部调用")
        check(singleLabels.contains("查看更多模型统计"), "Single model Bento row 2 must provide guide card 查看更多模型统计")

        // Test zero / inactive models in Overview Bento (e.g. 0 tokens & 0 requests)
        assistant.cachedUsageReportsByPeriod["today"] = [
            "byModel": [["model": "inactive-model", "totalTokens": 0, "requestCount": 0]],
            "todayHourly": []
        ]
        ov.update(force: true)
        check(ov.rightBentoTitleLabel.stringValue == "今日活跃模型", "Zero model Bento title must remain 今日活跃模型")
        check(ov.rightBentoCountBadge.title == "暂无调用", "Zero/inactive model Bento badge must show 暂无调用")
        check(ov.bentoRightStack.arrangedSubviews.count == 2, "Empty state Bento must display exactly 2 symmetrical subrows")
        let emptyLabels = allLabels(ov.bentoRightStack).map { $0.stringValue }
        check(emptyLabels.contains("今日暂无模型调用"), "Empty state Bento row 1 must show 今日暂无模型调用")
        check(emptyLabels.contains("模型用量明细"), "Empty state Bento row 2 must show 模型用量明细")
        for box in ov.bentoRightStack.arrangedSubviews.compactMap({ $0 as? NSBox }) {
            check(box.toolTip == nil || box.toolTip?.isEmpty == true, "Both empty state rows must be read-only without deep-link tooltip")
            check(box.accessibilityRole() == .group, "Both empty state rows must be accessible display groups, not buttons")
        }

        // Restore fixture data
        assistant.cachedUsageReportsByPeriod["today"] = [
            "summary": totals,
            "byModel": models,
            "todayHourly": todayHourly
        ]
        ov.update(force: true)
        panelHost.orderOut(nil)

        assistant.activeAccountId = "a"
        assistant.confirmSwitchForTesting = { _, reply in reply(true) }
        assistant.switchAccountByIdFromMenu("b")
        check(assistant.activeAccountId == "a","Menu must not optimistically change current identity")
        waitUntil(description: "account switch to complete") {
            switches >= 1 && !assistant.accountSwitchInFlight
        }
        check(switches == 1, "Confirmed fixture switch must run exactly once")
        let opensBeforeIdleSwitch = assistant.openedApplications
        preflightState = "running_idle"
        assistant.switchAccountByIdFromMenu("c")
        waitUntil(description: "running_idle switch to complete and relaunch") {
            switches >= 2 && !assistant.accountSwitchInFlight && assistant.openedApplications > opensBeforeIdleSwitch
        }
        check(switches == 2 && assistant.openedApplications == opensBeforeIdleSwitch + 1, "Switching while Antigravity was running must automatically relaunch Antigravity")
        switches = 1; assistant.activeAccountId = "a"; activeId = "a"
        preflightState = "safe"
        preflightState = "busy"; assistant.switchAccountByIdFromMenu("c"); pump()
        check(switches == 1,"Running official app must block switching")
        preflightState = "error"; assistant.switchAccountByIdFromMenu("c"); pump()
        check(switches == 1,"Failed preflight must not execute")
        preflightState = "safe"; assistant.confirmSwitchForTesting = { _, reply in reply(false) }
        assistant.switchAccountByIdFromMenu("c"); pump(); check(switches == 1,"Cancelled confirmation must not execute")
        let summary = QuotaPresentation.menuAccountSummary(accounts[0]); check(summary.contains("Claude/GPT") && summary.contains("已耗尽"),"Menu must disclose exhausted family")

        // 校验菜单栏图标纯净性：无论配额是否耗尽（当前账号 a 的 Claude 为 0%），图标始终保持纯净 Template 图标，绝不附带警告圆点
        let statusButton = NSButton(frame: NSRect(x: 0, y: 0, width: 22, height: 22))
        let baseIcon = assistant.baseMenuConnectedIcon()
        check(baseIcon != nil, "baseMenuConnectedIcon must load valid icon")
        check(baseIcon?.size == NSSize(width: 18, height: 18), "baseMenuConnectedIcon size must be 18x18")
        check(baseIcon?.isTemplate == true, "baseMenuConnectedIcon must be marked as template for system auto-tinting")
        assistant.updateStatusItemState(buttonOverride: statusButton)
        check(statusButton.image === baseIcon, "Status item image must be baseMenuConnectedIcon")
        check(statusButton.image?.isTemplate == true, "Status item image must remain template without warning dot")
        check(statusButton.alphaValue == 1.0, "Connected status icon must maintain full opacity (1.0)")
        let pausedStatus: [String: Any] = ["mode": "paused", "windows": 1, "entries": 4300, "appVersion": "2.25.0", "liveAccountEmail": "alex@example.invalid", "activeAccountEmail": "alex@example.invalid", "accountsRevision": "fixture", "pid": -1]
        assistant.statusValue = LiveStatus(pausedStatus)
        assistant.updateStatusItemState(buttonOverride: statusButton)
        check(statusButton.alphaValue == 1.0, "Pausing translation must not reduce menu bar icon opacity")
        assistant.statusValue = LiveStatus(status)

        DesktopApplicationTarget.installedChannelsOverride = ["stable", "insiders"]
        Assistant.applicationChannel = "insiders"
        assistant.configuration.value.applicationChannel = "insiders"
        check(assistant.targetApplication.label == "Antigravity" && assistant.targetApplication.name == "Antigravity", "Unified target label and name must always be Antigravity")
        check(assistant.targetApplication.supportsAccountSwitch == true, "Stable Antigravity must support account switching")
        check(assistant.targetApplication.channel == "stable", "Legacy channel cannot redirect native target")
        check(assistant.targetApplication.bundleIdentifier == "com.google.antigravity", "Native target must be stable")
        check(DesktopApplicationTarget.installedChannels() == ["stable"], "Insiders must not be discoverable")
        let stableSettings = PreferencesController(app: assistant)
        func allTextValues(_ v: NSView) -> [String] {
            var values: [String] = []
            if let tf = v as? NSTextField { values.append(tf.stringValue) }
            if let btn = v as? NSButton { values.append(btn.title) }
            if let pop = v as? NSPopUpButton { values.append(contentsOf: pop.itemTitles) }
            for sub in v.subviews { values.append(contentsOf: allTextValues(sub)) }
            return values
        }
        check(!allTextValues(stableSettings.view).contains { $0.localizedCaseInsensitiveContains("Insiders") || $0.contains("目标应用") }, "Settings UI must not display target application switcher or Insiders text")
        check(stableSettings.manageCacheBtn.title == "管理存储…", "Storage settings row button must display 管理存储…")
        check(stableSettings.pricingSyncCheckBtn.title == "立即检查" && stableSettings.pricingSyncCheckBtn.intrinsicContentSize.height == 28, "Pricing check button must use fixed-width InlineRefreshButton matching global 28pt height")
        stableSettings.pricingSyncCheckBtn.setBusy(true, available: true)
        check(stableSettings.pricingSyncCheckBtn.isActivitySpinning && stableSettings.pricingSyncCheckBtn.title == "立即检查", "Pricing check button must spin in place without title jump")
        stableSettings.pricingSyncCheckBtn.setBusy(false, available: true)
        stableSettings.refreshStorageRowState(force: true); pump()
        check(!stableSettings.storageBadge.isHidden && stableSettings.storageBadge.title.hasPrefix("可释放 "), "Storage settings row must display reclaimable space pill badge")
        check(!allTextValues(stableSettings.view).contains("检查更新") && !allTextValues(stableSettings.view).contains("关于"), "Settings UI must extract 关于 section out into its own top-level sidebar tab")
        assistant.selectPage(4); pump()
        let aboutPage = assistant.aboutPage!
        check(assistant.names == ["总览", "账号", "用量", "设置", "关于"], "Sidebar must contain 5 top-level tabs ending with 关于")
        check(aboutPage.checkUpdateBtn.title == "检查更新", "About page must display 检查更新 button")
        check(aboutPage.updateStatusLabel.stringValue.contains("检查更新") || aboutPage.updateStatusLabel.stringValue.contains("最新版本"), "About page must display update status copy when idle/up-to-date")
        check(assistant.installUpdateButton?.isHidden == true, "Sidebar installUpdateButton must stay hidden when no update is available")
        assistant.updateManager.simulateRelease(AppReleaseInfo(
            version: "1.1.0",
            tagName: "v1.1.0",
            title: "GravityBox v1.1.0",
            changelog: "### 更新亮点\n- 新增 GitHub Release 检查更新与后台预下载\n- 毛玻璃更新 Sheet 展示完整 Changelog\n```bash\nsudo xattr -rd com.apple.quarantine /Applications/GravityBox.app\n```\n### 附件 SHA-256 校验\n```text\n7a88a030118d8e58a5f265bf0de61d00f9d26c115d56bad41e52f0969f3b3346  GravityBox-1.0.1-arm64.dmg\n```",
            publishedDate: "2026-11-04",
            htmlURL: URL(string: "https://github.com/Enzoo404/gravitybox/releases/tag/v1.1.0")!,
            dmgURL: nil,
            sha256URL: nil
        ))
        aboutPage.refreshUpdateState()
        check(!aboutPage.installNowBtn.isHidden && aboutPage.updateStatusLabel.stringValue.contains("v1.1.0"), "About page must display inline update prompt and 立即更新 button when update is available")
        check(assistant.installUpdateButton?.isHidden == false && assistant.installUpdateButton?.title == "安装更新" && assistant.installUpdateButton?.badgeText == "v1.1.0" && assistant.installUpdateButton?.isUpdatePrompt == true, "Sidebar must display 安装更新 prompt capsule above 打开 Antigravity when update is available")
        if let installBtn = assistant.installUpdateButton, let openBtn = assistant.launchApplicationButton, let bStack = installBtn.superview as? NSStackView {
            let installIdx = bStack.arrangedSubviews.firstIndex(of: installBtn) ?? -1
            let openIdx = bStack.arrangedSubviews.firstIndex(of: openBtn) ?? -1
            check(installIdx >= 0 && openIdx == installIdx + 1, "安装更新 capsule must sit directly above 打开 Antigravity in sidebar bottomStack")
        }
        // Capture Hero/Overview with sidebar 安装更新 capsule visible
        assistant.selectPage(0); window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 960, height: 640)), display: true); pump()
        for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            window.appearance = NSAppearance(named: appearance)
            window.contentView?.layoutSubtreeIfNeeded(); pump()
            try capture(window.contentView!, output.appendingPathComponent("\(theme)-hero-install-update-capsule.png"))
        }
        assistant.selectPage(4); pump()
        aboutPage.openUpdateSheet(); pump()
        if let updateSheet = assistant.updateSheet {
            check(updateSheet.primaryBtn.title == "立即更新", "Update sheet must display 立即更新 button when release is available")
            check(updateSheet.primaryBtn.showsSpinner == false && updateSheet.spinner.isHidden == true, "Update sheet primaryBtn must hide inline spinner when updateAvailable")
            check(updateSheet.closeBtn.isEnabled == true, "Update sheet closeBtn must be enabled in updateAvailable state")
            let sheetTexts = allTextValues(updateSheet.sheet.contentView!)
            check(!sheetTexts.contains { $0.hasPrefix("构建 ") }, "Update sheet header must not display 构建 pill")
            check(!sheetTexts.contains { $0.contains("正在连接 GitHub Releases") }, "Update sheet header must not display 正在连接 GitHub Releases subtitle")
            check(!sheetTexts.contains("正在检查") && !sheetTexts.contains("可升级") && !sheetTexts.contains("已是最新"), "Update sheet notes header must not display right-side state capsule")
            updateSheet.sheet.contentView?.layoutSubtreeIfNeeded()
            if let titleRow = updateSheet.titleLabel.superview {
                check(abs(titleRow.frame.midY - updateSheet.githubBtn.frame.midY) <= 1.5, "GravityBox title and version pill must be vertically parallel with GitHub button")
            }
            check(updateSheet.changelogTextView.string.contains("• 新增 GitHub Release 检查更新"), "Update sheet must format markdown list items into bullets")
            check(!updateSheet.changelogTextView.string.contains("```") && !updateSheet.changelogTextView.string.contains("###"), "Update sheet must strip raw markdown code fences and heading hashes")
            check(!updateSheet.changelogTextView.string.contains("sudo xattr") && !updateSheet.changelogTextView.string.contains("SHA-256"), "Update sheet must strip terminal quarantine commands and SHA-256 footer blocks")
            let updaterScript = AppUpdateManager.buildDetachedUpdaterScript(
                myPid: 12345,
                stagedAppPath: "/tmp/staged/GravityBox.app",
                targetAppPath: "/Applications/GravityBox.app",
                workDirPath: "/tmp/staged",
                dmgFilePath: "/tmp/updates/v1.0.4/GravityBox-1.0.4-arm64.dmg"
            )
            check(updaterScript.contains("HUP TERM INT QUIT PIPE") && updaterScript.contains("kill -9 12345") && updaterScript.contains("--install-update"), "Detached updater must wait for its parent then invoke the transactional helper")
            check(!updaterScript.contains("rm -rf") && !updaterScript.contains("ditto"), "Detached launcher must never delete or copy over the live app")
            check(AppUpdateManager.extractGravityBoxDMGVersion(from: "GravityBox-1.0.4-arm64.dmg") == "1.0.4", "Must extract version from standard arm64 DMG filename")
            check(AppUpdateManager.extractGravityBoxDMGVersion(from: "GravityBox-v1.0.3-universal.dmg.sha256") == "1.0.3", "Must extract version from v-prefixed DMG sha256 sidecar")
            check(AppUpdateManager.extractGravityBoxDMGVersion(from: "OtherApp-1.0.4-arm64.dmg") == nil, "Must ignore unrelated DMG filenames")

            // Test cleanupObsoleteUpdateArtifacts across state/updates and Downloads
            let fm = FileManager.default
            let oldUpdateDir = state.appendingPathComponent("updates/v1.0.3", isDirectory: true)
            let currUpdateDir = state.appendingPathComponent("updates/v1.0.4", isDirectory: true)
            let newerUpdateDir = state.appendingPathComponent("updates/v1.1.0", isDirectory: true)
            let staleInstallDir = state.appendingPathComponent("updates/install-stale", isDirectory: true)
            let staleTxDir = state.appendingPathComponent("updates/transactions/install-aborted", isDirectory: true)
            let confirmedTxDir = state.appendingPathComponent("updates/transactions/install-confirmed", isDirectory: true)
            let fakeDownloadsDir = state.appendingPathComponent("test-downloads", isDirectory: true)
            for dir in [oldUpdateDir, currUpdateDir, newerUpdateDir, staleInstallDir, staleTxDir, confirmedTxDir, fakeDownloadsDir] {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            }
            let confirmedReceipt = UpdateInstallReceipt(phase: "confirmed", token: "tok", targetPath: "/Applications/GravityBox.app", backupPath: "/Applications/.GravityBox-backup-test.app", expectedVersion: "1.0.5", newAppHash: "abc", oldAppHash: "def", dmgPath: "")
            try confirmedReceipt.save(to: confirmedTxDir.appendingPathComponent(UpdateInstaller.receiptName))
            let confirmedStagedApp = confirmedTxDir.appendingPathComponent("GravityBox.app")
            let confirmedHelper = confirmedTxDir.appendingPathComponent("installer")
            try fm.createDirectory(at: confirmedStagedApp, withIntermediateDirectories: true)
            try Data("helper".utf8).write(to: confirmedHelper)
            let oldCachedDMG = oldUpdateDir.appendingPathComponent("GravityBox-1.0.3-arm64.dmg")
            let currCachedDMG = currUpdateDir.appendingPathComponent("GravityBox-1.0.4-arm64.dmg")
            let newerCachedDMG = newerUpdateDir.appendingPathComponent("GravityBox-1.1.0-arm64.dmg")
            let newerPartDMG = newerUpdateDir.appendingPathComponent("download-temp.dmg.part")
            let dlOldDMG = fakeDownloadsDir.appendingPathComponent("GravityBox-1.0.3-arm64.dmg")
            let dlCurrDMG = fakeDownloadsDir.appendingPathComponent("GravityBox-1.0.4-arm64.dmg")
            let dlCurrSha = fakeDownloadsDir.appendingPathComponent("GravityBox-1.0.4-arm64.dmg.sha256")
            let dlNewerDMG = fakeDownloadsDir.appendingPathComponent("GravityBox-1.1.0-arm64.dmg")
            let dlUnrelated = fakeDownloadsDir.appendingPathComponent("Antigravity-2.29.0.dmg")
            for f in [oldCachedDMG, currCachedDMG, newerCachedDMG, newerPartDMG, dlOldDMG, dlCurrDMG, dlCurrSha, dlNewerDMG, dlUnrelated] {
                try Data("dummy".utf8).write(to: f)
            }
            let previousCleanedVersion = assistant.configuration.value.lastCleanedVersion
            let unconfirmedCount = assistant.updateManager.cleanupObsoleteUpdateArtifacts(
                restartedAfterUpdate: true,
                currentVersionOverride: "1.0.4",
                downloadsDirectory: fakeDownloadsDir,
                detachMountedVolumes: false
            )
            check(unconfirmedCount == 0, "Startup, version change and restarted-after-update flags alone must never trigger cleanup")
            for f in [oldCachedDMG, currCachedDMG, newerCachedDMG, newerPartDMG, dlOldDMG, dlCurrDMG, dlCurrSha] {
                check(fm.fileExists(atPath: f.path), "Unconfirmed update must retain packages and checksums")
            }
            check(assistant.configuration.value.lastCleanedVersion == previousCleanedVersion, "Unconfirmed launch must not advance cleanup marker")
            let cleanedCount = assistant.updateManager.cleanupObsoleteUpdateArtifacts(
                successfulLaunchConfirmed: true,
                restartedAfterUpdate: true,
                currentVersionOverride: "1.0.4",
                downloadsDirectory: fakeDownloadsDir,
                detachMountedVolumes: false
            )
            check(cleanedCount >= 6, "cleanupObsoleteUpdateArtifacts must clean obsolete update folders, part files, and <=1.0.4 Downloads DMGs")
            check(!fm.fileExists(atPath: oldUpdateDir.path) && !fm.fileExists(atPath: currUpdateDir.path) && !fm.fileExists(atPath: staleInstallDir.path) && !fm.fileExists(atPath: staleTxDir.path), "Obsolete updates/v<=1.0.4 and install-* directories must be removed")
            check(!fm.fileExists(atPath: confirmedStagedApp.path) && !fm.fileExists(atPath: confirmedHelper.path) && fm.fileExists(atPath: confirmedTxDir.appendingPathComponent(UpdateInstaller.receiptName).path), "Confirmed transaction must clean staged GravityBox.app and installer while retaining install-receipt.json")
            check(fm.fileExists(atPath: newerCachedDMG.path) && !fm.fileExists(atPath: newerPartDMG.path), "Newer pre-downloaded DMG (v1.1.0 > 1.0.4) must be preserved while .dmg.part is cleaned")
            check(!fm.fileExists(atPath: dlOldDMG.path) && !fm.fileExists(atPath: dlCurrDMG.path) && !fm.fileExists(atPath: dlCurrSha.path), "Downloads DMGs and .sha256 for versions <= 1.0.4 must be cleaned")
            check(fm.fileExists(atPath: dlNewerDMG.path) && fm.fileExists(atPath: dlUnrelated.path), "Downloads DMGs for newer versions (>1.0.4) and unrelated apps must be preserved")
            check(assistant.configuration.value.lastCleanedVersion == "1.0.4", "cleanupObsoleteUpdateArtifacts must persist lastCleanedVersion = 1.0.4")
            try? fm.removeItem(at: state.appendingPathComponent("updates"))
            try? fm.removeItem(at: fakeDownloadsDir)

            for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
                updateSheet.sheet.appearance = NSAppearance(named: appearance)
                updateSheet.sheet.contentView?.layoutSubtreeIfNeeded(); pump()
                try capture(updateSheet.sheet.contentView!, output.appendingPathComponent("\(theme)-update-sheet-available.png"))
            }
            // Verify checking state spinner is embedded inside primaryBtn and exit button is 完成 at bottom-right
            let savedRelease = assistant.updateManager.availableRelease
            assistant.updateManager.simulateChecking()
            updateSheet.sheet.contentView?.layoutSubtreeIfNeeded()
            check(updateSheet.primaryBtn.title == "检查中…" && updateSheet.closeBtn.title == "完成" && updateSheet.changelogHeading.stringValue == "版本说明", "Checking state must render 版本说明 heading, 完成 button and 检查中… primary button")
            check(updateSheet.closeBtn.frame.minX > updateSheet.primaryBtn.frame.maxX, "Checking state must place 完成 button at far bottom-right")
            check(updateSheet.spinner.superview === updateSheet.primaryBtn && !updateSheet.spinner.isHidden, "Checking spinner must be embedded inside primaryBtn")
            for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
                updateSheet.sheet.appearance = NSAppearance(named: appearance)
                updateSheet.sheet.contentView?.layoutSubtreeIfNeeded(); pump()
                try capture(updateSheet.sheet.contentView!, output.appendingPathComponent("\(theme)-update-sheet-checking.png"))
            }
            assistant.updateManager.simulateRelease(savedRelease)
            updateSheet.sheet.contentView?.layoutSubtreeIfNeeded()
            check(updateSheet.primaryBtn.frame.minX > updateSheet.closeBtn.frame.maxX, "Update available state must place primary update action at far bottom-right")

            check(updateSheet.autoUpdateSwitch.state == .off, "Auto update switch in sheet footer must default to off")
            updateSheet.autoUpdateSwitch.state = .off
            updateSheet.toggleAutoUpdate()
            check(assistant.configuration.value.autoUpdateEnabled == false, "Toggling autoUpdateSwitch must persist autoUpdateEnabled = false")
            updateSheet.autoUpdateSwitch.state = .on
            updateSheet.toggleAutoUpdate()
            check(assistant.configuration.value.autoUpdateEnabled == true, "Toggling autoUpdateSwitch back must persist autoUpdateEnabled = true")
            assistant.dismissAllSheetsAndPopovers(); pump()
            check(window.activeSheetWindow == nil, "dismissAllSheetsAndPopovers must cleanly end attached modal update sheet before update restart")
        }
        assistant.updateManager.simulateRelease(nil)
        aboutPage.refreshUpdateState()
        check(!aboutPage.checkUpdateBtn.isHidden && aboutPage.installNowBtn.isHidden, "Clearing available release must restore 检查更新 button on About page")
        check(assistant.installUpdateButton?.isHidden == true, "Clearing available release must hide sidebar installUpdateButton again")
        if let updateSheet = assistant.updateSheet {
            check(updateSheet.closeBtn.isEnabled == true && updateSheet.primaryBtn.isEnabled == true && !updateSheet.primaryBtn.showsSpinner, "Transitioning to upToDate must keep closeBtn and primaryBtn enabled without spinner")
            check(updateSheet.changelogHeading.stringValue == "当前版本状态", "Update sheet upToDate state must display 当前版本状态 heading")
            check(updateSheet.changelogTextView.textContainer?.lineFragmentPadding == 0, "Update sheet changelogTextView must have zero lineFragmentPadding for flush-left alignment")
            for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
                updateSheet.sheet.appearance = NSAppearance(named: appearance)
                updateSheet.sheet.contentView?.layoutSubtreeIfNeeded(); pump()
                try capture(updateSheet.sheet.contentView!, output.appendingPathComponent("\(theme)-update-sheet-uptodate.png"))
            }
        }
        // Verify unified inactive PillBadge styling across neutral/secondary tints
        let lightApp = NSAppearance(named: .aqua)!
        let darkApp = NSAppearance(named: .darkAqua)!
        for c in [Design.inactivePill, Design.secondary, NSColor.secondaryLabelColor, NSColor.systemGray] {
            check(PillBadge.isNeutralOrInactiveTint(c, in: lightApp), "Neutral/inactive tint must be recognized in Light mode")
            check(PillBadge.isNeutralOrInactiveTint(c, in: darkApp), "Neutral/inactive tint must be recognized in Dark mode")
        }
        check(!PillBadge.isNeutralOrInactiveTint(Design.blue, in: lightApp), "Active blue tint must not be treated as neutral/inactive")

        // Capture Overview in idle (0 active models, 0 hourly tokens) to verify unified inactive capsules
        assistant.selectPage(0); window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 960, height: 640)), display: true); pump()
        assistant.cachedUsageReportsByPeriod["today"] = [
            "summary": totals,
            "byModel": [],
            "todayHourly": []
        ]
        assistant.overview!.updateReadinessMatrix()
        check(assistant.overview!.todayPeakBadge.title == "24 小时分布" && assistant.overview!.rightBentoCountBadge.title == "暂无调用", "Overview idle badges must show 24 小时分布 and 暂无调用")
        for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            window.appearance = NSAppearance(named: appearance)
            window.contentView?.layoutSubtreeIfNeeded()
            try capture(window.contentView!, output.appendingPathComponent("\(theme)-overview-idle-pills.png"))
        }
        assistant.cachedUsageReportsByPeriod["today"] = [
            "summary": totals,
            "byModel": models,
            "todayHourly": todayHourly
        ]
        assistant.overview!.updateReadinessMatrix()

        // Verify AccountsPage unified & per-card collapse/expand behavior and removal of Backup button
        assistant.selectPage(1); pump()
        let accPage = assistant.accountsPage!
        accPage.fetch(); pump()
        window.appearance = NSAppearance(named: .aqua)
        window.contentView?.layoutSubtreeIfNeeded(); pump()
        func allAccButtons(_ v: NSView) -> [NSButton] { (v as? NSButton).map { [$0] } ?? v.subviews.flatMap { allAccButtons($0) } }
        check(!allAccButtons(accPage.view).contains { $0.title == "备份…" }, "AccountsPage header must remove 备份… button")
        check((accPage.toggleCollapseAllButton as? DesignButton)?.isQuietAccessory == false, "AccountsPage 收起配额/展开配额 button must match global capsule button style")
        check(accPage.autoSwitchStatusBadge.title == "已停用", "Smart switch disabled state must retain 已停用 pill badge")
        let offSubtitle = accPage.policySubtitleLabel.stringValue
        accPage.autoSwitchToggle.state = .on
        accPage.updateAutoSwitchState()
        check(accPage.autoSwitchStatusBadge.title.hasPrefix("已启用"), "Smart switch enabled state must display 已启用 pill badge")
        check(accPage.policySubtitleLabel.stringValue == offSubtitle, "Smart switch subtitle must stay consistent between ON and OFF states")
        accPage.autoSwitchToggle.state = .off
        accPage.updateAutoSwitchState()
        check(!accPage.toggleCollapseAllButton.isHidden && accPage.toggleCollapseAllButton.title == "收起配额", "AccountsPage header must show 收起配额 button when cards are expanded")
        let expandedFirstCardHeight = accPage.cardsStack.arrangedSubviews.first?.bounds.height ?? 0
        check(expandedFirstCardHeight > 180, "Expanded account card height must include full quota bars (>180pt)")

        accPage.toggleCollapseAllAccounts(); pump()
        window.contentView?.layoutSubtreeIfNeeded(); pump()
        check(accPage.isAllCollapsedMode && accPage.collapsedAccountIds.count == 3, "Clicking 收起配额 must collapse all 3 account cards")
        check(accPage.toggleCollapseAllButton.title == "展开配额", "Header button title must switch to 展开配额 when all cards are collapsed")
        check(assistant.configuration.value.accountsCollapsed == true, "Collapsing all accounts must persist accountsCollapsed = true in configuration")
        let collapsedFirstCardHeight = accPage.cardsStack.arrangedSubviews.first?.bounds.height ?? 0
        check(collapsedFirstCardHeight > 40 && collapsedFirstCardHeight < expandedFirstCardHeight - 100, "Collapsed account card height must shrink by >100pt (got \(collapsedFirstCardHeight) vs \(expandedFirstCardHeight))")
        let collapsedTexts = allTextValues(accPage.cardsStack)
        check(collapsedTexts.contains { $0.contains("Gemini 91%") && $0.contains("Claude/GPT 0%") }, "Collapsed account card must display inline quota summary")
        for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            window.appearance = NSAppearance(named: appearance)
            window.contentView?.layoutSubtreeIfNeeded(); pump()
            try capture(window.contentView!, output.appendingPathComponent("\(theme)-accounts-collapsed.png"))
        }

        // Toggle single account card expand while others stay collapsed
        let singleBtn = NSButton()
        singleBtn.identifier = NSUserInterfaceItemIdentifier("a")
        accPage.toggleSingleAccountCollapse(singleBtn); pump()
        window.contentView?.layoutSubtreeIfNeeded(); pump()
        check(!accPage.collapsedAccountIds.contains("a") && accPage.collapsedAccountIds.contains("b"), "Per-card collapse button must expand account a while keeping b collapsed")
        check(accPage.toggleCollapseAllButton.title == "收起配额", "When any card is expanded, header button must offer 收起配额")

        // Collapse all again, then expand all
        accPage.toggleCollapseAllAccounts(); pump()
        check(accPage.collapsedAccountIds.count == 3 && accPage.toggleCollapseAllButton.title == "展开配额", "Clicking 收起配额 when partially expanded must collapse all cards")
        accPage.toggleCollapseAllAccounts(); pump()
        check(accPage.collapsedAccountIds.isEmpty && accPage.toggleCollapseAllButton.title == "收起配额" && assistant.configuration.value.accountsCollapsed == false, "Clicking 展开配额 must expand all cards and persist accountsCollapsed = false")

        let stableAccounts = AccountsPage(app: assistant)
        stableAccounts.updateAutoSwitchState()
        check(stableAccounts.autoSwitchToggle.isEnabled && stableAccounts.configButton.isEnabled, "All account switch controls must remain enabled for stable Antigravity")
        check(!allTextValues(stableAccounts.view).contains { $0.localizedCaseInsensitiveContains("Insiders") }, "Accounts UI must not mention Insiders")
        let stableAdd = AddAccountSheet(app: assistant) {}
        check(stableAdd.currentButton.isEnabled, "Save current account must remain enabled for stable Antigravity")
        stableAdd.busy(false)
        check(stableAdd.currentButton.isEnabled, "Leaving busy state must keep save current account enabled")
        check(!allTextValues(stableAdd.window.contentView!).contains { $0.localizedCaseInsensitiveContains("Insiders") }, "AddAccountSheet UI must not mention Insiders")
        assistant.pageHost.subviews.forEach { $0.removeFromSuperview() }
        assistant.preferencesController = stableSettings
        assistant.currentPage = -1
        assistant.selectPage(3); window.setContentSize(NSSize(width: 1060, height: 760)); pump()
        try capture(window.contentView!, output.appendingPathComponent("stable-settings.png"))

        // Verify translationSwitch target-based state toggling and error-recovery behavior
        check(stableSettings.translationSwitch.isEnabled == true, "translationSwitch must be enabled when reachable")
        check((stableSettings.translationSwitch as AnyObject) is DesignSwitch && (stableSettings.hudSwitch as AnyObject) is DesignSwitch && (stableAccounts.autoSwitchToggle as AnyObject) is DesignSwitch, "Switches must use DesignSwitch to stay blue when window is unfocused")
        check(stableSettings.translationSwitch.state == .on, "translationSwitch must be on when status mode is adaptive")
        check(stableSettings.translationSwitch.toolTip == nil, "translationSwitch must not display hover tooltip")

        // Verify More Menu (…) includes 对话状态栏 right below 界面汉化
        let moreMenu = assistant.buildMoreMenu()
        let moreTitles = moreMenu.items.map(\.title)
        if let transIdx = moreTitles.firstIndex(of: "界面汉化"), let hudIdx = moreTitles.firstIndex(of: "对话状态栏") {
            check(hudIdx == transIdx + 1, "对话状态栏 must sit directly below 界面汉化 in More menu")
        } else {
            check(false, "More menu must contain both 界面汉化 and 对话状态栏")
        }

        // Verify global zero-tooltip requirement across all pages and menu panel
        func hasNonEmptyTooltip(_ v: NSView) -> String? {
            if let tip = v.toolTip, !tip.isEmpty { return "\(type(of: v)): \(tip)" }
            for sub in v.subviews {
                if let found = hasNonEmptyTooltip(sub) { return found }
            }
            return nil
        }
        for pageView: NSView in [assistant.overview!.view, assistant.accountsPage!.view, assistant.usagePage!.view, stableSettings.view!, aboutPage.view, menuPanel.view] {
            let found = hasNonEmptyTooltip(pageView)
            check(found == nil, "Global tooltip cleanup violated on view: \(found ?? "")")
        }

        // 0. Verify unreachable backend (e.g. Node process blocked by Gatekeeper quarantine): switch stays greyed out
        assistant.reachable = false
        stableSettings.update()
        check(stableSettings.translationSwitch.isEnabled == false, "translationSwitch must remain greyed out / disabled when backend is unreachable due to Gatekeeper quarantine interception")
        check(stableSettings.translationSwitch.toolTip == nil, "translationSwitch must not show hover tooltip when backend is unreachable")
        let menuDisabled = NSMenu()
        assistant.menuNeedsUpdate(menuDisabled)
        let toggleDisabled = menuDisabled.items.first { $0.title == "界面汉化" }
        check(toggleDisabled?.isEnabled == false, "Menu bar translation toggle must be disabled when backend is unreachable")

        assistant.reachable = true
        stableSettings.update()
        check(stableSettings.translationSwitch.isEnabled == true, "translationSwitch must become enabled once backend is reachable after quarantine clearance")
        let menuEnabled = NSMenu()
        assistant.menuNeedsUpdate(menuEnabled)
        let toggleEnabled = menuEnabled.items.first { $0.title == "界面汉化" }
        check(toggleEnabled?.isEnabled == true, "Menu bar translation toggle must become enabled once backend is reachable")

        // 1. User flips switch from ON to OFF
        stableSettings.translationSwitch.state = .off
        stableSettings.toggleTranslation()
        pump()
        check(lastTranslationCommand == "pause", "Flipping translationSwitch to off must send pause command")

        // 2. User flips switch from OFF to ON
        stableSettings.translationSwitch.state = .on
        stableSettings.toggleTranslation()
        pump()
        check(lastTranslationCommand == "resume", "Flipping translationSwitch to on must send resume command")

        // 3. User attempts to turn ON translation when system is in error mode (switch is OFF)
        assistant.statusValue = LiveStatus(["mode": "error", "message": "连接中断", "appVersion": "2.29.1"])
        stableSettings.update()
        check(stableSettings.translationSwitch.state == .off, "translationSwitch must be off when status mode is error")
        check(stableSettings.translationSwitch.toolTip == nil, "translationSwitch must not display hover tooltip in error mode")
        // User flips switch ON to recover/retry
        stableSettings.translationSwitch.state = .on
        stableSettings.toggleTranslation()
        pump()
        check(lastTranslationCommand == "resume", "Turning on translationSwitch from error mode must send resume (not pause!)")
        check(assistant.statusValue.enabled == true, "Optimistic state after turning on translationSwitch must report enabled == true")

        // 4. Verify LiveStatus.enabled respects translationEnabled during starting/error states
        let pausedStartingStatus = LiveStatus(["mode": "starting", "translationEnabled": false, "appVersion": "2.29.1"])
        check(pausedStartingStatus.enabled == false, "starting mode with translationEnabled=false must report enabled == false")
        assistant.statusValue = pausedStartingStatus
        stableSettings.update()
        check(stableSettings.translationSwitch.state == .off, "translationSwitch must stay off when starting in paused mode")
        stableSettings.translationSwitch.state = .on
        stableSettings.toggleTranslation()
        pump()
        check(lastTranslationCommand == "resume" && assistant.statusValue.enabled == true, "Turning on switch during paused starting state must send resume and optimistically enable")

        // 5. Menu bar toggle command toggling based on perceived enabled state
        assistant.statusValue = LiveStatus(["mode": "adaptive", "appVersion": "2.29.1"])
        assistant.toggleTranslation()
        pump()
        check(lastTranslationCommand == "pause", "Menu toggleTranslation when enabled must send pause")
        assistant.statusValue = LiveStatus(["mode": "paused", "appVersion": "2.29.1"])
        assistant.toggleTranslation()
        pump()
        check(lastTranslationCommand == "resume", "Menu toggleTranslation when paused must send resume")

        // Restore normal status
        assistant.statusValue = LiveStatus(status)
        stableSettings.update()
        check(stableSettings.hudSwitch.isEnabled == true && stableSettings.hudSwitch.state == .on, "hudSwitch must default to on and enabled when translation is active")
        stableSettings.hudSwitch.state = .off
        stableSettings.toggleHud()
        pump()
        check(lastHudCommandEnabled == false && assistant.configuration.value.hudEnabled == false, "Turning off hudSwitch must send hud_set(false) and persist hudEnabled=false")
        stableSettings.hudSwitch.state = .on
        stableSettings.toggleHud()
        pump()
        check(lastHudCommandEnabled == true && assistant.configuration.value.hudEnabled == true, "Turning on hudSwitch must send hud_set(true) and persist hudEnabled=true")

        DesktopApplicationTarget.installedChannelsOverride = ["stable"]
        check(DesktopApplicationTarget.bothInstalled == false, "Single-app mode must report bothInstalled == false")
        check(DesktopApplicationTarget.effectiveChannel(configured: "insiders") == "stable", "Single-app mode must auto-fallback to sole installed app")
        DesktopApplicationTarget.installedChannelsOverride = ["insiders"]
        check(DesktopApplicationTarget.installedChannels().isEmpty, "Insiders alone is not a supported installation")
        check(DesktopApplicationTarget.preferredLaunchPath() == "/Applications/Antigravity.app", "Launch must not fall back to Insiders")
        DesktopApplicationTarget.installedChannelsOverride = nil

        // Exercise the real download/cache path with local fixture bytes; no external requests or installation.
        let updateRoot = state.appendingPathComponent("update-integrity-fixtures")
        try FileManager.default.createDirectory(at: updateRoot, withIntermediateDirectories: true)
        let fakeDMG = updateRoot.appendingPathComponent("source.dmg")
        try Data("synthetic package".utf8).write(to: fakeDMG)
        let malformed = updateRoot.appendingPathComponent("malformed.sha256")
        try Data("invalid".utf8).write(to: malformed)
        let wrongName = updateRoot.appendingPathComponent("wrong-name.sha256")
        try Data((String(repeating: "0", count: 64) + "  Other.dmg\n").utf8).write(to: wrongName)
        let mismatch = updateRoot.appendingPathComponent("mismatch.sha256")
        try Data((String(repeating: "0", count: 64) + "  GravityBox-9.9.9-arm64.dmg\n").utf8).write(to: mismatch)
        let sources: [URL?] = [nil, updateRoot.appendingPathComponent("missing.sha256"), malformed, wrongName, mismatch]
        for source in sources {
            let release = AppReleaseInfo(version: "9.9.9", tagName: "v9.9.9", title: "fixture", changelog: "", publishedDate: "", htmlURL: URL(string: "https://example.invalid")!, dmgURL: fakeDMG, sha256URL: source)
            var finished = false, accepted = false
            assistant.updateManager.preDownloadRelease(release, silent: false) { result in
                if case .success = result { accepted = true }
                finished = true
            }
            waitUntil(description: "preDownloadRelease to finish") {
                finished
            }
            check(finished && !accepted && assistant.updateManager.downloadedDMGURL == nil, "Invalid or missing checksum must never produce an installable package")
        }
        let cachedDMG = state.appendingPathComponent("updates/v9.9.9/GravityBox-9.9.9-arm64.dmg")
        try FileManager.default.createDirectory(at: cachedDMG.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("previously verified synthetic package".utf8).write(to: cachedDMG)
        let cachedHash = try UpdatePackageIntegrity.fileHash(cachedDMG)
        try Data("\(cachedHash)  \(cachedDMG.lastPathComponent)\n".utf8).write(to: cachedDMG.appendingPathExtension("sha256"))
        try AppUpdateManager.verifyCachedDownload(cachedDMG)
        try Data("tampered cached package".utf8).write(to: cachedDMG)
        var rejectedCache = false
        do { try AppUpdateManager.verifyCachedDownload(cachedDMG) } catch { rejectedCache = true }
        check(rejectedCache, "Cached packages must be rehashed before installation")
        assistant.updateManager.simulateRelease(nil)

        Assistant.applicationChannel = "stable"
        assistant.configuration.value.applicationChannel = "stable"
        // Failed account changes must never export stale contents under the new account name.
        do {
            let isolated = Assistant(state: state.appendingPathComponent("usage-query-contract"))
            isolated.configuration = try ConfigurationStore(state: isolated.state)
            isolated.bridge = BackendBridge(resources: state, state: isolated.state)
            isolated.reachable = true
            var fail = false
            isolated.bridge.fixtureReply = { request in
                if fail { return ["ok": false, "error": "synthetic read failure"] }
                return ["ok": true, "period": request["period"] as? String ?? "today", "selectedAccountId": "all", "snapshotId": "stable-query-snapshot", "summary": ["availability": "complete", "totalTokens": 150, "requestCount": 1, "databasesScanned": 1, "databasesDiscovered": 1], "byModel": [], "dailyTrends": [], "todayHourly": []]
            }
            let page = UsagePage(app: isolated)
            pump()
            fail = true; page.fetch(force: true); pump()
            check(page.statusSummary.stringValue.contains("读取失败"), "Failure feedback must be present")
            fail = false; page.fetch(force: true); pump()
            check(!page.statusSummary.stringValue.contains("读取失败"), "Same snapshot success must clear an earlier failure")
            page.periodSegment.selectedSegment = 1
            fail = true; page.fetch(force: true); pump()
            check(!page.exportButton.isEnabled, "A period mismatch must disable stale export")
            if let overview = assistant.dashboardPage {
                overview.renderSummary([
                    "accounts": ["activeEmail": "test@example.invalid", "activeName": "Test", "activeTier": "PRO", "isLiveVerified": true],
                    "usage": ["todayTokens": 100, "totalTokens": 1000, "estimatedUsd": 0.1, "allTimeEstimatedUsd": 1.0, "requestCount": 1, "totalRequestCount": 10, "databasesScanned": 378, "databasesDiscovered": 378, "failedDatabasesCount": 0, "skippedLargeRecords": 0, "unknownTimeRecords": 0, "hasError": false, "availability": "partial"]
                ], isStaleFallback: false)
                check(overview.usageQualityLabel.isHidden, "Overview usageQualityLabel must remain hidden when 378/378 DBs succeeded with 0 failed/skipped/unknown despite partial historical availability")
            }
            page.updateReadStatus(["databasesScanned": 378, "databasesDiscovered": 378, "failedDatabasesCount": 0, "skippedLargeRecords": 0, "unknownTimeRecords": 0, "unpricedModels": 0, "availability": "partial", "pricing_warnings": ["旧JSON含缺少来源或归属证据的记录，原件已保留；请查看只读账本预览", "历史金额凭据缺少原始用量或时间，已单独保留待核对，不计入Token和请求数"]])
            check(page.footerBox.isHidden, "Usage footerBox must remain hidden in healthy state even with read-only legacy archive notes")
            page.updateReadStatus(["databasesScanned": 377, "databasesDiscovered": 378, "failedDatabasesCount": 1, "skippedLargeRecords": 0, "unknownTimeRecords": 0, "unpricedModels": 0, "availability": "partial"])
            check(!page.footerBox.isHidden && page.statusSummary.stringValue.contains("1"), "Usage footerBox must appear when failedDatabasesCount > 0")
            let pricingSheet = PricingSyncSheetController(app: isolated)
            pricingSheet.apply(payload: [
                "synced": true,
                "count": 2,
                "version": "2026-11-13",
                "status": ["lastCheckAt": 1794539810722.0, "modelCount": 2],
                "prices": [
                    "gemini-3.8-flash": [
                        "input": 0.75, "output": 3.75, "cached": 0.075,
                        "provenance": ["platform": "Google Cloud 标准 Global API", "checkedAt": "2026-11-12", "validUntil": "2026-12-31T23:59:59Z", "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/pricing"]
                    ],
                    "gemini-4-hydrogen": [
                        "input": 1.5, "output": 7.5, "cached": 0.075, "cacheWrite": 0,
                        "provenance": ["platform": "Google Cloud 标准 Global API", "checkedAt": "2026-11-13", "sourceUrl": "https://cloud.google.com/model-garden/pricing?hl=en"]
                    ]
                ],
                "pricingStatus": ["gemini-3.8-flash": "confirmed", "gemini-4-hydrogen": "confirmed"],
            ])
            check(pricingSheet.sheet.contentView != nil, "PricingSyncSheetController must populate native sheet view")
            func allPricingButtons(_ v: NSView) -> [NSButton] { (v as? NSButton).map { [$0] } ?? v.subviews.flatMap { allPricingButtons($0) } }
            check(!allPricingButtons(pricingSheet.sheet.contentView!).contains { $0.title == "复制价格表" }, "PricingSyncSheetController must remove 复制价格表 button")
            check(pricingSheet.closeBtn.title == "完成", "PricingSyncSheetController exit button must be titled 完成")
            check(pricingSheet.subtitleLabel.isHidden && pricingSheet.subtitleLabel.stringValue.isEmpty, "PricingSyncSheetController must hide header subtitle on normal synced state")
            check(pricingSheet.summaryPill.title.hasPrefix("已同步 ") && pricingSheet.summaryPill.title.hasSuffix("· 2 款"), "PricingSyncSheetController pill must display latest sync time and active count: \(pricingSheet.summaryPill.title)")
            check(!pricingSheet.historicalNoteLabel.isHidden && pricingSheet.historicalNoteLabel.stringValue.contains("已下架模型"), "PricingSyncSheetController must explain historical pricing retention")
            check(pricingSheet.renderedSummaryLines.contains { $0.contains("官方定价 2026-11-12 · 优惠至 2026-12-31") } && !pricingSheet.renderedSummaryLines.contains { $0.contains("核对 2026") }, "PricingSyncSheetController must use Plan 1 date wording")
            try capture(pricingSheet.sheet.contentView!, output.appendingPathComponent("light-pricing-sheet.png"))
            pricingSheet.apply(payload: [
                "synced": false,
                "error": "offline",
                "status": ["lastCheckAt": 1794539910722.0, "modelCount": 1],
                "prices": [
                    "gemini-4-hydrogen": ["input": 1.5, "output": 7.5, "cached": 0.075]
                ],
                "pricingStatus": ["gemini-4-hydrogen": "confirmed"],
            ])
            check(!pricingSheet.subtitleLabel.isHidden && pricingSheet.subtitleLabel.stringValue == "检查提示：offline", "PricingSyncSheetController must show concise failure reason without unit suffix")
            check(pricingSheet.summaryPill.title.hasSuffix("· 1 款"), "PricingSyncSheetController pill must display failed check time and active count: \(pricingSheet.summaryPill.title)")
            var checks = 0
            let manager = isolated.updateManager
            manager.checkTransport = { request, completion in
                checks += 1
                DispatchQueue.global().async {
                    let response = HTTPURLResponse(url: request.url!, statusCode: 403, httpVersion: nil, headerFields: nil)
                    completion(nil, response, nil)
                }
            }
            manager.checkForUpdates(silent: true)
            manager.checkForUpdates(silent: false)
            pump()
            check(checks == 1, "Overlapping update checks must share the main-thread busy gate")
            manager.checkForUpdates(silent: false)
            pump()
            check(checks == 2, "A background 403 must reset busy state so retry can run")
            for (input, expected) in [(999, "999"), (1000, "1K"), (999499, "999K"), (999500, "1M"), (999999, "1M"), (1_000_000, "1M"), (999_500_000, "1B")] {
                check(InterfaceText.formatCompactTokens(input) == expected, "Compact number boundary must match HUD: \(input)")
            }
            let appPaths = ["/Applications/Antigravity.app"]
            check(
                Assistant.hasRunningAntigravityProcess(
                    psOutput: "/Applications/Antigravity.app/Contents/MacOS/Electron\n",
                    appPaths: appPaths
                ) == true,
                "Executable inside Antigravity.app/Contents must count as running"
            )
            check(
                Assistant.hasRunningAntigravityProcess(
                    psOutput: "/bin/zsh -c ls /Applications/Antigravity.app/Contents/Resources\n",
                    appPaths: appPaths
                ) == false,
                "Unrelated process mentioning app path in arguments must not block switching"
            )
            isolated.suppressLifecycleAutoQuit(seconds: 60.0)
            let longDeadline = isolated.suppressLifecycleAutoQuitUntil
            isolated.suppressLifecycleAutoQuit(seconds: 5.0)
            check(
                isolated.suppressLifecycleAutoQuitUntil >= longDeadline,
                "Shorter lifecycle auto-quit suppression must not shorten an existing longer deadline"
            )
        }

        // Exercise the real countdown view, rather than a JS reimplementation of its old colors.
        let countdown = QuotaBarView(percentage: 80, resetText: "6天12小时后重置")
        check(countdown.resetLabel.textColor == Design.secondary, "Normal countdown stays neutral")
        countdown.update(percentage: 5, resetText: "3小时后重置")
        check(countdown.resetLabel.textColor == Design.secondary, "Low percentage does not turn a normal reset time into an urgent notice")
        countdown.update(percentage: 50, resetText: "即将重置")
        check(countdown.resetLabel.textColor != Design.secondary, "Imminent reset uses warning color")
        countdown.update(percentage: 50, resetText: "重置时间已过")
        check(countdown.resetLabel.textColor != Design.secondary, "Expired reset uses warning color")

        // Production account quota updates reuse card views, including unchanged snapshots.
        do {
            let page = assistant.accountsPage!
            let windows = ["gemini":["fiveHour":bucket(80),"weekly":bucket(90)],"claude":["fiveHour":bucket(100),"weekly":bucket(70)]]
            let base: [String: Any] = ["id":"gate-account", "email":"gate@example.invalid", "revision":"gate-revision", "familyWindows":windows]
            page.fetch(["accounts":[base], "activeId":"gate-account"])
            let cards = page.cardsStack.arrangedSubviews
            page.fetch(["accounts":[base], "activeId":"gate-account"])
            check(zip(cards,page.cardsStack.arrangedSubviews).allSatisfy { $0 === $1 }, "Identical snapshots retain card views")
            func quotaViews(_ view: NSView) -> [QuotaBarView] { (view as? QuotaBarView).map{[$0]} ?? view.subviews.flatMap{quotaViews($0)} }
            for (family, key, percent, title) in [("gemini","fiveHour",40.0,"Gemini · 5 小时"),("gemini","weekly",85.0,"Gemini · 每周"),("claude","fiveHour",50.0,"Claude/GPT · 5 小时")] {
                var changed = base
                var nextWindows = windows; nextWindows[family]?[key] = bucket(percent)
                changed["familyWindows"] = nextWindows
                page.fetch(["accounts":[changed], "activeId":"gate-account"])
                check(quotaViews(page.view).contains { $0.titleLabel.stringValue == title && $0.percentageKnown && $0.percentage == Int(percent) }, "Production card refresh observes \(family)/\(key)")
                check(page.cardsStack.arrangedSubviews.count == cards.count && zip(cards,page.cardsStack.arrangedSubviews).allSatisfy { $0 === $1 }, "Account quota changes reuse existing card views")
            }
        }

        // Production dashboard identity handling includes mismatch, missing identity and offline states.
        do {
            let page = assistant.dashboardPage!
            for (verified, liveEmail, expectedStatus) in [(true,"other@example.invalid","账号不一致"),(true,"gate@example.invalid",""),(true,"",""),(false,"","")] {
                page.renderSummary(["accounts":["activeEmail":"gate@example.invalid", "isLiveVerified":verified, "liveAccountEmail":liveEmail]], isStaleFallback:false)
                check(page.accountStatusLabel.stringValue == expectedStatus, "Production dashboard identity status for \(liveEmail)")
                check(page.activeEmailLabel.stringValue == "gate@example.invalid", "Identity warning preserves saved email")
                check(page.currentAccountPill.title == (verified ? "当前账号" : "已选记录"), "Offline state cannot claim a verified current account")
            }
        }

        let result:[String:Any] = ["stableOnlySelectionPassed":true,"nativeLayouts":captures.count,"captures":captures,"menuCaptures":4,"safeSwitchSharedFlowPassed":true,"emailWidthPassed":true,"partialPricingPassed":true,"nativeAssertions":assertionCount,"scope":"isolated synthetic AppKit fixture; not installed-app acceptance"]
        try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("native-ui-results.json"))
        window.orderOut(nil)
        print("24 current-page native layouts and 4 menu states; fixture checks passed")
    }
}
