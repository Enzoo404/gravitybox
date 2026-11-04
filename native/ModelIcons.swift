import Cocoa

enum ModelIcons {
    private static var cache: [String:NSImage] = [:]
    static func image(_ name:String) -> NSImage? {
        if let image=cache[name] { return image }
        #if NATIVE_UI_TEST
        let root = URL(fileURLWithPath:ProcessInfo.processInfo.environment["GRAVITYBOX_UI_RESOURCES"] ?? "assets")
        #else
        let root = Bundle.main.resourceURL!
        #endif
        let folder = root.appendingPathComponent("model-icons")
        let file = name + ".png"
        guard let image=NSImage(contentsOf:folder.appendingPathComponent(file)) else { return nil }
        image.isTemplate = (name == "openai")
        cache[name]=image; return image
    }
    static func tintColor(for image: NSImage) -> NSColor? {
        image.isTemplate ? .labelColor : nil
    }
    static func brands(for title:String) -> [String] {
        let lower=title.lowercased()
        if lower.contains("gemini") { return ["gemini"] }
        if lower.contains("claude") && lower.contains("gpt") { return ["claude","openai"] }
        if lower.contains("claude") { return ["claude"] }
        if lower.contains("gpt") || lower.contains("openai") { return ["openai"] }
        return []
    }
}
