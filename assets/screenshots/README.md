# 实机截图资产清单

本目录截图于 2026-11-13 基于最新 **GravityBox v1.0.5** 原生 macOS AppKit 渲染引擎截取，全量覆盖浅色模式（Light Mode）与深色模式（Dark Mode），提供原生 2x Retina 超高清像素，包含主控制台全部五大页面、常驻菜单栏多标签面板以及存储维护弹窗。

---

## 资产清单

### 1. 全景 Hero 展示图（2560 × 1440 · Retina 16:9）

| 文件 | 主题 | 内容说明 | 像素尺寸 |
| :--- | :--- | :--- | :--- |
| `hero.png` | 浅色 (Light) | 主工作台（总览看板）与常驻菜单栏面板悬浮排版，带自然环境投影与浅色渐变背景 | 2560 × 1440 |
| `hero-dark.png` | 深色 (Dark) | 深色主工作台与深色菜单栏面板悬浮排版，带深邃投影与暗色夜空渐变背景 | 2560 × 1440 |

### 2. 主控制台页面（2200 × 1520 · 2x Retina · 带原生交通灯与圆角）

| 浅色版本 (Light) | 深色版本 (Dark) | 页面内容 | 像素尺寸 |
| :--- | :--- | :--- | :--- |
| `overview.png` | `dark-overview.png` | **总览 (`⌘1`)**：Gemini/Claude 双周期配额雷达、今日 Token 消耗汇总与活跃模型分布 | 2200 × 1520 |
| `accounts.png` | `dark-accounts.png` | **账号 (`⌘2`)**：当前活跃账号与备用账号配额并列对比、智能换号策略与多账号管理 | 2200 × 1520 |
| `usage.png` | `dark-usage.png` | **用量 (`⌘3`)**：24 小时 Token 趋势柱状图、API 等效时序费用分布环图与缓存命中率 | 2200 × 1520 |
| `settings.png` | `dark-settings.png` | **设置 (`⌘4`)**：免解包界面汉化热开关、会话遥测 HUD、开机跟随与价格源同步 | 2200 × 1520 |
| `about.png` | `dark-about.png` | **关于 (`⌘5`)**：原生系统运行环境、自包含 Node 22 独立沙箱、版本与合规说明 | 2200 × 1520 |

### 3. 常驻菜单栏面板（792 × 1288 · 2x Retina · 独立快捷面板）

| 浅色版本 (Light) | 深色版本 (Dark) | 标签页内容 | 像素尺寸 |
| :--- | :--- | :--- | :--- |
| `menubar.png` | `dark-menubar.png` | **用量标签 (Usage)**：实时 Token 汇总、今日时段消耗与主流模型消耗占比 | 792 × 1288 |
| `menubar-quota.png` | `dark-menubar-quota.png` | **配额标签 (Quota)**：Gemini 5 小时滚动与每周配额进度条、重置倒计时雷达 | 792 × 1118 |
| `menubar-accounts.png` | `dark-menubar-accounts.png` | **账号标签 (Accounts)**：备用账号列表、剩余额度一览与一键安全切换入口 | 792 × 1162 |

### 4. 交互弹窗（1480 × 1448 · 2x Retina）

| 浅色版本 (Light) | 深色版本 (Dark) | 弹窗内容 | 像素尺寸 |
| :--- | :--- | :--- | :--- |
| `maintenance.png` | `dark-maintenance.png` | **存储与维护**：三分类缓存安全扫描、核心凭据只读锁定、系统废纸篓软删除 | 1480 × 1448 |

---

## 规范与隐私处理说明

1. **隐私安全绝不妥协**：全量截图数据均采用项目官方测试夹具与脱敏样本（如 `Alex`、`alex@example.invalid`、`second-long-email@example.invalid`），严格杜绝任何开发者的真实 Google 邮箱、个人姓名、私人路径或实际凭据外泄；
2. **像素极致保真**：基于 macOS Sonoma/Sequoia 原生 AppKit 与 CoreGraphics 进行 2x Retina 超采样渲染，主窗口保留标准原生红黄绿交通灯控制组件、抗锯齿圆角与材质半透明度；
3. **等效参考计价**：用量页与菜单栏中展示的费用为基于公开模型价格表折算的 API 等效参考费用，不代表真实扣费账单。
