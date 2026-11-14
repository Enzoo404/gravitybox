# 贡献指南 (Contributing Guide)

感谢你关注并参与 GravityBox 的开源建设！

GravityBox 致力于为 macOS 用户提供优雅、原生且注重隐私安全的 Antigravity 辅助工具箱。无论你是提交 Bug 报告、提出功能建议、改进词典质量，还是编写代码，我们都非常欢迎你的贡献。

参与本项目即表示你同意遵守我们的 [贡献者行为准则 (CODE_OF_CONDUCT.md)](./CODE_OF_CONDUCT.md)。如发现安全或隐私漏洞，请勿公开提交 Issue，请按 [安全策略 (SECURITY.md)](./SECURITY.md) 私下提报。

---

## 目录

1. [开发环境要求](#1-开发环境要求)
2. [本地快速开始](#2-本地快速开始)
3. [核心开发原则](#3-核心开发原则)
4. [测试与门禁验证](#4-测试与门禁验证)
5. [分支与提交规范](#5-分支与提交规范)
6. [Pull Request 流程](#6-pull-request-流程)
7. [维护与版本发布](#7-维护与版本发布)

---

## 1. 开发环境要求

- **操作系统**：macOS 14 (Sonoma) 或更高版本（推荐 Apple Silicon 芯片）
- **Node.js**：`>=22.15.0 <23`（推荐使用 nvm 或 fnm 管理）
- **Swift / Xcode CLI Tools**：系统自带 `swiftc`（Xcode Command Line Tools）
- **Google Chrome**：用于运行基于 CDP 的无头浏览器回归套件（`/Applications/Google Chrome.app`）

运行以下命令可自动诊断本地环境是否满足要求：
```bash
npm run doctor
```

---

## 2. 本地快速开始

```bash
# 1. 克隆代码仓库
git clone https://github.com/Enzoo404/gravitybox.git
cd gravitybox

# 2. 安装开发依赖并初始化环境
npm ci
npm run setup:dev

# 3. 运行常规编译与单元/集成测试
npm test

# 4. 运行完整发布门禁（含浏览器回归、Swift -O 检查与全版本词典门禁）
npm run verify
```

---

## 3. 核心开发原则

参与 GravityBox 开发时，请恪守以下核心安全与工程红线：

1. **隐私安全底线**：
   - 严禁加入任何未经用户明确授权的外部遥测、埋点或数据回传代码。
   - 所有登录凭据与敏感 Token 必须通过系统级钥匙串（macOS Keychain）免密安全隔离存储，历史归档必须经过深度不可逆脱敏。
2. **数据零硬删除（Non-destructive Safety）**：
   - 缓存维护与账号切号事务严禁执行物理硬删除操作，必须走四阶段原子恢复引擎与隔离废纸篓快照（Displaced Storage）。
3. **版权与上游隔离**：
   - 严禁将任何官方或第三方的二进制文件（如 `vendor/` 下的原始界面包或 ASAR 文件）提交至 Git 仓库。
   - 提取文案统一沉淀在 `ui-strings/` 下，由官方发布指纹（SHA256）与分层词典（`dict/`）驱动门禁校验。
4. **非侵入式热注入**：
   - 汉化与界面增强基于 CDP 页面调试接口与 DOM 观察器运行，不得修改或重签名官方应用。

---

## 4. 测试与门禁验证

提交代码前，请务必在本地运行并通过所有测试套件：

### 单元与集成测试 (Unit & Integration Tests)
```bash
npm run test:unit
```
覆盖账号并发事务、双周期额度熔合、Protobuf/SQLite 解码、用量计费算法与小型原生行为测试。仅检查非原生测试可用 `npm run test:fast`，仅检查小型原生行为测试可用 `npm run test:native`；这些局部检查不生成发布通过记录。

历史审计和按日期分散的混合用例按生产领域归并在 `*-contracts.test.mjs`。必要的失败路径和数据保全断言继续执行；各夹具组保持独立作用域并串行运行子用例，隔离时钟与文件系统替换。固定外观、源码实现拼写和手写算法副本已裁剪，随机几何压力测试改为确定性边界。原生快照合并及总览时效中尚无独立轻量夹具的两项守卫继续保留在状态契约测试中。

完整原生 UI 夹具不纳入默认测试枚举、CI 或打包前门禁。修改原生界面需要合成夹具辅助检查时，可按需运行 `npm run test:native-ui`，该命令不生成发布通过记录；安装后的实际界面及操作仍由人工验收。

### 浏览器端回归测试 (Browser Regression)
```bash
node tools/setup-test-browser.mjs
npm run test:browser
```
启动无头 Chromium 实例，通过 CDP 验证界面汉化、微补丁、Shadow DOM 穿透、双语热切换及受保护元素隔离。

macOS ARM64 开发环境与 CI 使用固定版本的 Chrome Headless Shell，下载至 `.cache/` 并核对压缩包及二进制 SHA-256。版本与哈希在 `tools/setup-test-browser.mjs` 中一起维护。可用 `CHROME_BIN` 显式指定其他测试浏览器；未准备固定浏览器时，本地仍可使用已安装的 Chrome。测试浏览器不随应用打包。

### 自动化发布门禁 (Release Gate)
```bash
npm run verify
```
完整发布门禁流水线包含：清理孤儿构建产物、编译 TypeScript、合并运行时、核对价格资产、单元/集成及小型原生行为测试（`npm test` 聚焦这部分日常开发验证）、无头浏览器测试（`npm run test:browser`）、发行版 Swift 原生编译（`-O`）以及全部受支持版本的词典覆盖率门禁。可通过 `node tools/verify.mjs --target-app-version <x.y.z>` 做单版本定向验证，或默认自动对历史冻结版本启用免 vendor 校验。通过后可直接运行 `node tools/package-mac.mjs`（或 `npm run package:mac`），打包器会再次核对源码与产物指纹。

---

## 5. 分支与提交规范

日常采用 `main` + 短期任务分支。本机修改和测试后推送分支，创建 PR，检查通过后合并；保存代码与发布安装包分别进行。维护者可直接使用仓库内任务分支，无需 Fork。

我们推荐遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范，保持提交历史整洁易读：

- `feat(scope): 描述新特性`
- `fix(scope): 修复缺陷`
- `style(native-ui): 界面样式与审美优化`
- `refactor(scope): 代码重构与架构调整`
- `test(scope): 增加或修复测试用例`
- `docs(scope): 文档补充与更新`

---

## 6. Pull Request 流程

1. Fork 官方仓库至个人账号。
2. 基于 `main` 分支拉取开发分支（例如 `feat/your-feature-name`）。
3. 编写代码并增加对应的单元测试或浏览器测试。
4. 运行 `npm test`（日常单测）与 `npm run verify`（提交发布相关改动时），确保完整门禁通过。
5. 推送至个人分支并向 `Enzoo404/gravitybox:main` 发起 Pull Request。
6. CI 自动化检查通过后，核心维护者将对 PR 进行 Review 并合并。

## 7. 维护与版本发布

开发包先使用单独的 macOS 测试用户验证。仅改 App 名称不能隔离正式账号、钥匙串和数据；不要直接覆盖日常使用的正式版。

1. 版本 PR 统一更新 `package.json`、`package-lock.json` 的项目版本和 `CHANGELOG.md`。完整门禁及合并后 main CI 均通过后，再确定发布提交。
2. 推送指向该提交的 `vX.Y.Z` 标签，触发 **Release** 工作流；也可手动输入已存在的标签。当前仅支持数字正式版本，次版本与修订号各不超过 99。
3. 工作流验证标签、提交、项目版本、包内版本、源码摘要和 DMG 校验文件，然后创建**草稿 Release**，不会自动公开。已有 Release（含草稿）会被拒绝，不覆盖任何附件。
4. 从草稿下载 DMG、`.dmg.sha256` 和 `release-manifest.json`，校验 DMG，并实际验证全新安装、从上一正式版升级及账号/设置保留；按变更范围补充实际功能验收。记录实际验收文件的完整 SHA-256。
5. 在 Actions 中从 `main` 运行 **Publish Accepted Release**，填写标签和上述 SHA-256，并勾选验收确认。流程重新下载已有附件，核对文件哈希、清单、远端附件摘要与标签提交后，仅把原草稿转为公开版本，**不重新构建**。
6. 你日常使用的正式版也从该 Release 安装；已发布版本不移动标签、不替换包，修正使用新版本号。

CI 与构建草稿的验证日志保留为 Actions artifacts（7 天）。如草稿上传中断，先检查已存在的草稿和附件；重跑不会自动删除草稿或覆盖文件，也不能将不完整草稿直接发布。需要重建时由维护者确认如何处理该未公开草稿，或改用新版本号。

要只读核对已有草稿，可从 `main` 手动运行 **Release**，填写标签并勾选 `inspect_only`。此模式不构建、不上传、不公开；草稿通过带权限的 Release 分页列表查找，不能用只返回正式版本的按标签接口判断其是否存在。

GitHub 只向具备仓库推送权限的身份列出草稿，因此该检查 job 的临时令牌需要 `contents: write`；“只读”指检查脚本实际只执行 GET 查询，不代表令牌本身只有读取权限。权限仅限该 job，不调整全局工作流权限或用户凭据。

应用内更新只面向公开正式 Release；草稿验收由维护者手动下载进行。实际安装、升级和数据保留仍需人工验证，Actions 中的确认框只是记录维护者的确认。
