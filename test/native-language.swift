import Cocoa
@main struct LanguageTests {
 static func main()throws {
  let domain="local.gravitybox.fixture."+UUID().uuidString,preferences=UserDefaults(suiteName:domain)!
  let state=FileManager.default.temporaryDirectory.appendingPathComponent("gravity-language-"+UUID().uuidString);try FileManager.default.createDirectory(at:state,withIntermediateDirectories:true)
  defer{preferences.removePersistentDomain(forName:domain);preferences.synchronize();try? FileManager.default.removeItem(at:state)}
  try Data("{\"applicationChannel\":\"insiders\"}".utf8).write(to: state.appendingPathComponent("config.json"))
  precondition(MenuLanguagePreferences(state: state).domain == "com.google.antigravity", "Legacy config must not select Insiders language preferences")
  let store=MenuLanguagePreferences(state:state,domain:domain)
  try store.enable();precondition(store.isChinese);precondition(store.canRestore);try store.restore();precondition(store.current==nil);precondition(!store.canRestore)
  preferences.set(["en-GB","fr"],forKey:"AppleLanguages");preferences.synchronize();try store.enable();try store.enable();try store.restore();precondition(store.current as? [String]==["en-GB","fr"])
  try store.enable();preferences.set(["ja"],forKey:"AppleLanguages");preferences.synchronize()
  do{try store.restore();fatalError("External change must not be overwritten")}catch{precondition(store.current as? [String]==["ja"])}
  preferences.removeObject(forKey:"AppleLanguages");preferences.synchronize()
  try store.enable();try store.disable();precondition(!store.isChinese);precondition(store.current as? [String]==["en-US"])
  try store.setPreference(index:0);precondition(store.current==nil)
  preferences.set(["zh-Hans"],forKey:"AppleLanguages");preferences.synchronize()
  try store.disable();precondition(!store.isChinese, "Turning off must work even if the original preference was Chinese")
  let attributes=try FileManager.default.attributesOfItem(atPath:store.backup.path)
  precondition((attributes[.posixPermissions] as? NSNumber)?.intValue==0o600)
  print("原生语言偏好：空值恢复、原数组恢复、重复启用、外部更改保护及私有备份通过")
 }
}
