import Cocoa

/// Read-only, selectable details. Sections keep normal results separate from diagnostic data.
final class InspectionDetails: NSObject {
    let sections: [(String, String)]
    let selection: DesignSegmentedControl
    let content = NSTextView()
    var sheetWindow: NSWindow?
    weak var hostWindow: NSWindow?
    init(_ sections: [(String, String)]) {
        self.sections = sections
        selection = DesignSegmentedControl(labels: sections.map { $0.0 }, trackingMode: .selectOne, target: nil, action: nil)
        super.init(); selection.target = self; selection.action = #selector(selectSection); selection.selectedSegment = 0
        content.isEditable = false; content.isSelectable = true; content.isRichText = true
        content.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular); content.textColor = .labelColor; content.drawsBackground = false
        content.textContainerInset = NSSize(width: 10, height: 10); content.autoresizingMask = [.width]
        content.isVerticallyResizable = true; content.isHorizontallyResizable = false
        content.textContainer?.widthTracksTextView = true; content.textContainer?.containerSize = NSSize(width: 500, height: CGFloat.greatestFiniteMagnitude)
        selectSection()
    }
    @objc func selectSection() {
        let value = sections[max(0, selection.selectedSegment)].1
        let styled = NSMutableAttributedString(string:value, attributes:[.font:NSFont.monospacedSystemFont(ofSize:11.5, weight:.regular),.foregroundColor:NSColor.labelColor])
        if let detector = try? NSDataDetector(types:NSTextCheckingResult.CheckingType.link.rawValue) {
            for match in detector.matches(in:value, range:NSRange(value.startIndex..., in:value)) {
                if let url = match.url, ["http","https"].contains(url.scheme ?? "") { styled.addAttribute(.link,value:url,range:match.range) }
            }
        }
        content.textStorage?.setAttributedString(styled); content.scrollToBeginningOfDocument(nil)
    }
    @objc func closeSheet() {
        guard let sheetWindow, let hostWindow else { return }
        hostWindow.endSheet(sheetWindow)
    }
    @objc func copyCurrentSection() {
        let value = sections[max(0, selection.selectedSegment)].1
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }
    static func show(_ title: String, sections: [(String, String)], in window: NSWindow) {
        guard window.activeSheetWindow == nil else { return }
        let inspector = InspectionDetails(sections)
        let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 540, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
        sheet.isReleasedWhenClosed = false
        sheet.backgroundColor = .clear
        sheet.isOpaque = false
        inspector.sheetWindow = sheet
        inspector.hostWindow = window

        let surface = SheetVisualEffectView()
        sheet.contentView = surface

        let titleLabel = text(title, size: 15, weight: .semibold, color: .labelColor)
        let headerRow = horizontal([titleLabel, flexibleSpace(), inspector.selection], spacing: 12)
        headerRow.alignment = .centerY

        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.documentView = inspector.content
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: 268).isActive = true

        let codeBox = group([scroll], inset: 4)
        codeBox.cornerRadius = 10
        codeBox.fillColor = Design.subcard

        let copyBtn = button("复制内容", target: inspector, action: #selector(InspectionDetails.copyCurrentSection))
        let closeBtn = button("关闭", target: inspector, action: #selector(InspectionDetails.closeSheet))
        closeBtn.bezelColor = .controlAccentColor
        closeBtn.keyEquivalent = "\r"

        let footerRow = horizontal([copyBtn, flexibleSpace(), closeBtn], spacing: 8)
        let root = vertical([headerRow, codeBox, footerRow], spacing: 14)
        for v in [headerRow, codeBox, footerRow] { fillWidth(v, in: root) }
        surface.addSubview(root)
        pin(root, to: surface, inset: 20)

        window.beginSheet(sheet) { _ in withExtendedLifetime(inspector) {} }
    }
}
