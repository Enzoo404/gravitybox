# 更新日志 (Changelog)

本项目的所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 (Semantic Versioning)](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed
- 仅支持 Antigravity 正式版：停止发现、启动、跟随和汉化 Insiders；用量仅统计正式版，菜单语言不再联动写入 Insiders。
- 新版启动时备份并迁移旧 Insiders 通道配置到正式版，保留其它设置、账号与历史数据；Insiders 历史配额不再用于正式版展示。
- 显式 Insiders 通道及路径请求返回不支持；切号仍保留对共享凭据应用运行状态的保护检查。

---

## [1.0.1] - 待验收发布

### Fixed
- **Usage**：等待用量持久化缓存写入完成；测试目录默认不触发远程价格同步。
- **Version**：价格同步请求的 User-Agent 随实际构建版本更新；打包的后端元数据保留版本号，测试缓存与日常数据隔离。
- **CI / Browser**：固定测试浏览器版本及 SHA-256，等待页面导航完成，补齐测试重启隔离与临时目录清理。
- **CI / Test**：放宽 CI 环境下 Swift 原生编译测试超时阈值并完善错误诊断输出（`e8dbd1c`）
- **CI / Test**：修复 UTC 时区环境下的单元测试差异与测试夹具清理逻辑（`b9733f2`）
- **Browser / i18n**：优化浏览器回归测试耗时预算并补充时长模板回退处理（`e4be614`）

### Maintenance
- 标签只构建草稿 Release，验收后手动公开原包；拒绝版本不一致、哈希不符和覆盖已有附件。
- CI 保留验证报告，贡献指南补充维护与发版步骤。
- 限制 TypeScript 与 Node 类型声明的自动主版本升级。

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

[Unreleased]: https://github.com/Enzoo404/gravitybox/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/Enzoo404/gravitybox/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Enzoo404/gravitybox/releases/tag/v1.0.0
