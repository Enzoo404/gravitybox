# Project: GravityBox 1.0.5 Release Evaluation & Verification

## Architecture & Scope
GravityBox 1.0.5 分支针对 macOS 原生 (Apple Silicon arm64) 轻量级 Antigravity 辅助工具箱的修复合理性深度评估与发布就绪审查。

## Feature Inventory
| # | Feature / Module | Description | Files Touched | Milestone | Status |
|---|------------------|-------------|---------------|-----------|--------|
| 1 | 模块 1：缓存维护与存储事务 | 引入 ReentrantMutex 互斥锁、退出静止后重取扫描令牌、非破坏性废纸篓与原子快照回滚、内存缓存清空、IPC幂等清理、SQLite Worker 池退出守护 | `src/maintenance.ts`, `native/Maintenance.swift`, `src/accounts.ts`, `src/ipc-idempotency.ts`, `src/sqlite-read.ts`, `src/main.ts` | M1 | ASSESSED (PASS) |
| 2 | 模块 2：在线更新器与生命周期 | 静默检查 403 状态机安全复位、静默预下载中用户点击立即安装自动衔接、`acknowledge` 耗时哈希后台化、`updates/transactions/` 深度清理并保留凭据、多层级 Sheet 递归安全关闭、`DesignButton` 定时器注销与 RunLoop 绑定 | `native/Preferences.swift`, `native/Assistant.swift`, `native/Backend.swift`, `native/Design.swift`, `test/native-ui.swift` | M1 | ASSESSED (PASS) |
| 3 | 模块 3：账号状态同步与配额 | `mergeLiveQuotaWithSaved` 配额熔合保护高级套餐与分组、Argon 配额明确区分“模型配额”契约、`lastFetchedAccountsRevision` 游标消除 `watchState` 竞态、未保存账号保留 activeId、`quota-rejected` 门槛与 20 份上限、切号预检补齐 Insiders 阻断 | `src/main.ts`, `src/accounts.ts`, `native/MenuStatusCard.swift`, `native/Assistant.swift`, `native/Accounts.swift`, `native/AccountPolicySheet.swift`, `native/AddAccountSheet.swift` | M1 | ASSESSED (PASS) |
| 4 | 模块 4：汉化控制器与 SQLite/用量 | 零侵入运行时 CDP 热适配（无二进制篡改/重签名）、敏感 DOM 选择器严格保护、CDP 注入竞态与延迟重试、时序费率与历史账单单价冻结、定价溯源元数据、远程同步 5 分钟优雅退避、快照缓存 TTL 续期 | `src/controller.ts`, `src/discovery.ts`, `src/usage.ts`, `src/sqlite-read.ts`, `assets/pricing-feed.json`, `native/Usage.swift`, `native/UsageLog.swift` | M1 | ASSESSED (PASS) |
| 5 | 模块 5：原生 UI 与布局优化 | 菜单栏卡片隐藏视图约束脱落修复、880pt 最小窗口宽度适配（QuotaBarView 间距收窄至 14pt/4pt/2pt 防文本截断）、主页/账号页双列间距紧凑化、弹窗头部副标题换行抗压缩、中性灰已选记录徽章与深浅色模式语义色 | `native/MenuStatusCard.swift`, `native/Components.swift`, `native/Pages.swift`, `native/Accounts.swift`, `native/Design.swift`, `native/AccountPolicySheet.swift` | M1 | ASSESSED (PASS) |
| 6 | 自动化门禁体系复测 | 全量 TypeScript 编译 (`npm run build`)、全量单元与集成测试 (`npm test`)、无头浏览器回归 (`npm run test:browser`)、Swift 原生编译检查 (`swiftc -O`)、受支持版本 (2.23.0～2.29.1) 词典门禁 (`npm run i18n:gate`)、全量验证 (`npm run verify`) | 全量工程构建脚本与测试文件 | M2 | VERIFIED (PASS) |
| 7 | 安全性与 AGENTS.md 契约审计 | 专一支持 Antigravity 正式版、零外部遥测、零凭据泄露/硬编码 Token 审计、零侵入 CDP 原则校验、数据安全与快照回滚能力取证 | 全量改动文件与配置 | M3 | AUDITED (CLEAN) |
| 8 | 终审报告与 GitHub 发布就绪判定 | 输出《GravityBox 1.0.5 修复合理性深度评估与 GitHub 发布就绪报告》，分级列出发现的问题，给出明确终审结论 | 结构化交付物 | M4 | IN_PROGRESS |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | 5 大模块修复代码深度走查与合理性/风险评估 | 源码 diff 走查、逻辑自洽性、竞态与泄漏排查 | none | DONE |
| M2 | 全量执行自动化门禁复测与工程规范合规性审查 | npm run build, npm test, npm run test:browser, Swift native, npm run verify | M1 | DONE |
| M3 | 安全性与 AGENTS.md 契约取证审计 | 正式版专一性、零遥测、凭据脱敏、非破坏性操作取证 | M1 | DONE |
| M4 | 交叉评审、挑战验证与终审报告综合交付 | 交付《GravityBox 1.0.5 修复合理性深度评估与 GitHub 发布就绪报告》 | M2, M3 | IN_PROGRESS |

## Interface & Code Layout
- `src/`: Node.js / TypeScript 核心后端逻辑（缓存维护、账号管理、CDP 汉化注入、SQLite 只读分析、用量核算、IPC 调度）
- `native/`: AppKit Swift 原生菜单栏面板、主窗口控制台、UI 组件、系统级更新器
- `runtime/`: 运行时注入脚本（engine.js）
- `assets/`: 模型时序计价基准配置文件（pricing-feed.json）
- `test/`: 自动化测试套件（单元测试、集成测试、无头浏览器测试、Swift 原生 UI 几何断言）
- `tools/`: 构建与门禁脚本（verify.mjs, clean-dist.mjs, copy-runtime.mjs, coverage-report.mjs）
