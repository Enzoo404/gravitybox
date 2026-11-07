import Cocoa
import Darwin

struct BackendFailure: LocalizedError {
    let message: String
    /// Connection-level failures happen while the helper is still booting; they are worth a short retry.
    let retryable: Bool
    init(message: String, retryable: Bool = false) { self.message = message; self.retryable = retryable }
    var errorDescription: String? { message }
}

final class BackendBridge {
    let state: URL
    let resources: URL
    private var child: Process?
    private var generation = 0
    private(set) var isRestarting = false
    private let queue = DispatchQueue(label: "local.gravitybox.bridge", qos: .userInitiated)
    private let controlQueue = DispatchQueue(label:"local.gravitybox.control",qos:.userInitiated,attributes:.concurrent)
    private static let maxReplyBytes = 4_000_000
    #if NATIVE_UI_TEST
    var fixtureReply: (([String:Any]) -> [String:Any])?
    #endif
    var onExit: ((String) -> Void)?
    var ownedPID: Int32? { child?.processIdentifier }
    var isOwnedProcessRunning: Bool { child?.isRunning == true }

    init(resources: URL, state: URL) { self.resources = resources; self.state = state }

    /// Boots the bundled runtime on a background queue so the main thread never blocks on `Process`.
    /// `completion` always runs on the main queue.
    func launch(completion: ((Result<Void, Error>) -> Void)? = nil) {
        #if NATIVE_UI_TEST
        completion?(.success(()))
        #else
        queue.async { [self] in
            let result = Result { try startChildProcess() }
            DispatchQueue.main.async { completion?(result) }
        }
        #endif
    }

    /// Restore the old channel's injected UI before opening the new channel's helper.
    func restart(completion: @escaping (Result<Void, Error>) -> Void) {
        guard !isRestarting else { return }
        generation += 1
        isRestarting = true
        queue.async { [self] in
            let result = Result {
                if let child, child.isRunning {
                    _ = try request(["command": "stop"])
                    let deadline = Date().addingTimeInterval(10)
                    while child.isRunning && Date() < deadline { usleep(50_000) }
                    guard !child.isRunning else { throw BackendFailure(message: "旧连接尚未退出，未连接另一个版本。") }
                }
                try startChildProcess()
            }
            DispatchQueue.main.async { self.isRestarting = false; completion(result) }
        }
    }

    private func startChildProcess() throws {
        if child?.isRunning == true { return }
        let node = resources.appendingPathComponent("runtime/node")
        guard FileManager.default.isExecutableFile(atPath: node.path) else {
            throw BackendFailure(message: "运行环境缺失。请重新安装完整的 GravityBox 安装包。")
        }
        let fm = FileManager.default
        try fm.createDirectory(at: state, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let logDir = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/GravityBox")
        try fm.createDirectory(at: logDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let log = logDir.appendingPathComponent("backend.log")
        if let size = try? fm.attributesOfItem(atPath: log.path)[.size] as? NSNumber, size.intValue > 1_048_576 {
            let archiveDir = logDir.appendingPathComponent("归档", isDirectory:true)
            try fm.createDirectory(at:archiveDir,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            let archive = archiveDir.appendingPathComponent("backend-\(Int(Date().timeIntervalSince1970))-\(UUID().uuidString.prefix(8)).log")
            try fm.moveItem(at: log, to: archive)
        }
        if !fm.fileExists(atPath: log.path) { fm.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        let handle = try FileHandle(forWritingTo: log)
        do { try handle.seekToEnd() } catch { try? handle.close(); throw error }
        let process = Process(); process.executableURL = node
        process.arguments = ["--max-old-space-size=128", resources.appendingPathComponent("core/dist/main.js").path, "--state-dir", state.path]
        process.standardOutput = FileHandle.nullDevice; process.standardError = handle
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self, !self.isRestarting, self.child?.processIdentifier == process.processIdentifier else { return }
                self.onExit?("本机服务已停止 · \(process.terminationStatus)")
            }
        }
        do { try process.run() } catch { try? handle.close(); throw error }
        child = process
        try handle.close()
    }

    func send(_ payload: [String: Any], completion: @escaping (Result<[String: Any], Error>) -> Void) {
        let requestGeneration = generation
        guard !isRestarting else { completion(.failure(BackendFailure(message: "正在切换目标应用，请稍候。"))); return }
        #if NATIVE_UI_TEST
        if let fixtureReply { let reply = fixtureReply(payload); DispatchQueue.main.async { if reply["ok"] as? Bool == false { completion(.failure(BackendFailure(message: reply["error"] as? String ?? "测试失败"))) } else { completion(.success(reply)) } }; return }
        #endif
        let command = payload["command"] as? String ?? ""
        let readOnlyCommands: Set<String> = [
            "status", "task_list", "task_cancel", "usage_cancel", "ping",
            "dashboard_summary", "account_list", "account_get", "account_switch_preflight",
            "maintenance_scan", "maintenance_history", "usage_summary", "usage_events",
            "usage_snapshot_release", "auto_switch_get", "auto_switch_best",
            "account_recovery_info", "api_pricing_get"
        ]
        let channel = readOnlyCommands.contains(command) ? controlQueue : queue
        channel.async { [self] in
            let result = Result { try request(payload) }
            DispatchQueue.main.async { guard requestGeneration == self.generation else { return }; completion(result) }
        }
    }

    func request(_ payload: [String: Any]) throws -> [String: Any] {
        var last: BackendFailure?
        let isBooting = child?.isRunning == true
        let maxAttempts = isBooting ? 8 : 3
        let delays: [useconds_t] = [35_000, 50_000, 75_000, 100_000, 140_000, 180_000, 220_000]
        for attempt in 0..<maxAttempts {
            do { return try performRequest(payload) }
            catch let failure as BackendFailure {
                last = failure
                guard failure.retryable, attempt < maxAttempts - 1 else { throw failure }
                usleep(delays[min(attempt, delays.count - 1)])
            }
        }
        throw last ?? BackendFailure(message: "后台尚未连接。请稍候，或点击重新连接。")
    }

    private func performRequest(_ payload: [String: Any]) throws -> [String: Any] {
        let command = payload["command"] as? String ?? ""
        // Long helpers (switch/import/maintenance) may legitimately take a while; status stays snappy.
        let budget: TimeInterval = command == "stop" ? 30 : (command == "status" || command == "task_list" ? 8 : 45)
        let deadline = Date().addingTimeInterval(budget)
        let fd = try openSocket(deadline: deadline)
        defer { Darwin.close(fd) }
        var data = try JSONSerialization.data(withJSONObject: payload); data.append(0x0A)
        try writeAll(data, fd: fd, deadline: deadline)
        let value = try readReply(fd: fd, deadline: deadline)
        if value["ok"] as? Bool == false {
            throw BackendFailure(message: value["error"] as? String ?? value["message"] as? String ?? "操作未完成")
        }
        return value
    }

    private func openSocket(deadline: Date) throws -> Int32 {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw BackendFailure(message: "无法建立本机连接", retryable: true) }
        // Writing to a socket whose peer already closed raises SIGPIPE on macOS, which kills the app.
        var one: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            Darwin.close(fd); throw BackendFailure(message: "无法建立本机连接", retryable: true)
        }
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
        let path = state.appendingPathComponent("control.sock").path
        let bytes = path.utf8CString; let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard bytes.count <= capacity else { Darwin.close(fd); throw BackendFailure(message: "数据目录路径过长") }
        _ = withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { strncpy($0, path, capacity) }
        }
        let originalFlags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, originalFlags | O_NONBLOCK)
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if connected != 0 {
            guard errno == EINPROGRESS else {
                Darwin.close(fd); throw BackendFailure(message: "后台尚未连接。请稍候，或点击重新连接。", retryable: true)
            }
            var descriptor = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
            let wait = Int32(max(1, min(deadline.timeIntervalSinceNow, 2)) * 1000)
            let ready = poll(&descriptor, 1, wait)
            var socketError: Int32 = 0; var length = socklen_t(MemoryLayout<Int32>.size)
            if ready <= 0 || getsockopt(fd, SOL_SOCKET, SO_ERROR, &socketError, &length) != 0 || socketError != 0 {
                Darwin.close(fd); throw BackendFailure(message: "后台尚未连接。请稍候，或点击重新连接。", retryable: true)
            }
        }
        // Keep nonblocking mode: send/recv deadlines must survive peer backpressure.
        return fd
    }

    private func writeAll(_ data: Data, fd: Int32, deadline: Date) throws {
        try data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < data.count {
                let sent = Darwin.send(fd, buffer.baseAddress!.advanced(by: offset), data.count - offset, 0)
                if sent > 0 { offset += sent; continue }
                if sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                    var descriptor = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                    let remaining = Int32(max(0, deadline.timeIntervalSinceNow) * 1000)
                    if remaining <= 0 || poll(&descriptor, 1, remaining) <= 0 {
                        throw BackendFailure(message: "本机请求未能完整发送")
                    }
                    continue
                }
                if sent < 0 && errno == EINTR { continue }
                throw BackendFailure(message: "本机请求未能完整发送")
            }
        }
    }

    private func readReply(fd: Int32, deadline: Date) throws -> [String: Any] {
        var reply = Data(); var buffer = [UInt8](repeating: 0, count: 65_536)
        while true {
            let remaining = Int32(max(0, deadline.timeIntervalSinceNow) * 1000)
            if remaining <= 0 { throw BackendFailure(message: "后台响应超时，请稍后重试") }
            var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&descriptor, 1, min(remaining, 5_000))
            if ready == 0 { continue }
            if ready < 0 { if errno == EINTR { continue }; throw BackendFailure(message: "后台响应无效或连接已中断") }
            let count = Darwin.recv(fd, &buffer, buffer.count, 0)
            if count > 0 {
                reply.append(buffer, count: count)
                if reply.count > Self.maxReplyBytes { throw BackendFailure(message: "后台响应超出大小限制") }
                if reply.last == 0x0A { break }
                continue
            }
            if count == 0 { throw BackendFailure(message: "后台响应无效或连接已中断") }
            if errno == EAGAIN || errno == EINTR { continue }
            throw BackendFailure(message: "后台响应无效或连接已中断")
        }
        guard let value = try JSONSerialization.jsonObject(with: reply) as? [String: Any] else {
            throw BackendFailure(message: "后台响应无效或连接已中断")
        }
        return value
    }

    func stop(completion: @escaping () -> Void) {
        send(["command": "stop"]) { _ in completion() }
    }

    /// Best-effort fast stop for self-update or forced termination: bypasses the serial `queue`
    /// so an in-flight long command cannot block shutdown, and guarantees `child` termination
    /// and `completion` callback on the main thread within `timeout` seconds.
    func forceStop(timeout: TimeInterval = 2.0, completion: @escaping () -> Void) {
        generation += 1
        isRestarting = true
        #if NATIVE_UI_TEST
        DispatchQueue.main.async {
            self.isRestarting = false
            completion()
        }
        #else
        let targetChild = child
        let pid = targetChild?.processIdentifier ?? 0
        let lock = NSLock()
        var completed = false
        let finish: () -> Void = {
            lock.lock()
            let shouldRun = !completed
            completed = true
            lock.unlock()
            if shouldRun {
                DispatchQueue.main.async { completion() }
            }
        }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout + 0.4) {
            if let targetChild, targetChild.isRunning {
                targetChild.terminate()
                if pid > 0 { _ = Darwin.kill(pid, SIGKILL) }
            }
            finish()
        }
        controlQueue.async { [self] in
            if let targetChild, targetChild.isRunning {
                let stopDeadline = Date().addingTimeInterval(min(1.2, max(0.3, timeout * 0.6)))
                if let fd = try? openSocket(deadline: stopDeadline) {
                    if var data = try? JSONSerialization.data(withJSONObject: ["command": "stop"]) {
                        data.append(0x0A)
                        try? writeAll(data, fd: fd, deadline: stopDeadline)
                        _ = try? readReply(fd: fd, deadline: stopDeadline)
                    }
                    Darwin.close(fd)
                }
                let waitDeadline = Date().addingTimeInterval(max(0.2, timeout * 0.4))
                while targetChild.isRunning && Date() < waitDeadline {
                    usleep(30_000)
                }
                if targetChild.isRunning {
                    targetChild.terminate()
                    let termDeadline = Date().addingTimeInterval(0.25)
                    while targetChild.isRunning && Date() < termDeadline {
                        usleep(25_000)
                    }
                    if targetChild.isRunning && pid > 0 {
                        _ = Darwin.kill(pid, SIGKILL)
                    }
                }
            }
            finish()
        }
        #endif
    }
}
