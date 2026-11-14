# GravityBox 工程架构总览

## 核心定位
GravityBox (`1.1.0`) 是面向 macOS 14+ (Apple Silicon `arm64`) 的轻量级 Google Antigravity 正式版伴侣工具箱，提供零侵入式双语热适配、输入框实时会话遥测 HUD、双周期配额监控、多账号四阶段原子切换、只读 SQLite 用量与时序计费核算及非破坏性缓存维护。

## 目录与模块分工
- `native/`：macOS 原生 AppKit 前端（常驻菜单栏面板、5 页主控制台 `Overview / Accounts / Usage / Settings / About`、进程守护与自更新校验）
- `src/`：Node 22 / TypeScript 核心后端（CDP 注入控制、账号切换事务、双周期配额聚合、`sqlite-worker` 只读投影、时序计费与重估、`metrics-engine` HUD 引擎、IPC 服务）
- `runtime/`：注入 Isolated World 的零侵入 DOM 观察引擎（`engine.js`）与会话遥测 HUD 实例（`hud-instance.js` / `hud-popover.js` / `hud-styles.js`）
- `dict/` & `ui-strings/`：分层词典与基于官方正式版 SHA-256 指纹提取的界面文案基准（覆盖 `2.23.0` ~ `2.32.1`）
- `assets/`：图标、实机截图、公开模型目录与时序定价基准（`model-catalog.json` / `pricing-feed.json`）
- `tools/`：构建（`clean-dist` / `copy-runtime`）、价格同步（`sync-pricing-feed`）、全量门禁（`verify`）及 DMG 打包（`package-mac`）脚本
- `test/`：Node 单元与集成测试、无头 Chromium 浏览器回归（`test/browser.mjs`）及原生 Swift AppKit 布局断言（`test/native-ui.swift`）
