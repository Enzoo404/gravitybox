<p align="center">
  <img src="assets/master-1024.png" width="112" height="112" alt="GravityBox" />
</p>

<h1 align="center">GravityBox</h1>

<p align="center">
  为 Google Antigravity 打造的 macOS 原生伴侣应用
  <br>
  界面汉化 · 配额监控 · 多账号管理 · Token 用量统计
</p>

<p align="center">
  <a href="https://github.com/Enzoo404/gravitybox/releases/latest"><img src="https://img.shields.io/github/v/release/Enzoo404/gravitybox?style=flat-square" alt="Release"></a>
  <a href="https://github.com/Enzoo404/gravitybox/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Enzoo404/gravitybox/ci.yml?branch=main&style=flat-square&logo=github" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/macOS-14%2B-lightgrey?style=flat-square&logo=apple" alt="macOS 14+">
  <img src="https://img.shields.io/badge/Apple%20Silicon-arm64-orange?style=flat-square" alt="Apple Silicon">
</p>

---

## 简介

GravityBox 是我为自己日常使用 [Google Antigravity](https://antigravity.google) 而开发的 macOS 应用。它由两部分组成：

- **桌面主窗口**：总览、账号、用量、设置四个页面，集中管理账号、查看配额与 Token 用量；
- **菜单栏卡片**：常驻菜单栏，无需切换窗口即可查看当前配额、切换账号、开关界面汉化。

应用使用 Swift / AppKit 编写原生界面，后台由 TypeScript 服务提供账号、配额、用量分析与界面汉化能力，二者通过本地 Unix Domain Socket 通信。

## 功能

### 界面汉化
- 通过本地 Chrome DevTools Protocol 在运行时翻译 Antigravity 界面，**不修改、不解包、不重签名** Antigravity 应用本身；
- 仅翻译菜单、按钮、设置项等界面文案；代码块、终端、聊天正文、未发送草稿、项目名与品牌名称均不处理；
- 可随时在中文与官方原版英文之间切换，无需重启。

### 配额监控
- 分别展示 Gemini 的 5 小时与每周额度，以及 Claude / GPT、Gemini 4 Argon 的额度，并显示距离重置的剩余时间；
- 在主窗口与菜单栏卡片中同步呈现，可手动刷新。

### 多账号管理
- 保存多个 Google 账号，一键切换 Antigravity 当前登录的账号；
- **智能切换**：当前账号剩余额度低于设定阈值时，自动切换到额度更充足的备用账号；
- 登录凭据保存在 macOS 钥匙串中；切换过程可回滚，不会对原有数据做物理删除。

### Token 用量统计
- 读取本地会话数据，按会话与项目统计 Input / Output Token；
- 内置各模型价格表，折算 API 费用；历史记录按事件发生时的价格计算。价格表可通过 `pricing-feed.json` 自定义。

## 安装

**系统要求**：macOS 14 (Sonoma) 及以上，Apple Silicon；已安装 Google Antigravity（正式版或 Insiders）。

1. 前往 [Releases](https://github.com/Enzoo404/gravitybox/releases/latest) 下载 `GravityBox-<version>-arm64.dmg`；
2. 打开 DMG，将 `GravityBox.app` 拖入「应用程序」；
3. 应用使用 ad-hoc 签名，未经 Apple 公证。如首次启动被系统拦截，请在终端执行：

   ```bash
   sudo xattr -rd com.apple.quarantine /Applications/GravityBox.app
   ```

## 配置

通过 Google 账号在线登录、刷新云端配额需要提供 OAuth 客户端凭据。复制 [`.env.example`](./.env.example) 为 `.env`，放置于项目根目录，或 `~/Library/Application Support/GravityBox/.env`（安装版读取此路径）：

```bash
GRAVITYBOX_GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GRAVITYBOX_GOOGLE_CLIENT_SECRET=your_client_secret

# 可选：自定义模型价格源
# GRAVITYBOX_PRICING_FEED_URL=https://example.com/pricing-feed.json
```

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                  Native macOS GUI (AppKit)                  │
│          Main Window  ·  Menu Bar Card  ·  Settings         │
└──────────────────────────────┬──────────────────────────────┘
                               │ Unix Domain Socket
┌──────────────────────────────▼──────────────────────────────┐
│               Core Backend (TypeScript / Node)              │
│   Accounts · Quota · Usage Analyzer · Localization (CDP)    │
└──────────────┬───────────────────────────────┬──────────────┘
               │ Local CDP                     │ Keychain
┌──────────────▼──────────────┐ ┌──────────────▼──────────────┐
│    Google Antigravity       │ │   macOS Keychain (tokens)   │
└─────────────────────────────┘ └─────────────────────────────┘
```

## 隐私与网络

- 不包含任何遥测、统计或数据上报；
- 账号、用量等数据均在本机处理和存储；
- 仅在以下场景访问网络：Google 官方接口（账号登录与配额查询）、GitHub（检查应用更新、获取默认价格表）。

## 从源码构建

需要 Node.js `>=22.15.0 <23` 与 Xcode Command Line Tools。

```bash
git clone https://github.com/Enzoo404/gravitybox.git
cd gravitybox

npm ci
npm run doctor      # 检查开发环境
npm run build       # 编译
npm test            # 单元与集成测试
npm run verify      # 完整发布检查
npm run package:mac # 生成 DMG
```

## 参与贡献

欢迎提交 Issue 与 Pull Request，开始之前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。安全问题请按 [SECURITY.md](./SECURITY.md) 私下报告。

## 声明

GravityBox 是独立的第三方项目，与 Google、Anthropic、OpenAI、Apple 无隶属或合作关系。相关名称与商标归各自所有者所有，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 许可证

[MIT](./LICENSE) © Enzoo404
