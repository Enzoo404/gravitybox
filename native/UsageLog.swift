import Cocoa
import UniformTypeIdentifiers

func saveUsageJSON(_ report: [String: Any], name: String, window: NSWindow, app: Assistant, onCompletion: ((Bool) -> Void)? = nil) {
    let panel = NSSavePanel(); panel.allowedContentTypes = [.json]; panel.nameFieldStringValue = name
    panel.beginSheetModal(for: window) { response in
        guard response == .OK, let url = panel.url else {
            onCompletion?(false)
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let state = PerformanceSignpost.begin("UsageExportWrite")
            let result = Result {
                let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
                try data.write(to: url, options: .atomic)
            }
            PerformanceSignpost.end("UsageExportWrite", state)
            DispatchQueue.main.async {
                switch result {
                case .success:
                    app.showMessage("用量记录已导出")
                    onCompletion?(true)
                case .failure(let error):
                    app.showMessage("导出失败：\(error.localizedDescription)", error: true)
                    onCompletion?(false)
                }
            }
        }
    }
}

typealias PageNumberField = PolicyNumberField

final class UsageLogController: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate, NSTextFieldDelegate {
    unowned let app: Assistant
    let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 540), styleMask: [.titled], backing: .buffered, defer: false)
    let search = NSSearchField()
    let searchSpinner = NSProgressIndicator()
    let table = NSTableView()
    let listHost = NSView()
    let scroll = TableScrollView()
    let emptyTitle = text("正在读取请求记录…", size: 13, weight: .medium, color: Design.secondary)
    let emptyIcon = NSImageView()
    // F08: filtered/searched empty results get an explicit way back instead of a contradictory footer.
    let clearFiltersButton = button("清除筛选", target: nil, action: #selector(clearFilters))
    let emptyView = NSView()
    var snapshotID: String?
    var loading = false
    var closed = false
    var searchDebounce: DispatchWorkItem?
    let period = DesignSegmentedControl(labels: ["今日", "近 7 天", "近 30 天", "全部"], trackingMode: .selectOne, target: nil, action: nil)
    let status = text("正在读取…", size: 11, color: Design.secondary, wrap: true)
    let previous = button("上一页", target: nil, action: #selector(previousPage))
    let next = button("下一页", target: nil, action: #selector(nextPage))
    let pageNumber = PageNumberField(string: "1")
    let pageCount = text("/ 1 页", size: 11, color: Design.secondary)
    var listScope = ""
    let refreshButton = InlineRefreshButton("刷新", width: 66, target: nil, action: #selector(reloadSnapshot))
    let exportButton = button("导出…", target: nil, action: #selector(exportRows))
    var rows: [[String: Any]] = []; var offset = 0; var total = 0; var requestRevision = 0
    var onDismiss: (() -> Void)?
    let periods = ["today", "7d", "30d", "all"]
    init(app: Assistant, period selected: String) {
        self.app = app; super.init()
        sheet.title = "请求明细"; sheet.isReleasedWhenClosed = false; table.rowHeight = 64; table.backgroundColor = .clear
        search.placeholderString = "搜索模型"; search.delegate = self; search.setAccessibilityLabel("搜索请求模型")
        period.selectedSegment = periods.firstIndex(of: selected) ?? 0; period.controlSize = .regular; period.target = self; period.action = #selector(periodChanged)
        period.translatesAutoresizingMaskIntoConstraints = false; period.heightAnchor.constraint(equalToConstant: 28).isActive = true
        table.headerView = nil; table.gridStyleMask = []; table.intercellSpacing = NSSize(width: 0, height: 8)
        table.selectionHighlightStyle = .none; table.focusRingType = .none
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("request")); column.width = 640; column.minWidth = 400; table.addTableColumn(column)
        table.dataSource = self; table.delegate = self
        scroll.tableStyle = .plain; table.style = .plain
        scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true; scroll.documentView = table
        scroll.automaticallyAdjustsContentInsets = false
        listHost.addSubview(scroll); pin(scroll,to:listHost)
        emptyIcon.image = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: nil)
        emptyIcon.contentTintColor = Design.secondary
        emptyIcon.imageScaling = .scaleProportionallyUpOrDown
        emptyIcon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([emptyIcon.widthAnchor.constraint(equalToConstant: 24), emptyIcon.heightAnchor.constraint(equalToConstant: 24)])
        emptyTitle.alignment = .center
        clearFiltersButton.target = self
        clearFiltersButton.setAccessibilityLabel("清除搜索筛选")
        clearFiltersButton.isHidden = true
        let empty = vertical([emptyIcon, emptyTitle, clearFiltersButton], spacing: 10); empty.alignment = .centerX
        emptyView.addSubview(empty); empty.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([empty.centerXAnchor.constraint(equalTo:emptyView.centerXAnchor),empty.centerYAnchor.constraint(equalTo:emptyView.centerYAnchor),empty.leadingAnchor.constraint(greaterThanOrEqualTo:emptyView.leadingAnchor,constant:20),empty.trailingAnchor.constraint(lessThanOrEqualTo:emptyView.trailingAnchor,constant:-20)])
        listHost.addSubview(emptyView); pin(emptyView,to:listHost)
        listHost.heightAnchor.constraint(greaterThanOrEqualToConstant: 240).isActive = true
        listHost.setContentHuggingPriority(.defaultLow, for:.vertical)
        previous.target = self; next.target = self; refreshButton.target = self; exportButton.target = self
        previous.isEnabled = false; next.isEnabled = false; exportButton.isEnabled = false
        pageNumber.alignment = .center
        pageNumber.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        pageNumber.focusRingType = .none
        pageNumber.isBezeled = false
        pageNumber.drawsBackground = false
        pageNumber.delegate = self
        pageNumber.setAccessibilityLabel("请求明细页码")
        pageNumber.target = self
        pageNumber.action = #selector(jumpToPage)
        pageNumber.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            pageNumber.widthAnchor.constraint(equalToConstant: 46),
            pageNumber.heightAnchor.constraint(equalToConstant: 28)
        ])
        let close = button("完成", target: self, action: #selector(closeSheet)); close.bezelColor = Design.blue; close.keyEquivalent = "\u{1b}"
        searchSpinner.style = .spinning; searchSpinner.controlSize = .small; searchSpinner.isDisplayedWhenStopped = false
        searchSpinner.translatesAutoresizingMaskIntoConstraints = false; searchSpinner.isHidden = true
        NSLayoutConstraint.activate([searchSpinner.widthAnchor.constraint(equalToConstant: 16), searchSpinner.heightAnchor.constraint(equalToConstant: 16)])
        search.translatesAutoresizingMaskIntoConstraints = false; search.widthAnchor.constraint(greaterThanOrEqualToConstant: 220).isActive = true
        let searchRow = horizontal([search, searchSpinner], spacing: 6); searchRow.alignment = .centerY
        period.setContentHuggingPriority(.required,for:.horizontal); period.setContentCompressionResistancePriority(.required,for:.horizontal)
        let headerActions = horizontal([refreshButton, exportButton], spacing: 8)
        headerActions.alignment = .centerY
        let root = vertical([
            horizontal([text("请求明细", size: 18, weight: .semibold), flexibleSpace(), headerActions]),
            horizontal([searchRow, period], spacing: 12),
            listHost,
            status,
            horizontal([previous, next, pageNumber, pageCount, flexibleSpace(), close])
        ], spacing: 12)
        let surface = SheetVisualEffectView(); sheet.isOpaque = false; sheet.backgroundColor = .clear; sheet.contentView = surface
        let content = fixedPage(root); surface.addSubview(content); pin(content, to: surface); Design.applyControls(surface)
    }
    func show(in window: NSWindow, onDismiss: @escaping () -> Void) {
        self.onDismiss = onDismiss; window.beginSheet(sheet) { [weak self] _ in self?.onDismiss?() }; fetch()
    }
    @objc func reloadSnapshot() {
        guard !loading, !exporting else { return }
        if let snapshotID { app.bridge.send(["command":"usage_snapshot_release","snapshotId":snapshotID]) { _ in } }
        snapshotID = nil; offset = 0; fetch(force: true)
    }
    @objc func closeSheet() {
        if let snapshotID { app.bridge.send(["command":"usage_snapshot_release","snapshotId":snapshotID]) { _ in } }
        snapshotID = nil; closed = true; requestRevision += 1; searchDebounce?.cancel(); sheet.sheetParent?.endSheet(sheet) }
    @objc func periodChanged() { offset = 0; fetch() }
    func controlTextDidChange(_ obj: Notification) {
        guard obj.object as? NSSearchField === search else { return }
        searchDebounce?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.offset = 0; self?.fetch(fromSearch: true) }
        searchDebounce = work; DispatchQueue.main.asyncAfter(deadline:.now()+0.18,execute:work)
    }
    func controlTextDidBeginEditing(_ obj: Notification) {
        if obj.object as? NSTextField === pageNumber {
            pageNumber.needsDisplay = true
        }
    }
    func controlTextDidEndEditing(_ obj: Notification) {
        guard obj.object as? NSTextField === pageNumber else { return }
        pageNumber.needsDisplay = true
        let pages = max(1, (total + 199) / 200)
        let current = offset / 200 + 1
        let raw = pageNumber.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let number = Int(raw), (1...pages).contains(number) else {
            pageNumber.stringValue = "\(current)"
            return
        }
        pageNumber.stringValue = "\(number)"
        if number != current && !loading {
            offset = (number - 1) * 200
            fetch()
        }
    }
    @objc func jumpToPage() {
        let pages = max(1, (total + 199) / 200)
        let current = offset / 200 + 1
        let raw = pageNumber.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let number = Int(raw), (1...pages).contains(number) else {
            status.stringValue = "页码范围 1–\(pages.formatted())"
            pageNumber.stringValue = "\(current)"
            pageNumber.needsDisplay = true
            return
        }
        pageNumber.stringValue = "\(number)"
        sheet.makeFirstResponder(nil)
        pageNumber.needsDisplay = true
        guard number != current else { return }
        offset = (number - 1) * 200; fetch()
    }
    func pageStatus() -> String { rows.isEmpty ? "无请求记录" : "\(listScope) · 共 \(total.formatted()) 条 · 当前 \((offset + 1).formatted())–\((offset + rows.count).formatted()) 条" }
    @objc func previousPage() { offset = max(0, offset - 200); fetch() }
    @objc func nextPage() { offset += 200; fetch() }
    /// F08: true when a search term is narrowing the list (period is part of the query too but the
    /// page always has a period; the confusing empty footer came from the text search).
    var filterActive: Bool { !search.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    @objc func clearFilters() {
        searchDebounce?.cancel()
        search.stringValue = ""
        offset = 0
        fetch()
    }

    func fetch(force: Bool = false, fromSearch: Bool = false) {
        searchDebounce?.cancel(); loading = true; pageNumber.isEnabled = false
        refreshButton.setBusy(true, available: app.reachable)
        if fromSearch {
            searchSpinner.isHidden = false; searchSpinner.startAnimation(nil)
        } else {
            searchSpinner.stopAnimation(nil); searchSpinner.isHidden = true
        }
        previous.isEnabled = false; next.isEnabled = false; exportButton.isEnabled = false
        status.stringValue = "正在读取…"; status.textColor = Design.secondary; updateEmptyState()
        requestRevision += 1; let revision = requestRevision
        var payload: [String:Any] = ["command": "usage_events", "period": periods[max(0, period.selectedSegment)], "query": search.stringValue, "offset": offset, "limit": 200]
        if force {
            payload["force"] = true
            payload["pinSnapshot"] = true
        } else if let snapshotID {
            payload["snapshotId"] = snapshotID
        } else {
            payload["pinSnapshot"] = true
        }
        let acquiring = snapshotID == nil || force
        app.bridge.send(payload) { [weak self] response in
            guard let self else { return }
            guard !self.closed, revision == self.requestRevision else {
                if acquiring, case .success(let value) = response, let id = value["snapshot_id"] as? String { self.app.bridge.send(["command":"usage_snapshot_release","snapshotId":id]) { _ in } }
                return
            }
            self.loading = false
            self.refreshButton.setBusy(false, available: self.app.reachable)
            self.searchSpinner.stopAnimation(nil); self.searchSpinner.isHidden = true
            switch response {
            case .failure(let error):
                self.snapshotID = nil
                self.rows = []; self.table.reloadData(); self.status.stringValue = "读取请求记录失败：\(error.localizedDescription)"; self.status.textColor = accessibleDangerColor(); self.emptyTitle.stringValue = "无法读取请求记录"; self.updateEmptyState(failed:true)
            case .success(let value):
                self.snapshotID = value["snapshot_id"] as? String
                self.rows = value["rows"] as? [[String: Any]] ?? []; self.total = intVal(value, "total")
                let animateTable = Design.shouldAnimate(in: self.table)
                if animateTable {
                    self.table.wantsLayer = true
                    self.table.alphaValue = 0.35
                } else {
                    self.table.alphaValue = 1.0
                }
                self.table.reloadData()
                if animateTable {
                    NSAnimationContext.runAnimationGroup { ctx in
                        ctx.duration = 0.14
                        ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                        self.table.animator().alphaValue = 1.0
                    }
                }
                self.previous.isEnabled = self.offset > 0; self.next.isEnabled = self.offset + self.rows.count < self.total
                self.status.textColor = Design.secondary
                let scope = value["scope"] as? String ?? "本机历史记录"
                self.listScope = scope; self.pageNumber.stringValue = "\(self.offset / 200 + 1)"; self.pageNumber.isEnabled = self.total > 0; self.pageNumber.needsDisplay = true; self.pageCount.stringValue = "/ \(max(1, (self.total + 199) / 200).formatted()) 页"
                if self.rows.isEmpty {
                    // F08: never print "N 个 · 0 条 · 当前 0–0"; the footer must match the empty state.
                    if self.filterActive {
                        self.status.stringValue = "筛选无结果"
                    } else if self.total == 0 {
                        self.status.stringValue = "当前时间范围暂无请求记录"
                    } else if self.offset > 0 {
                        self.status.stringValue = "本页无记录 · 共 \(self.total.formatted()) 条 · 可返回上一页"
                    } else {
                        self.status.stringValue = "共 \(self.total.formatted()) 条请求记录"
                    }
                } else {
                    self.status.stringValue = self.pageStatus()
                }
                self.exportButton.isEnabled = self.total > 0 && self.snapshotID != nil && (value["availability"] as? String) != "unavailable"
                self.updateEmptyState(); self.scroll.contentView.scroll(to:.zero); self.scroll.reflectScrolledClipView(self.scroll.contentView)
                if force {
                    self.app.usagePage?.update(force: false)
                }
            }
        }
    }
    private var exporting = false
    @objc func exportRows() {
        guard !exporting, !loading, total > 0 else { return }
        exporting = true
        refreshButton.isEnabled = false
        exportButton.isEnabled = false
        pageNumber.isEnabled = false
        period.isEnabled = false
        search.isEnabled = false
        previous.isEnabled = false
        next.isEnabled = false
        let chosenPeriod = periods[max(0, period.selectedSegment)], query = search.stringValue
        var collected: [[String: Any]] = []; var generation: Int?; var snapshotID: String? = self.snapshotID; var scope = ""
        func finishExport(errorMsg: String? = nil) {
            exporting = false
            refreshButton.setBusy(false, available: app.reachable)
            exportButton.isEnabled = total > 0 && self.snapshotID != nil
            pageNumber.isEnabled = total > 0
            period.isEnabled = true
            search.isEnabled = true
            previous.isEnabled = offset > 0
            next.isEnabled = offset + rows.count < total
            if let errorMsg {
                status.stringValue = errorMsg
            }
        }
        func readPage() {
            var payload:[String:Any] = ["command":"usage_events","period":chosenPeriod,"query":query,"offset":collected.count,"limit":500]
            if let snapshotID { payload["snapshotId"] = snapshotID }
            app.bridge.send(payload) { [weak self] result in
                guard let self, !self.closed else { return }
                switch result {
                case .failure(let error):
                    finishExport(errorMsg: "导出失败：\(error.localizedDescription)")
                case .success(let value):
                    let returnedID = value["snapshot_id"] as? String
                    guard let returnedID, !returnedID.isEmpty, snapshotID == nil || snapshotID == returnedID else { finishExport(errorMsg:"统计快照已变化，请重新导出"); return }
                    snapshotID = returnedID
                    let stamp = intVal(value, "generated_at")
                    if let old = generation, old != stamp {
                        finishExport(errorMsg: "统计记录已更新，请重新导出。")
                        return
                    }
                    generation = stamp; scope = value["scope"] as? String ?? ""
                    let batch = value["rows"] as? [[String: Any]] ?? []; collected += batch
                    let total = intVal(value, "total")
                    self.status.stringValue = "正在导出 · \(collected.count.formatted())/\(total.formatted()) 条"
                    if collected.count < total && !batch.isEmpty {
                        readPage()
                    } else {
                        let exportedCount = collected.count
                        let fallbackScope = scope.isEmpty ? "本机历史记录" : scope
                        self.status.stringValue = "选择保存位置 · \(exportedCount.formatted()) 条"
                        saveUsageJSON(["period": chosenPeriod, "query": query, "scope": scope, "generatedAt": stamp, "snapshotId":snapshotID ?? "", "rows": collected], name: "GravityBox-请求明细-\(chosenPeriod).json", window: self.sheet, app: self.app) { [weak self] saved in
                            guard let self, !self.closed else { return }
                            finishExport()
                            if saved {
                                self.status.stringValue = "已导出 \(exportedCount.formatted()) 条请求记录 · \(fallbackScope)"
                            } else {
                                self.status.stringValue = self.pageStatus()
                            }
                        }
                    }
                }
            }
        }
        readPage()
    }
    func updateEmptyState(failed: Bool = false) {
        emptyView.isHidden = !rows.isEmpty; scroll.isHidden = rows.isEmpty
        let symbolName: String
        if failed {
            symbolName = "exclamationmark.triangle"
            emptyIcon.contentTintColor = accessibleWarningColor()
            emptyTitle.stringValue = "无法读取请求记录"
        } else if loading {
            symbolName = "magnifyingglass"
            emptyIcon.contentTintColor = Design.secondary
            emptyTitle.stringValue = "正在读取请求记录…"
        } else if filterActive {
            symbolName = "line.3.horizontal.decrease.circle"
            emptyIcon.contentTintColor = .secondaryLabelColor
            emptyTitle.stringValue = "筛选无结果"
        } else {
            symbolName = "magnifyingglass"
            emptyIcon.contentTintColor = Design.secondary
            emptyTitle.stringValue = "暂无请求记录"
        }
        emptyIcon.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)
        clearFiltersButton.isHidden = !filterActive || failed || loading
    }
    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat { 64 }
    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { false }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard rows.indices.contains(row) else { return nil }
        let card = (tableView.makeView(withIdentifier:NSUserInterfaceItemIdentifier("usage-event-card"),owner:self) as? UsageEventCard) ?? UsageEventCard(frame:.zero)
        card.configure(rows[row], highlight: search.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)); return card
    }
}
