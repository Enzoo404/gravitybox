# GravityBox 高清实机截图资产说明

本目录保存 `README.md` 与 `README_EN.md` 所引用的全部 **2x Retina 高清实机截图（共 22 张，含深色/浅色双主题自适应版本）**。

## 隐私脱敏规范

所有账号、邮箱、额度与用量均源自隔离沙盒测试固件（`Alex`、`example.invalid` 保留域与模拟会话样本），**不包含任何真实个人凭据、真实 Token、本地项目名称或生产账号信息**。

## 资产生成方式

- **原生 Swift / AppKit 窗口与菜单栏截图**：由 `npm run test:native-ui` 在临时沙盒目录采集后，经 `swift tools/generate-screenshots.swift` 添加 macOS 圆角裁剪、交通灯按钮与全景 Hero 合成，输出 20 张 PNG。
- **IDE 对话状态栏（Telemetry HUD）截图**：在无头 Chromium (`deviceScaleFactor: 2`) 中加载项目真实 `runtime/hud-*.js` 模块渲染浅/深双色实景交互图，输出 `hud.png` 与 `hud-dark.png`（`2160×1080`）。

## 截图清单

| 场景 | 浅色模式 (Light) | 深色模式 (Dark) | 分辨率 | 说明 |
| --- | --- | --- | --- | --- |
| **全景 Hero 首图** | `hero.png` | `hero-dark.png` | `2560×1440` | 主控制台总览与菜单栏面板合成视图 |
| **对话状态栏 (HUD)** | `hud.png` | `hud-dark.png` | `2160×1080` | 嵌入 IDE 对话输入区底部的三胶囊状态条与向上弹出层 |
| **主窗口 · 总览** | `overview.png` | `dark-overview.png` | `2200×1520` | 账号配额双周期看板、当日消耗趋势与活跃模型 Top |
| **主窗口 · 账号** | `accounts.png` | `dark-accounts.png` | `2200×1520` | 多账号卡片、状态徽标与原子事务安全切换入口 |
| **主窗口 · 用量** | `usage.png` | `dark-usage.png` | `2200×1520` | 分周期 Token 核算、API 费用估算与缓存命中率趋势 |
| **主窗口 · 设置** | `settings.png` | `dark-settings.png` | `2200×1520` | 界面汉化、对话状态栏、自动更新价格基准与存储管理 |
| **主窗口 · 关于** | `about.png` | `dark-about.png` | `2200×1520` | 版本信息（v1.1.0）、应用内更新检测与目标版本状态 |
| **菜单栏 · 用量** | `menubar.png` | `dark-menubar.png` | `792×1288` | 菜单栏面板默认“用量”视图 |
| **菜单栏 · 配额** | `menubar-quota.png` | `dark-menubar-quota.png` | `792×1118` | 菜单栏面板“配额”与备用账号推荐 |
| **菜单栏 · 账号** | `menubar-accounts.png` | `dark-menubar-accounts.png` | `792×1162` | 菜单栏面板一键安全切号入口 |
| **存储瘦身与清理** | `maintenance.png` | `dark-maintenance.png` | `1480×1448` | 无损缓存评估、废纸篓移入清理与快照一键还原 |
