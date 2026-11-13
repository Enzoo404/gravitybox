import Cocoa


final class UsagePage: NSObject {
    unowned let app: Assistant
    let view: NSView

    let periodSegment = DesignSegmentedControl(labels: ["今日", "近 7 天", "近 30 天", "全部"], trackingMode: .selectOne, target: nil, action: nil)
    let refreshButton: InlineRefreshButton
    let exportButton = button("导出…", target: nil, action: #selector(exportUsage))

    // 顶部 4 张 KPI 指标卡
    let totalTokensMetric = metricValue()
    let tokensDetail = text("输入 — · 缓存读取 — · 输出 —", size: 11, color: .secondaryLabelColor, wrap: true)
    let costTitle = text("API 费用估算", size: 12, weight: .semibold)
    let priceCoverage = text("", size: 11, color: Design.secondary)
    let usdMetric = metricValue()
    let usdDetail = text("", size: 11, color: .secondaryLabelColor, wrap: true)
    let cacheRateMetric = metricValue()
    let cacheTrack = UsageCacheTrack()
    let requestDetailsButton = button("请求明细…", target: nil, action: #selector(showLog))
    let cacheRateDetail = text("", size: 11, color: .secondaryLabelColor, wrap: true)
    let requestsMetric = metricValue()
    let requestsDetail = text("", size: 11, color: .secondaryLabelColor, wrap: true)

    // 中部可视化图表
    let trendTitleLabel = text("今日用量", size: 13.5, weight: .semibold)
    let trendChart = UsageTrendChartView()
    let donutChart = ModelDonutChartView()
    let donutLegendStack = NSStackView()

    // Model summaries share the same card surface as the rest of the application.
    let modelsBreakdownStack = NSStackView()
    let modelsCountLabel = text("", size: 11.5, color: .secondaryLabelColor)

    let statusSummary = text("", size: 11.5, color: .secondaryLabelColor, wrap: true)
    let footerBox = DesignCardBox()

    var latestReport: [String: Any] = [:]
    var logController: UsageLogController?
    var loading = false
    // E02: 与总览页一致的 15s 节流指纹，避免每次 3s tick 都重拉 usage_summary 并重建图表。
    var metricsKey = ""
    private var renderedSnapshotKey = ""
    private var restoreScroll = true
    var lastFetchTime: Date = .distantPast
    var modelRows: [[String: Any]] = []
    private static let scanDateFormatter: DateFormatter = InterfaceText.shortDateTimeFormatter
    let periods = ["today", "7d", "30d", "all"]
    let palette: [NSColor] = [
        Design.color(0x2563EB, 0x3B82F6),
        Design.color(0x0D9488, 0x2DD4BF),
        Design.color(0x7C3AED, 0xA78BFA),
        Design.color(0xD97706, 0xFBBF24),
        Design.color(0x4F46E5, 0x818CF8),
        Design.color(0xDB2777, 0xF472B6)
    ]

    init(app: Assistant) {
        self.app = app
        refreshButton = InlineRefreshButton("刷新", width: 66, target: nil, action: #selector(refreshUsage))
        periodSegment.selectedSegment = app.usageSelectedPeriod
        periodSegment.controlSize = .regular
        periodSegment.setAccessibilityLabel("用量统计时间范围")
        periodSegment.translatesAutoresizingMaskIntoConstraints = false
        periodSegment.heightAnchor.constraint(equalToConstant: 28).isActive = true

        let headerActions = horizontal([periodSegment, refreshButton, exportButton], spacing: 8)
        headerActions.alignment = .centerY
        let root = pageStack(title: "用量", actions: headerActions)
        root.spacing = Design.Spacing.roomy
        totalTokensMetric.font = .monospacedDigitSystemFont(ofSize: 30, weight: .semibold)
        let trendHeader = horizontal([vertical([text("Token 用量", size: 11, color: Design.secondary), totalTokensMetric, tokensDetail], spacing: 6), flexibleSpace(), trendTitleLabel])
        let trend = vertical([trendHeader, trendChart], spacing: 12)
        fillWidth(trendHeader, in: trend); fillWidth(trendChart, in: trend)
        root.addArrangedSubview(group([trend]))
        costTitle.font = .systemFont(ofSize: 13, weight: .semibold)
        usdMetric.font = .monospacedDigitSystemFont(ofSize: 24, weight: .semibold)
        priceCoverage.isHidden = true
        donutLegendStack.orientation = .vertical; donutLegendStack.alignment = .leading; donutLegendStack.spacing = 8
        donutLegendStack.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let costHeading = horizontal([costTitle, flexibleSpace(), usdMetric], spacing: 8)
        costHeading.alignment = .centerY
        costHeading.heightAnchor.constraint(equalToConstant: 28).isActive = true
        let donutBody = horizontal([donutChart, donutLegendStack], spacing: 10)
        donutBody.alignment = .centerY
        donutLegendStack.translatesAutoresizingMaskIntoConstraints = false
        donutLegendStack.widthAnchor.constraint(equalTo: donutBody.widthAnchor, constant: -114).isActive = true
        usdDetail.isHidden = true
        let donutContent = vertical([costHeading, divider(), donutBody, usdDetail], spacing: 12)
        for row in donutContent.arrangedSubviews { fillWidth(row, in: donutContent) }

        requestsMetric.font = .monospacedDigitSystemFont(ofSize: 22, weight: .semibold)
        cacheRateMetric.font = .monospacedDigitSystemFont(ofSize: 20, weight: .semibold)
        requestDetailsButton.controlSize = .small
        let requestHeading = horizontal([text("请求与缓存", size: 13, weight: .semibold), flexibleSpace(), requestDetailsButton], spacing: 8)
        requestHeading.alignment = .centerY
        requestHeading.heightAnchor.constraint(equalToConstant: 28).isActive = true
        let requestLeft = vertical([text("请求总数", size: 11.5, weight: .medium, color: .labelColor), requestsDetail], spacing: 3)
        let requestStats = horizontal([requestLeft, flexibleSpace(), requestsMetric], spacing: 10)
        requestStats.alignment = .centerY
        let cacheLeft = vertical([text("缓存命中率", size: 11.5, weight: .medium, color: .labelColor), cacheRateDetail], spacing: 2)
        let cacheHeading = horizontal([cacheLeft, flexibleSpace(), cacheRateMetric], spacing: 10)
        cacheHeading.alignment = .centerY
        let cacheStats = vertical([cacheHeading, cacheTrack], spacing: 8)
        fillWidth(cacheHeading, in: cacheStats); fillWidth(cacheTrack, in: cacheStats)
        let requestContent = vertical([requestHeading, divider(), requestStats, divider(), cacheStats], spacing: 14)
        for row in requestContent.arrangedSubviews { fillWidth(row, in: requestContent) }
        let costCard = group([donutContent], inset: 15); let requestCard = group([requestContent], inset: 15); requestCard.identifier = NSUserInterfaceItemIdentifier("requests-cache-card")
        let middle = horizontal([costCard, requestCard], spacing: 12); middle.distribution = .fill; middle.alignment = .top
        costCard.heightAnchor.constraint(equalTo: requestCard.heightAnchor).isActive = true
        costCard.widthAnchor.constraint(equalTo: requestCard.widthAnchor, multiplier: 1.12).isActive = true
        root.addArrangedSubview(middle)
        modelsBreakdownStack.orientation = .vertical; modelsBreakdownStack.alignment = .leading; modelsBreakdownStack.spacing = 14
        modelsBreakdownStack.identifier = NSUserInterfaceItemIdentifier("model-usage-list")
        let breakdown = vertical([horizontal([text("模型用量", size: 13, weight: .semibold), flexibleSpace(), modelsCountLabel]), modelsBreakdownStack], spacing: 16)
        for row in breakdown.arrangedSubviews { fillWidth(row, in: breakdown) }
        let footerRow = horizontal([statusSummary], spacing: 8)
        footerRow.alignment = .centerY
        footerBox.boxType = .custom
        footerBox.cornerRadius = 10
        footerBox.borderWidth = 0.5
        footerBox.borderColor = Design.border
        footerBox.fillColor = Design.subcard
        footerBox.contentViewMargins = NSSize(width: 12, height: 10)
        footerBox.addSubview(footerRow)
        footerRow.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            footerRow.leadingAnchor.constraint(equalTo: footerBox.leadingAnchor, constant: 12),
            footerRow.trailingAnchor.constraint(equalTo: footerBox.trailingAnchor, constant: -12),
            footerRow.topAnchor.constraint(equalTo: footerBox.topAnchor, constant: 10),
            footerRow.bottomAnchor.constraint(equalTo: footerBox.bottomAnchor, constant: -10)
        ])
        footerBox.isHidden = true
        root.addArrangedSubview(group([breakdown])); root.addArrangedSubview(footerBox)

        view = scrollPage(root)
        super.init()

        exportButton.target = self
        func connect(_ view: NSView) { if let control = view as? NSButton, control.target == nil { control.target = self }; for child in view.subviews { connect(child) } }; connect(view)
        refreshButton.target = self
        periodSegment.target = self
        periodSegment.action = #selector(periodChanged(_:))

        fetch()
    }

    @objc func periodChanged(_ sender: DesignSegmentedControl) {
        app.usageSelectedPeriod = sender.selectedSegment
        fetch(force: false)
    }

    @objc func refreshUsage() {
        guard !loading else { return }
        fetch(force: true)
    }

    /// E02: 仅在数据/时间范围/任务状态变化或距上次刷新 ≥15s 时重新拉取；hover 与滚动不再每 3 秒被打断。
    func update(force: Bool = false) {
        guard !loading else { return }
        let key = metricsKeyForCurrentPeriod()
        let timeExpired = Date().timeIntervalSince(lastFetchTime) >= 15.0
        if !force && !timeExpired && key == metricsKey { return }
        fetch(force: force)
    }

    private func metricsKeyForCurrentPeriod() -> String {
        let segIdx = max(0, min(periods.count - 1, periodSegment.selectedSegment))
        return "\(periods[segIdx])_\(app.statusValue.taskRevision)_\(app.statusValue.working)_\(app.statusValue.enabled)_\(app.statusValue.mode)_\(app.reachable)"
    }

    private func formatCompactTokens(_ count: Int) -> String {
        InterfaceText.formatCompactTokens(count, formatSmallWithLocale: true)
    }

    /// F14: one currency format everywhere on the usage surfaces.
    private func formatUsd(_ value: Double) -> String {
        InterfaceText.formatUsd(value)
    }

    private func syncExportButtonState(for period: String) {
        let summary = latestReport["summary"] as? [String: Any] ?? [:]
        exportButton.isEnabled = !loading
            && UsageQueryIdentity(period: period).matches(latestReport)
            && latestReport["snapshotId"] != nil
            && (summary["availability"] as? String) != "unavailable"
    }

    func fetch(force: Bool = false) {
        guard !loading else { return }
        loading = true
        refreshButton.setBusy(true, available: app.reachable)
        exportButton.isEnabled = false
        let requestKey = metricsKeyForCurrentPeriod()
        let segIdx = max(0, min(periods.count - 1, periodSegment.selectedSegment))
        let period = periods[segIdx]
        trendTitleLabel.stringValue = segIdx == 0 ? "今日用量" : (segIdx == 1 ? "近 7 天用量" : (segIdx == 2 ? "近 30 天用量" : "全部用量"))

        app.fetchUsageSummary(period: period, force: force, allowCached: false) { [weak self] response in
            guard let self else { return }
            self.loading = false
            self.refreshButton.setBusy(false, available: self.app.reachable)
            self.lastFetchTime = Date()
            if self.periods[max(0, self.periodSegment.selectedSegment)] != period {
                self.fetch(force: force)
                return
            }
            switch response {
            case .failure(let error):
                // 失败同样进入 15s 退避，避免每个 3s tick 反复请求。
                self.metricsKey = requestKey
                self.syncExportButtonState(for: period)
                let oldPeriod = self.latestReport["period"] as? String ?? ""
                self.statusSummary.stringValue = "读取失败，保留上次结果（\(oldPeriod)）：\(error.localizedDescription)"
                self.statusSummary.textColor = accessibleWarningColor()
                self.footerBox.isHidden = false
            case .success(let value):
                guard UsageQueryIdentity(period: period).matches(value) else {
                    self.statusSummary.stringValue = "返回的统计范围不匹配，已停止展示和导出，请重新读取"
                    self.statusSummary.textColor = accessibleWarningColor()
                    self.footerBox.isHidden = false
                    self.exportButton.isEnabled = false
                    return
                }
                self.metricsKey = requestKey
                self.latestReport = value
                let summary = value["summary"] as? [String: Any] ?? [:]
                // Request state is independent of chart identity: a successful retry must
                // clear the old error even when the data snapshot itself did not change.
                self.updateReadStatus(summary)
                let snapshotKey = "\(value["snapshotId"] ?? ""):\(period):\(summary["availability"] ?? ""):\(summary["failedDatabasesCount"] ?? 0):\(summary["skippedLargeRecords"] ?? 0):\(summary["unknownTimeRecords"] ?? 0)"
                if !snapshotKey.hasPrefix(":") && snapshotKey == self.renderedSnapshotKey { self.syncExportButtonState(for: period); return }
                self.renderedSnapshotKey = snapshotKey
                self.syncExportButtonState(for: period)
                if (summary["availability"] as? String) == "unavailable" {
                    for label in [self.totalTokensMetric, self.usdMetric, self.cacheRateMetric, self.requestsMetric] { label.stringValue = "—" }
                    self.tokensDetail.stringValue = "当前无法读取统计"; self.usdDetail.stringValue = "暂无可用估算"; self.requestsDetail.stringValue = "无法判断调用次数"; self.cacheRateDetail.stringValue = "暂无可用数据"
                    self.modelRows = []; self.trendChart.points = []; self.donutChart.slices = []
                    self.modelsBreakdownStack.arrangedSubviews.forEach { self.modelsBreakdownStack.removeArrangedSubview($0); $0.removeFromSuperview() }
                    self.statusSummary.stringValue = "统计暂不可用：所选数据库均读取失败，请检查本地数据库权限或磁盘状态。"; self.statusSummary.textColor = accessibleWarningColor(); self.footerBox.isHidden = false
                    return
                }
                let total = intVal(summary, "totalTokens")
                let prompt = intVal(summary, "promptTokens")
                let output = intVal(summary, "candidatesTokens")
                let cached = intVal(summary, "cachedTokens")
                let requests = intVal(summary, "requestCount")
                let usd = doubleVal(summary, "estimatedUsd")
                let cacheHit = doubleVal(summary, "cacheHitRate", fallback: (prompt + cached) > 0 ? (Double(cached) / Double(prompt + cached)) * 100.0 : 0.0)

                self.totalTokensMetric.stringValue = self.formatCompactTokens(total)
                let cacheWrite = intVal(summary, "cacheWriteTokens")
                self.tokensDetail.stringValue = "输入 \(self.formatCompactTokens(prompt)) · 缓存读取 \(self.formatCompactTokens(cached))" + (cacheWrite > 0 ? " · 缓存写入 \(self.formatCompactTokens(cacheWrite))" : "") + " · 输出 \(self.formatCompactTokens(output))"
                let pricedCount = (summary["pricedModels"] as? Int) ?? (summary["priced_models"] as? Int) ?? (value["pricedModels"] as? Int) ?? 0
                let unpricedCount = (summary["unpricedModels"] as? Int) ?? (summary["unpriced_models"] as? Int) ?? (value["unpricedModels"] as? Int) ?? 0
                self.costTitle.stringValue = "API 费用估算"
                let coverageRows = value["byModel"] as? [[String: Any]] ?? []
                let unpricedTokens = coverageRows.reduce(0) { $0 + intVal($1, "unpricedTokens", fallback: intVal($1, "unpriced_tokens")) }
                let coverageText = total > 0 && unpricedTokens > 0
                    ? "已计价部分 · 另有 \(Int((Double(unpricedTokens) / Double(total) * 100).rounded()))% Token 未计价"
                    : "已计价部分 · 含未计价请求"
                self.priceCoverage.stringValue = unpricedCount > 0 ? coverageText : ""
                self.priceCoverage.isHidden = unpricedCount == 0
                self.usdMetric.stringValue = unpricedCount > 0 && pricedCount == 0 && usd == 0 ? "未计价" : self.formatUsd(usd)
                self.usdDetail.stringValue = ""
                self.usdDetail.isHidden = true

                self.cacheRateMetric.stringValue = String(format: "%.1f%%", cacheHit)
                self.cacheTrack.update(percent: cacheHit)
                self.cacheRateDetail.stringValue = "读取 \(self.formatCompactTokens(cached)) Token"

                self.requestsMetric.stringValue = "\(requests.formatted()) 次"
                let avgIn = requests > 0 ? total / requests : 0
                self.requestsDetail.stringValue = requests > 0 ? "平均每次约 \(self.formatCompactTokens(avgIn)) Token" : "当前时段暂无调用"

                self.updateReadStatus(summary)

                let priceRows = value["byModel"] as? [[String: Any]] ?? []
                let outdated = priceRows.filter { ($0["pricingStatus"] as? String ?? "") == "expired" }.count
                if outdated > 0 {
                    self.usdDetail.stringValue = "\(outdated) 个模型价格待核对"
                    self.usdDetail.textColor = accessibleWarningColor()
                    self.usdDetail.isHidden = false
                } else {
                    self.usdDetail.textColor = .secondaryLabelColor
                    self.usdDetail.isHidden = true
                }
                let rows = (value["byModel"] as? [[String: Any]]) ?? (value["models"] as? [[String: Any]]) ?? []
                self.modelRows = rows
                let scroll = self.view as? NSScrollView
                let preservedOrigin = self.restoreScroll ? self.app.usageScrollOrigin : (scroll?.contentView.bounds.origin ?? .zero)
                self.restoreScroll = false
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0
                    ctx.allowsImplicitAnimation = false
                    self.updateChartsAndBreakdown(summary: summary, value: value, segIdx: segIdx, totalTokens: total, totalUsd: usd)
                    scroll?.layoutSubtreeIfNeeded()
                    if let scroll {
                        let maxY = max(0, (scroll.documentView?.bounds.height ?? 0) - scroll.contentView.bounds.height)
                        let clampedY = max(0, min(preservedOrigin.y, maxY))
                        scroll.contentView.scroll(to: NSPoint(x: 0, y: clampedY))
                        scroll.reflectScrolledClipView(scroll.contentView)
                    }
                }
            }
        }
    }

    func updateReadStatus(_ summary: [String: Any]) {
        let failed = intVal(summary, "failedDatabasesCount", fallback: intVal(summary, "failed_databases_count"))
        let skipped = intVal(summary, "skippedLargeRecords", fallback: intVal(summary, "skipped_large_records"))
        let unknown = intVal(summary, "unknownTimeRecords")
        let scanned = intVal(summary, "databasesScanned")
        let discovered = intVal(summary, "databasesDiscovered", fallback: scanned)
        let unpriced = intVal(summary, "unpricedModels", fallback: intVal(summary, "unpriced_models"))
        let scope = InterfaceText.usageScope(scanned: scanned, discovered: discovered, failed: failed, skipped: skipped, unknown: unknown)
        let cached = summary["availability"] as? String == "cached"
        let warnings = (summary["pricing_warnings"] as? [String] ?? []).filter {
            !$0.hasPrefix("旧JSON") && !$0.hasPrefix("旧账本") && !$0.hasPrefix("历史金额凭据")
        }
        var parts: [String] = []
        if cached { parts.append("上次记录") }
        let hasScopeIssue = failed > 0 || skipped > 0 || unknown > 0 || (discovered > 0 && scanned < discovered)
        if hasScopeIssue || cached {
            parts.append(scope)
        }
        if unpriced > 0 {
            parts.append("\(unpriced) 款模型暂无适用价格")
        }
        if !warnings.isEmpty {
            parts.append(warnings.joined(separator: "；"))
        }
        statusSummary.stringValue = parts.joined(separator: " · ")
        let hasWarning = hasScopeIssue || cached || unpriced > 0 || !warnings.isEmpty
        statusSummary.textColor = hasWarning ? accessibleWarningColor() : .secondaryLabelColor
        footerBox.isHidden = !hasWarning
    }

    func updateChartsAndBreakdown(summary: [String: Any], value: [String: Any], segIdx: Int, totalTokens: Int, totalUsd: Double) {
        let signpost = PerformanceSignpost.begin("UsageChartsAndBreakdown")
        defer { PerformanceSignpost.end("UsageChartsAndBreakdown", signpost) }
        if let rows = (value["byModel"] as? [[String: Any]]) ?? (value["models"] as? [[String: Any]]) {
            self.modelRows = rows
        }
        // 1. 更新趋势柱状图
        if segIdx == 0 {
            let hourly = (value["todayHourly"] as? [[String: Any]]) ?? (summary["today_hourly"] as? [[String: Any]]) ?? []
            let pts = UsageTrendChartView.todayPoints(hourly)
            trendChart.points = pts
        } else {
            let daily = (value["dailyTrends"] as? [[String: Any]]) ?? (summary["daily_trends"] as? [[String: Any]]) ?? []
            // segIdx == 1: 7天; segIdx == 2: 30天; segIdx == 3: 全部 (展示完整 30 天或更长历史，杜绝被截成14天)
            let count = segIdx == 1 ? 7 : (segIdx == 2 ? 30 : max(30, daily.count))
            let slice = daily.suffix(count)
            let pts: [UsageTrendChartView.Point] = slice.map { d in
                let dateStr = (d["date"] as? String) ?? ""
                let shortDate = dateStr.count >= 10 ? String(dateStr.suffix(5)) : dateStr
                let t = (d["total_tokens"] as? Int) ?? (d["totalTokens"] as? Int) ?? 0
                return .init(label: shortDate, tokens: t)
            }
            trendChart.points = pts
        }
        let maxPoint = trendChart.points.max(by: { $0.tokens < $1.tokens })
        let peakText = (maxPoint != nil && maxPoint!.tokens > 0) ? "，峰值于 \(maxPoint!.label) · \(formatCompactTokens(maxPoint!.tokens)) Token" : ""
        trendChart.setAccessibilityElement(true)
        trendChart.setAccessibilityLabel("\(trendTitleLabel.stringValue)\(peakText)")

        // 2. 更新环图与图例 (N09: 按费用降序排列，超出项合并为「其他」，保证图例百分比与环图 360° 完全对齐)
        donutLegendStack.arrangedSubviews.forEach {
            donutLegendStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        var slices: [ModelDonutChartView.Slice] = []

        // 先筛选已计价且有费用的模型，按费用降序排序
        let pricedModels = modelRows.filter {
            let mUsd = doubleVal($0, "estimatedUsd", fallback: doubleVal($0, "estimated_usd"))
            let isPriced = (($0["priced"] as? Bool) ?? (mUsd > 0)) || ($0["partiallyPriced"] as? Bool == true)
            return isPriced && mUsd > 0
        }.sorted {
            let u1 = doubleVal($0, "estimatedUsd", fallback: doubleVal($0, "estimated_usd"))
            let u2 = doubleVal($1, "estimatedUsd", fallback: doubleVal($1, "estimated_usd"))
            return u1 > u2
        }

        let totalPricedUsd = pricedModels.reduce(0.0) { $0 + doubleVal($1, "estimatedUsd", fallback: doubleVal($1, "estimated_usd")) }
        let effectiveTotalUsd = max(totalUsd, totalPricedUsd)

        let topCount = 4
        var topSlices: [(name: String, usd: Double, tokens: Int, color: NSColor)] = []
        var otherUsd = 0.0
        var otherTokens = 0
        var otherCount = 0

        for (idx, item) in pricedModels.enumerated() {
            let name = (item["model"] as? String) ?? "未知模型"
            let mUsd = doubleVal(item, "estimatedUsd", fallback: doubleVal(item, "estimated_usd"))
            let mTokens = intVal(item, "totalTokens", fallback: intVal(item, "total_tokens"))
            if idx < topCount || pricedModels.count <= 5 {
                let color = palette[idx % palette.count]
                topSlices.append((name: name, usd: mUsd, tokens: mTokens, color: color))
            } else {
                otherUsd += mUsd
                otherTokens += mTokens
                otherCount += 1
            }
        }

        if otherCount > 0 && otherUsd > 0 {
            topSlices.append((name: "其他模型 · \(otherCount) 个", usd: otherUsd, tokens: otherTokens, color: .systemGray))
        }

        for (_, slice) in topSlices.enumerated() {
            slices.append(.init(model: slice.name, usd: slice.usd, tokens: slice.tokens, color: slice.color))

            let dot = NSBox()
            dot.boxType = .custom; dot.borderWidth = 0; dot.cornerRadius = 4; dot.fillColor = slice.color
            dot.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([dot.widthAnchor.constraint(equalToConstant: 8), dot.heightAnchor.constraint(equalToConstant: 8)])

            let pct = effectiveTotalUsd > 0 ? Int(round((slice.usd / effectiveTotalUsd) * 100)) : 0
            let pctText = (slice.usd > 0 && pct == 0) ? "<1%" : "\(pct)%"
            let nameLbl = text(slice.name, size: 12, weight: .medium, wrap: false)
            nameLbl.maximumNumberOfLines = 1
            nameLbl.lineBreakMode = .byTruncatingTail
            nameLbl.cell?.wraps = false
            nameLbl.cell?.truncatesLastVisibleLine = true
            nameLbl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

            let usdDisplay = self.formatUsd(slice.usd)
            let valLbl = text("\(usdDisplay) · 占比 \(pctText)", size: 10.5, weight: .regular, color: .secondaryLabelColor)
            valLbl.lineBreakMode = .byTruncatingTail
            valLbl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            valLbl.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
            let details = vertical([nameLbl, valLbl], spacing: 2)
            fillWidth(nameLbl, in: details); fillWidth(valLbl, in: details)
            let dotWrap = NSView()
            dotWrap.translatesAutoresizingMaskIntoConstraints = false
            dotWrap.addSubview(dot)
            NSLayoutConstraint.activate([
                dotWrap.widthAnchor.constraint(equalToConstant: 8),
                dotWrap.heightAnchor.constraint(equalToConstant: 14),
                dot.centerXAnchor.constraint(equalTo: dotWrap.centerXAnchor),
                dot.centerYAnchor.constraint(equalTo: dotWrap.centerYAnchor)
            ])
            let row = horizontal([dotWrap, details], spacing: 7)
            row.alignment = .top
            details.translatesAutoresizingMaskIntoConstraints = false
            details.widthAnchor.constraint(equalTo: row.widthAnchor, constant: -15).isActive = true
            donutLegendStack.addArrangedSubview(row)
            fillWidth(row, in: donutLegendStack)
        }

        if slices.isEmpty {
            let zeroHint = modelRows.isEmpty ? "当前时段暂无模型用量记录" : modelRows.contains(where: { $0["priced"] as? Bool == true }) ? "已计价费用为零" : "暂无价格数据"
            donutLegendStack.addArrangedSubview(text(zeroHint, size: 12, color: .secondaryLabelColor))
        }
        donutChart.isHidden = slices.isEmpty
        donutChart.slices = slices
        donutChart.totalUsd = effectiveTotalUsd
        let topModelName = topSlices.first?.name ?? "暂无"
        let topPct = topSlices.first.map { slice in effectiveTotalUsd > 0 ? Int(round((slice.usd / effectiveTotalUsd) * 100)) : 0 } ?? 0
        donutChart.setAccessibilityElement(true)
        donutChart.setAccessibilityLabel(pricedModels.isEmpty && !modelRows.isEmpty ? "暂无可计价模型" : "各模型费用占比环图，合计等效费用 \(self.formatUsd(effectiveTotalUsd))，最高费用占比 \(topModelName) · \(topPct)%")

        // Visible summaries use real model metrics.
        modelsBreakdownStack.arrangedSubviews.forEach {
            modelsBreakdownStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        modelsCountLabel.stringValue = modelRows.isEmpty ? "" : "\(modelRows.count) 个模型"

        guard !modelRows.isEmpty else {
            let empty = vertical([symbol("chart.bar", size: 22, color: Design.secondary), text("暂无模型用量", size: 13, color: Design.secondary)], spacing: 10)
            empty.alignment = .centerX; empty.heightAnchor.constraint(greaterThanOrEqualToConstant: 90).isActive = true
            modelsBreakdownStack.addArrangedSubview(empty); fillWidth(empty, in: modelsBreakdownStack)
            return
        }

        for item in modelRows {
            let name = (item["model"] as? String) ?? "未知模型"
            let mTokens = intVal(item, "totalTokens", fallback: intVal(item, "total_tokens"))
            let mIn = intVal(item, "promptTokens", fallback: intVal(item, "input_tokens"))
            let mOut = intVal(item, "candidatesTokens", fallback: intVal(item, "output_tokens"))
            let mReq = intVal(item, "requestCount", fallback: intVal(item, "request_count"))
            let mUsd = doubleVal(item, "estimatedUsd", fallback: doubleVal(item, "estimated_usd"))
            let rawRatio = totalTokens > 0 ? (Double(mTokens) / Double(totalTokens)) * 100.0 : 0.0
            let sharePct = totalTokens > 0 ? max(0, min(100, Int(round(rawRatio)))) : 0
            let shareText = (mTokens > 0 && sharePct == 0) ? "<1%" : "\(sharePct)%"
            let isItemPriced = (item["priced"] as? Bool) ?? (mUsd > 0)
            var usdStr: String
            if isItemPriced || (item["partiallyPriced"] as? Bool == true) {
                if mUsd > 0 && mUsd < 0.001 {
                    usdStr = "<$0.001"
                } else if mUsd < 0.01 && mUsd > 0 {
                    usdStr = String(format: "$%.3f", mUsd)
                } else if mUsd == 0 {
                    usdStr = "$0.00"
                } else {
                    usdStr = String(format: "$%.2f", mUsd)
                }
            } else {
                usdStr = mTokens > 0 ? "未计价" : "$0.00"
            }
            if item["partiallyPriced"] as? Bool == true { usdStr = "部分 " + usdStr }
            let row = ModelUsageRow(name: name, tokens: formatCompactTokens(mTokens), input: formatCompactTokens(mIn), output: formatCompactTokens(mOut), requests: mReq, cost: usdStr, share: sharePct, shareText: shareText)
            if !modelsBreakdownStack.arrangedSubviews.isEmpty {
                let line = divider(); modelsBreakdownStack.addArrangedSubview(line); fillWidth(line, in: modelsBreakdownStack)
            }
            modelsBreakdownStack.addArrangedSubview(row); fillWidth(row, in: modelsBreakdownStack)
        }
    }

    @objc func showLog() {
        guard let window = app.window, window.activeSheetWindow == nil else { return }
        let controller = UsageLogController(app: app, period: periods[max(0, periodSegment.selectedSegment)])
        logController = controller; controller.show(in: window) { [weak self] in self?.logController = nil }
    }
    @objc func exportUsage() {
        let selected = periods[max(0, min(periods.count - 1, periodSegment.selectedSegment))]
        guard !loading, exportButton.isEnabled, UsageQueryIdentity(period: selected).matches(latestReport), latestReport["snapshotId"] != nil, let window = app.window else { return }
        let snapshot = latestReport
        saveUsageJSON(snapshot, name: "GravityBox-用量-\(selected).json", window: window, app: app)
    }

}
