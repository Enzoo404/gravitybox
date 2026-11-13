import Cocoa
import QuartzCore
import OSLog

enum PerformanceSignpost {
    static let signposter = OSSignposter(subsystem: "local.gravitybox.app", category: "Performance")
    static func begin(_ name: StaticString) -> OSSignpostIntervalState {
        signposter.beginInterval(name, id: signposter.makeSignpostID())
    }
    static func end(_ name: StaticString, _ state: OSSignpostIntervalState) {
        signposter.endInterval(name, state)
    }
}

// The approved standalone preview is the visual contract. Native system surfaces keep OS behavior.
enum Design {
    /// Density roles, not a mandate to make menu cards and full pages equally spacious.
    enum Spacing {
        static let compact: CGFloat = 6
        static let standard: CGFloat = 12
        static let roomy: CGFloat = 14
        static let page: CGFloat = 10
    }
    enum Radius {
        static let card: CGFloat = 14
        static let medium: CGFloat = 12
        static let popover: CGFloat = 11
        static let compact: CGFloat = 10
    }
    static func shouldAnimate(in view: NSView?) -> Bool {
        #if NATIVE_UI_TEST
        return false
        #else
        return !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion && view?.window != nil
        #endif
    }
    static func color(_ light: UInt32, _ dark: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let n = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((n >> 16) & 255)/255, green: CGFloat((n >> 8) & 255)/255, blue: CGFloat(n & 255)/255, alpha: 1)
        }
    }
    static let background = color(0xF5F6F9, 0x1C1C1E)
    static let card = color(0xFFFFFF, 0x242428)
    static let subcard = color(0xEBEDF3, 0x2C2C31)
    static let track = color(0xE2E4EC, 0x38383E)
    static let primary = color(0x1D1D1F, 0xF2F2F7)
    static let text = primary
    static let secondary = color(0x6E6E73, 0x8E8E93)
    static let border = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor.white.withAlphaComponent(0.085)
            : NSColor.black.withAlphaComponent(0.068)
    }
    static func cardShadow() -> NSShadow {
        let shadow = NSShadow()
        shadow.shadowColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor.black.withAlphaComponent(0.32)
                : NSColor(srgbRed: 0.05, green: 0.07, blue: 0.14, alpha: 0.055)
        }
        shadow.shadowOffset = NSSize(width: 0, height: -2.0)
        shadow.shadowBlurRadius = 6.5
        return shadow
    }
    static func drawSpecularBevel(in rect: NSRect, cornerRadius: CGFloat, isDark: Bool) {
        let innerRect = rect.insetBy(dx: 0.5, dy: 0.5)
        guard innerRect.width > 2 && innerRect.height > 2 else { return }
        let r = max(1, cornerRadius - 0.5)
        guard let gctx = NSGraphicsContext.current else { return }
        let ctx = gctx.cgContext
        ctx.saveGState()
        let cgPath = CGPath(roundedRect: innerRect, cornerWidth: r, cornerHeight: r, transform: nil)
        ctx.addPath(cgPath)
        ctx.setLineWidth(isDark ? 0.65 : 0.75)
        ctx.replacePathWithStrokedPath()
        ctx.clip()

        let topColor = isDark
            ? NSColor.white.withAlphaComponent(0.145)
            : NSColor.white.withAlphaComponent(0.82)
        let midColor = isDark
            ? NSColor.white.withAlphaComponent(0.045)
            : NSColor.white.withAlphaComponent(0.35)
        let bottomColor = isDark
            ? NSColor.white.withAlphaComponent(0.015)
            : NSColor.white.withAlphaComponent(0.10)

        if let grad = NSGradient(colors: [topColor, midColor, bottomColor], atLocations: [0.0, 0.45, 1.0], colorSpace: .sRGB) {
            let isFlipped = gctx.isFlipped
            let startPt = NSPoint(x: innerRect.midX, y: isFlipped ? innerRect.minY : innerRect.maxY)
            let endPt = NSPoint(x: innerRect.midX, y: isFlipped ? innerRect.maxY : innerRect.minY)
            grad.draw(from: startPt, to: endPt, options: [])
        }
        ctx.restoreGState()
    }
    static let blue = color(0x0064DC, 0x0A84FF)
    static let activeBlue = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0.38, green: 0.68, blue: 1.0, alpha: 1.0)
            : blue
    }
    static let inactivePill = color(0x4A638C, 0x8CA6D6)
    static let inactivePillFill = NSColor(name: nil) {
        $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0.34, green: 0.52, blue: 0.84, alpha: 0.14)
            : NSColor(srgbRed: 0.918, green: 0.942, blue: 0.982, alpha: 0.95)
    }
    static let inactivePillBorder = NSColor(name: nil) {
        $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0.46, green: 0.66, blue: 0.96, alpha: 0.22)
            : NSColor(srgbRed: 0.24, green: 0.45, blue: 0.78, alpha: 0.18)
    }
    static let popoverCardBackground = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor.white.withAlphaComponent(0.07) : NSColor.white.withAlphaComponent(0.76) }
    static let popoverCardBorder = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor.white.withAlphaComponent(0.095) : NSColor.black.withAlphaComponent(0.07) }
    static let popoverFooterBackground = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor.white.withAlphaComponent(0.04) : NSColor.black.withAlphaComponent(0.025) }

    static func isInPopover(_ view: NSView?) -> Bool {
        var cur = view?.superview
        while let v = cur {
            if let vev = v as? NSVisualEffectView, vev.material == .popover { return true }
            cur = v.superview
        }
        return false
    }

    private static var cachedAppIcon: NSImage?
    private static var cachedBrandMark: NSImage?
    static func appIconImage() -> NSImage? {
        if let cached = cachedAppIcon { return cached }
        var candidates: [URL] = []
        if let res = Bundle.main.resourceURL {
            candidates.append(res.appendingPathComponent("AppIcon.icns"))
            candidates.append(res.appendingPathComponent("master-1024.png"))
        }
        if let envPath = ProcessInfo.processInfo.environment["GRAVITYBOX_UI_RESOURCES"] {
            let envURL = URL(fileURLWithPath: envPath)
            candidates.append(envURL.appendingPathComponent("AppIcon.icns"))
            candidates.append(envURL.appendingPathComponent("master-1024.png"))
        }
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        candidates.append(cwd.appendingPathComponent("assets/AppIcon.icns"))
        candidates.append(cwd.appendingPathComponent("assets/master-1024.png"))
        for url in candidates {
            if let img = NSImage(contentsOf: url) {
                img.isTemplate = false
                cachedAppIcon = img
                return img
            }
        }
        return NSApp?.applicationIconImage
    }

    /// Extracts the transparent rainbow double-arch mark from AppIcon without the white squircle background or white edge halo.
    static func brandMarkImage() -> NSImage? {
        if let cached = cachedBrandMark { return cached }
        guard let src = appIconImage() else { return nil }
        let dim = 256
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
        var pixels = [UInt8](repeating: 0, count: dim * dim * 4)
        let rendered: Bool = pixels.withUnsafeMutableBytes { ptr in
            guard let base = ptr.baseAddress,
                  let ctx = CGContext(data: base, width: dim, height: dim, bitsPerComponent: 8, bytesPerRow: dim * 4, space: colorSpace, bitmapInfo: bitmapInfo) else {
                return false
            }
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
            src.draw(in: NSRect(x: 0, y: 0, width: dim, height: dim), from: .zero, operation: .copy, fraction: 1.0)
            NSGraphicsContext.restoreGraphicsState()
            return true
        }
        guard rendered else { return src }

        let minBound = Int(Double(dim) * 0.19)
        let maxBound = Int(Double(dim) * 0.81)
        var cropMinX = dim, cropMinY = dim, cropMaxX = 0, cropMaxY = 0

        for y in 0..<dim {
            for x in 0..<dim {
                let idx = (y * dim + x) * 4
                guard x >= minBound && x <= maxBound && y >= minBound && y <= maxBound, pixels[idx + 3] > 200 else {
                    pixels[idx] = 0; pixels[idx + 1] = 0; pixels[idx + 2] = 0; pixels[idx + 3] = 0
                    continue
                }
                let r = Double(pixels[idx]) / 255.0
                let g = Double(pixels[idx + 1]) / 255.0
                let b = Double(pixels[idx + 2]) / 255.0
                let minC = min(r, min(g, b))
                let maxC = max(r, max(g, b))
                let sat = maxC - minC
                // White squircle background has minC > 0.93 and sat < 0.04; rainbow arch has strong color & lower minC.
                let rawAlpha = max((0.94 - minC) / 0.36, sat * 1.65)
                let alpha = min(1.0, max(0.0, rawAlpha))
                if alpha < 0.04 {
                    pixels[idx] = 0; pixels[idx + 1] = 0; pixels[idx + 2] = 0; pixels[idx + 3] = 0
                } else {
                    // Un-premultiply white background to eliminate any white fringe on dark backgrounds
                    let bgWeight = 1.0 - alpha
                    let pureR = min(1.0, max(0.0, (r - bgWeight) / alpha))
                    let pureG = min(1.0, max(0.0, (g - bgWeight) / alpha))
                    let pureB = min(1.0, max(0.0, (b - bgWeight) / alpha))
                    pixels[idx] = UInt8(round(pureR * alpha * 255.0))
                    pixels[idx + 1] = UInt8(round(pureG * alpha * 255.0))
                    pixels[idx + 2] = UInt8(round(pureB * alpha * 255.0))
                    pixels[idx + 3] = UInt8(round(alpha * 255.0))
                    if alpha > 0.12 {
                        if x < cropMinX { cropMinX = x }
                        if x > cropMaxX { cropMaxX = x }
                        if y < cropMinY { cropMinY = y }
                        if y > cropMaxY { cropMaxY = y }
                    }
                }
            }
        }

        let outImage: CGImage? = pixels.withUnsafeMutableBytes { ptr in
            guard let base = ptr.baseAddress,
                  let ctx = CGContext(data: base, width: dim, height: dim, bitsPerComponent: 8, bytesPerRow: dim * 4, space: colorSpace, bitmapInfo: bitmapInfo) else {
                return nil
            }
            return ctx.makeImage()
        }
        guard let fullCG = outImage else { return src }
        if cropMaxX > cropMinX && cropMaxY > cropMinY {
            let bw = cropMaxX - cropMinX + 1
            let bh = cropMaxY - cropMinY + 1
            let side = max(bw, bh) + 8
            let cx = (cropMinX + cropMaxX) / 2
            let cy = (cropMinY + cropMaxY) / 2
            let rx = max(0, min(dim - side, cx - side / 2))
            // CGImage cropping uses top-left origin whereas CGContext bitmap buffer row 0 is top
            let ry = max(0, min(dim - side, cy - side / 2))
            if let cropped = fullCG.cropping(to: CGRect(x: rx, y: ry, width: side, height: side)) {
                let result = NSImage(cgImage: cropped, size: NSSize(width: 64, height: 64))
                result.isTemplate = false
                cachedBrandMark = result
                return result
            }
        }
        let result = NSImage(cgImage: fullCG, size: NSSize(width: 64, height: 64))
        result.isTemplate = false
        cachedBrandMark = result
        return result
    }
    static func popUpOrigin(below anchor: NSView, spacing: CGFloat = 6) -> NSPoint {
        let yOffset = anchor.isFlipped ? (anchor.bounds.maxY + spacing) : (anchor.bounds.minY - spacing)
        return NSPoint(x: 0, y: yOffset)
    }

    static func popUpMenu(_ menu: NSMenu, below anchor: NSView, spacing: CGFloat = 6, matchAnchorWidth: Bool = false) {
        if matchAnchorWidth {
            menu.minimumWidth = max(menu.minimumWidth, anchor.bounds.width)
        }
        menu.popUp(positioning: nil, at: popUpOrigin(below: anchor, spacing: spacing), in: anchor)
    }

    static func applyControls(_ view: NSView) {
        if let popup = view as? NSPopUpButton {
            if !(popup.cell is DesignPopUpCell) {
                let menu = popup.menu, selected = popup.indexOfSelectedItem, target = popup.target, action = popup.action, enabled = popup.isEnabled
                let cell = DesignPopUpCell(textCell: "", pullsDown: popup.pullsDown)
                cell.menu = menu; popup.cell = cell; popup.selectItem(at: max(0, selected)); popup.target = target; popup.action = action; popup.isEnabled = enabled
                popup.invalidateIntrinsicContentSize()
            }
            popup.font = .systemFont(ofSize: 12); popup.isBordered = false
            popup.translatesAutoresizingMaskIntoConstraints = false
            if !popup.constraints.contains(where: { $0.identifier == "design-control-height" }) {
                let height = popup.heightAnchor.constraint(equalToConstant: 28); height.identifier = "design-control-height"; height.isActive = true
            }
            if !popup.constraints.contains(where: { $0.identifier == "design-control-width" }) {
                let titleWidth = (popup.title as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 12)]).width
                let width = popup.widthAnchor.constraint(greaterThanOrEqualToConstant: popup.pullsDown ? min(150, titleWidth+40) : 90); width.identifier = "design-control-width"; width.priority = .defaultHigh; width.isActive = true
            }
        } else if let field = view as? NSTextField, field.isEditable {
            if field.identifier?.rawValue == "native-percent-input" { field.font = .systemFont(ofSize:12); return }
            let currentFont = field.font ?? .systemFont(ofSize: 12)
            if !(field is NSSearchField), !(field is NSComboBox), !(field.cell is DesignTextCell), !(field.cell is DesignSecureCell) {
                let value = field.stringValue, placeholder = field.placeholderString, enabled = field.isEnabled
                let alignment = field.alignment, target = field.target, action = field.action
                let cell: NSTextFieldCell = field is NSSecureTextField ? DesignSecureCell(textCell: value) : DesignTextCell(textCell: value)
                cell.font = currentFont
                cell.alignment = alignment
                cell.placeholderString = placeholder
                cell.isEnabled = enabled
                cell.isEditable = true
                cell.isSelectable = true
                cell.usesSingleLineMode = true
                cell.wraps = false
                cell.isScrollable = true
                cell.sendsActionOnEndEditing = true
                cell.focusRingType = .none
                field.cell = cell
                field.stringValue = value
                field.alignment = alignment
                field.target = target
                field.action = action
                field.isEditable = true
                field.isSelectable = true
            }
            field.font = currentFont
            if !(field is NSSearchField) {
                field.isBezeled = false
                field.drawsBackground = false
                field.focusRingType = .none
                field.cell?.focusRingType = .none
            }
            if !field.constraints.contains(where: { $0.identifier == "design-input-height" }) {
                let height = field.heightAnchor.constraint(greaterThanOrEqualToConstant: 28); height.identifier = "design-input-height"; height.isActive = true
            }

        }
        for child in view.subviews { applyControls(child) }
    }
}

// MARK: - Global Motion Engine (Unified Curve & Timing Tokens, 120Hz CADisplayLink ProMotion, 0ms in NATIVE_UI_TEST / Reduce Motion)
final class DesignMotion: NSObject {
    enum Curve {
        case hover      // 130ms cubic-out
        case press      // 140ms snappy critically-damped tactile press/release
        case slide      // 180ms spring-out
        case expand     // 200ms ease-in-out
        case sweep      // 260ms cubic-out
        case spring     // 320ms ProMotion damped spring
        case breathe    // 1200ms gentle sinusoidal breathing pulse

        var duration: CFTimeInterval {
            switch self {
            case .hover: return 0.13
            case .press: return 0.14
            case .slide: return 0.18
            case .expand: return 0.20
            case .sweep: return 0.26
            case .spring: return 0.32
            case .breathe: return 1.20
            }
        }

        func evaluate(_ t: Double) -> CGFloat {
            let p = min(1.0, max(0.0, t))
            switch self {
            case .hover, .press, .sweep:
                return CGFloat(1.0 - pow(1.0 - p, 3.0))
            case .slide:
                return CGFloat(1.0 - pow(1.0 - p, 3.4))
            case .expand:
                return CGFloat(p < 0.5 ? 4.0 * p * p * p : 1.0 - pow(-2.0 * p + 2.0, 3.0) / 2.0)
            case .spring:
                return CGFloat(1.0 - exp(-6.0 * p) * cos(7.0 * p))
            case .breathe:
                return CGFloat(0.5 - 0.5 * cos(Double(p) * .pi))
            }
        }
    }

    private var timer: Timer?
    private var displayLink: CADisplayLink?
    private var startTime: CFTimeInterval = 0
    private var duration: CFTimeInterval = 0
    private var startVal: CGFloat = 0
    private var targetVal: CGFloat = 0
    private var activeCurve: Curve = .hover
    private var applyBlock: ((CGFloat) -> Void)?
    private var completionBlock: (() -> Void)?
    private weak var boundView: NSView?

    deinit {
        cancel()
    }

    func cancel() {
        displayLink?.invalidate()
        displayLink?.remove(from: .main, forMode: .common)
        displayLink = nil
        timer?.invalidate()
        timer = nil
        applyBlock = nil
        completionBlock = nil
    }

    func animate(in view: NSView?, from start: CGFloat, to target: CGFloat, curve: Curve = .hover, threshold: CGFloat = 0.01, apply: @escaping (CGFloat) -> Void, completion: (() -> Void)? = nil) {
        cancel()
        guard Design.shouldAnimate(in: view), abs(target - start) > threshold else {
            apply(target)
            completion?()
            return
        }
        self.boundView = view
        self.startVal = start
        self.targetVal = target
        self.activeCurve = curve
        self.applyBlock = apply
        self.completionBlock = completion
        self.startTime = CACurrentMediaTime()
        self.duration = curve.duration

        var linked = false
        if #available(macOS 14.0, *), let v = view {
            let link = v.displayLink(target: self, selector: #selector(handleDisplayLink(_:)))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
            link.add(to: .main, forMode: .common)
            self.displayLink = link
            linked = true
        } else if #available(macOS 14.0, *), let screen = NSScreen.main {
            let link = screen.displayLink(target: self, selector: #selector(handleDisplayLink(_:)))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
            link.add(to: .main, forMode: .common)
            self.displayLink = link
            linked = true
        }

        if !linked {
            let t = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in
                self?.stepAnimation()
            }
            timer = t
            RunLoop.main.add(t, forMode: .common)
        }
    }

    @objc private func handleDisplayLink(_ link: CADisplayLink) {
        stepAnimation()
    }

    private func stepAnimation() {
        guard Design.shouldAnimate(in: boundView) else {
            let finish = targetVal
            let comp = completionBlock
            let app = applyBlock
            cancel()
            app?(finish)
            comp?()
            return
        }
        let elapsed = CACurrentMediaTime() - startTime
        let progress = min(1.0, max(0.0, elapsed / duration))
        let eased = activeCurve.evaluate(progress)
        applyBlock?(startVal + (targetVal - startVal) * eased)
        if progress >= 1.0 {
            let comp = completionBlock
            let app = applyBlock
            let finish = targetVal
            cancel()
            app?(finish)
            comp?()
        }
    }
}

class DesignButton: NSButton {
    private var hoverTracking: NSTrackingArea?
    private let hoverMotion = DesignMotion()
    private let pressMotion = DesignMotion()
    private(set) var hoverProgress: CGFloat = 0
    private(set) var pressProgress: CGFloat = 0
    private var lastHighlighted = false
    var isQuietAccessory: Bool = false {
        didSet {
            guard oldValue != isQuietAccessory else { return }
            invalidateIntrinsicContentSize()
            needsDisplay = true
        }
    }

    var isActivitySpinning: Bool { showsSpinner }

    var hovered = false {
        didSet {
            guard oldValue != hovered else { return }
            let target: CGFloat = hovered ? 1.0 : 0.0
            hoverMotion.animate(in: self, from: hoverProgress, to: target, curve: .hover, threshold: 0.02) { [weak self] val in
                guard let self else { return }
                self.hoverProgress = val
                self.needsDisplay = true
            }
        }
    }
    override var isHighlighted: Bool {
        didSet {
            guard isHighlighted != lastHighlighted else { return }
            lastHighlighted = isHighlighted
            let target: CGFloat = isHighlighted ? 1.0 : 0.0
            pressMotion.animate(in: self, from: pressProgress, to: target, curve: .press, threshold: 0.01) { [weak self] val in
                guard let self else { return }
                self.pressProgress = val
                self.needsDisplay = true
            }
        }
    }
    override var allowsVibrancy: Bool { false }
    // The shared renderer owns keyboard focus; suppress AppKit's second bezel-shaped ring.
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        focusRingType = .none
        isBordered = false
        bezelStyle = .rounded
    }
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        focusRingType = .none
        isBordered = false
        bezelStyle = .rounded
    }
    deinit {
        hoverMotion.cancel()
        pressMotion.cancel()
        spinnerTimer?.invalidate()
        spinnerTimer = nil
    }
    override var wantsDefaultClipping: Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            hoverMotion.cancel()
            pressMotion.cancel()
            spinnerTimer?.invalidate()
            spinnerTimer = nil
            if hoverProgress != 0 { hoverProgress = 0 }
            if pressProgress != 0 { pressProgress = 0 }
        } else {
            syncSpinnerTimer()
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }
    override func mouseEntered(with event: NSEvent) { if isEnabled { hovered = true } }
    override func mouseExited(with event: NSEvent) { hovered = false }

    private var spinnerTimer: Timer?
    private var spinnerPhase: Int = 0

    let activitySpinner: NSProgressIndicator = {
        let s = NSProgressIndicator()
        s.style = .spinning
        s.controlSize = .small
        s.isDisplayedWhenStopped = false
        s.isHidden = true
        s.alphaValue = 0.001
        s.translatesAutoresizingMaskIntoConstraints = false
        return s
    }()

    private func syncSpinnerTimer() {
        spinnerTimer?.invalidate()
        spinnerTimer = nil
        guard showsSpinner, Design.shouldAnimate(in: self) else { return }
        let t = Timer(timeInterval: 1.0 / 12.0, repeats: true) { [weak self] _ in
            guard let self, self.showsSpinner else { return }
            self.spinnerPhase = (self.spinnerPhase + 1) % 8
            self.needsDisplay = true
        }
        RunLoop.main.add(t, forMode: .common)
        spinnerTimer = t
    }

    var showsSpinner: Bool = false {
        didSet {
            guard oldValue != showsSpinner else { return }
            if activitySpinner.superview == nil {
                addSubview(activitySpinner)
                NSLayoutConstraint.activate([
                    activitySpinner.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
                    activitySpinner.centerYAnchor.constraint(equalTo: centerYAnchor),
                    activitySpinner.widthAnchor.constraint(equalToConstant: 13),
                    activitySpinner.heightAnchor.constraint(equalToConstant: 13)
                ])
            }
            activitySpinner.isHidden = !showsSpinner
            if showsSpinner {
                spinnerPhase = 0
            }
            syncSpinnerTimer()
            invalidateIntrinsicContentSize()
            needsDisplay = true
        }
    }

    override var intrinsicContentSize: NSSize {
        if title.isEmpty, image != nil {
            return NSSize(width: isQuietAccessory ? 26 : 30, height: isQuietAccessory ? 26 : 28)
        }
        let width = (title as NSString).size(withAttributes: [.font: font ?? NSFont.systemFont(ofSize: 12, weight: .medium)]).width
        let iconExtra: CGFloat = (image != nil || showsSpinner) ? 18 : 0
        let pad: CGFloat = isQuietAccessory ? 16 : 24
        return NSSize(width: ceil(width) + pad + iconExtra, height: 28)
    }

    func drawButtonChromeAndLabel(spinnerLeftInset: CGFloat? = nil) {
        let primary = bezelColor != nil
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let inPopover = Design.isInPopover(self)
        let hp = isEnabled ? hoverProgress : 0
        let pp = isHighlighted ? max(pressProgress, 0.72) : pressProgress

        // 统一轻快按压回弹：悬停不越界放大、按压优雅内缩 2.5%、松手沿 140ms 阻尼干脆回弹（异步禁用态亦不截断释放动画）
        let scale: CGFloat = 1.0 - 0.025 * pp
        let gctx = NSGraphicsContext.current
        gctx?.saveGraphicsState()
        if abs(scale - 1.0) > 0.001, let cg = gctx?.cgContext {
            let cx = bounds.midX
            let cy = bounds.midY
            cg.translateBy(x: cx, y: cy)
            cg.scaleBy(x: scale, y: scale)
            cg.translateBy(x: -cx, y: -cy)
        }

        let rect = bounds.insetBy(dx: 1.0, dy: 1.0)
        let cornerR: CGFloat = 8.5
        let path = NSBezierPath(roundedRect: rect, xRadius: cornerR, yRadius: cornerR)

        if primary {
            let activeLook = isEnabled || isActivitySpinning
            let topBlue = activeLook
                ? Design.color(0x1A82FF, 0x389BFF).withAlphaComponent(1.0 - 0.12 * pp + 0.04 * hp)
                : Design.color(0x4CA0FF, 0x2B7AE0)
            let botBlue = activeLook
                ? Design.blue.withAlphaComponent(0.96 - 0.12 * pp)
                : Design.color(0x2E84EB, 0x1F68C9)
            if activeLook && !inPopover {
                NSGraphicsContext.saveGraphicsState()
                let btnShadow = NSShadow()
                btnShadow.shadowColor = Design.blue.withAlphaComponent(isDark ? 0.32 : 0.22)
                btnShadow.shadowOffset = NSSize(width: 0, height: -1.0)
                btnShadow.shadowBlurRadius = 2.5
                btnShadow.set()
                botBlue.setFill()
                path.fill()
                NSGraphicsContext.restoreGraphicsState()
            } else {
                botBlue.setFill()
                path.fill()
            }
            if let grad = NSGradient(starting: topBlue, ending: botBlue) {
                grad.draw(in: path, angle: 90)
            }
            Design.drawSpecularBevel(in: rect, cornerRadius: cornerR, isDark: true)
        } else if inPopover {
            // Pure translucent glass overlay that blends with the popover's vibrant wallpaper tint in both Light and Dark mode.
            let enableScale: CGFloat = isEnabled ? 1.0 : 0.45
            let fillColor: NSColor
            let borderColor: NSColor
            if isDark {
                let fillAlpha: CGFloat = (isHighlighted ? 0.15 : (0.08 + 0.05 * hp)) * enableScale
                let strokeAlpha: CGFloat = (0.10 + 0.06 * hp) * enableScale
                fillColor = NSColor.white.withAlphaComponent(fillAlpha)
                borderColor = NSColor.white.withAlphaComponent(strokeAlpha)
            } else {
                let fillAlpha: CGFloat = (isHighlighted ? 0.62 : (0.76 + 0.14 * hp)) * enableScale
                let strokeAlpha: CGFloat = (0.065 + 0.045 * hp) * enableScale
                fillColor = NSColor.white.withAlphaComponent(fillAlpha)
                borderColor = NSColor.black.withAlphaComponent(strokeAlpha)
            }
            fillColor.setFill()
            path.fill()
            borderColor.setStroke()
            path.lineWidth = 0.8
            path.stroke()
            if isEnabled {
                Design.drawSpecularBevel(in: rect, cornerRadius: cornerR, isDark: isDark)
            }
        } else if isQuietAccessory {
            let activeHighlight = max(hp, pp)
            if isEnabled && activeHighlight > 0.01 {
                let fill = isDark
                    ? NSColor.white.withAlphaComponent(0.10 * hp + 0.06 * pp)
                    : NSColor.black.withAlphaComponent(0.055 * hp + 0.04 * pp)
                fill.setFill()
                NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 7, yRadius: 7).fill()
            }
        } else {
            // 主窗口轻玻璃立体胶囊按钮（与左侧毛玻璃导航栏和菜单栏质感拉齐）
            let enableScale: CGFloat = isEnabled ? 1.0 : (isActivitySpinning ? 0.88 : 0.45)
            NSGraphicsContext.saveGraphicsState()
            if isEnabled || isActivitySpinning {
                let btnShadow = NSShadow()
                btnShadow.shadowColor = isDark
                    ? NSColor.black.withAlphaComponent(0.32 * (1.0 - 0.5 * pp))
                    : NSColor(srgbRed: 0.05, green: 0.08, blue: 0.16, alpha: (0.075 + 0.03 * hp) * (1.0 - 0.5 * pp))
                btnShadow.shadowOffset = NSSize(width: 0, height: -1.0)
                btnShadow.shadowBlurRadius = 2.2
                btnShadow.set()
            }
            let baseFill = isDark
                ? NSColor.white.withAlphaComponent((0.095 + 0.045 * hp - 0.025 * pp) * enableScale)
                : NSColor(srgbRed: 0.965, green: 0.972, blue: 0.988, alpha: (0.92 + 0.06 * hp - 0.06 * pp) * enableScale)
            baseFill.setFill()
            path.fill()
            NSGraphicsContext.restoreGraphicsState()

            let topGlass = isDark
                ? NSColor.white.withAlphaComponent((0.13 + 0.05 * hp - 0.03 * pp) * enableScale)
                : NSColor.white.withAlphaComponent((0.96 + 0.04 * hp - 0.08 * pp) * enableScale)
            let botGlass = isDark
                ? NSColor.white.withAlphaComponent((0.07 + 0.035 * hp - 0.02 * pp) * enableScale)
                : NSColor(srgbRed: 0.935, green: 0.945, blue: 0.970, alpha: (0.86 + 0.06 * hp) * enableScale)
            if let grad = NSGradient(starting: topGlass, ending: botGlass) {
                grad.draw(in: path, angle: 90)
            }
            if isEnabled && hp > 0.01 {
                Design.blue.withAlphaComponent((isDark ? 0.08 : 0.045) * hp).setFill()
                path.fill()
            }
            let strokeColor: NSColor
            if isEnabled && hp > 0.05 {
                strokeColor = isDark
                    ? NSColor.white.withAlphaComponent(0.14 + 0.08 * hp)
                    : Design.blue.withAlphaComponent(0.18 * hp + 0.08 * (1.0 - hp))
            } else {
                strokeColor = isDark
                    ? NSColor.white.withAlphaComponent(0.12 * enableScale)
                    : NSColor.black.withAlphaComponent(0.085 * enableScale)
            }
            strokeColor.setStroke()
            path.lineWidth = 0.75
            path.stroke()
            if isEnabled {
                Design.drawSpecularBevel(in: rect, cornerRadius: cornerR, isDark: isDark)
            }
        }

        let fgAlpha: CGFloat = primary ? ((isEnabled || isActivitySpinning) ? 1.0 : 0.88) : (isEnabled ? 1.0 : (isActivitySpinning ? 0.86 : 0.42))
        let baseFg: NSColor = primary ? .white : (isQuietAccessory ? (hp > 0.25 ? Design.primary : Design.secondary) : Design.primary)
        let fgColor = baseFg.withAlphaComponent(fgAlpha)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: 12, weight: .medium),
            .foregroundColor: fgColor
        ]

        let resolvedSpinnerInset = spinnerLeftInset ?? (showsSpinner ? 24 : nil)
        if showsSpinner {
            let cx: CGFloat = 16.5
            let cy: CGFloat = bounds.midY
            let innerR: CGFloat = 2.6
            let outerR: CGFloat = 5.6
            let spokeAlphas: [CGFloat] = [0.98, 0.82, 0.66, 0.52, 0.38, 0.28, 0.20, 0.14]
            let baseSpokeColor = primary ? NSColor.white : Design.primary
            for i in 0..<8 {
                let angle = CGFloat(i) * (.pi / 4.0) - (.pi / 2.0)
                let relIdx = (i - spinnerPhase + 8) % 8
                let alpha = spokeAlphas[relIdx]
                let p1 = NSPoint(x: cx + cos(angle) * innerR, y: cy + sin(angle) * innerR)
                let p2 = NSPoint(x: cx + cos(angle) * outerR, y: cy + sin(angle) * outerR)
                let spoke = NSBezierPath()
                spoke.move(to: p1)
                spoke.line(to: p2)
                spoke.lineWidth = 1.45
                spoke.lineCapStyle = .round
                baseSpokeColor.withAlphaComponent(alpha).setStroke()
                spoke.stroke()
            }
        }
        if let leftInset = resolvedSpinnerInset {
            let style = NSMutableParagraphStyle(); style.alignment = .center
            var centeredAttrs = attrs; centeredAttrs[.paragraphStyle] = style
            let size = (title as NSString).size(withAttributes: centeredAttrs)
            let rightInset: CGFloat = 6
            (title as NSString).draw(
                in: NSRect(x: leftInset, y: (bounds.height - size.height) / 2, width: max(0, bounds.width - leftInset - rightInset), height: size.height),
                withAttributes: centeredAttrs
            )
        } else if let img = image {
            let textSize = title.isEmpty ? .zero : (title as NSString).size(withAttributes: attrs)
            let maxBox: CGFloat = title.isEmpty ? 14.0 : 13.0
            let rawSize = img.size
            let iconW: CGFloat
            let iconH: CGFloat
            if rawSize.width > 0 && rawSize.height > 0 {
                let scale = min(maxBox / rawSize.width, maxBox / rawSize.height)
                iconW = max(3.5, round(rawSize.width * scale * 2.0) / 2.0)
                iconH = max(3.5, round(rawSize.height * scale * 2.0) / 2.0)
            } else {
                iconW = maxBox
                iconH = maxBox
            }
            let gap: CGFloat = title.isEmpty ? 0 : 5
            let totalW = iconW + gap + textSize.width
            let startX = title.isEmpty ? (bounds.width - iconW) / 2 : max(8, (bounds.width - totalW) / 2)
            let iconRect = NSRect(x: startX, y: (bounds.height - iconH) / 2, width: iconW, height: iconH)
            if img.isTemplate, let tinted = img.copy() as? NSImage {
                tinted.lockFocus()
                fgColor.set()
                NSRect(origin: .zero, size: tinted.size).fill(using: .sourceAtop)
                tinted.unlockFocus()
                tinted.draw(in: iconRect, from: .zero, operation: .sourceOver, fraction: 1.0, respectFlipped: true, hints: [.interpolation: NSNumber(value: NSImageInterpolation.high.rawValue)])
            } else {
                img.draw(in: iconRect, from: .zero, operation: .sourceOver, fraction: 1.0, respectFlipped: true, hints: [.interpolation: NSNumber(value: NSImageInterpolation.high.rawValue)])
            }
            if !title.isEmpty {
                (title as NSString).draw(at: NSPoint(x: startX + iconW + gap, y: (bounds.height - textSize.height) / 2), withAttributes: attrs)
            }
        } else {
            let textSize = (title as NSString).size(withAttributes: attrs)
            let style = NSMutableParagraphStyle(); style.alignment = .center
            var centeredAttrs = attrs; centeredAttrs[.paragraphStyle] = style
            (title as NSString).draw(in: NSRect(x: 6, y: (bounds.height - textSize.height) / 2, width: bounds.width - 12, height: textSize.height), withAttributes: centeredAttrs)
        }
        if window?.firstResponder === self { Design.blue.setStroke(); path.lineWidth = 2; path.stroke() }
        gctx?.restoreGraphicsState()
    }

    override func draw(_ dirtyRect: NSRect) {
        drawButtonChromeAndLabel(spinnerLeftInset: nil)
    }
}

final class DesignSurface: NSView {
    let color: NSColor
    init(_ color: NSColor) { self.color = color; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }
    override var isOpaque: Bool { true }
    override var allowsVibrancy: Bool { false }
    override var wantsDefaultClipping: Bool { true }
    override func draw(_ dirtyRect: NSRect) { color.setFill(); bounds.fill() }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); Design.applyControls(self); needsDisplay = true }
}

final class MetricCardBox: NSBox {
    weak var clickTarget: AnyObject?
    var clickAction: Selector?
    var metricTitle: String = ""
    weak var titleField: NSTextField?
    weak var valueField: NSTextField?
    weak var detailField: NSTextField?
    weak var chevronView: NSImageView?
    private var hoverTracking: NSTrackingArea?
    private let hoverMotion = DesignMotion()
    private var hoverProgress: CGFloat = 0
    override var allowsVibrancy: Bool { false }
    var hovered = false {
        didSet {
            guard oldValue != hovered, clickTarget != nil, clickAction != nil else { return }
            let target: CGFloat = hovered ? 1.0 : 0.0
            hoverMotion.animate(in: self, from: hoverProgress, to: target, curve: .hover, threshold: 0.04) { [weak self] val in
                guard let self else { return }
                self.hoverProgress = val
                self.borderColor = val > 0.02 ? Design.blue.withAlphaComponent(0.12 + 0.36 * val) : Design.border
                self.chevronView?.contentTintColor = val > 0.5 ? Design.blue : Design.secondary.withAlphaComponent(0.55)
                self.needsDisplay = true
            }
        }
    }

    override var acceptsFirstResponder: Bool { clickTarget != nil && clickAction != nil }
    override var canBecomeKeyView: Bool { clickTarget != nil && clickAction != nil }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        guard clickTarget != nil && clickAction != nil else { return }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }
    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }

    func refreshAccessibility() {
        let val = valueField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let det = detailField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let label = val.isEmpty ? metricTitle : "\(metricTitle)，\(val)"
        setAccessibilityLabel(label)
        setAccessibilityValue(det.isEmpty ? val : "\(val) · \(det)")
    }

    override func accessibilityLabel() -> String? {
        let val = valueField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !metricTitle.isEmpty {
            return val.isEmpty ? metricTitle : "\(metricTitle)，\(val)"
        }
        return super.accessibilityLabel()
    }

    override func accessibilityValue() -> Any? {
        let val = valueField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let det = detailField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !val.isEmpty || !det.isEmpty {
            return det.isEmpty ? val : "\(val) · \(det)"
        }
        return super.accessibilityValue()
    }

    override func keyDown(with event: NSEvent) {
        if let target = clickTarget, let action = clickAction, (event.keyCode == 36 || event.keyCode == 49) { // Return or Space
            NSApp.sendAction(action, to: target, from: self)
            return
        }
        super.keyDown(with: event)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        Design.drawSpecularBevel(in: bounds, cornerRadius: cornerRadius, isDark: isDark)
    }

    override func drawFocusRingMask() {
        let path = NSBezierPath(roundedRect: bounds, xRadius: cornerRadius, yRadius: cornerRadius)
        path.fill()
    }

    override var focusRingMaskBounds: NSRect { bounds }
}

// MARK: - A01: KPI detail line
// A real-data detail string ("累计 Token 用量 1.1B（统计 30/331 库）· 部分库异常") must not
// contribute to the window's minimum width. This label therefore has no intrinsic width:
// it fills the card, truncates with an ellipsis, and keeps the full copy in its tooltip
// (the accessibility value still exposes the complete stringValue).
final class MetricDetailField: NSTextField {
    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: super.intrinsicContentSize.height)
    }
    override var stringValue: String {
        get { super.stringValue }
        set {
            super.stringValue = newValue
            toolTip = nil
        }
    }
    func configureAsMetricDetail() {
        font = .systemFont(ofSize: 11)
        textColor = Design.secondary
        isEditable = false
        isSelectable = false
        isBezeled = false
        drawsBackground = false
        maximumNumberOfLines = 1
        lineBreakMode = .byTruncatingTail
        cell?.wraps = false
        cell?.isScrollable = false
        cell?.truncatesLastVisibleLine = true
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        setContentHuggingPriority(.defaultLow, for: .horizontal)
    }
}

func metricDetail(_ value: String) -> MetricDetailField {
    let field = MetricDetailField(labelWithString: value)
    field.configureAsMetricDetail()
    field.toolTip = nil
    return field
}

func compactMetric(_ title: String, value: NSTextField, detail: NSTextField, action: NSButton? = nil, target: AnyObject? = nil, onClick: Selector? = nil) -> NSBox {
    value.font = .monospacedDigitSystemFont(ofSize: 26, weight: .bold)
    detail.font = .systemFont(ofSize: 11)
    detail.textColor = Design.secondary
    detail.maximumNumberOfLines = 2
    detail.lineBreakMode = .byWordWrapping
    detail.cell?.wraps = true
    detail.cell?.isScrollable = false
    detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    detail.setContentHuggingPriority(.defaultLow, for: .horizontal)
    detail.toolTip = nil

    let (symbolName, badgeTint): (String, NSColor) = {
        if title.contains("Token") {
            return ("sparkles", Design.blue)
        } else if title.contains("费用") {
            return ("dollarsign.circle.fill", .systemTeal)
        } else if title.contains("请求") {
            return ("paperplane.fill", .systemIndigo)
        } else {
            return ("chart.bar.fill", Design.blue)
        }
    }()
    let badgeBox = NSBox()
    badgeBox.boxType = .custom
    badgeBox.cornerRadius = 6
    badgeBox.fillColor = NSColor(name: nil) { app in
        let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        return badgeTint.withAlphaComponent(isDark ? 0.18 : 0.10)
    }
    badgeBox.borderWidth = 0.5
    badgeBox.borderColor = NSColor(name: nil) { app in
        let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        return badgeTint.withAlphaComponent(isDark ? 0.30 : 0.16)
    }
    badgeBox.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        badgeBox.widthAnchor.constraint(equalToConstant: 22),
        badgeBox.heightAnchor.constraint(equalToConstant: 22)
    ])
    let badgeIcon = symbol(symbolName, size: 11.5, color: badgeTint)
    badgeIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
    badgeBox.addSubview(badgeIcon)
    NSLayoutConstraint.activate([
        badgeIcon.centerXAnchor.constraint(equalTo: badgeBox.centerXAnchor),
        badgeIcon.centerYAnchor.constraint(equalTo: badgeBox.centerYAnchor)
    ])
    badgeBox.setAccessibilityElement(false)

    let heading = text(title, size: 12, weight: .medium, color: Design.secondary)
    let headingGroup = horizontal([badgeBox, heading], spacing: 6)
    headingGroup.alignment = .centerY
    var chevron: NSImageView?
    let topRow: NSView
    if target != nil && onClick != nil {
        let icon = symbol("chevron.right", size: 10, color: Design.secondary.withAlphaComponent(0.55))
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 9.5, weight: .semibold)
        chevron = icon
        let headerRow = horizontal([headingGroup, flexibleSpace(), icon], spacing: 4)
        headerRow.alignment = .centerY
        topRow = headerRow
    } else {
        topRow = headingGroup
    }
    let rows: [NSView] = [topRow, value, detail] + (action.map { [$0] } ?? [])
    let content = vertical(rows, spacing: 6)
    for row in rows { fillWidth(row, in: content) }
    let card = MetricCardBox()
    card.metricTitle = title
    card.titleField = heading
    card.valueField = value
    card.detailField = detail
    card.chevronView = chevron
    card.boxType = .custom
    card.borderWidth = 0.5
    card.cornerRadius = Design.Radius.card
    card.fillColor = Design.card
    card.borderColor = Design.border
    card.shadow = Design.cardShadow()
    card.contentViewMargins = .zero
    card.addSubview(content)
    content.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        content.leadingAnchor.constraint(equalTo:card.leadingAnchor,constant:16),
        content.trailingAnchor.constraint(equalTo:card.trailingAnchor,constant:-16),
        content.centerYAnchor.constraint(equalTo:card.centerYAnchor),
        content.topAnchor.constraint(greaterThanOrEqualTo:card.topAnchor,constant:12),
        content.bottomAnchor.constraint(lessThanOrEqualTo:card.bottomAnchor,constant:-12)
    ])
    if let target, let onClick {
        card.clickTarget = target
        card.clickAction = onClick
        card.focusRingType = .exterior
        card.setAccessibilityElement(true)
        card.setAccessibilityRole(.button)
        card.refreshAccessibility()
        let gesture = NSClickGestureRecognizer(target: target, action: onClick)
        card.addGestureRecognizer(gesture)
    } else {
        card.setAccessibilityElement(true)
        card.setAccessibilityRole(.group)
        card.refreshAccessibility()
    }
    return card
}

// Legacy NSMenu menu quota components retired in favor of MenuPanelController.

final class DesignPopUpCell: NSPopUpButtonCell {
    private func presentMenuBelow(_ controlView: NSView) {
        guard isEnabled, let menu, !menu.items.isEmpty else { return }
        synchronizeTitleAndSelectedItem()
        isHighlighted = true
        controlView.needsDisplay = true
        Design.popUpMenu(menu, below: controlView, matchAnchorWidth: true)
        isHighlighted = false
        controlView.needsDisplay = true
    }

    override func trackMouse(with event: NSEvent, in cellFrame: NSRect, of controlView: NSView, untilMouseUp flag: Bool) -> Bool {
        guard isEnabled else { return false }
        presentMenuBelow(controlView)
        return true
    }

    override func performClick(withFrame cellFrame: NSRect, in controlView: NSView) {
        presentMenuBelow(controlView)
    }

    override func draw(withFrame cellFrame: NSRect, in controlView: NSView) {
        let focused = controlView.window?.firstResponder === controlView
        let insetRect = cellFrame.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: insetRect, xRadius: 7.5, yRadius: 7.5)
        let isDark = controlView.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let fill = isHighlighted
            ? (isDark ? NSColor(white: 0.24, alpha: 1.0) : Design.color(0xE1E4EC, 0x242428))
            : Design.subcard
        fill.setFill()
        path.fill()
        if focused {
            Design.blue.setStroke()
            path.lineWidth = 1.5
            path.stroke()
        } else {
            Design.border.setStroke()
            path.lineWidth = 1
            path.stroke()
        }
        let titleRect = NSRect(x: cellFrame.minX + 10, y: cellFrame.midY - 7, width: max(0, cellFrame.width - 32), height: 16)
        let style = NSMutableParagraphStyle(); style.lineBreakMode = .byTruncatingTail
        (title as NSString).draw(in: titleRect, withAttributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: .medium),
            .foregroundColor: isEnabled ? Design.primary : Design.secondary,
            .paragraphStyle: style
        ])
        // Crisp macOS dual-chevron (up/down) pop-up indicator
        let cx = cellFrame.maxX - 13
        let cy = cellFrame.midY
        let chev = NSBezierPath()
        // Up chevron (in flipped controlView coordinates, y decreases upwards)
        chev.move(to: NSPoint(x: cx - 3.2, y: cy - 1.4))
        chev.line(to: NSPoint(x: cx, y: cy - 4.4))
        chev.line(to: NSPoint(x: cx + 3.2, y: cy - 1.4))
        // Down chevron
        chev.move(to: NSPoint(x: cx - 3.2, y: cy + 1.4))
        chev.line(to: NSPoint(x: cx, y: cy + 4.4))
        chev.line(to: NSPoint(x: cx + 3.2, y: cy + 1.4))
        chev.lineWidth = 1.35
        chev.lineCapStyle = .round
        chev.lineJoinStyle = .round
        (focused ? Design.blue : Design.secondary).setStroke()
        chev.stroke()
    }
    override func cellSize(forBounds rect: NSRect) -> NSSize {
        NSSize(width: max(90, super.cellSize(forBounds: rect).width+12), height: 28)
    }
}

func identityHeader(identity: NSView, actions: NSView) -> NSView {
    let container = NSView(); container.identifier = NSUserInterfaceItemIdentifier("account-identity-header"); actions.identifier = NSUserInterfaceItemIdentifier("account-actions")
    for child in [identity, actions] { child.translatesAutoresizingMaskIntoConstraints = false; container.addSubview(child) }
    container.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        container.heightAnchor.constraint(greaterThanOrEqualToConstant: 36),
        identity.trailingAnchor.constraint(equalTo: actions.leadingAnchor, constant: -12), identity.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        identity.topAnchor.constraint(greaterThanOrEqualTo: container.topAnchor), identity.bottomAnchor.constraint(lessThanOrEqualTo: container.bottomAnchor),
        actions.trailingAnchor.constraint(equalTo: container.trailingAnchor), actions.centerYAnchor.constraint(equalTo: container.centerYAnchor)
    ])
    let identityHeight = container.heightAnchor.constraint(equalTo: identity.heightAnchor)
    identityHeight.priority = .defaultHigh; identityHeight.isActive = true
    identity.leadingAnchor.constraint(equalTo: container.leadingAnchor).isActive = true
    if let stack = actions as? NSStackView {
        let width = stack.arrangedSubviews.reduce(CGFloat(0)) { $0 + max(0, $1.intrinsicContentSize.width) } + CGFloat(max(0, stack.arrangedSubviews.count-1)) * stack.spacing
        stack.widthAnchor.constraint(equalToConstant: width).isActive = true
    }
    actions.setContentHuggingPriority(.required, for: .horizontal)
    actions.setContentCompressionResistancePriority(.required, for: .horizontal)
    return container
}

func drawInput(_ rect: NSRect, focused: Bool = false) {
    let insetRect = rect.insetBy(dx: 1.5, dy: 1.5)
    let path = NSBezierPath(roundedRect: insetRect, xRadius: 6, yRadius: 6)
    Design.color(0xFFFFFF, 0x2C2C2E).setFill()
    path.fill()
    if focused {
        NSGraphicsContext.current?.saveGraphicsState()
        let glowRect = rect.insetBy(dx: 0.5, dy: 0.5)
        let glowPath = NSBezierPath(roundedRect: glowRect, xRadius: 7, yRadius: 7)
        Design.blue.withAlphaComponent(0.24).setStroke()
        glowPath.lineWidth = 2.0
        glowPath.stroke()
        let borderPath = NSBezierPath(roundedRect: insetRect, xRadius: 6, yRadius: 6)
        Design.blue.setStroke()
        borderPath.lineWidth = 1.25
        borderPath.stroke()
        NSGraphicsContext.current?.restoreGraphicsState()
    } else {
        Design.border.setStroke()
        path.lineWidth = 1
        path.stroke()
    }
}
private func inputTextRect(_ rect: NSRect, font: NSFont? = nil) -> NSRect {
    let f = font ?? .systemFont(ofSize: 12)
    let height = ceil(f.ascender - f.descender + f.leading)
    return NSRect(x: rect.minX + 6, y: rect.midY - height / 2, width: max(0, rect.width - 12), height: height)
}
final class DesignTextCell: NSTextFieldCell {
    override func draw(withFrame rect: NSRect, in view: NSView) {
        let focused = (view as? NSTextField)?.currentEditor() != nil
        drawInput(rect, focused: focused)
        guard !focused else { return }
        let style = NSMutableParagraphStyle()
        style.alignment = alignment
        style.lineBreakMode = .byTruncatingTail
        let display = stringValue.isEmpty ? (placeholderString ?? "") : stringValue
        guard !display.isEmpty else { return }
        let color: NSColor = stringValue.isEmpty ? Design.secondary : (isEnabled ? NSColor.labelColor : Design.secondary)
        (display as NSString).draw(in: inputTextRect(rect, font: font), withAttributes: [
            .font: font ?? .systemFont(ofSize: 12),
            .foregroundColor: color,
            .paragraphStyle: style
        ])
    }
    override func edit(withFrame rect: NSRect, in view: NSView, editor: NSText, delegate: Any?, event: NSEvent?) {
        let textRect = inputTextRect(rect, font: font)
        editor.alignment = alignment
        if let tv = editor as? NSTextView {
            tv.drawsBackground = false
            tv.textContainerInset = .zero
            tv.textContainer?.lineFragmentPadding = 0
        }
        super.edit(withFrame: textRect, in: view, editor: editor, delegate: delegate, event: event)
    }
    override func select(withFrame rect: NSRect, in view: NSView, editor: NSText, delegate: Any?, start: Int, length: Int) {
        let textRect = inputTextRect(rect, font: font)
        editor.alignment = alignment
        if let tv = editor as? NSTextView {
            tv.drawsBackground = false
            tv.textContainerInset = .zero
            tv.textContainer?.lineFragmentPadding = 0
        }
        super.select(withFrame: textRect, in: view, editor: editor, delegate: delegate, start: start, length: length)
    }
}
final class DesignSecureCell: NSSecureTextFieldCell {
    override func draw(withFrame rect: NSRect, in view: NSView) {
        let focused = (view as? NSTextField)?.currentEditor() != nil
        drawInput(rect, focused: focused)
        super.drawInterior(withFrame: inputTextRect(rect, font: font), in: view)
    }
    override func edit(withFrame rect: NSRect, in view: NSView, editor: NSText, delegate: Any?, event: NSEvent?) {
        super.edit(withFrame: inputTextRect(rect, font: font), in: view, editor: editor, delegate: delegate, event: event)
    }
    override func select(withFrame rect: NSRect, in view: NSView, editor: NSText, delegate: Any?, start: Int, length: Int) {
        super.select(withFrame: inputTextRect(rect, font: font), in: view, editor: editor, delegate: delegate, start: start, length: length)
    }
}

// Shared feedback for quota actions in the dashboard and account cards.
final class QuotaRefreshButton: DesignButton {
    let spinner = NSProgressIndicator()
    var localBusy = false
    var lastError: String?
    private var appliedDisplayState: (busy: Bool, available: Bool, error: String)?
    override var isActivitySpinning: Bool { !spinner.isHidden }
    override var intrinsicContentSize: NSSize { NSSize(width: 88, height: 28) }
    init(target: AnyObject?, action: Selector) {
        super.init(frame: .zero); title = "刷新配额"; self.target = target; self.action = action
        bezelStyle = .rounded; isBordered = false; font = .systemFont(ofSize: 12, weight: .medium)
        spinner.style = .spinning; spinner.controlSize = .small; spinner.isDisplayedWhenStopped = false; spinner.isHidden = true
        spinner.translatesAutoresizingMaskIntoConstraints = false; addSubview(spinner)
        NSLayoutConstraint.activate([spinner.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),spinner.centerYAnchor.constraint(equalTo: centerYAnchor),spinner.widthAnchor.constraint(equalToConstant: 13),spinner.heightAnchor.constraint(equalToConstant: 13)])
        setAccessibilityLabel("刷新配额")
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ dirtyRect: NSRect) {
        drawButtonChromeAndLabel(spinnerLeftInset: spinner.isHidden ? 6 : 22)
    }
    func setRefreshState(busy: Bool, available: Bool, error: String?) {
        localBusy = busy
        lastError = error
        applyDisplayState(busy: busy, available: available, error: error)
    }
    func applyGlobalRefreshState(globalBusy: Bool, available: Bool, error: String?, cardBusy: Bool = false) {
        let effectiveBusy = globalBusy || localBusy || cardBusy
        let effectiveError = lastError ?? error
        applyDisplayState(busy: effectiveBusy, available: available, error: effectiveError)
    }
    private func applyDisplayState(busy: Bool, available: Bool, error: String?) {
        let normalizedError = error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let prev = appliedDisplayState, prev.busy == busy && prev.available == available && prev.error == normalizedError {
            return
        }
        appliedDisplayState = (busy: busy, available: available, error: normalizedError)
        isEnabled = available && !busy
        if spinner.isHidden != !busy {
            spinner.isHidden = !busy
            if busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        }
        toolTip = nil
        setAccessibilityHelp(!normalizedError.isEmpty ? ("刷新未完成：" + normalizedError) : (busy ? "正在刷新配额" : "刷新账号配额"))
        needsDisplay = true
    }
}

// Fixed-width inline refresh button with embedded spinner (keeps button text and width constant so sibling controls never shift).
final class InlineRefreshButton: DesignButton {
    let spinner = NSProgressIndicator()
    let fixedWidth: CGFloat
    private(set) var isBusy = false
    private var appliedBusyState: (busy: Bool, available: Bool)?
    override var isActivitySpinning: Bool { !spinner.isHidden }
    override var intrinsicContentSize: NSSize { NSSize(width: fixedWidth, height: 28) }
    init(_ buttonTitle: String = "刷新", width: CGFloat = 68, target: AnyObject? = nil, action: Selector) {
        self.fixedWidth = width
        super.init(frame: .zero)
        title = buttonTitle
        self.target = target
        self.action = action
        bezelStyle = .rounded
        isBordered = false
        font = .systemFont(ofSize: 12, weight: .medium)
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.isHidden = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            spinner.centerYAnchor.constraint(equalTo: centerYAnchor),
            spinner.widthAnchor.constraint(equalToConstant: 13),
            spinner.heightAnchor.constraint(equalToConstant: 13)
        ])
        setAccessibilityLabel(buttonTitle)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ dirtyRect: NSRect) {
        drawButtonChromeAndLabel(spinnerLeftInset: spinner.isHidden ? 6 : 22)
    }
    func setBusy(_ busy: Bool, available: Bool = true) {
        if let prev = appliedBusyState, prev.busy == busy && prev.available == available {
            return
        }
        appliedBusyState = (busy: busy, available: available)
        isBusy = busy
        isEnabled = available && !busy
        if spinner.isHidden != !busy {
            spinner.isHidden = !busy
            if busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        }
        setAccessibilityLabel(busy ? "\(title)，刷新中" : title)
        needsDisplay = true
    }
}

// Unified capsule segmented control with 120Hz sliding pill thumb and directional specular bevel, drop-in compatible with NSSegmentedControl.
final class DesignSegmentedControl: NSControl {
    override var allowsVibrancy: Bool { false }
    let labels: [String]
    private var segmentButtons: [SegmentButton] = []
    private var _selectedSegment: Int = 0
    private var slidePosition: CGFloat = 0
    private let slideMotion = DesignMotion()

    var selectedSegment: Int {
        get { _selectedSegment }
        set { setSelected(newValue, animated: Design.shouldAnimate(in: self)) }
    }

    var segmentCount: Int { labels.count }

    final class SegmentButton: NSButton {
        override func becomeFirstResponder() -> Bool { let result = super.becomeFirstResponder(); needsDisplay = true; return result }
        override func resignFirstResponder() -> Bool { let result = super.resignFirstResponder(); needsDisplay = true; return result }
        override var allowsVibrancy: Bool { false }
        let index: Int
        var isSelectedSegment = false { didSet { if oldValue != isSelectedSegment { needsDisplay = true } } }
        private var hoverTracking: NSTrackingArea?
        var hovered = false { didSet { if oldValue != hovered { needsDisplay = true } } }

        init(title: String, index: Int, target: AnyObject?, action: Selector) {
            self.index = index
            super.init(frame: .zero)
            self.title = title
            self.target = target
            self.action = action
            bezelStyle = .inline
            isBordered = false
            focusRingType = .none
            setButtonType(.momentaryChange)
            setAccessibilityElement(true)
            setAccessibilityRole(.radioButton)
            setAccessibilityLabel(title)
            let w = ceil((title as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold)]).width) + 22
            translatesAutoresizingMaskIntoConstraints = false
            widthAnchor.constraint(greaterThanOrEqualToConstant: max(54, w)).isActive = true
        }
        required init?(coder: NSCoder) { fatalError() }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let area = hoverTracking { removeTrackingArea(area) }
            let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
            hoverTracking = area
            addTrackingArea(area)
        }
        override func mouseEntered(with event: NSEvent) { if isEnabled { hovered = true } }
        override func mouseExited(with event: NSEvent) { hovered = false }

        override func draw(_ dirtyRect: NSRect) {
            let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let rect = bounds.insetBy(dx: 1, dy: 1)
            if window?.firstResponder === self { Design.blue.setStroke(); let ring = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6); ring.lineWidth = 2; ring.stroke() }
            let path = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6)
            if !isSelectedSegment && hovered {
                (isDark ? NSColor.white.withAlphaComponent(0.055) : NSColor.black.withAlphaComponent(0.035)).setFill()
                path.fill()
            }
            let weight: NSFont.Weight = isSelectedSegment ? .semibold : .medium
            let fg: NSColor = isSelectedSegment ? .labelColor : (hovered ? .labelColor : Design.secondary)
            let pStyle = NSMutableParagraphStyle()
            pStyle.alignment = .center
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 12, weight: weight),
                .foregroundColor: fg,
                .paragraphStyle: pStyle
            ]
            let sz = (title as NSString).size(withAttributes: attrs)
            let drawRect = NSRect(x: 2, y: (bounds.height - sz.height) / 2, width: max(0, bounds.width - 4), height: sz.height)
            (title as NSString).draw(in: drawRect, withAttributes: attrs)
        }
    }

    init(labels: [String], trackingMode: NSSegmentedControl.SwitchTracking = .selectOne, target: AnyObject? = nil, action: Selector? = nil) {
        self.labels = labels
        super.init(frame: .zero)
        self.target = target
        self.action = action
        focusRingType = .none
        translatesAutoresizingMaskIntoConstraints = false
        let stack = NSStackView()
        stack.orientation = .horizontal
        stack.distribution = .fillEqually
        stack.spacing = 2
        for (idx, item) in labels.enumerated() {
            let btn = SegmentButton(title: item, index: idx, target: self, action: #selector(segmentClicked(_:)))
            btn.isSelectedSegment = (idx == 0)
            btn.setAccessibilityValue(idx == 0 ? 1 : 0)
            segmentButtons.append(btn)
            stack.addArrangedSubview(btn)
            btn.heightAnchor.constraint(equalToConstant: 22).isActive = true
        }
        addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 3),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -3),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -3)
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.tabGroup)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: NSSize {
        let totalW = segmentButtons.reduce(CGFloat(6)) { acc, b in
            let w = ceil((b.title as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold)]).width) + 22
            return acc + max(54, w)
        } + CGFloat(max(0, segmentButtons.count - 1)) * 2
        return NSSize(width: totalW, height: 28)
    }

    private func setSelected(_ index: Int, animated: Bool) {
        guard !labels.isEmpty else { return }
        let clamped = max(0, min(labels.count - 1, index))
        _selectedSegment = clamped
        for (idx, btn) in segmentButtons.enumerated() {
            btn.isSelectedSegment = (idx == clamped)
            btn.setAccessibilityValue(idx == clamped ? 1 : 0)
        }
        let targetPos = CGFloat(clamped)
        if animated {
            slideMotion.animate(in: self, from: slidePosition, to: targetPos, curve: .spring, threshold: 0.01) { [weak self] pos in
                self?.slidePosition = pos
                self?.needsDisplay = true
            }
        } else {
            slideMotion.cancel()
            slidePosition = targetPos
            needsDisplay = true
        }
    }

    @objc private func segmentClicked(_ sender: SegmentButton) {
        setSelected(sender.index, animated: Design.shouldAnimate(in: self))
        if let action {
            NSApp.sendAction(action, to: target, from: self)
        }
    }

    override func layout() {
        super.layout()
        needsDisplay = true
    }

    private func interpolatedThumbRect() -> NSRect {
        guard !segmentButtons.isEmpty else { return .zero }
        let lowIdx = max(0, min(segmentButtons.count - 1, Int(floor(slidePosition))))
        let highIdx = max(0, min(segmentButtons.count - 1, Int(ceil(slidePosition))))
        let frac = max(0, min(1, slidePosition - CGFloat(lowIdx)))
        let r1 = convert(segmentButtons[lowIdx].bounds, from: segmentButtons[lowIdx])
        let r2 = convert(segmentButtons[highIdx].bounds, from: segmentButtons[highIdx])
        if r1.width <= 1 {
            let inset: CGFloat = 3
            let spacing: CGFloat = 2
            let count = CGFloat(max(1, labels.count))
            let totalW = max(0, bounds.width - inset * 2 - spacing * (count - 1))
            let itemW = totalW / count
            let x = inset + slidePosition * (itemW + spacing)
            return NSRect(x: x, y: inset, width: itemW, height: max(0, bounds.height - inset * 2))
        }
        return NSRect(
            x: r1.origin.x + (r2.origin.x - r1.origin.x) * frac,
            y: r1.origin.y + (r2.origin.y - r1.origin.y) * frac,
            width: r1.width + (r2.width - r1.width) * frac,
            height: r1.height + (r2.height - r1.height) * frac
        )
    }

    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let outerRect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let outerPath = NSBezierPath(roundedRect: outerRect, xRadius: 8, yRadius: 8)
        (isDark ? NSColor.white.withAlphaComponent(0.05) : NSColor.black.withAlphaComponent(0.045)).setFill()
        outerPath.fill()
        (isDark ? NSColor.white.withAlphaComponent(0.07) : NSColor.black.withAlphaComponent(0.06)).setStroke()
        outerPath.lineWidth = 0.5
        outerPath.stroke()

        let thumbRect = interpolatedThumbRect().insetBy(dx: 0.5, dy: 0.5)
        guard thumbRect.width > 1 && thumbRect.height > 1 else { return }
        let thumbPath = NSBezierPath(roundedRect: thumbRect, xRadius: 6, yRadius: 6)

        NSGraphicsContext.saveGraphicsState()
        let thumbShadow = NSShadow()
        thumbShadow.shadowColor = isDark
            ? NSColor.black.withAlphaComponent(0.38)
            : NSColor.black.withAlphaComponent(0.10)
        thumbShadow.shadowOffset = NSSize(width: 0, height: -1.0)
        thumbShadow.shadowBlurRadius = 2.5
        thumbShadow.set()

        let fill = isDark ? NSColor.white.withAlphaComponent(0.13) : NSColor.white.withAlphaComponent(0.95)
        fill.setFill()
        thumbPath.fill()
        NSGraphicsContext.restoreGraphicsState()

        (isDark ? NSColor.white.withAlphaComponent(0.14) : NSColor.black.withAlphaComponent(0.07)).setStroke()
        thumbPath.lineWidth = 0.6
        thumbPath.stroke()
        Design.drawSpecularBevel(in: thumbRect, cornerRadius: 6, isDark: isDark)
    }
}

// Custom macOS pill switch that preserves active blue tint when enabled even when the window is unfocused/inactive.
final class DesignSwitch: NSSwitch {
        override func becomeFirstResponder() -> Bool { let result = super.becomeFirstResponder(); needsDisplay = true; return result }
        override func resignFirstResponder() -> Bool { let result = super.resignFirstResponder(); needsDisplay = true; return result }
    private let thumbMotion = DesignMotion()
    private var thumbProgress: CGFloat = 0
    private var isPressedState = false

    override var wantsUpdateLayer: Bool { false }
    override var allowsVibrancy: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override var intrinsicContentSize: NSSize {
        NSSize(width: 34, height: 20)
    }

    override var state: NSControl.StateValue {
        get { super.state }
        set {
            let changed = super.state != newValue
            super.state = newValue
            suppressNativeLayers()
            let target: CGFloat = (newValue == .on) ? 1.0 : 0.0
            if changed && Design.shouldAnimate(in: self) {
                thumbMotion.animate(in: self, from: thumbProgress, to: target, curve: .spring, threshold: 0.01) { [weak self] val in
                    self?.thumbProgress = val
                    self?.needsDisplay = true
                }
            } else {
                thumbMotion.cancel()
                thumbProgress = target
                needsDisplay = true
            }
        }
    }

    override var isEnabled: Bool {
        didSet {
            suppressNativeLayers()
            needsDisplay = true
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        focusRingType = .none
        thumbProgress = (super.state == .on) ? 1.0 : 0.0
        suppressNativeLayers()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        focusRingType = .none
        thumbProgress = (super.state == .on) ? 1.0 : 0.0
        suppressNativeLayers()
    }

    deinit {
        thumbMotion.cancel()
    }

    private func suppressNativeLayers() {
        for sub in subviews {
            sub.isHidden = true
            sub.alphaValue = 0
        }
    }

    override func didAddSubview(_ subview: NSView) {
        super.didAddSubview(subview)
        subview.isHidden = true
        subview.alphaValue = 0
    }

    override func layout() {
        super.layout()
        suppressNativeLayers()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        suppressNativeLayers()
        needsDisplay = true
    }

    override func performClick(_ sender: Any?) {
        guard isEnabled else { return }
        state = (state == .on) ? .off : .on
        if let action {
            NSApp.sendAction(action, to: target, from: self)
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        isPressedState = true; needsDisplay = true
        defer { isPressedState = false; needsDisplay = true }
        // Let AppKit own event tracking, cancellation and action delivery.
        super.mouseDown(with: event)
    }

    override func keyDown(with event: NSEvent) {
        if isEnabled && (event.keyCode == 49 || event.keyCode == 36) {
            performClick(self)
            return
        }
        super.keyDown(with: event)
    }

    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let trackW: CGFloat = 32
        let trackH: CGFloat = 18
        let trackRect = NSRect(
            x: round((bounds.width - trackW) / 2),
            y: round((bounds.height - trackH) / 2),
            width: trackW,
            height: trackH
        )
        if window?.firstResponder === self {
            Design.blue.setStroke()
            let ring = NSBezierPath(roundedRect: trackRect.insetBy(dx: -3, dy: -3), xRadius: 12, yRadius: 12)
            ring.lineWidth = 2; ring.stroke()
        }
        let trackRadius = trackH / 2
        let trackPath = NSBezierPath(roundedRect: trackRect, xRadius: trackRadius, yRadius: trackRadius)

        let p = min(1.0, max(0.0, thumbProgress))
        let enableAlpha: CGFloat = isEnabled ? 1.0 : 0.45

        let offFill = isDark
            ? NSColor.white.withAlphaComponent(0.16 * enableAlpha)
            : NSColor.black.withAlphaComponent(0.12 * enableAlpha)
        let onFill = Design.blue.withAlphaComponent(enableAlpha)
        let trackFill = offFill.blended(withFraction: p, of: onFill) ?? (p >= 0.5 ? onFill : offFill)
        trackFill.setFill()
        trackPath.fill()

        let borderColor = p >= 0.5
            ? NSColor.white.withAlphaComponent((isDark ? 0.14 : 0.18) * enableAlpha)
            : (isDark ? NSColor.white.withAlphaComponent(0.10 * enableAlpha) : NSColor.black.withAlphaComponent(0.08 * enableAlpha))
        borderColor.setStroke()
        trackPath.lineWidth = 0.5
        trackPath.stroke()

        let thumbD: CGFloat = 14
        let stretch: CGFloat = (isEnabled && isPressedState) ? 2.0 : 0.0
        let thumbW = thumbD + stretch
        let minX = trackRect.minX + 2.0
        let maxX = trackRect.maxX - 2.0 - thumbW
        let thumbX = minX + (maxX - minX) * p
        let thumbRect = NSRect(x: thumbX, y: trackRect.midY - thumbD / 2, width: thumbW, height: thumbD)
        let thumbPath = NSBezierPath(roundedRect: thumbRect, xRadius: thumbD / 2, yRadius: thumbD / 2)

        NSGraphicsContext.saveGraphicsState()
        if isEnabled {
            let shadow = NSShadow()
            shadow.shadowColor = NSColor.black.withAlphaComponent(isDark ? 0.36 : 0.20)
            shadow.shadowOffset = NSSize(width: 0, height: -0.8)
            shadow.shadowBlurRadius = 1.8
            shadow.set()
        }
        NSColor.white.withAlphaComponent(isEnabled ? 1.0 : 0.78).setFill()
        thumbPath.fill()
        NSGraphicsContext.restoreGraphicsState()
    }
}


