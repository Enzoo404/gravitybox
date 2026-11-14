# 更新日志 (Changelog)

本项目的所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 (Semantic Versioning)](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.1.0] - 2026-11-14

### Added
- **In-IDE Telemetry HUD**：上线 Antigravity 输入框下方三联遥测胶囊（会话概览 / Token 消耗 / 上下文水位）及独立悬浮弹层；支持实时区分模型思考（实心蓝）与工具执行（呼吸蓝）状态、TTFT / 真实 TPS / 本轮用时与模型及工具耗时拆分、高对比度进度条及一键中英文双语独立开关。
- **HUD Popover Redesign**：会话统计卡片引入虚线分隔总平均与本轮实时数据，新增「最近一步 TTFT」与「最近一步 TPS」并统一「本轮用时」等字段为固定占位格式。
- **Storage & Maintenance v2**：新增存储与维护 v2（三分类缓存扫描、废纸篓软删除、7 天恢复点管理及账本数据维护），默认隔离核心 `state.vscdb` 与凭据。
- **Pricing / Usage**：新增模型定价同步明细弹窗（`PricingSyncSheetController`），支持查看各官方模型时序定价、执行公开定价表（GitHub Raw / jsDelivr）同步与历史用量账本重估预览/应用。
- **i18n / Dictionary**：新增对 Google Antigravity `2.31.0`、`2.31.2` 与 `2.32.1` 官方版本的指纹登记、文案抽取与分层词典适配（现已覆盖 `2.23.0` ~ `2.32.1` 全系列受支持版本）。
- **Packaging / Compliance**：DMG 安装包内补充随附项目根 `LICENSE` 副本并纳入构建完整性校验清单。

### Changed
- **About & Updater UI**：移除独立更新弹窗（`UpdateSheetController`），将自动更新开关、检查更新、安装提示与版本信息内联整合至「关于 (`⌘5`)」侧栏页面；主窗口侧栏统一精简为 5 页交互结构并同步深浅色实机截图资产。
- **Usage / Model Normalization**：统一用量看板、账本聚合与账本重估（`revalueLedger`）对 `MODEL_PLACEHOLDER_M667/668/669`、推理强度后缀（`high` / `medium` / `low`）及双阶段 Orchestrator / Worker 模型的原始机器学习模型名解析。

### Fixed
- **HUD / Duration & Clocks**：使用物理时间区间并集去重并发工具与并行子智能体的耗时统计，隔离历史轮次未闭合步与 `status=6/7` 终止态步对 `inFlight` 时长与活跃计数的污染，并将前端走表速率严格封顶为 1x 物理时间，解决并发工具/子智能体期间计时倍速快进的问题；保留真实活跃长耗时工具的占位 `end` 兼容。
- **HUD / State Recovery**：修复 HUD 在 `unavailable` / `loading` 状态恢复为 `ready` 后 `#val-tps-latest` 残留 `hidden` 导致永久不可见的缺陷，确保固定占位值正确重置为 `—`。
- **Accounts / Switch & Quota**：修复切号时 LaunchServices 退出等待与 Antigravity 重启核验重试逻辑；隔离菜单栏配额警告展示状态；将 Node 后端最大老生代内存限制提升至 256MB 以避免超大历史账本分析发生 OOM。

## [1.0.5] - 2026-11-09

### Added
- **i18n / Dictionary**：为 Antigravity 2.30.0 设置面板新增的“界面布局 (Interface Layout)”模块提供标准化汉化支持，收录“界面布局”、“知识工作”、“软件工程”及对应精简/完整界面的说明文案。

### Fixed
- **Maintenance / Cleanup**：修复在 Antigravity 运行时点击“清理选中缓存… -> 退出并清理”因应用退出刷盘改变缓存指纹而报错“缓存内容或路径已变化，请重新扫描”的问题，在应用退出静止后自动重新获取最新扫描令牌再执行清理，并引入互斥锁防止并发扫描与清理/恢复交错。
- **Updater / Lifecycle**：修复后台静默检查更新遇到非 200 响应（如 GitHub API 403 限流）时未复位状态、导致更新弹窗长期停留在 `.checking` 状态的问题；修复静默预下载进行中点击“立即更新 / 安装更新”被忽略的问题，支持预下载完成后自动衔接安装。
- **Updater / Storage**：将 `UpdateInstaller.acknowledge` 移入后台队列并与 `isConfirmed` 确认等待衔接，消除主线程全量哈希计算开销；扩展 `cleanupObsoleteUpdateArtifacts` 扫描 `updates/transactions/` 目录，清理中断的 `install-*` 目录及已确认事务中残留的暂存 `GravityBox.app` 与 `installer` 副本，保留 `install-receipt.json` 恢复凭证。
- **Accounts / State Sync**：修复 `watchState()` 提前更新 `statusValue.accountsRevision` 与 `liveAccountEmail` 导致后续 `refresh()` 漏判账号变更的问题；修复运行未保存账号时清空已配置 `activeId` 导致主窗口与菜单栏状态分裂的问题；统一 `dashboard_summary`、`status` 与 `account_list` 对本机实时配额与已保存套餐/分组的合并逻辑。
- **Accounts / Quota**：仅在存在未验证配额数据时归档 `quota-rejected` 快照并限制保留最近 20 份记录，避免定时的重复 403 错误导致目录无限堆积；在 `account_switch_preflight` 中同步检查 `Antigravity - Insiders.app` 运行态，与切号守卫保持一致。
- **i18n / Controller**：修复后台界面包探测（`inspectBundleInBackground`）在用户暂停汉化后完成时把状态误覆写回 `connected` / `adaptive` 的竞态；为窗口本地服务尚未就绪的场景增加有界延迟重同步，并消除初次注入失败时的重复错误追加；为原生 `setTranslationEnabled` 增加请求代数保护，防止快速连续拨动开关时旧回调覆写新状态。
- **i18n / Engine**：移除 `injectMicroPatch` 对 `[data-gravitybox-loc="1"], [data-gravitybox-ui]` 注入的硬编码 `font-family` 与 `-webkit-font-smoothing: antialiased` 覆盖规则，使所有汉化节点自然继承宿主的 `--font-family` 与 `--editor-font-family` 设置，并消除查看用量弹窗异步刷新前后因 GPU 合成图层切换导致的字体先粗后细跳变。
- **SQLite / IPC**：为 `SqliteReadSnapshot` 空闲 Worker 池增加 `exit` 与 `error` 守护监听，并在 `close()` 时清理在途挂起请求与定时器，防止复用已退出 Worker 导致 8 秒超时或未捕获异常；完善 `IdempotencyStore` 超时回收与容量淘汰策略，补齐 `main.ts` 早期信号锁释放与 `dashboard_summary` 的 `skippedLargeRecords` 字段透传。
- **UI / Layout**：修复菜单栏配额卡片将未标明周期的 Gemini 4 Argon 默认显示为“每周”的问题；统一主窗口账号页与菜单栏账号页中“已选记录”徽章为 `Design.inactivePill`；修复菜单栏配额空态按钮“前往账号页添加…”跳往总览页的问题；优化 880pt 最小窗口宽度下 `QuotaBarView` 间距与重置倒计时布局、弹窗头部副标题换行抗压缩及多级 Sheet 关闭顺序。

## [1.0.4] - 2026-11-08

### Added
- **i18n**：正式适配 Antigravity `2.29.0` 与 `2.29.1` 官方版本，登记新版本 `main.js` SHA-256 指纹，补齐 2.29.x 新增的语音音色专有名词（`Arlo`、`Cleo`、`Finn`、`Fola`、`Gero`、`Lora`、`Neno`、`Olin`、`Tari`）、`Google Chat` 及配额/环境限制提示词条，覆盖 2.23.0 ～ 2.29.1 官方受支持版本词典词条。
- **Updater**：更新缓存仅在新版身份校验、后台就绪及成功确认后清理；安装事务与旧版本恢复副本单独保留，避免自动清理影响失败回退。
- **Updater**：新增成功确认后的自动清理流程（`AppUpdateManager.cleanupObsoleteUpdateArtifacts`）。应用仅启动、版本变化或带有更新重启标记均不触发清理；新版确认成功后才清理 `updates/` 下版本不高于当前运行版本的历史缓存目录、中断的 `.dmg.part` 临时文件与 `install-*` 暂存目录；并在更新重启或升级完成运行验证后，自动卸载残留的 `/Volumes/GravityBox*` 磁盘映像卷；不扫描或访问用户的 `~/Downloads` 目录，杜绝系统权限弹窗与隐私越界。
- **Configuration**：配置模型新增 `lastCleanedVersion` 字段，支持跨版本手动拖拽升级成功验证后记录历史安装包清理状态。

### Fixed
- **Updater / Cleanup**：DMG 与校验文件统一延后至安装成功确认后清理；等待后台、安装失败或恢复受阻时保留安装包，移除失败路径中的提前删除。手动拖拽升级也在运行包签名验证与后台就绪后才清理。
- **Updater / Integrity**：SHA-256 校验文件缺失、无法读取、格式错误、文件名不匹配或哈希不符时停止升级；复用缓存和安装前重新核对哈希，当前 App 可继续使用。
- **Updater / Recovery**：在目标磁盘暂存并验证新 App，通过原子交换保留旧版本；新版本后台就绪后才确认安装，启动失败则恢复旧版，并保留中断恢复记录。
- **Accounts / Recovery**：撤销切号新增持久恢复事务，数据库、账号文件与钥匙串按实际提交结果对账；中途失败补偿，补偿受阻时保留材料并支持重试，避免混合账号状态。
- **i18n / UI**：连接异常（`mode == "error"`）时汉化开关显示为“关”并提示“连接异常，点击重试”，一键开启即发送 `resume` 触发重连，无需先关再开；开关命令在途期间，陈旧状态快照不再把开关短暂弹回旧状态（`pendingTranslationTarget`）。
- **Backend**：将 `processArguments` 迁入 `BackendBridge`，使 `Backend.swift` 可脱离 `Assistant.swift` 独立编译，修复 `native-repair` 测试编译失败。
- **Backend / Gatekeeper**：修复部分用户通过 Finder 右键首次打开应用时，macOS 仅解除主二进制隔离而保留 `Contents/Resources/runtime/node` 的 `com.apple.quarantine` 属性，导致内嵌 Node 后端被静默拦截、`translationSwitch` 长期灰置不可点击的问题；启动子进程前自动清理内嵌运行时与资源目录的 Quarantine 扩展属性。
- **Backend / Process Lifecycle**：启动后端前自动检测并清理遗留的旧 `backend.lock` 孤儿进程与失效 `control.sock`，重置重连计数并在用户手动拨动汉化开关时按需拉起后端；修复 `watchState` 因 `ownedPID` 时序差丢弃状态快照的问题。
- **i18n / UI**：重构原生偏好设置（`PreferencesController`）、菜单栏（`Assistant`）与后端 `Controller` 的汉化开关状态同步机制（新增 `translationEnabled` 字段与乐观状态更新），并将 `DevToolsActivePort` 陈旧端口探测降级为等待态（`waiting`）而非错误态（`error`），解决开关在 `starting` / `error` 状态下反发 `pause` 或点击后立刻弹回关闭的问题。
- **Updater**：修复预下载缓存 `.dmg` 被系统或外部清理后，更新弹窗仍残留 `readyToInstall` 状态的问题，新增 `hasDownloadedUpdateReady` 与 `validateCachedDMGState()` 实时核对磁盘文件存在性。
- **UI / Design**：统一主窗口总览页（`DashboardPage`）与状态栏快捷面板（`MenuStatusCard` / `MenuPanelController`）中 `FREE` 套餐徽标及“已选记录”中性状态胶囊为 `Design.inactivePill`，消除残留系统默认浅灰背景导致的视觉割裂。
- **UI / Design**：修复点击“检查更新”或“管理缓存”时，处于禁用/扫描态的主操作按钮（`DesignButton`，如“检查中…”与“清理选中缓存…”）因 `path.fill()` 未预设填充色而在半透明蓝色渐变底层铺满纯黑（`#000000`），导致按钮瞬间变为深藏蓝色的问题。
- **Updater / UI**：精简并重构检查更新弹窗（`UpdateSheetController`）卡片布局：移除头部“构建 1000x…”胶囊与“正在连接 GitHub Releases…”副标题，将 `GravityBox` 标题及版本号胶囊下移并与右侧 `GitHub ↗` 按钮保持水平居中对齐；移除“版本说明”右侧状态胶囊与“关闭”按钮左侧独立转圈指示器，改为在“检查中…”、“下载中…”、“正在安装…”主胶囊按钮内部内嵌白色旋转指示器。
- **Updater / Sidebar**：开启“自动更新”后后台仅检测并预下载新版本而不自动覆盖安装；检测到可用更新时，在主界面侧边栏底部“打开 Antigravity”胶囊上方动态展示视觉风格统一的“安装更新”提示胶囊，点击即可一键触发更新安装。
- **UI / Accessibility**：统一总览页（`DashboardPage`）与请求明细页（`UsageLogController`）在浅色/深色模式下的异常与预警文字颜色为高对比度语义色（`accessibleWarningColor()` / `accessibleDangerColor()`），提升浅色白底卡片上的可读性。

## [1.0.3] - 2026-11-08

### Added
- **Accounts**：原生账号中心（AccountsPage）新增配额折叠卡片特性，支持顶部全局“收起配额/展开配额”按钮与单卡独立展开/折叠控制。
- **Accounts**：卡片折叠后自动收缩高度（降低超 100pt），并以自适应胶囊徽标展示紧凑摘要（如 `Gemini 91%`、`Claude/GPT 0%`），提升多账号列表浏览效率。
- **Configuration**：原生配置数据模型新增 `accountsCollapsed` 偏好项并支持本地持久化存储，启动与切页自动保持用户视图选择。
- **UI / Design**：优化中性灰胶囊徽标（Inactive Pill Badge）与数据看板（DashboardPage）空态徽标在 macOS 亮色与暗色模式下的视觉表现。
- **Test**：新增原生 Swift Headless 界面自动化测试，完整覆盖账号卡片收起/展开、状态切换及配置持久化断言。

### Fixed
- **i18n**：全面修复 Antigravity 2.29 版本汉化失效缺陷。
- **i18n**：放宽 CDP 与运行时路由白名单正则，适配 2.29 新增的 `/chatski-connect`、`/c`、`/c/_new` 等路径，防止新会话窗口被误拦截过滤。
- **i18n**：重构 DOM Ready 页面就绪契约检测，支持大小写不敏感侧边栏选择器（`[aria-label*="Sidebar" i]`）、新版输入框（`[data-testid="agent-input-box"]`）与新版设置对话框。
- **i18n**：在页面注入链路中引入 10 次状态轮询确认与重试机制，彻底消除“新版页面结构尚未识别”报错与注入超时。
- **CI**：对齐多版本词典门禁范围，增强云端虚拟机慢速环境下的异步切号事件循环等待，根除偶发时钟抖动。

## [1.0.2] - 2026-11-07

### Fixed
- **Updater**：修复应用内点击“立即更新”时因模态 Sheet 挂载及后台串行队列阻塞导致的死锁卡顿，增加超时强杀与内核硬退出双重保底。
- **Updater**：更新脚本脱离父进程组独立运行，并增加 5 秒等待上限与 kill -9 强杀兜底，防止进程被系统连带终止。
- **Updater**：修复开机跟随启动守护进程（`--lifecycle-agent`）被误判为主程序导致更新后不自动重启的问题。
- **Lifecycle**：移除后台常驻守护进程向 AppKit 窗口系统注册交互策略的代码，修复主程序退出后因常驻实例被 LaunchServices 锁死导致 Finder 提示“已不能再打开”（错误码 -600）。
- **Updater**：格式化更新日志展示，自动剥离 Markdown 反引号代码块与标题标记；修复更新弹窗关闭按钮锁死及损坏 DMG 重复使用的问题。
- **Core**：退出前立即落盘待保存的防抖配置；修复账号列表并发拉取时偶现漏刷新视图；消除请求明细 Sheet 窗口释放相关的内存安全隐患。

## [1.0.1] - 2026-11-07

### Added
- **i18n**：补全用量统计、模型配额与多语言切换界面的汉化词条，官方支持的 2.23.0 ~ 2.28.0 各版本覆盖率均达到 100%。

### Changed
- **Channel**：仅支持 Antigravity 正式版，移除对 Insiders 通道的联动与状态跟随（PR #12）。
- **Channel**：新版启动时自动备份并迁移旧 Insiders 通道配置到正式版，保留其它设置、账号与历史数据；Insiders 历史配额不再用于正式版展示。
- **Quota**：正式版使用独立配额服务缓存与切号恢复记录；保留旧共享文件，但不自动应用来源不明的历史恢复点。
- **Target**：显式 Insiders 通道及路径请求返回不支持；切号仍保留对共享凭据应用运行状态的保护检查。

### Fixed
- **Usage**：等待用量持久化缓存写入完成；测试目录默认不触发远程价格同步。
- **Version**：价格同步请求的 User-Agent 随实际构建版本更新；打包的后端元数据保留版本号，测试缓存与日常数据隔离。
- **CI / Browser**：固定测试浏览器版本及 SHA-256，等待页面导航完成，补齐测试重启隔离与临时目录清理。
- **CI / Test**：放宽 CI 环境下 Swift 原生编译测试超时阈值并完善错误诊断输出（`e8dbd1c`）
- **CI / Test**：修复 UTC 时区环境下的单元测试差异与测试夹具清理逻辑（`b9733f2`）
- **Browser / i18n**：优化浏览器回归测试耗时预算并补充时长模板回退处理（`e4be614`）

### Maintenance
- **Tools**：优化 UI 字符串自动提取逻辑，完善覆盖率报告生成工具。
- **Test**：新增多界面本地化补充测试套件与安全防注入检查。
- **Release**：标签只构建草稿 Release，验收后手动公开原包；拒绝版本不一致、哈希不符和覆盖已有附件。
- **CI**：CI 保留验证报告，限制 TypeScript 与 Node 类型声明的自动主版本升级。

### Documentation
- 重写并完善 `README.md`、`THIRD_PARTY_NOTICES.md`，补充完整功能说明、架构图、隐私说明与使用条款提示
- 新增 `CODE_OF_CONDUCT.md`、`CHANGELOG.md` 与 GitHub PR / Issue 引导模板

---

## [1.0.0] - 2026-11-05

### Added
- **双界面原生应用**：提供基于 Swift / AppKit 构建的 macOS 主窗口工作台（总览、账号、用量、设置）与菜单栏常驻快捷面板（用量、配额、账号三标签页），原生适配浅色与深色模式。
- **非侵入式界面汉化**：通过本地回环 CDP 在 Isolated World 中实时替换 Antigravity 界面文案，不修改 `app.asar`、不破坏签名；支持即时开关还原，内置代码/终端/草稿内容保护与分层外置词典（覆盖 `2.23.0`～`2.28.0`）。
- **多维度配额监控**：支持 PRO / ULTRA 与 FREE 账号的 Gemini（5 小时 + 每周）、Claude / GPT（5 小时 + 每周）及 Gemini 4 Argon（每周）额度进度与重置倒计时展示，支持本机实时读取与云端定时同步。
- **多账号管理与智能切换**：支持一键保存本机当前登录账号或通过 Google OAuth 添加备用账号；凭据安全隔离于 macOS Keychain；提供带活跃任务检测、自动启停与 7 天恢复点回滚的原子切号流程，以及低额度智能切换推荐。
- **Token 用量统计与 API 费用估算**：只读快照解析本地 SQLite 会话数据库，支持按时间范围（今日 / 7 天 / 30 天 / 全部）统计四类 Token 与缓存命中率，内置支持时间区间的模型价格表与逐条请求明细检索导出。
- **安全缓存维护与系统联动**：按“运行加速缓存”“会话状态与应用授权”“已保护核心数据”三类扫描存储空间，清理统一移入系统废纸篓并支持一键原位恢复；支持开机自启、跟随 Antigravity 启停、正式版与 Insiders 双通道切换及在线更新校验。

### Fixed
- **Native UI**：保持菜单栏状态图标在不同翻译开关状态下的不透明度一致（`b9921e8`，已包含于 1.0.0）。

[Unreleased]: https://github.com/Enzoo404/gravitybox/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Enzoo404/gravitybox/compare/v1.0.5...v1.1.0
[1.0.5]: https://github.com/Enzoo404/gravitybox/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/Enzoo404/gravitybox/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/Enzoo404/gravitybox/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Enzoo404/gravitybox/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Enzoo404/gravitybox/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Enzoo404/gravitybox/releases/tag/v1.0.0
