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
