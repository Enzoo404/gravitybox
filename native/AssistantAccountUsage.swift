import Cocoa

extension Assistant {
    func fetchUsageSummary(period: String, force: Bool = false, allowCached: Bool = true, completion: ((Result<[String: Any], Error>) -> Void)? = nil) {
        let cacheKey = period
        if !force && allowCached,
           let cached = cachedUsageReportsByPeriod[cacheKey],
           let lastAt = usageLastFetchTimeByPeriod[cacheKey],
           Date().timeIntervalSince(lastAt) < 15.0,
           ((cached["summary"] as? [String: Any])?["failedDatabasesCount"] as? Int ?? 0) == 0 {
            completion?(.success(cached))
            return
        }
        if force {
            usageAutoHealAttemptsByPeriod[cacheKey] = 0
        }
        if let completion {
            usageWaitersByPeriod[cacheKey, default: []].append(completion)
        }
        if usageInFlightByPeriod[cacheKey] == true {
            if force {
                usagePendingForceByPeriod.insert(cacheKey)
                usageManualRefreshPeriods.insert(cacheKey)
                menuPanelController?.syncHeaderRefreshState()
            }
            return
        }
        usageInFlightByPeriod[cacheKey] = true
        let generation = (usageGenerationByPeriod[cacheKey] ?? 0) + 1
        usageGenerationByPeriod[cacheKey] = generation
        if force {
            usageManualRefreshPeriods.insert(cacheKey)
            menuPanelController?.syncHeaderRefreshState()
        }
        var payload: [String: Any] = ["command": "usage_summary", "period": period]
        if force { payload["force"] = true }
        bridge.send(payload) { [weak self] response in
            guard let self else { return }
            if self.usagePendingForceByPeriod.remove(cacheKey) != nil {
                self.usageInFlightByPeriod[cacheKey] = false
                self.fetchUsageSummary(period: period, force: true, allowCached: false)
                return
            }
            self.usageInFlightByPeriod[cacheKey] = false
            self.usageManualRefreshPeriods.remove(cacheKey)
            guard generation >= (self.usageGenerationByPeriod[cacheKey] ?? 0) else { return }
            self.usageLastFetchTimeByPeriod[cacheKey] = Date()
            let waiters = self.usageWaitersByPeriod.removeValue(forKey: cacheKey) ?? []
            switch response {
            case .failure(let error):
                self.usageFetchErrorsByPeriod[cacheKey] = error.localizedDescription
            case .success(let value):
                self.usageFetchErrorsByPeriod[cacheKey] = nil
                self.cachedUsageReportsByPeriod[cacheKey] = value
                let failedCount = (value["summary"] as? [String: Any])?["failedDatabasesCount"] as? Int ?? 0
                if failedCount == 0 {
                    self.usageAutoHealAttemptsByPeriod[cacheKey] = 0
                } else {
                    #if !NATIVE_UI_TEST
                    let attempts = self.usageAutoHealAttemptsByPeriod[cacheKey, default: 0]
                    if attempts < 2 && !self.usageAutoHealPendingPeriods.contains(cacheKey) && self.reachable && !self.quitting {
                        self.usageAutoHealAttemptsByPeriod[cacheKey] = attempts + 1
                        self.usageAutoHealPendingPeriods.insert(cacheKey)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
                            guard let self else { return }
                            self.usageAutoHealPendingPeriods.remove(cacheKey)
                            guard self.reachable && !self.quitting else { return }
                            self.fetchUsageSummary(period: period, force: false, allowCached: false)
                        }
                    }
                    #endif
                }
                if force && self.contentVisible && self.currentPage == 2 {
                    self.usagePage?.update(force: false)
                }
            }
            self.menuPanelController?.onUsageReportUpdated(period: period, result: response)
            for waiter in waiters { waiter(response) }
        }
    }

    func refreshSingleAccountQuota(id: String, completion: ((Result<[String: Any], Error>) -> Void)? = nil) {
        guard !id.isEmpty else {
            completion?(.failure(BackendFailure(message: "账号标识无效")))
            return
        }
        guard reachable else {
            completion?(.failure(BackendFailure(message: "本机服务尚未就绪")))
            return
        }
        guard !refreshingAccountIds.contains(id) else {
            completion?(.failure(BackendFailure(message: "该账号配额正在刷新中")))
            return
        }
        singleAccountRefreshErrors[id] = nil
        refreshingAccountIds.insert(id)
        updateQuotaRefreshControls()
        menuPanelController?.syncFromAssistant()
        bridge.send(["command": "quota_refresh", "id": id]) { [weak self] response in
            guard let self else { return }
            self.refreshingAccountIds.remove(id)
            switch response {
            case .failure(let error):
                self.singleAccountRefreshErrors[id] = error.localizedDescription
            case .success:
                self.singleAccountRefreshErrors[id] = nil
                if let globalErr = self.quotaRefreshError, !InterfaceText.isMultiAccountSummary(globalErr) {
                    self.quotaRefreshError = nil
                }
                self.fetchAccountList(notifyPage: true)
                self.overview?.update(force: true)
            }
            self.updateQuotaRefreshControls()
            self.menuPanelController?.syncFromAssistant()
            completion?(response)
        }
    }

    func buildAccountSwitchMenu() -> NSMenu {
        let switchSubmenu = NSMenu(title: "切换账号")
        switchSubmenu.showsStateColumn = true
        if cachedAccounts.isEmpty {
            let emptyItem = NSMenuItem(title: "暂无可用账号快照", action: nil, keyEquivalent: "")
            emptyItem.isEnabled = false
            switchSubmenu.addItem(emptyItem)
        } else {
            let ordered = cachedAccounts.enumerated().sorted { lhs, rhs in
                let l = lhs.element["id"] as? String == activeAccountId
                let r = rhs.element["id"] as? String == activeAccountId
                return l == r ? lhs.offset < rhs.offset : l
            }.map(\.element)
            for acc in ordered {
                let id = acc["id"] as? String ?? ""
                let accEmail = acc["email"] as? String ?? "未知账号"
                let label = acc["name"] as? String ?? ""
                let displayName = label.isEmpty ? accEmail : "\(label) · \(accEmail)"
                let accTier = AccountIdentity.normalizeTier(acc["subscription_tier"] as? String)
                let title = [displayName, accTier, QuotaPresentation.menuQuotaText(acc)].filter { !$0.isEmpty }.joined(separator: " · ")
                let accItem = NSMenuItem(title: title, action: #selector(switchAccountFromMenu(_:)), keyEquivalent: "")
                accItem.target = self
                accItem.representedObject = id
                accItem.isEnabled = acc["disabled"] as? Bool != true
                if id == activeAccountId || (activeAccountId.isEmpty && accEmail == statusValue.activeAccountEmail) { accItem.state = .on }
                switchSubmenu.addItem(accItem)
            }
        }
        switchSubmenu.addItem(.separator())
        let manageItem = NSMenuItem(title: "管理账号…", action: #selector(showAccountsFromMenuCard), keyEquivalent: "")
        manageItem.target = self
        switchSubmenu.addItem(manageItem)
        return switchSubmenu
    }
    func popUpAccountSwitchMenu(from anchorView: NSView) {
        let submenu = buildAccountSwitchMenu()
        Design.popUpMenu(submenu, below: anchorView)
    }
    @objc func showAccountsFromMenuCard() {
        closeMenuPopover()
        showAccounts()
    }
    func switchAccountByIdFromMenu(_ id: String) {
        guard !id.isEmpty, id != activeAccountId else { return }
        closeMenuPopover()
        let targetAccount = cachedAccounts.first(where: { ($0["id"] as? String) == id })
        let email = targetAccount?["email"] as? String ?? ""
        let name = targetAccount?["name"] as? String ?? ""
        requestInteractiveAccountSwitch(id: id, email: email, name: name)
    }

    func invalidateUsageReportCache() {
        cachedUsageReportsByPeriod.removeAll()
        usageLastFetchTimeByPeriod.removeAll()
        usageFetchErrorsByPeriod.removeAll()
        overview?.metricsKey = ""
        usagePage?.metricsKey = ""
        if contentVisible && currentPage == 2 {
            usagePage?.fetch()
        }
        if menuTracking || menuPopover?.isShown == true {
            menuPanelController?.syncFromAssistant()
        }
    }

    @objc func switchAccountFromMenu(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        switchAccountByIdFromMenu(id)
    }
    func requestInteractiveAccountSwitch(id: String, email: String, name: String, completion: (() -> Void)? = nil) {
        guard !id.isEmpty, !accountSwitchInFlight, reachable else { return }
        accountSwitchInFlight = true
        bridge.send(["command": "account_switch_preflight", "id": id]) { [weak self] result in
            guard let self else { return }
            guard case .success(let payload) = result else {
                self.accountSwitchInFlight = false
                if case .failure(let error) = result {
                    self.showMessage("无法确认切换前置条件：" + error.localizedDescription, error: true)
                }
                return
            }
            let appRunning = payload["appRunning"] as? Bool == true
            let insidersRunning = payload["insidersRunning"] as? Bool == true
            let stableRunning = (payload["stableRunning"] as? Bool) ?? (appRunning && !insidersRunning)
            let shouldQuitAndRelaunch = !insidersRunning && (stableRunning || Self.isAntigravityRunning())
            let hasRunningTask = (payload["hasRunningTask"] as? Bool == true) || (payload["safe"] as? Bool == false)
            let display: String
            if !name.isEmpty && name.caseInsensitiveCompare(email) != .orderedSame && !email.isEmpty {
                display = "\(name)（\(email)）"
            } else {
                display = email.isEmpty ? (name.isEmpty ? "目标账号" : name) : email
            }
            if insidersRunning {
                self.accountSwitchInFlight = false
                self.showMessage("检测到 Antigravity Insiders 正在运行，请先保存工作并手动退出后再切换账号", error: true)
                return
            }
            let performSwitch = { [weak self] in
                guard let self else { return }
                self.suppressLifecycleAutoQuit(seconds: 75.0)
                self.bridge.send(["command": "account_switch", "id": id, "target": "all", "autoRefreshToken": true]) { [weak self] response in
                    guard let self else { return }; self.accountSwitchInFlight = false
                    switch response {
                    case .failure(let error):
                        if shouldQuitAndRelaunch { self.relaunchAntigravityAfterSwitch() }
                        self.showMessage("切换账号失败：" + error.localizedDescription, error: true)
                    case .success(let value):
                        self.showMessage(value["message"] as? String ?? "已切换至账号：\(email)")
                        if shouldQuitAndRelaunch { self.relaunchAntigravityAfterSwitch() }
                        self.invalidateUsageReportCache()
                        self.refresh(); self.accountsPage?.fetch(); self.overview?.fetch(); completion?()
                    }
                }
            }
            let execute: (Bool) -> Void = { [weak self] confirmed in
                guard let self else { return }
                guard confirmed else { self.accountSwitchInFlight = false; return }
                #if NATIVE_UI_TEST
                if self.confirmSwitchForTesting != nil {
                    self.bridge.send(["command": "account_switch", "id": id, "target": "all", "autoRefreshToken": true]) { [weak self] response in
                        guard let self else { return }; self.accountSwitchInFlight = false
                        if case .success(let value) = response {
                            self.showMessage(value["message"] as? String ?? "已切换至账号：\(email)")
                            if shouldQuitAndRelaunch { self.relaunchAntigravityAfterSwitch() }
                            self.invalidateUsageReportCache()
                            self.refresh(); self.accountsPage?.fetch(); self.overview?.fetch(); completion?()
                        }
                    }
                    return
                }
                #endif
                if shouldQuitAndRelaunch {
                    self.quitAntigravityAndWait { [weak self] exited in
                        guard let self else { return }
                        guard exited else {
                            self.accountSwitchInFlight = false
                            self.showMessage("请先在 Antigravity 中保存工作并退出应用，再切换账号", error: true)
                            return
                        }
                        performSwitch()
                    }
                } else {
                    performSwitch()
                }
            }
            if hasRunningTask {
                #if NATIVE_UI_TEST
                if self.confirmSwitchForTesting != nil {
                    self.accountSwitchInFlight = false
                    return
                }
                #endif
                let busyAlert = NSAlert()
                busyAlert.alertStyle = .warning
                busyAlert.messageText = "切换至 \(display)？"
                busyAlert.informativeText = "检测到 Antigravity 有正在运行的任务，现在切换会中断当前任务并重启应用。"
                busyAlert.addButton(withTitle: "仍要切换")
                busyAlert.addButton(withTitle: "取消")
                self.presentSheetAlert(busyAlert) { execute($0 == .alertFirstButtonReturn) }
                return
            }
            #if NATIVE_UI_TEST
            if let confirm = self.confirmSwitchForTesting { confirm(display, execute); return }
            #endif
            let alert = NSAlert()
            alert.alertStyle = .informational
            alert.messageText = "切换至 \(display)？"
            alert.informativeText = appRunning
                ? "当前无正在运行的任务，确认后将自动重启 Antigravity 生效。"
                : "Antigravity 当前未运行，确认后将直接切换账号。"
            alert.addButton(withTitle: "确认切换")
            alert.addButton(withTitle: "取消")
            self.presentSheetAlert(alert) { execute($0 == .alertFirstButtonReturn) }
        }
    }
    @objc func refreshAccountQuotas() {
        guard !quotaRefreshing, pendingAccountTaskId == nil, reachable else { return }
        quotaRefreshing = true; quotaRefreshStartedAt = Date(); quotaRefreshError = nil; updateQuotaRefreshControls()
        let poll = Timer(timeInterval: 0.75, repeats: true) { [weak self] _ in self?.refresh(taskPollOnly: true) }
        quotaRefreshPollTimer?.invalidate(); quotaRefreshPollTimer = poll
        RunLoop.main.add(poll, forMode: .common); RunLoop.main.add(poll, forMode: .eventTracking)
        bridge.send(["command": "quota_refresh_start"]) { [weak self] response in
            guard let self else { return }
            switch response {
            case .failure(let error): self.finishQuotaRefresh(error: error.localizedDescription)
            case .success(let value):
                guard let id = value["taskId"] as? String, !id.isEmpty else { self.finishQuotaRefresh(error: "未取得刷新任务，请重试"); return }
                self.pendingAccountTaskId = id; self.refresh(taskPollOnly: true)
            }
        }
    }
    func finishQuotaRefresh(error: String?) {
        quotaRefreshing = false; quotaRefreshStartedAt = nil; pendingAccountTaskId = nil; quotaRefreshError = error; quotaRefreshPollTimer?.invalidate(); quotaRefreshPollTimer = nil
        updateQuotaRefreshControls(); fetchAccountList(notifyPage: true); overview?.update(force: true)
    }
    func updateQuotaRefreshControls() {
        let available = reachable && (pendingAccountTaskId == nil || quotaRefreshing)
        func apply(_ view: NSView) {
            if let control = view as? QuotaRefreshButton {
                let cid = control.identifier?.rawValue ?? ""
                control.applyGlobalRefreshState(globalBusy: quotaRefreshing, available: available, error: quotaRefreshError, cardBusy: refreshingAccountIds.contains(cid))
            }
            for child in view.subviews { apply(child) }
        }
        apply(pageHost)
        updateStatusItemState()
        if menuTracking || menuPopover?.isShown == true {
            menuPanelController?.syncFromAssistant()
        }
    }
    func fetchAccountList(notifyPage: Bool = true, completion: ((Result<[String: Any], Error>) -> Void)? = nil) {
        if let completion { accountListWaiters.append(completion) }
        if notifyPage { accountListPendingNotifyPage = true }
        guard !accountListInFlight else { return }
        accountListInFlight = true
        accountListGeneration += 1
        let generation = accountListGeneration
        lastAccountListFetchAt = Date()
        bridge.send(["command": "account_list"]) { [weak self] res in
            guard let self else { return }
            self.accountListInFlight = false
            let waiters = self.accountListWaiters
            let shouldNotifyPage = self.accountListPendingNotifyPage
            self.accountListWaiters.removeAll()
            self.accountListPendingNotifyPage = false
            if case .success(let val) = res, generation >= self.accountListGeneration, let list = val["accounts"] as? [[String: Any]] {
                self.lastFetchedAccountsRevision = self.statusValue.accountsRevision
                self.lastFetchedLiveEmail = self.statusValue.liveAccountEmail
                var resolvedActiveId = val["activeId"] as? String ?? (val["currentAccountId"] as? String ?? "")
                if !self.statusValue.liveAccountEmail.isEmpty,
                   let live = list.first(where: { ($0["email"] as? String ?? "").caseInsensitiveCompare(self.statusValue.liveAccountEmail) == .orderedSame }),
                   let id = live["id"] as? String {
                    resolvedActiveId = id
                }
                self.activeAccountId = resolvedActiveId
                self.cachedAccounts = list.enumerated().sorted { lhs, rhs in
                    let l = lhs.element["id"] as? String == resolvedActiveId
                    let r = rhs.element["id"] as? String == resolvedActiveId
                    return l == r ? lhs.offset < rhs.offset : l
                }.map(\.element)
                if let globalErr = self.quotaRefreshError, InterfaceText.isMultiAccountSummary(globalErr) {
                    let anyAccountHasIssue = self.cachedAccounts.contains { acc in
                        if acc["disabled"] as? Bool == true { return false }
                        let err = (acc["quota_refresh_error"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        if !err.isEmpty && !err.contains("双周期") { return true }
                        if let quota = acc["quota"] as? [String: Any],
                           let stale = quota["stale_groups"] as? [[String: Any]], !stale.isEmpty {
                            return true
                        }
                        return false
                    }
                    if !anyAccountHasIssue {
                        self.quotaRefreshError = nil
                    }
                }
                self.updateQuotaRefreshControls()
                if shouldNotifyPage { self.accountsPage?.fetch(val) }
            }
            for waiter in waiters { waiter(res) }
        }
    }
    func failPendingQuotaRefresh(_ message: String) {
        guard quotaRefreshing || pendingAccountTaskId != nil else { return }
        quotaRefreshing = false; pendingAccountTaskId = nil; quotaRefreshStartedAt = nil
        quotaRefreshError = message; quotaRefreshPollTimer?.invalidate(); quotaRefreshPollTimer = nil
    }
}
