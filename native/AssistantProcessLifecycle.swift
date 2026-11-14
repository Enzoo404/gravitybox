import Cocoa
import OSLog

private let lifecycleLogger = Logger(subsystem: "local.gravitybox.app", category: "Lifecycle")

extension Assistant {
    static func hasRunningAntigravityProcess(psOutput: String, appPaths: [String]) -> Bool {
        psOutput.split(separator: "\n").contains { line in
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            return appPaths.contains { trimmed.hasPrefix($0 + "/Contents/") }
        }
    }

    func quitAntigravityAndWait(completion: @escaping (Bool) -> Void) {
        suppressLifecycleAutoQuit(seconds: 30.0)
        let appPaths = DesktopApplicationTarget.allTargets.map(\.path)
        let queue = DispatchQueue(label: "local.gravitybox.quit-wait", qos: .userInitiated)
        let start = Date()
        var retriedTerminate = false

        func terminateRunningTargets() {
            let matchingApps = NSRunningApplication.runningApplications(withBundleIdentifier: DesktopApplicationTarget().bundleIdentifier)
                .filter { DesktopApplicationTarget.matchesAny($0) && !$0.isTerminated }
            for app in matchingApps { _ = app.terminate() }
        }

        func hasAntigravityProcesses() -> Bool {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/ps")
            task.arguments = ["-ax", "-ww", "-o", "args="]
            let pipe = Pipe()
            task.standardOutput = pipe
            task.standardError = FileHandle.nullDevice
            do {
                try task.run()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                task.waitUntilExit()
                let output = String(data: data, encoding: .utf8) ?? ""
                return Self.hasRunningAntigravityProcess(psOutput: output, appPaths: appPaths)
            } catch { return false }
        }

        func finish(_ exited: Bool) {
            DispatchQueue.main.async { [weak self] in
                self?.suppressLifecycleAutoQuit(seconds: 20.0)
                completion(exited)
            }
        }

        func pollStep() {
            let stillRegistered = DesktopApplicationTarget.isRegisteredRunning()
            let stillRunning = stillRegistered || hasAntigravityProcesses()
            if !stillRunning {
                // Allow LaunchServices / runningboardd to finish unregistering the terminated app job before relaunch.
                queue.asyncAfter(deadline: .now() + .milliseconds(300)) { finish(true) }
                return
            }
            let elapsed = Date().timeIntervalSince(start)
            if elapsed >= 20.0 {
                finish(false)
                return
            }
            if !retriedTerminate && elapsed >= 2.0 {
                retriedTerminate = true
                DispatchQueue.main.async { terminateRunningTargets() }
            }
            queue.asyncAfter(deadline: .now() + .milliseconds(150)) { pollStep() }
        }

        DispatchQueue.main.async { terminateRunningTargets() }
        queue.asyncAfter(deadline: .now() + .milliseconds(50)) { pollStep() }
    }

    func setTranslationEnabled(_ enable: Bool) {
        let previousStatus = statusValue
        translationCommandGeneration += 1
        let commandGen = translationCommandGeneration
        pendingTranslationTarget = enable
        statusValue.translationEnabled = enable
        if enable {
            if statusValue.mode == "paused" || statusValue.mode == "error" || statusValue.mode == "starting" {
                statusValue.mode = "waiting"
            }
        } else {
            statusValue.mode = "paused"
        }
        updateViews()
        let sendCommand = { [weak self] in
            guard let self, commandGen == self.translationCommandGeneration else { return }
            self.bridge.send(["command": enable ? "resume" : "pause"]) { [weak self] result in
                DispatchQueue.main.async {
                    guard let self, commandGen == self.translationCommandGeneration else { return }
                    self.pendingTranslationTarget = nil
                    switch result {
                    case .success(let value):
                        if let raw = value["status"] as? [String: Any] {
                            self.reachable = true
                            self.recoveryAttempts = 0
                            self.statusValue = self.mergeStatusSnapshot(raw, previous: self.statusValue)
                            self.updateViews()
                        }
                        self.refresh()
                    case .failure(let error):
                        self.statusValue.translationEnabled = previousStatus.translationEnabled
                        self.updateViews()
                        self.showMessage(error.localizedDescription, error: true)
                        self.refresh()
                    }
                }
            }
        }
        if !reachable && !bridge.isOwnedProcessRunning {
            recoveryAttempts = 0
            nextRecoveryAt = .distantPast
            bridge.launch { _ in sendCommand() }
        } else {
            sendCommand()
        }
    }
    func effectiveHudEnabled() -> Bool {
        if let pending = pendingHudTarget { return pending }
        if let live = statusValue.hudEnabled { return live }
        return configuration?.value.hudEnabled ?? true
    }
    func setHudEnabled(_ enable: Bool) {
        let previousStatus = statusValue
        let previousConfig = configuration.value.hudEnabled
        hudCommandGeneration += 1
        let commandGen = hudCommandGeneration
        pendingHudTarget = enable
        statusValue.hudEnabled = enable
        configuration.value.hudEnabled = enable
        try? configuration.save()
        updateViews()
        bridge.send(["command": "hud_set", "enabled": enable]) { [weak self] result in
            DispatchQueue.main.async {
                guard let self, commandGen == self.hudCommandGeneration else { return }
                self.pendingHudTarget = nil
                switch result {
                case .success(let value):
                    if let raw = value["status"] as? [String: Any] {
                        self.reachable = true
                        self.recoveryAttempts = 0
                        self.statusValue = self.mergeStatusSnapshot(raw, previous: self.statusValue)
                    }
                    self.updateViews()
                case .failure(let error):
                    self.statusValue.hudEnabled = previousStatus.hudEnabled
                    self.configuration.value.hudEnabled = previousConfig
                    try? self.configuration.save()
                    self.updateViews()
                    self.showMessage(error.localizedDescription, error: true)
                }
            }
        }
    }
    @objc func toggleTranslation() {
        setTranslationEnabled(!statusValue.enabled)
    }
    @objc func toggleHud() {
        setHudEnabled(!effectiveHudEnabled())
    }
    @objc func openAntigravity() {
        #if NATIVE_UI_TEST
        openedApplications += 1; return
        #else
        suppressLifecycleAutoQuit(seconds: 30.0)
        let launchPath = DesktopApplicationTarget.preferredLaunchPath(fallbackChannel: Self.applicationChannel)
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        config.createsNewApplicationInstance = false
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: launchPath), configuration: config) { [weak self] _, error in
            if let error {
                DispatchQueue.main.async { self?.showMessage(error.localizedDescription, error: true) }
            }
        }
        #endif
    }

    func relaunchAntigravityAfterSwitch(attemptsRemaining: Int = 3) {
        #if NATIVE_UI_TEST
        openedApplications += 1
        return
        #else
        suppressLifecycleAutoQuit(seconds: 30.0)
        let launchPath = DesktopApplicationTarget.preferredLaunchPath(fallbackChannel: Self.applicationChannel)
        if attemptsRemaining <= 1 {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                proc.arguments = ["-a", launchPath]
                proc.standardOutput = FileHandle.nullDevice
                proc.standardError = FileHandle.nullDevice
                let launchError: Error? = {
                    do {
                        try proc.run()
                        proc.waitUntilExit()
                        return proc.terminationStatus == 0 ? nil : BackendFailure(message: "open exited with \(proc.terminationStatus)")
                    } catch {
                        return error
                    }
                }()
                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 1.2) { [weak self] in
                    guard let self else { return }
                    let running = Self.isAntigravityRunning()
                    if !running {
                        DispatchQueue.main.async {
                            let detail = launchError?.localizedDescription ?? "请手动打开 Antigravity"
                            self.showMessage("账号已切换，但自动重启 Antigravity 失败：\(detail)", error: true)
                        }
                    }
                }
            }
            return
        }

        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        config.createsNewApplicationInstance = false
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: launchPath), configuration: config) { [weak self] app, error in
            guard let self else { return }
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 1.2) { [weak self] in
                guard let self else { return }
                let running = Self.isAntigravityRunning() || (app != nil && app?.isTerminated == false)
                if running {
                    DispatchQueue.main.async { self.antigravityWasRunning = true }
                    return
                }
                if attemptsRemaining > 1 {
                    DispatchQueue.main.async {
                        self.relaunchAntigravityAfterSwitch(attemptsRemaining: attemptsRemaining - 1)
                    }
                } else if let error {
                    DispatchQueue.main.async {
                        self.showMessage("账号已切换，但自动重启 Antigravity 失败：\(error.localizedDescription)", error: true)
                    }
                }
            }
        }
        #endif
    }
    static var antigravityBundlePath: String { DesktopApplicationTarget.preferredLaunchPath(fallbackChannel: applicationChannel) }
    static let lifecycleAgentLabel = "local.gravitybox.lifecycle"

    static func isAntigravityApp(_ app: NSRunningApplication) -> Bool {
        DesktopApplicationTarget.matchesAny(app)
    }

    static func isAntigravityRunning() -> Bool {
        DesktopApplicationTarget.isRegisteredRunning()
    }

    func installAntigravityLifecycleObserver() {
        #if !NATIVE_UI_TEST
        antigravityWasRunning = Self.isAntigravityRunning()
        let nc = NSWorkspace.shared.notificationCenter
        if let obs = workspaceLaunchObserver { nc.removeObserver(obs) }
        if let obs = workspaceTerminateObserver { nc.removeObserver(obs) }
        workspaceLaunchObserver = nc.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let self else { return }
            if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, Self.isAntigravityApp(app) {
                self.antigravityWasRunning = true
            } else if Self.isAntigravityRunning() {
                self.antigravityWasRunning = true
            }
        }
        workspaceTerminateObserver = nc.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let self else { return }
            let matchedApp = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication).map(Self.isAntigravityApp) ?? false
            guard matchedApp || (self.antigravityWasRunning && !Self.isAntigravityRunning()) else { return }
            self.checkAntigravityExitedAndQuitIfNeeded()
        }
        #endif
    }

    func checkAntigravityExitedAndQuitIfNeeded() {
        #if !NATIVE_UI_TEST
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self else { return }
            if Self.isAntigravityRunning() {
                self.antigravityWasRunning = true
                return
            }
            let wasRunning = self.antigravityWasRunning
            self.antigravityWasRunning = false
            guard wasRunning,
                  self.configuration?.value.syncAntigravityLifecycle == true,
                  !self.quitting,
                  Date() >= self.suppressLifecycleAutoQuitUntil else { return }
            self.stopBackendAndQuit()
        }
        #endif
    }

    func syncLifecycleAgentRegistration() {
        #if !NATIVE_UI_TEST
        antigravityWasRunning = Self.isAntigravityRunning()
        let enabled = configuration?.value.syncAntigravityLifecycle == true
        let launchAgentsDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents")
        let plistURL = launchAgentsDir.appendingPathComponent("\(Self.lifecycleAgentLabel).plist")
        let installedExec = "/Applications/GravityBox.app/Contents/MacOS/GravityBox"
        let executablePath = FileManager.default.isExecutableFile(atPath: installedExec)
            ? installedExec
            : (Bundle.main.executableURL?.path ?? installedExec)
        let uid = getuid()
        DispatchQueue.global(qos: .utility).async {
            let fm = FileManager.default
            func runLaunchctl(_ args: [String]) {
                let task = Process()
                task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
                task.arguments = args
                task.standardOutput = FileHandle.nullDevice
                task.standardError = FileHandle.nullDevice
                try? task.run()
                task.waitUntilExit()
            }
            if enabled {
                try? fm.createDirectory(at: launchAgentsDir, withIntermediateDirectories: true)
                let plist: [String: Any] = [
                    "Label": Self.lifecycleAgentLabel,
                    "ProgramArguments": [executablePath, "--lifecycle-agent"],
                    "RunAtLoad": true,
                    "KeepAlive": true,
                    "ProcessType": "Background"
                ]
                if let data = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) {
                    try? data.write(to: plistURL, options: .atomic)
                    runLaunchctl(["bootout", "gui/\(uid)", plistURL.path])
                    runLaunchctl(["bootstrap", "gui/\(uid)", plistURL.path])
                }
            } else {
                if fm.fileExists(atPath: plistURL.path) {
                    runLaunchctl(["bootout", "gui/\(uid)", plistURL.path])
                    try? fm.removeItem(at: plistURL)
                } else {
                    runLaunchctl(["bootout", "gui/\(uid)/\(Self.lifecycleAgentLabel)"])
                }
            }
        }
        #endif
    }

    func scheduleSelfHealingRestart(reason: String) {
        guard !quitting, !bridge.isRestarting, !selfHealingPending else { return }
        let now = Date()
        if now.timeIntervalSince(lastAutoRestartAt) > 60.0 {
            autoRestartAttempts = 0
        }
        guard autoRestartAttempts < 3 else {
            lifecycleLogger.error("后台子进程短时间内连续异常退出 3 次，停止自动拉起并保留报错: \(reason, privacy: .private)")
            return
        }
        autoRestartAttempts += 1
        lastAutoRestartAt = now
        selfHealingPending = true
        let attempt = autoRestartAttempts
        lifecycleLogger.warning("后台子进程异常退出 (\(reason, privacy: .private))，将在 1 秒后尝试自动自愈重启 (第 \(attempt, privacy: .public)/3 次)...")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self else { return }
            self.selfHealingPending = false
            guard !self.quitting, !self.reachable, !self.bridge.isOwnedProcessRunning else { return }
            self.bridge.launch { [weak self] result in
                guard let self else { return }
                switch result {
                case .success:
                    lifecycleLogger.info("后台子进程自愈重启成功，重新同步状态与用量。")
                    self.refresh()
                    if self.contentVisible && self.currentPage == 2 {
                        self.usagePage?.fetch()
                    }
                    if self.menuPopover?.isShown == true, let panel = self.menuPanelController {
                        let periodKey = MenuPanelController.periods[max(0, min(MenuPanelController.periods.count - 1, panel.selectedPeriod))]
                        self.fetchUsageSummary(period: periodKey, force: true, allowCached: false)
                    }
                case .failure(let error):
                    lifecycleLogger.error("后台子进程自愈重启失败: \(error.localizedDescription, privacy: .private)")
                }
            }
        }
    }
    func syncUpdatePromptControls() {
        aboutPage?.refreshUpdateState()
        if let release = updateManager.availableRelease {
            installUpdateButton?.badgeText = "v\(release.version)"
            installUpdateButton?.toolTip = nil
            installUpdateButton?.isHidden = false
        } else {
            installUpdateButton?.badgeText = ""
            installUpdateButton?.toolTip = nil
            installUpdateButton?.isHidden = true
        }
    }

    @objc func installUpdateFromSidebar() {
        guard let release = updateManager.availableRelease else {
            checkForUpdatesFromMenu()
            return
        }
        if window?.activeSheetWindow != nil {
            dismissAllSheetsAndPopovers()
        }
        showAbout()
        updateManager.installRelease(release)
    }
    func configureAutoUpdateTimer() {
        autoUpdateTimer?.invalidate()
        autoUpdateTimer = nil
        #if !NATIVE_UI_TEST
        guard configuration?.value.autoUpdateEnabled == true else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            guard let self, !self.quitting, self.configuration?.value.autoUpdateEnabled == true else { return }
            self.updateManager.checkForUpdates(silent: true)
        }
        let t = Timer(timeInterval: 6 * 3600.0, repeats: true) { [weak self] _ in
            guard let self, !self.quitting, self.configuration?.value.autoUpdateEnabled == true else { return }
            self.updateManager.checkForUpdates(silent: true)
        }
        t.tolerance = 300.0
        RunLoop.main.add(t, forMode: .common)
        autoUpdateTimer = t
        #endif
    }
    func suppressLifecycleAutoQuit(seconds: TimeInterval) {
        let candidate = Date().addingTimeInterval(seconds)
        if candidate > suppressLifecycleAutoQuitUntil {
            suppressLifecycleAutoQuitUntil = candidate
        }
    }
    @objc func checkForUpdatesFromMenu() {
        if window?.activeSheetWindow != nil {
            dismissAllSheetsAndPopovers()
        }
        showAbout()
        updateManager.checkForUpdates(silent: false)
    }
    @objc func quit() {
        performQuit()
    }

    func dismissAllSheetsAndPopovers() {
        closeMenuPopover()
        guard let window else { return }
        var safetyCounter = 0
        while let rootSheet = window.activeSheetWindow, safetyCounter < 8 {
            safetyCounter += 1
            var leaf = rootSheet
            var depth = 0
            while let child = leaf.activeSheetWindow, depth < 8 {
                leaf = child
                depth += 1
            }
            let parent = leaf.sheetParent ?? window
            parent.endSheet(leaf)
            leaf.orderOut(nil)
        }
    }

    func quitForUpdate() {
        quitting = true
        suppressLifecycleAutoQuit(seconds: 60)
        timer?.invalidate(); timer = nil
        quotaRefreshTimer?.invalidate(); quotaRefreshTimer = nil
        quotaRefreshPollTimer?.invalidate(); quotaRefreshPollTimer = nil
        autoUpdateTimer?.invalidate(); autoUpdateTimer = nil
        if configSaveWorkItem != nil {
            configSaveWorkItem?.cancel()
            configSaveWorkItem = nil
            try? configuration?.save()
        }
        dismissAllSheetsAndPopovers()
        window?.orderOut(nil)
        #if NATIVE_UI_TEST
        return
        #else
        bridge.forceStop(timeout: 2.0) { [weak self] in
            self?.directorySource?.cancel()
            self?.directorySource = nil
            NSApp.terminate(nil)
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.35) {
                Darwin._exit(0)
            }
        }
        #endif
    }

    private func performQuit() {
        guard !quitting else { return }
        stopBackendAndQuit()
    }
    private func stopBackendAndQuit() {
        guard !quitting else { return }; quitting = true
        timer?.invalidate(); quotaRefreshTimer?.invalidate(); quotaRefreshPollTimer?.invalidate(); autoUpdateTimer?.invalidate()
        if configSaveWorkItem != nil {
            configSaveWorkItem?.cancel()
            configSaveWorkItem = nil
            try? configuration?.save()
        }
        dismissAllSheetsAndPopovers()
        bridge.send(["command":"stop"]) { [weak self] result in
            guard let self else { return }
            if case .success = result { self.directorySource?.cancel(); NSApp.terminate(nil) }
            else if !self.bridge.isOwnedProcessRunning { self.directorySource?.cancel(); NSApp.terminate(nil) }
            else { self.quitting = false; self.configureRefreshTimer(); self.configureQuotaRefreshTimer(); self.configureAutoUpdateTimer(); self.showPanel(); self.showMessage("尚未确认撤销汉化，请稍后重试退出。", error:true) }
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { if quitting { return .terminateNow }; quit(); return .terminateCancel }
}

#if !NATIVE_UI_TEST
enum AntigravityLifecycleAgent {
    private static var cachedConfigMtime: Date?
    private static var cachedSyncEnabled: Bool = false

    static func isSyncEnabled() -> Bool {
        let configURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/GravityBox/config.json")
        let mtime = (try? FileManager.default.attributesOfItem(atPath: configURL.path))?[.modificationDate] as? Date
        if let mtime, mtime == cachedConfigMtime {
            return cachedSyncEnabled
        }
        guard let data = try? Data(contentsOf: configURL),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            cachedConfigMtime = nil
            cachedSyncEnabled = false
            return false
        }
        cachedConfigMtime = mtime
        Assistant.applicationChannel = "stable"
        cachedSyncEnabled = (raw["syncAntigravityLifecycle"] as? Bool == true)
        return cachedSyncEnabled
    }

    static func isMainGravityBoxRunning() -> Bool {
        Assistant.findExistingMainPeer(excludingPid: getpid()) != nil
    }

    static func launchGravityBoxIfNeeded() {
        guard isSyncEnabled(), !isMainGravityBoxRunning() else { return }
        let installedURL = URL(fileURLWithPath: "/Applications/GravityBox.app")
        let bundleURL = FileManager.default.fileExists(atPath: installedURL.path) ? installedURL : Bundle.main.bundleURL
        let config = NSWorkspace.OpenConfiguration()
        config.activates = false
        config.createsNewApplicationInstance = false
        config.arguments = ["--launched-by-antigravity"]
        NSWorkspace.shared.openApplication(at: bundleURL, configuration: config, completionHandler: nil)
    }

    static func run() -> Never {
        if !isSyncEnabled() { exit(0) }
        var wasRunning = Assistant.isAntigravityRunning()
        let nc = NSWorkspace.shared.notificationCenter
        nc.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { note in
            if !isSyncEnabled() { exit(0) }
            if let launched = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
               Assistant.isAntigravityApp(launched) {
                wasRunning = true
                launchGravityBoxIfNeeded()
            }
        }
        nc.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { _ in
            if !Assistant.isAntigravityRunning() {
                wasRunning = false
            }
        }
        let timer = Timer(timeInterval: 6.0, repeats: true) { _ in
            if !isSyncEnabled() { exit(0) }
            let nowRunning = Assistant.isAntigravityRunning()
            if nowRunning && !wasRunning {
                wasRunning = true
                launchGravityBoxIfNeeded()
            } else if !nowRunning {
                wasRunning = false
            }
        }
        timer.tolerance = 1.5
        RunLoop.main.add(timer, forMode: .common)
        RunLoop.main.run()
        exit(0)
    }
}
#endif
