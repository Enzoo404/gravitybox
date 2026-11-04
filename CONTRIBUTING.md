# 贡献指南 (Contributing Guide)

感谢你关注并参与 GravityBox 的开源建设！

GravityBox 致力于为 macOS 用户提供优雅、原生且注重隐私安全的 Antigravity 辅助工具箱。无论你是提交 Bug 报告、提出功能建议、改进词典质量，还是编写代码，我们都非常欢迎你的贡献。

---

## 目录

1. [开发环境要求](#1-开发环境要求)
2. [本地快速开始](#2-本地快速开始)
3. [核心开发原则](#3-核心开发原则)
4. [测试与门禁验证](#4-测试与门禁验证)
5. [分支与提交规范](#5-分支与提交规范)
6. [Pull Request 流程](#6-pull-request-流程)

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

# 3. 编译 TypeScript 与静态资源
npm run build

# 4. 运行全量单元与集成测试
npm test
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
npm test
```
包含 300+ 个核心测试用例，覆盖账号并发事务、双周期额度熔合、Protobuf/SQLite 解码与用量计费算法。

### 浏览器端回归测试 (Browser Regression)
```bash
npm run test:browser
```
启动无头 Chromium 实例，通过 CDP 验证界面汉化、微补丁、Shadow DOM 穿透、双语热切换及受保护元素隔离。

### 自动化发布门禁 (Release Gate)
```bash
npm run verify
```
运行完整的流水线门禁：编译 TypeScript、单元测试、浏览器测试、Swift 原生编译检查、以及免 vendor 模式的词典覆盖率门禁（`tools/coverage-report.mjs --gate`）。

---

## 5. 分支与提交规范

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
4. 运行 `npm test` 与 `npm run verify`，确保所有门禁 100% 绿色通过。
5. 推送至个人分支并向 `Enzoo404/gravitybox:main` 发起 Pull Request。
6. CI 自动化检查通过后，核心维护者将对 PR 进行 Review 并合并。
