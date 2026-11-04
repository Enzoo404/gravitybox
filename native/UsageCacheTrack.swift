import Cocoa

final class UsageCacheTrack: NSView {
    private(set) var percent: Double?
    private var displayedPercent: Double = 0
    private let motion = DesignMotion()
    private let trackHeight: CGFloat = 6
    private let scaleHeight: CGFloat = 13

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        // G06: 6pt 轨道 + 13pt 底部的 0%/100% 基准说明，总高 22pt，压缩缓存卡底部大块空带。
        heightAnchor.constraint(equalToConstant: trackHeight + scaleHeight + 3).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.progressIndicator)
        setAccessibilityLabel("缓存命中率")
        setAccessibilityHelp("0%–100% 基准：轨道长度代表缓存命中率。")
    }
    required init?(coder: NSCoder) { fatalError() }

    deinit {
        motion.cancel()
    }

    func update(percent: Double) {
        let target = percent.isFinite ? max(0, min(100, percent)) : nil
        self.percent = target
        let current = target.map { String(format: "%.1f%%", $0) } ?? "待刷新"
        setAccessibilityValue(target.map { NSNumber(value: $0) })
        setAccessibilityHelp("0%–100% 基准：轨道长度代表缓存命中率，当前 \(current)。")
        let targetVal = target ?? 0
        motion.cancel()
        let startVal = displayedPercent
        guard Design.shouldAnimate(in: self), abs(targetVal - startVal) >= 0.2 else {
            displayedPercent = targetVal
            needsDisplay = true
            return
        }
        motion.animate(in: self, from: CGFloat(startVal), to: CGFloat(targetVal), curve: .sweep, threshold: 0.2) { [weak self] val in
            self?.displayedPercent = Double(val)
            self?.needsDisplay = true
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            motion.cancel()
            displayedPercent = percent ?? 0
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        // 轨道贴顶部，底部 13pt 留给 0%/100% 基准说明。
        let trackRect = NSRect(x: 0, y: bounds.height - trackHeight, width: bounds.width, height: trackHeight)
        let path = NSBezierPath(roundedRect: trackRect, xRadius: 3, yRadius: 3)
        Design.track.setFill()
        path.fill()

        if percent != nil && displayedPercent > 0 {
            NSGraphicsContext.saveGraphicsState()
            path.addClip()
            let fillW = bounds.width * CGFloat(displayedPercent) / 100
            let fillRect = NSRect(x: 0, y: trackRect.minY, width: fillW, height: trackHeight)
            let fillPath = NSBezierPath(roundedRect: fillRect, xRadius: 3, yRadius: 3)
            if let grad = NSGradient(starting: Design.blue.withAlphaComponent(0.75), ending: Design.blue) {
                grad.draw(in: fillPath, angle: 0)
            } else {
                Design.blue.setFill()
                fillPath.fill()
            }
            NSGraphicsContext.restoreGraphicsState()
        }

        // 0/100 两端标签（移除 0% 与 100% 处的两条竖线刻度）。
        let scaleColor = Design.secondary
        let labelAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: .regular),
            .foregroundColor: scaleColor
        ]
        let zero = "0%" as NSString
        zero.draw(at: NSPoint(x: 0, y: trackRect.minY - scaleHeight - 1), withAttributes: labelAttrs)
        let hundred = "100%" as NSString
        let hundredSize = hundred.size(withAttributes: labelAttrs)
        hundred.draw(at: NSPoint(x: max(0, bounds.width - hundredSize.width), y: trackRect.minY - scaleHeight - 1), withAttributes: labelAttrs)
    }
}
