# GravityBox

<p align="center">
  <img src="https://raw.githubusercontent.com/Enzoo404/gravitybox/main/assets/master-1024.png" width="128" height="128" alt="GravityBox Logo" style="border-radius: 24px;" />
</p>

<p align="center">
  <strong>专为 Google Antigravity 打造的高性能原生 macOS 工具箱</strong>
  <br>
  <span>多账号智能轮转 · 双周期配额精准透视 · Token 成本动态核算 · 零侵入式双语切换</span>
</p>

<p align="center">
  <a href="https://github.com/Enzoo404/gravitybox/releases/latest"><img src="https://img.shields.io/github/v/release/Enzoo404/gravitybox?color=blue&style=flat-square" alt="Latest Release"></a>
  <a href="https://github.com/Enzoo404/gravitybox/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Enzoo404/gravitybox/ci.yml?branch=main&style=flat-square&logo=github" alt="CI Status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-macOS%2014%2B-lightgrey.svg?style=flat-square&logo=apple" alt="Platform">
  <img src="https://img.shields.io/badge/arch-Apple%20Silicon-orange.svg?style=flat-square" alt="Arch">
</p>

---

## 💡 为什么需要 GravityBox？

**Google Antigravity** 是一款强大的 AI 编程与 Agent 辅助环境，但在日常重度使用中，开发者常常面临一些实际痛点：

- ⏳ **配额焦虑**：Gemini 模型的 5 小时滑动窗口与每周限额到底还剩多少？何时重置？官方界面往往不够直观。
- 🔀 **多账号切换繁琐**：多账号之间切号需要反复登出登入，中断开发心流。
- 💸 **Token 用量缺乏统计**：会话跑了多少 Token？消耗了多少真实 API 费用？难以量化。
- 🌐 **语言门槛**：全英文设置与复杂的模型选项，缺乏高质量且不破坏原版的中文对照。

**GravityBox 为此而生。** 它是一款常驻在 macOS 菜单栏的原生伴侣工具，旨在解决上述所有痛点，让你的 Antigravity 开发体验更专注、更流畅。

---

## ✨ 核心特性

### 1. ⏱️ 真实双周期配额监控
- **双重周期精准透视**：分别呈现 Gemini 5 小时限额与每周限额，拒绝用周限额模糊代替短期窗口；支持 Argon 与 Claude/GPT 限额独立计量。
- **动态倒计时**：实时精确计算额度刷新剩余时间（如「2 小时 15 分钟后重置」），告别盲目等待。
- **额度健康度预警**：剩余配额偏低或耗尽时智能提醒，辅助决策切号时机。

### 2. 🔄 智能多账号无缝轮换
- **一键安全切号**：支持绑定多个 Google 账号，瞬间无缝切换工作上下文。
- **启发式自动推荐**：当前账号额度偏低或耗尽时，自动推荐剩余额度最充裕的备用账号。
- **系统钥匙串守护**：所有 OAuth 凭证均存放于 macOS 系统级 Keychain 中加密保护，严防凭据外泄。

### 3. 📊 Token 消耗与成本动态核算
- **本地会话无感分析**：直接解析本地 SQLite 事务与消息流，精准统计每个会话与项目的 Input / Output Token。
- **时序价格模型**：内置 2026 最新官方模型阶梯定价，历史消耗按事件发生时的价格永久冻结对账，支持自定义定价源。

### 4. 🌐 非侵入式双语热更新
- **零侵入架构**：通过本地 CDP (Chrome DevTools Protocol) 协议进行前端热适配，**绝不修改、解包或篡改官方客户端签名**。
- **严格的内容隔离**：代码块、聊天正文、终端会话、未发送草稿与项目专属专有名词均受到强保护，绝不误翻或干扰代码逻辑。
- **热切换**：无需重启客户端，一键即时在官方原版英文与中文本地化之间自由切换。

### 5. 🎨 极致纯净的原生 macOS 体验
- **Swift / AppKit 原生构建**：常驻菜单栏与 Bento Grid 视觉看板，支持深色/浅色模式自适应，极低内存与 CPU 开销。
- **隐私第一 (Privacy-First)**：**0 外部网络遥测、0 数据埋点、0 个人信息上报**，完全离线可用。

---

## 🏗️ 架构概览

GravityBox 采用松耦合的分层设计，GUI 界面与核心分析服务完全通过本地 Unix Domain Socket 通信，确保宿主安全性：

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

## 🚀 快速上手

### 方式一：下载 DMG 安装包（推荐）

1. 前往 [Releases 页面](https://github.com/Enzoo404/gravitybox/releases) 下载最新版本的 `GravityBox-1.0.0-arm64.dmg`。
2. 双击打开，将 `GravityBox.app` 拖入 `Applications`（应用程序）文件夹。
3. **首次启动说明**：
   由于个人开源项目采用本地 Ad-hoc 签名（未经过 Apple 商业开发者证书公证），macOS Gatekeeper 可能会提示“无法打开”或“已损坏”。只需打开终端执行以下命令解除隔离属性即可正常打开：
   ```bash
   sudo xattr -rd com.apple.quarantine /Applications/GravityBox.app
   ```

### 方式二：从源码编译构建

如果你希望自行编译或参与贡献，请确保系统满足以下环境要求：
- macOS 14 (Sonoma) 或 macOS 15+ (Apple Silicon `arm64`)
- Node.js `>=22.15.0 <23`
- Xcode Command Line Tools (`swiftc`)

```bash
# 1. 克隆代码仓库
git clone https://github.com/Enzoo404/gravitybox.git
cd gravitybox

# 2. 安装开发依赖并进行环境自检
npm ci
npm run doctor

# 3. 编译 TypeScript 与运行时代码
npm run build

# 4. 运行全量测试套件（300+ 项测试与原生编译检查）
npm test

# 5. 打包生成 macOS 原生 DMG 安装镜像
npm run package:mac
```

---

## 🔒 隐私与安全声明

- **零数据上报**：GravityBox 不包含任何遥测、统计代码或第三方网络 SDK，所有数据均在您的本地设备完成处理。
- **凭证安全**：Google OAuth 令牌受 macOS 系统 Keychain 加密保护，缓存切换机制采用非破坏性原子快照，绝无物理硬删除风险。
- **版权隔离**：本项目完全遵照开源合规准则，不包含亦不分发 Antigravity 官方专有二进制文件与代码副本。详细第三方许可与商标声明请参阅 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

---

## 🤝 参与贡献

我们非常欢迎社区贡献！
在提交 PR 之前，请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 了解代码规范与提交流程，并确保所有测试门禁通过：

```bash
npm run verify
```

---

## 📄 开源许可证

本项目采用 [MIT License](./LICENSE) 许可开源。

<p align="center">
  Made with ❤️ for the Antigravity community
</p>
