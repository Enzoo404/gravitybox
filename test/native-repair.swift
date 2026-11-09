import Cocoa
@main struct Probe {
 static func main() throws {
  let root=URL(fileURLWithPath:CommandLine.arguments[2])
  if CommandLine.arguments[1] == "bridge" {
   let bridge=BackendBridge(resources:root,state:root)
   bridge.send(["command":"usage_summary"]) { _ in }
   DispatchQueue.main.asyncAfter(deadline:.now()+0.05) {bridge.send(["command":"usage_cancel"]) { _ in CFRunLoopStop(CFRunLoopGetMain())}}
   DispatchQueue.main.asyncAfter(deadline:.now()+5) {CFRunLoopStop(CFRunLoopGetMain())};CFRunLoopRun();return
  }
  if CommandLine.arguments[1] == "quarantine" {
   let qVal = "0081;66554433;Safari;12345678-ABCD-EF01-2345-6789ABCDEF01"
   let fm = FileManager.default

   // 1. Single file standard clearance
   let testFile = root.appendingPathComponent("test-quarantine-file.bin")
   try Data("quarantine-test-payload".utf8).write(to: testFile)
   let setFileRes = testFile.path.withCString {
       Darwin.setxattr($0, "com.apple.quarantine", qVal, qVal.utf8.count, 0, 0)
   }
   precondition(setFileRes == 0, "setxattr failed on test file")
   precondition(testFile.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) >= 0 }, "test file must have quarantine attribute before clear")
   BackendBridge.clearQuarantineIfNeeded(at: testFile)
   precondition(testFile.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) < 0 }, "BackendBridge.clearQuarantineIfNeeded must strip quarantine from file")

   // 2. Read-only permissions file (0o555): verify permission recovery and successful quarantine removal
   let roFile = root.appendingPathComponent("test-quarantine-ro.bin")
   try Data("quarantine-ro-payload".utf8).write(to: roFile)
   _ = roFile.path.withCString { Darwin.setxattr($0, "com.apple.quarantine", qVal, qVal.utf8.count, 0, 0) }
   try fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: roFile.path)
   precondition(roFile.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) >= 0 })
   BackendBridge.clearQuarantineIfNeeded(at: roFile)
   precondition(roFile.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) < 0 }, "read-only 0o555 file quarantine must be cleared")
   let roAttrs = try fm.attributesOfItem(atPath: roFile.path)
   let roPerms = (roAttrs[.posixPermissions] as? NSNumber)?.intValue ?? 0
   precondition(roPerms == 0o555, "original 0o555 permissions must be restored after quarantine removal")

   // 3. App Bundle full recursive clearance
   let bundleDir = root.appendingPathComponent("TestBundle.app")
   let resourcesDir = bundleDir.appendingPathComponent("Contents/Resources", isDirectory: true)
   let runtimeDir = resourcesDir.appendingPathComponent("runtime", isDirectory: true)
   try fm.createDirectory(at: runtimeDir, withIntermediateDirectories: true)
   let nodeBin = runtimeDir.appendingPathComponent("node")
   try Data("#!/bin/sh\nexit 0\n".utf8).write(to: nodeBin)
   try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodeBin.path)

   _ = bundleDir.path.withCString { Darwin.setxattr($0, "com.apple.quarantine", qVal, qVal.utf8.count, 0, 0) }
   _ = resourcesDir.path.withCString { Darwin.setxattr($0, "com.apple.quarantine", qVal, qVal.utf8.count, 0, 0) }
   _ = nodeBin.path.withCString { Darwin.setxattr($0, "com.apple.quarantine", qVal, qVal.utf8.count, 0, 0) }

   precondition(bundleDir.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) >= 0 })
   precondition(resourcesDir.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) >= 0 })
   precondition(nodeBin.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) >= 0 })

   BackendBridge.clearQuarantineIfNeeded(at: bundleDir)

   precondition(bundleDir.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) < 0 }, "bundle directory quarantine must be cleared")
   precondition(resourcesDir.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) < 0 }, "nested resources quarantine must be cleared recursively")
   precondition(nodeBin.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) < 0 }, "nested node runtime quarantine must be cleared recursively")

   // 4. Scenario 2b: Only nodeBin has quarantine, parent bundleDir/resourcesDir do NOT (Finder right-click Gatekeeper bypass)
   let bundle2 = root.appendingPathComponent("TestBundle2.app")
   let res2 = bundle2.appendingPathComponent("Contents/Resources", isDirectory: true)
   let runtime2 = res2.appendingPathComponent("runtime", isDirectory: true)
   try fm.createDirectory(at: runtime2, withIntermediateDirectories: true)
   let node2 = runtime2.appendingPathComponent("node")
   try Data("#!/bin/sh\nexit 0\n".utf8).write(to: node2)
   try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node2.path)
   _ = node2.path.withCString { Darwin.setxattr($0, "com.apple.quarantine", qVal, qVal.utf8.count, 0, 0) }
   precondition(bundle2.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) < 0 })
   precondition(node2.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) >= 0 })
   BackendBridge.clearQuarantineIfNeeded(at: node2)
   precondition(node2.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) < 0 }, "isolated runtime/node quarantine must be cleared directly")

   _ = node2.path.withCString { Darwin.setxattr($0, "com.apple.quarantine", qVal, qVal.utf8.count, 0, 0) }
   BackendBridge.clearQuarantineIfNeeded(at: res2)
   precondition(node2.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) < 0 }, "nested node quarantine must be cleared when clearQuarantineIfNeeded called on parent resources")

   // 5. Nested read-only node binary inside resources directory (0o555 permission robustness)
   let bundleRO = root.appendingPathComponent("TestBundleRO.app")
   let resRO = bundleRO.appendingPathComponent("Contents/Resources", isDirectory: true)
   let runtimeRO = resRO.appendingPathComponent("runtime", isDirectory: true)
   try fm.createDirectory(at: runtimeRO, withIntermediateDirectories: true)
   let nodeRO = runtimeRO.appendingPathComponent("node")
   try Data("#!/bin/sh\nexit 0\n".utf8).write(to: nodeRO)
   _ = nodeRO.path.withCString { Darwin.setxattr($0, "com.apple.quarantine", qVal, qVal.utf8.count, 0, 0) }
   try fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: nodeRO.path)
   precondition(nodeRO.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) >= 0 })
   BackendBridge.clearQuarantineIfNeeded(at: resRO)
   precondition(nodeRO.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) < 0 }, "nested read-only node in directory must be cleared")
   let nodeROPerms = (try fm.attributesOfItem(atPath: nodeRO.path)[.posixPermissions] as? NSNumber)?.intValue ?? 0
   precondition(nodeROPerms == 0o555, "nested node permissions must be preserved after clearance")

   // 6. Deep directory nesting clearance
   let deepDir = root.appendingPathComponent("deep/level1/level2/level3/Contents/Resources/runtime", isDirectory: true)
   try fm.createDirectory(at: deepDir, withIntermediateDirectories: true)
   let deepNode = deepDir.appendingPathComponent("node")
   try Data("#!/bin/sh\nexit 0\n".utf8).write(to: deepNode)
   _ = deepNode.path.withCString { Darwin.setxattr($0, "com.apple.quarantine", qVal, qVal.utf8.count, 0, 0) }
   precondition(deepNode.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) >= 0 })
   BackendBridge.clearQuarantineIfNeeded(at: root.appendingPathComponent("deep/level1/level2/level3", isDirectory: true))
   precondition(deepNode.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) < 0 }, "deeply nested node quarantine must be cleared")

   // 7. Fast-path performance and idempotency on clean structures
   let t0 = CFAbsoluteTimeGetCurrent()
   BackendBridge.clearQuarantineIfNeeded(at: testFile)
   BackendBridge.clearQuarantineIfNeeded(at: bundleDir)
   let elapsedMs = (CFAbsoluteTimeGetCurrent() - t0) * 1000.0
   precondition(elapsedMs < 20.0, "clean directory clearQuarantineIfNeeded must be near instantaneous fast path (<20ms), took: \(elapsedMs)ms")
   precondition(testFile.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) < 0 })

   // 8. Graceful handling of non-existent path
   let nonExistent = root.appendingPathComponent("non-existent-subpath-\(UUID().uuidString)")
   BackendBridge.clearQuarantineIfNeeded(at: nonExistent)

   print("quarantine clearance passed")
   return
  }
  if CommandLine.arguments[1] == "launch_quarantine" {
   let resources = root.appendingPathComponent("mock_resources", isDirectory: true)
   let runtimeDir = resources.appendingPathComponent("runtime", isDirectory: true)
   let coreDistDir = resources.appendingPathComponent("core/dist", isDirectory: true)
   let fm = FileManager.default
   try fm.createDirectory(at: runtimeDir, withIntermediateDirectories: true)
   try fm.createDirectory(at: coreDistDir, withIntermediateDirectories: true)
   let nodeBin = runtimeDir.appendingPathComponent("node")
   let script = """
   #!/bin/sh
   trap 'exit 0' TERM INT
   while true; do
       sleep 0.1
   done
   """
   try Data(script.utf8).write(to: nodeBin)
   let qVal = "0081;66554433;Safari;12345678-ABCD-EF01-2345-6789ABCDEF01"
   _ = resources.path.withCString { Darwin.setxattr($0, "com.apple.quarantine", qVal, qVal.utf8.count, 0, 0) }
   _ = nodeBin.path.withCString { Darwin.setxattr($0, "com.apple.quarantine", qVal, qVal.utf8.count, 0, 0) }
   // Now set 0o555 read-only permissions on nodeBin to verify launch robustness with read-only runtime binaries
   try fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: nodeBin.path)
   let mainJs = coreDistDir.appendingPathComponent("main.js")
   try Data("// main.js\n".utf8).write(to: mainJs)

   precondition(resources.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) >= 0 }, "resources must have quarantine before launch")
   precondition(nodeBin.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) >= 0 }, "node binary must have quarantine before launch")

   let bridge = BackendBridge(resources: resources, state: root)
   var launchSuccess = false
   var launchError: Error?
   bridge.launch { result in
       switch result {
       case .success:
           launchSuccess = true
       case .failure(let err):
           launchError = err
       }
       CFRunLoopStop(CFRunLoopGetMain())
   }
   DispatchQueue.main.asyncAfter(deadline: .now() + 5.0) {
       CFRunLoopStop(CFRunLoopGetMain())
   }
   CFRunLoopRun()

   precondition(launchSuccess, "bridge.launch must succeed, error: \(String(describing: launchError))")
   precondition(bridge.isOwnedProcessRunning, "child process must be running")

   precondition(resources.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) < 0 }, "resources quarantine must be cleared by launch")
   precondition(nodeBin.path.withCString { Darwin.getxattr($0, "com.apple.quarantine", nil, 0, 0, 0) < 0 }, "runtime/node quarantine must be cleared by launch")

   bridge.stop()
   print("quarantine launch passed")
   return
  }
  let file=root.appendingPathComponent("config.json")
  let original:[String:Any] = ["schema":2,"selectedProfile":"gemini","profiles":["gemini":["preset":"gemini","model":"synthetic-preserve"],"custom":17],"futureField":"preserve","autoCompleteAuthorizedHost":"https://synthetic.invalid"]
  try JSONSerialization.data(withJSONObject:original).write(to:file)
  let store=try ConfigurationStore(state:root);store.value.lastPage=2;try store.save()
  let saved=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any]
  precondition((saved["profiles"] as? [String:Any])?["custom"] as? Int == 17);precondition(saved["futureField"] as? String == "preserve");precondition(saved["autoCompleteAuthorizedHost"] as? String == "https://synthetic.invalid")
  precondition(saved["selectedProfile"] as? String == "gemini")
  var legacy = saved; legacy["applicationChannel"] = "insiders"
  try JSONSerialization.data(withJSONObject: legacy).write(to: file)
  let reloaded = try ConfigurationStore(state: root)
  precondition(reloaded.value.applicationChannel == "stable")
  let migrated = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String:Any]
  precondition(migrated["applicationChannel"] as? String == "stable")
  precondition(migrated["futureField"] as? String == "preserve")
  let backup = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("config-before-stable-only.json"))) as! [String:Any]
  precondition(backup["applicationChannel"] as? String == "insiders")
  precondition(DesktopApplicationTarget(channel: "insiders").path == "/Applications/Antigravity.app")
  let invalid = Data("{\"schema\":2,\"applicationChannel\":\"other\"}".utf8)
  try invalid.write(to: file); var invalidRejected = false
  do { _ = try ConfigurationStore(state: root) } catch { invalidRejected = true }
  precondition(invalidRejected); let invalidAfter = try Data(contentsOf: file); precondition(invalidAfter == invalid)
  let future=Data("{\"schema\":3,\"profiles\":{}}".utf8);try future.write(to:file);var rejected=false
  do {_=try ConfigurationStore(state:root)}catch{rejected=true};precondition(rejected);let after=try Data(contentsOf:file);precondition(after==future)
  print("configuration preservation passed")
 }
}
