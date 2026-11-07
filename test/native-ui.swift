import Cocoa

@main struct NativeUIFixture {
    static func check(_ condition: Bool, _ message: String) {
        if !condition { FileHandle.standardError.write(Data((message+"\n").utf8)); exit(1) }
    }
    static func pump() {
        let end = Date().addingTimeInterval(0.15)
        while Date() < end { RunLoop.main.run(until:Date().addingTimeInterval(0.01)) }
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
        var activeId = "a", switches = 0, preflightState = "safe"
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
                return [
                    "ok": true,
                    "token": "fixture-token",
                    "entries": [
                        ["name": "Cache", "title": "网络与静态资源缓存", "subtitle": "界面静态资源、前端脚本与临时网络响应数据", "icon": "internaldrive", "category": "safe", "defaultSelected": true, "bytes": 864_026_624, "fileCount": 2640, "exists": true, "clearable": true],
                        ["name": "Code Cache", "title": "V8 字节码编译缓存", "subtitle": "JavaScript 与 WebAssembly 预编译加速字节码", "icon": "cpu", "category": "safe", "defaultSelected": true, "bytes": 412_090_368, "fileCount": 1120, "exists": true, "clearable": true],
                        ["name": "GPUCache", "title": "图形与着色器管线缓存", "subtitle": "Metal / WebGL 渲染管线与着色器编译产物", "icon": "sparkles.rectangle.stack", "category": "safe", "defaultSelected": true, "bytes": 184_549_376, "fileCount": 318, "exists": true, "clearable": true],
                        ["name": "CachedData", "title": "工作区运行编译缓存", "subtitle": "主进程与渲染进程预编译脚本缓存", "icon": "memorychip", "category": "safe", "defaultSelected": true, "bytes": 38_797_312, "fileCount": 134, "exists": true, "clearable": true],
                        ["name": "Cookies", "title": "网络会话与站点授权凭据", "subtitle": "站点级 Cookie 与网络登录会话，清理后部分服务需重新授权", "icon": "key.horizontal", "category": "stateful", "defaultSelected": false, "impactWarning": "清理后需重新登录授权", "bytes": 18_874_368, "fileCount": 12, "exists": true, "clearable": true]
                    ],
                    "safeBytes": 1_499_463_680,
                    "statefulBytes": 18_874_368,
                    "totalBytes": 1_518_338_048,
                    "totalFiles": 4224,
                    "protectedEntries": [
                        ["id": "workspace", "title": "工作区与核心账号凭据", "subtitle": "User/globalStorage（OAuth 令牌库 state.vscdb）与工作区配置", "icon": "folder.badge.gearshape", "bytes": 68_157_440, "fileCount": 312, "exists": true],
                        ["id": "conversations", "title": "Agent 历史对话与上下文库", "subtitle": "本地会话历史记录与模型调用统计数据库", "icon": "bubble.left.and.bubble.right", "bytes": 2_841_640_960, "fileCount": 343, "exists": true]
                    ],
                    "protectedBytes": 2_909_798_400,
                    "snapshots": [
                        ["id": "GravityBox-缓存-1729900800000", "timestamp": 1729900800, "totalBytes": 312_475_648, "fileCount": 3180, "items": ["Cache", "Code Cache", "GPUCache"], "movedCount": 3, "restorable": true, "interrupted": false]
                    ],
                    "running": true,
                    "scannedAt": Int(Date().timeIntervalSince1970)
                ]
            case "account_switch_preflight": return ["ok":preflightState != "error","safe":preflightState == "safe","appRunning":preflightState == "busy","hasRunningTask":preflightState == "busy","error":"隔离预检失败"]
            case "account_switch": switches += 1; activeId = payload["id"] as? String ?? activeId; return ["ok":true,"message":"隔离事务完成"]
            case "account_recovery_info": return ["ok":true,"available":false]
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
                for page in 0..<4 {
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
                        for targetName in ["gemini-3.8-flash-n", "gemini-3.8-flash-exp-a", "Claude Opus 5.5 Medium"] {
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
            check(policy.modelPopup.itemTitles == ["Gemini","Claude/GPT","Gemini 4 Argon"], "Model popup must expose exactly the requested three choices")
            for popup in [policy.strategyPopup, policy.modelPopup] {
                check(popup.focusRingType == .none && popup.cell?.focusRingType == NSFocusRingType.none, "Installed popup cell must not restore the square focus bezel")
            }
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
            func quotaBars(_ view:NSView)->[QuotaBarView] { (view as? QuotaBarView).map{[$0]} ?? view.subviews.flatMap{quotaBars($0)} }
            let modelBars = quotaBars(window.contentView!).filter{$0.titleLabel.stringValue.contains("模型配额")}
            check(modelBars.count == 2 && modelBars.allSatisfy{$0.percentageKnown && $0.percentage == 100}, "FREE model quota must render known on both account rows")
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
            check(!(tile is NSControl), "\(tile.metricKey) tile must not inherit from NSControl")
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
            check(!(modelRow is NSControl), "MenuModelUsageRow must be a read-only NSView, not NSControl")
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
        check(menuPanel.selectedTab == 1 && menuPanel.headerRefreshButton.title == "刷新" && (menuPanel.headerRefreshButton.toolTip ?? "").contains("当前"), "Quota tab must keep fixed button title and scope tooltip to current account")
        check(menuPanel.quotaAccountNameLabel.stringValue == "Alex" && menuPanel.quotaGemini5h.valueLabel.stringValue == "91%", "Quota tab must display active account identity and contract quota")
        check(menuPanel.quotaFooterLabel.stringValue.hasPrefix("更新于 ") && !menuPanel.quotaFooterLabel.stringValue.contains("采样于"), "Quota tab footer must use concise 更新于 timestamp")
        check(menuPanel.quotaFooterLabel.superview === menuPanel.quotaRoot, "Quota tab footer must reside directly in quotaRoot")
        menuPanel.selectTab(2, persist: false); pump()
        check(menuPanel.selectedTab == 2 && menuPanel.headerRefreshButton.title == "刷新" && (menuPanel.headerRefreshButton.toolTip ?? "").contains("所有"), "Accounts tab must keep fixed button title and scope tooltip to all accounts")
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
        if let firstBox = ov.bentoRightStack.arrangedSubviews.first as? NSBox {
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
        pump(); check(switches == 1,"Confirmed fixture switch must run exactly once")
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
        check(stableSettings.checkUpdateBtn.title == "检查更新", "About row must replace 关于 GravityBox with 检查更新 button")
        check(!allTextValues(stableSettings.view).contains("关于 GravityBox"), "Settings UI must not contain 关于 GravityBox button")
        check(stableSettings.aboutSubtitleLabel.isHidden && stableSettings.aboutSubtitleLabel.stringValue.isEmpty, "About row subtitle must stay hidden when no update is available")
        assistant.updateManager.simulateRelease(AppReleaseInfo(
            version: "1.1.0",
            tagName: "v1.1.0",
            title: "GravityBox v1.1.0",
            changelog: "• 新增 GitHub Release 检查更新与后台预下载\n• 毛玻璃更新 Sheet 展示完整 Changelog",
            publishedDate: "2026-11-04",
            htmlURL: URL(string: "https://github.com/Enzoo404/gravitybox/releases/tag/v1.1.0")!,
            dmgURL: nil,
            sha256URL: nil
        ))
        stableSettings.refreshUpdateRowState()
        check(!stableSettings.aboutSubtitleLabel.isHidden && stableSettings.aboutSubtitleLabel.stringValue == "发现新版本 v1.1.0，可立即升级", "About row must display exact update subtitle when update is available")
        stableSettings.showUpdateSheet(); pump()
        if let updateSheet = stableSettings.updateSheet {
            check(updateSheet.primaryBtn.title == "立即更新", "Update sheet must display 立即更新 button when release is available")
            check(updateSheet.changelogTextView.string.contains("新增 GitHub Release 检查更新"), "Update sheet must display GitHub Release changelog")
            check(updateSheet.autoUpdateSwitch.state == .off, "Auto update switch in sheet footer must default to off")
            updateSheet.autoUpdateSwitch.state = .off
            updateSheet.toggleAutoUpdate()
            check(assistant.configuration.value.autoUpdateEnabled == false, "Toggling autoUpdateSwitch must persist autoUpdateEnabled = false")
            updateSheet.autoUpdateSwitch.state = .on
            updateSheet.toggleAutoUpdate()
            check(assistant.configuration.value.autoUpdateEnabled == true, "Toggling autoUpdateSwitch back must persist autoUpdateEnabled = true")
            updateSheet.closeSheet(); pump()
        }
        assistant.updateManager.simulateRelease(nil)
        stableSettings.refreshUpdateRowState()
        check(stableSettings.aboutSubtitleLabel.isHidden, "Clearing available release must hide about row subtitle again")
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

        DesktopApplicationTarget.installedChannelsOverride = ["stable"]
        check(DesktopApplicationTarget.bothInstalled == false, "Single-app mode must report bothInstalled == false")
        check(DesktopApplicationTarget.effectiveChannel(configured: "insiders") == "stable", "Single-app mode must auto-fallback to sole installed app")
        DesktopApplicationTarget.installedChannelsOverride = ["insiders"]
        check(DesktopApplicationTarget.installedChannels().isEmpty, "Insiders alone is not a supported installation")
        check(DesktopApplicationTarget.preferredLaunchPath() == "/Applications/Antigravity.app", "Launch must not fall back to Insiders")
        DesktopApplicationTarget.installedChannelsOverride = nil

        Assistant.applicationChannel = "stable"
        assistant.configuration.value.applicationChannel = "stable"
        let result:[String:Any] = ["stableOnlySelectionPassed":true,"nativeLayouts":captures.count,"captures":captures,"menuCaptures":4,"safeSwitchSharedFlowPassed":true,"emailWidthPassed":true,"partialPricingPassed":true,"scope":"isolated synthetic AppKit fixture; not installed-app acceptance"]
        try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("native-ui-results.json"))
        window.orderOut(nil)
        print("24 current-page native layouts and 4 menu states; fixture checks passed")
    }
}
