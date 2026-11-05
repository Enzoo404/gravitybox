# GravityBox

<p align="center">
  <img src="https://raw.githubusercontent.com/Enzoo404/gravitybox/main/assets/master-1024.png" width="128" height="128" alt="GravityBox Logo" style="border-radius: 24px;" />
</p>

<p align="center">
  <strong>专为 Google Antigravity 打造的 macOS 菜单栏助手</strong>
  <br>
  <span>界面汉化 · 配额监控与重置倒计时 · 多账号一键切换 · Token 消耗统计</span>
</p>

<p align="center">
  <a href="https://github.com/Enzoo404/gravitybox/releases/latest"><img src="https://img.shields.io/github/v/release/Enzoo404/gravitybox?color=blue&style=flat-square" alt="Latest Release"></a>
  <a href="https://github.com/Enzoo404/gravitybox/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Enzoo404/gravitybox/ci.yml?branch=main&style=flat-square&logo=github" alt="CI Status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-macOS%2014%2B-lightgrey.svg?style=flat-square&logo=apple" alt="Platform">
  <img src="https://img.shields.io/badge/arch-Apple%20Silicon-orange.svg?style=flat-square" alt="Arch">
</p>

---

## 项目背景

在日常重度使用 **Google Antigravity** 进行开发时，常会遇到一些体验上的局限：

- **全英文界面**：官方未提供中文支持，对于习惯母语界面的开发者存在一定阅读负担；
- **配额周期不透明**：Gemini 模型的 5 小时滑动窗口与每周限额容易混淆，难以准确预估恢复时间；
- **多账号切换繁琐**：单账号配额耗尽后，需频繁在客户端登出并重新走网页 OAuth 授权流程；
- **缺乏成本与用量统计**：各个会话与项目消耗了多少 Token、折合多少 API 费用，缺乏直观的统计视图。

**GravityBox** 是一款轻量的原生 macOS 菜单栏工具，旨在解决上述问题，提供更专注、顺畅的开发体验。

---

## 核心特性

### 🇨🇳 界面汉化
- **运行时无损汉化**：通过本地 CDP 调试通道在前端动态加载翻译，不解包、不修改客户端二进制或 ASAR 资源文件，官方客户端升级后依然兼容；
- **严格的内容隔离**：仅汉化界面交互文案，**严格排除**代码编辑器、终端输出、聊天正文及专有名词，避免代码被误翻译干扰；
- **随时无缝切换**：支持在菜单栏一键即时切换中文与官方英文原版，无需重启应用。

### ⏱️ 配额监控与重置倒计时
- **双周期拆分呈现**：将 Gemini 模型的 5 小时短期限额与每周总额度独立展示，避免混淆；
- **精准倒计时**：直观显示额度重置剩余时间（如「2 小时 15 分钟后重置」）；
- **全模型覆盖**：额外支持 Gemini 4 Argon、Claude / GPT 限额独立查看，低配额状态智能提醒。

### 🔄 多账号一键切换
- **免密快速轮转**：支持预先配置多个 Google 账号，当前账号额度偏低时，可在菜单栏一键切换至备用账号；
- **系统钥匙串加密**：所有 OAuth 凭证均安全存储于 macOS Keychain，保证凭据安全；
- **剩余配额对比**：清晰展示各账号额度状态，方便挑选最优备用账号。

### 💰 Token 消耗与费用统计
- **本地会话透视**：自动读取本地 SQLite 事务，按会话与项目分类统计 Input / Output Token；
- **官方阶梯价格核算**：内置 2026 最新官方模型定价，核算实际 API 折合费用，历史事件按发生时的价格冻结对账。

### ⚡️ 原生轻量与隐私安全
- **Swift / AppKit 原生开发**：常驻菜单栏与 Bento Grid 视觉看板，内存占用极小，性能损耗近乎为零；
- **100% 离线隐私**：所有数据均在本地处理，**无任何后台遥测、无数据埋点、不与任何外部第三方服务器通信**。

---

## 架构概览

GravityBox 采用松耦合的分层架构，Native GUI 与本地服务通过 Unix Domain Socket 进行 IPC 通信：

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

## 下载与安装

### 方式一：下载 DMG 安装包（推荐）

1. 前往 [Releases 页面](https://github.com/Enzoo404/gravitybox/releases) 下载最新的 `GravityBox-1.0.0-arm64.dmg`。
2. 双击打开，将 `GravityBox.app` 拖入「应用程序 (Applications)」文件夹。
3. **首次启动说明**：
   由于个人开源构建采用本地 Ad-hoc 签名（未购买 Apple 商业开发者证书公证），macOS Gatekeeper 安全机制可能会拦截并提示“无法打开”或“已损坏”。在终端中执行以下命令移除隔离属性即可正常启动：
   ```bash
   sudo xattr -rd com.apple.quarantine /Applications/GravityBox.app
   ```

### 方式二：从源码编译构建

**环境要求**：
- macOS 14 (Sonoma) 或更高版本 (Apple Silicon `arm64`)
- Node.js `>=22.15.0 <23`
- Xcode Command Line Tools (`swiftc`)

```bash
# 1. 克隆代码仓库
git clone https://github.com/Enzoo404/gravitybox.git
cd gravitybox

# 2. 安装依赖并检查环境
npm ci
npm run doctor

# 3. 编译 TypeScript 与运行时文件
npm run build

# 4. 运行全量测试套件
npm test

# 5. 打包生成 DMG 安装镜像
npm run package:mac
```

---

## 常见问题 (FAQ)

**Q：使用多账号切换功能会有账号安全风险吗？**  
A：不会。所有账号切换与登录均通过本机合法的官方 OAuth 流程进行，OAuth 凭据存储于 macOS 系统钥匙串（Keychain）中，工具不包含任何自动化刷量或异常请求行为。

**Q：界面汉化是否会影响代码编写或补全？**  
A：不会。汉化引擎针对 DOM 树进行了严格的内容隔离，代码编辑器、终端会话、模型回复正文及草稿输入框均处于保护名单内，仅对界面按钮与系统设置文案生效。

**Q：GravityBox 会上传用户数据吗？**  
A：不会。本项目完全开源，代码中不包含任何外部网络上传、埋点统计或分析 SDK，全部数据均在本地存储与处理。

---

## 开源许可与声明

- 本项目采用 [MIT License](./LICENSE) 开源。
- 详细第三方许可致谢与商标合理使用声明请参阅 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
