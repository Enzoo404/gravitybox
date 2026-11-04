# 安全策略与漏洞通报 (Security Policy)

GravityBox 高度重视用户的数据安全与隐私保护。作为一款涉及本地账号凭据管理与系统级辅助功能的工具箱，我们采取了多层次的安全与隐私隔离设计。

---

## 1. 受支持的版本 (Supported Versions)

我们仅针对最新稳定主版本提供安全更新与补丁支持：

| 版本 | 是否支持安全更新 |
| :--- | :--- |
| `1.0.x` | :white_check_mark: 当前维护版本 |
| `< 1.0.0` | :x: 已终止支持（请升级至最新版本） |

---

## 2. 漏洞提报渠道 (Reporting a Vulnerability)

**请切勿通过公开的 GitHub Issue 提报安全漏洞！**

如果你在 GravityBox 中发现了安全漏洞或潜在的凭据泄漏隐患，请通过以下安全渠道联系维护者：

1. **GitHub Private Vulnerability Reporting**（首选）：
   前往仓库的 **Security** -> **Advisories** -> **Report a vulnerability** 页面，在线提交加密漏洞报告。
2. **私密邮件沟通**：
   发送详细报告至项目维护者邮箱：[enzoo404@users.noreply.github.com](mailto:enzoo404@users.noreply.github.com)

### 提报内容建议包含：
- 漏洞类型与详细描述（如凭据隔离失效、IPC 未授权执行、未脱敏日志泄露等）；
- 复现步骤、概念验证代码（PoC）或环境上下文；
- 影响评估与潜在的利用场景；
- 建议的修复方案（若有）。

---

## 3. 漏洞响应与披露流程 (Response Process)

1. **初步确认**：在收到报告后的 **48 小时** 内，我们将确认收到报告并展开初步技术验证。
2. **漏洞修复**：经确认的安全漏洞将由核心维护者在私有安全分支中开发并经过回归验证。
3. **安全发版与致谢**：修复完成后，我们将发布包含安全补丁的正式版本，并在安全公告（Security Advisory）中向报告者公开致谢（经报告者同意）。

---

## 4. 核心安全架构说明 (Security Principles)

GravityBox 在架构层遵循以下核心安全保障机制：

- **零外部遥测**：应用绝不在后台发起未经许可的第三方遥测、分析或数据收集请求。
- **系统钥匙串隔离**：Google 授权凭据与 Refresh Token 仅通过 macOS 原生 Keychain 服务持久化存储，应用状态文件仅记录指针与脱敏索引。
- **IPC 深度脱敏**：前端 Native 进程与后端 TypeScript 控制器之间的通信通道严格进行敏感字段清洗与权限校验。
- **不可逆归档脱敏**：历史切换日志仅保留脱敏后的账号指纹，自动清理所有 Base64 编码凭据与 Protobuf 原始载荷。
