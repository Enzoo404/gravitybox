<p align="center">
  <img src="assets/master-1024.png" width="112" height="112" alt="GravityBox" />
</p>

<h1 align="center">GravityBox</h1>

<p align="center">
  Google Antigravity 的 macOS 原生伴侣应用
  <br>
  界面汉化 · 配额监控 · 多账号管理 · Token 用量与费用估算 · 缓存维护
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

GravityBox 是我为日常使用 [Google Antigravity](https://antigravity.google) 开发的 macOS 应用。它把使用 Antigravity 时需要反复查看、手动处理的几件事集中到一处：

- 官方界面是英文，这里提供**界面汉化**；
- 额度分散在不同模型和周期里，这里集中展示**配额与重置时间**；
- 使用多个 Google 账号时，这里统一做**账号管理与切换**；
- 想知道消耗了多少 Token、折合多少费用，这里提供**用量统计与费用估算**；
- 应用缓存越积越多，这里可以**安全清理并随时还原**。

应用有两种形态：

- **主窗口**：总览、账号、用量、设置四个页面；
- **菜单栏卡片**：用量、配额、账号三个标签，不离开当前窗口即可查看和操作。

界面使用 Swift / AppKit 编写；后台由 TypeScript 服务负责账号、配额、用量分析与汉化，二者通过本地 Unix Domain Socket 通信。

## 功能

### 界面汉化
- 运行时翻译 Antigravity 的菜单、按钮、设置与提示文案，**不修改、不解包、不重签名** Antigravity 本身，Antigravity 更新后无需重新打补丁；
- 代码块、终端、聊天正文、未发送的草稿、项目名与品牌名称不会被翻译；
- 在菜单栏中一键开关，随时回到官方英文界面，无需重启；
- 词典按功能与版本分层，可通过覆盖率检查发现未翻译的文案，欢迎提交补充。

### 配额监控
- 按账号展示 Gemini 的 5 小时与每周额度、Claude / GPT 的 5 小时与每周额度，以及 Gemini 4 Argon 的每周额度，并显示距离重置的剩余时间；
- 5 小时窗口与每周额度分别呈现，不会互相替代；缺少真实数据时明确标注，而不是估算；
- 主窗口与菜单栏卡片同步展示，支持手动刷新。

### 多账号管理
- 通过 Google 授权添加多个账号，账号卡片显示套餐（FREE / PRO / ULTRA）、当前账号标记与各自配额；
- 一键切换 Antigravity 当前使用的账号。切换前需要你先保存工作并退出 Antigravity，GravityBox 不会替你结束或重启它；
- **智能切换**：当前账号剩余额度低于设定阈值时，按优先级或轮询策略推荐最合适的备用账号，由你确认后执行；
- 每次切换都会记录恢复点，出现异常可一键恢复原账号；
- 登录凭据保存在 macOS 钥匙串；账号可导出为脱敏摘要（不含凭据），或包含凭据的备份文件（需自行妥善保管）。

### 用量与费用估算
- 读取本机的会话数据，按时间范围统计请求数，以及输入、缓存读取、缓存写入、输出各类 Token，并给出缓存命中率；
- 按模型展示 Token 占比，总览页展示当日的用量、请求数、时段消耗与费用估算；
- 内置模型价格表，支持限时价格与标准价格的生效时间段，历史记录按当时的价格计算；没有价格的模型仍会统计 Token 与请求数；
- 价格表可通过 `pricing-feed.json` 自定义。费用为按公开价格的估算值，不代表实际账单。

### 缓存维护
- 扫描 Antigravity 的应用缓存与着色器缓存，按影响程度分为“可安全清理”与“含登录状态、需谨慎”两类，后者默认不勾选；
- 清理时文件移入系统废纸篓，并生成恢复点，可在应用内一键原位还原；账号登录状态与历史对话不受影响。

### 其他
- 支持 Antigravity 正式版与 Insiders，两者的账号、配额与用量分别计量；
- 可设置登录 macOS 时自动启动；
- 可选的自动更新：开启后定期检查 GitHub Release，有新版本时提醒升级。

## 安装

**系统要求**：macOS 14 (Sonoma) 及以上，Apple Silicon；已安装 Google Antigravity（正式版或 Insiders）。

1. 前往 [Releases](https://github.com/Enzoo404/gravitybox/releases/latest) 下载 `GravityBox-<version>-arm64.dmg`；
2. 打开 DMG，将 `GravityBox.app` 拖入「应用程序」；
3. 应用使用 ad-hoc 签名，未经 Apple 公证。如首次启动被系统拦截，请在终端执行：

   ```bash
   sudo xattr -rd com.apple.quarantine /Applications/GravityBox.app
   ```

## 使用

1. 启动 GravityBox，菜单栏出现图标，点击即可打开卡片；
2. 在「账号」中添加 Google 账号（需先完成下方的[配置](#配置)），之后即可查看各账号配额并切换；
3. 在菜单栏菜单中开启「界面汉化」，Antigravity 界面随即显示为中文；
4. 在「用量」中查看 Token 与费用，在「设置」中管理开机启动、自动更新与缓存清理。

汉化词典已针对 Antigravity 2.23.0、2.23.1、2.24.0、2.26.0、2.27.0、2.28.0 做过覆盖率校验。其他版本也可使用，但新增文案可能暂未翻译。

## 配置

通过 Google 账号在线登录并刷新云端配额，需要提供 OAuth 客户端凭据。复制 [`.env.example`](./.env.example) 为 `.env`，放在项目根目录，或 `~/Library/Application Support/GravityBox/.env`（安装版读取此路径）：

```bash
GRAVITYBOX_GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GRAVITYBOX_GOOGLE_CLIENT_SECRET=your_client_secret

# 可选：自定义模型价格源
# GRAVITYBOX_PRICING_FEED_URL=https://example.com/pricing-feed.json
```

## 工作原理

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

- **汉化**：通过本地 Chrome DevTools Protocol 连接 Antigravity 页面，在运行时替换界面文案，仅作用于本机回环地址；
- **用量**：以只读方式读取 Antigravity 本地的会话数据库，不会写入或阻塞 Antigravity；
- **账号切换**：先预览、再写入，过程分阶段进行并保留恢复点，失败时自动回滚。

## 隐私与网络

- 不包含任何遥测、统计或数据上报；
- 账号、用量等数据均在本机处理和存储，登录凭据存放于 macOS 钥匙串；
- 仅在以下场景访问网络：Google 官方接口（账号授权与配额查询）、GitHub（检查应用更新、获取默认价格表）。

## 已知限制

- 应用未经 Apple 公证，首次启动需要手动放行（见[安装](#安装)）；
- 目前只提供 Apple Silicon 的安装包；
- 配额查询使用的是 Antigravity 自身所用的 Google 接口，该接口未公开，可能随官方更新而变化；
- 费用是基于价格表的估算值。

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

欢迎提交 Issue 与 Pull Request，开始之前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。汉化词条的补充与修正同样欢迎。安全问题请按 [SECURITY.md](./SECURITY.md) 私下报告。

## 声明

GravityBox 是独立的第三方项目，与 Google、Anthropic、OpenAI、Apple 无隶属或合作关系。相关名称与商标归各自所有者所有，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

使用本项目前，请自行确认符合 Google Antigravity 及相关服务的使用条款，使用风险由使用者自行承担。

## 许可证

[MIT](./LICENSE) © Enzoo404
