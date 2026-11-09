# 更新日志 (Changelog)

本项目的所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 (Semantic Versioning)](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.0.4] - 2026-11-08

### Added
- **i18n**：正式适配 Antigravity `2.29.0` 与 `2.29.1` 官方版本，登记新版本 `main.js` SHA-256 指纹，补齐 2.29.x 新增的语音音色专有名词（`Arlo`、`Cleo`、`Finn`、`Fola`、`Gero`、`Lora`、`Neno`、`Olin`、`Tari`）、`Google Chat` 及配额/环境限制提示词条，2.23.0 ～ 2.29.1 全版本覆盖率均达 100%。
- **Updater**：新增应用更新后自动清理 `.dmg` 安装包与残留文件机制。在独立更新脚本（`buildDetachedUpdaterScript`）完成新版本覆盖替换后，立即自动清理应用数据目录（`updates/v*`）中已安装版本的缓存 `.dmg` 与 `.sha256` 校验文件。
- **Updater**：新增启动自动清理流程（`AppUpdateManager.cleanupObsoleteUpdateArtifacts`）。每次启动时自动清理 `updates/` 下版本不高于当前运行版本的历史缓存目录、中断的 `.dmg.part` 临时文件与 `install-*` 暂存目录；在更新重启（`--restarted-after-update`）或版本升级首次启动时，自动卸载残留的 `/Volumes/GravityBox*` 磁盘映像卷，并将 `~/Downloads` 目录下不高于当前版本的 `GravityBox-*.dmg`（含 `.dmg.sha256`）安全移入废纸篓（保留更高版本的预下载包）。
- **Configuration**：配置模型新增 `lastCleanedVersion` 字段，支持跨版本手动拖拽升级后的首次启动自动触发历史安装包清理。

### Fixed
- **i18n / UI**：连接异常（`mode == "error"`）时汉化开关显示为“关”并提示“连接异常，点击重试”，一键开启即发送 `resume` 触发重连，无需先关再开；开关命令在途期间，陈旧状态快照不再把开关短暂弹回旧状态（`pendingTranslationTarget`）。
- **Backend**：将 `processArguments` 迁入 `BackendBridge`，使 `Backend.swift` 可脱离 `Assistant.swift` 独立编译，修复 `native-repair` 测试编译失败。
- **Backend / Gatekeeper**：修复部分用户通过 Finder 右键首次打开应用时，macOS 仅解除主二进制隔离而保留 `Contents/Resources/runtime/node` 的 `com.apple.quarantine` 属性，导致内嵌 Node 后端被静默拦截、`translationSwitch` 长期灰置不可点击的问题；启动子进程前自动清理内嵌运行时与资源目录的 Quarantine 扩展属性。
- **Backend / Process Lifecycle**：启动后端前自动检测并清理遗留的旧 `backend.lock` 孤儿进程与失效 `control.sock`，重置重连计数并在用户手动拨动汉化开关时按需拉起后端；修复 `watchState` 因 `ownedPID` 时序差丢弃状态快照的问题。
- **i18n / UI**：重构原生偏好设置（`PreferencesController`）、菜单栏（`Assistant`）与后端 `Controller` 的汉化开关状态同步机制（新增 `translationEnabled` 字段与乐观状态更新），并将 `DevToolsActivePort` 陈旧端口探测降级为等待态（`waiting`）而非错误态（`error`），彻底根治开关在 `starting` / `error` 状态下反发 `pause` 或点击后立刻弹回关闭的问题。
- **Updater**：修复预下载缓存 `.dmg` 被系统或外部清理后，更新弹窗仍残留 `readyToInstall` 状态的问题，新增 `hasDownloadedUpdateReady` 与 `validateCachedDMGState()` 实时核对磁盘文件存在性。
- **UI / Design**：统一主窗口总览页（`DashboardPage`）与状态栏快捷面板（`MenuStatusCard` / `MenuPanelController`）中 `FREE` 套餐徽标及“已选记录”中性状态胶囊为 `Design.inactivePill`，消除残留系统默认浅灰背景导致的视觉割裂。
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

[Unreleased]: https://github.com/Enzoo404/gravitybox/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/Enzoo404/gravitybox/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Enzoo404/gravitybox/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Enzoo404/gravitybox/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Enzoo404/gravitybox/releases/tag/v1.0.0
