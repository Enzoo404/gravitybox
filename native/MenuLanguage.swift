import Cocoa

struct ToolboxFailure: LocalizedError { let message:String;var errorDescription:String?{message} }
final class MenuLanguagePreferences {
    let state:URL;let domain:String;let syncCompanionDomain:Bool
    init(state:URL,domain:String?=nil){
        self.state=state
        self.syncCompanionDomain=(domain == nil)
        let data=try? Data(contentsOf:state.appendingPathComponent("config.json"))
        let config=data.flatMap{try? JSONSerialization.jsonObject(with:$0) as? [String:Any]}
        self.domain=domain ?? (config?["applicationChannel"] as? String == "insiders" ? "com.google.antigravity.insiders" : "com.google.antigravity")
    }
    var companionDomain:String{domain == "com.google.antigravity.insiders" ? "com.google.antigravity" : "com.google.antigravity.insiders"}
    var backup:URL{state.appendingPathComponent(domain == "com.google.antigravity.insiders" ? "native-language-backup-insiders.plist" : "native-language-backup.plist")}
    var current:Any?{UserDefaults.standard.persistentDomain(forName:domain)?["AppleLanguages"]}
    var isChinese:Bool{(current as? [String])?.first?.hasPrefix("zh")==true}
    var preferenceIndex:Int { guard let first=(current as? [String])?.first else{return 0};return first.hasPrefix("zh") ? 1 : first.hasPrefix("en") ? 2 : 0 }
    var canRestore:Bool{guard let data=try? Data(contentsOf:backup),let payload=try? PropertyListSerialization.propertyList(from:data,format:nil) as? [String:Any] else{return false};return payload["restored"] as? Bool != true}
    func enable()throws{try writeLanguages(["zh-Hans","en-US"])}
    func disable()throws{try writeLanguages(["en-US"])}
    func setPreference(index:Int)throws {
        switch index { case 1:try enable();case 2:try disable();default:try writeLanguages(nil) }
    }
    private func writeLanguages(_ value:[String]?)throws {
        var payload:[String:Any]
        if canRestore,let data=try? Data(contentsOf:backup),let saved=try? PropertyListSerialization.propertyList(from:data,format:nil) as? [String:Any] { payload=saved }
        else { payload=["present":current != nil,"value":current ?? []] }
        payload["written"]=value ?? [];payload["writtenPresent"]=value != nil;payload["restored"]=false
        // Save rollback state before changing the one application-scoped preference.
        try PropertyListSerialization.data(fromPropertyList:payload,format:.binary,options:0).write(to:backup,options:.atomic)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:backup.path)
        let preferences=UserDefaults(suiteName:domain)!
        if let value { preferences.set(value,forKey:"AppleLanguages") } else { preferences.removeObject(forKey:"AppleLanguages") }
        preferences.synchronize()
        if syncCompanionDomain, let companion = UserDefaults(suiteName: companionDomain) {
            if let value { companion.set(value, forKey: "AppleLanguages") } else { companion.removeObject(forKey: "AppleLanguages") }
            companion.synchronize()
        }
    }
    func restore()throws {
        let data=try Data(contentsOf:backup);var payload=try PropertyListSerialization.propertyList(from:data,format:nil) as? [String:Any] ?? [:]
        let expectedPresent=payload["writtenPresent"] as? Bool ?? true
        guard expectedPresent ? current as? [String] == payload["written"] as? [String] : current == nil else {throw ToolboxFailure(message:"语言偏好已在其它位置更改，已保留当前设置。")}
        let preferences=UserDefaults(suiteName:domain)!
        if payload["present"] as? Bool == true{preferences.set(payload["value"],forKey:"AppleLanguages")}else{preferences.removeObject(forKey:"AppleLanguages")};preferences.synchronize()
        if syncCompanionDomain, let companion = UserDefaults(suiteName: companionDomain) {
            if payload["present"] as? Bool == true { companion.set(payload["value"], forKey: "AppleLanguages") } else { companion.removeObject(forKey: "AppleLanguages") }
            companion.synchronize()
        }
        payload["restored"]=true
        try PropertyListSerialization.data(fromPropertyList:payload,format:.binary,options:0).write(to:backup,options:.atomic)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:backup.path)
    }
}
