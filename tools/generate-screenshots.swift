import Cocoa
import CoreGraphics

// GravityBox 高清实机截图生成与排版工具
// 支持 2x Retina 超高清渲染、交通灯按钮增强、深浅双主题以及全景 Hero 合成

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let appVersion: String = {
    let pkgURL = root.appendingPathComponent("package.json")
    if let data = try? Data(contentsOf: pkgURL),
       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let version = json["version"] as? String, !version.isEmpty {
        return version
    }
    return "1.1.0"
}()
let sourceDir = root.appendingPathComponent("质检报告/\(appVersion)-改造验收/原生布局")
let targetDir = root.appendingPathComponent("assets/screenshots")

try? FileManager.default.createDirectory(at: targetDir, withIntermediateDirectories: true)

// 辅助：加载图片并获取 NSBitmapImageRep
func loadRep(from url: URL) -> NSBitmapImageRep? {
    guard let data = try? Data(contentsOf: url),
          let img = NSImage(data: data),
          let rep = img.representations.compactMap({ $0 as? NSBitmapImageRep }).first ??
                    NSBitmapImageRep(data: data) else {
        return nil
    }
    return rep
}

// 辅助：保存 PNG
func savePNG(_ rep: NSBitmapImageRep, to url: URL) throws {
    guard let data = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "ScreenshotError", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to create PNG"])
    }
    try data.write(to: url)
}

// 辅助：在主窗口图像左上角绘制标准 macOS 交通灯按钮并做圆角处理
func polishMainWindow(_ sourceRep: NSBitmapImageRep, isDark: Bool) -> NSBitmapImageRep {
    let width = sourceRep.pixelsWide
    let height = sourceRep.pixelsHigh
    
    let targetRep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )!
    targetRep.size = NSSize(width: width / 2, height: height / 2)
    
    NSGraphicsContext.saveGraphicsState()
    let context = NSGraphicsContext(bitmapImageRep: targetRep)!
    NSGraphicsContext.current = context
    
    let logicalW = CGFloat(width) / 2.0
    let logicalH = CGFloat(height) / 2.0
    let logicalBounds = NSRect(x: 0, y: 0, width: logicalW, height: logicalH)
    
    // 圆角裁剪
    let cornerRadius: CGFloat = 11.0
    let clipPath = NSBezierPath(roundedRect: logicalBounds, xRadius: cornerRadius, yRadius: cornerRadius)
    clipPath.addClip()
    
    // 绘制原内容
    sourceRep.draw(in: logicalBounds)
    
    // 绘制标准 macOS 交通灯按钮 (Red, Yellow, Green)
    // 逻辑坐标系下，原点在左下角，顶部为 logicalH
    let btnRadius: CGFloat = 6.0
    let btnDiam: CGFloat = 12.0
    let startX: CGFloat = 19.0
    let centerY: CGFloat = logicalH - 20.0
    let spacing: CGFloat = 8.0
    
    let buttons: [(fill: NSColor, stroke: NSColor)] = [
        (NSColor(srgbRed: 1.0, green: 0.373, blue: 0.341, alpha: 1.0), NSColor(srgbRed: 0.88, green: 0.27, blue: 0.24, alpha: 1.0)),
        (NSColor(srgbRed: 1.0, green: 0.741, blue: 0.180, alpha: 1.0), NSColor(srgbRed: 0.87, green: 0.63, blue: 0.14, alpha: 1.0)),
        (NSColor(srgbRed: 0.153, green: 0.788, blue: 0.247, alpha: 1.0), NSColor(srgbRed: 0.10, green: 0.67, blue: 0.16, alpha: 1.0))
    ]
    
    for (i, btn) in buttons.enumerated() {
        let x = startX + CGFloat(i) * (btnDiam + spacing)
        let rect = NSRect(x: x, y: centerY - btnRadius, width: btnDiam, height: btnDiam)
        let path = NSBezierPath(ovalIn: rect)
        btn.fill.setFill()
        path.fill()
        btn.stroke.setStroke()
        path.lineWidth = 0.5
        path.stroke()
    }
    
    // 微弱窗口描边
    let strokeColor = isDark ? NSColor(white: 1.0, alpha: 0.15) : NSColor(white: 0.0, alpha: 0.12)
    strokeColor.setStroke()
    let strokePath = NSBezierPath(roundedRect: logicalBounds.insetBy(dx: 0.5, dy: 0.5), xRadius: cornerRadius, yRadius: cornerRadius)
    strokePath.lineWidth = 1.0
    strokePath.stroke()
    
    NSGraphicsContext.restoreGraphicsState()
    return targetRep
}

// 辅助：为菜单栏面板做圆角与微描边处理
func polishMenuPanel(_ sourceRep: NSBitmapImageRep, isDark: Bool) -> NSBitmapImageRep {
    let width = sourceRep.pixelsWide
    let height = sourceRep.pixelsHigh
    
    let targetRep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )!
    targetRep.size = NSSize(width: width / 2, height: height / 2)
    
    NSGraphicsContext.saveGraphicsState()
    let context = NSGraphicsContext(bitmapImageRep: targetRep)!
    NSGraphicsContext.current = context
    
    let logicalW = CGFloat(width) / 2.0
    let logicalH = CGFloat(height) / 2.0
    let bounds = NSRect(x: 0, y: 0, width: logicalW, height: logicalH)
    
    let clip = NSBezierPath(roundedRect: bounds, xRadius: 10.0, yRadius: 10.0)
    clip.addClip()
    // 垫一层实心底色，避免原图毛玻璃半透明通道在不同背景上产生阴影噪点
    let backdropColor = isDark
        ? NSColor(srgbRed: 0.16, green: 0.17, blue: 0.19, alpha: 1.0)
        : NSColor(srgbRed: 0.95, green: 0.96, blue: 0.97, alpha: 1.0)
    backdropColor.setFill()
    bounds.fill()
    sourceRep.draw(in: bounds)
    
    let strokeColor = isDark ? NSColor(white: 1.0, alpha: 0.18) : NSColor(white: 0.0, alpha: 0.12)
    strokeColor.setStroke()
    let stroke = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 10.0, yRadius: 10.0)
    stroke.lineWidth = 1.0
    stroke.stroke()
    
    NSGraphicsContext.restoreGraphicsState()
    return targetRep
}

// 合成 Hero 全景图（画布尺寸 2560 × 1440）
func composeHero(mainWin: NSBitmapImageRep, menuWin: NSBitmapImageRep, isDark: Bool) -> NSBitmapImageRep {
    let canvasW: Int = 2560
    let canvasH: Int = 1440
    let logicalW: CGFloat = 1280.0
    let logicalH: CGFloat = 720.0
    
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: canvasW,
        pixelsHigh: canvasH,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )!
    rep.size = NSSize(width: logicalW, height: logicalH)
    
    NSGraphicsContext.saveGraphicsState()
    let context = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = context
    let cg = context.cgContext
    
    // 背景渐变
    let bgColors: [CGColor]
    if isDark {
        bgColors = [
            NSColor(srgbRed: 0.09, green: 0.10, blue: 0.13, alpha: 1.0).cgColor,
            NSColor(srgbRed: 0.05, green: 0.06, blue: 0.08, alpha: 1.0).cgColor
        ]
    } else {
        bgColors = [
            NSColor(srgbRed: 0.94, green: 0.96, blue: 0.98, alpha: 1.0).cgColor,
            NSColor(srgbRed: 0.88, green: 0.91, blue: 0.94, alpha: 1.0).cgColor
        ]
    }
    let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: bgColors as CFArray, locations: [0.0, 1.0])!
    cg.drawLinearGradient(gradient, start: CGPoint(x: 0, y: logicalH), end: CGPoint(x: logicalW, y: 0), options: [])
    
    // 主窗口放置
    // 原始逻辑尺寸 1100x760，缩放到 880x608
    let mainScale: CGFloat = 0.80
    let mainW = 1100.0 * mainScale
    let mainH = 760.0 * mainScale
    let mainX: CGFloat = 50.0
    let mainY: CGFloat = (logicalH - mainH) / 2.0 - 15.0
    let mainRect = NSRect(x: mainX, y: mainY, width: mainW, height: mainH)
    
    // 主窗口阴影（仅对实心圆角背板投射阴影，避免半透明像素产生噪点）与绘制
    let mainCorner = 11.0 * mainScale
    let mainBackdrop = isDark
        ? NSColor(srgbRed: 0.12, green: 0.13, blue: 0.15, alpha: 1.0)
        : NSColor(srgbRed: 0.97, green: 0.98, blue: 0.99, alpha: 1.0)
    let mainPath = NSBezierPath(roundedRect: mainRect, xRadius: mainCorner, yRadius: mainCorner)
    cg.saveGState()
    let shadowColor = isDark ? NSColor(white: 0.0, alpha: 0.60).cgColor : NSColor(white: 0.0, alpha: 0.20).cgColor
    cg.setShadow(offset: CGSize(width: 0, height: -18), blur: 36, color: shadowColor)
    mainBackdrop.setFill()
    mainPath.fill()
    cg.restoreGState()

    cg.saveGState()
    mainPath.addClip()
    mainWin.draw(in: mainRect)
    cg.restoreGState()
    
    // 菜单栏面板放置在右下
    // 原始逻辑尺寸 396x644 (792x1288)，缩放到 316x515
    let menuScale: CGFloat = 0.80
    let menuW = (CGFloat(menuWin.pixelsWide) / 2.0) * menuScale
    let menuH = (CGFloat(menuWin.pixelsHigh) / 2.0) * menuScale
    let menuX: CGFloat = logicalW - menuW - 60.0
    let menuY: CGFloat = 60.0
    let menuRect = NSRect(x: menuX, y: menuY, width: menuW, height: menuH)
    
    // 菜单栏面板阴影（仅对实心圆角背板投射阴影）与绘制
    let menuCorner = 10.0 * menuScale
    let menuBackdrop = isDark
        ? NSColor(srgbRed: 0.16, green: 0.17, blue: 0.19, alpha: 1.0)
        : NSColor(srgbRed: 0.95, green: 0.96, blue: 0.97, alpha: 1.0)
    let menuPath = NSBezierPath(roundedRect: menuRect, xRadius: menuCorner, yRadius: menuCorner)
    cg.saveGState()
    let menuShadowColor = isDark ? NSColor(white: 0.0, alpha: 0.72).cgColor : NSColor(white: 0.0, alpha: 0.26).cgColor
    cg.setShadow(offset: CGSize(width: -6, height: -20), blur: 42, color: menuShadowColor)
    menuBackdrop.setFill()
    menuPath.fill()
    cg.restoreGState()

    cg.saveGState()
    menuPath.addClip()
    menuWin.draw(in: menuRect)
    cg.restoreGState()
    
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

// 主逻辑
print("== 开始生成超高清 Retina 实机截图与画廊资产 ==")

let pageNames = ["overview", "accounts", "usage", "settings", "about"]

// 1. 生成浅色模式主页面截图
var lightMainPages: [String: NSBitmapImageRep] = [:]
for (idx, name) in pageNames.enumerated() {
    let src = sourceDir.appendingPathComponent("light-1100x760-\(idx).png")
    if let rep = loadRep(from: src) {
        let polished = polishMainWindow(rep, isDark: false)
        let dest = targetDir.appendingPathComponent("\(name).png")
        try! savePNG(polished, to: dest)
        lightMainPages[name] = polished
        print("✓ 已生成 [Light] \(name).png (\(polished.pixelsWide)x\(polished.pixelsHigh))")
    }
}

// 2. 生成深色模式主页面截图
var darkMainPages: [String: NSBitmapImageRep] = [:]
for (idx, name) in pageNames.enumerated() {
    let src = sourceDir.appendingPathComponent("dark-1100x760-\(idx).png")
    if let rep = loadRep(from: src) {
        let polished = polishMainWindow(rep, isDark: true)
        let dest = targetDir.appendingPathComponent("dark-\(name).png")
        try! savePNG(polished, to: dest)
        darkMainPages[name] = polished
        print("✓ 已生成 [Dark] dark-\(name).png (\(polished.pixelsWide)x\(polished.pixelsHigh))")
    }
}

// 3. 生成菜单栏三标签面板截图 (Light & Dark)
let menuTabs = ["usage": "menubar", "quota": "menubar-quota", "accounts": "menubar-accounts"]
var lightMenuUsage: NSBitmapImageRep? = nil
var darkMenuUsage: NSBitmapImageRep? = nil

for (tab, outputName) in menuTabs {
    let lightSrc = sourceDir.appendingPathComponent("light-menu-panel-\(tab).png")
    if let rep = loadRep(from: lightSrc) {
        let polished = polishMenuPanel(rep, isDark: false)
        let dest = targetDir.appendingPathComponent("\(outputName).png")
        try! savePNG(polished, to: dest)
        if tab == "usage" { lightMenuUsage = polished }
        print("✓ 已生成 [Light] \(outputName).png (\(polished.pixelsWide)x\(polished.pixelsHigh))")
    }
    
    let darkSrc = sourceDir.appendingPathComponent("dark-menu-panel-\(tab).png")
    if let rep = loadRep(from: darkSrc) {
        let polished = polishMenuPanel(rep, isDark: true)
        let dest = targetDir.appendingPathComponent("dark-\(outputName).png")
        try! savePNG(polished, to: dest)
        if tab == "usage" { darkMenuUsage = polished }
        print("✓ 已生成 [Dark] dark-\(outputName).png (\(polished.pixelsWide)x\(polished.pixelsHigh))")
    }
}

// 4. 生成弹窗截图 (Maintenance Sheet)
if let rep = loadRep(from: sourceDir.appendingPathComponent("light-maintenance-sheet.png")) {
    let dest = targetDir.appendingPathComponent("maintenance.png")
    try! savePNG(rep, to: dest)
    print("✓ 已生成 [Light] maintenance.png (\(rep.pixelsWide)x\(rep.pixelsHigh))")
}
if let rep = loadRep(from: sourceDir.appendingPathComponent("dark-maintenance-sheet.png")) {
    let dest = targetDir.appendingPathComponent("dark-maintenance.png")
    try! savePNG(rep, to: dest)
    print("✓ 已生成 [Dark] dark-maintenance.png (\(rep.pixelsWide)x\(rep.pixelsHigh))")
}

// 5. 合成 Hero 全景图 (Light & Dark 2560x1440)
if let lightOverview = lightMainPages["overview"], let lightMenu = lightMenuUsage {
    let hero = composeHero(mainWin: lightOverview, menuWin: lightMenu, isDark: false)
    let dest = targetDir.appendingPathComponent("hero.png")
    try! savePNG(hero, to: dest)
    print("✓ 已合成 [Light] hero.png (\(hero.pixelsWide)x\(hero.pixelsHigh))")
}

if let darkOverview = darkMainPages["overview"], let darkMenu = darkMenuUsage {
    let heroDark = composeHero(mainWin: darkOverview, menuWin: darkMenu, isDark: true)
    let dest = targetDir.appendingPathComponent("hero-dark.png")
    try! savePNG(heroDark, to: dest)
    print("✓ 已合成 [Dark] hero-dark.png (\(heroDark.pixelsWide)x\(heroDark.pixelsHigh))")
}

print("== 全部超高清 Retina 实机截图与 Hero 画廊生成完成 ==")
