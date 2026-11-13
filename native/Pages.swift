import Cocoa

final class DashboardPage: NSObject {
    unowned let app: Assistant
    let view: NSView

    // Hero 账号与 5 桶配额
    let activeAccountLabel = text("正在读取账号…", size: 16, weight: .semibold)
    // B02: status/freshness warnings and the mailbox are two separate lines so a warning can
    // never be overwritten by the raw email (and so the badge always matches the visible copy).
    let accountStatusLabel = text("", size: 11, color: Design.secondary, wrap: true)
    let activeEmailLabel = text("", size: 11, color: .secondaryLabelColor, wrap: true)
    let tierBadge = pillBadge("待确认", color: .systemBlue)
    let currentAccountPill = pillBadge("当前账号", color: Design.blue)
    // F04: percentage = remaining quota, so the title carries the "剩余" semantics explicitly.
    let gemini5hBar = quotaBar(title: "Gemini · 5 小时", percentage: nil, resetText: "", icon: "bolt.fill")
    let geminiWeeklyBar = quotaBar(title: "Gemini · 每周", percentage: nil, resetText: "", icon: "calendar")
    let claude5hBar = quotaBar(title: "Claude/GPT · 5 小时", percentage: nil, resetText: "", icon: "cpu")
    let claudeWeeklyBar = quotaBar(title: "Claude/GPT · 每周", percentage: nil, resetText: "", icon: "calendar")
    // B03/B04: unknown Argon quota means "no data yet", never "not entitled"; the wording must not
    // imply eligibility. The percentage placeholder and explanation are supplied below.
    let argonWeeklyBar = quotaBar(title: "Gemini 4 Argon", percentage: nil, resetText: "", icon: "sparkles", unknownPlaceholder: "未取得配额数据")
    let carbonWeeklyBar = quotaBar(title: "Gemini 4 Carbon", percentage: nil, resetText: "", icon: "sparkles", unknownPlaceholder: "未取得配额数据")
    let extraStandaloneStack = NSStackView()
    let argonStatusLabel = text("Argon 配额未知", size:11, color:.secondaryLabelColor, wrap:true)
    let autoSwitchButton: NSButton
    let refreshQuotaButton: QuotaRefreshButton

    // 三磁贴 Bento 磁贴
    let todayTokensMetric = metricValue()
    let todayTokensDetail = metricDetail("累计 Token 用量 --")
    let todayRequestsMetric = metricValue()
    let todayRequestsDetail = metricDetail("累计请求数 --")
    let usageMetric = metricValue()
    let usageDetail = metricDetail("累计API 费用估算 --")
    var tokenMetricCard: MetricCardBox?
    var costMetricCard: MetricCardBox?
    var requestsMetricCard: MetricCardBox?

    // Bento 双栏数据看板（左侧今日 24h 时段消耗趋势 + 右侧今日活跃模型速览）
    let todayTrendChart = UsageTrendChartView()
    let todayPeakBadge = pillBadge("24 小时分布", color: Design.inactivePill)
    let rightBentoTitleLabel = metricDetail("今日活跃模型")
    let rightBentoCountBadge = pillBadge("暂无调用", color: Design.inactivePill)
    let bentoRightStack = NSStackView()
    private var bentoFingerprint = ""

    var metricsKey = ""
    var metricsLoading = false
    var lastMetricsFetchTime: Date = .distantPast
    var lastSuccessfulSummary: [String: Any]?
    let dataTimestampLabel = text("", size: 11, color: .secondaryLabelColor)
    let usageQualityLabel = text("", size: 11.5, color: .secondaryLabelColor, wrap: true)

    init(app: Assistant) {
        self.app = app
        autoSwitchButton = button("管理账号", target: app, action: #selector(Assistant.showAccounts))
        autoSwitchButton.controlSize = .small
        refreshQuotaButton = QuotaRefreshButton(target: nil, action: #selector(refreshActiveQuota))
        refreshQuotaButton.controlSize = .small
        let stack = pageStack(title: "总览")
        stack.spacing = Design.Spacing.page
        activeAccountLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        activeAccountLabel.lineBreakMode = .byTruncatingTail
        activeAccountLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        accountStatusLabel.maximumNumberOfLines = 2
        accountStatusLabel.lineBreakMode = .byTruncatingTail
        accountStatusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        accountStatusLabel.isHidden = true
        enableTextCopy(activeEmailLabel, title: "复制完整邮箱")
        activeEmailLabel.font = .systemFont(ofSize: 11.5, weight: .regular)
        activeEmailLabel.maximumNumberOfLines = 1
        activeEmailLabel.lineBreakMode = .byTruncatingMiddle
        activeEmailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let titleRow = horizontal([activeAccountLabel, tierBadge, currentAccountPill], spacing: 6)
        titleRow.alignment = .centerY
        tierBadge.setContentCompressionResistancePriority(.required, for: .horizontal)
        currentAccountPill.setContentCompressionResistancePriority(.required, for: .horizontal)
        let identity = vertical([titleRow, activeEmailLabel, accountStatusLabel], spacing: 4)
        for row in identity.arrangedSubviews { fillWidth(row, in: identity) }
        identity.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let heroActions = horizontal([refreshQuotaButton, autoSwitchButton], spacing: 6)
        heroActions.alignment = .centerY
        let accountTopRow = identityHeader(identity: identity, actions: heroActions)
        let first = horizontal([gemini5hBar, geminiWeeklyBar], spacing: 14)
        first.distribution = .fillEqually
        first.alignment = .top
        let second = horizontal([claude5hBar, claudeWeeklyBar], spacing: 14)
        second.distribution = .fillEqually
        second.alignment = .top
        argonStatusLabel.isHidden = true
        let thirdRow = horizontal([argonWeeklyBar, carbonWeeklyBar], spacing: 14)
        thirdRow.distribution = .fillEqually
        thirdRow.alignment = .top
        extraStandaloneStack.orientation = .vertical
        extraStandaloneStack.alignment = .leading
        extraStandaloneStack.spacing = 6
        extraStandaloneStack.isHidden = true
        extraStandaloneStack.detachesHiddenViews = true
        let third = vertical([thirdRow, extraStandaloneStack, argonStatusLabel], spacing: 6)
        third.detachesHiddenViews = true
        fillWidth(thirdRow, in: third)
        fillWidth(extraStandaloneStack, in: third)
        fillWidth(argonStatusLabel, in: third)
        for bar in [gemini5hBar, geminiWeeklyBar, claude5hBar, claudeWeeklyBar, argonWeeklyBar, carbonWeeklyBar] { bar.useCompactLayout() }
        dataTimestampLabel.isHidden = true
        let heroDivider = divider()
        let argonDivider = divider()
        let heroCard = group([accountTopRow, heroDivider, first, second, argonDivider, third, dataTimestampLabel], inset: 14, spacing: 8)
        if let heroInner = groupStack(heroCard) {
            heroInner.setCustomSpacing(8, after: accountTopRow)
            heroInner.setCustomSpacing(8, after: heroDivider)
            heroInner.setCustomSpacing(9, after: first)
            heroInner.setCustomSpacing(8, after: second)
            heroInner.setCustomSpacing(8, after: argonDivider)
            heroInner.setCustomSpacing(6, after: third)
        }
        heroCard.cornerRadius = Design.Radius.card
        heroCard.borderWidth = 0.5
        heroCard.borderColor = Design.border
        stack.addArrangedSubview(heroCard)
        let token = compactMetric("今日 Token 用量", value: todayTokensMetric, detail: todayTokensDetail)
        let cost = compactMetric("今日费用估算", value: usageMetric, detail: usageDetail)
        let requests = compactMetric("今日请求数", value: todayRequestsMetric, detail: todayRequestsDetail)
        tokenMetricCard = token as? MetricCardBox
        costMetricCard = cost as? MetricCardBox
        requestsMetricCard = requests as? MetricCardBox
        let metrics = horizontal([token, cost, requests], spacing: 12); metrics.distribution = .fillEqually; metrics.alignment = .top
        token.heightAnchor.constraint(equalTo: cost.heightAnchor).isActive = true
        token.heightAnchor.constraint(equalTo: requests.heightAnchor).isActive = true
        usageQualityLabel.isHidden = true
        stack.addArrangedSubview(usageQualityLabel)
        stack.addArrangedSubview(metrics)

        // 方案 A：Bento 双栏数据看板
        let trendIconBox = Self.makeHeaderIconBadge(symbolName: "chart.bar.xaxis", tint: Design.blue)
        let trendTitle = metricDetail("今日时段消耗")
        trendTitle.font = .systemFont(ofSize: 13, weight: .semibold)
        trendTitle.textColor = .labelColor
        todayPeakBadge.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let trendHeader = horizontal([trendIconBox, trendTitle, todayPeakBadge, flexibleSpace()], spacing: 6)
        trendHeader.alignment = .centerY
        for c in todayTrendChart.constraints where c.firstAttribute == .height { c.constant = 86 }
        let trendCard = group([trendHeader, divider(), todayTrendChart], inset: 12, spacing: 6)
        trendCard.cornerRadius = Design.Radius.card
        trendCard.borderWidth = 0.5
        trendCard.borderColor = Design.border

        let rightIconBox = Self.makeHeaderIconBadge(symbolName: "square.stack.3d.up.fill", tint: Design.blue)
        rightBentoTitleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        rightBentoTitleLabel.textColor = .labelColor
        rightBentoCountBadge.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let rightHeader = horizontal([rightIconBox, rightBentoTitleLabel, rightBentoCountBadge, flexibleSpace()], spacing: 6)
        rightHeader.alignment = .centerY
        bentoRightStack.orientation = .vertical
        bentoRightStack.alignment = .leading
        bentoRightStack.spacing = 6
        let rightCard = group([rightHeader, divider(), bentoRightStack], inset: 12, spacing: 6)
        rightCard.cornerRadius = Design.Radius.card
        rightCard.borderWidth = 0.5
        rightCard.borderColor = Design.border

        let bentoRow = horizontal([trendCard, rightCard], spacing: 12)
        bentoRow.distribution = .fillEqually
        bentoRow.alignment = .top
        trendCard.heightAnchor.constraint(equalTo: rightCard.heightAnchor).isActive = true
        stack.addArrangedSubview(bentoRow)

        view = dashboardScrollPage(stack, hero: heroCard, metrics: [token, cost, requests])
        super.init()

        autoSwitchButton.target = app
        refreshQuotaButton.target = self
        update()
    }

    private static func makeHeaderIconBadge(symbolName: String, tint: NSColor) -> NSView {
        let iconView = symbol(symbolName, size: 12, color: tint)
        iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11.5, weight: .semibold)
        let iconBox = NSBox()
        iconBox.boxType = .custom
        iconBox.cornerRadius = 6
        iconBox.fillColor = NSColor(name: nil) { app in
            app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? tint.withAlphaComponent(0.18) : tint.withAlphaComponent(0.10)
        }
        iconBox.borderWidth = 0.5
        iconBox.borderColor = NSColor(name: nil) { app in
            app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? tint.withAlphaComponent(0.30) : tint.withAlphaComponent(0.16)
        }
        iconBox.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iconBox.widthAnchor.constraint(equalToConstant: 22),
            iconBox.heightAnchor.constraint(equalToConstant: 22)
        ])
        iconBox.addSubview(iconView)
        NSLayoutConstraint.activate([
            iconView.centerXAnchor.constraint(equalTo: iconBox.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconBox.centerYAnchor)
        ])
        iconBox.setAccessibilityElement(false)
        return iconBox
    }

    private static func makeBentoSubRow(title: String, badgeText: String, badgeTint: NSColor, subtitle: String, trailingText: String, trailingTint: NSColor = Design.secondary) -> NSView {
        let nameLabel = text(title, size: 12.5, weight: .semibold, color: .labelColor)
        nameLabel.lineBreakMode = .byTruncatingTail
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        nameLabel.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        enableTextCopy(nameLabel, value: title, title: "复制完整模型 ID")

        let pill = pillBadge(badgeText, color: badgeTint)
        pill.isHidden = badgeText.isEmpty
        pill.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        pill.setContentHuggingPriority(.required, for: .horizontal)

        let rightLabel = text(trailingText, size: 11, weight: .semibold, color: trailingTint)
        rightLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
        rightLabel.lineBreakMode = .byTruncatingTail
        rightLabel.alignment = .right
        rightLabel.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        rightLabel.setContentHuggingPriority(.required, for: .horizontal)

        let topRow = horizontal([nameLabel, pill, flexibleSpace(), rightLabel], spacing: 6)
        topRow.alignment = .centerY

        let subLabel = metricDetail(subtitle)

        let rowStack = vertical([topRow, subLabel], spacing: 2.5)
        fillWidth(topRow, in: rowStack)
        fillWidth(subLabel, in: rowStack)

        let box = DesignCardBox()
        box.boxType = .custom
        box.cornerRadius = 9
        box.borderWidth = 0.5
        box.borderColor = Design.border
        box.enablesHoverHighlight = false
        box.fillColor = NSColor(name: nil) { app in
            app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor.white.withAlphaComponent(0.03) : NSColor.black.withAlphaComponent(0.02)
        }
        let a11ySummary = [title, badgeText, subtitle, trailingText].filter { !$0.isEmpty }.joined(separator: "，")
        box.setAccessibilityElement(true)
        box.setAccessibilityRole(.group)
        box.setAccessibilityLabel(a11ySummary)
        box.toolTip = nil
        box.addSubview(rowStack)
        rowStack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            rowStack.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 11),
            rowStack.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -11),
            rowStack.topAnchor.constraint(equalTo: box.topAnchor, constant: 6),
            rowStack.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -6)
        ])
        return box
    }

    func updateReadinessMatrix() {
        let report = app.cachedUsageReportsByPeriod["today"] ?? [:]
        let summary = report["summary"] as? [String: Any] ?? [:]
        let hourly = (report["todayHourly"] as? [[String: Any]]) ?? (summary["today_hourly"] as? [[String: Any]]) ?? []
        let pts = UsageTrendChartView.todayPoints(hourly)
        todayTrendChart.points = pts
        if let maxPt = pts.max(by: { $0.tokens < $1.tokens }), maxPt.tokens > 0 {
            let peakStr = InterfaceText.formatCompactTokens(maxPt.tokens)
            todayPeakBadge.title = "峰值 \(maxPt.label) · \(peakStr)"
            todayPeakBadge.tint = Design.blue
        } else {
            todayPeakBadge.title = "24 小时分布"
            todayPeakBadge.tint = Design.inactivePill
        }

        let rawModels = (report["byModel"] as? [[String: Any]]) ?? (report["models"] as? [[String: Any]]) ?? []
        let models = rawModels.filter {
            let t = intVal($0, "totalTokens", fallback: intVal($0, "total_tokens"))
            let r = intVal($0, "requestCount", fallback: intVal($0, "request_count"))
            return t > 0 || r > 0
        }.sorted { m1, m2 in
            let t1 = intVal(m1, "totalTokens", fallback: intVal(m1, "total_tokens"))
            let t2 = intVal(m2, "totalTokens", fallback: intVal(m2, "total_tokens"))
            if t1 != t2 { return t1 > t2 }
            let r1 = intVal(m1, "requestCount", fallback: intVal(m1, "request_count"))
            let r2 = intVal(m2, "requestCount", fallback: intVal(m2, "request_count"))
            return r1 > r2
        }

        let totalTokens = models.reduce(0) { $0 + intVal($1, "totalTokens", fallback: intVal($1, "total_tokens")) }
        let totalReqs = models.reduce(0) { $0 + intVal($1, "requestCount", fallback: intVal($1, "request_count")) }

        let fp = models.prefix(3).map {
            let m = "\($0["model"] ?? "")"
            let t = intVal($0, "totalTokens", fallback: intVal($0, "total_tokens"))
            let r = intVal($0, "requestCount", fallback: intVal($0, "request_count"))
            let u = doubleVal($0, "estimatedUsd", fallback: doubleVal($0, "estimated_usd"))
            return "\(m):\(t):\(r):\(u)"
        }.joined(separator: "|") + "||\(models.count)"
        guard fp != bentoFingerprint else { return }
        bentoFingerprint = fp

        bentoRightStack.arrangedSubviews.forEach {
            bentoRightStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }

        rightBentoTitleLabel.stringValue = "今日活跃模型"

        if models.count >= 2 {
            rightBentoCountBadge.title = models.count > 2 ? "Top 2 / 共 \(models.count) 个" : "2 个模型"
            rightBentoCountBadge.tint = Design.blue
            for item in models.prefix(2) {
                let rawId = (item["model"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                let modelId = (rawId?.isEmpty == false) ? rawId! : "未知模型"
                let displayModel = modelId
                let mTokens = intVal(item, "totalTokens", fallback: intVal(item, "total_tokens"))
                let mReqs = intVal(item, "requestCount", fallback: intVal(item, "request_count"))
                let mUsd = doubleVal(item, "estimatedUsd", fallback: doubleVal(item, "estimated_usd"))
                let usdBadge = mUsd > 0 ? InterfaceText.formatUsd(mUsd) : ""
                let sharePct: Int
                if totalTokens > 0 {
                    sharePct = Int(round(Double(mTokens) / Double(totalTokens) * 100))
                } else if totalReqs > 0 {
                    sharePct = Int(round(Double(mReqs) / Double(totalReqs) * 100))
                } else {
                    sharePct = 0
                }
                let shareNote = sharePct > 0 ? " · 占比 \(sharePct)%" : ""
                let row = Self.makeBentoSubRow(
                    title: displayModel,
                    badgeText: usdBadge,
                    badgeTint: Design.blue,
                    subtitle: "今日调用 \(mReqs.formatted()) 次\(shareNote)",
                    trailingText: "\(InterfaceText.formatCompactTokens(mTokens)) Token",
                    trailingTint: .labelColor
                )
                bentoRightStack.addArrangedSubview(row)
                fillWidth(row, in: bentoRightStack)
            }
        } else if models.count == 1 {
            rightBentoCountBadge.title = "1 个模型"
            rightBentoCountBadge.tint = Design.blue
            let topModel = models[0]
            let rawId = (topModel["model"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let modelId = (rawId?.isEmpty == false) ? rawId! : "未知模型"
            let displayModel = modelId
            let mTokens = intVal(topModel, "totalTokens", fallback: intVal(topModel, "total_tokens"))
            let mReqs = intVal(topModel, "requestCount", fallback: intVal(topModel, "request_count"))
            let mUsd = doubleVal(topModel, "estimatedUsd", fallback: doubleVal(topModel, "estimated_usd"))
            let usdBadge = mUsd > 0 ? InterfaceText.formatUsd(mUsd) : "主要模型"
            let row1 = Self.makeBentoSubRow(
                title: displayModel,
                badgeText: usdBadge,
                badgeTint: Design.blue,
                subtitle: "今日调用 \(mReqs.formatted()) 次 · 占今日全部调用",
                trailingText: "\(InterfaceText.formatCompactTokens(mTokens)) Token",
                trailingTint: .labelColor
            )
            bentoRightStack.addArrangedSubview(row1)
            fillWidth(row1, in: bentoRightStack)

            let hintRow = Self.makeBentoSubRow(
                title: "查看更多模型统计",
                badgeText: "单模型",
                badgeTint: Design.inactivePill,
                subtitle: "可在「用量」页查看全部历史趋势与按模型计价明细",
                trailingText: "-- Token",
                trailingTint: Design.secondary
            )
            bentoRightStack.addArrangedSubview(hintRow)
            fillWidth(hintRow, in: bentoRightStack)
        } else {
            rightBentoCountBadge.title = "暂无调用"
            rightBentoCountBadge.tint = Design.inactivePill

            let emptyRow1 = Self.makeBentoSubRow(
                title: "今日暂无模型调用",
                badgeText: "待运行",
                badgeTint: Design.inactivePill,
                subtitle: "在 IDE 中发起请求后，将在此实时呈现活跃模型",
                trailingText: "-- Token",
                trailingTint: Design.secondary
            )
            bentoRightStack.addArrangedSubview(emptyRow1)
            fillWidth(emptyRow1, in: bentoRightStack)

            let emptyRow2 = Self.makeBentoSubRow(
                title: "模型用量明细",
                badgeText: "用量分析",
                badgeTint: Design.inactivePill,
                subtitle: "可在「用量」页查阅完整模型分布与历史统计",
                trailingText: "-- 次",
                trailingTint: Design.secondary
            )
            bentoRightStack.addArrangedSubview(emptyRow2)
            fillWidth(emptyRow2, in: bentoRightStack)
        }
    }

    @objc func refreshActiveQuota() { app.refreshAccountQuotas() }

    func fetch() {
        update(force: true)
    }

    func update(force: Bool = false) {
        if force { bentoFingerprint = "" }
        updateReadinessMatrix()
        let status = app.statusValue
        guard app.reachable else {
            accountStatusLabel.stringValue = "本机服务离线，保留上次数据"
            accountStatusLabel.isHidden = false; accountStatusLabel.textColor = accessibleWarningColor()
            return
        }
        app.fetchUsageSummary(period: "today", force: force) { [weak self] _ in
            self?.updateReadinessMatrix()
        }
        guard !metricsLoading else { return }

        let now = Date()
        let interval = now.timeIntervalSince(lastMetricsFetchTime)
        let timeExpired = interval >= 15.0

        let currentKey = "\(status.taskRevision)_\(status.working)_\(status.enabled)_\(status.mode)_\(app.activeAccountId)_\(status.accountsRevision)_\(status.activeAccountEmail)_\(status.activeFiveHourQuota ?? -1)_\(status.liveAccountEmail)"
        if !force && !timeExpired && currentKey == metricsKey { return }
        metricsLoading = true

        app.bridge.send(["command": "dashboard_summary"]) { [weak self] response in
            guard let self else { return }
            self.metricsLoading = false
            switch response {
            case .failure(let error):
                if let old = self.lastSuccessfulSummary {
                    self.renderSummary(old, isStaleFallback: true)
                } else {
                    self.dataTimestampLabel.stringValue = "数据获取失败：\(error.localizedDescription)"
                    self.dataTimestampLabel.textColor = accessibleWarningColor()
                }
            case .success(let result):
                self.lastMetricsFetchTime = Date()
                self.metricsKey = currentKey
                self.lastSuccessfulSummary = result
                self.renderSummary(result, isStaleFallback: false)
            }
        }
    }

    private static let quotaObservedFormatter: DateFormatter = InterfaceText.shortDateTimeFormatter

    // B01: dashboard_summary returns stale_groups = [{name, observed_at}] for quota groups whose
    // values were carried over from the previous sample. Surface them as an orange warning without
    // hijacking the mailbox line; observed_at stays available in the tooltip.
    private func staleGroupSummary(_ account: [String: Any]) -> (hint: String, detail: String) {
        let rows = (account["staleGroups"] as? [[String: Any]]) ?? (account["stale_groups"] as? [[String: Any]]) ?? []
        guard !rows.isEmpty else { return ("", "") }
        let names = rows.compactMap { ($0["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        let hint = "\(rows.count) 个配额组未更新" + (names.isEmpty ? "" : "：\(names.joined(separator: "、"))")
        let details: [String] = rows.compactMap { row in
            guard let name = row["name"] as? String, !name.isEmpty else { return nil }
            let stamp = (row["observed_at"] as? Double) ?? (row["observed_at"] as? Int).map(Double.init) ?? 0
            guard stamp > 0 else { return name }
            return "\(name) 采样于 \(Self.quotaObservedFormatter.string(from: Date(timeIntervalSince1970: stamp)))"
        }
        return (hint, details.joined(separator: "；"))
    }

    // B12: sanitised short message for a partial dashboard failure. The payload may carry a
    // string or an object; an absent section without an explicit error is itself a failure.
    private static func summaryError(_ result: [String: Any], _ keys: [String]) -> String {
        for key in keys {
            if let text = result[key] as? String {
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
            if let object = result[key] as? [String: Any] {
                for field in ["message", "error"] {
                    if let text = object[field] as? String {
                        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty { return trimmed }
                    }
                }
            }
        }
        return ""
    }

    private static func shortError(_ text: String, limit: Int = 90) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > limit else { return trimmed.isEmpty ? "数据读取失败" : trimmed }
        return String(trimmed.prefix(limit)) + "…"
    }

    static func syncExtraStandaloneBars(_ models: [QuotaPresentation.Argon], into stack: NSStackView, compact: Bool = true) {
        stack.arrangedSubviews.forEach {
            stack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        guard !models.isEmpty else {
            stack.isHidden = true
            return
        }
        stack.isHidden = false
        var idx = 0
        while idx < models.count {
            let leftModel = models[idx]
            let leftPlaceholder = leftModel.availability == "disabled" ? "不可用" : leftModel.placeholder
            let leftBar = quotaBar(
                title: leftModel.title,
                percentage: leftModel.percentage,
                resetText: leftModel.percentage == nil ? "" : leftModel.resetText,
                icon: "sparkles",
                unknownPlaceholder: leftPlaceholder,
                stale: leftModel.stale
            )
            if compact { leftBar.useCompactLayout() } else { leftBar.useComfortableLayout() }
            if idx + 1 < models.count {
                let rightModel = models[idx + 1]
                let rightPlaceholder = rightModel.availability == "disabled" ? "不可用" : rightModel.placeholder
                let rightBar = quotaBar(
                    title: rightModel.title,
                    percentage: rightModel.percentage,
                    resetText: rightModel.percentage == nil ? "" : rightModel.resetText,
                    icon: "sparkles",
                    unknownPlaceholder: rightPlaceholder,
                    stale: rightModel.stale
                )
                if compact { rightBar.useCompactLayout() } else { rightBar.useComfortableLayout() }
                let row = horizontal([leftBar, rightBar], spacing: 14)
                row.distribution = .fillEqually
                row.alignment = .top
                stack.addArrangedSubview(row)
                fillWidth(row, in: stack)
                idx += 2
            } else {
                let row = horizontal([leftBar, NSView()], spacing: 14)
                row.distribution = .fillEqually
                row.alignment = .top
                stack.addArrangedSubview(row)
                fillWidth(row, in: stack)
                idx += 1
            }
        }
    }

    // B12: account half failed. Keep the retry hint local and never invent a 0% quota or an empty
    // account identity; the usage KPI area is rendered independently below.
    private func renderAccountsError(_ error: String, bothFailed: Bool) {
        let detail = Self.shortError(error)
        self.activeAccountLabel.stringValue = bothFailed ? "账号与用量数据暂时无法读取" : "账号数据暂时无法读取"
        self.tierBadge.isHidden = true
        self.accountStatusLabel.isHidden = false
        self.accountStatusLabel.stringValue = "\(detail) · 可稍后自动重试"
        self.accountStatusLabel.textColor = accessibleWarningColor()
        self.accountStatusLabel.toolTip = nil
        self.activeEmailLabel.stringValue = "点击右上角「刷新配额」或稍后自动重试"
        self.activeEmailLabel.toolTip = nil
        self.gemini5hBar.update(title: "Gemini · 5 小时", percentage: nil, resetText: "", icon: "bolt.fill", unknownPlaceholder: "读取失败")
        self.geminiWeeklyBar.update(title: "Gemini · 每周", percentage: nil, resetText: "", icon: "calendar", unknownPlaceholder: "读取失败")
        self.claude5hBar.update(title: "Claude/GPT · 5 小时", percentage: nil, resetText: "", icon: "cpu", unknownPlaceholder: "读取失败")
        self.claudeWeeklyBar.update(title: "Claude/GPT · 每周", percentage: nil, resetText: "", icon: "calendar", unknownPlaceholder: "读取失败")
        argonWeeklyBar.isHidden = false; carbonWeeklyBar.isHidden = false; extraStandaloneStack.isHidden = true; argonStatusLabel.isHidden = true
        self.argonWeeklyBar.update(title: "Gemini 4 Argon", percentage: nil, resetText: "", icon: "sparkles", unknownPlaceholder: "读取失败")
        self.carbonWeeklyBar.update(title: "Gemini 4 Carbon", percentage: nil, resetText: "", icon: "sparkles", unknownPlaceholder: "读取失败")
    }
    // B12: usage half failed. Show an explicit error instead of 0 / $0.00 / 0 次.
    private func renderUsageError(_ error: String) {
        let detail = Self.shortError(error)
        usageQualityLabel.stringValue = "用量读取失败 · 前往用量页查看详情"; usageQualityLabel.textColor = accessibleWarningColor()
        self.todayTokensMetric.stringValue = "—"
        self.todayTokensDetail.stringValue = "\(detail) · 可稍后自动重试"
        self.todayTokensDetail.textColor = accessibleWarningColor()
        self.todayTokensDetail.toolTip = nil
        self.usageMetric.stringValue = "—"
        self.usageDetail.stringValue = "\(detail) · 可稍后自动重试"
        self.usageDetail.textColor = accessibleWarningColor()
        self.usageDetail.toolTip = nil
        self.todayRequestsMetric.stringValue = "—"
        self.todayRequestsDetail.stringValue = "\(detail) · 可稍后自动重试"
        self.todayRequestsDetail.textColor = accessibleWarningColor()
        self.todayRequestsDetail.toolTip = nil
        self.tokenMetricCard?.refreshAccessibility()
        self.costMetricCard?.refreshAccessibility()
        self.requestsMetricCard?.refreshAccessibility()
    }

    private static let fetchTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

    func renderSummary(_ result: [String: Any], isStaleFallback: Bool) {
        let signpost = PerformanceSignpost.begin("DashboardRenderSummary")
        defer { PerformanceSignpost.end("DashboardRenderSummary", signpost) }
        let formatter = Self.fetchTimeFormatter
        let fetchTimeStr = formatter.string(from: lastMetricsFetchTime == .distantPast ? Date() : lastMetricsFetchTime)
        // B12: dashboard_summary reports partial failures via accountsError / usageError (snake_case
        // accepted for compatibility) while still returning the other half. A missing section with
        // no explicit error is treated as a failure too, so a backend exception can never render as
        // 0 / empty data.
        let accountsDict = result["accounts"] as? [String: Any]
        let usageDict = result["usage"] as? [String: Any]
        let accountsErrorRaw = Self.summaryError(result, ["accountsError", "accounts_error"])
        let usageErrorRaw = Self.summaryError(result, ["usageError", "usage_error"])
        let accountsFailed = accountsDict == nil || !accountsErrorRaw.isEmpty
        let usageFailed = usageDict == nil || !usageErrorRaw.isEmpty
        let accountsError = accountsErrorRaw.isEmpty ? (accountsFailed ? "账号数据读取失败" : "") : accountsErrorRaw
        let usageError = usageErrorRaw.isEmpty ? (usageFailed ? "用量数据读取失败" : "") : usageErrorRaw
        let fetchKey = "界面刷新：\(fetchTimeStr)"
        var quotaTime = ""
        var quotaUpdateDisplay = ""
        let nestedQuotaTs = ((accountsDict?["quota"] as? [String: Any])?["last_updated"] as? Double) ?? (((accountsDict?["quota"] as? [String: Any])?["last_updated"] as? Int).map(Double.init))
        if !accountsFailed, let acc = accountsDict, let quotaTs = (acc["quotaLastUpdated"] as? Double ?? (acc["quotaLastUpdated"] as? Int).map(Double.init) ?? nestedQuotaTs), quotaTs > 0 {
            let qDate = Date(timeIntervalSince1970: quotaTs)
            quotaTime = "配额采样：\(formatter.string(from: qDate)) · "
            quotaUpdateDisplay = "更新于 \(Self.quotaObservedFormatter.string(from: qDate))"
        }
        dataTimestampLabel.toolTip = nil
        dataTimestampLabel.setAccessibilityHelp("数据时间：\(quotaTime)\(fetchKey)")
        let hasErrorBanner = isStaleFallback || accountsFailed || usageFailed
        if hasErrorBanner {
            dataTimestampLabel.isHidden = false
            dataTimestampLabel.stringValue = isStaleFallback ? "数据未更新" : accountsFailed && usageFailed ? "数据读取失败" : accountsFailed ? "账号读取失败" : "用量读取失败"
            dataTimestampLabel.textColor = accessibleWarningColor()
        } else {
            dataTimestampLabel.isHidden = quotaUpdateDisplay.isEmpty
            dataTimestampLabel.stringValue = quotaUpdateDisplay
            dataTimestampLabel.textColor = .secondaryLabelColor
        }

        // 1. 账号与配额
        if let acc = accountsDict, !accountsFailed {
            let email = acc["activeEmail"] as? String ?? ""
            let name = acc["activeName"] as? String ?? ""
            let tier = acc["activeTier"] as? String ?? "FREE"

            let quotaContract = QuotaPresentation.contract(acc)
            let g5h = quotaContract.geminiPrimary.window?.percentage
            let gWeek = quotaContract.geminiWeekly?.percentage
            let c5h = quotaContract.claudePrimary.window?.percentage
            let cWeek = quotaContract.claudeWeekly?.percentage
            let g5Cd = quotaContract.geminiPrimary.window?.resetText ?? ""
            let gWCd = quotaContract.geminiWeekly?.resetText ?? ""
            let c5Cd = quotaContract.claudePrimary.window?.resetText ?? ""
            let cWCd = quotaContract.claudeWeekly?.resetText ?? ""

            if email.isEmpty {
                self.activeAccountLabel.stringValue = "尚未保存账号"
                self.accountStatusLabel.isHidden = true
                self.accountStatusLabel.stringValue = ""
                self.accountStatusLabel.toolTip = nil
                self.activeEmailLabel.stringValue = "点击「账号」页即可一键保存当前登录的 Google 账号"
                self.activeEmailLabel.toolTip = nil
                self.currentAccountPill.isHidden = true
            } else {
                self.activeAccountLabel.stringValue = name.isEmpty ? email : name
                self.currentAccountPill.isHidden = false
                let isStale = acc["isStale"] as? Bool == true
                
                let isConnected = acc["isLiveVerified"] as? Bool == true
                self.currentAccountPill.title = isConnected ? "当前账号" : "已选记录"
                self.currentAccountPill.tint = isConnected ? Design.blue : Design.inactivePill
                let refreshErr = acc["quotaRefreshError"] as? String ?? ""
                let liveEmail = (acc["liveAccountEmail"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

                // B02: one source of truth for the badge title, its tint and the visible status
                // line; the email is rendered on its own line and is never used to replace it.
                let badgeTitle: String
                let badgeTint: NSColor
                let statusText: String
                if !refreshErr.isEmpty {
                    badgeTitle = "配额预警"; badgeTint = accessibleWarningColor()
                    statusText = InterfaceText.quotaMessage(refreshErr)
                } else if isStale {
                    badgeTitle = "快照已过期"; badgeTint = accessibleWarningColor()
                    statusText = "配额已过期"
                } else if isConnected {
                    if !liveEmail.isEmpty && liveEmail.lowercased() == email.lowercased() {
                        badgeTitle = "运行中已核实"; badgeTint = .systemGreen
                        statusText = ""
                    } else if !liveEmail.isEmpty {
                        badgeTitle = "非运行中账号"; badgeTint = accessibleWarningColor()
                        statusText = "账号不一致"
                    } else {
                        badgeTitle = "已保存记录"; badgeTint = .secondaryLabelColor
                        statusText = ""
                    }
                } else {
                    badgeTitle = "已保存记录"; badgeTint = .secondaryLabelColor
                    statusText = ""
                }
                // B01: stale quota groups are a warning of their own; append them to the status
                // line (and tooltip with real sampling times) but never replace the mailbox line.
                let stale = self.staleGroupSummary(acc)
                var finalBadgeTitle = badgeTitle
                var finalBadgeTint = badgeTint
                var finalStatus = statusText
                if !stale.hint.isEmpty {
                    if finalBadgeTitle == "已保存记录" { finalBadgeTitle = "部分配额陈旧"; finalBadgeTint = accessibleWarningColor() }
                    finalStatus = finalStatus.isEmpty ? stale.hint : "\(finalStatus) · \(stale.hint)"
                }
                self.accountStatusLabel.isHidden = finalStatus.isEmpty
                self.accountStatusLabel.stringValue = finalStatus
                // B01: stale groups keep the existing orange warning semantics even while the
                // running identity itself is verified (the badge is not part of the header today).
                self.accountStatusLabel.textColor = !stale.hint.isEmpty
                    ? accessibleWarningColor()
                    : (finalBadgeTint == .secondaryLabelColor ? Design.secondary : finalBadgeTint)
                self.accountStatusLabel.toolTip = nil
                self.activeEmailLabel.stringValue = email
                self.activeEmailLabel.toolTip = nil
            }
            self.tierBadge.isHidden = email.isEmpty
            self.tierBadge.title = tier
            self.tierBadge.tint = tier == "ULTRA" ? .systemPurple : tier == "PRO" ? .systemBlue : Design.inactivePill
            self.tierBadge.isHidden = tier.isEmpty

            // F04: titles state that the percentage is the remaining quota, not a share/total.
            self.gemini5hBar.update(title: "Gemini · \(quotaContract.geminiPrimary.label)", percentage: g5h, resetText: g5Cd, icon: "bolt.fill", unknownPlaceholder: quotaContract.geminiPrimary.window?.placeholder ?? QuotaPresentation.missingWindowPlaceholder(otherPercentage:gWeek), stale: quotaContract.geminiPrimary.window?.stale == true)
            self.geminiWeeklyBar.update(title: "Gemini · 每周", percentage: gWeek, resetText: gWCd, icon: "calendar", unknownPlaceholder: quotaContract.geminiWeekly?.placeholder ?? QuotaPresentation.missingWindowPlaceholder(otherPercentage:g5h), stale: quotaContract.geminiWeekly?.stale == true)
            self.claude5hBar.update(title: "Claude/GPT · \(quotaContract.claudePrimary.label)", percentage: c5h, resetText: c5Cd, icon: "cpu", unknownPlaceholder: quotaContract.claudePrimary.window?.placeholder ?? QuotaPresentation.missingWindowPlaceholder(otherPercentage:cWeek), stale: quotaContract.claudePrimary.window?.stale == true)
            self.claudeWeeklyBar.update(title: "Claude/GPT · 每周", percentage: cWeek, resetText: cWCd, icon: "calendar", unknownPlaceholder: quotaContract.claudeWeekly?.placeholder ?? QuotaPresentation.missingWindowPlaceholder(otherPercentage:c5h), stale: quotaContract.claudeWeekly?.stale == true)
            let argon = quotaContract.argon
            argonWeeklyBar.isHidden = false; carbonWeeklyBar.isHidden = false; argonStatusLabel.isHidden = true
            argonStatusLabel.stringValue = argon?.compactText ?? "Argon 配额未知"
            let argonPlaceholder = argon?.availability == "disabled" ? "不可用" : (argon?.placeholder ?? "未知")
            self.argonWeeklyBar.update(title: argon?.title ?? "Gemini 4 Argon", percentage: argon?.percentage,
                resetText: argon?.percentage == nil ? "" : (argon?.resetText ?? ""), icon: "sparkles",
                unknownPlaceholder: argonPlaceholder, stale: argon?.stale == true)
            let carbon = quotaContract.carbon
            let carbonPlaceholder = carbon?.availability == "disabled" ? "不可用" : (carbon?.placeholder ?? "未知")
            self.carbonWeeklyBar.update(title: carbon?.title ?? "Gemini 4 Carbon", percentage: carbon?.percentage,
                resetText: carbon?.percentage == nil ? "" : (carbon?.resetText ?? ""), icon: "sparkles",
                unknownPlaceholder: carbonPlaceholder, stale: carbon?.stale == true)
            Self.syncExtraStandaloneBars(quotaContract.extraStandaloneModels, into: extraStandaloneStack, compact: true)
            let quotaWarning = QuotaPresentation.warningSummary(quotaContract)
            if !quotaWarning.isEmpty {
                self.accountStatusLabel.isHidden = false
                self.accountStatusLabel.stringValue = [self.accountStatusLabel.stringValue, quotaWarning].filter { !$0.isEmpty }.joined(separator: " · ")
                self.accountStatusLabel.textColor = accessibleWarningColor()
                self.accountStatusLabel.toolTip = nil
            }
        } else {
            self.renderAccountsError(accountsError, bothFailed: usageFailed)
        }

        // 2. 用量与账单
        if let usg = usageDict, !usageFailed {
            // B12: reset the warning styling left behind by a previous failure before rendering.
            self.todayTokensDetail.textColor = Design.secondary
            self.usageDetail.textColor = Design.secondary
            self.todayRequestsDetail.textColor = Design.secondary
            let todayTokens = intVal(usg, "todayTokens")
            let totalTokens = intVal(usg, "totalTokens")
            let todayUsd = doubleVal(usg, "estimatedUsd")
            let allUsd = doubleVal(usg, "allTimeEstimatedUsd", fallback: todayUsd)
            let todayRequests = intVal(usg, "requestCount")
            let totalRequests = intVal(usg, "totalRequestCount", fallback: todayRequests)
            let dbScanned = intVal(usg, "databasesScanned")
            let dbDiscovered = intVal(usg, "databasesDiscovered", fallback: dbScanned)
            let unpriced = intVal(usg, "unpricedModels")
            let hasErr = (usg["hasError"] as? Bool == true) || intVal(usg, "failedDatabasesCount") > 0

            let availability = usg["availability"] as? String ?? "complete"
            let unknown = intVal(usg, "unknownTimeRecords")
            let failed = intVal(usg, "failedDatabasesCount")
            let skipped = intVal(usg, "skippedLargeRecords")
            let showAuditScope = hasErr || failed > 0 || skipped > 0 || unknown > 0 || dbScanned < dbDiscovered || availability == "unavailable"
            self.usageQualityLabel.stringValue = InterfaceText.usageScope(scanned: dbScanned, discovered: dbDiscovered, failed: failed, skipped: skipped, unknown: unknown)
            self.usageQualityLabel.isHidden = !showAuditScope
            self.usageQualityLabel.textColor = (hasErr || failed > 0 || skipped > 0 || unknown > 0) ? accessibleWarningColor() : .secondaryLabelColor
            if availability == "unavailable" {
                self.renderUsageError("所选数据库均读取失败")
                self.usageQualityLabel.stringValue = "统计暂不可用 · 前往用量页查看读取详情"
                return
            }
            for label in [todayTokensDetail, usageDetail, todayRequestsDetail] { label.textColor = .secondaryLabelColor }
            let todayK = InterfaceText.formatCompactTokens(todayTokens)
            let totalK = InterfaceText.formatCompactTokens(totalTokens)

            self.todayTokensMetric.stringValue = todayK
            self.todayTokensDetail.stringValue = "累计 \(totalK) Token"

            let todayUnpriced = intVal(usg, "todayUnpricedModels")
            let todayPriced = intVal(usg, "todayPricedModels")
            self.usageMetric.stringValue = todayUnpriced > 0 && todayPriced == 0 && todayUsd == 0 ? "未计价" : (todayUnpriced > 0 ? "已计价部分 " : "") + InterfaceText.formatUsd(todayUsd)
            self.usageDetail.stringValue = unpriced > 0 && intVal(usg, "pricedModels") == 0 ? "累计未计价" : "累计 \(InterfaceText.formatUsd(allUsd))"
            self.usageDetail.toolTip = nil
            self.costMetricCard?.titleField?.stringValue = "今日费用估算"

            self.todayRequestsMetric.stringValue = todayRequests.formatted()
            self.todayRequestsDetail.stringValue = "累计 \(totalRequests.formatted()) 次"

            self.tokenMetricCard?.refreshAccessibility()
            self.costMetricCard?.refreshAccessibility()
            self.requestsMetricCard?.refreshAccessibility()
        } else {
            self.renderUsageError(usageError)
        }
        self.updateReadinessMatrix()
    }
}
