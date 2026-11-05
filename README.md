<p align="center">
  <img src="assets/master-1024.png" width="112" height="112" alt="GravityBox" />
</p>

<h1 align="center">GravityBox</h1>

<p align="center">
  专为 Google Antigravity 打造的 macOS 原生伴侣应用
  <br>
  界面汉化 · 多账号与配额管理 · Token 用量与费用估算 · 缓存维护
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

GravityBox 是我为日常使用 [Google Antigravity](https://antigravity.google) 开发的 macOS 原生应用。

在高频使用 Antigravity 的过程中，有几件事一直比较繁琐：官方只有英文界面、不同模型和周期的剩余额度分散在内部状态里不易直观查看、多个 Google 账号来回切换步骤多、本地消耗了多少 Token 和等效 API 费用缺少清晰账目、长期运行后各种编译与渲染缓存动辄占用数 GB 空间。我把这些日常高频需求整合到了 GravityBox 中。

它包含两套协同工作的原生交互界面，均支持系统浅色与深色外观：

- **主窗口工作台**：左侧为毛玻璃导航栏（带底部「打开 Antigravity」快捷启动按钮），右侧分为**「总览」「账号」「用量」「设置」**四个主页面（支持 `⌘1`–`⌘4` 快速切换），适合全面查看数据、管理多账号与执行维护操作；
- **菜单栏快捷面板**：点击右上角状态栏图标即可呼出，包含**「用量」「配额」「账号」**三个标签页及顶部汉化开关，写代码时无需离开当前工作区即可随时速览额度、展开对比备用账号或一键切号。

前端界面使用 Swift 与 AppKit 原生构建，后台由内置的 TypeScript / Node.js 服务处理汉化注入、账号事务、配额拉取与 SQLite 用量分析，前后端通过本地 Unix Domain Socket 通信。安装包内已自带独立运行时，无需额外配置 Node 环境即可开箱即用。

---

## 核心功能

### 1. 界面汉化
- **不改写官方应用包**：在运行时通过本地调试接口替换 Antigravity 的菜单、按钮、设置项与状态提示文案，**不解包、不修改 `app.asar`、不重签名**。不会破坏 macOS Gatekeeper 签名校验，Antigravity 官方升级后也无需重新打补丁；
- **代码与内容保护**：自动识别并跳过代码编辑器（`.monaco-editor`）、终端（`.xterm`）、代码块、聊天正文、未发送的输入框草稿、自定义项目名以及 70 余项技术与品牌专有名词，只翻译界面控件，不干渉开发内容；
- **即时生效与还原**：在主窗口「设置」或菜单栏右上角菜单中可随时开关「界面汉化」，关闭后立即原位恢复为官方英文界面，无需重启 Antigravity；
- **分层外置词典**：词典按功能模块与版本增量分层维护（`dict/`），支持热加载，并通过提取指纹对 Antigravity `2.23.0`、`2.23.1`、`2.24.0`、`2.26.0`、`2.27.0`、`2.28.0` 进行了覆盖率校验。

### 2. 多维度配额监控
- **完整呈现各模型与周期额度**：
  - 针对 **PRO / ULTRA** 订阅账号，分别展示 **Gemini（5 小时 + 每周）**、**Claude / GPT（5 小时 + 每周）** 以及 **Gemini 4 Argon（每周）** 共五条实时配额进度条与重置倒计时；
  - 针对 **FREE** 账号，自动适配展示各模型系列的**模型配额**与**每周配额**及对应重置时间；
- **严守真实数据契约**：5 小时窗口与每周额度独立呈现，绝不拿周配额冒充 5 小时配额；未获取到真实数据时明确标注状态，不做虚假估算；剩余额度 ≤20% 时进度条自动变为橙色预警，≤10% 或耗尽时变为红色警示；
- **双源采集与定时同步**：当前正在使用的账号优先从本机运行的 Antigravity 服务实时读取配额，同时支持通过 Google 云端接口刷新所有已保存账号的额度；可在「设置」中选择手动刷新，或开启后台定时刷新（每 5 / 10 / 15 / 30 / 60 分钟）。

### 3. 多账号管理与智能切换
- **两种添加账号方式**：点击「添加账号…」后，既可以点击**「保存当前账号」**直接读取本机已登录的 Antigravity 账号（无需配置任何环境变量即可一键入库），也可以通过**「Google 授权登录…」**在浏览器中完成 OAuth 授权以添加更多备用账号；同时支持导入本地历史账号库与导出账号备份（导出时可选择「仅导出脱敏摘要」或「包含凭据导出」）；
- **自动停启的安全切号流程**：在主窗口「账号」页或菜单栏「账号」标签中点击切换时，GravityBox 会先检查 Antigravity 的运行状态及是否有正在执行的 Agent 任务，并弹出确认框（若有活跃任务会提示中断风险）。点击确认后，应用会**自动退出 Antigravity -> 在本地数据库与 macOS 钥匙串中原子写入新账号凭据 -> 自动重新打开 Antigravity**，无需手动开关应用；
- **7 天恢复点回滚**：每次切换都会自动生成快照恢复点。如切换后遇到异常，可在账号页顶部横幅中一键「撤销并恢复原账号」；
- **智能切换推荐**：开启「智能切换」后，可在「配置…」中设定**推荐排序方式**（「配额充裕优先」或「按顺序轮询」，均优先推荐 ULTRA / PRO 订阅账号）、**监测模型范围**（`Gemini` / `Claude/GPT` / `Gemini 4 Argon`）、**触发切换阈值**（默认 10%）与**候选准入下限**（默认 30%）。当当前账号配额低于阈值时，界面会自动标出最佳备用账号并提示一键切换。

### 4. Token 用量统计与 API 费用估算
- **只读解析本地会话库**：以只读快照方式解析本机 Antigravity 的会话记录，支持按**「今日」「近 7 天」「近 30 天」「全部」**四个时间范围统计请求总数、输入 Token、缓存读取 Token、缓存写入 Token、输出 Token 以及**缓存命中率**；
- **多维可视化看板**：
  - **总览页**：展示今日与累计 Token、今日与累计估算费用、今日与累计请求数三张核心指标卡，以及「今日时段消耗」24 小时柱状图（自动标注峰值时段）和「今日活跃模型」摘要；
  - **用量页**：提供时段/按日趋势柱状图、「API 费用估算」模型占比环图（Donut Chart）、缓存命中率进度条，以及按模型展开的用量与费用列表；
  - **菜单栏「用量」标签**：浓缩展示四宫格指标卡、支持在 **Token / 请求** 双维度间切换的趋势图，以及支持原地展开的模型排行；
- **逐条请求明细与导出**：在「用量」页点击**「请求明细…」**可打开独立检索面板，按时间倒序查看每次调用的模型、精确时间与四类 Token 消耗，支持按模型名实时搜索、翻页跳转，并可将汇总报告或逐条请求记录导出为 JSON 文件；
- **支持价格区间的时间感知计费**：内置主流 Gemini、Claude、GPT 模型价格表（`assets/model-catalog.json`），支持限时优惠价与标准正式价的生效时间段自动匹配，历史调用按发生时的有效单价计算；可在「统计详情…」中核对每个模型的计价来源与有效期，也支持通过远程 `pricing-feed.json` 更新或自定义价格表（注：费用为按公开 API 价格折算的等效参考值，不代表实际订阅账单）。

### 5. 缓存维护与系统联动
- **分类扫描与核心数据保护**：在「设置 -> 存储与维护 -> 管理缓存…」中，顶部直观展示可清理体积与三色存储构成条，将本地文件严格划分为三类：
  - **运行加速缓存（推荐清理，默认勾选）**：包含网络与静态资源缓存、V8 字节码编译缓存、Metal / WebGL 图形与着色器缓存、工作区运行编译缓存、崩溃转储与日志等；
  - **会话状态与应用授权（需谨慎清理，默认不勾选）**：包含 Cookies、Local Storage、Service Worker 等，勾选清理前会明确提示可能导致部分扩展需重新登录；
  - **已保护核心数据（只读展示，绝不触碰）**：包含 `state.vscdb` 核心账号凭据与 Agent 历史对话数据库，始终受严格保护；
- **自动重启与废纸篓一键原位恢复**：若清理时 Antigravity 正在运行，确认后会自动退出 Antigravity、将选中缓存移入系统废纸篓并生成时间戳恢复点，随后自动重新启动 Antigravity。如清理后需要回退，可在面板底部点击**「原位恢复」**一键还原；
- **跟随 Antigravity 启停与开机自启**：在「设置」中除了支持「登录时启动」外，还可开启**「跟随 Antigravity 启停」**——打开 Antigravity 时自动在菜单栏启动 GravityBox，关闭 Antigravity 时自动一并退出；
- **内置校验的在线更新**：在「设置 -> 关于 -> 检查更新」中可查看 GitHub Release 最新版本与更新日志，支持开启「自动更新」（后台预下载新版本安装包）。执行升级时会自动完成 **SHA-256 哈希校验、DMG 镜像校验与代码签名校验**，通过后替换应用并自动重启；
- **正式版与 Insiders 双版本兼容**：自动识别本机安装的 Google Antigravity 正式版或 Insiders 版本。

---

## 安装

**系统要求**：macOS 14 (Sonoma) 及以上，Apple Silicon (`arm64`)；本机已安装 Google Antigravity（正式版或 Insiders）。

1. 前往 [Releases](https://github.com/Enzoo404/gravitybox/releases/latest) 下载最新的 `GravityBox-<version>-arm64.dmg`；
2. 双击挂载 DMG，将 `GravityBox.app` 拖入 `Applications`（应用程序）文件夹；
3. 由于应用采用本地 Ad-hoc 签名、未进行 Apple Developer 公证，首次打开若提示“无法验证开发者”或“已损坏”，请在终端执行以下命令放行：

   ```bash
   sudo xattr -rd com.apple.quarantine /Applications/GravityBox.app
   ```

---

## 快速上手

1. **启动与界面汉化**：打开 GravityBox，应用主窗口与右上角菜单栏图标会同时就绪。在主窗口「设置」页或点击菜单栏图标右上角的 `…` 菜单开启**「界面汉化」**，正在运行的 Antigravity 界面即刻切换为中文；
2. **纳管本机当前账号**：切到「账号」页，点击右上角「添加账号… -> 保存当前账号」，即可直接将本机当前登录的 Antigravity 账号纳入管理并查看实时配额；
3. **添加更多备用账号与切换**：如需通过浏览器 OAuth 登录其他 Google 账号，或让非当前激活的备用账号在后台通过云端接口刷新配额，请先完成下方的[可选配置](#可选配置)，随后即可在账号页或菜单栏卡片中一键切换账号；
4. **查看用量与清理缓存**：在「总览」和「用量」页查看 Token 消耗、费用环图与请求明细；在「设置」中按需开启「跟随 Antigravity 启停」或打开「管理缓存…」释放磁盘空间。

---

## 可选配置

直接保存本机已登录账号、查看本机实时配额、使用界面汉化、统计本地 Token 用量与清理缓存**均无需任何额外配置**。

如果你需要使用**「Google 授权登录…」**在浏览器中添加新账号，或通过 Google 云端接口刷新备用账号的配额，请配置你自己的 Google OAuth 客户端凭据。复制仓库中的 [`.env.example`](./.env.example) 为 `.env`，放置在 `~/Library/Application Support/GravityBox/.env`（安装版默认读取路径，源码运行时也可放在项目根目录）：

```bash
# Google OAuth 客户端凭据（用于浏览器授权添加账号及云端配额刷新）
GRAVITYBOX_GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GRAVITYBOX_GOOGLE_CLIENT_SECRET=your_client_secret

# 可选：自定义远程模型价格表 URL（默认指向本仓库 main 分支的 assets/pricing-feed.json）
# GRAVITYBOX_PRICING_FEED_URL=https://raw.githubusercontent.com/Enzoo404/gravitybox/main/assets/pricing-feed.json
```

---

## 工作原理与架构

```text
┌──────────────────────────────────────────────────────────────────────┐
│                      Native macOS App (Swift / AppKit)               │
│   Main Window (总览 / 账号 / 用量 / 设置)  ·  Menu Bar Panel (三标签)  │
└───────────────────────────────────┬──────────────────────────────────┘
                                    │ Unix Domain Socket (0600, JSON-RPC)
┌───────────────────────────────────▼──────────────────────────────────┐
│                    Core Backend (TypeScript / Node 22)               │
│   Localization (CDP) · Accounts & AutoSwitch · Quota · Usage · Cache │
└──────────┬────────────────────────┬────────────────────────┬─────────┘
           │ Local Loopback CDP     │ Read-Only / Atomic     │ Security Framework
┌──────────▼──────────┐  ┌──────────▼──────────┐  ┌──────────▼──────────┐
│ Google Antigravity  │  │  Local SQLite DBs   │  │   macOS Keychain    │
│ (Isolated World JS) │  │ & Displaced Trash   │  │  (OAuth Credentials)│
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

- **进程与通信隔离**：AppKit 原生前端与内置 Node 后端通过权限为 `0600` 的本地 Unix Domain Socket 通信，具备单实例进程锁与幂等指令保护；
- **非侵入式汉化注入**：仅连接本机回环地址（`127.0.0.1`）的 Chrome DevTools Protocol 调试端口，在独立执行环境（`Page.createIsolatedWorld`）中运行 DOM 观察器与文本替换，不污染页面全局对象；
- **只读数据库快照**：统计 Token 用量时，在独立 Worker 中以只读模式读取本地会话数据库，不写入、不加锁，绝不阻塞 Antigravity 的正常读写；
- **原子事务与零硬删除**：账号切换采用预检、备份、原子写入与自动回滚机制；缓存清理统一将文件移入系统废纸篓独立目录并记录清单，不执行不可逆的物理硬删除。

---

## 隐私与安全说明

- **零遥测与零埋点**：不包含任何第三方统计、崩溃上报或行为追踪代码；
- **凭据系统级隔离**：所有账号的 OAuth 令牌与敏感凭据仅存放在本机 **macOS 钥匙串（Keychain）** 中，本地配置文件（`accounts.json`）与历史日志仅保留脱敏索引；
- **外联边界透明**：应用仅在以下明确场景发起网络请求：
  1. 连接 Google 官方接口完成账号 OAuth 授权与云端配额查询；
  2. 连接 GitHub Releases / Raw 接口检查版本更新与同步公开模型价格表。

---

## 已知限制

- 应用使用本地 Ad-hoc 签名，未经过 Apple 公证，首次打开需按[安装说明](#安装)在终端移除隔离属性；
- 目前仅构建并支持 Apple Silicon (`arm64`) 架构的 Mac；
- 云端配额查询调用的是 Antigravity 客户端自身使用的内部接口，若上游接口协议调整可能会影响云端配额刷新；
- 用量页中的 API 费用是基于公开模型单价与本地 Token 记录折算的参考值，并非 Google 或第三方服务商的实际账单。

---

## 从源码构建

如果你希望从源码自行编译、调试或打包 DMG，需准备 **macOS 14+**、**Node.js `>=22.15.0 <23`** 以及 **Xcode Command Line Tools**（提供 `swiftc`）。

```bash
# 1. 克隆仓库
git clone https://github.com/Enzoo404/gravitybox.git
cd gravitybox

# 2. 安装依赖并检查本地编译环境
npm ci
npm run doctor

# 3. 编译 TypeScript 后端与运行时资源
npm run build

# 4. 运行单元与集成测试套件
npm test

# 5. 运行完整发布门禁（含 TS 编译、单元测试、浏览器回归、Swift 原生编译与词典覆盖率门禁）
npm run verify

# 6. 编译原生应用并打包生成 DMG 安装镜像
npm run package:mac
```

---

## 参与贡献

欢迎提交 Issue 反馈问题或发起 Pull Request 参与改进，也欢迎补充和修正 `dict/` 下的汉化词条。提交代码前请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。如发现安全或隐私相关隐患，请勿公开提交 Issue，请按 [SECURITY.md](./SECURITY.md) 中的说明私下联系。

---

## 声明

GravityBox 是独立的第三方开源项目，与 Google LLC、Anthropic PBC、OpenAI Inc.、Apple Inc. 无任何隶属、合作或背书关系。文中提及的产品名称与商标均归各自权利人所有，详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

使用本项目前，请自行确认符合 Google Antigravity 及相关服务的使用条款，使用风险由使用者自行承担。

## 许可证

[MIT](./LICENSE) © Enzoo404
