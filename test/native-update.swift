import Cocoa

@main struct NativeUpdateTests {
    static func check(_ value: Bool, _ message: String) {
        if !value { fatalError(message) }
    }
    static func rejects(_ message: String, _ action: () throws -> Void) {
        do { try action(); fatalError(message) } catch {}
    }
    static func validate(_ app: URL, _ version: String, _ hash: String) throws {
        let data = try Data(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        let info = try PropertyListSerialization.propertyList(from: data, format: nil) as! [String: Any]
        guard info["CFBundleShortVersionString"] as? String == version,
              try UpdatePackageIntegrity.appHash(app) == hash else { throw UpdatePackageIntegrity.failure("synthetic identity mismatch") }
    }
    static func main() throws {
        let fm = FileManager.default, root = URL(fileURLWithPath: CommandLine.arguments[1])
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("GravityBox-2.0.0-arm64.dmg")
        try Data("synthetic package".utf8).write(to: file)
        let hash = try UpdatePackageIntegrity.fileHash(file)
        check(try UpdatePackageIntegrity.expectedHash(hash + "  " + file.lastPathComponent + "\n", fileName: file.lastPathComponent) == hash, "standard checksum")
        check(try UpdatePackageIntegrity.expectedHash(hash.uppercased() + " *" + file.lastPathComponent + "\r\n", fileName: file.lastPathComponent) == hash, "binary checksum")
        for text in ["", "bad hash", String(repeating:"z",count:64)+"  "+file.lastPathComponent, hash+"  Other.dmg", hash+"  "+file.lastPathComponent+"\n"+hash+"  "+file.lastPathComponent] {
            rejects("invalid checksum accepted") { _ = try UpdatePackageIntegrity.expectedHash(text, fileName: file.lastPathComponent) }
        }
        try UpdatePackageIntegrity.verify(file, expected: hash)
        try Data("changed package".utf8).write(to: file)
        rejects("modified package accepted") { try UpdatePackageIntegrity.verify(file, expected: hash) }

        func makeApp(_ url: URL, _ version: String, _ payload: String) throws {
            try fm.createDirectory(at: url.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories:true)
            try fm.createDirectory(at: url.appendingPathComponent("Contents/_CodeSignature"), withIntermediateDirectories:true)
            try Data(payload.utf8).write(to: UpdateInstaller.executable(url))
            try Data("synthetic sealed resources".utf8).write(to: url.appendingPathComponent("Contents/_CodeSignature/CodeResources"))
            let info = ["CFBundleIdentifier":"local.gravitybox.app", "CFBundleShortVersionString":version]
            try PropertyListSerialization.data(fromPropertyList:info,format:.xml,options:0).write(to:url.appendingPathComponent("Contents/Info.plist"))
        }
        func fixture(_ name: String) throws -> (URL, URL, URL, String, String) {
            let dir = root.appendingPathComponent(name), target = dir.appendingPathComponent("GravityBox.app")
            let stage = dir.appendingPathComponent("staged.app"), work = dir.appendingPathComponent("state/updates/transactions/install-test")
            try fm.createDirectory(at:work,withIntermediateDirectories:true)
            try makeApp(target,"1.0.0","same native executable")
            // Identity must include version/resources, even when native binaries are unchanged.
            try makeApp(stage,"2.0.0","same native executable")
            let old = try UpdatePackageIntegrity.appHash(target), new = try UpdatePackageIntegrity.appHash(stage)
            check(old != new,"app version is part of identity")
            let receipt = try UpdateInstaller.prepare(stagedApp:stage,target:target,work:work,version:"2.0.0",dmg:file,validate:validate)
            let record = try JSONDecoder().decode(UpdateInstallReceipt.self,from:Data(contentsOf:receipt))
            return (target,URL(fileURLWithPath:record.backupPath),receipt,old,new)
        }
        let synthetic = UpdatePackageIntegrity.failure("synthetic failure")
        let success = try fixture("success ' $() 中文")
        let userData = success.2.deletingLastPathComponent().appendingPathComponent("user-state.json")
        try Data("preserve all account/settings data".utf8).write(to:userData)
        try UpdateInstaller.run(receiptURL:success.2,validate:validate,openApp:{_,_,_ in},awaitReady:{_,_ in true},stopApp:{_ in})
        check(try UpdatePackageIntegrity.appHash(success.0) == success.4,"new app installed")
        check(try UpdatePackageIntegrity.appHash(success.1) == success.3,"old app retained")
        check(try String(contentsOf:userData,encoding:.utf8) == "preserve all account/settings data","user state preserved")

        let moveFail = try fixture("swap-fails")
        rejects("failed swap must fail") { try UpdateInstaller.run(receiptURL:moveFail.2,exchange:{_,_ in throw synthetic},validate:validate,openApp:{_,_,_ in},awaitReady:{_,_ in true},stopApp:{_ in}) }
        check(try UpdatePackageIntegrity.appHash(moveFail.0) == moveFail.3,"swap error kept old app")

        for mode in ["launch-fails","backend-not-ready"] {
            let f = try fixture(mode)
            rejects("failed launch must restore old app") {
                try UpdateInstaller.run(receiptURL:f.2,validate:validate,openApp:{_,receipt,_ in if mode == "launch-fails" && receipt != nil { throw synthetic }},awaitReady:{_,_ in false},stopApp:{_ in})
            }
            check(try UpdatePackageIntegrity.appHash(f.0) == f.3,"old app restored on \(mode)")
            check(try UpdatePackageIntegrity.appHash(f.1) == f.4,"failed new app retained for diagnosis")
        }
        let interrupted = try fixture("interrupted-after-swap")
        try UpdateInstaller.swap(interrupted.0,interrupted.1)
        try UpdateInstaller.run(receiptURL:interrupted.2,validate:validate,openApp:{_,_,_ in},awaitReady:{_,_ in true},stopApp:{_ in})
        check(try UpdatePackageIntegrity.appHash(interrupted.0) == interrupted.4,"resume never swaps the new app back accidentally")
        check(try UpdatePackageIntegrity.appHash(interrupted.1) == interrupted.3,"resume retains predecessor")

        let failedRecovery = try fixture("rollback-temporarily-fails")
        var exchanges = 0
        rejects("failed rollback must retain recovery materials") {
            try UpdateInstaller.run(receiptURL:failedRecovery.2,exchange:{a,b in exchanges += 1;if exchanges == 2 { throw synthetic };try UpdateInstaller.swap(a,b)},validate:validate,openApp:{_,_,_ in throw synthetic},awaitReady:{_,_ in false},stopApp:{_ in})
        }
        let pending = try JSONDecoder().decode(UpdateInstallReceipt.self,from:Data(contentsOf:failedRecovery.2))
        check(pending.phase == "recovery-required","failed recovery reported")
        check(try UpdatePackageIntegrity.appHash(failedRecovery.1) == failedRecovery.3,"recovery failure retains old app")
        rejects("retried launch still fails") { try UpdateInstaller.run(receiptURL:failedRecovery.2,validate:validate,openApp:{_,_,_ in throw synthetic},awaitReady:{_,_ in false},stopApp:{_ in}) }
        check(try UpdatePackageIntegrity.appHash(failedRecovery.0) == failedRecovery.3,"retry restores old app")

        let acknowledged = try fixture("health-ack")
        try UpdateInstaller.swap(acknowledged.0,acknowledged.1)
        let state = acknowledged.2.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let record = try JSONDecoder().decode(UpdateInstallReceipt.self,from:Data(contentsOf:acknowledged.2))
        check(!UpdateInstaller.acknowledge(arguments:["app","--update-receipt",acknowledged.2.path,"--update-token","wrong"],state:state,bundle:acknowledged.0),"wrong health token refused")
        check(UpdateInstaller.acknowledge(arguments:["app","--update-receipt",acknowledged.2.path,"--update-token",record.token],state:state,bundle:acknowledged.0),"healthy matching app acknowledged")
        check(UpdateInstaller.waitForReady(acknowledged.2,token:record.token,timeout:0.1),"helper observes readiness")
        let launchArguments = ["app","--update-receipt",acknowledged.2.path,"--update-token",record.token]
        check(!UpdateInstaller.isConfirmed(arguments:launchArguments,state:state,bundle:acknowledged.0),"ready acknowledgement must not authorize cleanup before confirmation")
        var cleanupReceipt = record
        for phase in ["installed", "rolled-back", "recovery-required"] {
            cleanupReceipt.phase = phase; try cleanupReceipt.save(to: acknowledged.2)
            check(!UpdateInstaller.isConfirmed(arguments:launchArguments,state:state,bundle:acknowledged.0),"unconfirmed or failed transaction cannot authorize cleanup")
        }
        cleanupReceipt.phase = "confirmed"; try cleanupReceipt.save(to: acknowledged.2)
        check(UpdateInstaller.isConfirmed(arguments:launchArguments,state:state,bundle:acknowledged.0),"only committed confirmation authorizes cleanup")
        try fm.removeItem(at: acknowledged.2.deletingLastPathComponent().appendingPathComponent("ready"))
        check(!UpdateInstaller.isConfirmed(arguments:launchArguments,state:state,bundle:acknowledged.0),"confirmation without matching health acknowledgement is insufficient")
        check(fm.fileExists(atPath:file.path),"failed updates must retain the downloaded package")
        print("checksum, cache integrity, atomic swap, rollback, interrupted recovery, health acknowledgement and data preservation passed")
    }
}
