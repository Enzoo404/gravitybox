# GravityBox

<p align="center">
  <strong>专为 Google Antigravity 打造的原生 macOS 工具箱</strong>
  <br>
  <span>多账号智能轮转 · 双周期配额监控 · Token 真实 API 计价 · 非侵入式双语热增强</span>
</p>

<p align="center">
  <a href="https://github.com/Enzoo404/gravitybox/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Enzoo404/gravitybox/ci.yml?branch=main&style=flat-square&logo=github" alt="CI Status"></a>
  <a href="https://github.com/Enzoo404/gravitybox/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey.svg?style=flat-square&logo=apple" alt="macOS">
  <img src="https://img.shields.io/badge/node-%3E%3D22.15.0-brightgreen.svg?style=flat-square&logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/swift-5.9%2B-orange.svg?style=flat-square&logo=swift" alt="Swift">
</p>

---

## 🌟 核心特性 (Features)

### 🎛️ 1. 原生 macOS 体验与 Bento 视觉
- 采用 **Swift / AppKit** 构建轻量高效的原生常驻菜单栏与控制台。
- 遵循现代 macOS 极简美学，融合 Bento Grid 布局与细致的呼吸感微渐变，信息层次清晰，性能零冗余消耗。

### 🔄 2. 智能账号轮转与配额监控
- **多账号无缝切换**：支持绑定多个 Google 账号，一键免密安全切号。
- **真实双周期额度熔合**：精准解析并融合 Gemini 5 小时与每周限额窗口，拒绝用周限额冒充 5 小时；支持 Argon 独立配额计量。
- **智能轮换策略**：内置优先级与剩余额度启发式算法，在配额耗尽前自动推荐最优可用账号。
- **系统钥匙串保护**：OAuth 令牌与凭据全程受 macOS Keychain 加密保护，历史归档经过不可逆深度脱敏。

### 📊 3. Token 用量分析与动态 API 成本核算
- **深度会话解析**：自动扫描并解析本地 SQLite 事务与 Protobuf 数据流，精准统计每个会话与项目的 Input/Output Token 消耗。
- **时序动态计价**：支持官方 2026 最新模型费率及限时阶梯定价，历史事件按发生时的价格永久冻结对账，支持离线与自定义价格源（`pricing-feed.json`）。

### 🌐 4. 非侵入式双语热更新增强
- **零侵入架构**：通过本地 Chrome DevTools Protocol (CDP) 调试通道进行运行时文本热适配，绝不修改、解包或重签名官方应用。
- **严格的内容安全隔离**：聊天对话正文、代码块、终端会话、未发送草稿、项目名称与品牌专有名词受到严格保护，绝不篡改。
- **一键双语热切换**：随时在中文本地化与官方原版英文之间无缝切换。

### 🛡️ 5. 数据安全与版权合规
- **零外部遥测**：无后台上报、无埋点、无第三方网络请求。
- **非破坏性事务（Non-destructive Safety）**：缓存清理与切号事务绝无物理硬删除，内置完整的四阶段原子恢复与快照机制。
- **清晰的版权隔离**：官方应用二进制已被彻底排除出版本库（免 vendor 校验体系），100% 自由开源。

---

## 🏗️ 架构概览 (Architecture)

```
┌─────────────────────────────────────────────────────────────┐
│                  Native macOS GUI (AppKit)                  │
│       MenuBar Card / Bento Dashboard / Preferences          │
└──────────────────────────────┬──────────────────────────────┘
                               │ IPC (Unix Domain Socket)
┌──────────────────────────────▼──────────────────────────────┐
│             GravityBox Core Backend (TypeScript)             │
│  Account Manager · Quota Engine · SQLite Analyzer · CDP Hub │
└──────────────┬───────────────────────────────┬──────────────┘
               │ Local CDP                     │ macOS Keychain
┌──────────────▼──────────────┐ ┌──────────────▼──────────────┐
│     Antigravity Client      │ │       System Security       │
│  (Target: Release/Insiders) │ │   Encrypted Token Storage   │
└─────────────────────────────┘ └─────────────────────────────┘
```

---

## 📋 系统要求 (System Requirements)

- **操作系统**：macOS 14 (Sonoma) 或 macOS 15+ (Apple Silicon `arm64`)
- **目标应用**：Google Antigravity 正式版或 Antigravity Insiders
- **源码构建环境**：
  - Node.js `>=22.15.0 <23`
  - Xcode Command Line Tools (`swiftc`)

---

## 🚀 快速上手 (Quick Start)

### 方式一：安装 DMG 发行包

从 [GitHub Releases](https://github.com/Enzoo404/gravitybox/releases) 下载最新 `GravityBox-<version>-arm64.dmg` 并拖入 `/Applications`。由于开源构建采用本地 Ad-hoc 签名（未经过 Apple 公证），首次启动前若遇到系统拦截，请在终端执行以下命令移除隔离属性：

```bash
sudo xattr -rd com.apple.quarantine /Applications/GravityBox.app
```

### 方式二：从源码运行与构建

```bash
# 1. 克隆代码仓库
git clone https://github.com/Enzoo404/gravitybox.git
cd gravitybox

# 2. 安装依赖并检查环境健康度
npm ci
npm run doctor

# 3. 编译 TypeScript 与运行时文件
npm run build

# 4. 运行全量测试套件（301 项测试）
npm test

# 5. 启动开发后台
npm start
```

### 自动化发布与门禁验证

```bash
# 运行完整发布门禁（编译、单元测试、浏览器回归测试、Swift 原生编译检查及词典门禁）
npm run verify

# 打包为 macOS 原生应用（生成 DMG 安装镜像）
npm run package:mac
```

---

## ⚙️ 环境变量配置 (.env)

你可以复制 `.env.example` 为项目根目录 `.env`（或保存至 `~/Library/Application Support/GravityBox/.env` 供独立安装包读取）：

```bash
# Google OAuth 凭据（使用在线 OAuth 登录与云端配额刷新时配置）
# GRAVITYBOX_GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
# GRAVITYBOX_GOOGLE_CLIENT_SECRET=your_client_secret

# 自定义远程定价源（可选）
# GRAVITYBOX_PRICING_FEED_URL=https://raw.githubusercontent.com/Enzoo404/gravitybox/main/assets/pricing-feed.json
```

---

## 🤝 参与贡献 (Contributing)

我们非常欢迎社区贡献！请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 了解分支管理规范、测试要求与提交流程。

---

## 🔒 安全策略 (Security)

发现任何安全隐患或漏洞？请查阅 [SECURITY.md](./SECURITY.md)，通过私密渠道向维护者通报，切勿直接提交公开 Issue。

---

## 📄 开源许可证与致谢 (License & Acknowledgments)

- 本项目采用 [MIT License](./LICENSE) 开源许可。
- 感谢开源项目 [qqxpee/antigravity2-cn](https://github.com/qqxpee/antigravity2-cn) 为早期词典整理提供的启发与基础贡献。
- 详细第三方许可、开源致谢与商标声明请参阅 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/Enzoo404">Enzoo404</a> and contributors
</p>
